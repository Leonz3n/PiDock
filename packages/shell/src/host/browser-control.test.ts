import { beforeEach, describe, expect, it } from "vitest";
import { PiSessionChannel, resetPiSequencesForTests } from "../main/pi-session.js";
import { memoryTaskStore } from "./task-host.js";
import { runAgentBrowserAction, runHumanBrowserAction, type BrowserGatewayPort } from "./browser-control.js";
import { TaskWriteCoordinator } from "./write-coordination.js";

// Seam: [PiDock 06] (#8) Host browser sequence — the exact order `host.ts`
// runs, driven here without a utilityProcess or a real page. The gateway
// stands in for main's visible-page capability: it records what the Host
// asked for and never runs CDP itself.

const DIR = "/Users/name/Tasks/task-a1f92c3d";
const TASK_ID = "task-a1f92c3d";
const PAGE = { taskId: TASK_ID, pageId: "page-1", webContentsId: 11 };

beforeEach(() => {
  resetPiSequencesForTests();
});

function setup(permission: "read" | "default" | "auto" = "default") {
  const store = memoryTaskStore();
  const channel = new PiSessionChannel({
    taskId: TASK_ID,
    sessionId: "main",
    taskDir: DIR,
    providerId: "provider-local",
    model: "pidock-default",
    permission,
  });
  const calls: { action: string; page: unknown; params: Record<string, unknown>; actor: unknown }[] = [];
  let nextResult: Awaited<ReturnType<BrowserGatewayPort["perform"]>> = {
    ok: true,
    payload: { state: { url: "http://localhost:5173/checkout" } },
  };
  const gateway: BrowserGatewayPort = {
    taskId: TASK_ID,
    perform: async (request) => {
      calls.push({ action: request.action, page: request.page, params: request.params, actor: request.actor });
      return nextResult;
    },
  };
  const persisted = () => store.sessions.get(`${DIR}::main`);
  // [PiDock 09] (#11): the page change claims the task write right; the tests
  // drive the real coordinator so a held right refuses an `auto` action.
  const write = new TaskWriteCoordinator();
  const control = (input: { action?: Parameters<typeof runAgentBrowserAction>[0]["action"]; page?: unknown; approvalId?: unknown; params?: Record<string, unknown> } = {}) =>
    runAgentBrowserAction({
      gateway,
      channel,
      sessionId: "main",
      taskId: TASK_ID,
      action: input.action ?? "page/navigate",
      ...(input.page !== undefined ? { page: input.page } : { page: PAGE }),
      ...(input.params !== undefined ? { params: input.params } : {}),
      ...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
      taskDir: DIR,
      write,
      persist: () => store.writeSession(DIR, channel.snapshot()),
    });
  const human = (input: { action: Parameters<typeof runHumanBrowserAction>[0]["action"]; page?: unknown; params?: Record<string, unknown> }) =>
    runHumanBrowserAction({
      gateway,
      action: input.action,
      ...(input.page !== undefined ? { page: input.page } : { page: PAGE }),
      ...(input.params !== undefined ? { params: input.params } : {}),
      label: "用户显式操作",
      taskId: TASK_ID,
      channel,
      persist: () => store.writeSession(DIR, channel.snapshot()),
    });
  return {
    channel,
    gateway,
    calls,
    control,
    human,
    persisted,
    write,
    setResult: (result: Awaited<ReturnType<BrowserGatewayPort["perform"]>>) => {
      nextResult = result;
    },
  };
}

