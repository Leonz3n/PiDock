import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const state = vi.hoisted(() => ({ nextId: 1 }));
vi.mock("electron", () => ({
  session: { fromPartition: (partition: string) => ({ partition }) },
  WebContentsView: class {
    private bounds = { x: 0, y: 0, width: 1, height: 1 };
    private visible = true;
    private url = "";
    webContents = {
      id: state.nextId++, mainFrame: { processId: 1, routingId: 1 },
      once: vi.fn(), on: vi.fn(), send: vi.fn(), setWindowOpenHandler: vi.fn(),
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
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn(), eventNames: () => [] },
  utilityProcess: { fork: vi.fn() },
}));

import {
  assertProductionWindowEvidence,
  assertTrustedWindowEvidence,
  createTaskBrowserCapability,
  createTrustedWindow,
  loadTrustedViews,
  registerIpc,
  trustedWindowEvidence,
} from "./runtime.js";

import { ProjectRegistry } from "./project-registry.js";
import { TaskRootIndex } from "./task-root-index.js";
import { ipcMain } from "electron";

const originalTaskUrl = process.env["PIDOCK_TASK_URL"];
afterEach(() => {
  if (originalTaskUrl === undefined) delete process.env["PIDOCK_TASK_URL"];
  else process.env["PIDOCK_TASK_URL"] = originalTaskUrl;
});

describe("trusted Electron view modes", () => {
  it("scopes SDK bridge to subscribed shell main frame and revokes on navigation or task switch", async () => {
    const views = await createTrustedWindow("workspace-a", "production");
    const listeners = new Set<(message: unknown) => void>();
    const detach = vi.fn((listener: (message: unknown) => void) => listeners.delete(listener));
    const routeTaskOp = vi.fn(async (params: { taskId: string; op: string }) => ({ payload: { source: "sdk-jsonl", messages: [], taskId: params.taskId, op: params.op } }));
    const taskRegistry = { routeTaskOp, entryForTaskId: () => ({ client: { onTurnEvent: (listener: (message: unknown) => void) => {
      listeners.add(listener); return () => detach(listener);
    } } }) };
    registerIpc({} as never, views.registry, taskRegistry as never);
    const sdk = vi.mocked(ipcMain.handle).mock.calls.findLast(([channel]) => channel === "shell/sdkTurn")?.[1];
    const oldTaskOp = vi.mocked(ipcMain.handle).mock.calls.findLast(([channel]) => channel === "shell/taskOp")?.[1];
    expect(sdk).toBeDefined();
    const shell = { sender: views.shellView.webContents, senderFrame: views.shellView.webContents.mainFrame } as never;
    const task = { sender: views.taskView.webContents, senderFrame: views.taskView.webContents.mainFrame } as never;
    const identity = { taskId: "task-a", sessionId: "main" };
    expect(await sdk!(task, { action: "subscribe", ...identity })).toMatchObject({ ok: false });
    expect(await sdk!(shell, { action: "start", ...identity, requestId: "r1", text: "hi" })).toMatchObject({ ok: false });
    expect(await sdk!(shell, { action: "subscribe", ...identity })).toMatchObject({ ok: true });
    expect(await sdk!(shell, { action: "start", ...identity, requestId: "r1", text: "hi", toolPlan: [] })).toMatchObject({ ok: false });
    expect(await oldTaskOp!(shell, { taskId: "task-a", op: "task/sdkStart", payload: { sessionId: "main" } })).toMatchObject({ ok: false });
    const push = (sequence: number) => ({ kind: "sdk-turn-event", event: { taskId: "task-a", sessionId: "main", turnId: "turn-1", sequence, type: "delta", text: "x" } });
    for (const listener of listeners) listener(push(1));
    expect(views.shellView.webContents.send).toHaveBeenCalledWith("shell/sdkTurnEvent", push(1));
    for (const listener of listeners) listener(push(3));
    expect(views.shellView.webContents.send).toHaveBeenCalledWith("shell/sdkTurnEvent", expect.objectContaining({ kind: "needs-resync", turnId: "turn-1" }));
    for (const listener of listeners) listener({ kind: "sdk-turn-event", event: { ...push(1).event, taskId: "other", turnId: "turn-2" } });
    expect(views.shellView.webContents.send).not.toHaveBeenCalledWith("shell/sdkTurnEvent", expect.objectContaining({ event: expect.objectContaining({ taskId: "other" }) }));
    const navigation = vi.mocked(views.shellView.webContents.once).mock.calls.find(([name]) => name === "did-start-navigation")?.[1] as (() => void) | undefined;
    navigation?.();
    expect(detach).toHaveBeenCalled();
    expect(await sdk!(shell, { action: "status", ...identity, requestId: "r1" })).toMatchObject({ ok: false });
    expect(await sdk!(shell, { action: "subscribe", ...identity })).toMatchObject({ ok: true });
    await oldTaskOp!(shell, { taskId: "task-b", op: "task/sessionStates", payload: {} });
    expect(await sdk!(shell, { action: "projection", ...identity })).toMatchObject({ ok: false });
  });

  it("binds project IPC to shell main frame and fails closed without a configured store", async () => {
    const root = mkdtempSync(join(tmpdir(), "pidock-project-runtime-"));
    try {
      const views = await createTrustedWindow("workspace-project", "production");
      const store = new ProjectRegistry(root);
      const taskRoot = join(root, "tasks");
      mkdirSync(taskRoot);
      const taskDir = join(taskRoot, "task-abcdef12");
      mkdirSync(taskDir);
      const createdAt = "2026-09-22T10:00:00Z";
      writeFileSync(join(taskDir, "task.json"), JSON.stringify({ taskId: "task-abcdef12", name: "Real", dirId: "task-abcdef12",
        root: taskRoot, taskDir, branch: "task/main", remoteBranch: "main", baseCommit: "abc123", repos: [], createdAt, updatedAt: createdAt }));
      registerIpc({} as never, views.registry, undefined, store, new TaskRootIndex(root, taskRoot));
      const handler = vi.mocked(ipcMain.handle).mock.calls.findLast(([channel]) => channel === "shell/projectOp")?.[1];
      expect(handler).toBeDefined();
      const event = { sender: views.shellView.webContents, senderFrame: views.shellView.webContents.mainFrame } as never;
      const invalid = { sender: views.taskView.webContents, senderFrame: views.taskView.webContents.mainFrame } as never;
      expect(await handler!(invalid, { op: "list" })).toMatchObject({ ok: false });
      expect(await handler!(event, { op: "list", registryPath: "/tmp/forbidden" })).toMatchObject({ ok: false });
      expect(await handler!(event, { op: "list" })).toEqual({ ok: true, payload: { initialized: false, projects: [] } });
      expect(await handler!(event, { op: "create", input: { name: "Real", description: "", repositories: [], directories: [] } })).toMatchObject({ ok: true });
      expect(store.list().projects).toHaveLength(1);
      const projectId = store.list().projects[0]!.id;
      const claim = { op: "claim", taskId: "task-abcdef12", projectId };
      expect(await handler!(invalid, claim)).toMatchObject({ ok: false });
      expect(await handler!(event, { ...claim, taskDir })).toMatchObject({ ok: false });
      expect(await handler!(event, claim)).toMatchObject({ ok: true, payload: { action: "claim", toProjectId: projectId } });
      expect(store.associations(new TaskRootIndex(root, taskRoot))).toMatchObject([{ taskId: "task-abcdef12", state: "assigned" }]);
      expect(await handler!(invalid, { op: "delete", projectId })).toMatchObject({ ok: false });
      expect(await handler!(event, { op: "unlink", taskId: "task-abcdef12", expectedProjectId: projectId })).toMatchObject({ ok: true, payload: { action: "unlink" } });
      expect(await handler!(event, { op: "delete", projectId, taskDir })).toMatchObject({ ok: false });
      expect(await handler!(event, { op: "delete", projectId })).toMatchObject({ ok: true, payload: { action: "delete", projectId } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("accepts picker-only import from the shell main frame and refuses payload paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "pidock-picker-runtime-"));
    try {
      const views = await createTrustedWindow("workspace-picker", "production");
      const index = new TaskRootIndex(join(root, "data"), join(root, "default"));
      const picker = vi.fn(async () => null);
      registerIpc({} as never, views.registry, undefined, undefined, index, picker);
      const handler = vi.mocked(ipcMain.handle).mock.calls.findLast(([channel]) => channel === "shell/importTaskRoot")?.[1];
      expect(handler).toBeDefined();
      const sender = { sender: views.shellView.webContents, senderFrame: views.shellView.webContents.mainFrame } as never;
      const other = { sender: views.taskView.webContents, senderFrame: views.taskView.webContents.mainFrame } as never;
      expect(await handler!(other)).toMatchObject({ ok: false });
      expect(await handler!(sender, { path: "/tmp/arbitrary" })).toMatchObject({ ok: false });
      expect(picker).not.toHaveBeenCalled();
      expect(await handler!(sender)).toEqual({ ok: true, payload: { canceled: true } });
      expect(picker).toHaveBeenCalledTimes(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

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
