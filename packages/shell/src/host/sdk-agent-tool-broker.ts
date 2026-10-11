/**
 * The Agent tool broker ([PiDock 02m] #5): the ONE enforcement point for every
 * effect an Agent tool has.
 *
 * Why here and not in the SDK tools: the model context (and therefore the
 * `AgentSession` that owns the tools) runs in a worker thread that has no
 * credential and no host services. `sdk-agent-tool-contract.ts` declares four
 * tools to that worker; none of them touches the filesystem or a process. Every
 * call travels back to this broker, which is the only code that acts, and only
 * after this order succeeds:
 *
 * 1. **arguments** are re-validated from scratch (the worker's schema is never
 *    trusted: unknown keys, wrong types and oversized payloads are refused);
 * 2. **confinement** resolves the requested path lexically *and* on its real
 *    path (so a symlink that points outside is refused), then requires it to be
 *    inside this task: the original checkout, another task's folder, an
 *    application-private path and anything outside the task folder are refused
 *    by name before any read or write; a write must additionally land inside one
 *    of this task's own worktrees;
 * 3. the **existing permission gate** (`main/pi-session.ts` semantics) decides:
 *    `read` denies every non-read tool, `default` asks for command tools, `auto`
 *    allows inside the task;
 * 4. a mutating tool **claims the task write right** (`write-coordination.ts`)
 *    around its whole effect and releases it when the tool completes, and
 * 5. an approval is **re-checked immediately before execution** (live tier,
 *    approval scope, tool/target/payload version, real path, one-shot spend).
 *
 * A refusal is returned as a tool result (the model adapts); it is never an
 * exception that kills the session. Confinement is deliberately repeated at
 * execution time, so an approval can never be spent on a different path, a
 * different file state or a different command.
 *
 * Honest boundary: `exec.run` runs a real shell. Its working directory and the
 * path arguments that can be *recognised* as paths are confined — the command
 * is split on shell operators so a glued redirect (`x>/tmp/y`) is seen, a token
 * naming a `.git` control path is refused whatever its case, quoting or simple
 * backslash escaping (`echo x > .g\it` is the same control file to the shell as
 * `echo x > .git`), and a command whose expansion cannot be decoded (`$`,
 * backticks) is refused rather than approximated. This is a filter, not a
 * sandbox: only tokens that contain `/`, start with `~`, are exactly `..` or
 * name a `.git` segment are examined, so a path the shell re-encodes
 * (`printf '\057tmp' | xargs touch`) is not decoded here, and an embedded
 * interpreter (`python -c …`) is not decoded either. The confinement rules that
 * stop a wrong *tool path* are what this module proves; the human approval under
 * `default` remains the boundary for arbitrary command execution.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { PiApproval, PiApprovalScope, PiGateDecision, PiPermission } from "../main/pi-session.js";
import { AGENT_TOOL_SCOPE, SERVICE_CONTROL_SCOPE } from "../main/pi-session.js";
import type { ControlExecutionPort } from "./execution-ledger.js";
import { isCredentialEnvName } from "./explicit-text-provider.js";
import { normalizeScopePath } from "./path-coordination.js";
import { runAgentServiceControl, type ServiceExecutionDriver } from "./service-control.js";
import { SERVICE_CONTROL_TOOL, type ServiceRecord, type TaskServiceRuntime } from "./service-runtime.js";
import { writeClaimError, type WriteCoordinatorPort } from "./write-coordination.js";
import {
  sdkAgentToolSpec,
  type SdkAgentToolName,
  type SdkAgentToolOutcome,
  type SdkAgentToolRequest,
  type SdkAgentToolSpec,
} from "./sdk-agent-tool-contract.js";

/** Bounded effects: a tool never streams an unbounded payload through a turn. */
const MAX_PATH_CHARS = 4096;
const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_SEARCH_PATTERN_CHARS = 512;
const MAX_SEARCH_MATCHES = 200;
const MAX_SEARCH_FILES = 2000;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_COMMAND_CHARS = 4096;
const MAX_COMMAND_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;
/**
 * The Agent service surface is bounded like every other tool: a service id is
 * an identifier, never a path, and the log tail is a bounded read of the
 * Host's own already-truncated/redacted lines.
 */
const MAX_SERVICE_ID_CHARS = 128;
const SERVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SERVICE_LOG_LIMIT = 100;
const DEFAULT_SERVICE_LOG_LIMIT = 40;
const MAX_SERVICE_LOG_BYTES = 8 * 1024;
/** Write-irrelevant device paths a command may still name. */
const COMMAND_DEVICE_ALLOWLIST = new Set(["/dev/null"]);

/** One worktree of this task: `<taskDir>/<repoDir>`. */
export interface SdkAgentWorktree {
  repoDir: string;
  path: string;
}

/**
 * One plain-directory link of this task ([PiDock 03] #6). `path` is the in-task
 * link the Agent names; `sourcePath` is the recorded original it shares. A link
 * is NOT a copy: a write through `path` changes files under `sourcePath`.
 */
export interface SdkAgentSharedDir {
  linkName: string;
  path: string;
  sourcePath: string;
}

/** Everything the broker needs to know about "this task". */
export interface SdkAgentToolScope {
  taskDir: string;
  /** The folder that holds this task (and its sibling tasks). */
  taskRoot: string;
  worktrees: readonly SdkAgentWorktree[];
  /**
   * Plain-directory links ([PiDock 03] #6): shared, non-isolated views of the
   * original files. Optional so a pre-#6 caller keeps compiling (absent = none).
   */
  sharedDirs?: readonly SdkAgentSharedDir[];
  /** Recorded source checkouts (the ORIGINAL clones): never tool-accessible. */
  primaryCheckouts: readonly string[];
  /** Application-private paths; throws for a path that is one. */
  assertProtected(path: string): void;
}

/**
 * The real service machinery of this task ([PiDock 04] #7), as the Host owns
 * it: the SAME `TaskServiceRuntime` the `task/registerService` and
 * `task/serviceStatus` ops answer from, the SAME `TaskServiceProcesses` driver
 * `task/controlService` uses, and the same durable-owner uncertainty check. The
 * Agent service tools never build any of this themselves and never accept a
 * program, path, port or environment value from the model: the Host hands this
 * surface in (`host.ts`), and a Host without it refuses every service tool by
 * name instead of falling back to a local effect.
 */
export interface SdkAgentServiceHost {
  readonly services: TaskServiceRuntime;
  /** The Host's real process driver (registered process identity only), built on first control. */
  driver(): ServiceExecutionDriver;
  /** The durable-owner uncertainty refusal for one service, or `null` when control/read may proceed. */
  refusal(serviceId: string): string | null;
  /** The task's execution ledger: every Agent control records one run ([PiDock 14] #17). */
  readonly executions?: ControlExecutionPort;
}

/** The gate surface of one session channel (structural `PiSessionChannel`). */
export interface SdkAgentToolChannel {
  readonly currentPermission: PiPermission;
  previewGate(toolName: string, target: string): PiGateDecision;
  gate(toolName: string, target: string, contentVersion: string, currentCallId?: string, scope?: PiApprovalScope, operation?: string): PiGateDecision;
  consumeApproval(approvalId: string): boolean;
  reject(approvalId: string): void;
  snapshot(): { approvals: PiApproval[] };
}

export interface SdkAgentCommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

