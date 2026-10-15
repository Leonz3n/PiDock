import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HostClient } from "../rpc/host-client.js";
import { InstalledServiceHostAuthority } from "../main/service-host-binding.js";
import { PerTaskHostRegistry } from "../main/runtime.js";
import { ServiceCatalog, serviceCatalogAuthority } from "../main/service-catalog.js";
import { TaskRootIndex } from "../main/task-root-index.js";
import { ProjectRegistry } from "../main/project-registry.js";
import { diskTaskStore } from "./task-host.js";
import { buildTaskDiskRecord } from "./task-store.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});
function platform(value: NodeJS.Platform): void {
  const saved = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value, configurable: true });
  cleanups.push(() => { Object.defineProperty(process, "platform", saved); });
}
async function installed() {
  vi.resetModules();
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-owner-parent-")));
  cleanups.push(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const profile = join(home, "profile"), root = join(home, "tasks");
  const taskId = "task-12345678", taskDir = join(root, taskId), workspaceId = "workspace-a";
  mkdirSync(profile, { mode: 0o700 });
  mkdirSync(join(taskDir, "work"), { recursive: true });
  diskTaskStore.writeTask(taskDir, buildTaskDiskRecord({ taskId, name: "Parent admission", dirId: taskId,
    branch: "task/main", root, taskDir, remoteBranch: "main", baseCommit: "source-fixture", repos: ["work"], now: "2026-01-01T00:00:00.000Z" }));
  const roots = new TaskRootIndex(profile, root);
  await roots.register(taskDir);
  const projects = new ProjectRegistry(profile), authority = serviceCatalogAuthority(roots, projects), catalog = new ServiceCatalog(profile, authority);
  const child = new EventEmitter() as EventEmitter & { postMessage(value: unknown): void; kill(): void };
  const parent = new EventEmitter() as EventEmitter & { postMessage(value: unknown): void };
  child.kill = vi.fn(() => { child.emit("exit", 0); });
  child.postMessage = vi.fn((value) => { parent.emit("message", { data: value }); });
  parent.postMessage = (value) => { child.emit("message", value); };
  const oldPort = Object.getOwnPropertyDescriptor(process, "parentPort");
  Object.defineProperty(process, "parentPort", { configurable: true, value: parent });
  cleanups.push(() => { if (oldPort) Object.defineProperty(process, "parentPort", oldPort); else Reflect.deleteProperty(process, "parentPort"); });
  for (const [name, value] of Object.entries({ PIDOCK_WORKSPACE_ID: workspaceId, PIDOCK_TASK_ID: taskId,
    PIDOCK_TASK_DIR: taskDir, PIDOCK_PROTECTED_PROFILE: profile, PIDOCK_DEFAULT_TASKS_ROOT: root })) vi.stubEnv(name, value);
  // The actual post-#90 Windows fork environment, with no required marker.
  vi.stubEnv("PIDOCK_SERVICE_OWNER_REQUIRED", undefined);
  const { startHost } = await import("./host.js");
  startHost();
  const client = new HostClient(child as never);
  const main = new InstalledServiceHostAuthority(profile, catalog, authority, workspaceId, {});
  cleanups.push(async () => { client.dispose(); child.emit("exit", 0); await main.disposeWhenExited().catch(() => {}); });
  const registry = new PerTaskHostRegistry(workspaceId, async () => ({ client, child: child as never }), () => taskDir, undefined, roots);
  const factory = vi.fn(() => main);
  const task = (op: Parameters<HostClient["task"]>[0]["op"], payload: Record<string, unknown> = {}) =>
    registry.routeTaskOp({ taskId, op, payload, origin: { kind: "shell-ui", senderWebContentsId: 7 } });
  return { registry, factory, child, catalog, task, taskId };
}

// #90 installed 0.1.2 still received the main authority's failure fence even
// though createHost no longer set PIDOCK_SERVICE_OWNER_REQUIRED on Windows.
it("does not let installed main service binding fence human terminal writes on win32", async () => {
  platform("win32");
  const f = await installed();
  f.registry.configureServices(f.factory);
  await expect(f.task("task/terminalControl", { instanceId: "term-absent", action: "input", data: "\r" }))
    .rejects.toThrow("terminal-not-running");
  expect(f.factory).not.toHaveBeenCalled();
  expect(f.child.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "service-owner-fenced" }));
  expect(f.registry.serviceOwnerState(f.taskId)).toBe("absent");
  expect((await f.task("task/sessionStates")).payload).toMatchObject({ orphans: [] });
  expect(await f.registry.quitAll({ origin: { kind: "shell-ui", senderWebContentsId: 7 } })).toMatchObject({ ok: true });
  await f.registry.disposeAll();
  expect(f.child.kill).toHaveBeenCalledTimes(1);
});

it("keeps a failed installed parent authority fail-closed on an admitted platform", async () => {
  const f = await installed();
  platform("darwin");
  vi.spyOn(f.catalog, "ownerSnapshot").mockImplementation(() => { throw Error("catalog-unavailable"); });
  f.registry.configureServices(f.factory);
  await expect(f.task("task/terminalControl", { instanceId: "term-absent", action: "input", data: "\r" }))
    .rejects.toThrow("task-locked: 执行资源尚未核验（service-owner-inventory）");
  expect(f.factory).toHaveBeenCalledTimes(1);
  expect(f.child.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: "service-owner-fenced" }));
  expect(f.registry.serviceOwnerState(f.taskId)).toBe("fenced");
  expect((await f.task("task/sessionStates")).payload).toMatchObject({ orphans: [expect.objectContaining({ resourceId: "service-owner-inventory", verificationRequired: true })] });
  expect(await f.registry.quitAll({ origin: { kind: "shell-ui", senderWebContentsId: 7 } })).toMatchObject({ ok: false });
});

