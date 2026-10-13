import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ nextId: 1, bridgeKeys: [] as string[] }));
vi.mock("electron", () => ({
  app: { whenReady: async () => {}, getPath: () => "/tmp/pidock-smoke-contract" },
  session: { fromPartition: (partition: string) => ({ partition }) },
  utilityProcess: { fork: () => {
    const child = new EventEmitter();
    return Object.assign(child, { kill: vi.fn(() => child.emit("exit", 0)) });
  } },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn(), eventNames: () => [] },
  WebContentsView: class {
    private bounds = { x: 0, y: 0, width: 1, height: 1 };
    private visible = true;
    private url = "";
    constructor(private options: { webPreferences: { preload?: string } }) {}
    webContents = {
      id: state.nextId++, mainFrame: { processId: 1, routingId: 1 },
      once: vi.fn(), on: vi.fn(), setWindowOpenHandler: vi.fn(), close: vi.fn(),
      loadURL: async (url: string) => { this.url = url; },
      loadFile: async (file: string) => { this.url = `file://${file}`; },
      getURL: () => this.url, isDestroyed: () => false,
      executeJavaScript: async () => {
        const globals = { require: "undefined", process: "undefined", module: "undefined", ipcRenderer: "undefined", electron: "undefined" };
        if (this.url.startsWith("data:")) return { globals: { ...globals, pidock: "object" }, rejected: true };
        if (!this.options.webPreferences.preload) return { globals: { ...globals, pidock: "undefined", cdp: "undefined" }, marker: "task", title: "PiDock Task Page (S2)" };
        return {
          globals: { ...globals, pidock: "object" }, bridge: true, bridgeKeys: state.bridgeKeys,
          security: { sandboxed: true, contextIsolated: true },
          ping: { ok: true, payload: { pong: true, workspaceId: "smoke-contract" } },
          versions: { ok: true, payload: { electron: "44.4.3", mainNode: "24.21.0", utilityNode: "24.21.0", workspaceId: "smoke-contract" } },
          mismatchRejected: true, mismatchError: "payload workspace does not match sender binding",
        };
      },
    };
    setBounds(bounds: typeof this.bounds) { this.bounds = bounds; }
    getBounds() { return this.bounds; }
    setVisible(visible: boolean) { this.visible = visible; }
    getVisible() { return this.visible; }
  },
  BrowserWindow: class {
    id = state.nextId++;
    contentView = { children: [] as unknown[], addChildView: (view: unknown) => { this.contentView.children.push(view); } };
    getContentBounds() { return { width: 1440, height: 900 }; }
    on = vi.fn();
    once = vi.fn();
    destroy = vi.fn();
    isVisible() { return true; }
  },
}));

import { SHELL_BRIDGE_SURFACE, runSmoke } from "./smoke.js";

// Captured native preload contract; these mocked probes test report validation,
// not the actual renderer sandbox or native IPC authorization. The list is the
// smoke run's own contract, and `native preload bridge surface` below derives
// the real keys from preload.cjs, so the mirror cannot drift unnoticed (#15).
const authorizedKeys = [...SHELL_BRIDGE_SURFACE];
const rendererUrl = process.env["PIDOCK_RENDERER_URL"];
const taskUrl = process.env["PIDOCK_TASK_URL"];
afterEach(() => {
  if (rendererUrl === undefined) delete process.env["PIDOCK_RENDERER_URL"];
  else process.env["PIDOCK_RENDERER_URL"] = rendererUrl;
  if (taskUrl === undefined) delete process.env["PIDOCK_TASK_URL"];
  else process.env["PIDOCK_TASK_URL"] = taskUrl;
});

describe("mocked native smoke bridge contract", () => {
  async function report(keys: string[]) {
    delete process.env["PIDOCK_RENDERER_URL"];
    delete process.env["PIDOCK_TASK_URL"];
    state.bridgeKeys = keys;
    return runSmoke("smoke-contract");
  }

  it("accepts the complete authorized preload surface", async () => {
    const result = await report(authorizedKeys);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.trustDomains.shell.bridgeKeys).toEqual(authorizedKeys);
  });

  it.each(["providerOp", "serviceCatalogOp"])("rejects a missing %s capability", async (key) => {
    expect(await report(authorizedKeys.filter((value) => value !== key))).toMatchObject({
      ok: false, error: { message: expect.stringContaining("shell bridge surface mismatch") },
    });
  });

  it("rejects an arbitrary extra capability", async () => {
    expect(await report([...authorizedKeys, "arbitraryIpc"].sort())).toMatchObject({
      ok: false, error: { message: expect.stringContaining("shell bridge surface mismatch") },
    });
  });
});

describe("native preload bridge surface", () => {
  // Runs the real preload script with a stub Electron in a vm context and
  // captures exactly what it puts on the page global. This is the surface the
  // smoke probe compares against, so deriving it here (instead of restating it)
  // is what keeps `SHELL_BRIDGE_SURFACE` honest.
  function exposedByPreload(source = readFileSync(new URL("../preload/preload.cjs", import.meta.url), "utf8")): { name: string; bridge: Record<string, unknown> } {
    const exposures: { name: string; bridge: Record<string, unknown> }[] = [];
    const context = createContext({
      require: (specifier: string) => {
        if (specifier !== "electron") throw new Error(`unexpected preload require: ${specifier}`);
        return {
          contextBridge: {
            exposeInMainWorld: (name: string, bridge: Record<string, unknown>) => exposures.push({ name, bridge }),
          },
          ipcRenderer: { invoke: async () => ({ ok: true }), on: () => {}, removeListener: () => {} },
        };
      },
      process: { sandboxed: true, contextIsolated: true },
    });
    runInContext(source, context, { filename: "preload.cjs" });
    expect(exposures).toHaveLength(1);
    return exposures[0]!;
  }

  it("exposes exactly the smoke contract's keys, derived from preload.cjs itself", () => {
    const { name, bridge } = exposedByPreload();
    expect(name).toBe("pidock");
    for (const key of Object.keys(bridge)) expect(typeof bridge[key]).toBe("function");
    expect(Object.keys(bridge).sort()).toEqual([...SHELL_BRIDGE_SURFACE]);
  });

  it("would catch the preload surface drifting from the smoke contract", () => {
    // MUTATION CHECK: the assertion above is only a pin if the derivation reads
    // the file. Renaming one bridge entry in the source must change the derived
    // key set, so a future preload edit cannot pass unnoticed.
    const source = readFileSync(new URL("../preload/preload.cjs", import.meta.url), "utf8");
    const forked = source.replace("  appendTaskRepos: function", "  appendTaskReposRenamed: function");
    expect(forked).not.toBe(source);
    const keys = Object.keys(exposedByPreload(forked).bridge).sort();
    expect(keys).toContain("appendTaskReposRenamed");
    expect(keys).not.toEqual([...SHELL_BRIDGE_SURFACE]);
  });
});
