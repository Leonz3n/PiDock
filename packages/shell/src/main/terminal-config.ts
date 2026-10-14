/**
 * Built-in terminal domain for [PiDock 10] (#15), S2 slice.
 *
 * Pure rules + a bounded per-task registry: no pty, no `child_process`, no
 * filesystem. The Host owns the real spawn behind these guards; this module
 * owns what a valid terminal launch looks like, how the terminal is bound to
 * one task and one selected root, and how its stop scope is proven.
 *
 * Design notes (from the #15 boxes):
 * - The terminal's cwd is one of the task's file roots (a repo worktree or a
 *   plain-directory link), never the app's cwd and never another task's folder.
 * - The child env comes from the #7 resolution order (仓库默认配置 → 共享模板 →
 *   本机私有配置 → 任务覆盖 → 运行时绑定) and is a fresh object per terminal;
 *   `process.env` is never read or written, so one terminal cannot leak into
 *   another and the app's global environment stays untouched.
 * - Program and argv are explicit: inline `FOO=bar cmd` and shell chaining are
 *   refused, because a terminal that is a shell string cannot be attributed or
 *   permission-gated per command.
 * - Every instance records its owning task, owning session (null = human UI
 *   explicit) and process identity, so stopping one terminal matches
 *   instance+pid+startedAt and can never stop another task's process.
 * - History is bounded and scrubbed with the shared secret scrubber; the real
 *   pty/streaming/exit observation remains a recorded residual (no spawn here).
 */

import { posix as posixPath, win32 as win32Path } from "node:path";
import { resolveServiceEnv, validateServiceDescriptor, buildChildEnv, type ResolvedServiceRow, type ServiceEnvLayers } from "./service-config.js";
import { appendBounded, truncateText } from "./bounded-buffer.js";
import { scrubSecretText } from "./browser-rules.js";
import { resolveWorkspacePath, type WorkspaceAttribution, type WorkspaceRoot } from "./workspace-files.js";

/** Bounded terminal history: lines kept per instance and characters per line. */
export const MAX_TERMINAL_HISTORY = 200;
export const MAX_TERMINAL_LINE = 2000;
/** Max live terminal instances one task Host tracks. */
export const MAX_TERMINAL_INSTANCES = 8;
/** Window bounds: a resize outside this range is refused, not clamped silently. */
export const MIN_TERMINAL_COLS = 20;
export const MIN_TERMINAL_ROWS = 5;
export const MAX_TERMINAL_COLS = 500;
export const MAX_TERMINAL_ROWS = 200;

/** Who opened the terminal: an agent session, or an explicit human action. */
export interface TerminalOwner {
  taskId: string;
  /** `null` = human-UI explicit; never a session claim the Host did not resolve. */
  sessionId: string | null;
  label: string;
}

export interface TerminalPlan {
  instanceId: string;
  taskId: string;
  rootId: string;
  attribution: WorkspaceAttribution;
  /** Explicit program + argv (never a shell string). */
  program: string;
  args: string[];
  /** The selected root: repo worktree cwd or the plain-directory link itself. */
  cwd: string;
  /** Fresh per-terminal env object; never `process.env`. */
  env: Record<string, string>;
  /** Display rows of the resolved env, values masked where secret. */
  resolved: ResolvedServiceRow[];
  cols: number;
  rows: number;
  owner: TerminalOwner;
  historyLimit: number;
}

export type TerminalPlanResult = { ok: true; plan: TerminalPlan } | { ok: false; error: string };

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * The checks a program from this module's own profile table still has to pass.
 *
 * It is deliberately not `validateServiceDescriptor` minus a rule: the caller
 * rule's whitespace test exists to make a caller-authored command line
 * impossible (`FOO=bar cmd`, `bash -c …`), and a table path is not a caller
 * string. What is checked here is the precise property instead - the whole value
 * must be ONE absolute path, and it may not carry the two other smuggles the #7
 * rule names (`=` inline assignment, and shell chaining) - while the host seam
 * additionally proves that this entire string names an existing executable file,
 * which no command line can. Caller programs are untouched: they still go
 * through `validateServiceDescriptor` exactly as before.
 */
