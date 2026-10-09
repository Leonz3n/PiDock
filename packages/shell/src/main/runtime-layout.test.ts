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
      once: vi.fn(), on: vi.fn(), removeListener: vi.fn(), send: vi.fn(), setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(async (url: string) => { this.url = url; }), loadFile: vi.fn(async (file: string) => { this.url = `file://${file}`; }),
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
  runTaskService,
  serviceExecutionRefusal,
  SERVICE_EXECUTION_BLOCKED,
  trustedWindowEvidence,
} from "./runtime.js";

import { ProjectRegistry } from "./project-registry.js";
import { TaskRootIndex } from "./task-root-index.js";
import { ProviderWiring } from "./provider-ipc.js";
import { ProviderProfileStore } from "./provider-profile-store.js";
import { ipcMain, type WebContentsView } from "electron";

const originalTaskUrl = process.env["PIDOCK_TASK_URL"];
afterEach(() => {
  if (originalTaskUrl === undefined) delete process.env["PIDOCK_TASK_URL"];
  else process.env["PIDOCK_TASK_URL"] = originalTaskUrl;
});

describe("trusted Electron view modes", () => {
  it("refuses SDK start after credential removal while preserving projection, status and cancel", async () => {
    const root = mkdtempSync(join(tmpdir(), "pidock-provider-start-gate-"));
    try {
      const views = await createTrustedWindow("workspace-provider", "production");
      await loadTrustedViews(views);
      const store = new ProviderProfileStore(root);
      const env: Record<string, string | undefined> = { PIDOCK_PROVIDER_START_TEST: "synthetic-start-gate-only" };
      const profile = store.save({ name: "Synthetic", baseUrl: "https://models.example.test/v1", modelId: "text-model",
        contextWindow: 128000, maxTokens: 8192, authRef: "PIDOCK_PROVIDER_START_TEST" });
      let active = false;
      const install = vi.fn(async () => { if (active) throw Error("sdk-turn-journal-uncommitted"); });
      const providers = new ProviderWiring(store, install, env);
      await providers.select("task-a", profile.id, views.shellView.webContents.id);
      const routeTaskOp = vi.fn(async ({ op }: { op: string }) => ({ payload: op === "task/sendMessage"
        ? { turn: { turnId: "11111111-2222-3333-4444-555555555555", state: "accepted" } }
        : op === "task/sdkStatus" ? { turn: { state: "accepted" } }
        : op === "task/sdkCancel" ? { turn: { state: "cancelled" } }
        : { source: "sdk-jsonl", messages: [] } }));
      registerIpc({} as never, views.registry, { routeTaskOp,
        entryForTaskId: () => ({ client: { onTurnEvent: () => () => {} } }) } as never,
        undefined, undefined, undefined, undefined, providers);
      const sdk = vi.mocked(ipcMain.handle).mock.calls.findLast(([channel]) => channel === "shell/sdkTurn")?.[1];
      const shell = { sender: views.shellView.webContents, senderFrame: views.shellView.webContents.mainFrame } as never;
      const identity = { taskId: "task-a", sessionId: "main" };
      expect(await sdk!(shell, { action: "subscribe", ...identity })).toMatchObject({ ok: true });
      expect(await sdk!(shell, { action: "start", ...identity, requestId: "original", text: "original" })).toMatchObject({ ok: true });
      active = true;
      delete env[profile.authRef];
      const startsBefore = routeTaskOp.mock.calls.filter(([request]) => request.op === "task/sendMessage").length;
      const refused = await sdk!(shell, { action: "start", ...identity, requestId: "must-not-start", text: "next" });
      const startsAfter = routeTaskOp.mock.calls.filter(([request]) => request.op === "task/sendMessage").length;
      expect(await sdk!(shell, { action: "projection", ...identity })).toMatchObject({ ok: true, payload: { source: "sdk-jsonl" } });
      expect(await sdk!(shell, { action: "status", ...identity, requestId: "original" })).toMatchObject({ ok: true, payload: { turn: { state: "accepted" } } });
      expect(await sdk!(shell, { action: "cancel", ...identity, turnId: "11111111-2222-3333-4444-555555555555" })).toMatchObject({ ok: true, payload: { turn: { state: "cancelled" } } });
      expect({ refused: refused.ok === false, newStartDispatches: startsAfter - startsBefore,
        selectionRetained: store.selection("task-a")?.profileId === profile.id })
        .toEqual({ refused: true, newStartDispatches: 0, selectionRetained: true });
      env[profile.authRef] = "synthetic-restored-start-test-only";
      expect(await providers.select("task-a", profile.id, views.shellView.webContents.id))
        .toMatchObject({ state: "credential-missing" });
      active = false;
      expect(await sdk!(shell, { action: "start", ...identity, requestId: "after-terminal", text: "next" }))
        .toMatchObject({ ok: false });
      expect(routeTaskOp.mock.calls.filter(([request]) => request.op === "task/sendMessage")).toHaveLength(startsBefore);
      expect(await sdk!(shell, { action: "status", ...identity, requestId: "original" })).toMatchObject({ ok: true });
      expect(await sdk!(shell, { action: "projection", ...identity })).toMatchObject({ ok: true });
      expect(await providers.select("task-a", profile.id, views.shellView.webContents.id)).toMatchObject({ state: "configured" });
      expect(await sdk!(shell, { action: "start", ...identity, requestId: "after-idle-select", text: "next" }))
        .toMatchObject({ ok: true });
      expect(routeTaskOp.mock.calls.filter(([request]) => request.op === "task/sendMessage")).toHaveLength(startsBefore + 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reconciles a turn completing while the Host listener is attached", async () => {
    const views = await createTrustedWindow("workspace-a", "production");
    await loadTrustedViews(views);
    let completed = false;
    const detach = vi.fn();
    const routeTaskOp = vi.fn(async ({ op }: { op: string }) => ({ payload: op === "task/sdkStatus"
      ? { turn: completed ? { taskId: "task-a", sessionId: "main", requestId: "known", turnId: "turn-1", state: "done", needsResync: false } : null }
      : { source: "sdk-jsonl", messages: completed ? [{ role: "assistant", text: "completed", usage: { input: 4, output: 2 } }] : [] } }));
    const taskRegistry = { routeTaskOp, entryForTaskId: () => ({ client: { onTurnEvent: (listener: (message: unknown) => void) => {
      // The terminal push falls exactly between the first read and registration.
      completed = true;
      listener({ kind: "sdk-turn-status", turn: { taskId: "task-a", sessionId: "main", turnId: "turn-1", state: "done" } });
      return detach;
    } } }) };
    registerIpc({} as never, views.registry, taskRegistry as never);
    const sdk = vi.mocked(ipcMain.handle).mock.calls.findLast(([channel]) => channel === "shell/sdkTurn")?.[1];
    const shell = { sender: views.shellView.webContents, senderFrame: views.shellView.webContents.mainFrame } as never;
    expect(await sdk!(shell, { action: "subscribe", taskId: "task-a", sessionId: "main", requestId: "known" })).toMatchObject({
      ok: true, payload: { snapshot: { messages: [{ role: "assistant", text: "completed" }] }, turn: { turnId: "turn-1", state: "done" } },
    });
    expect(routeTaskOp).toHaveBeenCalledTimes(4);
    expect(await sdk!(shell, { action: "unsubscribe", taskId: "task-a", sessionId: "main" })).toMatchObject({ ok: true });
    expect(detach).toHaveBeenCalledTimes(1);
    expect(views.shellView.webContents.removeListener).toHaveBeenCalledWith("did-navigate-in-page", expect.any(Function));
    expect(views.shellView.webContents.removeListener).toHaveBeenCalledWith("destroyed", expect.any(Function));
  });

  it("re-reads JSONL when a known turn settles between snapshot and status", async () => {
    const views = await createTrustedWindow("workspace-a", "production");
    await loadTrustedViews(views);
    let completed = false;
    const routeTaskOp = vi.fn(async ({ op }: { op: string }) => {
      if (op === "task/sdkStatus") {
        completed = true;
        return { payload: { turn: { taskId: "task-a", sessionId: "main", requestId: "known", turnId: "turn-1", state: "done", needsResync: false } } };
      }
      return { payload: { source: "sdk-jsonl", messages: completed ? [{ role: "assistant", text: "final" }] : [] } };
    });
    registerIpc({} as never, views.registry, { routeTaskOp,
      entryForTaskId: () => ({ client: { onTurnEvent: () => () => {} } }) } as never);
    const sdk = vi.mocked(ipcMain.handle).mock.calls.findLast(([channel]) => channel === "shell/sdkTurn")?.[1];
    const shell = { sender: views.shellView.webContents, senderFrame: views.shellView.webContents.mainFrame } as never;
    expect(await sdk!(shell, { action: "subscribe", taskId: "task-a", sessionId: "main", requestId: "known" })).toMatchObject({
      ok: true, payload: { turn: { state: "done" }, snapshot: { messages: [{ text: "final" }] } },
    });
    expect(routeTaskOp).toHaveBeenCalledTimes(4);
  });

  it("bounds terminal bookkeeping and conservatively resyncs evicted turns", async () => {
    const views = await createTrustedWindow("workspace-a", "production");
    await loadTrustedViews(views);
    let deliver: ((message: unknown) => void) | undefined;
    const routeTaskOp = vi.fn(async ({ op, payload }: { op: string; payload: { requestId?: string } }) => ({ payload: op === "task/sdkStatus"
      ? { turn: { taskId: "task-a", sessionId: "main", turnId: payload.requestId, state: "done", needsResync: false } }
      : op === "task/sendMessage" ? (() => {
        deliver?.({ kind: "sdk-turn-event", event: { taskId: "task-a", sessionId: "main", turnId: "evicted-replay", sequence: 1, type: "delta", text: "stale" } });
        deliver?.({ kind: "sdk-turn-event", event: { taskId: "task-a", sessionId: "main", turnId: "turn-new", sequence: 1, type: "delta", text: "fast" } });
        return { turn: { taskId: "task-a", sessionId: "main", turnId: "turn-new", state: "accepted", lastSequence: 1 } };
      })()
      : { source: "sdk-jsonl", messages: [] } }));
    registerIpc({} as never, views.registry, { routeTaskOp, entryForTaskId: () => ({ client: { onTurnEvent: (callback: typeof deliver) => { deliver = callback; return () => { deliver = undefined; }; } } }) } as never);
    const sdk = vi.mocked(ipcMain.handle).mock.calls.findLast(([channel]) => channel === "shell/sdkTurn")?.[1];
    const shell = { sender: views.shellView.webContents, senderFrame: views.shellView.webContents.mainFrame } as never;
    const identity = { taskId: "task-a", sessionId: "main" };
    expect(await sdk!(shell, { action: "subscribe", ...identity })).toMatchObject({ ok: true });
    for (let i = 0; i < 70; i++) deliver!({ kind: "sdk-turn-resync", taskId: "task-a", sessionId: "main", turnId: `turn-${i}` });
    expect(await sdk!(shell, { action: "status", ...identity, requestId: "turn-0" })).toMatchObject({ ok: true, payload: { turn: { needsResync: true } } });
    expect(await sdk!(shell, { action: "status", ...identity, requestId: "turn-69" })).toMatchObject({ ok: true, payload: { turn: { needsResync: true } } });
    expect(await sdk!(shell, { action: "start", ...identity, requestId: "new", text: "hello" })).toMatchObject({ ok: true, payload: { turn: { turnId: "turn-new" } } });
    expect(views.shellView.webContents.send).toHaveBeenCalledWith("shell/sdkTurnEvent", expect.objectContaining({ event: expect.objectContaining({ turnId: "turn-new", text: "fast" }) }));
    expect(views.shellView.webContents.send).not.toHaveBeenCalledWith("shell/sdkTurnEvent", expect.objectContaining({ event: expect.objectContaining({ turnId: "evicted-replay" }) }));
    deliver!({ kind: "sdk-turn-event", event: { taskId: "task-a", sessionId: "main", turnId: "turn-new", sequence: 2, type: "delta", text: "fresh" } });
    expect(views.shellView.webContents.send).toHaveBeenCalledWith("shell/sdkTurnEvent", expect.objectContaining({ event: expect.objectContaining({ turnId: "turn-new", text: "fresh" }) }));
    await sdk!(shell, { action: "unsubscribe", ...identity });
    expect(deliver).toBeUndefined();
  });

  it("scopes SDK bridge to subscribed shell main frame and revokes on navigation or task switch", async () => {
    const views = await createTrustedWindow("workspace-a", "production");
    await loadTrustedViews(views);
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
    expect(await sdk!(shell, { action: "subscribe", ...identity })).toMatchObject({ ok: true });
    expect(await sdk!(shell, { action: "projection", ...identity })).toMatchObject({ ok: true });
    expect(await sdk!(shell, { action: "unsubscribe", ...identity })).toMatchObject({ ok: true });
    expect(await sdk!(shell, { action: "projection", ...identity })).toMatchObject({ ok: false });
    await views.shellView.webContents.loadURL("file:///tmp/untrusted.html");
    expect(await sdk!(shell, { action: "subscribe", ...identity })).toMatchObject({ ok: false });
    await views.shellView.webContents.loadURL("http://localhost/projects/project-a/tasks/task-a?session=main");
    expect(await sdk!(task, { action: "subscribe", ...identity })).toMatchObject({ ok: false });
    expect(await sdk!(shell, { action: "start", ...identity, requestId: "r1", text: "hi" })).toMatchObject({ ok: false });
    expect(await sdk!(shell, { action: "subscribe", ...identity })).toMatchObject({ ok: true });
    expect(await sdk!(shell, { action: "start", ...identity, requestId: "r1", text: "hi", toolPlan: [] })).toMatchObject({ ok: false });
    expect(await oldTaskOp!(shell, { taskId: "task-a", op: "task/sendMessage", payload: { sessionId: "main", requestId: "r1", text: "hi" } })).toMatchObject({ ok: false });
    expect(await oldTaskOp!(shell, { taskId: "task-a", op: "task/sdkStart", payload: { sessionId: "main" } })).toMatchObject({ ok: false });
    const push = (sequence: number) => ({ kind: "sdk-turn-event", event: { taskId: "task-a", sessionId: "main", turnId: "turn-1", sequence, type: "delta", text: "x" } });
    for (const listener of listeners) listener(push(1));
    expect(views.shellView.webContents.send).toHaveBeenCalledWith("shell/sdkTurnEvent", push(1));
    for (const listener of listeners) listener(push(3));
    expect(views.shellView.webContents.send).toHaveBeenCalledWith("shell/sdkTurnEvent", expect.objectContaining({ kind: "needs-resync", turnId: "turn-1" }));
    for (const listener of listeners) listener({ kind: "sdk-turn-status", turn: { taskId: "task-a", sessionId: "main", turnId: "turn-1", state: "done" } });
    const sendsBeforeReplay = vi.mocked(views.shellView.webContents.send).mock.calls.length;
    for (const listener of listeners) listener(push(1));
    expect(views.shellView.webContents.send).toHaveBeenCalledTimes(sendsBeforeReplay);
    for (const listener of listeners) listener({ kind: "sdk-turn-event", event: { ...push(1).event, taskId: "other", turnId: "turn-2" } });
    expect(views.shellView.webContents.send).not.toHaveBeenCalledWith("shell/sdkTurnEvent", expect.objectContaining({ event: expect.objectContaining({ taskId: "other" }) }));
    const navigation = vi.mocked(views.shellView.webContents.once).mock.calls.findLast(([name]) => name === "did-start-navigation")?.[1] as (() => void) | undefined;
    navigation?.();
    expect(detach).toHaveBeenCalled();
    expect(await sdk!(shell, { action: "status", ...identity, requestId: "r1" })).toMatchObject({ ok: false });
    expect(await sdk!(shell, { action: "subscribe", ...identity })).toMatchObject({ ok: true });
    const current = [...listeners][0]!;
    expect(await sdk!(shell, { action: "subscribe", ...identity })).toMatchObject({ ok: true });
    current(push(2));
    expect(await sdk!(shell, { action: "projection", ...identity })).toMatchObject({ ok: true });
    const stale = [...listeners][0]!;
    expect(await sdk!(shell, { action: "subscribe", taskId: "task-b", sessionId: "main" })).toMatchObject({ ok: false });
    expect(await sdk!(shell, { action: "projection", ...identity })).toMatchObject({ ok: false });
    stale({ kind: "sdk-turn-event", event: { taskId: "task-a", sessionId: "main", turnId: "late", sequence: 1, type: "delta", text: "late" } });
    expect(views.shellView.webContents.send).not.toHaveBeenCalledWith("shell/sdkTurnEvent", expect.objectContaining({ event: expect.objectContaining({ turnId: "late" }) }));
    expect(await sdk!(shell, { action: "subscribe", ...identity })).toMatchObject({ ok: true });
    await oldTaskOp!(shell, { taskId: "task-b", op: "task/sessionStates", payload: {} });
    expect(await sdk!(shell, { action: "projection", ...identity })).toMatchObject({ ok: false });
    expect(await sdk!(shell, { action: "subscribe", ...identity })).toMatchObject({ ok: true });
    await views.shellView.webContents.loadURL("http://localhost/projects/project-a/tasks/task-b?session=main");
    const sameDocument = vi.mocked(views.shellView.webContents.on).mock.calls.findLast(([name]) => name === "did-navigate-in-page")?.[1] as (() => void) | undefined;
    sameDocument?.();
    expect(await sdk!(shell, { action: "status", ...identity, requestId: "r1" })).toMatchObject({ ok: false });
  });

  // [PiDock 02i] (#42) box 4: the successor tickets moved production turns to
  // `shell/sdkTurn`, so the legacy DemoApp `shellHost.sendMessage` path has to
  // stay refused at the shell bridge instead of reaching any task Host.
  it("refuses legacy DemoApp conversation ops as unknown at the shell bridge", async () => {
    const views = await createTrustedWindow("workspace-legacy", "production");
    const routeTaskOp = vi.fn(async () => ({ payload: {} }));
    registerIpc({} as never, views.registry, { routeTaskOp } as never);
    const taskOp = vi.mocked(ipcMain.handle).mock.calls.findLast(([channel]) => channel === "shell/taskOp")?.[1];
    expect(taskOp).toBeDefined();
    const shell = { sender: views.shellView.webContents, senderFrame: views.shellView.webContents.mainFrame } as never;
    for (const op of ["task/sendMessage", "task/sdkStart", "task/sdkStatus", "task/sdkProjection", "task/sdkProvider", "task/sdkCancel"]) {
      expect(await taskOp!(shell, { taskId: "task-a", op, payload: { sessionId: "main" } }))
        .toEqual({ ok: false, error: `invalid-payload: unknown task op: ${op}` });
    }
    expect(routeTaskOp).not.toHaveBeenCalled();
    // A surviving whitelisted op still reaches the task Host: the refusal above
    // comes from the conversation guard, not from sender attestation.
    expect(await taskOp!(shell, { taskId: "task-a", op: "task/sessionStates", payload: {} })).toMatchObject({ ok: true });
    expect(routeTaskOp).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-a", op: "task/sessionStates" }));
    expect(vi.mocked(ipcMain.handle).mock.calls.findLast(([channel]) => channel === "shell/sdkTurn")?.[1]).toBeDefined();
  });

  // [PiDock 04] (#7) The production IPC trigger for catalog-driven service
  // execution must refuse by default: ticket #7's final review blocks
  // production wiring until process-tree ownership/exit reclaim and task-path
  // identity are redesigned with descendant and cross-platform real tests. The
  // capability (`runTaskService`) and its Host wiring stay intact and are
  // driven directly by `service-execution-wiring.test.ts`.
  describe("catalog service execution production gate", () => {
    const request = { op: "runTaskService", taskId: "task-abcdef12", projectId: "project-a", serviceId: "s-a", action: "start" };
    async function gate() {
      const views = await createTrustedWindow("workspace-service-gate", "production");
      const routeTaskOp = vi.fn(async () => ({ payload: { service: { serviceId: "s-a" } } }));
      // Refusing must not even resolve the trusted launch: a launch is what
      // makes a spawn possible, so a resolved launch would be a regression.
      const launchFor = vi.fn(() => { throw new Error("a launch must not be resolved while the production entry is blocked"); });
      registerIpc({} as never, views.registry, { routeTaskOp } as never,
        undefined, undefined, undefined, undefined, undefined, { launchFor } as never);
      const handler = vi.mocked(ipcMain.handle).mock.calls.findLast(([channel]) => channel === "shell/serviceCatalogOp")?.[1];
      expect(handler).toBeDefined();
      const shell = { sender: views.shellView.webContents, senderFrame: views.shellView.webContents.mainFrame } as never;
      return { handler: handler!, shell, routeTaskOp, launchFor };
    }

    it("refuses the production trigger and starts no process by default", async () => {
      const g = await gate();
      expect(await g.handler(g.shell, request)).toEqual({ ok: false, error: SERVICE_EXECUTION_BLOCKED });
      // No process can have started: main neither resolved the trusted launch
      // nor asked the Host to register/control the service.
      expect(g.launchFor).not.toHaveBeenCalled();
      expect(g.routeTaskOp).not.toHaveBeenCalled();
    });

    it("returns the named blocked error, distinct from payload validation", async () => {
      const g = await gate();
      const blocked = await g.handler(g.shell, request);
      const invalid = await g.handler(g.shell, { ...request, program: "/bin/sh" });
      expect(blocked).toEqual({ ok: false, error: SERVICE_EXECUTION_BLOCKED });
      // A payload-validation failure stays a validation error; only a
      // well-formed identity reaches the named, fail-closed refusal.
      expect(invalid).toMatchObject({ ok: false, error: expect.stringContaining("invalid-payload") });
      expect((invalid as { error: string }).error).not.toBe(SERVICE_EXECUTION_BLOCKED);
      expect(g.routeTaskOp).not.toHaveBeenCalled();
    });

    it("exposes the decision as a pure, documented fail-closed helper", () => {
      expect(serviceExecutionRefusal()).toBe(SERVICE_EXECUTION_BLOCKED);
      expect(SERVICE_EXECUTION_BLOCKED).toContain("service-execution-blocked");
      expect(SERVICE_EXECUTION_BLOCKED).toContain("#7");
    });

    it("still drives the capability through the main-function seam", async () => {
      const calls: { op: string; origin: { kind: string } }[] = [];
      const routeTaskOp = vi.fn(async (entry: { op: string; origin: { kind: string } }) => {
        calls.push(entry);
        return { payload: { op: entry.op, action: "start" } };
      });
      const launchFor = vi.fn(() => ({ serviceId: "s-a", descriptor: { name: "API" }, layers: { task: [] }, templateVersion: 1 }));
      const result = await runTaskService({ routeTaskOp } as never, { launchFor } as never,
        { taskId: "task-a", projectId: "project-a", serviceId: "s-a", action: "start" }, 7);
      expect(calls.map((entry) => entry.op)).toEqual(["task/registerService", "task/controlService"]);
      expect(calls.map((entry) => entry.origin.kind)).toEqual(["service-catalog", "service-catalog"]);
      expect(result).toEqual({ op: "task/controlService", action: "start" });
    });
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

  it("selects the latest committed task page and falls back across tasks before returning to full width", async () => {
    const views = await createTrustedWindow("workspace-multi", "production");
    const capability = createTaskBrowserCapability({
      window: views.window, trust: views.registry, workspaceId: "workspace-multi",
      originsFor: () => ["http://localhost:5173"], layout: views.layout,
    });
    const request = (taskId: string, action: string, page?: { pageId: string; webContentsId: number }) =>
      capability.registry.handleRequest({ workspaceId: "workspace-multi", taskId, action, page,
        params: action === "page/open" ? { url: "http://localhost:5173/" } : {},
        actor: { kind: "human", label: "test" } });
    const open = async (taskId: string) => {
      const result = await request(taskId, "page/open");
      if (!result.ok) throw new Error(result.error);
      return result.payload as { pageId: string; webContentsId: number };
    };
    const firstA = await open("task-a");
    const viewA = views.layout!.activeBrowser!.activeTab!.view as WebContentsView;
    const pageB = await open("task-b");
    const viewB = views.layout!.activeBrowser!.activeTab!.view as WebContentsView;
    expect(viewA.getVisible()).toBe(false);
    expect(viewB.getVisible()).toBe(true);
    const secondA = await open("task-a");
    const laterA = views.layout!.activeBrowser!.activeTab!.view as WebContentsView;
    expect(viewB.getVisible()).toBe(false);
    expect(laterA.getVisible()).toBe(true);
    views.window.setContentBounds({ width: 720, height: 560 });
    assertProductionWindowEvidence(views);
    expect(laterA.getBounds()).toEqual({ x: 280, y: 0, width: 440, height: 560 });
    expect(await request("task-a", "page/close", secondA)).toMatchObject({ ok: true, payload: { closed: true } });
    expect(views.layout!.activeBrowser!.activeTab!.view).toBe(viewA);
    expect(viewA.getVisible()).toBe(true);
    expect(viewA.getBounds()).toEqual({ x: 280, y: 0, width: 440, height: 560 });
    expect(viewB.getVisible()).toBe(false);
    expect(await request("task-a", "page/close", firstA)).toMatchObject({ ok: true, payload: { closed: true } });
    expect(viewB.getVisible()).toBe(true);
    expect(viewB.getBounds()).toEqual({ x: 280, y: 0, width: 440, height: 560 });
    expect(views.registry.requireTaskBinding(pageB.webContentsId, { taskId: "task-b", pageId: pageB.pageId }))
      .toMatchObject({ taskId: "task-b", pageId: pageB.pageId });
    assertProductionWindowEvidence(views);
    expect(await request("task-b", "page/close", pageB)).toMatchObject({ ok: true, payload: { closed: true } });
    expect(views.layout!.activeBrowser).toBeUndefined();
    expect(views.shellView.getBounds()).toEqual({ x: 0, y: 0, width: 720, height: 560 });
    expect(views.taskView.getVisible()).toBe(false);
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

// [PiDock 02a/02c] (#34/#36) The Desktop task list is one `shell/listTasks`
// handler: main owns the roots, the renderer names no path, and a broken root
// fails closed instead of being padded with fixture rows.
describe("[PiDock 02a/02c] shell task inventory IPC", () => {
  function writeTaskRecord(root: string, id: string) {
    const dir = join(root, id);
    mkdirSync(dir);
    writeFileSync(join(dir, "task.json"), JSON.stringify({ taskId: id, name: "Real", dirId: id, root, taskDir: dir,
      branch: "task/main", remoteBranch: "main", baseCommit: "abc123", repos: [],
      createdAt: "2026-09-22T10:00:00Z", updatedAt: "2026-09-22T10:00:00Z" }));
    return dir;
  }
  const summary = (taskId: string) => ({ taskId, name: "Real", branch: "task/main", repoCount: 0, updatedAt: "2026-09-22T10:00:00Z" });

  it("lists the configured roots, refuses a task-domain sender and arbitrary taskDir payloads, and reports one failing root without fixture backfill", async () => {
    const home = mkdtempSync(join(tmpdir(), "pidock-list-tasks-"));
    try {
      const defaultRoot = join(home, "default");
      const overrideRoot = join(home, "override");
      mkdirSync(defaultRoot);
      mkdirSync(overrideRoot);
      writeTaskRecord(defaultRoot, "task-00000001");
      writeTaskRecord(overrideRoot, "task-00000002");
      const index = new TaskRootIndex(join(home, "userData"), defaultRoot);
      const views = await createTrustedWindow("workspace-list", "production");
      registerIpc({} as never, views.registry, undefined, undefined, index);
      const handler = vi.mocked(ipcMain.handle).mock.calls.findLast(([channel]) => channel === "shell/listTasks")?.[1];
      expect(handler).toBeDefined();
      const shell = { sender: views.shellView.webContents, senderFrame: views.shellView.webContents.mainFrame } as never;
      const taskSender = { sender: views.taskView.webContents, senderFrame: views.taskView.webContents.mainFrame } as never;

      // A task-domain webContents may not read the Desktop inventory.
      expect(await handler!(taskSender)).toMatchObject({ ok: false, error: expect.stringContaining("wrong-domain") });
      // The renderer names an operation, never a task directory or root path.
      expect(await handler!(shell, { taskDir: overrideRoot })).toMatchObject({ ok: false, error: expect.stringContaining("invalid-payload") });

      // Default root only: the override root is not registered, so its real task
      // is neither listed nor invented.
      expect(await handler!(shell)).toEqual({ ok: true, payload: {
        tasks: [summary("task-00000001")], roots: [{ label: "默认任务根", state: "ready" }],
      } });

      // Explicitly importing the override root adds only its verified real task.
      expect(await index.importRoot(overrideRoot)).toBe(1);
      expect(await handler!(shell)).toEqual({ ok: true, payload: {
        tasks: [summary("task-00000001"), summary("task-00000002")],
        roots: [{ label: "默认任务根", state: "ready" }, { label: "已登记任务根 1", state: "ready" }],
      } });

      // One root fails: the registered root's record is corrupted. Its identity is
      // refused with a per-root error, the healthy task stays visible, and the
      // failed root contributes no substitute or fixture row.
      writeFileSync(join(overrideRoot, "task-00000002", "task.json"), "{ not json");
      const failed = await handler!(shell);
      expect(failed).toEqual({ ok: true, payload: {
        tasks: [summary("task-00000001")],
        roots: [{ label: "默认任务根", state: "ready" },
          { label: "已登记任务根 1", state: "error", message: "任务根目录不可读取或任务身份冲突，请检查后重试" }],
      } });
      expect((failed as { payload: { tasks: unknown[] } }).payload.tasks).toHaveLength(1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