describe("agent browser action dispatch", () => {
  it("mints one scope-bound approval for a default-tier action, then acts once and refuses the replay", async () => {
    const { channel, calls, control, persisted } = setup("default");
    const first = await control();
    expect(first).toEqual({ ok: false, error: "approval-required: approval-1" });
    expect(calls).toHaveLength(0);
    expect(persisted()?.approvals.find((item) => item.id === "approval-1")).toMatchObject({
      tool: "browser.navigate",
      target: `${DIR}/browser/page-1`,
      permissionAtRequest: "default",
      scope: "browser-control",
      status: "pending",
    });
    // A pending request authorizes no page operation.
    expect((await control({ approvalId: "approval-1" })).ok).toBe(false);
    expect(calls).toHaveLength(0);

    channel.approve("approval-1");
    const acted = await control({ approvalId: "approval-1", params: { url: "http://localhost:5173/checkout" } });
    expect(acted.ok).toBe(true);
    expect(acted).toMatchObject({ payload: { action: "page/navigate", actor: "agent", tier: "default", pageId: "page-1" } });
    expect(calls).toEqual([
      {
        action: "page/navigate",
        page: PAGE,
        params: { url: "http://localhost:5173/checkout" },
        actor: { kind: "agent", sessionId: "main" },
      },
    ]);
    // The action is visible in the session the user reads, and the spend is
    // written back so replaying the id cannot touch the page again.
    expect(persisted()?.messages.at(-1)).toMatchObject({ role: "agent", origin: "agent", text: expect.stringContaining("page/navigate") });
    expect(persisted()?.approvals.find((item) => item.id === "approval-1")?.consumedAt).toBeDefined();
    const replay = await control({ action: "page/reload", approvalId: "approval-1" });
    expect(replay.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("never spends a turn approval minted for the same tool + target", async () => {
    const { channel, calls, control } = setup("default");
    const turn = channel.gate("browser.navigate", `${DIR}/browser/page-1`, "v1");
    if (turn.verdict !== "ask") throw new Error("expected an approval request");
    expect(channel.snapshot().approvals[0].scope).toBeUndefined();
    channel.approve(turn.approvalId);
    const denied = await control({ approvalId: turn.approvalId });
    expect(denied.ok).toBe(false);
    expect(denied).toMatchObject({ error: expect.stringContaining("用途未绑定") });
    expect(calls).toHaveLength(0);
    expect(channel.snapshot().approvals[0].consumedAt).toBeUndefined();
  });

  it("binds the approval to the page: a confirmation for page-1 cannot act on page-2", async () => {
    const { channel, calls, control } = setup("default");
    const first = await control({ page: PAGE });
    expect(first).toMatchObject({ error: "approval-required: approval-1" });
    channel.approve("approval-1");
    const other = await control({ page: { taskId: TASK_ID, pageId: "page-2", webContentsId: 12 }, approvalId: "approval-1" });
    expect(other.ok).toBe(false);
    expect(other).toMatchObject({ error: expect.stringContaining("页面未绑定") });
    expect(calls).toHaveLength(0);
  });

  it("denies read-only sessions and never mints", async () => {
    const { channel, calls, control } = setup("read");
    const denied = await control();
    expect(denied).toMatchObject({ error: expect.stringContaining("只读") });
    expect(channel.snapshot().approvals).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("allows auto tier without an approval but still requires a bound handle", async () => {
    const { channel, calls, control } = setup("auto");
    expect(await control()).toMatchObject({ ok: true, payload: { actor: "agent", tier: "auto" } });
    expect(channel.snapshot().approvals).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  // [PiDock 09] (#11) box 3: the auto tier follows the task write right too,
  // and the refusal happens before the page is touched.
  it("refuses an auto-tier page change while another session holds the write right", async () => {
    const { calls, control, write } = setup("auto");
    const held = write.claimWrite("other", "auto", { kind: "turn", label: "回合工具 fs.write" });
    expect(held.ok).toBe(true);
    const denied = await control();
    expect(denied).toMatchObject({ ok: false, error: expect.stringContaining("task-locked: 同一任务写操作权由会话 other 持有") });
    expect(calls).toHaveLength(0);
    // The right is released only by that session; then the same action runs
    // and the claim ends with it (a page change holds the right, not forever).
    write.releaseWrite((held as { claimId: string }).claimId);
    expect((await control()).ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(write.owner).toBeNull();
  });

  it("does not mint a default-tier browser confirmation while another session holds the write right", async () => {
    const { calls, control, channel, write } = setup("default");
    write.claimWrite("other", "auto", { kind: "turn", label: "回合工具 fs.write" });
    const denied = await control();
    expect(denied).toMatchObject({ ok: false, error: expect.stringContaining("task-locked") });
    expect(channel.snapshot().approvals).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("keeps user-only actions off the agent path", async () => {
    const { calls, control } = setup("auto");
    for (const action of ["marker/create", "takeover/pause", "takeover/resume"] as const) {
      const denied = await control({ action });
      expect(denied).toMatchObject({ error: expect.stringContaining("只能由用户显式操作") });
    }
    expect(calls).toHaveLength(0);
  });

  it("fails closed when the gateway is bound to another task", async () => {
    const { channel, gateway, calls } = setup("auto");
    const denied = await runAgentBrowserAction({
      gateway: { ...gateway, taskId: "task-ffffffff" },
      channel,
      sessionId: "main",
      taskId: TASK_ID,
      action: "page/state",
      page: PAGE,
      taskDir: DIR,
      persist: () => {},
    });
    expect(denied).toMatchObject({ error: expect.stringContaining("page-foreign-task") });
    expect(calls).toHaveLength(0);
  });

  it("surfaces the gateway's refusal (page/allowlist/takeover) without logging a success", async () => {
    const { channel, calls, control, setResult } = setup("auto");
    setResult({ ok: false, error: "navigation-denied: http://example.org 不在任务运行配置的地址内" });
    const denied = await control();
    expect(denied.ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(channel.snapshot().messages).toHaveLength(0);
  });
});

describe("human browser surface", () => {
  it("sends a user marker into the session with its structured payload", async () => {
    const { human, calls, persisted, setResult } = setup("read");
    const marker = {
      kind: "browser-marker",
      taskId: TASK_ID,
      pageId: "page-1",
      url: "http://localhost:5173/checkout",
      mode: "box",
      annotation: "总额与对账单不一致",
      epoch: 2,
    };
    setResult({ ok: true, payload: { marker } });
    const result = await human({ action: "marker/create", params: { marker } });
    expect(result.ok).toBe(true);
    expect(calls[0]?.actor).toEqual({ kind: "human", label: "用户显式操作" });
    const message = persisted()?.messages.at(-1);
    expect(message).toMatchObject({ role: "user", origin: "human" });
    expect(message?.references?.[0]).toEqual(marker);
  });

  it("drives takeover pause/resume through the same gateway", async () => {
    const { human, calls } = setup("default");
    expect((await human({ action: "takeover/pause", params: { reason: "人工接管" } })).ok).toBe(true);
    expect((await human({ action: "takeover/resume" })).ok).toBe(true);
    expect(calls.map((call) => call.action)).toEqual(["takeover/pause", "takeover/resume"]);
  });

  it("refuses a gateway bound to another task", async () => {
    const { channel, gateway } = setup("default");
    const denied = await runHumanBrowserAction({
      gateway: { ...gateway, taskId: "task-ffffffff" },
      action: "page/state",
      page: PAGE,
      label: "用户显式操作",
      taskId: TASK_ID,
      channel,
      persist: () => {},
    });
    expect(denied).toMatchObject({ error: expect.stringContaining("page-foreign-task") });
  });
});
