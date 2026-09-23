import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserActionNotice,
  browserActionRefusal,
  markBrowserIssue,
  markerPayloadFromSelection,
  readBrowserEvidence,
  readBrowserPageState,
  requestBrowserAction,
  setBrowserTakeover,
} from "../data/browserSurface";

// Seam: [PiDock 06] (#8) renderer browser surface. The page itself is
// owned by main (Chromium/CDP never reachable from here), so these tests
// assert the payloads and notices the renderer builds and the routing it
// uses — plus the local simulation used outside the shell.

const TASK_ID = "task-abcdef12";
const PAGE = { pageId: "page-1", webContentsId: 11 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser marker payload", () => {
  it("carries task, page, URL, annotation, epoch, locator and rect", () => {
    const marker = markerPayloadFromSelection({
      taskId: TASK_ID,
      page: PAGE,
      url: "http://localhost:5173/checkout",
      mode: "box",
      annotation: "  总额与对账单不一致  ",
      epoch: 4,
      locator: { kind: "testId", value: "checkout-total" },
      rect: { x: 10, y: 20, width: 120, height: 24 },
    });
    expect(marker).toEqual({
      page: { taskId: TASK_ID, pageId: "page-1", webContentsId: 11 },
      url: "http://localhost:5173/checkout",
      mode: "box",
      annotation: "总额与对账单不一致",
      epoch: 4,
      locator: { kind: "testId", value: "checkout-total" },
      rect: { x: 10, y: 20, width: 120, height: 24 },
    });
  });

  it("keeps a marker usable when the user left the note empty", () => {
    const marker = markerPayloadFromSelection({
      taskId: TASK_ID,
      page: { pageId: "page-2" },
      url: "http://localhost:5173/detail",
      mode: "point",
      annotation: "   ",
      epoch: 0,
    });
    expect(marker["annotation"]).toBe("需要检查这里");
    expect(marker["page"]).toEqual({ taskId: TASK_ID, pageId: "page-2" });
  });
});

describe("browser action notices", () => {
  it("maps confirmations, takeover and refusals to visible states", () => {
    expect(browserActionNotice("page/state", { ok: true })).toMatchObject({ kind: "info" });
    expect(browserActionNotice("input/click", { ok: false, error: "approval-required: approval-7" })).toEqual({
      kind: "approval",
      text: "浏览器操作需要确认，确认后重试",
      approvalId: "approval-7",
    });
    expect(browserActionNotice("input/click", { ok: false, error: "takeover-paused: 用户正在接管页面" })).toMatchObject({
      kind: "refused",
      text: "用户正在接管页面：Agent 操作已暂停",
    });
    expect(browserActionNotice("page/navigate", { ok: false, error: "navigation-denied: https://example.org" })).toMatchObject({
      kind: "refused",
      text: "navigation-denied: https://example.org",
    });
  });

  it("refuses the page to read-only sessions", () => {
    expect(browserActionRefusal("read")).toContain("只读");
    expect(browserActionRefusal("default")).toBeUndefined();
    expect(browserActionRefusal("auto")).toBeUndefined();
  });
});

