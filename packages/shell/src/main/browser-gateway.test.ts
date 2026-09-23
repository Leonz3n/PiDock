import { describe, expect, it } from "vitest";
import {
  createBrowserGateway,
  createBrowserGatewayRegistry,
  MAX_SCREENSHOT_BASE64,
  type BrowserSurface,
  type BrowserSurfaceRequest,
} from "./browser-gateway.js";
import { deriveNavigationAllowlist } from "./browser-rules.js";

// Seam: [PiDock 06] (#8) main-process browser gateway. The surface stands
// in for the visible page classes (`TaskBrowser`/`TaskAutomation`), so the
// ownership, allowlist, takeover, evidence and marker rules are covered
// without Electron; the real adapter is only wiring over verified classes.

const TASK_ID = "task-a1f92c3d";
const OTHER_TASK = "task-ffffffff";
const PAGE = { pageId: "page-1", webContentsId: 11 };

function fakeSurface(overrides: Partial<BrowserSurface> = {}) {
  const performed: BrowserSurfaceRequest[] = [];
  const surface: BrowserSurface = {
    taskId: TASK_ID,
    pages: () => [
      { pageId: "page-1", webContentsId: 11, url: "http://localhost:5173/checkout" },
      { pageId: "page-2", webContentsId: 12, url: "http://localhost:5173/detail" },
    ],
    state: async () => ({ epoch: 3, viewport: { width: 1200, height: 800, scrollX: 0, scrollY: 120 }, title: "对账单", url: "http://localhost:5173/checkout" }),
    takeoverState: () => ({ paused: false }),
    rawEvidence: () => ({ consoleErrors: [], failedRequests: [] }),
    screenshot: async () => ({ bytes: 24, width: 4, height: 2, sha256: "a".repeat(64), data: "iVBORw0KGgo=" }),
    perform: async (request) => {
      performed.push(request);
      return { ok: true, payload: { performed: request.action } };
    },
    ...overrides,
  };
  return { surface, performed };
}

function gatewayFor(surface: BrowserSurface, secrets: readonly string[] = []) {
  return createBrowserGateway({ taskId: TASK_ID, surface, allowlist: deriveNavigationAllowlist({ ports: [5173] }), secrets });
}

const agent = { kind: "agent", sessionId: "main" } as const;
const human = { kind: "human", label: "用户显式操作" } as const;

