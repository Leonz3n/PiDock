import { act, render, screen, waitFor, within } from "@testing-library/react";
import { flushSync } from "react-dom";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "./helpers";
import { TerminalTakeoverPanel } from "../components/ToolPanels";
import { TERMINAL_HISTORY_POLL_MS } from "../data/terminalSurface";

/**
 * Flow: [PiDock 10] (#15) the terminal panel against the real Host channel.
 *
 * The panel is used in both modes: without a shell it keeps the in-memory echo
 * (covered beside the other terminal flows), and with `window.pidock` present it
 * must send labelled human start/stop/input/resize, render the Host's bounded
 * history instead of a local echo, and show the Host's own state - an exit code
 * nobody observed as 未观测, never `0`, and never as a whole-tree drain.
 */

type BridgedWindow = { pidock?: { taskOp: ReturnType<typeof vi.fn> } };

/**
 * Expose the preload bridge on the real jsdom window, exactly as the browser
 * panel flows do: the renderer only reads `window.pidock`, so a plain property
 * is what the shell provides.
 */
function stubShell(taskOp: ReturnType<typeof vi.fn>) {
  (window as unknown as BridgedWindow).pidock = { taskOp };
}

afterEach(() => {
  delete (window as unknown as BridgedWindow).pidock;
  vi.useRealTimers();
});

const ATTRIBUTION = {
  taskId: "release",
  rootId: "front-monorepo",
  rootKind: "worktree" as const,
  rootLabel: "front-monorepo",
  piWorkDir: "/w/tasks/release",
};

const ROOTS = {
  taskDir: "/w/tasks/release",
  roots: [
    { id: "front-monorepo", kind: "worktree", label: "front-monorepo", path: "/w/tasks/release/front-monorepo", repo: "front-monorepo" },
  ],
};

