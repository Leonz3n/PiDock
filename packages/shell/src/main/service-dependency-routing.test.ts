/**
 * [PiDock 05] (#10 box 1) the PRODUCTION read the shipped dock uses for a task's
 * 本地/远程位置 and its REAL 实际依赖去向.
 *
 * Why this file goes through the REAL IPC handler: three earlier slices shipped a
 * capability that nothing in production reached. The seam that must hold here is
 * hop by hop - `shell/serviceCatalogOp {op:"taskDependencyRouting"}` (the same
 * channel the dock already uses for `{op:"runTaskServiceGroup"}`) →
 * `parseTaskDependencyRoutingRequest` → `readTaskDependencyRouting` over a REAL
 * `ServiceCatalog` and a REAL task folder. Nothing about the plan is supplied by
 * the caller: the page names `{projectId,taskId}` and nothing else.
 *
 * Evidence split (stated, not implied):
 * - REAL: the registered handler itself, a real `ServiceCatalog` on a temp
 *   profile with real task directories and a real executable program path, the
 *   trusted sender attestation and every value the read returns.
 * - FIXTURE: `electron` is mocked (no Electron runtime under vitest), the catalog
 *   authority is an in-test stub (the real `TaskRootIndex`/`ProjectRegistry`
 *   wiring has its own suites) and the program path is `process.execPath`.
 * - The handler is registered with **no task registry at all**, which is the
 *   strongest available proof that this read cannot fork a Host, start a unit or
 *   create a child: there is no collaborator on the path that could.
 * No Electron UI, no packaged build and no Windows run: win32 stays a named
 * negative (the group/plan platform gate is a different op and is not on this
 * read's path).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "" },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn(), eventNames: () => [] },
  utilityProcess: { fork: vi.fn() },
  session: { fromPartition: (partition: string) => ({ partition }) },
  WebContentsView: class {},
  BrowserWindow: class {},
}));

import { ipcMain } from "electron";
import { TrustDomainRegistry } from "./trust-domain.js";
import { registerIpc } from "./runtime.js";
import { ServiceCatalog, type ServiceCatalogAuthority } from "./service-catalog.js";

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

const SENDER = 7;

/**
 * A real catalog over a real task folder, plus the REAL `shell/serviceCatalogOp`
 * handler with NO task registry: every fixture below is real trusted state, and
 * the read has no Host to reach.
 */
