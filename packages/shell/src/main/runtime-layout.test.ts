import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ nextId: 1 }));
vi.mock("electron", () => ({
  session: { fromPartition: (partition: string) => ({ partition }) },
  WebContentsView: class {
    private bounds = { x: 0, y: 0, width: 1, height: 1 };
    private visible = true;
    private url = "";
    webContents = {
      id: state.nextId++, mainFrame: { processId: 1, routingId: 1 },
      once: vi.fn(), on: vi.fn(), setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(async (url: string) => { this.url = url; }), loadFile: vi.fn(async (_file: string) => {}),
      getURL: () => this.url,
      isDestroyed: () => false, close: vi.fn(),
    };
    setBounds(bounds: typeof this.bounds) { this.bounds = bounds; }
    getBounds() { return this.bounds; }
    setVisible(visible: boolean) { this.visible = visible; }
    getVisible() { return this.visible; }
  },
  BrowserWindow: class {
    id = state.nextId++;
    contentView = {
      children: [] as unknown[],
      addChildView: (view: unknown) => { this.contentView.children.push(view); },
      removeChildView: (view: unknown) => { this.contentView.children.splice(this.contentView.children.indexOf(view), 1); },
    };
    private listeners = new Map<string, () => void>();
    private bounds = { width: 1440, height: 900 };
    getContentBounds() { return this.bounds; }
    setContentBounds(bounds: typeof this.bounds) { this.bounds = bounds; this.listeners.get("resize")?.(); }
    on(event: string, listener: () => void) { this.listeners.set(event, listener); }
    once(event: string, listener: () => void) { this.listeners.set(event, listener); }
    isVisible() { return true; }
  },
  ipcMain: { handle: vi.fn() },
  utilityProcess: { fork: vi.fn() },
}));

import {
  assertProductionWindowEvidence,
  assertTrustedWindowEvidence,
  createTaskBrowserCapability,
  createTrustedWindow,
  loadTrustedViews,
  trustedWindowEvidence,
} from "./runtime.js";

const originalTaskUrl = process.env["PIDOCK_TASK_URL"];
afterEach(() => {
  if (originalTaskUrl === undefined) delete process.env["PIDOCK_TASK_URL"];
  else process.env["PIDOCK_TASK_URL"] = originalTaskUrl;
});

describe("trusted Electron view modes", () => {
  it("retains the default smoke two-visible-view evidence and loads explicit task URLs", async () => {
    const smoke = await createTrustedWindow("workspace-a");
    const smokeLoaded = await loadTrustedViews(smoke);
    expect(smokeLoaded.shellUrl).toMatch(/\/renderer\/smoke\.html$/);
    expect(smoke.shellView.webContents.loadFile).toHaveBeenCalledWith(expect.stringMatching(/\/renderer\/smoke\.html$/));
    assertTrustedWindowEvidence(trustedWindowEvidence(smoke));
    process.env["PIDOCK_TASK_URL"] = "http://127.0.0.1:4319/task";
    const explicit = await createTrustedWindow("workspace-b", "dual");
    const loaded = await loadTrustedViews(explicit);
    expect(loaded.taskUrl).toBe(process.env["PIDOCK_TASK_URL"]);
    expect(explicit.taskView.webContents.loadURL).toHaveBeenCalledWith(loaded.taskUrl);
    assertTrustedWindowEvidence(trustedWindowEvidence(explicit));
  });

  it("routes a validated lazy page through main layout, resize, close and restore", async () => {
    const views = await createTrustedWindow("workspace-d", "production");
    const capability = createTaskBrowserCapability({
      window: views.window, trust: views.registry, workspaceId: "workspace-d",
      originsFor: () => ["http://localhost:5173"], layout: views.layout,
    });
    const request = (action: string, page?: { pageId: string; webContentsId: number }, url?: string) =>
      capability.registry.handleRequest({
        workspaceId: "workspace-d", taskId: "task-d", action, page,
        params: url ? { url } : {}, actor: { kind: "human" as const, label: "test" },
      });
    expect((await request("page/open", undefined, "https://example.com"))?.ok).toBe(false);
    assertProductionWindowEvidence(views);
    const opened = await request("page/open", undefined, "http://localhost:5173/");
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.error);
    const page = opened.payload as { pageId: string; webContentsId: number };
    assertProductionWindowEvidence(views);
    views.window.setContentBounds({ width: 720, height: 560 });
    assertProductionWindowEvidence(views);
    const browser = capability.surfaces.get("task-d")!;
    expect(browser.pages()).toHaveLength(1);
    expect(views.layout?.activeBrowser?.activeTab?.view.getVisible()).toBe(true);
    expect((await request("page/close", page)).ok).toBe(true);
    assertProductionWindowEvidence(views);
    expect(views.shellView.getBounds().width).toBe(720);
    expect((await request("page/restore")).ok).toBe(true);
    assertProductionWindowEvidence(views);
  });

  it("keeps production fixture registered but hidden and fills the window on resize", async () => {
    delete process.env["PIDOCK_TASK_URL"];
    const views = await createTrustedWindow("workspace-c", "production");
    const loaded = await loadTrustedViews(views);
    expect(loaded.shellUrl).toMatch(/\/renderer\/index\.html$/);
    expect(views.shellView.webContents.loadFile).toHaveBeenCalledWith(expect.stringMatching(/\/renderer\/index\.html$/));
    expect(loaded.taskUrl).toBe("about:blank");
    expect(views.taskView.webContents.loadFile).not.toHaveBeenCalled();
    expect(views.taskView.getVisible()).toBe(false);
    expect(views.shellView.getBounds().width).toBe(1440);
    assertProductionWindowEvidence(views);
    views.window.setContentBounds({ width: 720, height: 560 });
    expect(views.shellView.getBounds()).toEqual({ x: 0, y: 0, width: 720, height: 560 });
    assertProductionWindowEvidence(views);
  });
});