describe("browser gateway ownership and tiers", () => {
  it("rejects a surface bound to another task", async () => {
    const { surface } = fakeSurface({ taskId: OTHER_TASK });
    const result = await gatewayFor(surface).perform({ action: "page/state", page: PAGE as never, params: {}, actor: agent });
    expect(result).toMatchObject({ error: expect.stringContaining("page-foreign-task") });
  });

  it("keeps user-only actions off the agent path but allowed for the user", async () => {
    const { surface, performed } = fakeSurface();
    const gateway = gatewayFor(surface);
    const denied = await gateway.perform({ action: "marker/create", page: PAGE as never, params: {}, actor: agent });
    expect(denied).toMatchObject({ error: expect.stringContaining("只能由用户显式操作") });
    const paused = await gateway.perform({ action: "takeover/pause", page: undefined, params: {}, actor: agent });
    expect(paused.ok).toBe(false);
    const humanPause = await gateway.perform({ action: "takeover/pause", page: undefined, params: {}, actor: human });
    expect(humanPause.ok).toBe(true);
    expect(performed.map((request) => request.action)).toEqual(["takeover/pause"]);
  });

  it("refuses agent automation while the user holds the page, and lets the user work", async () => {
    const { surface, performed } = fakeSurface({ takeoverState: () => ({ paused: true, reason: "人工登录" }) });
    const gateway = gatewayFor(surface);
    const denied = await gateway.perform({ action: "page/navigate", page: PAGE as never, params: { url: "http://localhost:5173/checkout" }, actor: agent });
    expect(denied).toMatchObject({ error: expect.stringContaining("takeover-paused") });
    expect(performed).toHaveLength(0);
    const user = await gateway.perform({ action: "page/navigate", page: PAGE as never, params: { url: "http://localhost:5173/checkout" }, actor: human });
    expect(user.ok).toBe(true);
  });

  it("fails closed on missing, foreign and stale page handles", async () => {
    const { surface } = fakeSurface();
    const gateway = gatewayFor(surface);
    expect(await gateway.perform({ action: "page/reload", page: undefined, params: {}, actor: agent })).toMatchObject({
      error: expect.stringContaining("page-required"),
    });
    expect(
      await gateway.perform({ action: "page/reload", page: { taskId: OTHER_TASK, pageId: "page-1" } as never, params: {}, actor: agent }),
    ).toMatchObject({ error: expect.stringContaining("page-foreign-task") });
    expect(await gateway.perform({ action: "page/reload", page: { pageId: "page-gone" } as never, params: {}, actor: agent })).toMatchObject({
      error: expect.stringContaining("page-stale"),
    });
    expect(
      await gateway.perform({ action: "page/reload", page: { pageId: "page-1", webContentsId: 99 } as never, params: {}, actor: agent }),
    ).toMatchObject({ error: expect.stringContaining("page-stale") });
  });

  it("binds the delegation to the live page, not the caller's claims", async () => {
    const { surface, performed } = fakeSurface();
    const result = await gatewayFor(surface).perform({
      action: "input/click",
      page: { taskId: TASK_ID, pageId: "page-2", webContentsId: 12 } as never,
      params: { locator: { kind: "testId", value: "checkout-total" } },
      actor: agent,
    });
    expect(result.ok).toBe(true);
    expect(performed[0]).toMatchObject({ action: "input/click", page: { pageId: "page-2", webContentsId: 12 }, actor: agent });
  });

  it("keeps navigation on the task's own addresses", async () => {
    const { surface, performed } = fakeSurface();
    const gateway = gatewayFor(surface);
    const denied = await gateway.perform({ action: "page/navigate", page: PAGE as never, params: { url: "https://example.org/" }, actor: agent });
    expect(denied).toMatchObject({ error: expect.stringContaining("navigation-denied") });
    const fileDenied = await gateway.perform({ action: "page/open", page: undefined, params: { url: "file:///etc/passwd" }, actor: agent });
    expect(fileDenied.ok).toBe(false);
    const allowed = await gateway.perform({ action: "page/navigate", page: PAGE as never, params: { url: "http://127.0.0.1:5173/checkout" }, actor: agent });
    expect(allowed.ok).toBe(true);
    expect(performed.map((request) => request.action)).toEqual(["page/navigate"]);
  });
});