async function fixture() {
  vi.resetModules();
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-dep-routing-")));
  cleanups.push(home);
  const profile = join(home, "profile");
  const root = join(home, "tasks");
  const taskId = "task-1a2b3c4d";
  const taskDir = join(root, taskId);
  const projectId = randomUUID();
  mkdirSync(profile, { mode: 0o700 });
  for (const dir of ["repo-a/caller", "repo-a/callee"]) mkdirSync(join(taskDir, dir), { recursive: true });
  const stat = statSync(taskDir, { bigint: true });
  const identity = { taskId, createdAt: "2026-01-01T00:00:00.000Z", root, realRoot: root, dirId: taskId,
    directoryDevice: stat.dev.toString(), directoryInode: stat.ino.toString() };
  const owner = (id: string) => id === taskId ? { identity, projectId, rootIds: ["repo-a"] } : null;
  const authority: ServiceCatalogAuthority = { projectExists: (id) => id === projectId, task: (id) => owner(id), verifiedTask: (id) => owner(id) };
  const catalog = new ServiceCatalog(profile, authority);
  const environmentId = catalog.createEnvironment({ projectId, name: "开发环境" }).environmentId;

  /** One pinned revision of one service in the task's environment. */
  const template = (input: { name: string; ports: number[]; shared: { key: string; value: string }[]; dependencies?: { to: string; kind: "call" | "prestart" }[]; serviceId?: string; expectedVersion?: number }) =>
    catalog.saveTemplate({
      projectId, environmentId,
      ...(input.serviceId === undefined ? {} : { serviceId: input.serviceId, expectedVersion: input.expectedVersion as number }),
      descriptor: { name: input.name, program: "node", args: ["service.cjs"], ports: input.ports, runType: "long-lived" },
      shared: input.shared.map((row) => ({ ...row, secret: false })),
      ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies }),
    });
  const bind = (serviceId: string, subdir: string, templateVersion = 1) =>
    catalog.bindTask({ taskId, serviceId, environmentId, templateVersion, rootId: "repo-a", subdir,
      programPath: realpathSync(process.execPath), privateRefs: [] });

  const trust = new TrustDomainRegistry();
  trust.registerShell({ webContentsId: SENDER, viewId: "shell-view", workspaceId: "workspace-a" });
  vi.mocked(ipcMain.handle).mockClear();
  // `tasks` is undefined on purpose: this read needs no Host, and with none wired
  // it provably cannot reach one.
  registerIpc({} as never, trust, undefined, undefined, undefined, undefined, undefined, undefined, catalog);
  const handler = vi.mocked(ipcMain.handle).mock.calls.findLast(([channel]) => channel === "shell/serviceCatalogOp")?.[1];
  expect(handler).toBeDefined();
  const shell = {
    sender: { id: SENDER, mainFrame: { processId: 1, routingId: 1 }, getURL: () => "file:///shell/index.html", isDestroyed: () => false, on: vi.fn(), removeListener: vi.fn() },
    senderFrame: { processId: 1, routingId: 1 },
  };
  const op = (payload: Record<string, unknown>, sender: unknown = shell) =>
    handler!(sender as never, payload) as Promise<{ ok: boolean; payload?: Record<string, unknown>; error?: string }>;
  const read = () => op({ op: "taskDependencyRouting", projectId, taskId });

  /**
   * The task's two services in ONE repository: `caller-api` DECLARES a `call`
   * dependency on `callee-api` (so exactly one address variable is bound to this
   * task's own instance), while `caller-api`'s own address variable has no
   * declaration - its consumers keep the shared environment address.
   */
  const pair = (input: { declaration: boolean }) => {
    const callee = template({ name: "Callee API", ports: [9102],
      shared: [{ key: "PORT", value: "9102" }, { key: "CALLEE_API_URL", value: "https://shared.example/callee" }] });
    const caller = template({ name: "Caller API", ports: [9101],
      shared: [{ key: "PORT", value: "9101" }, { key: "CALLER_API_URL", value: "https://shared.example/caller" }],
      ...(input.declaration ? { dependencies: [{ to: callee.serviceId, kind: "call" as const }] } : {}) });
    bind(caller.serviceId, "caller");
    bind(callee.serviceId, "callee");
    return { caller, callee };
  };
  return { home, profile, taskId, taskDir, projectId, environmentId, catalog, op, read, pair, template, bind, shell, senderWebContentsId: SENDER };
}