/** One instance exactly as `task/terminalState` reports it (the parser is strict). */
function hostInstance(overrides: Record<string, unknown> = {}) {
  return {
    instanceId: "term-release-1",
    rootId: "front-monorepo",
    attribution: ATTRIBUTION,
    program: "bash",
    args: ["-l"],
    cwd: "/w/tasks/release/front-monorepo",
    owner: { taskId: "release", sessionId: null, label: "用户显式操作" },
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

const HOST_PLAN = {
  plan: {
    instanceId: "term-release-1",
    rootId: "front-monorepo",
    attribution: ATTRIBUTION,
    program: "bash",
    args: ["-l"],
    cwd: "/w/tasks/release/front-monorepo",
    cols: 80,
    rows: 24,
    resolved: [{ key: "PATH", value: "/usr/bin", secret: false, source: "仓库默认配置" }],
    historyLimit: 200,
    owner: { taskId: "release", sessionId: null, label: "用户显式操作" },
  },
};

/**
 * (#85) The shell profiles main resolved for this machine. The panel names one of
 * these ids (`powershell` by default) and never a shell of its own, so every stub
 * that drives the panel needs this answer.
 */
const HOST_PROFILES = {
  platform: "win32",
  profiles: [
    { id: "powershell", label: "PowerShell", source: "PowerShell", program: "C:/Program Files/PowerShell/7/pwsh.exe", args: [] },
    { id: "git-bash", label: "Git Bash", source: "Git Bash", program: "C:/Program Files/Git/bin/bash.exe", args: ["--login", "-i"] },
  ],
  defaultProfileId: "powershell",
  unavailable: [{ id: "wsl", label: "WSL", missing: ["C:/Windows/System32/wsl.exe"] }],
};

type Call = { taskId: string; op: string; payload: Record<string, unknown> };

/**
 * Drain the microtask turns a panel read needs. Used with fake timers, where
 * `waitFor` cannot advance the clock itself.
 */
async function flush(turns = 10) {
  await act(async () => {
    for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
  });
}

/** Answer one op the way the Host does; every call is recorded for assertions. */
function hostStub(
  calls: Call[],
  handlers: Partial<Record<string, (payload: Record<string, unknown>) => unknown>>,
) {
  return vi.fn(async (taskId: string, op: string, payload: Record<string, unknown> = {}) => {
    calls.push({ taskId, op, payload });
    // (#85) The profile read is what lets the panel offer a start at all; a test
    // that does not script it still needs this machine's own answer.
    if (op === "task/terminalProfiles" && handlers[op] === undefined) return { ok: true, payload: HOST_PROFILES };
    const handler = handlers[op];
    return handler ? handler(payload) : { ok: true, payload: {} };
  });
}

async function openTerminalPanel(taskOp: ReturnType<typeof vi.fn>) {
  const user = userEvent.setup();
  renderApp("/projects/atlas/tasks/release?session=main");
  await screen.findByRole("heading", { name: "发布前检查" });
  // The bridge appears after the page mounted, so the app stays on the demo path
  // while the tool panel speaks to the shell.
  stubShell(taskOp);
  await user.click(screen.getByRole("button", { name: "终端" }));
  return user;
}

describe("#15 terminal panel on the real channel", () => {
  it("sends typed input to the running instance as the bridge's own input action", async () => {
    const calls: Call[] = [];
    const taskOp = hostStub(calls, {
      "task/terminalState": () => ({ ok: true, payload: { spawnImplemented: true, instances: [hostInstance()] } }),
      "task/fileRoots": () => ({ ok: true, payload: ROOTS }),
      "task/terminalHistory": () => ({ ok: true, payload: { history: [{ at: "t1", line: "host-pty-line" }] } }),
    });
    const user = await openTerminalPanel(taskOp);

    const instance = await screen.findByTestId("terminal-instance");
    expect(instance).toHaveTextContent("term-release-1");
    expect(instance).toHaveTextContent("运行中");
    // The output is the Host's history, not the panel's local echo of the seed.
    expect(await within(screen.getByTestId("terminal-output")).findByText("host-pty-line")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-output")).not.toHaveTextContent("命令已加入模拟队列");

    await user.type(screen.getByLabelText("终端输入"), "echo MARK-11");
    await user.click(screen.getByRole("button", { name: "执行" }));

    await waitFor(() => expect(calls.some((call) => call.payload["action"] === "input")).toBe(true));
    const typed = calls.find((call) => call.payload["action"] === "input");
    expect(typed?.taskId).toBe("release");
    expect(typed?.op).toBe("task/terminalControl");
    expect(typed?.payload).toEqual({ instanceId: "term-release-1", action: "input", data: "echo MARK-11\n" });
    // A human takeover action names no session (the Host refuses an Agent session
    // for raw input and attests the labelled origin itself) and no boolean stands
    // in for one.
    expect(typed?.payload["sessionId"]).toBeUndefined();
    expect(Object.keys(typed?.payload ?? {}).sort()).toEqual(["action", "data", "instanceId"]);
    // The draft is cleared and the panel re-read the same instance's history.
    expect(screen.getByLabelText("终端输入")).toHaveValue("");
    await waitFor(() => expect(calls.filter((call) => call.op === "task/terminalHistory").length).toBeGreaterThan(1));
  });

  it("sends a wider window as the bridge's own resize action and re-reads the Host's state", async () => {
    const calls: Call[] = [];
    let cols = 80;
    const taskOp = hostStub(calls, {
      "task/terminalState": () => ({ ok: true, payload: { spawnImplemented: true, instances: [hostInstance({ cols })] } }),
      "task/fileRoots": () => ({ ok: true, payload: ROOTS }),
      "task/terminalHistory": () => ({ ok: true, payload: { history: [] } }),
      "task/terminalControl": (payload) => {
        if (payload["action"] === "resize") cols = Number(payload["cols"]);
        return { ok: true, payload: { instanceId: "term-release-1", action: payload["action"], actor: "human" } };
      },
    });
    const user = await openTerminalPanel(taskOp);

    const instance = await screen.findByTestId("terminal-instance");
    await user.click(within(instance).getByRole("button", { name: /加宽/ }));

    await waitFor(() => expect(calls.some((call) => call.payload["action"] === "resize")).toBe(true));
    const resized = calls.find((call) => call.payload["action"] === "resize");
    expect(resized?.payload).toEqual({ instanceId: "term-release-1", action: "resize", cols: 100, rows: 24 });
    expect(resized?.payload["sessionId"]).toBeUndefined();
    // The window shown is the Host's own record after the change, not the click.
    await waitFor(() => expect(screen.getByTestId("terminal-instance")).toHaveTextContent("100×24"));
  });

  it("plans and starts the real terminal for the task root as a labelled human action", async () => {
    const calls: Call[] = [];
    let started = false;
    const taskOp = hostStub(calls, {
      "task/terminalState": () => ({
        ok: true,
        payload: { spawnImplemented: true, instances: started ? [hostInstance()] : [] },
      }),
      "task/fileRoots": () => ({ ok: true, payload: ROOTS }),
      "task/planTerminal": () => ({ ok: true, payload: HOST_PLAN }),
      "task/terminalControl": (payload) => {
        if (payload["action"] === "start") started = true;
        return { ok: true, payload: { instanceId: "term-release-1", action: payload["action"], actor: "human" } };
      },
      "task/terminalHistory": () => ({ ok: true, payload: { history: [{ at: "t1", line: "bash-5.2$" }] } }),
    });
    const user = await openTerminalPanel(taskOp);

    await user.click(await screen.findByRole("button", { name: "按计划启动终端" }));

    const plan = await screen.findByTestId("terminal-plan");
    // The cwd is the selected task root, and the owner is the explicit human action.
    expect(plan).toHaveTextContent("/w/tasks/release/front-monorepo");
    expect(plan).toHaveTextContent("用户显式操作");
    const start = calls.find((call) => call.payload["action"] === "start");
    expect(start?.op).toBe("task/terminalControl");
    expect(start?.payload).toEqual({
      instanceId: "term-release-1",
      action: "start",
      rootId: "front-monorepo",
      // (#85) The panel names the shell PROFILE main resolved; no shell string
      // and no argv travel from the renderer.
      profileId: "powershell",
      // The Host guard refuses a start without the #7 env layers: a human start
      // resolves them explicitly (empty layers = an explicit empty resolve).
      layers: { repoDefaults: [], shared: [], privateEntries: [], task: [] },
      label: "终端面板（用户显式操作）",
    });
    expect(start?.payload["sessionId"]).toBeUndefined();
    expect(calls.find((call) => call.op === "task/planTerminal")?.payload["sessionId"]).toBeUndefined();
    // The started instance comes back from the Host's own state read.
    expect(await screen.findByTestId("terminal-instance")).toHaveTextContent("运行中");
  });

  it("names a blank env row key and source in the plan instead of an unnamed `=value`", async () => {
    // `terminalPlanFromHost` reads `resolved[].key/value/source` with `str()`
    // (`data/workspaceFiles.ts:589-599`), so all three can be blank; the row used
    // to render `=value （）` — an env entry whose name and origin are both
    // missing. A blank VALUE stays the value the Host sent: it is the variable's
    // content, not a missing name.
    const calls: Call[] = [];
    const taskOp = hostStub(calls, {
      "task/terminalState": () => ({ ok: true, payload: { spawnImplemented: true, instances: [] } }),
      "task/fileRoots": () => ({ ok: true, payload: ROOTS }),
      "task/planTerminal": () => ({
        ok: true,
        payload: {
          plan: {
            ...HOST_PLAN.plan,
            resolved: [
              { key: "", value: "x", secret: false, source: "仓库默认配置" },
              { key: "PATH", value: "/usr/bin", secret: false, source: "" },
              { key: "EMPTY", value: "", secret: false, source: "任务覆盖" },
            ],
          },
        },
      }),
    });
    const user = await openTerminalPanel(taskOp);

    await user.click(await screen.findByRole("button", { name: "按计划启动终端" }));

    const rows = within(await screen.findByTestId("terminal-plan")).getAllByTestId("terminal-plan-env");
    expect(rows[0]?.textContent).toBe("Host 未上报变量名=x （仓库默认配置）");
    expect(rows[1]?.textContent).toBe("PATH=/usr/bin （Host 未上报变量来源）");
    expect(rows[2]?.textContent).toBe("EMPTY= （任务覆盖）");
  });

  it("names an empty root label in the terminal repo choice instead of a blank option", async () => {
    // `workspaceRootsFromHost` keeps a label the Host sent as `""` (`str()`),
    // and this choice renders only while the task has more than one root — the
    // shape that would otherwise offer a nameless option.
    const calls: Call[] = [];
    const taskOp = hostStub(calls, {
      "task/terminalState": () => ({ ok: true, payload: { spawnImplemented: true, instances: [hostInstance()] } }),
      "task/fileRoots": () => ({
        ok: true,
        payload: {
          taskDir: ROOTS.taskDir,
          roots: [
            ROOTS.roots[0]!,
            { id: "blank-root", kind: "worktree", label: "", path: "/w/tasks/release/blank-root", repo: "blank-root" },
          ],
        },
      }),
    });
    await openTerminalPanel(taskOp);

    const choice = await screen.findByLabelText("终端仓库");
    expect(within(choice).getByRole("option", { name: "Host 未上报根名称" })).toBeInTheDocument();
    // The real root beside it still reads as the Host's own name.
    expect(within(choice).getByRole("option", { name: "front-monorepo" })).toBeInTheDocument();
  });

  it("plans the human action with the same label the start carries, so plan and start agree", async () => {
    // The Host labels an unlabelled human caller `用户显式操作` itself
    // (host-guards.ts:166), so a plan sent without a label renders
    // `用户显式操作（用户显式操作）` while the start sends `终端面板（用户显式操作）`.
    const calls: Call[] = [];
    const taskOp = hostStub(calls, {
      "task/terminalState": () => ({ ok: true, payload: { spawnImplemented: true, instances: [] } }),
      "task/fileRoots": () => ({ ok: true, payload: ROOTS }),
      // Mirror the Host: the plan's owner label is the caller's own label.
      "task/planTerminal": (payload) => ({
        ok: true,
        payload: { plan: { ...HOST_PLAN.plan, owner: { taskId: "release", sessionId: null, label: payload["label"] ?? "用户显式操作" } } },
      }),
      "task/terminalControl": (payload) => ({ ok: true, payload: { instanceId: "term-release-1", action: payload["action"], actor: "human" } }),
      "task/terminalHistory": () => ({ ok: true, payload: { history: [] } }),
    });
    const user = await openTerminalPanel(taskOp);

    await user.click(await screen.findByRole("button", { name: "按计划启动终端" }));

    const plan = await screen.findByTestId("terminal-plan");
    const planCall = calls.find((call) => call.op === "task/planTerminal");
    const startCall = calls.find((call) => call.payload["action"] === "start");
    expect(planCall?.payload["label"]).toBe("终端面板（用户显式操作）");
    expect(planCall?.payload["label"]).toBe(startCall?.payload["label"]);
    expect(plan).toHaveTextContent("终端面板（用户显式操作）");
    // Not the doubled `用户显式操作（用户显式操作）`.
    expect(plan).not.toHaveTextContent("用户显式操作（用户显式操作）");
  });

  it("labels who owns the driven instance, so an Agent-owned terminal is driven knowingly", async () => {
    const calls: Call[] = [];
    const taskOp = hostStub(calls, {
      "task/terminalState": () => ({
        ok: true,
        payload: {
          spawnImplemented: true,
          instances: [
            hostInstance({ instanceId: "term-agent-1", owner: { taskId: "release", sessionId: "sess-main", label: "会话 sess-main" } }),
          ],
        },
      }),
      "task/fileRoots": () => ({ ok: true, payload: ROOTS }),
      "task/terminalHistory": () => ({ ok: true, payload: { history: [] } }),
    });
    await openTerminalPanel(taskOp);

    const instance = await screen.findByTestId("terminal-instance");
    expect(instance).toHaveTextContent("终端归属");
    expect(instance).toHaveTextContent("Agent 会话 sess-main");
  });

  it("renders an exit whose code was never observed as 未观测 and never as a whole-tree drain", async () => {
    const calls: Call[] = [];
    const taskOp = hostStub(calls, {
      "task/terminalState": () => ({
        ok: true,
        payload: {
          spawnImplemented: true,
          // A natural exit: the Host proved the root ended, but the receipt is
          // `root-exited` (the exit was not covered by an observation), so no
          // exit code was ever observed.
          instances: [hostInstance({ lifecycle: "exited", processKnown: true, exitReason: "exited", exitedAt: "2026-10-10T00:01:00.000Z" })],
        },
      }),
      "task/fileRoots": () => ({ ok: true, payload: ROOTS }),
      "task/terminalHistory": () => ({ ok: true, payload: { history: [{ at: "t1", line: "logout" }] } }),
    });
    await openTerminalPanel(taskOp);

    const instance = await screen.findByTestId("terminal-instance");
    expect(instance).toHaveTextContent("已退出");
    expect(instance).toHaveTextContent("退出码未观测");
    expect(instance).not.toHaveTextContent("退出码 0");
    // The exit is not read as "the whole tree is confirmed gone".
    const scope = screen.getByTestId("terminal-exit-scope");
    expect(scope).toHaveTextContent("不主张整棵进程树");
    expect(instance).not.toHaveTextContent("已确认整棵");
    // No running process, so no input can be sent and no stop is offered.
    expect(screen.getByRole("button", { name: "执行" })).toBeDisabled();
    expect(within(instance).queryByRole("button", { name: "停止终端" })).toBeNull();
  });

  it("names an empty Host value on the plan and instance rows instead of a blank one", async () => {
    // `str()` keeps `""` for the cwd, the program, the instance id and both
    // owner fields (`workspaceFiles.ts:228`), so none of them may render as a
    // blank span or a `·`-joined segment with nothing behind it.
    const calls: Call[] = [];
    const taskOp = hostStub(calls, {
      "task/terminalState": () => ({
        ok: true,
        payload: {
          spawnImplemented: true,
          instances: [hostInstance({ instanceId: "", cwd: "", lifecycle: "exited", owner: { taskId: "", sessionId: "", label: "" } })],
        },
      }),
      "task/fileRoots": () => ({ ok: true, payload: ROOTS }),
      "task/planTerminal": () => ({
        ok: true,
        payload: { plan: { ...HOST_PLAN.plan, cwd: "", program: "", owner: { taskId: "", sessionId: null, label: "" } } },
      }),
      "task/terminalHistory": () => ({ ok: true, payload: { history: [{ at: "t1", line: "line" }] } }),
    });
    const user = await openTerminalPanel(taskOp);

    await user.click(await screen.findByRole("button", { name: "按计划启动终端" }));
    const plan = await screen.findByTestId("terminal-plan");
    expect(plan).toHaveTextContent("Host 未上报终端工作目录");
    expect(plan).toHaveTextContent("Host 未上报终端程序");
    // A named human caller with no label is named as unrecorded, not `人工 · `.
    expect(plan).toHaveTextContent("人工 · Host 未上报操作者名称");

    const instance = await screen.findByTestId("terminal-instance");
    expect(instance).toHaveTextContent("Host 未上报实例标识");
    // An Agent-owned instance whose session id is empty says so instead of
    // ending the sentence at `Agent 会话 `.
    expect(instance).toHaveTextContent("Agent 会话 Host 未上报会话标识");
  });

  it("names an unrecorded exit reason instead of a bare segment in the state line", async () => {
    // The state line is `已退出 · <reason> · <code>`: an exit reason the Host left
    // empty is not a reason, and `已退出 ·  · 退出码…` claims one was recorded.
    const calls: Call[] = [];
    const taskOp = hostStub(calls, {
      "task/terminalState": () => ({
        ok: true,
        payload: { spawnImplemented: true, instances: [hostInstance({ lifecycle: "exited", exitReason: "" })] },
      }),
      "task/fileRoots": () => ({ ok: true, payload: ROOTS }),
      "task/terminalHistory": () => ({ ok: true, payload: { history: [] } }),
    });
    await openTerminalPanel(taskOp);

    const instance = await screen.findByTestId("terminal-instance");
    expect(instance).toHaveTextContent("退出原因未报告");
    expect(instance).not.toHaveTextContent("已退出 ·  ·");
  });

  it("keeps an instance running when the Host could not prove the end (unknown receipt)", async () => {
    const calls: Call[] = [];
    let stopAttempts = 0;
    const taskOp = hostStub(calls, {
      "task/terminalState": () => ({ ok: true, payload: { spawnImplemented: true, instances: [hostInstance()] } }),
      "task/fileRoots": () => ({ ok: true, payload: ROOTS }),
      "task/terminalHistory": () => ({ ok: true, payload: { history: [] } }),
      "task/terminalControl": (payload) => {
        if (payload["action"] === "stop") stopAttempts += 1;
        // The Host signals nothing it cannot prove: the instance stays running.
        return { ok: false, error: "terminal-termination-unconfirmed: 终端 term-release-1 及其子进程未被证实结束" };
      },
    });
    const user = await openTerminalPanel(taskOp);

    const instance = await screen.findByTestId("terminal-instance");
    await user.click(within(instance).getByRole("button", { name: "停止终端" }));

    await waitFor(() => expect(stopAttempts).toBe(1));
    // The refusal is the Host's own reason, verbatim...
    expect(await screen.findByTestId("terminal-notice")).toHaveTextContent(
      "terminal-termination-unconfirmed: 终端 term-release-1 及其子进程未被证实结束",
    );
    // ...and the terminal is still shown as running, never as stopped.
    expect(screen.getByTestId("terminal-instance")).toHaveTextContent("运行中");
    expect(screen.queryByTestId("terminal-exit-scope")).toBeNull();
  });

  it("shows the Host's refusal verbatim when input reaches a terminal without a live process", async () => {
    const calls: Call[] = [];
    const taskOp = hostStub(calls, {
      // The registry still says running (an `unknown` receipt keeps it addressable)
      // while the Host has no live session behind it.
      "task/terminalState": () => ({ ok: true, payload: { spawnImplemented: true, instances: [hostInstance()] } }),
      "task/fileRoots": () => ({ ok: true, payload: ROOTS }),
      "task/terminalHistory": () => ({ ok: true, payload: { history: [] } }),
      "task/terminalControl": () => ({ ok: false, error: "terminal-not-running: 终端 term-release-1 没有运行中的真实进程" }),
    });
    const user = await openTerminalPanel(taskOp);

    await screen.findByTestId("terminal-instance");
    await user.type(screen.getByLabelText("终端输入"), "ls");
    await user.click(screen.getByRole("button", { name: "执行" }));

    const notice = await screen.findByTestId("terminal-notice");
    expect(notice).toHaveTextContent("terminal-not-running: 终端 term-release-1 没有运行中的真实进程");
    expect(notice.textContent).toBe("terminal-not-running: 终端 term-release-1 没有运行中的真实进程");
  });
});

describe("#15 terminal history freshness", () => {
  it("drops a history answer for a superseded instance instead of overwriting the current output", async () => {
    // Mutation that this test is the guard for: deleting the
    // `if (historyEpoch.current !== request) return;` check in
    // `TerminalTakeoverPanel.readHistory` lets the slow first answer land and
    // this assertion fails ("A-stale" replaces "B-out").
    vi.useFakeTimers();
    const calls: Call[] = [];
    let releaseFirst: ((value: unknown) => void) | undefined;
    const first = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let stateReads = 0;
    const taskOp = hostStub(calls, {
      "task/terminalState": () => {
        stateReads += 1;
        return {
          ok: true,
          payload: {
            spawnImplemented: true,
            instances: [stateReads === 1 ? hostInstance({ instanceId: "inst-a" }) : hostInstance({ instanceId: "inst-b" })],
          },
        };
      },
      "task/fileRoots": () => ({ ok: true, payload: ROOTS }),
      "task/terminalHistory": (payload) => {
        const target = String(payload["instanceId"]);
        if (target === "inst-a" && calls.filter((call) => call.op === "task/terminalHistory").length === 1) return first;
        return { ok: true, payload: { history: [{ at: "t1", line: target === "inst-a" ? "A-tail" : "B-out" }] } };
      },
    });
    stubShell(taskOp);
    render(<TerminalTakeoverPanel taskId="release" />);
    await flush();
    expect(screen.getByTestId("terminal-instance")).toHaveTextContent("inst-a");

    // One poll tick: the same instance is re-read, then the Host reports the
    // newer instance b, which the panel follows.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TERMINAL_HISTORY_POLL_MS);
    });
    await flush();
    expect(screen.getByTestId("terminal-instance")).toHaveTextContent("inst-b");
    expect(screen.getByTestId("terminal-output")).toHaveTextContent("B-out");

    // The slow answer for the superseded instance arrives late: it must be dropped.
    await act(async () => {
      releaseFirst?.({ ok: true, payload: { history: [{ at: "t1", line: "A-stale" }] } });
    });
    await flush();
    expect(screen.getByTestId("terminal-output")).toHaveTextContent("B-out");
    expect(screen.getByTestId("terminal-output")).not.toHaveTextContent("A-stale");
  });

  it("never shows another task's rows when its slow answer arrives after the switch", async () => {
    const calls: Call[] = [];
    let releaseEarlier: ((value: unknown) => void) | undefined;
    const earlier = new Promise((resolve) => {
      releaseEarlier = resolve;
    });
    const taskOp = vi.fn(async (taskId: string, op: string, payload: Record<string, unknown> = {}) => {
      calls.push({ taskId, op, payload });
      if (op === "task/terminalState") {
        if (taskId === "first") return earlier;
        return { ok: true, payload: { spawnImplemented: true, instances: [hostInstance({ instanceId: `term-${taskId}-1` })] } };
      }
      if (op === "task/fileRoots") return { ok: true, payload: ROOTS };
      if (op === "task/terminalHistory") return { ok: true, payload: { history: [{ at: "t1", line: `${taskId}-line` }] } };
      return { ok: true, payload: {} };
    });
    stubShell(taskOp);
    const view = render(<TerminalTakeoverPanel taskId="first" />);
    await flush();
    // The first task's own read is still pending while the panel moves on.
    expect(screen.getByText("正在读取终端状态…")).toBeInTheDocument();

    view.rerender(<TerminalTakeoverPanel taskId="second" />);
    await flush();
    expect(screen.getByTestId("terminal-instance")).toHaveTextContent("term-second-1");
    expect(screen.getByTestId("terminal-output")).toHaveTextContent("second-line");

    // The superseded task's answer must not be shown as the current task's rows.
    await act(async () => {
      releaseEarlier?.({ ok: true, payload: { spawnImplemented: true, instances: [hostInstance({ instanceId: "term-first-1" })] } });
    });
    await flush();
    expect(screen.getByTestId("terminal-instance")).toHaveTextContent("term-second-1");
    expect(screen.queryByText(/term-first-1/)).toBeNull();
    expect(screen.getByTestId("terminal-output")).not.toHaveTextContent("first-line");
  });

  it("paints no stale history for one frame during a task switch (the output row is task-tagged)", async () => {
    // The mount effect clears the history only after the new render commits, so a
    // task switch would otherwise paint the previous task's lines for one frame.
    // `flushSync` commits that render without flushing passive effects - exactly
    // that frame - and the output must already be fenced by its task tag.
    const calls: Call[] = [];
    const taskOp = vi.fn(async (taskId: string, op: string, payload: Record<string, unknown> = {}) => {
      calls.push({ taskId, op, payload });
      if (op === "task/terminalState") return { ok: true, payload: { spawnImplemented: true, instances: [hostInstance()] } };
      if (op === "task/fileRoots") return { ok: true, payload: ROOTS };
      if (op === "task/terminalHistory") return { ok: true, payload: { history: [{ at: "t1", line: `${taskId}-line` }] } };
      return { ok: true, payload: {} };
    });
    stubShell(taskOp);
    let setTask!: (value: string) => void;
    function Wrapper() {
      const [task, setTaskState] = useState("first");
      setTask = setTaskState;
      return <TerminalTakeoverPanel taskId={task} />;
    }
    render(<Wrapper />);
    await flush();
    expect(screen.getByTestId("terminal-output")).toHaveTextContent("first-line");

    act(() => {
      flushSync(() => setTask("second"));
      // Still inside `act`: the new render has committed but its passive
      // effects have not run, so this asserts on the frame in question.
      expect(screen.getByTestId("terminal-output")).not.toHaveTextContent("first-line");
    });
    await flush();
    expect(screen.getByTestId("terminal-output")).toHaveTextContent("second-line");
  });
});

describe("#15 terminal panel without a shell", () => {
  it("keeps the in-memory echo and never claims a process", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    await user.click(screen.getByRole("button", { name: "终端" }));
    expect(await screen.findByTestId("terminal-spawn-residual")).toHaveTextContent("未实现范围");

    await user.type(screen.getByLabelText("终端输入"), "pnpm test");
    await user.click(screen.getByRole("button", { name: "执行" }));
    // Today's behaviour stays: the memory adapter echoes, no Host is asked.
    expect(await screen.findByText("命令已加入模拟队列")).toBeInTheDocument();
    expect(screen.getByText(/这里是内存模拟/)).toBeInTheDocument();
  });
});

