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
  type TerminalOwner,
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
    registry.markProcess("term-1", { processId: 4321, startedAt: "2026-09-22T10:00:01.000Z" });
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
