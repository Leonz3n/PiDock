import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ nextId: 1, userData: "" }));
vi.mock("electron", () => ({
  app: { getPath: (name: string) => (name === "userData" ? state.userData : state.userData) },
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

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ipcMain } from "electron";
import { validateHostTaskOp } from "../host/host-guards.js";
import { TaskWorkspaceHost, diskTaskStore } from "../host/task-host.js";
import { buildTaskDiskRecord } from "../host/task-store.js";
import { protectApplicationProfile } from "../host/protected-application-path.js";
import { TaskWorkspaceFiles } from "../host/workspace-files.js";
import { openExternalEditor } from "../host/open-editor.js";
import { externalEditorSettingsPath } from "./external-editor.js";
import { ProjectRegistry } from "./project-registry.js";
import { createTrustedWindow, registerIpc } from "./runtime.js";
import { TaskRootIndex } from "./task-root-index.js";

// Seam: [PiDock 10] (#15 box 28) route integrity for the external editor
// through the REAL registered handlers. `shell/taskOp` is the renderer's
// generic op route; `shell/openTaskEditor` is the dedicated attested entry.
// Main must refuse the op on the generic route by name, accept nothing but
// `taskId` + `rootId` on the dedicated entry, read the editor program from its
// own settings document, and hand the Host exactly that program.
//
// The in-process delegate stands in for the utilityProcess Host (as the #6
// route tests do), so this is real-handler + real-rule + real-child evidence,
// not Electron-IPC evidence. The throwaway editor records its own argv/cwd.

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  delete process.env["EDITOR_EVIDENCE"];
  state.userData = "";
});

const REPO_DIR = "repo-aaaaaaaa";
const LINK_NAME = "dir-22222222";
const TASK_ID = "task-abcdef12";

interface Route {
  home: string;
  taskId: string;
  taskDir: string;
  worktreePath: string;
  linkPath: string;
  sharedSourcePath: string;
  userData: string;
  shimPath: string;
  evidencePath: string;
  forwarded: { op: string; payload: Record<string, unknown>; origin: unknown }[];
  openEditor: (payload: Record<string, unknown>) => Promise<{ ok: boolean; payload?: unknown; error?: string }>;
  taskOp: (op: string, payload: Record<string, unknown>) => Promise<{ ok: boolean; payload?: unknown; error?: string }>;
  chooseEditor: (settings: unknown) => void;
  snapshot: () => string[];
}

