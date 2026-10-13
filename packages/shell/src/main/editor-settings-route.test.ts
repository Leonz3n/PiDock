/**
 * Seam: [PiDock 10] (#15 box 28) 外部编辑器设置 through the REAL registered
 * handlers, with a REAL child process.
 *
 * The gap this slice closes: the launch read `external-editor.json` from this
 * application's machine-private profile, but nothing in the app could write it,
 * so every 「用外部编辑器打开」 press returned `editor-not-configured` until a
 * user hand-edited that app-private file. These tests save through the real
 * `shell/editorSettingsOp` handler (never by writing the file directly), then
 * launch through the real `shell/openTaskEditor` handler and assert what the
 * child itself recorded — and clear the setting again to prove the honest
 * refusal comes back and nothing is spawned.
 *
 * Route integrity is pinned here too: the write is NOT a task op (it never
 * travels on the renderer-reachable `shell/taskOp`), a task-domain sender is
 * refused, and the save never reaches the Host as a task op at all.
 *
 * The configured "editor" is a throwaway Node script that records its own argv
 * and cwd; the user's real editor is never started.
 */

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

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ipcMain } from "electron";
import { validateHostTaskOp } from "../host/host-guards.js";
import { TaskWorkspaceHost, diskTaskStore } from "../host/task-host.js";
import { buildTaskDiskRecord } from "../host/task-store.js";
import { protectApplicationProfile } from "../host/protected-application-path.js";
import { TaskWorkspaceFiles } from "../host/workspace-files.js";
import { openExternalEditor } from "../host/open-editor.js";
import { isHostTaskOp } from "../rpc/protocol.js";
import { externalEditorSettingsPath, loadExternalEditorSettings } from "./external-editor.js";
import { ProjectRegistry } from "./project-registry.js";
import { createTrustedWindow, registerIpc } from "./runtime.js";
import { TaskRootIndex } from "./task-root-index.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  delete process.env["EDITOR_EVIDENCE"];
  state.userData = "";
});

const REPO_DIR = "repo-aaaaaaaa";
const TASK_ID = "task-abcdef12";
const NODE = process.execPath;