describe("[PiDock 05] #10 box 1 the trusted 本地/远程位置 + 实际依赖去向 read", () => {
  it("derives 位置, the repo's multiple run units and per-variable 去向 from the catalog and the PINNED bindings", async () => {
    const f = await fixture();
    const { caller, callee } = f.pair({ declaration: true });

    const result = await f.read();
    expect(result.ok).toBe(true);
    const view = result.payload as Record<string, unknown>;

    // 位置 + identity per bound service, each from the binding's own pin.
    expect(view["units"]).toEqual([
      { unitId: `repo-a:${caller.serviceId}`, serviceId: caller.serviceId, name: "Caller API", repoDir: "repo-a", subdir: "caller",
        templateVersion: 1, environment: "开发环境", location: "local", declaredPorts: [9101] },
      { unitId: `repo-a:${callee.serviceId}`, serviceId: callee.serviceId, name: "Callee API", repoDir: "repo-a", subdir: "callee",
        templateVersion: 1, environment: "开发环境", location: "local", declaredPorts: [9102] },
    ]);
    // ONE repository contributes TWO run units (一个仓库可以选择多个运行单元).
    expect(view["repoGroups"]).toEqual([
      { repoDir: "repo-a", unitIds: [`repo-a:${caller.serviceId}`, `repo-a:${callee.serviceId}`] },
    ]);

    // 实际依赖去向: the DECLARED target is this task's own instance address (address + port),
    // and the variable no declaration binds keeps the shared environment address.
    expect(view["destinations"]).toEqual([
      // The variable NO declaration binds: the consumer keeps the shared
      // environment address, reported with the layer that really reads it.
      { unitId: `repo-a:${caller.serviceId}`, serviceId: caller.serviceId, key: "CALLER_API_URL",
        target: { kind: "remote", environment: "开发环境" },
        readPoints: [{ source: "共享模板", masked: false, value: "https://shared.example/caller" }],
        reason: "没有服务依赖声明把「CALLER_API_URL」绑定到本任务的本地实例「Caller API」，消费者会继续使用共享环境地址" },
      // The declared target: THIS task's own instance, address and port.
      { unitId: `repo-a:${callee.serviceId}`, serviceId: callee.serviceId, key: "CALLEE_API_URL",
        target: { kind: "local-instance", instanceId: `${f.taskId}/${callee.serviceId}`, address: `${f.taskId}/${callee.serviceId}@9102`, port: 9102 },
        value: "http://127.0.0.1:9102", readPoints: [{ source: "共享模板", masked: false }] },
    ]);
    // The remote-dependency list is exactly the destinations whose target is not
    // this task's own instance - and it carries no address of its own.
    const remote = (view["destinations"] as Record<string, unknown>[]).filter((entry) => (entry["target"] as { kind: string }).kind === "remote");
    expect(remote).toHaveLength(1);
    expect(remote[0]).not.toHaveProperty("value");
    expect(JSON.stringify(remote)).not.toContain("127.0.0.1");
    expect(JSON.stringify(remote)).not.toContain("9101");

    // The declared edge is a DECLARATION with a named state: this read verifies nothing.
    expect(view["linkage"]).toEqual({
      state: "declared",
      edges: [{ from: `repo-a:${caller.serviceId}`, to: `repo-a:${callee.serviceId}`, fromName: "Caller API", toName: "Callee API", kind: "call" }],
    });
    // The plan's OWN diagnostic for the unbound read point rides the same answer
    // (and is the message the row above carries as its reason), so the dock can
    // show why the variable stays shared without re-deriving anything.
    expect(view["diagnostics"]).toEqual([{
      code: "missing-binding",
      message: "共享模板读取「CALLER_API_URL」，但本任务没有把该变量绑定到本地实例「Caller API」",
      hint: "请在运行面板把该变量绑定到当前任务的本地服务，否则消费者会继续使用共享环境地址",
    }]);
    // NOTHING WAS STARTED: no run record, no registration and no Host exists on
    // this path at all (the handler has no task registry wired).
    expect(JSON.stringify(view)).not.toContain("pid");
  });

  it("names 无依赖边（未做互验） when no pinned revision declares an edge, and invents none", async () => {
    const f = await fixture();
    const { caller } = f.pair({ declaration: false });

    const result = await f.read();
    expect(result.ok).toBe(true);
    const view = result.payload as Record<string, unknown>;
    expect(view["linkage"]).toEqual({ state: "no-declaration", edges: [] });
    // With no declaration, NEITHER unit's address variable is bound: both keep the
    // shared environment address instead of a synthesized local one.
    const destinations = view["destinations"] as Record<string, unknown>[];
    expect(destinations.map((entry) => [entry["key"], (entry["target"] as { kind: string }).kind])).toEqual([
      ["CALLER_API_URL", "remote"],
      ["CALLEE_API_URL", "remote"],
    ]);
    expect(destinations.every((entry) => entry["value"] === undefined)).toBe(true);
    expect(JSON.stringify(view)).not.toContain(`repo-a:${caller.serviceId}@`);
  });

  it("reflects the PINNED revision, not the newest one in the environment", async () => {
    const f = await fixture();
    const { callee } = f.pair({ declaration: true });
    // A newer revision of the SAME service: another declared port and another
    // shared value. The task's binding still pins v1.
    const newer = f.template({ serviceId: callee.serviceId, expectedVersion: 1, name: "Callee API", ports: [9399],
      shared: [{ key: "PORT", value: "9399" }, { key: "CALLEE_API_URL", value: "https://shared.example/v2" }] });
    expect(newer.version).toBe(2);

    const view = (await f.read()).payload as Record<string, unknown>;
    const bound = (view["destinations"] as Record<string, unknown>[]).find((entry) => entry["key"] === "CALLEE_API_URL") as Record<string, unknown>;
    expect(bound["target"]).toMatchObject({ kind: "local-instance", port: 9102 });
    expect(bound["value"]).toBe("http://127.0.0.1:9102");
    expect((view["units"] as Record<string, unknown>[]).find((unit) => unit["serviceId"] === callee.serviceId)).toMatchObject({ templateVersion: 1, declaredPorts: [9102] });
  });

  it("refuses a page that names the plan's trusted inputs BY NAME, and accepts the same call without them", async () => {
    const f = await fixture();
    f.pair({ declaration: true });
    const attempts: [string, unknown][] = [
      ["units", [{ unitId: "repo-a:x", serviceId: "x", name: "X", location: "local" }]],
      ["rules", [{ key: "CALLEE_API_URL", unitId: "repo-a:x", kind: "url" }]],
      ["layers", { repoDefaults: [], shared: [{ key: "CALLEE_API_URL", value: "https://attacker.example", secret: false }], privateEntries: [], task: [] }],
      ["dependencies", [{ from: "repo-a:x", to: "repo-a:y", kind: "call" }]],
    ];
    for (const [key, value] of attempts) {
      const result = await f.op({ op: "taskDependencyRouting", projectId: f.projectId, taskId: f.taskId, [key]: value });
      expect(result.ok).toBe(false);
      // Refused BY NAME, with the key's own spelling in the refusal.
      expect(result.error).toContain(`不接受 ${key}`);
    }
    // MUTATION GUARD for the refusals above: the very same op accepts the very
    // same request once those keys are absent, so the refusal is keyed on them and
    // not on the op.
    const accepted = await f.op({ op: "taskDependencyRouting", projectId: f.projectId, taskId: f.taskId });
    expect(accepted.ok).toBe(true);
    expect((accepted.payload as Record<string, unknown>)["taskId"]).toBe(f.taskId);
    // A payload that is not the documented shape is refused too (never partially read).
    expect((await f.op({ op: "taskDependencyRouting", taskId: f.taskId })).ok).toBe(false);
  });

  it("refuses a declared-but-unbound target BY NAME instead of dropping the edge", async () => {
    const f = await fixture();
    const callee = f.template({ name: "Callee API", ports: [9102], shared: [{ key: "CALLEE_API_URL", value: "https://shared.example/callee" }] });
    const caller = f.template({ name: "Caller API", ports: [9101], shared: [{ key: "CALLER_API_URL", value: "https://shared.example/caller" }],
      dependencies: [{ to: callee.serviceId, kind: "call" }] });
    // Only the declarer is bound; the declared target is not.
    f.bind(caller.serviceId, "caller");

    const result = await f.read();
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      `服务依赖声明无法满足，未生成整组计划：「Caller API」（${caller.serviceId}）声明的依赖目标 ${callee.serviceId} 未在本任务的服务绑定中，请先绑定该服务或从共享模板移除该声明`,
    );
  });

  it("names a launch main cannot resolve instead of showing a partial routing", async () => {
    const f = await fixture();
    const { caller } = f.pair({ declaration: true });
    // The binding's working copy is gone: the trusted launch no longer resolves.
    rmSync(join(f.taskDir, "repo-a/caller"), { recursive: true, force: true });
    const result = await f.read();
    expect(result.ok).toBe(false);
    expect(result.error).toBe(`依赖去向读取失败：${caller.serviceId} 的启动材料无法从可信服务目录解析（service-launch-unavailable）`);
  });

  it("answers an empty task with no fabricated unit and the named no-declaration state", async () => {
    const f = await fixture();
    const view = (await f.read()).payload as Record<string, unknown>;
    expect(view).toEqual({ taskId: f.taskId, units: [], repoGroups: [], destinations: [], linkage: { state: "no-declaration", edges: [] }, diagnostics: [] });
  });
});