describe("#85 terminal shell profiles in the panel", () => {
  it("offers the profiles main resolved, starts the chosen one and names the gap", async () => {
    const calls: Call[] = [];
    const taskOp = hostStub(calls, {
      "task/terminalState": () => ({ ok: true, payload: { spawnImplemented: true, instances: [] } }),
      "task/fileRoots": () => ({ ok: true, payload: ROOTS }),
      "task/planTerminal": () => ({ ok: true, payload: HOST_PLAN }),
      "task/terminalControl": (payload) => ({ ok: true, payload: { instanceId: "term-release-1", action: payload["action"], actor: "human" } }),
      "task/terminalHistory": () => ({ ok: true, payload: { history: [] } }),
    });
    const user = await openTerminalPanel(taskOp);

    // The picker is main's own list, and the platform default is preselected.
    const picker = await screen.findByLabelText("终端 shell 配置");
    expect(picker).toHaveValue("powershell");
    expect(within(picker).getByRole("option", { name: /Git Bash/ })).toBeInTheDocument();
    // A profile this machine cannot run is named with the executable that was
    // probed - never silently replaced by one that happens to exist.
    const gap = screen.getByTestId("terminal-profile-missing");
    expect(gap).toHaveTextContent("WSL");
    expect(gap).toHaveTextContent("C:/Windows/System32/wsl.exe");

    await user.selectOptions(picker, "git-bash");
    await user.click(await screen.findByRole("button", { name: "按计划启动终端" }));

    const start = calls.find((call) => call.payload["action"] === "start");
    expect(start?.payload["profileId"]).toBe("git-bash");
    // The renderer names no shell and no argv: main resolves both.
    expect(start?.payload["program"]).toBeUndefined();
    expect(start?.payload["args"]).toBeUndefined();
    const plan = calls.find((call) => call.op === "task/planTerminal");
    expect(plan?.payload["profileId"]).toBe("git-bash");
  });

  it("refuses to start when main resolved no shell and names every executable it probed", async () => {
    const calls: Call[] = [];
    const taskOp = hostStub(calls, {
      "task/terminalProfiles": () => ({
        ok: true,
        payload: {
          platform: "win32",
          profiles: [],
          defaultProfileId: null,
          unavailable: [{ id: "powershell", label: "PowerShell", missing: ["C:/Program Files/PowerShell/7/pwsh.exe"] }],
        },
      }),
      "task/terminalState": () => ({ ok: true, payload: { spawnImplemented: true, instances: [] } }),
      "task/fileRoots": () => ({ ok: true, payload: ROOTS }),
    });
    const user = await openTerminalPanel(taskOp);

    expect(await screen.findByTestId("terminal-profile-notice")).toHaveTextContent("C:/Program Files/PowerShell/7/pwsh.exe");
    const start = screen.getByRole("button", { name: "按计划启动终端" });
    expect(start).toBeDisabled();
    await user.click(start);
    expect(calls.some((call) => call.payload["action"] === "start")).toBe(false);
    expect(calls.some((call) => call.op === "task/planTerminal")).toBe(false);
  });

  it("shows the Host's own refusal when the profile read fails and offers no start", async () => {
    const calls: Call[] = [];
    const taskOp = hostStub(calls, {
      "task/terminalProfiles": () => ({ ok: false, error: "terminal-profile-unknown: 本机没有终端 shell 配置「cmder」" }),
      "task/terminalState": () => ({ ok: true, payload: { spawnImplemented: true, instances: [] } }),
      "task/fileRoots": () => ({ ok: true, payload: ROOTS }),
    });
    await openTerminalPanel(taskOp);

    expect(await screen.findByTestId("terminal-profile-notice")).toHaveTextContent("terminal-profile-unknown: 本机没有终端 shell 配置「cmder」");
    expect(screen.queryByLabelText("终端 shell 配置")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "按计划启动终端" })).toBeDisabled();
  });
});