function validateProfileProgram(program: string): string | null {
  if (program.length === 0) return "启动程序不能为空";
  const absolute =
    program.startsWith("/") || /^[A-Za-z]:[\\/]/.test(program) || /^\\\\[^\\]+\\[^\\]+/.test(program);
  if (!absolute) return `终端 shell 配置必须是本机绝对路径：${program}`;
  if (program.includes("=")) return `终端 shell 配置不能携带内联环境赋值：${program}`;
  if (/(&&|\|\||[;|`]|\$\()/.test(program)) return `终端 shell 配置不能使用 shell 连接符：${program}`;
  return null;
}

/**
 * Plan one terminal for a task root. Fail-closed at every step: an unknown
 * root, a root-less selection, an invalid program/argv, an out-of-range window
 * or a broken env layer (duplicate keys, secrets in the shared template,
 * missing `${REF}`) all refuse instead of launching something unexpected.
 */
export function planTerminal(input: {
  roots: readonly WorkspaceRoot[];
  taskId: string;
  taskDir: string;
  rootId: unknown;
  /** Optional subdirectory inside the root; still confined to that root. */
  relative?: unknown;
  program: unknown;
  args?: unknown;
  /**
   * Where `program` came from. "caller" (the default) is a program a caller
   * named, and it faces every #7 refusal exactly as before. "profile" means main
   * itself resolved it from the platform profile table (`resolveTerminalProfile`)
   * and re-verified at plan time that the whole string is an existing executable
   * file (`host/terminal-profiles.ts`), so it is validated as an absolute path
   * instead of being run through the caller-string proxy - see
   * `validateProfileProgram`. No op payload can set this: the Host's own launch
   * path derives it from `profileId`, and the record's `program`/`profileId` are
   * the only two fields read.
   */
  programSource?: "caller" | "profile";
  layers: ServiceEnvLayers;
  cols?: unknown;
  rows?: unknown;
  owner: TerminalOwner;
  instanceId: string;
  secrets?: readonly string[];
}): TerminalPlanResult {
  const target = resolveWorkspacePath({
    roots: input.roots,
    taskId: input.taskId,
    taskDir: input.taskDir,
    rootId: input.rootId,
    relative: input.relative,
    allowRoot: true,
  });
  if (!target.ok) return { ok: false, error: target.error };
  if (typeof input.program !== "string") return { ok: false, error: "invalid-payload: program must be a string" };
  const args = input.args === undefined ? [] : input.args;
  if (!Array.isArray(args) || !args.every((entry) => typeof entry === "string")) {
    return { ok: false, error: "invalid-payload: args must be an array of strings" };
  }
  // Reuse the #7 launch rule instead of restating it: blank program, inline env
  // assignment and shell chaining are all refused the same way a service launch
  // refuses them, so a terminal cannot become the un-gated exec path.
  //
  // A program MAIN resolved from its own profile table takes `validateProfileProgram`
  // instead: the #7 whitespace rule is a proxy for "this is one executable, not a
  // caller-authored command line", and the documented PowerShell profile -
  // `%ProgramFiles%\PowerShell\7\pwsh.exe`, which is what VS Code starts - is an
  // absolute path WITH a space. That proxy is not needed for a table path, whose
  // precision comes from the host-side check that the entire string names an
  // existing executable file (a command line cannot). Caller programs keep the
  // rule byte for byte; see `validateProfileProgram`.
  const invalid =
    input.programSource === "profile"
      ? validateProfileProgram(input.program)
      : validateServiceDescriptor({
          name: "终端",
          program: input.program,
          args,
          ports: [],
          runType: "long-lived",
        })?.message ?? null;
  if (invalid) return { ok: false, error: `invalid-terminal: ${invalid}` };
  const cols = input.cols === undefined ? 80 : input.cols;
  const rows = input.rows === undefined ? 24 : input.rows;
  if (!isPositiveInt(cols) || cols < MIN_TERMINAL_COLS || cols > MAX_TERMINAL_COLS) {
    return { ok: false, error: `invalid-terminal: 终端列数必须在 ${MIN_TERMINAL_COLS}–${MAX_TERMINAL_COLS} 之间` };
  }
  if (!isPositiveInt(rows) || rows < MIN_TERMINAL_ROWS || rows > MAX_TERMINAL_ROWS) {
    return { ok: false, error: `invalid-terminal: 终端行数必须在 ${MIN_TERMINAL_ROWS}–${MAX_TERMINAL_ROWS} 之间` };
  }
  const resolved = resolveServiceEnv(input.layers);
  if (!resolved.ok) return { ok: false, error: `invalid-terminal: ${resolved.error.message}` };
  const masked = resolved.rows.map((row) => ({ ...row, value: row.secret ? "••••••••" : row.value }));
  return {
    ok: true,
    plan: {
      instanceId: input.instanceId,
      taskId: input.taskId,
      rootId: target.root.id,
      attribution: target.attribution,
      program: input.program.trim(),
      args: [...args],
      cwd: target.absolute,
      env: buildChildEnv(resolved.rows),
      resolved: masked,
      cols,
      rows,
      owner: input.owner,
      historyLimit: MAX_TERMINAL_HISTORY,
    },
  };
}

/**
 * One selectable shell profile, the shape VS Code's own profile table has: an
 * id, the label and `source` the picker shows, and the explicit program + argv
 * the pty is started with. `program` is always an absolute path main resolved.
 */
export interface TerminalShellProfile {
  id: string;
  label: string;
  /** Where the profile comes from, as VS Code spells it (`PowerShell`, `/bin/zsh`). */
  source: string;
  program: string;
  args: string[];
}

/** The OS seam the table is decided through, injected so every platform branch is testable. */
export interface TerminalProfileProbe {
  /** Whether this absolute path names an existing regular file. */
  exists(path: string): boolean;
  /** Whether it also runs: POSIX `X_OK`; win32 has no execute bit, so it repeats `exists`. */
  isExecutable(path: string): boolean;
}

export interface TerminalProfileResolution {
  platform: NodeJS.Platform;
  /** The selectable profiles this host really has, the default first. */
  profiles: TerminalShellProfile[];
  /**
   * The platform default's id: PowerShell on win32, the `$SHELL` login shell on
   * macOS/Linux. `null` means the default itself is missing - which is a named
   * fact (see `unavailable`), never a reason to open a different shell.
   */
  defaultProfileId: string | null;
  /** Profiles this platform names but this host cannot run, with every path that was probed. */
  unavailable: { id: string; label: string; missing: string[] }[];
}

/** One entry of the built-in table: the ids it can resolve to and the argv it runs with. */
interface ProfileCandidate {
  id: string;
  label: string;
  source: string;
  paths: string[];
  args: string[];
}

/** Windows environment names are case-insensitive; POSIX reads the exact name. */
function profileEnvValue(env: Record<string, string | undefined>, name: string, platform: NodeJS.Platform): string | undefined {
  const named = env[name];
  if (named !== undefined && named.length > 0) return named;
  if (platform !== "win32") return undefined;
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  const value = key === undefined ? undefined : env[key];
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * The Windows table, in VS Code's own order of preference.
 *
 * - `PowerShell` is the win32 default. VS Code's PowerShell source starts the
 *   installed PowerShell 7 (`%ProgramFiles%\PowerShell\7\pwsh.exe`) when there
 *   is one and the inbox `%windir%\System32\WindowsPowerShell\v1.0\powershell.exe`
 *   otherwise. `Sysnative` comes first for the same reason VS Code puts it
 *   there: it is the un-redirected view a 32-bit process needs, and it simply
 *   does not exist for a 64-bit one, so the fallback is the documented path.
 * - `Command Prompt` is `${env:windir}\System32\cmd.exe` with an EMPTY argv
 *   (VS Code's own entry), never `/c <something>`.
 * - `Git Bash` is only offered when Git for Windows is really installed, and
 *   runs as a LOGIN shell with `--login -i` (VS Code #119427), so
 *   `~/.bash_profile` is sourced instead of swallowed.
 * - `WSL` is offered when `wsl.exe` exists (VS Code's auto-detected entry).
 *
 * No profile carries `-NoProfile` or any other argument that would skip the
 * user's own profile: that is the whole point of opening their shell.
 */
function win32Candidates(env: Record<string, string | undefined>): ProfileCandidate[] {
  const windowsDir = profileEnvValue(env, "windir", "win32") ?? profileEnvValue(env, "SystemRoot", "win32") ?? "C:\\Windows";
  const programFiles = profileEnvValue(env, "ProgramFiles", "win32");
  const programFilesX86 = profileEnvValue(env, "ProgramFiles(x86)", "win32");
  const localAppData = profileEnvValue(env, "LOCALAPPDATA", "win32");
  return [
    {
      id: "powershell",
      label: "PowerShell",
      source: "PowerShell",
      paths: [
        ...(programFiles === undefined
          ? []
          : [win32Path.join(programFiles, "PowerShell", "7", "pwsh.exe"), win32Path.join(programFiles, "PowerShell", "7-preview", "pwsh.exe")]),
        win32Path.join(windowsDir, "Sysnative", "WindowsPowerShell", "v1.0", "powershell.exe"),
        win32Path.join(windowsDir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ],
      args: [],
    },
    {
      id: "command-prompt",
      label: "Command Prompt",
      source: "Command Prompt",
      paths: [win32Path.join(windowsDir, "Sysnative", "cmd.exe"), win32Path.join(windowsDir, "System32", "cmd.exe")],
      args: [],
    },
    {
      id: "git-bash",
      label: "Git Bash",
      source: "Git Bash",
      paths: [
        ...(programFiles === undefined ? [] : [win32Path.join(programFiles, "Git", "bin", "bash.exe")]),
        ...(programFilesX86 === undefined ? [] : [win32Path.join(programFilesX86, "Git", "bin", "bash.exe")]),
        ...(localAppData === undefined ? [] : [win32Path.join(localAppData, "Programs", "Git", "bin", "bash.exe")]),
      ],
      args: ["--login", "-i"],
    },
    { id: "wsl", label: "WSL", source: "WSL", paths: [win32Path.join(windowsDir, "System32", "wsl.exe")], args: [] },
  ];
}

/**
 * The macOS/Linux table. Every entry is a LOGIN shell (`-l`).
 *
 * VS Code resolves the terminal's environment by starting a login shell once and
 * merging what it prints, which is how a PATH addition in `~/.zprofile` reaches
 * the terminal. This Host's child environment comes from the #7 layer resolution
 * and never reads the user's login environment, so the equivalent available here
 * is to replace the shell itself so the user's own profile really runs: `-l` is
 * the same mechanism VS Code gives Git Bash for exactly this reason. It is a
 * recorded divergence from VS Code's exact argv (`args: []` on its zsh/bash
 * entries), not a claim to have inherited the login environment.
 */
function posixCandidates(): ProfileCandidate[] {
  return [
    { id: "zsh", label: "zsh", source: "/bin/zsh", paths: ["/bin/zsh"], args: ["-l"] },
    { id: "bash", label: "bash", source: "/bin/bash", paths: ["/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"], args: ["-l"] },
    { id: "sh", label: "sh", source: "/bin/sh", paths: ["/bin/sh"], args: ["-l"] },
    { id: "fish", label: "fish", source: "fish", paths: ["/opt/homebrew/bin/fish", "/usr/local/bin/fish", "/usr/bin/fish"], args: ["-l"] },
  ];
}

/**
 * Resolve the platform's shell profiles against an injected environment and file
 * probe.
 *
 * Rules, all decided here (never by the renderer):
 * - win32 offers PowerShell/Command Prompt/Git Bash/WSL in that order and its
 *   default is PowerShell; the first profiled path that exists and is executable
 *   wins, so an absent PowerShell 7 falls through to the inbox 5.1.
 * - macOS/Linux default to the login shell `$SHELL` names, but only after it is
 *   validated as an existing absolute executable; `SHELL` that fails that check
 *   is ignored and the documented fallback is `zsh` (`/bin/zsh`). A `$SHELL`
 *   outside the table is added to it under its own basename.
 * - A profile this host cannot run is omitted and reported in `unavailable` with
 *   every path that was probed, so a failure can name the executable it looked
 *   for instead of silently opening some other shell.
 * - The default is listed first, as VS Code documents its own list ("the first
 *   profile is the default").
 */
export function resolveShellProfiles(input: {
  platform?: NodeJS.Platform;
  env: Record<string, string | undefined>;
  probe: TerminalProfileProbe;
}): TerminalProfileResolution {
  const platform = input.platform ?? process.platform;
  const candidates = platform === "win32" ? win32Candidates(input.env) : withLoginShell(posixCandidates(), input.env);
  const defaultProfileId = platform === "win32" ? "powershell" : loginShellProfileId(input.env);
  const profiles: TerminalShellProfile[] = [];
  const unavailable: TerminalProfileResolution["unavailable"] = [];
  for (const candidate of candidates) {
    const program = candidate.paths.find((path) => input.probe.exists(path) && input.probe.isExecutable(path));
    if (program === undefined) {
      unavailable.push({ id: candidate.id, label: candidate.label, missing: [...candidate.paths] });
      continue;
    }
    profiles.push({ id: candidate.id, label: candidate.label, source: candidate.source, program, args: [...candidate.args] });
  }
  // A default that is not installed is `null`, not a different shell: the caller
  // then names the missing executable and lets the user pick another profile.
  const resolvedDefault = profiles.some((profile) => profile.id === defaultProfileId) ? defaultProfileId : null;
  // The default is listed first, as VS Code documents its own list.
  const ordered =
    resolvedDefault === null
      ? profiles
      : [profiles.find((profile) => profile.id === resolvedDefault)!, ...profiles.filter((profile) => profile.id !== resolvedDefault)];
  return { platform, profiles: ordered, defaultProfileId: resolvedDefault, unavailable };
}

/**
 * The id `$SHELL` selects on macOS/Linux, before it is known to be installed:
 * the basename of an absolute, existing, executable `$SHELL`, else `zsh` (the
 * documented fallback `/bin/zsh`). A non-absolute or missing `$SHELL` - a Git
 * Bash `SHELL=/usr/bin/bash` typo is the same shape - never names a profile.
 */
function loginShellProfileId(env: Record<string, string | undefined>): string {
  const shell = env["SHELL"];
  if (shell !== undefined && posixPath.isAbsolute(shell)) return posixPath.basename(shell);
  return "zsh";
}

/**
 * Fold an absolute `$SHELL` into the table: it selects one of the table entries
 * when it matches, and is added under its own basename when it does not (an
 * `$SHELL` this table has never heard of is still the user's own login shell).
 */
function withLoginShell(candidates: ProfileCandidate[], env: Record<string, string | undefined>): ProfileCandidate[] {
  const shell = env["SHELL"];
  if (shell === undefined || !posixPath.isAbsolute(shell)) return candidates;
  if (candidates.some((candidate) => candidate.paths.includes(shell))) return candidates;
  return [...candidates, { id: posixPath.basename(shell), label: posixPath.basename(shell), source: shell, paths: [shell], args: ["-l"] }];
}

export type TerminalProfileSelection = { ok: true; profile: TerminalShellProfile } | { ok: false; error: string };

/**
 * Select one profile by the id a caller named. A known-but-uninstalled profile
 * and an unknown one are both refused BY NAME, with the paths that were probed
 * or the ids that are available, so nothing is silently replaced by another
 * shell.
 */
export function resolveTerminalProfile(resolution: TerminalProfileResolution, profileId: unknown): TerminalProfileSelection {
  if (typeof profileId !== "string" || profileId.trim().length === 0) {
    return { ok: false, error: "invalid-payload: 终端 shell 配置标识必须是非空字符串" };
  }
  const id = profileId.trim();
  const profile = resolution.profiles.find((candidate) => candidate.id === id);
  if (profile) return { ok: true, profile };
  const named = resolution.unavailable.find((candidate) => candidate.id === id);
  if (named) {
    return { ok: false, error: `terminal-profile-unavailable: 终端 shell 配置「${named.label}」在本机不可用：未找到 ${named.missing.join("、")}` };
  }
  const available = resolution.profiles.map((candidate) => candidate.id);
  return {
    ok: false,
    error:
      available.length === 0
        ? `terminal-profile-unknown: 本机没有终端 shell 配置「${id}」，且未解析出任何可用配置`
        : `terminal-profile-unknown: 本机没有终端 shell 配置「${id}」；可用：${available.join("、")}`,
  };
}

/** One live-or-exited terminal instance of one task. */
export interface TerminalInstanceRecord {
  instanceId: string;
  taskId: string;
  rootId: string;
  attribution: WorkspaceAttribution;
  program: string;
  args: string[];
  cwd: string;
  owner: TerminalOwner;
  cols: number;
  rows: number;
  /** Non-secret env keys only: values stay Host-side (`plan.env`). */
  envKeys: string[];
  lifecycle: "running" | "exited";
  /** OS process identity; absent until the spawner reports it. */
  processId?: number;
  /**
   * The process-group id the spawner reported for that pid. A forkpty child is
   * a session/group leader (`pgid === pid`), so a stop signals `-processGroupId`
   * and can name exactly one group. It is recorded beside the pid because a
   * group id that does not match the recorded pid is not this terminal's group.
   * Absent where the platform has no group (win32), where the stop instead
   * terminates the Host-owned helper handle.
   */
  processGroupId?: number;
  startedAt: string;
  /** Observed state after exit (box 5: show the real end state). */
  exitedAt?: string;
  exitCode?: number;
  exitReason?: string;
  history: { at: string; line: string }[];
}

/** What a stop request must match: instance + process identity, never a port. */
export interface TerminalStopScope {
  taskId: string;
  instanceId: string;
  processId: number;
  startedAt: string;
}

export type TerminalStopResult = { ok: true; scope: TerminalStopScope } | { ok: false; error: string };

/**
 * Bounded registry of one task's terminal instances. Ownership is explicit:
 * `taskId` is fixed at construction, so an instance of another task is
 * `task-mismatch` and can never be stopped from here. Stop scopes are proven
 * from the recorded process identity — a port is not an identity, and a
 * missing pid fails closed (`unknown-process`) rather than stopping whatever
 * happens to listen there.
 */
export class TaskTerminalRegistry {
  private readonly instances = new Map<string, TerminalInstanceRecord>();

  constructor(
    readonly taskId: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  list(): TerminalInstanceRecord[] {
    return [...this.instances.values()].map((record) => this.copy(record));
  }

  get(instanceId: string): TerminalInstanceRecord | undefined {
    const record = this.instances.get(instanceId);
    return record ? this.copy(record) : undefined;
  }

  /** Register a planned terminal. Bounded; re-registering the same id keeps its history/lifecycle. */
  register(plan: TerminalPlan): TerminalInstanceRecord {
    if (plan.taskId !== this.taskId) {
      throw new Error(`task-mismatch: 终端 ${plan.instanceId} 属于任务 ${plan.taskId}，不能注册到 ${this.taskId}`);
    }
    const existing = this.instances.get(plan.instanceId);
    if (!existing && this.instances.size >= MAX_TERMINAL_INSTANCES) {
      throw new Error(`terminal-limit: 本任务已登记 ${MAX_TERMINAL_INSTANCES} 个终端，请先停止不再使用的终端`);
    }
    const record: TerminalInstanceRecord = {
      instanceId: plan.instanceId,
      taskId: this.taskId,
      rootId: plan.rootId,
      attribution: plan.attribution,
      program: plan.program,
      args: [...plan.args],
      cwd: plan.cwd,
      owner: { ...plan.owner },
      cols: plan.cols,
      rows: plan.rows,
      envKeys: Object.keys(plan.env).sort(),
      lifecycle: existing?.lifecycle ?? "running",
      ...(existing?.processId !== undefined ? { processId: existing.processId } : {}),
      ...(existing?.processGroupId !== undefined ? { processGroupId: existing.processGroupId } : {}),
      startedAt: existing?.startedAt ?? this.now(),
      ...(existing?.exitedAt !== undefined ? { exitedAt: existing.exitedAt } : {}),
      ...(existing?.exitCode !== undefined ? { exitCode: existing.exitCode } : {}),
      ...(existing?.exitReason !== undefined ? { exitReason: existing.exitReason } : {}),
      history: existing ? existing.history.map((entry) => ({ ...entry })) : [],
    };
    this.instances.set(plan.instanceId, record);
    return this.copy(record);
  }

  /**
   * Record the OS process identity the spawner observed. `processGroupId` is
   * recorded exactly when the spawner observed one: a forkpty child leads its own
   * group, so a POSIX caller passes the group it read, and a platform that has no
   * process group (win32) passes none and gets none recorded - it is NEVER
   * defaulted to the pid, which would store a group nobody observed and make the
   * record claim an ownership the platform cannot have. A mismatch is refused at
   * stop time, never guessed.
   */
  markProcess(instanceId: string, input: { processId: unknown; processGroupId?: unknown; startedAt?: unknown }): TerminalInstanceRecord {
    const record = this.require(instanceId);
    if (!isPositiveInt(input.processId)) throw new Error("invalid-process: 终端进程号必须是正整数");
    if (input.processGroupId !== undefined && !isPositiveInt(input.processGroupId)) throw new Error("invalid-process: 终端进程组号必须是正整数");
    record.processId = input.processId;
    if (input.processGroupId === undefined) delete record.processGroupId;
    else record.processGroupId = input.processGroupId;
    if (typeof input.startedAt === "string" && input.startedAt.trim().length > 0) record.startedAt = input.startedAt.trim();
    return this.copy(record);
  }

  /** Window resize inside the documented bounds; a bad size is refused, not clamped. */
  resize(instanceId: string, input: { cols: unknown; rows: unknown }): TerminalInstanceRecord {
    const record = this.require(instanceId);
    if (
      !isPositiveInt(input.cols) ||
      !isPositiveInt(input.rows) ||
      input.cols < MIN_TERMINAL_COLS ||
      input.cols > MAX_TERMINAL_COLS ||
      input.rows < MIN_TERMINAL_ROWS ||
      input.rows > MAX_TERMINAL_ROWS
    ) {
      throw new Error(`invalid-terminal: 终端窗口大小超出 ${MIN_TERMINAL_COLS}x${MIN_TERMINAL_ROWS}–${MAX_TERMINAL_COLS}x${MAX_TERMINAL_ROWS}`);
    }
    record.cols = input.cols;
    record.rows = input.rows;
    return this.copy(record);
  }

  /** Append one output line: bounded history, masked, bounded line length. */
  appendOutput(instanceId: string, line: string, secrets: readonly string[] = []): TerminalInstanceRecord {
    const record = this.require(instanceId);
    appendBounded(
      record.history,
      { at: this.now(), line: truncateText(scrubSecretText(line, secrets), MAX_TERMINAL_LINE) },
      MAX_TERMINAL_HISTORY,
    );
    return this.copy(record);
  }

  history(instanceId: string, limit = 50): { at: string; line: string }[] {
    const record = this.require(instanceId);
    return record.history.slice(-Math.max(1, limit)).map((entry) => ({ ...entry }));
  }

  /**
   * Reopen an instance whose previous run exited, so a restart is a new run:
   * the exit record of the previous run is cleared. Without this a restarted
   * terminal kept `lifecycle: "exited"` (and its stale pid), which made a later
   * stop return success without signalling the shell that was really running.
   */
  markRunning(instanceId: string): TerminalInstanceRecord {
    const record = this.require(instanceId);
    record.lifecycle = "running";
    delete record.exitedAt;
    delete record.exitCode;
    delete record.exitReason;
    return this.copy(record);
  }

  /** Record the real exit state so the panel never shows a stale "running". */
  markExited(instanceId: string, input: { exitCode?: unknown; reason?: unknown } = {}): TerminalInstanceRecord {
    const record = this.require(instanceId);
    record.lifecycle = "exited";
    record.exitedAt = this.now();
    if (typeof input.exitCode === "number" && Number.isInteger(input.exitCode)) record.exitCode = input.exitCode;
    if (typeof input.reason === "string" && input.reason.trim().length > 0) record.exitReason = input.reason.trim();
    return this.copy(record);
  }

  /** Terminal instances still owned by one agent session (write coordination readout). */
  ownedBySession(sessionId: string): TerminalInstanceRecord[] {
    return this.list().filter((record) => record.owner.sessionId === sessionId && record.lifecycle === "running");
  }

  /**
   * Prove what a stop request may act on: same task, known instance, and a
   * recorded process identity (the pid the spawner observed). Anything else
   * fails closed with a reason the UI shows.
   *
   * The recorded pid is the whole identity this registry can name. What a stop
   * may then act on is platform-specific and belongs to the driver that owns the
   * session: a process group that has to still belong to that pid where the
   * platform owns groups, and the Host-owned helper handle on win32 where none
   * exists. This method therefore never invents or requires a group - a record
   * the spawner gave no group (win32) is a start the Host can still stop, not a
   * reason to refuse.
   */
  stopScope(instanceId: string): TerminalStopResult {
    const record = this.instances.get(instanceId);
    if (!record) return { ok: false, error: `unknown-instance: 本任务没有终端实例 ${instanceId}` };
    if (record.taskId !== this.taskId) {
      return { ok: false, error: `task-mismatch: 终端 ${instanceId} 属于任务 ${record.taskId}，不会停止其他任务的进程` };
    }
    if (record.processId === undefined) {
      return { ok: false, error: `unknown-process: 终端 ${instanceId} 尚未报告进程号，无法安全停止` };
    }
    return { ok: true, scope: { taskId: record.taskId, instanceId: record.instanceId, processId: record.processId, startedAt: record.startedAt } };
  }

  /** Drop one instance (panel closed after exit, or task disposed). */
  remove(instanceId: string): void {
    this.instances.delete(instanceId);
  }

  private require(instanceId: string): TerminalInstanceRecord {
    const record = this.instances.get(instanceId);
    if (!record) throw new Error(`unknown-instance: 本任务没有终端实例 ${instanceId}`);
    return record;
  }

  private copy(record: TerminalInstanceRecord): TerminalInstanceRecord {
    return {
      ...record,
      args: [...record.args],
      owner: { ...record.owner },
      envKeys: [...record.envKeys],
      attribution: { ...record.attribution },
      history: record.history.map((entry) => ({ ...entry })),
    };
  }
}