function recordSubtree(dir: string): string[] {
  const lines: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      const key = relative(dir, full);
      if (entry.isSymbolicLink()) {
        // The plain-directory link is a symlink: record its target, never follow it.
        lines.push(`${key}->${execFileSync("readlink", [full], { encoding: "utf8" }).trim()}`);
        continue;
      }
      if (entry.isDirectory()) {
        lines.push(`${key}/`);
        walk(full);
        continue;
      }
      lines.push(`${key}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  };
  walk(dir);
  return lines;
}

async function productionRoute(): Promise<Route> {
  const home = mkdtempSync(join(tmpdir(), "pidock-editor-route-"));
  homes.push(home);
  const taskRoot = join(home, "tasks");
  const taskDir = join(taskRoot, TASK_ID);
  const userData = join(home, "userData");
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(userData, { recursive: true });
  state.userData = userData;
  // In-task roots are spelled the way the product spells them: `joinRoot`
  // appends the root name after a FORWARD slash on every platform (the same
  // fixture correction #56 made in open-editor.test.ts). Windows accepts both
  // separators, so the fixture still creates and expects the product's string.
  const worktreePath = `${taskDir}/${REPO_DIR}`;
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(join(worktreePath, "app.ts"), "export const app = 1;\n");
  const sharedSourcePath = join(home, "shared-assets");
  mkdirSync(sharedSourcePath, { recursive: true });
  writeFileSync(join(sharedSourcePath, "original.txt"), "original\n");
  const linkPath = `${taskDir}/${LINK_NAME}`;
  // win32: a plain directory symlink needs SeCreateSymbolicLinkPrivilege; a junction is the directory link this platform can create without it (#57).
  symlinkSync(sharedSourcePath, linkPath, process.platform === "win32" ? "junction" : "dir");
  diskTaskStore.writeTask(
    taskDir,
    buildTaskDiskRecord({
      taskId: TASK_ID,
      name: "编辑器任务",
      dirId: TASK_ID,
      branch: `task/${TASK_ID}`,
      root: taskRoot,
      taskDir,
      remoteBranch: "main",
      baseCommit: "0123456789abcdef0123456789abcdef01234567",
      repos: [REPO_DIR],
      repoSources: [{ repoDir: REPO_DIR, remote: "origin", remoteBranch: "main", baseCommit: "0123456789abcdef0123456789abcdef01234567" }],
      dirLinks: [{ linkName: LINK_NAME, directoryId: "22222222-0000-4000-8000-000000000001", sourcePath: sharedSourcePath, snapshotAt: "2026-09-24T10:00:00.000Z" }],
      now: "2026-09-24T10:00:00.000Z",
    }),
  );
  const shimPath = join(home, "fake-editor.cjs");
  const evidencePath = join(home, "editor-evidence.json");
  writeFileSync(
    shimPath,
    [
      'const fs = require("node:fs");',
      "fs.writeFileSync(process.env.EDITOR_EVIDENCE, JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd(), pid: process.pid }));",
      "",
    ].join("\n"),
  );
  process.env["EDITOR_EVIDENCE"] = evidencePath;

  const projects = new ProjectRegistry(userData);
  const roots = new TaskRootIndex(userData, taskRoot);
  const filesFor = () => new TaskWorkspaceFiles(TASK_ID, taskDir, diskTaskStore, undefined, () => [], protectApplicationProfile(userData));
  const forwarded: { op: string; payload: Record<string, unknown>; origin: unknown }[] = [];
  const routeTaskOp = vi.fn(async (params: { taskId: string; op: string; payload?: Record<string, unknown>; origin?: unknown }) => {
    forwarded.push({ op: params.op, payload: params.payload ?? {}, origin: params.origin });
    // Same per-op guard main's `routeTaskOp` and the Host dispatch run.
    const guard = validateHostTaskOp(params.op, params.payload ?? {});
    if (!guard.ok) throw new Error(guard.error);
    if (params.op === "task/fileRoots") {
      const record = diskTaskStore.readTask(taskDir);
      void record;
      return { workspaceId: "workspace-editor-route", taskId: params.taskId, op: params.op, payload: { roots: filesFor().roots(), taskDir } };
    }
    if (params.op === "task/openEditor") {
      const opened = await openExternalEditor({ files: filesFor(), payload: params.payload ?? {}, origin: params.origin as never });
      if (!opened.ok) throw new Error(opened.error);
      return { workspaceId: "workspace-editor-route", taskId: params.taskId, op: params.op, payload: { launch: opened.launch } };
    }
    throw new Error(`unexpected op ${params.op}`);
  });
  // A real in-process task record the Host would own, so the delegate path is
  // exercised with the same store the file panel reads.
  void new TaskWorkspaceHost(TASK_ID, taskDir, diskTaskStore, () => "2026-09-24T11:00:00.000Z");

  const views = await createTrustedWindow("workspace-editor-route", "production");
  registerIpc({} as never, views.registry, { routeTaskOp } as never, projects, roots);
  const handlers = vi.mocked(ipcMain.handle).mock.calls;
  const openEditorHandler = handlers.findLast(([channel]) => channel === "shell/openTaskEditor")?.[1] as unknown as (
    event: unknown,
    payload: unknown,
  ) => Promise<{ ok: boolean; payload?: unknown; error?: string }>;
  const taskOpHandler = handlers.findLast(([channel]) => channel === "shell/taskOp")?.[1] as unknown as (
    event: unknown,
    payload: unknown,
  ) => Promise<{ ok: boolean; payload?: unknown; error?: string }>;
  const shell = { sender: views.shellView.webContents, senderFrame: views.shellView.webContents.mainFrame };
  return {
    home,
    taskId: TASK_ID,
    taskDir,
    worktreePath,
    linkPath,
    sharedSourcePath,
    userData,
    shimPath,
    evidencePath,
    forwarded,
    openEditor: (payload) => openEditorHandler(shell, payload),
    taskOp: (op, payload) => taskOpHandler(shell, { taskId: TASK_ID, op, payload }),
    chooseEditor: (settings) => writeFileSync(externalEditorSettingsPath(userData), typeof settings === "string" ? settings : JSON.stringify(settings)),
    snapshot: () => recordSubtree(taskDir),
  };
}

/** The launch receipt the Host envelope carries, for one editor entry call. */
function launchOf(result: { ok: boolean; payload?: unknown; error?: string }): Record<string, unknown> {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  const host = result.payload as { payload?: { launch?: Record<string, unknown> } };
  const launch = host.payload?.launch;
  expect(launch).toBeDefined();
  return launch as Record<string, unknown>;
}

function recorded(evidencePath: string): { argv: string[]; cwd: string; pid: number } {
  return JSON.parse(readFileSync(evidencePath, "utf8")) as { argv: string[]; cwd: string; pid: number };
}

describe("#15 box 28 external editor through the real shell handlers", () => {
  it("refuses task/openEditor on the renderer's generic shell/taskOp route and never reaches the Host", async () => {
    const route = await productionRoute();
    route.chooseEditor({ program: process.execPath, args: [route.shimPath] });
    const before = route.snapshot();

    const result = await route.taskOp("task/openEditor", {
      rootId: REPO_DIR,
      // Everything here is a page-supplied lie: a program and args that must
      // never be used, because this route is not the editor entry at all.
      editor: { program: "/bin/sh", args: ["-c", "touch PWNED"] },
      program: "/bin/sh",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("shell/openTaskEditor");
    // The Host was never asked and nothing ran: the refusal is by name, not a
    // silently-ignored field.
    expect(route.forwarded).toEqual([]);
    expect(existsSync(route.evidencePath)).toBe(false);
    expect(route.snapshot()).toEqual(before);
  });

  it("accepts only taskId + rootId on the attested editor entry, so a page cannot name the program", async () => {
    const route = await productionRoute();
    route.chooseEditor({ program: process.execPath, args: [route.shimPath] });
    const before = route.snapshot();

    for (const payload of [
      { taskId: TASK_ID, rootId: REPO_DIR, program: process.execPath },
      { taskId: TASK_ID, rootId: REPO_DIR, args: [route.shimPath] },
      { taskId: TASK_ID, rootId: REPO_DIR, editor: { program: "/bin/sh", args: ["-c", "touch PWNED"] } },
      { taskId: TASK_ID, rootId: REPO_DIR, path: "/etc" },
    ]) {
      const result = await route.openEditor(payload);
      expect(result.ok, JSON.stringify(payload)).toBe(false);
      expect(result.error).toContain("只接受 taskId 与 rootId");
    }
    // Nothing was spawned for any forged program, and the workspace is intact.
    expect(route.forwarded).toEqual([]);
    expect(existsSync(route.evidencePath)).toBe(false);
    expect(route.snapshot()).toEqual(before);
  });

  it("launches the user-configured program at the root the file panel resolves, leaving the workspace byte-identical", async () => {
    const route = await productionRoute();
    route.chooseEditor({ program: process.execPath, args: [route.shimPath] });
    const before = route.snapshot();

    // The roots the file panel shows, read through the same real handler path.
    const roots = (await route.taskOp("task/fileRoots", {})) as { ok: boolean; payload?: { payload?: { roots: { id: string; path: string; kind: string }[] } } };
    const shown = roots.payload?.payload?.roots.find((root) => root.id === REPO_DIR);
    expect(shown?.path).toBe(route.worktreePath);

    const result = await route.openEditor({ taskId: TASK_ID, rootId: REPO_DIR });
    const launch = launchOf(result);

    // The program on the Host envelope is main's own settings value, and the
    // payload carries no renderer-supplied program anywhere.
    expect(route.forwarded.map((entry) => entry.op)).toEqual(["task/fileRoots", "task/openEditor"]);
    const sent = route.forwarded[1]!;
    expect(sent.payload).toEqual({ rootId: REPO_DIR, editor: { program: process.execPath, args: [route.shimPath] } });
    expect(Object.keys(sent.payload)).toEqual(["rootId", "editor"]);
    // Main stamped the human attestation itself.
    expect(sent.origin).toEqual({ kind: "shell-ui", senderWebContentsId: expect.any(Number) });

    // The launch opened the same root the file panel resolved.
    expect(launch["openedPath"]).toBe(shown?.path);
    expect(launch["cwd"]).toBe(route.worktreePath);
    expect(launch["args"]).toEqual([route.shimPath, route.worktreePath]);
    expect(launch["actor"]).toBe("human");
    expect(launch["rootKind"]).toBe("worktree");
    expect(String(launch["note"])).toContain("编辑器配置");

    await vi.waitFor(() => expect(existsSync(route.evidencePath)).toBe(true), { timeout: 10_000 });
    const observed = recorded(route.evidencePath);
    expect(observed.argv).toEqual([route.shimPath, route.worktreePath]);
    expect(observed.cwd).toBe(realpathSync(route.worktreePath));

    // 盒子 28: no editor configuration was copied or generated, and the task
    // folder is byte-identical (this assertion fails if a launch writes one).
    expect(route.snapshot()).toEqual(before);
    expect(existsSync(join(route.worktreePath, ".vscode"))).toBe(false);
    expect(existsSync(join(route.taskDir, ".vscode"))).toBe(false);
    expect(existsSync(join(route.worktreePath, "PWNED"))).toBe(false);
  });

  it("opens a plain-directory link at the original target, keeping the shared-directory disclosure", async () => {
    const route = await productionRoute();
    route.chooseEditor({ program: process.execPath, args: [route.shimPath] });
    const before = route.snapshot();

    const result = await route.openEditor({ taskId: TASK_ID, rootId: LINK_NAME });
    const launch = launchOf(result);
    expect(launch["openedPath"]).toBe(route.sharedSourcePath);
    expect(launch["rootKind"]).toBe("shared-dir");
    expect(String(launch["disclosure"])).toContain("修改影响原文件");
    expect(String(launch["disclosure"])).toContain(route.linkPath);

    await vi.waitFor(() => expect(existsSync(route.evidencePath)).toBe(true), { timeout: 10_000 });
    expect(recorded(route.evidencePath).argv).toEqual([route.shimPath, route.sharedSourcePath]);
    expect(route.snapshot()).toEqual(before);
  });

  it("refuses an unconfigured or malformed editor setting by name, spawning nothing", async () => {
    const route = await productionRoute();
    const before = route.snapshot();

    const unconfigured = await route.openEditor({ taskId: TASK_ID, rootId: REPO_DIR });
    expect(unconfigured.ok).toBe(false);
    expect(unconfigured.error).toContain("editor-not-configured");
    // Actionable: the refusal names the settings document to configure.
    expect(unconfigured.error).toContain(externalEditorSettingsPath(route.userData));

    route.chooseEditor("{ not json");
    const malformed = await route.openEditor({ taskId: TASK_ID, rootId: REPO_DIR });
    expect(malformed.ok).toBe(false);
    expect(malformed.error).toContain("editor-settings-invalid");

    route.chooseEditor({ program: process.execPath, args: [route.shimPath], extra: true });
    const unknownKey = await route.openEditor({ taskId: TASK_ID, rootId: REPO_DIR });
    expect(unknownKey.ok).toBe(false);
    expect(unknownKey.error).toContain("editor-settings-invalid");

    expect(route.forwarded).toEqual([]);
    expect(existsSync(route.evidencePath)).toBe(false);
    expect(route.snapshot()).toEqual(before);
  });

  it("refuses an unknown root by name through the Host's own root resolution", async () => {
    const route = await productionRoute();
    route.chooseEditor({ program: process.execPath, args: [route.shimPath] });
    const result = await route.openEditor({ taskId: TASK_ID, rootId: "repo-ffffffff" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown-root");
    expect(existsSync(route.evidencePath)).toBe(false);
  });

  it("refuses a structurally invalid editor payload at the envelope, not at the spawn", async () => {
    // The guard is the same one main's routeTaskOp and the Host dispatch run.
    for (const payload of [
      { rootId: REPO_DIR, editor: { program: "", args: [] } },
      { rootId: REPO_DIR, editor: { program: process.execPath, args: [1] } },
      { rootId: REPO_DIR, editor: { program: process.execPath, unknown: true } },
      { rootId: "", editor: { program: process.execPath } },
      { rootId: REPO_DIR, editor: { program: process.execPath }, sessionId: "s1" },
    ]) {
      const guard = validateHostTaskOp("task/openEditor", payload);
      expect(guard.ok, JSON.stringify(payload)).toBe(false);
    }
    expect(validateHostTaskOp("task/openEditor", { rootId: REPO_DIR, editor: { program: process.execPath } }).ok).toBe(true);
  });
});