// Real ConPTY and the pinned win32-x64 payload are not available off Windows;
// the platform-independent tests above still exercise parent/Host admission.
it.skipIf(process.platform !== "win32")("round-trips default PowerShell and drains it on quit through the installed parent registry", { timeout: 90_000 }, async () => {
  const f = await installed();
  f.registry.configureServices(f.factory);
  const profiles = (await f.task("task/terminalProfiles")).payload;
  expect(profiles).toMatchObject({ defaultProfileId: "powershell" });
  const instanceId = "parent-real-powershell";
  const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
  let started = false, quit = false;
  cleanups.push(async () => { if (started && !quit) await f.task("task/terminalControl", { instanceId, action: "stop" }); });
  const start = await f.task("task/terminalControl", { instanceId, action: "start", rootId: "work", profileId: profiles["defaultProfileId"],
    layers: { repoDefaults: [
      { key: "PATH", value: `${join(systemRoot, "System32")};${systemRoot}`, secret: false },
      { key: "SystemRoot", value: systemRoot, secret: false },
      { key: "TERM", value: "xterm-256color", secret: false },
    ], shared: [], privateEntries: [], task: [] } });
  started = true;
  expect(start.payload).toMatchObject({ actor: "human", instance: { lifecycle: "running" } });
  await f.task("task/terminalControl", { instanceId, action: "input", data: "Write-Output ('pidock-' + 'before-sleep'); Start-Sleep 30; Write-Output ('pidock-' + 'bad-after-sleep')\r" });
  const history = async () => JSON.stringify((await f.task("task/terminalHistory", { instanceId, limit: 200 })).payload);
  await expect.poll(history, { timeout: 20_000 }).toContain("pidock-before-sleep");
  const promptCount = async () => {
    const rows = (await f.task("task/terminalHistory", { instanceId, limit: 200 })).payload["history"] as { line: string }[];
    return rows.filter(({ line }) => /^PS .*?>\s*$/.test(line)).length;
  };
  const beforeInterrupt = await promptCount();
  await f.task("task/terminalControl", { instanceId, action: "input", data: "\x03" });
  // Wait for the shell to finish cancellation and read input again; writing
  // during PowerShell's Ctrl+C handler can legitimately discard that input.
  await expect.poll(promptCount, { timeout: 20_000 }).toBeGreaterThan(beforeInterrupt);
  await f.task("task/terminalControl", { instanceId, action: "input", data: "Write-Output ('pidock-' + 'parent-ok')\r" });
  await expect.poll(history, { timeout: 20_000 }).toContain("pidock-parent-ok");
  expect(await history()).not.toContain("pidock-bad-after-sleep");
  expect((await f.task("task/terminalControl", { instanceId, action: "resize", cols: 100, rows: 30 })).payload)
    .toMatchObject({ action: "resize", actor: "human" });
  expect(f.factory).not.toHaveBeenCalled();
  expect(await f.registry.quitAll({ origin: { kind: "shell-ui", senderWebContentsId: 7 } })).toMatchObject({ ok: true });
  quit = true;
  await f.registry.disposeAll();
  expect(f.child.kill).toHaveBeenCalledTimes(1);
});

// The renderer adapter supplies empty env layers. Force the Windows PowerShell fallback,
// which fails with 8009001d under ConPTY when SystemRoot is absent; PS7 does not.
it.skipIf(process.platform !== "win32")("starts Windows PowerShell from a renderer-shaped request with empty env layers", { timeout: 40_000 }, async () => {
  vi.stubEnv("ProgramFiles", undefined);
  const f = await installed();
  f.registry.configureServices(f.factory);
  const profiles = (await f.task("task/terminalProfiles")).payload;
  const offered = profiles["profiles"] as { program: string; args: string[] }[];
  expect(offered[0]!.program.toLowerCase()).toMatch(/windowspowershell.*powershell\.exe$/);
  expect(offered[0]!.args).toEqual([]);
  const instanceId = "inbox-powershell-no-layers";
  cleanups.push(async () => { await f.registry.quitAll({ origin: { kind: "shell-ui", senderWebContentsId: 7 } }); await f.registry.disposeAll(); });
  const start = await f.task("task/terminalControl", { instanceId, action: "start", rootId: "work", profileId: "powershell",
    layers: { repoDefaults: [], shared: [], privateEntries: [], task: [] } });
  expect(start.payload).toMatchObject({ actor: "human", instance: { lifecycle: "running" } });
  await f.task("task/terminalControl", { instanceId, action: "input", data: "if ($env:SystemRoot -and $env:PATH) { Write-Output ('pidock-' + 'inbox-ok') }\r" });
  const history = async () => JSON.stringify((await f.task("task/terminalHistory", { instanceId, limit: 200 })).payload);
  await expect.poll(history, { timeout: 12_000 }).toContain("pidock-inbox-ok");
  expect(await history()).not.toMatch(/8009001d/i);
  expect(await f.registry.quitAll({ origin: { kind: "shell-ui", senderWebContentsId: 7 } })).toMatchObject({ ok: true });
});
