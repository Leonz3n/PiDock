import { describe, expect, it, vi } from "vitest";
import {
  TERMINAL_HISTORY_LIMIT,
  planTerminalForRoot,
  readTerminalHistory,
  readTerminalRoots,
  readTerminalState,
  terminalExitScopeNote,
  terminalInstanceStateText,
  terminalRefusalText,
} from "../data/terminalSurface";
import type { TerminalInstanceView } from "../data/workspaceFiles";

// [PiDock 10] (#15) unit rules of the human takeover surface: the state text the
// panel shows must be the Host's own facts (an unobserved exit code is not `0`,
// and no exit is read as a whole-tree drain), and a refusal is the Host's reason
// verbatim. The rule layer stays Host-side; these are the view rules.

const ATTRIBUTION = {
  taskId: "task-abcdef12",
  rootId: "shipment",
  rootKind: "worktree" as const,
  rootLabel: "shipment",
  piWorkDir: "/w/task-abcdef12",
};

function instance(overrides: Partial<TerminalInstanceView> = {}): TerminalInstanceView {
  return {
    instanceId: "term-1",
    rootId: "shipment",
    attribution: ATTRIBUTION,
    program: "bash",
    args: ["-l"],
    cwd: "/w/task-abcdef12/shipment",
    owner: { taskId: "task-abcdef12", sessionId: null, label: "用户显式操作" },
    cols: 80,
    rows: 24,
    envKeys: ["PATH"],
    lifecycle: "running",
    processKnown: true,
    processId: 4321,
    startedAt: "2026-10-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("#15 terminal state text", () => {
  it("names the recorded process only when the Host recorded one", () => {
    expect(terminalInstanceStateText(instance())).toBe("运行中 · pid 4321");
    expect(terminalInstanceStateText(instance({ processKnown: false, processId: undefined }))).toBe("运行中 · Host 未报告进程号");
  });

  it("shows an unobserved exit code as 未观测 instead of fabricating 0", () => {
    // A signalled child, or a stop that finished before any exit event: the pty
    // reported no code, so `0` would be invented.
    const text = terminalInstanceStateText(instance({ lifecycle: "exited", exitReason: "exited", exitCode: undefined }));
    expect(text).toContain("退出码未观测");
    expect(text).not.toContain("退出码 0");
    expect(text).toContain("自然退出");
    // A code the Host really observed is shown as it is.
    expect(terminalInstanceStateText(instance({ lifecycle: "exited", exitReason: "user-request", exitCode: 0 }))).toContain("退出码 0");
    expect(terminalInstanceStateText(instance({ lifecycle: "exited", exitReason: "user-request" }))).toContain("用户请求停止");
  });

  it("never reads an exit as a proven whole-tree drain", () => {
    // `root-exited` is the same verified drain as `tree-drained` without the
    // containment claim, and an `unknown` receipt leaves the instance running -
    // the panel says what the Host proved, and no more.
    expect(terminalExitScopeNote(instance({ lifecycle: "exited", exitReason: "exited" }))).toContain("不主张整棵进程树");
    expect(terminalExitScopeNote(instance())).toBeUndefined();
  });

  it("keeps a refusal in the Host's own words", () => {
    expect(terminalRefusalText("terminal-termination-unconfirmed: 终端 term-1 及其子进程未被证实结束", "终端停止失败")).toBe(
      "terminal-termination-unconfirmed: 终端 term-1 及其子进程未被证实结束",
    );
    expect(terminalRefusalText(undefined, "终端停止失败")).toBe("终端停止失败");
    expect(terminalRefusalText("   ", "终端停止失败")).toBe("终端停止失败");
  });
});

describe("#15 terminal surface reads", () => {
  it("asks for the bounded history and parses the Host's answer", async () => {
    const taskOp = vi.fn(async () => ({ ok: true, payload: { history: [{ at: "t1", line: "bash-5.2$" }] } }));
    vi.stubGlobal("window", { pidock: { taskOp } });
    try {
      const history = await readTerminalHistory({ taskId: "task-abcdef12", instanceId: "term-1" });
      expect(history).toEqual({ ok: true, value: [{ at: "t1", line: "bash-5.2$" }] });
      expect(taskOp).toHaveBeenCalledWith("task-abcdef12", "task/terminalHistory", {
        instanceId: "term-1",
        limit: TERMINAL_HISTORY_LIMIT,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("drops a history answer that is not the documented shape and keeps the Host's refusal verbatim", async () => {
    const taskOp = vi.fn(async (_taskId: string, _op: string, payload: Record<string, unknown>) =>
      payload["instanceId"] === "broken"
        ? { ok: true, payload: { history: [{ line: "no timestamp" }] } }
        : { ok: false, error: "unknown-instance: 本任务没有终端实例 gone" },
    );
    vi.stubGlobal("window", { pidock: { taskOp } });
    try {
      expect(await readTerminalHistory({ taskId: "task-abcdef12", instanceId: "broken" })).toEqual({
        ok: false,
        error: "Host 终端历史响应无法解析",
      });
      expect(await readTerminalHistory({ taskId: "task-abcdef12", instanceId: "gone" })).toEqual({
        ok: false,
        error: "unknown-instance: 本任务没有终端实例 gone",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports the Host's spawn gate and the real roots, and refuses honestly when there is none", async () => {
    const taskOp = vi.fn(async (_taskId: string, op: string) => {
      if (op === "task/terminalState") return { ok: true, payload: { spawnImplemented: false, instances: [] } };
      if (op === "task/fileRoots") return { ok: true, payload: { taskDir: "/w/task-abcdef12", roots: [] } };
      return { ok: true, payload: {} };
    });
    vi.stubGlobal("window", { pidock: { taskOp } });
    try {
      expect(await readTerminalState("task-abcdef12")).toEqual({ ok: true, value: { spawnImplemented: false, instances: [] } });
      // An empty root list is the Host's own answer: the terminal cannot pick a cwd.
      expect(await readTerminalRoots("task-abcdef12")).toEqual({
        ok: false,
        error: "本任务没有可用的文件根，终端无法确定工作目录",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("plans a root without naming a session (the plan is the human action's own preview)", async () => {
    const taskOp = vi.fn(async () => ({
      ok: true,
      payload: {
        plan: {
          instanceId: "term-1",
          rootId: "shipment",
          attribution: ATTRIBUTION,
          program: "bash",
          args: ["-l"],
          cwd: "/w/task-abcdef12/shipment",
          cols: 80,
          rows: 24,
          resolved: [{ key: "PATH", value: "/usr/bin", secret: false, source: "仓库默认配置" }],
          historyLimit: 200,
          owner: { taskId: "task-abcdef12", sessionId: null, label: "用户显式操作" },
        },
      },
    }));
    vi.stubGlobal("window", { pidock: { taskOp } });
    try {
      const planned = await planTerminalForRoot({
        taskId: "task-abcdef12",
        instanceId: "term-1",
        rootId: "shipment",
        program: "bash",
        args: ["-l"],
      });
      expect(planned.ok).toBe(true);
      expect(taskOp).toHaveBeenCalledWith(
        "task-abcdef12",
        "task/planTerminal",
        expect.objectContaining({ instanceId: "term-1", rootId: "shipment", program: "bash", args: ["-l"] }),
      );
      const payload = taskOp.mock.calls.at(-1)![2] as Record<string, unknown>;
      expect(payload).not.toHaveProperty("sessionId");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
