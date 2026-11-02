/**
 * Seam: [#117 第 5 项] browser state is main's persistent partition, so main —
 * not the page — decides what the lifecycle ops learn about it.
 *
 * Before this slice the Host answered with an always-empty page probe and an
 * always-failing removal stub, so 「清理完成」 could be shown while browser
 * data was still on disk. These tests pin the two halves that make the new
 * wiring trustworthy:
 *
 * 1. `observeTaskBrowserState` reports `true`/`false` only from a real
 *    partition path, and `null` (never `false`) when it cannot read one.
 * 2. On the REAL `shell/taskOp` handler, a page-supplied `browserState` is
 *    overwritten by main's observation — a page cannot hide browser data from
 *    the cleanup scope it is asking for, and cannot claim retention either.
 *
 * The Host delegate is in-process (as the other route tests do), so this is
 * real-handler + real-rule evidence, not Electron-IPC evidence.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ nextId: 1, userData: "", partitionPath: "" }));
vi.mock("electron", () => ({
  app: { getPath: () => state.userData },
  session: {
    fromPartition: (partition: string) => ({
      partition,
      getStoragePath: () => state.partitionPath,
    }),
  },
  WebContentsView: class {
    webContents = {
      id: state.nextId++,
      mainFrame: { processId: 1, routingId: 1 },
      once: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(async () => {}),
      loadFile: vi.fn(async () => {}),
      getURL: () => "about:blank",
      isDestroyed: () => false,
      close: vi.fn(),
    };
    setBounds() {}
    getBounds() { return { x: 0, y: 0, width: 1, height: 1 }; }
    setVisible() {}
    getVisible() { return true; }
  },
  BrowserWindow: class {
    id = state.nextId++;
    contentView = {
      children: [] as unknown[],
      addChildView: (view: unknown) => { this.contentView.children.push(view); },
      removeChildView: () => {},
    };
    private listeners = new Map<string, () => void>();
    getContentBounds() { return { width: 1440, height: 900 }; }
    on(event: string, listener: () => void) { this.listeners.set(event, listener); }
    once(event: string, listener: () => void) { this.listeners.set(event, listener); }
    isVisible() { return true; }
  },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn(), eventNames: () => [] },
  utilityProcess: { fork: vi.fn() },
}));

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ipcMain } from "electron";
import { validateHostTaskOp } from "../host/host-guards.js";
import { observeTaskBrowserState } from "./task-browser-observation.js";
import { createTrustedWindow, registerIpc } from "./runtime.js";
import { ProjectRegistry } from "./project-registry.js";
import { TaskRootIndex } from "./task-root-index.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  state.userData = "";
  state.partitionPath = "";
});

describe("[#117 第 5 项] observing the browser partition", () => {
  const deps = (path: string | null, exists = true) => ({
    storagePathFor: () => path,
    exists: () => exists,
  });

  it("reports retention from the partition path main can read", () => {
    expect(observeTaskBrowserState({ workspaceId: "w", taskId: "task-a" }, deps("/profile/Partitions/x"))).toEqual({ retained: true });
    expect(observeTaskBrowserState({ workspaceId: "w", taskId: "task-a" }, deps("/profile/Partitions/x", false))).toEqual({ retained: false });
  });

  it("reports 'not observed' — never 'nothing retained' — when the path is unreadable", () => {
    expect(observeTaskBrowserState({ workspaceId: "w", taskId: "task-a" }, deps(null))).toEqual({ retained: null });
    expect(
      observeTaskBrowserState({ workspaceId: "w", taskId: "task-a" }, {
        storagePathFor: () => { throw new Error("session unavailable"); },
        exists: () => true,
      }),
    ).toEqual({ retained: null });
    expect(
      observeTaskBrowserState({ workspaceId: "w", taskId: "task-a" }, {
        storagePathFor: () => "/profile/Partitions/x",
        exists: () => { throw new Error("stat failed"); },
      }),
    ).toEqual({ retained: null });
  });

  it("refuses an empty task id instead of observing some other task's partition", () => {
    expect(() => observeTaskBrowserState({ workspaceId: "w", taskId: "  " }, deps("/p"))).toThrow(/invalid-browser-observation/);
  });
});

type Envelope = { ok: boolean; payload?: unknown; error?: string };

async function productionRoute() {
  const home = mkdtempSync(join(tmpdir(), "pidock-browser-state-"));
  homes.push(home);
  const userData = join(home, "userData");
  mkdirSync(userData, { recursive: true });
  state.userData = userData;
  const partitionPath = join(userData, "Partitions", "task-a");
  mkdirSync(partitionPath, { recursive: true });
  writeFileSync(join(partitionPath, "marker"), "persisted\n");
  state.partitionPath = partitionPath;

  const forwarded: { op: string; payload: Record<string, unknown> }[] = [];
  const routeTaskOp = vi.fn(async (params: { taskId: string; op: string; payload?: Record<string, unknown> }) => {
    forwarded.push({ op: params.op, payload: params.payload ?? {} });
    const guard = validateHostTaskOp(params.op, params.payload ?? {});
    if (!guard.ok) throw new Error(guard.error);
    return { workspaceId: "workspace-browser-state", taskId: params.taskId, op: params.op, payload: { ok: true } };
  });
  const views = await createTrustedWindow("workspace-browser-state", "production");
  registerIpc(
    {} as never,
    views.registry,
    { routeTaskOp } as never,
    new ProjectRegistry(userData),
    new TaskRootIndex(userData, join(home, "tasks")),
  );
  const handler = vi.mocked(ipcMain.handle).mock.calls
    .findLast(([name]) => name === "shell/taskOp")?.[1] as unknown as (event: unknown, payload: unknown) => Promise<Envelope>;
  const shell = { sender: views.shellView.webContents, senderFrame: views.shellView.webContents.mainFrame };
  return {
    forwarded,
    taskOp: (taskId: string, op: string, payload: Record<string, unknown>) => handler(shell, { taskId, op, payload }),
  };
}

describe("[#117 第 5 项] main stamps browser state on the lifecycle route", () => {
  it("overwrites a page-supplied observation with main's own", async () => {
    const route = await productionRoute();
    expect(await route.taskOp("task-a", "task/cleanupPreview", {
      selection: { exportSessions: false, exportDrafts: false, exportUsage: false },
      browserState: { retained: false },
    })).toMatchObject({ ok: true });
    expect(route.forwarded.at(-1)?.payload["browserState"]).toEqual({ retained: true });
  });

  it("stamps archive and cleanup runs too, so the receipt is written from the same observation", async () => {
    const route = await productionRoute();
    await route.taskOp("task-a", "task/archive", { label: "用户", browserState: { retained: null } });
    expect(route.forwarded.at(-1)?.payload["browserState"]).toEqual({ retained: true });
    await route.taskOp("task-a", "task/runCleanup", {
      label: "用户",
      selection: { exportSessions: false, exportDrafts: false, exportUsage: false },
    });
    expect(route.forwarded.at(-1)?.payload["browserState"]).toEqual({ retained: true });
  });

  it("reports 'not observed' when Electron cannot name the partition path", async () => {
    const route = await productionRoute();
    state.partitionPath = "";
    await route.taskOp("task-a", "task/cleanupPreview", {
      selection: { exportSessions: false, exportDrafts: false, exportUsage: false },
    });
    expect(route.forwarded.at(-1)?.payload["browserState"]).toEqual({ retained: null });
  });
});
