/**
 * Tests for the [PiDock 10] (#15) S2 terminal rules and registry. Pure: no pty,
 * no child_process, no process.env mutation.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_HISTORY,
  MAX_TERMINAL_INSTANCES,
  MAX_TERMINAL_LINE,
  TaskTerminalRegistry,
  planTerminal,
  resolveShellProfiles,
  resolveTerminalProfile,
  type TerminalOwner,
  type TerminalProfileProbe,
} from "./terminal-config.js";
import { workspaceRoots } from "./workspace-files.js";

const TASK_DIR = "/Users/dev/pidock/tasks/task-aaaaaaaa";
const ROOTS = workspaceRoots({
  taskId: "task-aaaaaaaa",
  taskDir: TASK_DIR,
  repos: ["invoice-service"],
  repoSources: [{ repoDir: "invoice-service", remoteBranch: "main" }],
  dirLinks: [{ linkName: "dir-51cd20bb", directoryId: "dir-51cd20bb", sourcePath: "/Users/dev/work/invoice-docs" }],
});
const OWNER: TerminalOwner = { taskId: "task-aaaaaaaa", sessionId: "main", label: "会话 main" };

function plan(overrides: Partial<Parameters<typeof planTerminal>[0]> = {}) {
  return planTerminal({
    roots: ROOTS,
    taskId: "task-aaaaaaaa",
    taskDir: TASK_DIR,
    rootId: "invoice-service",
    program: "bash",
    args: ["-l"],
    layers: { repoDefaults: [], shared: [], privateEntries: [{ key: "DB_PASSWORD", value: "s3cret", secret: true }], task: [{ key: "PORT", value: "9101", secret: false }] },
    owner: OWNER,
    instanceId: "term-1",
    secrets: ["s3cret"],
    ...overrides,
  });
}

describe("planTerminal", () => {
  it("uses the selected task root as cwd with explicit program + argv", () => {
    const result = plan();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.cwd).toBe(`${TASK_DIR}/invoice-service`);
    expect(result.plan.program).toBe("bash");
    expect(result.plan.args).toEqual(["-l"]);
    expect(result.plan.attribution).toMatchObject({ taskId: "task-aaaaaaaa", rootKind: "worktree", repo: "invoice-service", piWorkDir: TASK_DIR });
  });

  it("resolves env from the #7 layers into a fresh per-terminal object and masks display rows", () => {
    const first = plan();
    const second = plan({ instanceId: "term-2" });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.plan.env).toEqual({ DB_PASSWORD: "s3cret", PORT: "9101" });
    expect(Object.keys(first.plan.env)).toEqual(["DB_PASSWORD", "PORT"]);
    expect(first.plan.env).not.toBe(second.plan.env);
    first.plan.env["MUTATED"] = "1";
    expect(second.plan.env["MUTATED"]).toBeUndefined();
    expect(first.plan.resolved.find((row) => row.key === "DB_PASSWORD")?.value).toBe("••••••••");
    expect(first.plan.resolved.find((row) => row.key === "PORT")?.value).toBe("9101");
  });

  it("accepts a plain-directory link root and keeps its shared attribution", () => {
    const result = plan({ rootId: "dir-51cd20bb" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.cwd).toBe(`${TASK_DIR}/dir-51cd20bb`);
    expect(result.plan.attribution.sharedNote).toContain("修改影响原文件");
  });

  it("refuses an unknown root, another task's folder and escaping relative paths", () => {
    for (const rootId of ["other-task", ""]) {
      const result = plan({ rootId });
      expect(result.ok).toBe(false);
    }
    const escape = plan({ relative: "../../../etc" });
    expect(escape.ok).toBe(false);
    if (escape.ok) return;
    expect(escape.error).toContain("path-out-of-scope");
  });

  it("refuses inline env assignment and shell chaining instead of becoming an un-gated exec path", () => {
    const inline = plan({ program: "FOO=bar" });
    expect(inline.ok).toBe(false);
    const chained = plan({ program: "bash", args: ["-c", "rm -rf / && echo done"] });
    expect(chained.ok).toBe(false);
    if (chained.ok) return;
    expect(chained.error).toContain("shell 连接符");
  });

  it("refuses a broken env layer, an out-of-range window and non-string args", () => {
    const secretShared = plan({ layers: { repoDefaults: [], shared: [{ key: "API_TOKEN", value: "x", secret: false }], privateEntries: [], task: [] } });
    expect(secretShared.ok).toBe(false);
    const hugeWindow = plan({ cols: MAX_TERMINAL_COLS + 1 });
    expect(hugeWindow.ok).toBe(false);
    const badArgs = plan({ args: [1] as unknown as string[] });
    expect(badArgs.ok).toBe(false);
  });

  it("never touches process.env", () => {
    const before = { ...process.env };
    const result = plan();
    expect(result.ok).toBe(true);
    expect({ ...process.env }).toEqual(before);
  });
});

describe("TaskTerminalRegistry", () => {
  function makeRegistry() {
    const registry = new TaskTerminalRegistry("task-aaaaaaaa", () => "2026-09-22T10:00:00.000Z");
    const planned = plan();
    if (!planned.ok) throw new Error("plan failed");
    registry.register(planned.plan);
    registry.markProcess("term-1", { processId: 4321, processGroupId: 4321, startedAt: "2026-09-22T10:00:01.000Z" });
    return registry;
  }

  it("tracks ownership, cwd and the resolved env keys without exposing values", () => {
    const record = makeRegistry().get("term-1")!;
    expect(record.owner).toEqual(OWNER);
    expect(record.cwd).toBe(`${TASK_DIR}/invoice-service`);
    expect(record.envKeys).toEqual(["DB_PASSWORD", "PORT"]);
    expect("env" in record).toBe(false);
    expect(record.lifecycle).toBe("running");
  });

  it("bounds history, masks secrets and bounds a single line", () => {
    const registry = makeRegistry();
    for (let index = 0; index < MAX_TERMINAL_HISTORY + 10; index += 1) registry.appendOutput("term-1", `line ${index}`);
    registry.appendOutput("term-1", "export TOKEN=tok_live_abcdef");
    registry.appendOutput("term-1", "x".repeat(MAX_TERMINAL_LINE + 50));
    const history = registry.history("term-1", MAX_TERMINAL_HISTORY);
    expect(history).toHaveLength(MAX_TERMINAL_HISTORY);
    expect(history.some((entry) => entry.line.includes("tok_live_abcdef"))).toBe(false);
    expect(history[history.length - 1]!.line.length).toBeLessThanOrEqual(MAX_TERMINAL_LINE);
    expect(history[0]!.line).toBe("line 12");
  });

  it("resizes inside the bounds and refuses a size outside them", () => {
    const registry = makeRegistry();
    expect(registry.resize("term-1", { cols: 120, rows: 40 })).toMatchObject({ cols: 120, rows: 40 });
    expect(() => registry.resize("term-1", { cols: 5, rows: 24 })).toThrow(/invalid-terminal/);
  });

  it("shows the real exit state after exit", () => {
    const registry = makeRegistry();
    const exited = registry.markExited("term-1", { exitCode: 0, reason: "exited" });
    expect(exited).toMatchObject({ lifecycle: "exited", exitCode: 0, exitReason: "exited", exitedAt: "2026-09-22T10:00:00.000Z" });
    expect(registry.ownedBySession("main")).toHaveLength(0);
  });

  it("proves a stop scope by instance + process identity, never by port", () => {
    const registry = makeRegistry();
    const scope = registry.stopScope("term-1");
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    expect(scope.scope).toEqual({ taskId: "task-aaaaaaaa", instanceId: "term-1", processId: 4321, startedAt: "2026-09-22T10:00:01.000Z" });
  });

  it("fails closed for an unknown instance and refuses an instance of another task", () => {
    const registry = makeRegistry();
    const unknown = registry.stopScope("term-9");
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error).toContain("unknown-instance");

    const foreign = new TaskTerminalRegistry("task-bbbbbbbb");
    const planned = plan({ rootId: "invoice-service" });
    if (!planned.ok) throw new Error("plan failed");
    expect(() => foreign.register(planned.plan)).toThrow(/task-mismatch/);
  });

  it("refuses to stop before a process identity is known, and bounds the instance count", () => {
    const fresh = new TaskTerminalRegistry("task-aaaaaaaa");
    const planned = plan();
    if (!planned.ok) throw new Error("plan failed");
    fresh.register(planned.plan);
    const noProcess = fresh.stopScope("term-1");
    expect(noProcess.ok).toBe(false);
    if (noProcess.ok) return;
    expect(noProcess.error).toContain("unknown-process");

    for (let index = 1; index < MAX_TERMINAL_INSTANCES; index += 1) {
      const next = plan({ instanceId: `term-${index + 1}` });
      if (!next.ok) throw new Error("plan failed");
      fresh.register(next.plan);
    }
    const overflow = plan({ instanceId: "term-overflow" });
    if (!overflow.ok) throw new Error("plan failed");
    expect(() => fresh.register(overflow.plan)).toThrow(/terminal-limit/);
  });

  it("returns deep copies so a caller cannot corrupt Host state", () => {
    const registry = makeRegistry();
    const first = registry.get("term-1")!;
    first.history.push({ at: "x", line: "injected" });
    first.args.push("--evil");
    expect(registry.get("term-1")!.history).toHaveLength(0);
    expect(registry.get("term-1")!.args).toEqual(["-l"]);
  });
});

/**
 * [PiDock 10] (#85) the platform shell-profile table, in the shape VS Code's
 * own table has (`src/vs/platform/terminal/common/terminalPlatformConfiguration.ts`):
 * win32 opens PowerShell by default and also offers Command Prompt (empty argv),
 * Git Bash (`--login -i`) and WSL; macOS/Linux open the login shell `$SHELL`
 * names. The platform, the environment and the file probe are all injected, so
 * the win32 and darwin rules are decided here on any host - a darwin executable
 * probe is not observable on this machine and is never claimed as verified.
 */