describe("browser action routing", () => {
  it("simulates locally outside the shell", async () => {
    vi.stubGlobal("window", {});
    const result = await requestBrowserAction({ taskId: TASK_ID, action: "page/state", page: PAGE });
    expect(result).toMatchObject({ ok: true, simulated: true });
  });

  it("routes the human path through task/browserAction with a bound page", async () => {
    const taskOp = vi.fn(async () => ({ ok: true, payload: {} }));
    vi.stubGlobal("window", { pidock: { taskOp } });
    const result = await requestBrowserAction({
      taskId: TASK_ID,
      action: "takeover/pause",
      page: PAGE,
      params: { reason: "人工登录" },
      label: "用户接管浏览器",
      targetSessionId: "main",
    });
    expect(result.ok).toBe(true);
    expect(taskOp).toHaveBeenCalledWith(TASK_ID, "task/browserAction", {
      action: "takeover/pause",
      page: { taskId: TASK_ID, pageId: "page-1", webContentsId: 11 },
      params: { reason: "人工登录" },
      targetSessionId: "main",
      label: "用户接管浏览器",
    });
  });

  it("keeps agent session/approval ids on the agent path only", async () => {
    const taskOp = vi.fn(async () => ({ ok: true, payload: {} }));
    vi.stubGlobal("window", { pidock: { taskOp } });
    await requestBrowserAction({ taskId: TASK_ID, action: "input/click", page: PAGE, sessionId: "main", approvalId: "approval-2" });
    expect(taskOp).toHaveBeenCalledWith(TASK_ID, "task/browserAction", {
      action: "input/click",
      page: { taskId: TASK_ID, pageId: "page-1", webContentsId: 11 },
      sessionId: "main",
      approvalId: "approval-2",
    });
  });

  it("reads page state before a marker and surfaces a refusal", async () => {
    const taskOp = vi.fn(async () => ({ ok: false, error: "page-stale: 页面 page-1 不存在或已关闭" }));
    vi.stubGlobal("window", { pidock: { taskOp } });
    const state = await readBrowserPageState({ taskId: TASK_ID, page: PAGE });
    expect(state).toMatchObject({ ok: false, epoch: 0, url: "" });
    expect(state.error).toContain("page-stale");
  });

  it("parses state and evidence envelopes", async () => {
    const taskOp = vi.fn(async (_taskId: string, _op: string, payload: Record<string, unknown>) => {
      if (payload["action"] === "page/state") {
        return { ok: true, payload: { state: { epoch: 3, url: "http://localhost:5173/checkout", title: "对账单" } } };
      }
      return {
        ok: true,
        payload: {
          evidence: {
            consoleErrors: [{ text: "TypeError: x is undefined" }],
            failedRequests: [{ url: "http://localhost:5173/api/orders", errorText: "net::ERR_FAILED" }],
          },
        },
      };
    });
    vi.stubGlobal("window", { pidock: { taskOp } });
    const state = await readBrowserPageState({ taskId: TASK_ID, page: PAGE });
    expect(state).toEqual({ ok: true, epoch: 3, url: "http://localhost:5173/checkout", title: "对账单" });
    const evidence = await readBrowserEvidence({ taskId: TASK_ID, page: PAGE });
    expect(evidence.evidence.consoleErrors).toEqual(["TypeError: x is undefined"]);
    expect(evidence.evidence.failedRequests[0]).toMatchObject({ url: "http://localhost:5173/api/orders" });
  });

  it("sends takeover pause and resume as user actions", async () => {
    const taskOp = vi.fn(async (_taskId: string, _op: string, _payload: Record<string, unknown>) => ({ ok: true, payload: {} }));
    vi.stubGlobal("window", { pidock: { taskOp } });
    expect((await setBrowserTakeover({ taskId: TASK_ID, page: PAGE, paused: true })).kind).toBe("info");
    await setBrowserTakeover({ taskId: TASK_ID, page: PAGE, paused: false });
    expect(taskOp.mock.calls.map((call) => (call[2] as Record<string, unknown>)["action"])).toEqual(["takeover/pause", "takeover/resume"]);
  });

  it("sends a user marker into the task session and reports relocation", async () => {
    const taskOp = vi.fn(async (_taskId: string, _op: string, _payload: Record<string, unknown>) => ({
      ok: true,
      payload: { marker: { kind: "browser-marker", id: "marker-1", needsRelocation: true, currentEpoch: 5 } },
    }));
    vi.stubGlobal("window", { pidock: { taskOp } });
    const marked = await markBrowserIssue({
      taskId: TASK_ID,
      page: PAGE,
      url: "http://localhost:5173/checkout",
      annotation: "总额与对账单不一致",
      epoch: 4,
      sessionId: "main",
    });
    expect(marked.notice.kind).toBe("info");
    expect(marked.marker).toMatchObject({ id: "marker-1", pageId: "page-1", needsRelocation: true });
    const sent = taskOp.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(sent["action"]).toBe("marker/create");
    expect(sent["targetSessionId"]).toBe("main");
    const marker = (sent["params"] as Record<string, unknown>)["marker"] as Record<string, unknown>;
    expect(marker["annotation"]).toBe("总额与对账单不一致");
    expect(marker["epoch"]).toBe(4);
    expect(marker["url"]).toBe("http://localhost:5173/checkout");
  });
});