export interface SdkAgentToolBrokerOptions {
  /** True when the Host knows this session (a live channel or a saved snapshot). */
  sessionKnown(sessionId: string): boolean;
  channel(sessionId: string): SdkAgentToolChannel;
  /** Persists the channel snapshot after minting or spending a confirmation. */
  persist(sessionId: string): void;
  write: WriteCoordinatorPort;
  scope(): SdkAgentToolScope;
  /**
   * The task's real service surface ([PiDock 04] #7). Absent means this Host
   * has none (a pre-#7 wiring or a task-unbound Host): every service tool is
   * then refused by name, and nothing is started, stopped or read.
   */
  services?: () => SdkAgentServiceHost | undefined;
  /** Real path: `realpath` of the deepest existing ancestor + the rest. */
  resolveRealPath(path: string): string;
  /** True while the Host is closing (no new effect may start). */
  closing(): boolean;
  approvalTimeoutMs?: number;
  /** Process boundary for `exec.run`; injected so tests drive their own. */
  runCommand?: (input: { command: string; cwd: string; timeoutMs: number }) => Promise<SdkAgentCommandResult>;
}

export type SdkAgentApprovalVerdict = "approved" | "rejected" | "cancelled" | "expired" | "closed";

type PathRefusal = { ok: false; code: string; reason: string };
type PathAllowed = { ok: true; absolute: string; real: string };

function refuse(code: string, reason: string): SdkAgentToolOutcome {
  return { outcome: "refused", code, text: `${code}: ${reason}` };
}

function pathRefuse(code: string, reason: string): PathRefusal {
  return { ok: false, code, reason };
}

/** Components followed before a link chain is declared unresolvable. */
const MAX_LINK_DEPTH = 64;

type SymlinkComponent = { link: string; target: string };

/** The first path component that is a symlink, or `null` once none is left. */
function findSymlinkComponent(path: string): SymlinkComponent | null {
  const absolute = resolve(path);
  const root = parse(absolute).root || sep;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep)) {
    if (part.length === 0) continue;
    current = join(current, part);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // "Does not exist yet" is the normal case for a write target; anything
      // else (e.g. a denied stat) must not be treated as absence.
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    }
    if (stat.isSymbolicLink()) return { link: current, target: readlinkSync(current) };
  }
  return null;
}

/**
 * Resolve a path following every symlink component, including a link whose
 * target does not exist yet, and then complete the result with the host's real
 * path resolver.
 *
 * Why not `resolveRealPath` alone: it resolves the *deepest existing* ancestor,
 * so a symlink whose target is missing counts as absent, and a write through it
 * would create the file at the link's target — outside the task. Walking the
 * components here closes that hole; a chain that never terminates (or an
 * unreadable component) is refused by name instead of being approximated.
 */
function resolveLinkChain(path: string, realpath: (value: string) => string): string {
  let current = resolve(path);
  for (let depth = 0; depth < MAX_LINK_DEPTH; depth++) {
    const found = findSymlinkComponent(current);
    if (!found) return realpath(current);
    const target = isAbsolute(found.target) ? found.target : resolve(dirname(found.link), found.target);
    current = resolve(target, relative(found.link, current));
  }
  throw new Error("tool-refused:symlink-depth");
}

/**
 * True when `path` is `root` itself or inside it.
 *
 * Deliberately directional: `pathScopeOverlaps` is symmetric, so it would also
 * accept an *ancestor* of the root (the task folder above its own worktree, or
 * the folder holding every task), which is exactly the escape a write must not
 * take.
 */
function withinScope(path: string, root: string): boolean {
  const target = normalizeScopePath(path);
  const scope = normalizeScopePath(root);
  if (target.length === 0 || scope.length === 0) return false;
  return target === scope || target.startsWith(`${scope}/`);
}

/**
 * True when a path names a git control entry (`.git`, `.GIT`, …) as one of its
 * segments.
 *
 * Case-insensitive on purpose: macOS (APFS) and Windows are product targets,
 * and there `repo/.git` and `repo/.GIT` are the SAME directory entry. Neither
 * `normalizeScopePath` (it folds only a Windows drive letter) nor production's
 * non-native `realpathSync` folds segment case, so a case-sensitive compare
 * would let `.GIT` rewrite a worktree's git pointer and retarget git at the
 * primary checkout this module exists to keep out of reach.
 *
 * A segment that is the *value* of an assignment (`dd of=.git`,
 * `GIT_DIR=.git`, `--git-dir=.git`) names the control path just as a bare
 * token does, so the segment boundary includes `=` after a plain segment.
 */
function hasGitControlSegment(path: string): boolean {
  return path
    .split(/[\\/]+/)
    .some((segment) => segment.toLowerCase() === ".git" || /(?:^|=)\.git$/i.test(segment));
}

/**
 * The one spelling a POSIX shell actually executes for a token: outside quotes a
 * backslash escapes the next character (`\g` → `g`) and quote characters are
 * removed (`.g"i"t` → `.git`). The `.git` guard must compare this spelling too,
 * because `.g\it` carries no `/`, is dropped by the path-shape filter, and its
 * raw-token segment split (`[\\/]`) yields `[".g", "it"]` — so a raw-token-only
 * test lets `echo x > .g\it` overwrite the worktree's git pointer under `auto`.
 * This decodes simple escapes and quoting only, never expansions or the shell
 * grammar: it stays a filter, not a sandbox.
 */
