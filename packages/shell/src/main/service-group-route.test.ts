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

import { ipcMain } from "electron";
import { createTrustedWindow, registerIpc } from "./runtime.js";

// Seam: the REAL `shell/taskOp` handler — the sandboxed renderer's only route to
// a task Host. The Electron transport is mocked (no utilityProcess round trip),
// and the Host itself is a spy, because what this file pins is the TRUST rule in
// main: the plan's 依赖边/变量绑定规则/配置层 are trusted data, so a page can name
// none of them. Main's own plan route (`PerTaskHostRegistry.routeTaskOp`) does not
// pass through this handler, so the catalog plan is unaffected by the refusal.

interface Route {
  invoke: (op: string, payload?: Record<string, unknown>) => Promise<unknown>;
  routed: { op: string; payload: Record<string, unknown> }[];
}

const EXPIRED_WINDOWS: { dispose: () => void }[] = [];

afterEach(() => {
  for (const entry of EXPIRED_WINDOWS.splice(0)) entry.dispose();
  vi.restoreAllMocks();
  vi.resetModules();
});

/** The real `shell/taskOp` handler of one trusted shell window, with a Host spy. */
async function route(): Promise<Route> {
  const views = await createTrustedWindow("workspace-task-op", "production");
  // The task browser of this window really opened a tab; close it so no listener
  // of this suite outlives the test.
  EXPIRED_WINDOWS.push({ dispose: () => views.taskBrowser.close() });
  const routed: { op: string; payload: Record<string, unknown> }[] = [];
  const tasks = {
    routeTaskOp: async (params: { op: string; payload?: Record<string, unknown> }) => {
      routed.push({ op: params.op, payload: params.payload ?? {} });
      return { workspaceId: "workspace-task-op", taskId: "task-1a2b3c4d", op: params.op, payload: { plan: { assignments: [], diagnostics: [], taskRows: [] } } };
    },
    configureServices: vi.fn(),
  };
  registerIpc({} as never, views.registry, tasks as never);
  const handler = vi
    .mocked(ipcMain.handle)
    .mock.calls.findLast(([channel]) => channel === "shell/taskOp")?.[1] as unknown as (
    event: unknown,
    payload: unknown,
  ) => Promise<unknown>;
  const shell = { sender: views.shellView.webContents, senderFrame: views.shellView.webContents.mainFrame };
  return {
    routed,
    invoke: async (op, payload = {}) => {
      try {
        return await handler(shell, { taskId: "task-1a2b3c4d", op, payload });
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

const UNITS = [{ unitId: "repo-a:caller-api", serviceId: "caller-api", name: "Caller API", repoDir: "repo-a", location: "local" }];

describe("[PiDock 05] #10 + ADR 0002 a page cannot name the plan's trusted inputs", () => {
  it("refuses renderer-supplied dependencies, rules and layers BY NAME, and asks no Host", async () => {
    const r = await route();
    const attempts: [string, unknown][] = [
      ["dependencies", [{ from: "repo-a:caller-api", to: "repo-a:callee-api", kind: "call" }]],
      ["rules", [{ key: "CALLEE_API_URL", unitId: "repo-a:callee-api", kind: "url" }]],
      ["layers", { repoDefaults: [], shared: [{ key: "CALLEE_API_URL", value: "https://shared.example", secret: false }], privateEntries: [], task: [] }],
    ];
    for (const [key, value] of attempts) {
      const result = (await r.invoke("task/planServiceGroup", { units: UNITS, [key]: value })) as { ok: boolean; error: string };
      // Refused by the key's own name, and never silently dropped: a page must not
      // be able to make the plan's edges/rules/layers look like they were applied.
      expect(result.ok).toBe(false);
      expect(result.error).toBe(
        `invalid-payload: shell/taskOp 不接受 task/planServiceGroup.${key}：计划的依赖边、变量绑定规则与配置层只从可信服务目录读取（ref #7）`,
      );
      // The Host was never asked: no half-decided plan can be written from here.
      expect(r.routed).toEqual([]);
    }
  });

  it("still forwards the read-shaped plan request: units, ports and the environment label", async () => {
    const r = await route();
    const result = (await r.invoke("task/planServiceGroup", {
      units: UNITS,
      requests: [{ unitId: "repo-a:caller-api", port: 9101 }],
      environment: "开发环境",
    })) as { ok: boolean };
    expect(result.ok).toBe(true);
    // MUTATION GUARD for the refusal above: the very same route accepts the same
    // payload once the three trusted keys are absent, so the refusal is keyed on
    // them and not on the op.
    expect(r.routed).toEqual([
      { op: "task/planServiceGroup", payload: { units: UNITS, requests: [{ unitId: "repo-a:caller-api", port: 9101 }], environment: "开发环境" } },
    ]);
  });
});