function recordSubtree(dir: string): string[] {
  const lines: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      const key = relative(dir, full);
      if (entry.isSymbolicLink()) {
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

type Envelope = { ok: boolean; payload?: unknown; error?: string };

interface Route {
  home: string;
  taskId: string;
  taskDir: string;
  worktreePath: string;
  userData: string;
  shimPath: string;
  evidencePath: string;
  notExecutablePath: string;
  bundlePath: string;
  forwarded: { op: string; payload: Record<string, unknown>; origin: unknown }[];
  settings: (request: Record<string, unknown>, sender?: Sender) => Promise<Envelope>;
  openEditor: (payload: Record<string, unknown>) => Promise<Envelope>;
  taskOp: (op: string, payload: Record<string, unknown>) => Promise<Envelope>;
  document: () => string | null;
  snapshot: () => string[];
  /** Binds a WebContents id in the TASK trust domain, for the refusal probe. */
  registerTaskSender: (webContentsId: number) => void;
}

interface Sender {
  sender: { id: number; mainFrame: { processId: number; routingId: number } };
  senderFrame: { processId: number; routingId: number } | null;
}

async function productionRoute(): Promise<Route> {
  const home = mkdtempSync(join(tmpdir(), "pidock-editor-settings-route-"));
  homes.push(home);
  const taskRoot = join(home, "tasks");
  const taskDir = join(taskRoot, TASK_ID);
  const userData = join(home, "userData");
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(userData, { recursive: true });
  state.userData = userData;
  // The reported root is the product's own spelling: `task/fileRoots`
  // (`joinRoot`, `main/workspace-files.ts`) keeps the native taskDir and appends
  // the repo dir with `/`, so the launch arg compared against is this mixed form.
  const worktreePath = `${taskDir}/${REPO_DIR}`;
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(join(worktreePath, "app.ts"), "export const app = 1;\n");
  diskTaskStore.writeTask(
    taskDir,
    buildTaskDiskRecord({
      taskId: TASK_ID,
      name: "编辑器设置任务",
      dirId: TASK_ID,
      branch: `task/${TASK_ID}`,
      root: taskRoot,
      taskDir,
      remoteBranch: "main",
      baseCommit: "0123456789abcdef0123456789abcdef01234567",
      repos: [REPO_DIR],
      repoSources: [{ repoDir: REPO_DIR, remote: "origin", remoteBranch: "main", baseCommit: "0123456789abcdef0123456789abcdef01234567" }],
      dirLinks: [],
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
  const notExecutablePath = join(home, "not-executable.txt");
  writeFileSync(notExecutablePath, "no\n");
  const bundlePath = join(home, "Fake Editor.app");
  mkdirSync(bundlePath, { recursive: true });

  const projects = new ProjectRegistry(userData);
  const roots = new TaskRootIndex(userData, taskRoot);
  const filesFor = () => new TaskWorkspaceFiles(TASK_ID, taskDir, diskTaskStore, undefined, () => [], protectApplicationProfile(userData));
  const forwarded: { op: string; payload: Record<string, unknown>; origin: unknown }[] = [];
  const routeTaskOp = vi.fn(async (params: { taskId: string; op: string; payload?: Record<string, unknown>; origin?: unknown }) => {
    forwarded.push({ op: params.op, payload: params.payload ?? {}, origin: params.origin });
    const guard = validateHostTaskOp(params.op, params.payload ?? {});
    if (!guard.ok) throw new Error(guard.error);
    if (params.op === "task/fileRoots") {
      return { workspaceId: "workspace-editor-settings", taskId: params.taskId, op: params.op, payload: { roots: filesFor().roots(), taskDir } };
    }
    if (params.op === "task/openEditor") {
      const opened = await openExternalEditor({ files: filesFor(), payload: params.payload ?? {}, origin: params.origin as never });
      if (!opened.ok) throw new Error(opened.error);
      return { workspaceId: "workspace-editor-settings", taskId: params.taskId, op: params.op, payload: { launch: opened.launch } };
    }
    throw new Error(`unexpected op ${params.op}`);
  });
  void new TaskWorkspaceHost(TASK_ID, taskDir, diskTaskStore, () => "2026-09-24T11:00:00.000Z");

  const views = await createTrustedWindow("workspace-editor-settings", "production");
  registerIpc({} as never, views.registry, { routeTaskOp } as never, projects, roots);
  const handlers = vi.mocked(ipcMain.handle).mock.calls;
  const handlerFor = (channel: string) =>
    handlers.findLast(([name]) => name === channel)?.[1] as unknown as (event: unknown, payload: unknown) => Promise<Envelope>;
  const settingsHandler = handlerFor("shell/editorSettingsOp");
  const openEditorHandler = handlerFor("shell/openTaskEditor");
  const taskOpHandler = handlerFor("shell/taskOp");
  const shell: Sender = { sender: views.shellView.webContents, senderFrame: views.shellView.webContents.mainFrame };
  return {
    home,
    taskId: TASK_ID,
    taskDir,
    worktreePath,
    userData,
    shimPath,
    evidencePath,
    notExecutablePath,
    bundlePath,
    forwarded,
    settings: (request, sender = shell) => settingsHandler(sender, request),
    openEditor: (payload) => openEditorHandler(shell, payload),
    taskOp: (op, payload) => taskOpHandler(shell, { taskId: TASK_ID, op, payload }),
    document: () => (existsSync(externalEditorSettingsPath(userData)) ? readFileSync(externalEditorSettingsPath(userData), "utf8") : null),
    snapshot: () => recordSubtree(taskDir),
    registerTaskSender: (webContentsId) => views.registry.registerTask({
      webContentsId,
      viewId: "task-view",
      workspaceId: "workspace-editor-settings",
      taskId: TASK_ID,
      pageId: "page-1",
    }),
  };
}

function launchOf(result: Envelope): Record<string, unknown> {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  const host = result.payload as { payload?: { launch?: Record<string, unknown> } };
  const launch = host.payload?.launch;
  expect(launch).toBeDefined();
  return launch as Record<string, unknown>;
}

function recorded(evidencePath: string): { argv: string[]; cwd: string; pid: number } {
  return JSON.parse(readFileSync(evidencePath, "utf8")) as { argv: string[]; cwd: string; pid: number };
}

describe("#15 box 28 the editor setting is reachable through the app's own save path", () => {
  it("saves through the real handler, then launches a REAL child that recorded the configured argv/cwd", async () => {
    const route = await productionRoute();
    const before = route.snapshot();

    // The round trip a user performs: save in 本机设置, then open from the panel.
    const saved = await route.settings({ op: "save", program: NODE, args: [route.shimPath, "--flag"] });
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
    expect(saved.payload).toEqual({ program: NODE, args: [route.shimPath, "--flag"], settingsPath: externalEditorSettingsPath(route.userData) });

    // Persistence: the launch's own loader sees exactly what was saved, and a
    // fresh process would too (the document on disk is the only carrier).
    const loaded = loadExternalEditorSettings(route.userData);
    expect(loaded.ok && loaded.settings).toEqual({ program: NODE, args: [route.shimPath, "--flag"] });
    expect(JSON.parse(route.document() as string)).toEqual({ program: NODE, args: [route.shimPath, "--flag"] });

    const result = await route.openEditor({ taskId: TASK_ID, rootId: REPO_DIR });
    const launch = launchOf(result);
    expect(launch["program"]).toBe(NODE);
    expect(launch["args"]).toEqual([route.shimPath, "--flag", route.worktreePath]);
    expect(launch["actor"]).toBe("human");

    // The real child recorded its own argv/cwd: the saved program ran with the
    // fixed argv and the workspace path as ONE argument.
    await vi.waitFor(() => expect(existsSync(route.evidencePath)).toBe(true), { timeout: 10_000 });
    const observed = recorded(route.evidencePath);
    expect(observed.argv).toEqual([route.shimPath, "--flag", route.worktreePath]);
    expect(observed.cwd).toBe(realpathSync(route.worktreePath));
    expect(observed.pid).toBe(launch["pid"]);

    // 盒子 28: nothing was copied into the task folder.
    expect(route.snapshot()).toEqual(before);
    expect(existsSync(join(route.worktreePath, ".vscode"))).toBe(false);
  });

  it("clears the setting through the real handler, and the launch returns the named refusal without spawning", async () => {
    const route = await productionRoute();
    await route.settings({ op: "save", program: NODE, args: [route.shimPath] });
    const before = route.snapshot();
    const forwardedBefore = route.forwarded.length;

    const cleared = await route.settings({ op: "clear" });
    expect(cleared.ok).toBe(true);
    expect(cleared.payload).toEqual({ program: null, args: [], settingsPath: externalEditorSettingsPath(route.userData) });
    expect(route.document()).toBeNull();

    const result = await route.openEditor({ taskId: TASK_ID, rootId: REPO_DIR });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("editor-not-configured");
    // Actionable: it names the document the save path writes.
    expect(result.error).toContain(externalEditorSettingsPath(route.userData));
    // Nothing was spawned and the Host was never asked.
    expect(existsSync(route.evidencePath)).toBe(false);
    expect(route.forwarded.length).toBe(forwardedBefore);
    expect(route.snapshot()).toEqual(before);
  });

  it("refuses an invalid program by name and keeps launching the previously valid setting", async () => {
    const route = await productionRoute();
    await route.settings({ op: "save", program: NODE, args: [route.shimPath] });
    const savedDocument = route.document();

    const cases: { request: Record<string, unknown>; name: string }[] = [
      { request: { op: "save", program: "vim" }, name: "editor-program-invalid" },
      { request: { op: "save", program: "/usr/../etc/passwd" }, name: "editor-program-invalid" },
      { request: { op: "save", program: route.notExecutablePath }, name: "editor-program-not-executable" },
      { request: { op: "save", program: route.bundlePath }, name: "editor-program-not-executable" },
      { request: { op: "save", program: join(route.home, "no-such-editor") }, name: "editor-program-not-found" },
      { request: { op: "save", program: NODE, args: [1] }, name: "editor-settings-invalid" },
    ];
    for (const entry of cases) {
      const refused = await route.settings(entry.request);
      expect(refused.ok, JSON.stringify(entry.request)).toBe(false);
      expect(refused.error, JSON.stringify(entry.request)).toContain(entry.name);
      // Fail-closed: the refused save changed nothing on disk.
      expect(route.document(), JSON.stringify(entry.request)).toBe(savedDocument);
    }

    // The still-valid setting is what launches, proven by the child's own argv.
    rmSync(route.evidencePath, { force: true });
    launchOf(await route.openEditor({ taskId: TASK_ID, rootId: REPO_DIR }));
    await vi.waitFor(() => expect(existsSync(route.evidencePath)).toBe(true), { timeout: 10_000 });
    expect(recorded(route.evidencePath).argv).toEqual([route.shimPath, route.worktreePath]);
  });

  it("is a main-side settings write: the save never becomes a Host task op, and no task op carries it", async () => {
    const route = await productionRoute();
    // MUTATION CHECK: if the save ever became part of the renderer-reachable
    // task-op set (HOST_TASK_OPS), `isHostTaskOp` would accept a settings op and
    // the `shell/taskOp` write below would stop being refused as unknown.
    expect(isHostTaskOp("task/editorSettings")).toBe(false);
    expect(isHostTaskOp("task/openEditor")).toBe(true);

    const saved = await route.settings({ op: "save", program: NODE });
    expect(saved.ok).toBe(true);
    // The write is main's own settings document: no Host op was involved.
    expect(route.forwarded).toEqual([]);

    // A page cannot write the program through the generic route: the op name
    // does not exist there, so a page-chosen program never reaches a write.
    for (const op of ["task/editorSettings", "task/editorSettingsOp", "task/saveEditorSettings", "task/externalEditorSettings"]) {
      const result = await route.taskOp(op, { program: "/bin/sh", args: ["-c", "touch PWNED"] });
      expect(result.ok, op).toBe(false);
      if (!result.ok) expect(result.error).toContain("unknown task op");
    }
    expect(route.forwarded).toEqual([]);
    expect(JSON.parse(route.document() as string)).toEqual({ program: NODE });
    expect(existsSync(join(route.worktreePath, "PWNED"))).toBe(false);

    // The launch route still refuses the page-reachable path (kept from the
    // previous slice): the editor op is only reachable through its own entry.
    const legacy = await route.taskOp("task/openEditor", { rootId: REPO_DIR, editor: { program: "/bin/sh", args: ["-c", "touch PWNED"] } });
    expect(legacy.ok).toBe(false);
    if (!legacy.ok) expect(legacy.error).toContain("shell/openTaskEditor");
  });

  it("refuses the save from a non-shell sender, writing nothing", async () => {
    const route = await productionRoute();
    // A task-page sender (the task trust domain) is not the attested shell UI.
    const taskWebContentsId = 4242;
    route.registerTaskSender(taskWebContentsId);
    const taskSender: Sender = {
      sender: { id: taskWebContentsId, mainFrame: { processId: 1, routingId: 1 } },
      senderFrame: { processId: 1, routingId: 1 },
    };
    const refused = await route.settings({ op: "save", program: NODE }, taskSender);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("wrong-domain");
    expect(route.document()).toBeNull();

    // An unregistered WebContents is refused too.
    const stranger: Sender = { sender: { id: 987_654, mainFrame: { processId: 9, routingId: 9 } }, senderFrame: { processId: 9, routingId: 9 } };
    const unknown = await route.settings({ op: "save", program: NODE }, stranger);
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain("unknown-sender");
    expect(route.document()).toBeNull();
  });

  it("reads the saved setting back for the settings surface and reports the honest 未配置 state", async () => {
    const route = await productionRoute();
    const initial = await route.settings({ op: "read" });
    expect(initial.ok).toBe(true);
    expect(initial.payload).toEqual({ program: null, args: [], settingsPath: externalEditorSettingsPath(route.userData) });

    await route.settings({ op: "save", program: NODE, args: ["--wait"] });
    const read = await route.settings({ op: "read" });
    expect(read.payload).toEqual({ program: NODE, args: ["--wait"], settingsPath: externalEditorSettingsPath(route.userData) });

    // A hand-broken document is reported by name, never as 未配置.
    writeFileSync(externalEditorSettingsPath(route.userData), "{ broken");
    const broken = await route.settings({ op: "read" });
    expect(broken.ok).toBe(false);
    expect(broken.error).toContain("editor-settings-invalid");
    // Clearing recovers the honest state through the same real handler.
    const cleared = await route.settings({ op: "clear" });
    expect(cleared.ok).toBe(true);
    expect(cleared.payload).toMatchObject({ program: null });
  });
});