function unquoteShellToken(token: string): string {
  return token.replace(/\\(.)/g, "$1").replace(/['"]/g, "");
}

/**
 * Resolve one requested path against the task scope. `base` is what a relative
 * path is relative to (the task folder for file tools, the command's working
 * directory for `exec.run`) — never the Host process cwd.
 *
 * Order matters: the named refusals tell the model *why* it was refused, and
 * every check runs on the real path so a symlink cannot smuggle a target past
 * the lexical comparison.
 */
export function resolveSdkAgentToolPath(input: {
  scope: SdkAgentToolScope;
  resolveRealPath: (path: string) => string;
  requested: string;
  base: string;
  mode: "read" | "write";
}): PathAllowed | PathRefusal {
  const requested = input.requested.trim();
  if (requested.length === 0 || requested.length > MAX_PATH_CHARS || requested.includes("\0")) {
    return pathRefuse("tool-refused:invalid-path", "路径为空、过长或包含 NUL，无法校验");
  }
  const lexical = resolve(input.base, requested);
  let real: string;
  try {
    real = resolveLinkChain(lexical, input.resolveRealPath);
  } catch {
    return pathRefuse("tool-refused:invalid-path", `路径无法解析：${requested}`);
  }
  // Every comparison below is between real paths: the scope's own roots are
  // resolved the same way (a task under a symlinked temp/home folder keeps its
  // identity) instead of being trusted as written.
  const realRoot = (path: string): string => {
    try {
      return normalizeScopePath(resolveLinkChain(path, input.resolveRealPath));
    } catch {
      return normalizeScopePath(path);
    }
  };
  try {
    input.scope.assertProtected(lexical);
    input.scope.assertProtected(real);
  } catch {
    return pathRefuse("tool-refused:protected-path", "目标位于应用私有目录，任务工具不可访问");
  }
  for (const checkout of input.scope.primaryCheckouts) {
    if (withinScope(real, realRoot(checkout))) {
      return pathRefuse("tool-refused:primary-checkout", `目标位于原始检出目录 ${checkout}，任务工具不会回退到主检出`);
    }
  }
  const taskDir = realRoot(input.scope.taskDir);
  const taskRoot = realRoot(input.scope.taskRoot);
  const normalizedReal = normalizeScopePath(real);
  const lexicalKey = normalizeScopePath(lexical);
  // Plain-directory links ([PiDock 03] #6): the Agent reaches a shared original
  // only THROUGH its in-task link path, and only when the resolved real path
  // stays under that link's recorded original. Both halves are required — the
  // link name is the entry point, the real path is the confinement — so naming
  // the original directly, or a link inside it that escapes it, is refused.
  const sharedDirs = (input.scope.sharedDirs ?? [])
    .map((shared) => ({ link: normalizeScopePath(resolve(shared.path)), real: realRoot(shared.sourcePath) }))
    .filter((shared) => shared.link.length > 0 && shared.real.length > 0);
  const inTask = taskDir.length > 0 && withinScope(normalizedReal, taskDir);
  const shared = inTask
    ? undefined
    : sharedDirs.find((entry) => withinScope(lexicalKey, entry.link) && withinScope(normalizedReal, entry.real));
  if (!inTask && shared === undefined) {
    if (sharedDirs.some((entry) => withinScope(lexicalKey, entry.link))) {
      return pathRefuse("tool-refused:out-of-scope", `链接指向其原始目录之外（解析为 ${normalizedReal}），已拒绝`);
    }
    return taskRoot.length > 0 && withinScope(normalizedReal, taskRoot)
      ? pathRefuse("tool-refused:other-task", `目标是本任务目录 ${taskDir} 之外的兄弟路径（${normalizedReal}），任务工具只在本任务范围内工作`)
      : pathRefuse("tool-refused:out-of-scope", `目标不在任务目录 ${taskDir} 内（解析为 ${normalizedReal}）`);
  }
  if (input.mode === "write") {
    const worktrees = input.scope.worktrees
      .map((worktree) => realRoot(worktree.path))
      .filter((root) => root.length > 0);
    const inWorktree = worktrees.some((root) => withinScope(normalizedReal, root));
    // A shared link is writable like a worktree: it is a shared view of the
    // original, and the create/append flow already required the user's
    // `sharedWriteConfirmed` before the link existed. Cross-task write
    // coordination for such a target is #11 / box 13 and stays deferred.
    if (!inWorktree && shared === undefined) {
      return pathRefuse(
        "tool-refused:not-a-worktree",
        input.scope.worktrees.length === 0 && (input.scope.sharedDirs ?? []).length === 0
          ? "本任务尚无可用工作副本，不可写入"
          : `目标不在任务工作副本或普通目录链接内（可写：${[...input.scope.worktrees.map((worktree) => worktree.path), ...(input.scope.sharedDirs ?? []).map((dir) => dir.path)].join("、")}）`,
      );
    }
    // A write must never rewrite a worktree's own git control file: in a linked
    // worktree `.git` is a regular file naming the primary checkout, so writing
    // it would silently retarget git at the checkout this module exists to keep
    // out of reach (and `derivedPrimaryCheckouts` would then trust the forgery).
    // Git changes go through `exec.run`, never a raw write to the control file.
    // The segment is matched case-insensitively: on APFS/Windows `repo/.GIT` IS
    // `repo/.git`, so a case-sensitive compare is not a guard at all. The same
    // guard covers a shared original's own git control files.
    if (hasGitControlSegment(normalizedReal)) {
      return pathRefuse("tool-refused:invalid-target", "不可写入 .git 控制文件或目录（大小写不敏感）");
    }
  } else if (inTask) {
    // The Host's own bookkeeping under the task folder (its SDK sessions,
    // ledger, context home and the task record itself) is not task content;
    // the Agent reads the repositories, not the machinery that runs it. Folded
    // case for the same reason as the git control file above: `.PIDOCK-*` and
    // `TASK.JSON` are the same entries on the product's filesystems. Only the
    // task folder has this bookkeeping; a shared original is ordinary content.
    const relative = normalizeScopePath(real).slice(taskDir.length + 1).toLowerCase();
    if (relative === "task.json" || relative.split("/").some((segment) => segment.startsWith(".pidock-"))) {
      return pathRefuse("tool-refused:protected-path", "目标是任务宿主私有状态，任务工具只读取任务内容");
    }
  }
  return { ok: true, absolute: lexical, real };
}

/** File fingerprint used as the approval's payload version for a write. */
function fileFingerprint(path: string): string {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return `not-a-file:${stat.isDirectory() ? "dir" : "other"}`;
    if (stat.size > MAX_WRITE_BYTES) return `too-large:${stat.size}`;
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "absent";
  }
}

function versionOf(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify([1, ...parts])).digest("hex");
}

/**
 * Who performed the last start/stop, as the model and the UI both read it: the
 * explicit human action carries main's own label, the Agent path carries the
 * session it was decided for. `none` means no control was recorded yet.
 */
function serviceControlLabel(lastControl: ServiceRecord["lastControl"]): string {
  if (lastControl === undefined) return "none";
  return lastControl.actor.kind === "human"
    ? `human:${lastControl.actor.label} (${lastControl.action})`
    : `agent:${lastControl.actor.sessionId} (${lastControl.action})`;
}

/** One successful service control as the model reads it: the Host's own actor and tier. */
function serviceActionText(payload: { serviceId: string; action: "start" | "stop"; actor: "agent"; tier: PiPermission }): string {
  return `service ${payload.serviceId} ${payload.action}: ${payload.actor} (permission ${payload.tier})`;
}

/**
 * The Host control sequence's own named refusal, kept readable as
 * `tool-refused:<its code>` so the model can tell a refusal (`unknown-service`,
 * `service-execution-unavailable`, a write-lock loss) from a failed action.
 */
function serviceControlRefusal(error: string): SdkAgentToolOutcome {
  const code = error.split(":")[0]!.trim();
  return refuse(/^[a-z][a-z0-9-]{1,63}$/.test(code) ? `tool-refused:${code}` : "tool-refused:service-control-failed", error);
}

/** The child environment: the Host's own, minus every credential-shaped name. */
function commandEnvironment(): Record<string, string> {
  const env: Record<string, string> = { TERM: "dumb" };
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || isCredentialEnvName(name)) continue;
    env[name] = value;
  }
  return env;
}