describe("browser gateway evidence and markers", () => {
  it("bounds and scrubs evidence before it leaves the surface", async () => {
    const { surface } = fakeSurface({
      rawEvidence: () => ({
        consoleErrors: Array.from({ length: 30 }, (_, index) => ({ kind: "console" as const, text: `err-${index} token=super-secret-value` })),
        failedRequests: [{ requestId: "r1", url: "http://user:pw@localhost:5173/api", errorText: "net::ERR_FAILED", resourceType: "XHR", canceled: false }],
      }),
    });
    const result = await gatewayFor(surface, ["super-secret-value"]).perform({ action: "evidence", page: PAGE as never, params: {}, actor: agent });
    expect(result.ok).toBe(true);
    const evidence = (result as { payload: { evidence: { consoleErrors: { text: string }[]; failedRequests: { url: string }[] } } }).payload.evidence;
    expect(evidence.consoleErrors).toHaveLength(20);
    expect(evidence.consoleErrors.at(-1)?.text).not.toContain("super-secret-value");
    expect(evidence.failedRequests[0]?.url).not.toContain("user:pw@");
  });

  it("caps on-demand screenshots", async () => {
    const { surface } = fakeSurface({
      screenshot: async () => ({ bytes: 10, width: 4, height: 2, sha256: "b".repeat(64), data: "x".repeat(MAX_SCREENSHOT_BASE64 + 1) }),
    });
    const denied = await gatewayFor(surface).perform({ action: "screenshot", page: PAGE as never, params: {}, actor: agent });
    expect(denied).toMatchObject({ error: expect.stringContaining("screenshot-too-large") });

    const ok = await gatewayFor(fakeSurface().surface).perform({ action: "screenshot", page: PAGE as never, params: {}, actor: agent });
    expect(ok.ok).toBe(true);
    expect((ok as { payload: { screenshot: { data: string; sha256: string } } }).payload.screenshot).toMatchObject({ data: "iVBORw0KGgo=" });
  });

  it("attributes a user marker to this task's page and reports relocation", async () => {
    const { surface, performed } = fakeSurface();
    const result = await gatewayFor(surface).perform({
      action: "marker/create",
      page: { taskId: TASK_ID, pageId: "page-1" } as never,
      params: {
        marker: { page: { taskId: TASK_ID, pageId: "page-1" }, url: "http://localhost:5173/checkout", mode: "box", annotation: "总额不一致", epoch: 2 },
      },
      actor: human,
    });
    expect(result.ok).toBe(true);
    const payload = (result as { payload: { marker: { kind: string; needsRelocation: boolean; currentEpoch: number; screenshotSha256: string }; screenshot: { sha256: string; width: number; height: number } } }).payload;
    expect(payload.marker).toMatchObject({ kind: "browser-marker", needsRelocation: true, currentEpoch: 3, screenshotSha256: "a".repeat(64) });
    // The marker carries the page snapshot it was raised on.
    expect(payload.screenshot).toMatchObject({ sha256: "a".repeat(64), width: 4, height: 2 });
    expect(performed[0]?.params["marker"]).toMatchObject({ taskId: TASK_ID, pageId: "page-1" });

    const invalid = await gatewayFor(surface).perform({
      action: "marker/create",
      page: PAGE as never,
      params: { marker: { page: { taskId: TASK_ID, pageId: "page-1" }, url: "http://localhost:5173/x", mode: "box", annotation: " ", epoch: 2 } },
      actor: human,
    });
    expect(invalid).toMatchObject({ error: expect.stringContaining("用户说明") });
  });
});

describe("browser gateway registry", () => {
  const registryWith = (surface: BrowserSurface | { error: string }) =>
    createBrowserGatewayRegistry({
      workspaceId: "ws-a",
      surfaceFor: () => surface,
      allowlistFor: () => deriveNavigationAllowlist({ ports: [5173] }),
    });

  it("refuses another workspace, unknown actions and unknown tasks", async () => {
    const { surface } = fakeSurface();
    const registry = registryWith(surface);
    expect(
      await registry.handleRequest({ workspaceId: "ws-b", taskId: TASK_ID, action: "page/state", page: PAGE, actor: agent }),
    ).toMatchObject({ error: "task-workspace-mismatch" });
    expect(
      await registry.handleRequest({ workspaceId: "ws-a", taskId: TASK_ID, action: "page/teleport", page: PAGE, actor: agent }),
    ).toMatchObject({ error: expect.stringContaining("unknown-action") });
    const missing = registryWith({ error: "task-unknown: no browser for this task" });
    expect(await missing.handleRequest({ workspaceId: "ws-a", taskId: OTHER_TASK, action: "page/state", page: PAGE, actor: agent })).toMatchObject({
      error: expect.stringContaining("task-unknown"),
    });
  });

  it("routes a valid request to the task's surface", async () => {
    const { surface, performed } = fakeSurface();
    const result = await registryWith(surface).handleRequest({
      workspaceId: "ws-a",
      taskId: TASK_ID,
      action: "page/reload",
      page: PAGE,
      actor: { kind: "agent", sessionId: "main" },
    });
    expect(result.ok).toBe(true);
    expect(performed).toHaveLength(1);
    expect(performed[0]).toMatchObject({ action: "page/reload", page: { pageId: "page-1", webContentsId: 11 } });
  });

  it("answers a page-state read with the live page identity", async () => {
    const { surface } = fakeSurface();
    const result = await registryWith(surface).handleRequest({
      workspaceId: "ws-a",
      taskId: TASK_ID,
      action: "page/state",
      page: PAGE,
      actor: { kind: "agent", sessionId: "main" },
    });
    expect(result).toMatchObject({
      ok: true,
      payload: {
        pageId: "page-1",
        identity: { taskId: TASK_ID, pageId: "page-1", webContentsId: 11 },
        state: { epoch: 3, title: "对账单", viewport: { width: 1200, height: 800 } },
      },
    });
  });
});