describe("terminal shell profiles (#85)", () => {
  const WIN32_ENV: Record<string, string> = {
    windir: "C:\\Windows",
    SystemRoot: "C:\\Windows",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
  };
  const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const POWERSHELL_5 = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const CMD = "C:\\Windows\\System32\\cmd.exe";
  const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
  const GIT_BASH_X86 = "C:\\Program Files (x86)\\Git\\bin\\bash.exe";
  const GIT_BASH_LOCAL = "C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";
  const WSL = "C:\\Windows\\System32\\wsl.exe";
  const probe = (paths: readonly string[]): TerminalProfileProbe => ({
    exists: (path) => paths.includes(path),
    isExecutable: (path) => paths.includes(path),
  });
  const win32 = (paths: readonly string[] = [PWSH, POWERSHELL_5, CMD, GIT_BASH, WSL], env: Record<string, string> = WIN32_ENV) =>
    resolveShellProfiles({ platform: "win32", env, probe: probe(paths) });
  const posix = (paths: readonly string[], env: Record<string, string> = {}) =>
    resolveShellProfiles({ platform: "darwin", env, probe: probe(paths) });

  it("lists PowerShell, Command Prompt, Git Bash and WSL on win32 and selects PowerShell", () => {
    const resolution = win32();
    expect(resolution.profiles.map((profile) => profile.id)).toEqual(["powershell", "command-prompt", "git-bash", "wsl"]);
    expect(resolution.defaultProfileId).toBe("powershell");
    // PowerShell 7 at its known install location wins over the inbox 5.1.
    expect(resolution.profiles[0]).toMatchObject({ label: "PowerShell", source: "PowerShell", program: PWSH, args: [] });
    expect(resolution.unavailable).toEqual([]);
  });

  it("gives Git Bash `--login -i`, Command Prompt an empty argv and never a -NoProfile", () => {
    const resolution = win32();
    const byId = new Map(resolution.profiles.map((profile) => [profile.id, profile]));
    expect(byId.get("git-bash")).toMatchObject({ program: GIT_BASH, args: ["--login", "-i"] });
    expect(byId.get("command-prompt")).toMatchObject({ program: CMD, args: [] });
    expect(byId.get("wsl")).toMatchObject({ program: WSL, args: [] });
    // Clause 6: the user's profile is never swallowed - no `-NoProfile` anywhere.
    for (const profile of resolution.profiles) {
      expect(profile.args.map((arg) => arg.toLowerCase())).not.toContain("-noprofile");
    }
  });

  it("falls back to the inbox Windows PowerShell when PowerShell 7 is not installed", () => {
    const resolution = win32([POWERSHELL_5, CMD]);
    expect(resolution.profiles[0]).toMatchObject({ id: "powershell", program: POWERSHELL_5 });
    expect(resolution.defaultProfileId).toBe("powershell");
  });

  it("omits a profile this host cannot run and names every executable it probed", () => {
    const resolution = win32([PWSH, POWERSHELL_5, CMD]);
    expect(resolution.profiles.map((profile) => profile.id)).toEqual(["powershell", "command-prompt"]);
    expect(resolution.unavailable).toEqual([
      { id: "git-bash", label: "Git Bash", missing: [GIT_BASH, GIT_BASH_X86, GIT_BASH_LOCAL] },
      { id: "wsl", label: "WSL", missing: [WSL] },
    ]);
  });

  it("selects no default when even PowerShell is missing, and names what was probed", () => {
    const resolution = win32([]);
    expect(resolution.profiles).toEqual([]);
    expect(resolution.defaultProfileId).toBeNull();
    expect(resolution.unavailable[0]).toEqual({
      id: "powershell",
      label: "PowerShell",
      missing: [
        PWSH,
        "C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe",
        "C:\\Windows\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe",
        POWERSHELL_5,
      ],
    });
  });

  it("reads the win32 environment names case-insensitively", () => {
    const resolution = win32(["D:\\Apps\\PowerShell\\7\\pwsh.exe", "D:\\Windows\\System32\\cmd.exe"], {
      WINDIR: "D:\\Windows",
      PROGRAMFILES: "D:\\Apps",
    });
    expect(resolution.profiles[0]).toMatchObject({ id: "powershell", program: "D:\\Apps\\PowerShell\\7\\pwsh.exe" });
    expect(resolution.profiles.find((profile) => profile.id === "command-prompt")?.program).toBe("D:\\Windows\\System32\\cmd.exe");
  });

  it("defaults to the $SHELL login shell on darwin and linux", () => {
    const darwin = posix(["/bin/zsh", "/bin/bash", "/bin/sh"], { SHELL: "/bin/zsh" });
    expect(darwin.defaultProfileId).toBe("zsh");
    // The default is listed first, the way VS Code's list reads (first = default).
    expect(darwin.profiles[0]?.id).toBe("zsh");
    expect(darwin.profiles.map((profile) => profile.id)).toEqual(["zsh", "bash", "sh"]);
    const linux = posix(["/bin/zsh", "/bin/bash", "/bin/sh"], { SHELL: "/bin/bash" });
    expect(linux.defaultProfileId).toBe("bash");
    expect(linux.profiles[0]?.id).toBe("bash");
    // A login shell, so `~/.zprofile`/`~/.bash_profile` really runs and a tool it
    // adds to PATH is visible in the terminal (the reason VS Code gives Git Bash
    // `--login -i`).
    expect(linux.profiles[0]?.args).toEqual(["-l"]);
  });

  it("adds a $SHELL that is outside the table and validates it as an absolute executable", () => {
    // `$SHELL` picks the default even when the table entry lists several paths.
    const resolution = posix(["/bin/zsh", "/opt/homebrew/bin/fish"], { SHELL: "/opt/homebrew/bin/fish" });
    expect(resolution.defaultProfileId).toBe("fish");
    expect(resolution.profiles[0]).toMatchObject({ id: "fish", program: "/opt/homebrew/bin/fish", args: ["-l"] });
    // A login shell this table has never heard of is still the user's own shell:
    // it is added under its own basename, and its `source` is the path itself.
    const custom = posix(["/bin/bash", "/usr/local/bin/mysh"], { SHELL: "/usr/local/bin/mysh" });
    expect(custom.defaultProfileId).toBe("mysh");
    expect(custom.profiles[0]).toMatchObject({ id: "mysh", source: "/usr/local/bin/mysh", program: "/usr/local/bin/mysh", args: ["-l"] });
  });

  it("ignores a $SHELL that is not an existing absolute executable and falls back to /bin/zsh", () => {
    const relative = posix(["/bin/zsh"], { SHELL: "bash" });
    expect(relative.defaultProfileId).toBe("zsh");
    const missing = posix(["/bin/bash"], { SHELL: "/opt/bin/nope" });
    expect(missing.defaultProfileId).toBeNull();
    expect(missing.unavailable[0]).toEqual({ id: "zsh", label: "zsh", missing: ["/bin/zsh"] });
    expect(missing.profiles.map((profile) => profile.id)).toEqual(["bash"]);
  });

  it("refuses an unknown profile id by name instead of substituting another shell", () => {
    const unknown = resolveTerminalProfile(win32(), "cmder");
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error).toContain("terminal-profile-unknown");
    expect(unknown.error).toContain("cmder");
    expect(unknown.error).toContain("powershell");
  });

  it("refuses a known profile this host cannot run, naming the missing executable", () => {
    const missing = resolveTerminalProfile(win32([PWSH, POWERSHELL_5, CMD]), "git-bash");
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error).toContain("terminal-profile-unavailable");
    expect(missing.error).toContain(GIT_BASH);
  });

  it("selects the profile a caller names and returns its own argv", () => {
    const selected = resolveTerminalProfile(win32(), "git-bash");
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.profile).toMatchObject({ id: "git-bash", program: GIT_BASH, args: ["--login", "-i"] });
  });

  it("refuses a caller program that carries whitespace, exactly as #7 does", () => {
    // The caller path is untouched by the profile work: a space in a
    // caller-named program is still the #7 refusal, so a command line can never
    // be smuggled in as a program - not even the one PowerShell is installed at.
    const spaced = plan({ program: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" });
    expect(spaced.ok).toBe(false);
    if (spaced.ok) return;
    expect(spaced.error).toContain("不能包含空格");
  });

  it("accepts a main-resolved profile path that carries whitespace and still demands an absolute path", () => {
    // What main's own table hands over is one absolute file path - the whole
    // string names an existing executable (`host/terminal-profiles.ts` re-probes
    // it), which no command line can - so the caller-string proxy is not applied
    // to it. Everything else about it is still checked.
    const resolved = plan({ program: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", programSource: "profile" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.plan.program).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");

    const relative = plan({ program: "pwsh.exe", programSource: "profile" });
    expect(relative.ok).toBe(false);
    if (relative.ok) return;
    expect(relative.error).toContain("必须是本机绝对路径");
  });

  it("refuses a profile path that carries inline env assignment or shell chaining", () => {
    const inline = plan({ program: "/bin/FOO=bar", programSource: "profile" });
    expect(inline.ok).toBe(false);
    if (inline.ok) return;
    expect(inline.error).toContain("内联环境赋值");
    const chained = plan({ program: "/bin/sh;curl http://evil", programSource: "profile" });
    expect(chained.ok).toBe(false);
    if (chained.ok) return;
    expect(chained.error).toContain("shell 连接符");
  });
});