function defaultRunCommand(input: { command: string; cwd: string; timeoutMs: number }): Promise<SdkAgentCommandResult> {
  return new Promise((settle) => {
    const child = spawn("/bin/sh", ["-c", input.command], {
      cwd: input.cwd,
      env: commandEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    let done = false;
    const append = (chunk: Buffer) => {
      if (output.length >= MAX_COMMAND_BYTES) return;
      output += chunk.toString("utf8").slice(0, MAX_COMMAND_BYTES - output.length);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);
    const finish = (exitCode: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settle({ exitCode, output, timedOut });
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      append(Buffer.from(`\ncommand-spawn-failed: ${error instanceof Error ? error.message : String(error)}`));
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/**
 * Recognise the tokens of a command that must be confined. The command is
 * split on shell word/operator boundaries, so a path glued to a redirect or a
 * pipe (`echo x>/tmp/y`, `cat</etc/hosts`) yields the path token on its own
 * instead of a single relative-looking token that resolves inside the worktree
 * while the shell writes outside it. Flags and their `--flag=value` payloads
 * are included only through their value, so `--file=/etc/passwd` is still
 * checked.
 *
 * A command whose expansion cannot be decoded (`$`, backticks) is reported as
 * `unresolvable`: the filter must refuse it rather than approximate a path the
 * shell may or may not produce.
 *
 * A token that names a `.git` control entry is kept even though it carries no
 * `/` (`echo x > .git`), because a bare `.git` token is exactly how the
 * worktree's git pointer gets rewritten.
 */
function commandPathTokens(command: string): { tokens: string[]; unresolvable: boolean } {
  if (/[`$]/.test(command)) return { tokens: [], unresolvable: true };
  const tokens = command
    .split(/[\s;|&<>(){}]+/)
    .map((token) => token.replace(/^['"]+|['"];?$/g, ""))
    .filter((token) => token.length > 0)
    .flatMap((token) => {
      const match = /^-[^\s=]*=(.+)$/.exec(token);
      return match ? [match[1]!] : [token];
    })
    .filter((token) =>
      token === ".." ||
      token.startsWith("~/") ||
      token.startsWith("~") ||
      token.includes("/") ||
      hasGitControlSegment(token) ||
      hasGitControlSegment(unquoteShellToken(token)),
    );
  return { tokens, unresolvable: false };
}

function readFileText(path: string, offset: number, limit: number | undefined): string {
  const buffer = readFileSync(path);
  const truncatedBytes = buffer.length > MAX_READ_BYTES;
  const text = buffer.subarray(0, MAX_READ_BYTES).toString("utf8");
  const lines = text.split("\n");
  const from = Math.min(offset - 1, lines.length);
  const selected = lines.slice(from, limit === undefined ? undefined : from + limit);
  const numbered = selected.map((line, index) => `${from + index + 1}\t${line}`).join("\n");
  const notes: string[] = [];
  if (truncatedBytes) notes.push(`[truncated at ${MAX_READ_BYTES} bytes]`);
  if (limit !== undefined && from + selected.length < lines.length) notes.push(`[showing lines ${from + 1}-${from + selected.length} of ${lines.length}]`);
  return notes.length > 0 ? `${numbered}\n${notes.join("\n")}` : numbered;
}

function searchEntries(path: string): string {
  const entries = readdirSync(path, { withFileTypes: true })
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort()
    .slice(0, MAX_LIST_ENTRIES);
  return entries.length > 0 ? entries.join("\n") : "(empty directory)";
}

/**
 * Directories a traversal never descends into: git's own control directories
 * (matched case-insensitively — on APFS/Windows `.GIT` IS `.git`), dependency
 * trees, and the Host's own task bookkeeping (`.pidock-sdk-sessions`,
 * `.pidock-sdk-context-home`, …). The last one matters because confinement on a
 * *target* is per-target: a search rooted at the task folder would otherwise
 * walk the Host's state and return its lines as task content.
 */
function isHiddenSearchDirectory(name: string): boolean {
  const folded = name.toLowerCase();
  return folded === ".git" || folded === "node_modules" || folded.startsWith(".pidock-");
}

function searchFiles(root: string, pattern: RegExp): string {
  const files: string[] = [];
  const walk = (path: string): void => {
    if (files.length >= MAX_SEARCH_FILES) return;
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(path);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      if (isHiddenSearchDirectory(parse(path).base)) return;
      let entries: string[];
      try {
        entries = readdirSync(path).sort();
      } catch {
        return;
      }
      for (const entry of entries) walk(join(path, entry));
      return;
    }
    if (stat.isFile()) {
      // The task record at the top of the searched folder, and any regular
      // `.pidock-*` marker the Host wrote directly (task creation writes
      // `.pidock-creation` holding the task id), are Host state, not task
      // content; the per-target read guard refuses them by name too. This is
      // the file-branch half of the same fold-case prefix rule the directory
      // branch applies, so `fs.search {path:"."}` cannot hand the marker back.
      const base = parse(path).base.toLowerCase();
      if (base.startsWith(".pidock-") || (dirname(path) === root && base === "task.json")) return;
      files.push(path);
    }
  };
  walk(root);
  const matches: string[] = [];
  for (const file of files) {
    if (matches.length >= MAX_SEARCH_MATCHES) break;
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(file);
    } catch {
      continue;
    }
    if (stat.size > MAX_SEARCH_FILE_BYTES) continue;
    let text: string;
    try {
      const buffer = readFileSync(file);
      if (buffer.includes(0)) continue;
      text = buffer.toString("utf8");
    } catch {
      continue;
    }
    const relative = file.slice(root.length + 1) || file;
    for (const [index, line] of text.split("\n").entries()) {
      if (matches.length >= MAX_SEARCH_MATCHES) break;
      pattern.lastIndex = 0;
      if (pattern.test(line)) matches.push(`${relative}:${index + 1}: ${line.slice(0, 400)}`);
    }
  }
  return matches.length > 0 ? matches.join("\n") : "(no matches)";
}

/**
 * The original checkouts a tool must never touch, derived from the worktrees
 * themselves: a linked worktree's `.git` is a file naming
 * `<primary>/.git/worktrees/<name>`, so the primary checkout is the folder that
 * holds that `.git`. The task record does not persist the source checkout, and
 * deriving it from the worktree keeps the refusal evidence-based instead of
 * assumed; anything that does not look like a linked worktree contributes none
 * (the lexical task-folder rule still refuses it).
 */
export function derivedPrimaryCheckouts(worktrees: readonly string[]): string[] {
  const checkouts = new Set<string>();
  for (const worktree of worktrees) {
    let pointer: string;
    try {
      const path = join(worktree, ".git");
      if (!lstatSync(path).isFile()) continue;
      pointer = readFileSync(path, "utf8").trim();
    } catch {
      continue;
    }
    const match = /^gitdir:\s*(.+)$/.exec(pointer);
    if (!match) continue;
    const gitDir = resolve(worktree, match[1]!.trim());
    const worktreesDir = dirname(gitDir);
    const dotGit = dirname(worktreesDir);
    if (worktreesDir.split(/[\\/]/).pop() !== "worktrees" || dotGit.split(/[\\/]/).pop() !== ".git") continue;
    checkouts.add(dirname(dotGit));
  }
  return [...checkouts].sort();
}

/** Parsed, strictly validated arguments of one tool call. */
interface ParsedArguments {
  ok: true;
  values: { path?: string; pattern?: string; content?: string; command?: string; cwd?: string; offset?: number; limit?: number; serviceId?: string };
}
type ArgumentsRefusal = { ok: false; outcome: SdkAgentToolOutcome };

function parseArguments(tool: SdkAgentToolName, args: Record<string, unknown>): ParsedArguments | ArgumentsRefusal {
  const allowed: Record<SdkAgentToolName, readonly string[]> = {
    "fs.read": ["path", "offset", "limit"],
    "fs.search": ["path", "pattern"],
    "fs.write": ["path", "content"],
    "exec.run": ["command", "cwd"],
    "service.status": ["serviceId"],
    "service.logs": ["serviceId", "limit"],
    "service.start": ["serviceId"],
    "service.stop": ["serviceId"],
  };
  const unknown = Object.keys(args).filter((key) => !allowed[tool].includes(key));
  if (unknown.length > 0) return { ok: false, outcome: refuse("tool-refused:invalid-arguments", `未知参数：${unknown.join("、")}`) };
  const string = (key: string, max: number): string | ArgumentsRefusal => {
    const value = args[key];
    if (value === undefined) return { ok: false, outcome: refuse("tool-refused:invalid-arguments", `缺少参数 ${key}`) };
    if (typeof value !== "string" || value.trim().length === 0 || value.length > max || value.includes("\0")) {
      return { ok: false, outcome: refuse("tool-refused:invalid-arguments", `参数 ${key} 必须是非空字符串（≤${max} 字符）`) };
    }
    return value;
  };
  const optionalString = (key: string, max: number): string | undefined | ArgumentsRefusal => {
    const value = args[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || value.trim().length === 0 || value.length > max || value.includes("\0")) {
      return { ok: false, outcome: refuse("tool-refused:invalid-arguments", `参数 ${key} 必须是非空字符串（≤${max} 字符）`) };
    }
    return value;
  };
  const optionalPositive = (key: string): number | undefined | ArgumentsRefusal => {
    const value = args[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
      return { ok: false, outcome: refuse("tool-refused:invalid-arguments", `参数 ${key} 必须是正整数`) };
    }
    return value;
  };
  const values: ParsedArguments["values"] = {};
  if (tool === "fs.read" || tool === "fs.search" || tool === "fs.write") {
    const path = string("path", MAX_PATH_CHARS);
    if (typeof path !== "string") return path;
    values.path = path;
  }
  if (tool === "fs.read") {
    const offset = optionalPositive("offset");
    if (offset !== undefined && typeof offset !== "number") return offset;
    const limit = optionalPositive("limit");
    if (limit !== undefined && typeof limit !== "number") return limit;
    if (offset !== undefined) values.offset = offset;
    if (limit !== undefined) values.limit = limit;
  }
  if (tool === "fs.search") {
    const pattern = optionalString("pattern", MAX_SEARCH_PATTERN_CHARS);
    if (pattern !== undefined && typeof pattern !== "string") return pattern;
    if (pattern !== undefined) values.pattern = pattern;
  }
  if (tool === "fs.write") {
    const content = args["content"];
    if (typeof content !== "string" || content.includes("\0") || Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
      return { ok: false, outcome: refuse("tool-refused:invalid-arguments", `参数 content 必须是字符串且 ≤${MAX_WRITE_BYTES} 字节`) };
    }
    values.content = content;
  }
  if (tool === "exec.run") {
    const command = string("command", MAX_COMMAND_CHARS);
    if (typeof command !== "string") return command;
    const cwd = optionalString("cwd", MAX_PATH_CHARS);
    if (cwd !== undefined && typeof cwd !== "string") return cwd;
    values.command = command;
    if (cwd !== undefined) values.cwd = cwd;
  }
  // [PiDock 04] #7: the service tools name a service id and (for the log tail)
  // a line count — never a program, a path, a port or an environment value.
  // The key allowlist above is what refuses the latter: an extra key is a
  // refusal, not a silently ignored hint.
  if (tool === "service.status" || tool === "service.logs" || tool === "service.start" || tool === "service.stop") {
    const serviceId = string("serviceId", MAX_SERVICE_ID_CHARS);
    if (typeof serviceId !== "string") return serviceId;
    values.serviceId = serviceId;
  }
  if (tool === "service.logs") {
    const limit = optionalPositive("limit");
    if (limit !== undefined && typeof limit !== "number") return limit;
    if (limit !== undefined && limit > MAX_SERVICE_LOG_LIMIT) {
      return { ok: false, outcome: refuse("tool-refused:invalid-arguments", `参数 limit 不能超过 ${MAX_SERVICE_LOG_LIMIT}`) };
    }
    if (limit !== undefined) values.limit = limit;
  }
  return { ok: true, values };
}

export class SdkAgentToolBroker {
  private readonly waits = new Map<string, { sessionId: string; settle: (verdict: SdkAgentApprovalVerdict) => void }>();
  private closed = false;
  private readonly approvalTimeoutMs: number;
  private readonly runCommand: (input: { command: string; cwd: string; timeoutMs: number }) => Promise<SdkAgentCommandResult>;

  constructor(private readonly options: SdkAgentToolBrokerOptions) {
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.runCommand = options.runCommand ?? defaultRunCommand;
  }

  /** One model tool call: never throws, always answers with a tool result. */
  async call(sessionId: string, request: SdkAgentToolRequest): Promise<SdkAgentToolOutcome> {
    try {
      return await this.perform(sessionId, request);
    } catch (error) {
      return refuse("tool-refused:tool-failed", error instanceof Error ? error.message : String(error));
    }
  }

  /** The Host calls this after the user decided one agent-tool confirmation. */
  settleApproval(approvalId: string, verdict: SdkAgentApprovalVerdict): void {
    const wait = this.waits.get(approvalId);
    if (!wait) return;
    this.waits.delete(approvalId);
    wait.settle(verdict);
  }

  /** Cancel/stop: this session's waiting tools stop with named refusals. */
  cancelSession(sessionId: string): void {
    for (const [approvalId, wait] of [...this.waits]) {
      if (wait.sessionId !== sessionId) continue;
      this.waits.delete(approvalId);
      this.settleParked(approvalId, sessionId);
      wait.settle("cancelled");
    }
  }

  /** Host shutdown: no new effect starts and no tool call stays parked. */
  close(): void {
    this.closed = true;
    for (const [approvalId, wait] of [...this.waits]) {
      this.waits.delete(approvalId);
      this.settleParked(approvalId, wait.sessionId);
      wait.settle("closed");
    }
  }

  /**
   * A parked call that is cancelled, closed or timed out must not leave a live
   * confirmation behind: the confirmation is settled through the same channel
   * that minted it, so a later decision by the user cannot reach an effect that
   * has already refused.
   */
  private settleParked(approvalId: string, sessionId: string): void {
    try {
      this.options.channel(sessionId).reject(approvalId);
      this.options.persist(sessionId);
    } catch {
      // The channel is gone or the confirmation was already settled.
    }
  }

  private async perform(sessionId: string, request: SdkAgentToolRequest): Promise<SdkAgentToolOutcome> {
    if (this.closed || this.options.closing()) return refuse("tool-refused:task-host-closing", "任务宿主正在关闭，不接受新的工具执行");
    if (typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(sessionId)) return refuse("tool-refused:unknown-session", "工具请求未命名本任务的会话");
    const tool = typeof request?.tool === "string" ? request.tool : "";
    const spec = sdkAgentToolSpec(tool);
    if (!spec) return refuse("tool-refused:unknown-tool", `工具未接入门禁：${tool}`);
    const args = request.args;
    if (typeof args !== "object" || args === null || Array.isArray(args)) return refuse("tool-refused:invalid-arguments", "参数必须是一个对象");
    if (!this.options.sessionKnown(sessionId)) return refuse("tool-refused:unknown-session", `会话 ${sessionId} 不属于本任务`);
    const parsed = parseArguments(spec.name, args as Record<string, unknown>);
    if (!parsed.ok) return parsed.outcome;
    // The service tools resolve their target against the task's own service
    // runtime, not against a path: they are answered before any path is
    // resolved, so an id can never be read as a filename.
    if (spec.name.startsWith("service.")) {
      return await this.performServiceTool({ sessionId, channel: this.options.channel(sessionId), spec, values: parsed.values });
    }
    const scope = this.options.scope();
    // The default working directory of a command is this task's first worktree:
    // a command line only ever runs inside a worktree of the task it belongs to.
    const base = parsed.values.cwd ?? scope.worktrees[0]?.path ?? scope.taskDir;
    if (spec.name === "exec.run") {
      // The command's own working directory is the one path argument that
      // changes what every relative token means, so it is resolved first.
      const cwdPath = resolveSdkAgentToolPath({ scope, resolveRealPath: this.options.resolveRealPath, requested: base, base: scope.taskDir, mode: "write" });
      if (!cwdPath.ok) return refuse(cwdPath.code, `命令工作目录不可用：${cwdPath.reason}`);
      const scanned = commandPathTokens(parsed.values.command!);
      if (scanned.unresolvable) {
        return refuse("tool-refused:unresolvable-command", "命令包含无法判定的展开（$ 、反引号），已拒绝以防路径越界");
      }
      for (const token of scanned.tokens) {
        if (COMMAND_DEVICE_ALLOWLIST.has(token)) continue;
        // A `.git` control path is refused by name here, before any resolution
        // and before the gate, so a bare `.git` token (no `/`, so it is not
        // path-shaped) cannot rewrite the worktree's git pointer — and neither
        // can a quoting/escaping spelling of it (`.g\it`, `.g"i"t`).
        if (hasGitControlSegment(token) || hasGitControlSegment(unquoteShellToken(token))) {
          return refuse("tool-refused:invalid-target", `命令参数 ${token} 指向 .git 控制文件，任务工具不可写入`);
        }
        if (token.startsWith("~")) return refuse("tool-refused:out-of-scope", `命令参数 ${token} 指向任务外的家目录`);
        const tokenPath = resolveSdkAgentToolPath({ scope, resolveRealPath: this.options.resolveRealPath, requested: token, base: cwdPath.real, mode: "write" });
        if (!tokenPath.ok) return refuse(tokenPath.code, `命令参数 ${token} 越界：${tokenPath.reason}`);
      }
      return await this.runWithGate({
        sessionId, channel: this.options.channel(sessionId), name: spec.name, kind: spec.kind, target: cwdPath.absolute,
        operation: parsed.values.command,
        version: versionOf([spec.name, spec.kind, cwdPath.real, parsed.values.command, base]),
        effect: () => this.executeCommand(parsed.values.command!, cwdPath.real),
      });
    }
    const resolved = resolveSdkAgentToolPath({
      scope, resolveRealPath: this.options.resolveRealPath, requested: parsed.values.path!, base: scope.taskDir, mode: spec.kind === "read" ? "read" : "write",
    });
    if (!resolved.ok) return refuse(resolved.code, resolved.reason);
    if (spec.name === "fs.write") {
      const fingerprint = fileFingerprint(resolved.real);
      if (fingerprint.startsWith("not-a-file") || fingerprint.startsWith("too-large")) {
        return refuse("tool-refused:invalid-target", `目标不是可写文件（${fingerprint}）`);
      }
      return await this.runWithGate({
        sessionId, channel: this.options.channel(sessionId), name: spec.name, kind: spec.kind, target: resolved.absolute,
        version: versionOf([spec.name, spec.kind, resolved.real, fingerprint, createHash("sha256").update(parsed.values.content!).digest("hex")]),
        effect: () => this.executeWrite(resolved.real, parsed.values.content!),
      });
    }
    return await this.runWithGate({
      sessionId, channel: this.options.channel(sessionId), name: spec.name, kind: spec.kind, target: resolved.absolute,
      version: versionOf([spec.name, spec.kind, resolved.real]),
      effect: () => this.executeRead(spec.name, resolved.real, parsed.values),
    });
  }

  /**
   * One Agent service tool ([PiDock 04] #7 box 5), answered from this task's own
   * service runtime:
   *
   * - the model names a `serviceId` and nothing else (the argument allowlist
   *   already refused any other key, so a payload naming a program, a path, a
   *   port or an env value is a refusal), and the id must be one this task has
   *   bound — an unknown or foreign id is refused by name with nothing read,
   *   started or stopped;
   * - a durable owner state the Host cannot confirm is returned as the same
   *   named refusal the UI read answers, so the Agent never sees a bare
   *   `stopped` it cannot trust;
   * - `service.status`/`service.logs` are `read` kind, so the one gate decides
   *   them like any other read (a read-only session may still read them), their
   *   output is bounded, and process liveness is never inferred from dependency
   *   reachability (or the reverse);
   * - `service.start`/`service.stop` are `command` kind and go through the
   *   existing Host service-control sequence (`service-control.ts`), which
   *   mints the Host's own `service-control`-scoped confirmation, verifies it
   *   against the live channel, spends it one-shot and only then reaches the
   *   real process driver. The gate preview here runs first, before any claim or
   *   mint, so a read-only session is refused without touching anything.
   */
  private async performServiceTool(input: {
    sessionId: string;
    channel: SdkAgentToolChannel;
    spec: SdkAgentToolSpec;
    values: ParsedArguments["values"];
  }): Promise<SdkAgentToolOutcome> {
    const serviceId = input.values.serviceId!;
    if (serviceId.length > MAX_SERVICE_ID_CHARS || !SERVICE_ID_PATTERN.test(serviceId)) {
      return refuse("tool-refused:invalid-arguments", `serviceId 不是服务标识（只接受本任务已绑定服务的 id）：${serviceId.slice(0, 64)}`);
    }
    const host = this.options.services?.();
    if (!host) return refuse("tool-refused:service-control-unavailable", "本任务未接入真实服务进程通道，Agent 不能读写服务");
    const record = host.services.get(serviceId);
    if (!record) return refuse("tool-refused:unknown-service", `${serviceId} 不是本任务绑定的服务`);
    const uncertain = host.refusal(serviceId);
    if (uncertain !== null) return refuse("tool-refused:service-execution-uncertain", uncertain);
    const target = `${host.services.taskDir}/services/${serviceId}`;
    if (input.spec.kind === "read") {
      return await this.runWithGate({
        sessionId: input.sessionId, channel: input.channel, name: input.spec.name, kind: input.spec.kind, target,
        version: versionOf([input.spec.name, target, record.templateVersion, record.lifecycle]),
        effect: async () => input.spec.name === "service.logs"
          ? await this.executeServiceLogs(host, serviceId, input.values.limit)
          : await this.executeServiceStatus(host, serviceId),
      });
    }
    if (record.launchSource !== "catalog") {
      return refuse("tool-refused:service-execution-unavailable", `${serviceId} 仅由界面登记，未接入真实进程执行`);
    }
    // `controlBoundService` previews the gate again, because it needs the verdict
    // to choose between the direct (`auto`) and the mint-and-park (`default`)
    // branch; a `read` tier is denied there with the gate's own reason.
    return await this.controlBoundService({
      sessionId: input.sessionId, channel: input.channel, host, serviceId, target,
      action: input.spec.name === "service.start" ? "start" : "stop",
    });
  }

  /**
   * Start/stop one task-bound service through the Host's own gated control
   * sequence (`service-control.ts`), which owns the verification, the one-shot
   * spend and the real process driver.
   *
   * `auto` reaches the sequence directly (the tier allows the control; the
   * sequence holds the task write right around it). Under `default` this method
   * mints the Host's `service-control`-scoped confirmation through the one gate
   * and parks on the user's decision **with nothing awaited in between**, so a
   * decision can never be made in a window where this call is not yet waiting
   * (the same ordering the `exec.run` path uses). Only an approving decision
   * reaches the second call, which re-checks the live tier, the confirmation and
   * the pinned revision immediately before the sequence spends it one-shot and
   * reaches the driver. A rejection, cancellation or expiry returns here with
   * nothing started or stopped.
   */
  private async controlBoundService(input: {
    sessionId: string;
    channel: SdkAgentToolChannel;
    host: SdkAgentServiceHost;
    serviceId: string;
    action: "start" | "stop";
    target: string;
  }): Promise<SdkAgentToolOutcome> {
    const run = (approvalId?: string) => runAgentServiceControl({
      services: input.host.services,
      driver: input.host.driver(),
      channel: input.channel,
      sessionId: input.sessionId,
      serviceId: input.serviceId,
      action: input.action,
      ...(approvalId !== undefined ? { approvalId } : {}),
      write: this.options.write,
      persist: () => this.options.persist(input.sessionId),
      ...(input.host.executions !== undefined ? { executions: input.host.executions } : {}),
    });
    const preview = input.channel.previewGate(input.action === "start" ? "service.start" : "service.stop", input.target);
    if (preview.verdict === "deny") return refuse("tool-refused:gate-denied", preview.reason);
    if (preview.verdict === "allow") {
      const acted = await run();
      return acted.ok ? { outcome: "ok", text: serviceActionText(acted.payload) } : serviceControlRefusal(acted.error);
    }
    // `default`: the tier the confirmation is minted for, checked against the
    // live tier once more right before the action.
    if (input.channel.currentPermission !== "default") {
      return refuse("tool-refused:permission-changed", "会话权限已变更，确认请求只对原请求生效");
    }
    const record = input.host.services.get(input.serviceId);
    if (!record) return refuse("tool-refused:unknown-service", `${input.serviceId} 不是本任务绑定的服务`);
    const gate = input.channel.gate(SERVICE_CONTROL_TOOL, input.target, record.templateVersion, undefined, SERVICE_CONTROL_SCOPE,
      `服务${input.action === "start" ? "启动" : "停止"} ${input.serviceId}`);
    if (gate.verdict !== "ask") return refuse("tool-refused:gate-denied", "确认请求未能创建，执行已拒绝");
    this.options.persist(input.sessionId);
    const verdict = await this.awaitApproval(gate.approvalId, input.sessionId);
    if (verdict !== "approved") {
      return refuse(
        verdict === "rejected" ? "tool-refused:approval-rejected" : verdict === "cancelled" ? "tool-refused:approval-cancelled" : verdict === "expired" ? "tool-refused:approval-expired" : "tool-refused:approval-unavailable",
        `确认请求 ${gate.approvalId} 未获批准（${verdict}），本次调用未执行任何操作`,
      );
    }
    const recheck = this.recheckServiceApproval({ channel: input.channel, approvalId: gate.approvalId, target: input.target, version: record.templateVersion });
    if (!recheck.ok) return refuse(recheck.code, recheck.reason);
    if (this.closed || this.options.closing()) return refuse("tool-refused:task-host-closing", "任务宿主正在关闭，执行已取消");
    const acted = await run(gate.approvalId);
    return acted.ok ? { outcome: "ok", text: serviceActionText(acted.payload) } : serviceControlRefusal(acted.error);
  }

  /**
   * The live-tier/confirmation re-check immediately before the confirmed
   * action: the tier must still be `default`, the confirmation must still be
   * the approved, unspent, `service-control`-scoped one for THIS service
   * folder. It is a pre-flight only: the one-shot spend stays inside the Host
   * control sequence (`consumeApproval`), so a confirmation can never be spent
   * twice and the broker never becomes a second spender.
   */
  private recheckServiceApproval(input: { channel: SdkAgentToolChannel; approvalId: string; target: string; version: string }):
    { ok: true } | { ok: false; code: string; reason: string } {
    if (input.channel.currentPermission !== "default") {
      return { ok: false, code: "tool-refused:permission-changed", reason: "会话权限已变更，确认请求只对原请求生效" };
    }
    const approval = input.channel.snapshot().approvals.find((row) => row.id === input.approvalId);
    if (!approval || approval.status !== "approved" || approval.consumedAt !== undefined) {
      return { ok: false, code: "tool-refused:invalid-approval", reason: "确认请求未批准、已处理或已消费" };
    }
    if (approval.scope !== SERVICE_CONTROL_SCOPE || approval.tool !== SERVICE_CONTROL_TOOL ||
        approval.target !== input.target || approval.permissionAtRequest !== "default") {
      return { ok: false, code: "tool-refused:invalid-approval", reason: "确认请求与本次服务操作不匹配（用途/目标未绑定）" };
    }
    // The confirmation names the revision the service was registered with: a
    // re-registration between the mint and the decision makes it stale instead
    // of authorizing a control the user never saw.
    if (approval.contentVersion !== input.version) {
      return { ok: false, code: "tool-refused:stale-approval", reason: "服务登记版本已变化，确认请求已过期，请重新发起调用" };
    }
    return { ok: true };
  }

  /**
   * The real state of one task-bound service, read at execution time (after the
   * gate). `lifecycle` is process liveness only; dependency reachability is a
   * separate note and is never reported as liveness in either direction.
   */
  private async executeServiceStatus(host: SdkAgentServiceHost, serviceId: string): Promise<SdkAgentToolOutcome> {
    const record = host.services.get(serviceId);
    if (!record) return refuse("tool-refused:unknown-service", `${serviceId} 不是本任务绑定的服务`);
    return {
      outcome: "ok",
      text: [
        `service ${record.serviceId}`,
        `lifecycle: ${record.lifecycle}`,
        `launchSource: ${record.launchSource} (template v${record.templateVersion})`,
        `lastControl: ${serviceControlLabel(record.lastControl)}`,
        ...(record.startedAt !== undefined ? [`startedAt: ${record.startedAt}`] : []),
        ...(record.stoppedAt !== undefined ? [`stoppedAt: ${record.stoppedAt}`] : []),
        ...(record.exitReason !== undefined ? [`exitReason: ${record.exitReason}`] : []),
        record.dependencyNote === undefined
          ? "dependency: not probed (reachability is never reported as process liveness)"
          : `dependency: ${record.dependencyNote} (reachability note only; process liveness stays ${record.lifecycle})`,
      ].join("\n"),
    };
  }

  /**
   * The bounded tail of one task-bound service's log. The lines are the Host's
   * own (already truncated to 2000 characters each and already redacted, so no
   * private value reaches the model), and the answer is bounded again here by
   * the requested line count and a byte budget: there is no log stream and no
   * unbounded read.
   */
  private async executeServiceLogs(host: SdkAgentServiceHost, serviceId: string, limit: number | undefined): Promise<SdkAgentToolOutcome> {
    if (host.services.get(serviceId) === undefined) return refuse("tool-refused:unknown-service", `${serviceId} 不是本任务绑定的服务`);
    const lines = host.services.serviceLog(serviceId, Math.min(limit ?? DEFAULT_SERVICE_LOG_LIMIT, MAX_SERVICE_LOG_LIMIT));
    const selected: { at: string; line: string }[] = [];
    let bytes = 0;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const entry = lines[index]!;
      const size = Buffer.byteLength(entry.line, "utf8") + 2;
      if (bytes + size > MAX_SERVICE_LOG_BYTES) break;
      bytes += size;
      selected.unshift(entry);
    }
    const omitted = lines.length - selected.length;
    return {
      outcome: "ok",
      text: [
        `service ${serviceId} log tail: ${selected.length} line(s)${omitted > 0 ? `, ${omitted} older line(s) omitted by the byte bound` : ""}`,
        ...selected.map((entry) => `${entry.at} ${entry.line}`),
      ].join("\n"),
    };
  }

  /**
   * Gate → (approval) → effect, with the write right held around a mutating
   * tool. Reads never claim it: analysis is not blocked by a writing session.
   *
   * `target` is the requested path as the gate knows it (the task-relative path
   * resolved against the task folder), while `version` binds the real path the
   * effect will use: the existing gate compares lexically against its own task
   * folder, and confinement on the real path has already run before this point.
   */
  private async runWithGate(input: {
    sessionId: string;
    channel: SdkAgentToolChannel;
    name: SdkAgentToolName;
    kind: "read" | "write" | "command";
    target: string;
    /** What the confirmation shows when `target` alone cannot state the real operation (an `exec.run` command). */
    operation?: string;
    version: string;
    effect: () => Promise<SdkAgentToolOutcome>;
  }): Promise<SdkAgentToolOutcome> {
    const mutating = input.kind !== "read";
    // The gate is previewed before the write right is claimed: a tier denial is
    // then reported by the permission gate itself (the same component the turn
    // flow uses), not by the write coordinator, and no claim is taken at all.
    const preview = input.channel.previewGate(input.name, input.target);
    if (preview.verdict === "deny") return refuse("tool-refused:gate-denied", preview.reason);
    let claimId: string | undefined;
    if (mutating) {
      const claim = this.options.write.claimWrite(input.sessionId, input.channel.currentPermission, {
        kind: "agent-tool",
        label: `Agent 工具 ${input.name} ${input.target}`,
      });
      if (!claim.ok) return refuse("tool-refused:write-lock", writeClaimError(claim));
      claimId = claim.claimId;
    }
    try {
      if (preview.verdict === "ask") {
        const tier = input.channel.currentPermission;
        const gate = input.channel.gate(input.name, input.target, input.version, undefined, AGENT_TOOL_SCOPE, input.operation);
        if (gate.verdict !== "ask") return refuse("tool-refused:gate-denied", "确认请求未能创建，执行已拒绝");
        this.options.persist(input.sessionId);
        const verdict = await this.awaitApproval(gate.approvalId, input.sessionId);
        if (verdict !== "approved") {
          return refuse(
            verdict === "rejected" ? "tool-refused:approval-rejected" : verdict === "cancelled" ? "tool-refused:approval-cancelled" : verdict === "expired" ? "tool-refused:approval-expired" : "tool-refused:approval-unavailable",
            `确认请求 ${gate.approvalId} 未获批准（${verdict}），本次调用未执行任何操作`,
          );
        }
        const recheck = this.recheckApproval({ ...input, approvalId: gate.approvalId, tier });
        if (!recheck.ok) return refuse(recheck.code, recheck.reason);
      }
      if (this.closed || this.options.closing()) return refuse("tool-refused:task-host-closing", "任务宿主正在关闭，执行已取消");
      return await input.effect();
    } finally {
      if (claimId !== undefined) this.options.write.releaseWrite(claimId);
    }
  }

  /**
   * Per-request approval re-check, immediately before the effect: the live tier
   * must still be the tier the confirmation was minted for (a permission change
   * only ever affects later requests, and can never retroactively authorize a
   * pending one), the confirmation must still name this tool, this target and
   * this payload version, the real path must still pass the gate, and the
   * one-shot spend must succeed.
   */
  private recheckApproval(input: {
    sessionId: string;
    channel: SdkAgentToolChannel;
    name: SdkAgentToolName;
    target: string;
    version: string;
    approvalId: string;
    tier: PiPermission;
  }): { ok: true } | { ok: false; code: string; reason: string } {
    if (input.tier !== "default") return { ok: false, code: "tool-refused:permission-changed", reason: "确认请求的用户权限已变更，请重新发起调用" };
    if (input.channel.currentPermission !== input.tier) {
      return { ok: false, code: "tool-refused:permission-changed", reason: "会话权限已变更，确认请求只对原请求生效" };
    }
    const approval = input.channel.snapshot().approvals.find((row) => row.id === input.approvalId);
    if (!approval || approval.status !== "approved" || approval.consumedAt !== undefined) {
      return { ok: false, code: "tool-refused:invalid-approval", reason: "确认请求未批准、已处理或已消费" };
    }
    if (approval.scope !== AGENT_TOOL_SCOPE || approval.tool !== input.name || approval.target !== input.target) {
      return { ok: false, code: "tool-refused:invalid-approval", reason: "确认请求与本次工具调用不匹配（用途/动作/目标未绑定）" };
    }
    if (approval.permissionAtRequest !== input.tier || approval.contentVersion !== input.version) {
      return { ok: false, code: "tool-refused:stale-approval", reason: "确认请求的请求权限或内容版本已变化，请重新发起调用" };
    }
    if (input.channel.previewGate(input.name, input.target).verdict === "deny") {
      return { ok: false, code: "tool-refused:gate-denied", reason: "当前权限已拒绝该目标" };
    }
    if (!input.channel.consumeApproval(input.approvalId)) {
      return { ok: false, code: "tool-refused:invalid-approval", reason: "确认请求已被消费，不能再次执行" };
    }
    this.options.persist(input.sessionId);
    return { ok: true };
  }

  /** Park the tool call on the user's decision; a silent request must not hang. */
  private async awaitApproval(approvalId: string, sessionId: string): Promise<SdkAgentApprovalVerdict> {
    return await new Promise<SdkAgentApprovalVerdict>((settle) => {
      const timer = setTimeout(() => {
        if (!this.waits.has(approvalId)) return;
        this.waits.delete(approvalId);
        this.settleParked(approvalId, sessionId);
        settle("expired");
      }, this.approvalTimeoutMs);
      const finish = (verdict: SdkAgentApprovalVerdict) => {
        clearTimeout(timer);
        settle(verdict);
      };
      this.waits.set(approvalId, { sessionId, settle: finish });
      if (this.closed) {
        this.waits.delete(approvalId);
        finish("closed");
      }
    });
  }

  private async executeRead(
    tool: SdkAgentToolName,
    path: string,
    values: { pattern?: string; offset?: number; limit?: number },
  ): Promise<SdkAgentToolOutcome> {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(path);
    } catch {
      return refuse("tool-refused:not-found", `目标不存在：${path}`);
    }
    if (tool === "fs.search") {
      if (values.pattern === undefined) {
        if (!stat.isDirectory()) return refuse("tool-refused:invalid-target", "读取目录列表需要目录路径；搜索文件请提供 pattern");
        return { outcome: "ok", text: searchEntries(path) };
      }
      let pattern: RegExp;
      try {
        pattern = new RegExp(values.pattern);
      } catch {
        return refuse("tool-refused:invalid-arguments", "pattern 不是合法正则表达式");
      }
      return { outcome: "ok", text: searchFiles(path, pattern) };
    }
    if (!stat.isFile()) return refuse("tool-refused:invalid-target", "fs.read 只读取普通文件");
    if (stat.size > MAX_READ_BYTES * 8) return refuse("tool-refused:too-large", `文件过大（${stat.size} 字节），请用 fs.search 定位后再读取`);
    return { outcome: "ok", text: readFileText(path, values.offset ?? 1, values.limit) };
  }

  private async executeWrite(path: string, content: string): Promise<SdkAgentToolOutcome> {
    // The write target was resolved and confined before the gate; the parent
    // directory is created inside that same confined path. The path is resolved
    // once more immediately before the effect, so a symlink swapped in after the
    // confirmation cannot redirect this write outside the task.
    const again = resolveLinkChain(path, this.options.resolveRealPath);
    if (normalizeScopePath(again) !== normalizeScopePath(path)) {
      return refuse("tool-refused:invalid-target", "目标路径在确认之后发生变化，本次写入已取消");
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { encoding: "utf8", mode: 0o644 });
    const bytes = Buffer.byteLength(content, "utf8");
    return { outcome: "ok", text: `Successfully wrote ${bytes} bytes to ${path}` };
  }

  private async executeCommand(command: string, cwd: string): Promise<SdkAgentToolOutcome> {
    const result = await this.runCommand({ command, cwd, timeoutMs: COMMAND_TIMEOUT_MS });
    const exit = result.timedOut ? "timed out" : `exit ${result.exitCode ?? "unknown"}`;
    const output = result.output.trim();
    return {
      outcome: "ok",
      text: [`$ ${command}`, `(${exit} in ${cwd})`, output.length > 0 ? output : "(no output)"].join("\n"),
    };
  }
}
