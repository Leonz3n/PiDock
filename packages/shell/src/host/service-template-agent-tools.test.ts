/**
 * [PiDock 04] (#7 box 6) the Agent's shared-template edit, driven through the
 * REAL tool broker, the REAL permission gate, the REAL catalog store and the
 * REAL Host -> main request pair.
 *
 * Evidence split (stated, not implied):
 * - REAL production objects: `host.js`'s own `agentServiceHostFor` and
 *   `serviceTemplateEditPortFor` (the exact pair `taskHostFor` hands to
 *   `TaskWorkspaceHost`), the real `TaskWorkspaceHost`, the real
 *   `PiSessionChannel` gate, the real task write coordinator, the real
 *   `SdkAgentToolBroker`, the real `ServiceCatalog`/`ServiceCatalogAuthority`,
 *   the real `ServiceTemplateRequestClient` + `HostClient` envelope handlers and
 *   main's own `createServiceTemplateHandler`.
 * - ONE replaced hop: production runs the model context in a worker thread and
 *   calls `broker.call(sessionId, request)` for every declared tool
 *   (`sdk-context-client.ts:210`); these tests capture the broker through the
 *   same `toolHost` option and call it with the same signature (no Provider turn
 *   is started, no model is stubbed). The UtilityProcess boundary between main
 *   and the Host is an in-process duplex EventEmitter that carries the SAME
 *   envelopes through the SAME guards on both sides.
 * - REAL child process: the running-service leg starts the task's bound service
 *   through the Host's own driver and probes the OS process the child reported,
 *   so "the edit disturbed nothing" is about a real pid, not a returned flag.
 * - The document on disk is the assertion for every no-write path: the bytes of
 *   `service-templates.json` are compared, so "nothing was written" is a fact
 *   about the file, not about an absent call.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PI_GATED_TOOL_NAMES } from "../main/pi-session.js";
import { ServiceCatalog, type ServiceCatalogAuthority } from "../main/service-catalog.js";
import { createServiceTemplateHandler } from "../main/service-catalog-ipc.js";
import { HostClient } from "../rpc/host-client.js";
import { isServiceTemplateRequest, type ServiceTemplateEditPort, type ServiceTemplateRequestParams } from "../rpc/service-template-request.js";
import { protectApplicationProfile } from "./protected-application-path.js";
import { SDK_AGENT_TOOL_NAMES, type SdkAgentToolName, type SdkAgentToolOutcome, type SdkAgentToolRequest } from "./sdk-agent-tool-contract.js";
import { SdkAgentToolBroker, type SdkAgentServiceHost, type SdkAgentToolScope } from "./sdk-agent-tool-broker.js";
import { publicServiceStatus } from "./service-public.js";
import type { TaskWorkspaceHost } from "./task-host.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

const TOOL = "service.template.update" satisfies SdkAgentToolName;

/** The fixture child: reports its own pid, then stays alive. */
const SERVICE_SCRIPT = `const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(process.cwd(), "started-a.txt"), String(process.pid));
console.log("ready:" + process.env.SERVICE_GREETING);
setInterval(() => {}, 1000);
`;

const WAIT_MS = 30_000;
const POLL_MS = 25;

async function until(check: () => boolean, label: string): Promise<void> {
  for (let elapsed = 0; elapsed < WAIT_MS; elapsed += POLL_MS) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw Error(`timed out waiting for ${label}`);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * A refusal is immediate; only a confirmed write may park on the user. A call
 * that would park inside a refusal assertion is a failed assertion, not a
 * 30-second hang, so the mutation that lets a call through is named here.
 */
async function refusedPromptly(call: Promise<SdkAgentToolOutcome>): Promise<SdkAgentToolOutcome> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([call, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(Error("工具调用没有立即拒绝，反而在等待用户确认")); }, 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

function markerPid(taskDir: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(taskDir, "repo-a", "svc-a", "started-a.txt"), "utf8"));
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch { return undefined; }
}

interface Harness {
  taskId: string;
  otherTaskId: string;
  taskDir: string;
  profile: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
  catalog: InstanceType<typeof ServiceCatalog>;
  surface: SdkAgentServiceHost;
  broker: { call(sessionId: string, request: SdkAgentToolRequest): Promise<SdkAgentToolOutcome> };
  host: TaskWorkspaceHost;
  /** The very port the Host hands to its broker (the production factory, not a copy). */
  templatePort: ServiceTemplateEditPort;
  /** A second service of the same environment, usable as a declaration target. */
  peerServiceId: string;
  /** The shared template document on disk: the byte-exact proof surface. */
  documentPath: string;
  document: () => string;
  versions: () => { pinned: number; latest: number; otherPinned: number };
  /** The template tool, as the model calls it. */
  call(args: Record<string, unknown>): Promise<SdkAgentToolOutcome>;
  /** Any other real tool of this task (the service surface shares the gate). */
  callTool(tool: SdkAgentToolName, args: Record<string, unknown>): Promise<SdkAgentToolOutcome>;
}

/** One edit the Agent may name: the whole revision content, and nothing else. */
function editArgs(serviceId: string, greeting: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    serviceId,
    descriptor: { name: "API a", program: "node", args: ["service.cjs"], ports: [], runType: "long-lived" },
    shared: [{ key: "SERVICE_GREETING", value: greeting, secret: false }, { key: "SERVICE_TAG", value: "a", secret: false }],
    ...extra,
  };
}

/**
 * `register: false` leaves the task's service UNREGISTERED, the honest state of a
 * bound service the task has never started or stopped.
 */
async function harness(options: { register?: boolean } = {}): Promise<Harness> {
  vi.resetModules();
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-agent-template-")));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const profile = join(home, "profile");
  const root = join(home, "tasks");
  const taskId = "task-7f20c4aa";
  const otherTaskId = "task-7f20c4bb";
  const taskDir = join(root, taskId);
  const otherTaskDir = join(root, otherTaskId);
  const projectId = randomUUID();
  for (const dir of [taskDir, otherTaskDir]) {
    mkdirSync(join(dir, "repo-a", "svc-a"), { recursive: true });
    writeFileSync(join(dir, "repo-a", "svc-a", "service.cjs"), SERVICE_SCRIPT);
  }
  mkdirSync(profile, { mode: 0o700 });

  // The Host speaks RPC over `process.parentPort`; install the same duplex pair
  // production has, so the real Host client and the real main-side `HostClient`
  // carry the real envelopes through the real guards.
  const hostSide = new EventEmitter() as EventEmitter & { postMessage(value: unknown): void };
  const mainSide = new EventEmitter() as EventEmitter & { postMessage(value: unknown): void };
  hostSide.postMessage = (message) => { mainSide.emit("message", message); };
  mainSide.postMessage = (message) => { hostSide.emit("message", { data: message }); };
  const oldPort = Object.getOwnPropertyDescriptor(process, "parentPort");
  Object.defineProperty(process, "parentPort", { configurable: true, value: hostSide });
  cleanups.push(() => { if (oldPort) Object.defineProperty(process, "parentPort", oldPort); else Reflect.deleteProperty(process, "parentPort"); });
  for (const [name, value] of Object.entries({ PIDOCK_WORKSPACE_ID: "workspace-a", PIDOCK_TASK_ID: taskId, PIDOCK_TASK_DIR: taskDir, PIDOCK_PROTECTED_PROFILE: profile })) vi.stubEnv(name, value);
  vi.stubEnv("LOCAL_TEST_TOKEN", "synthetic-private-value");

  const { agentServiceHostFor, serviceTemplateEditPortFor } = await import("./host.js");
  const { TaskWorkspaceHost, diskTaskStore } = await import("./task-host.js");
  const { buildTaskDiskRecord } = await import("./task-store.js");
  for (const [id, dir] of [[taskId, taskDir], [otherTaskId, otherTaskDir]] as const) {
    diskTaskStore.writeTask(dir, buildTaskDiskRecord({ taskId: id, name: "Agent templates", dirId: id, branch: `task/${id}`,
      root, taskDir: dir, remoteBranch: "main", baseCommit: "source-fixture", repos: ["repo-a"], now: "2026-01-01T00:00:00.000Z" }));
  }

  const surface = agentServiceHostFor(taskId);
  if (!surface) throw Error("the production Agent service surface is not wired");
  const identityOf = (id: string, dir: string) => {
    const stat = statSync(dir, { bigint: true });
    return { identity: { taskId: id, createdAt: "2026-01-01T00:00:00.000Z", root, realRoot: root, dirId: id,
      directoryDevice: stat.dev.toString(), directoryInode: stat.ino.toString() }, projectId, rootIds: ["repo-a"] };
  };
  const owners = new Map([[taskId, identityOf(taskId, taskDir)], [otherTaskId, identityOf(otherTaskId, otherTaskDir)]]);
  const authority: ServiceCatalogAuthority = { projectExists: (id) => id === projectId, task: (id) => owners.get(id) ?? null, verifiedTask: (id) => owners.get(id) ?? null };
  const catalog = new ServiceCatalog(profile, authority);
  const environmentId = catalog.createEnvironment({ projectId, name: "开发环境" }).environmentId;
  const template = catalog.saveTemplate({ projectId, environmentId, descriptor: { name: "API a", program: "node", args: ["service.cjs"], ports: [], runType: "long-lived" },
    shared: [{ key: "SERVICE_GREETING", value: "hello-a", secret: false }, { key: "SERVICE_TAG", value: "a", secret: false }] });
  catalog.bindTask({ taskId, serviceId: template.serviceId, environmentId, templateVersion: 1, rootId: "repo-a", subdir: "svc-a",
    programPath: realpathSync(process.execPath), privateRefs: [{ key: "SERVICE_TOKEN", envRef: "LOCAL_TEST_TOKEN" }] });
  // A SECOND task bound to the same service and environment: it keeps its own pin.
  catalog.bindTask({ taskId: otherTaskId, serviceId: template.serviceId, environmentId, templateVersion: 1, rootId: "repo-a", subdir: "svc-a",
    programPath: realpathSync(process.execPath), privateRefs: [] });
  // A peer service in the SAME environment: the declaration target a real edit
  // may name (a self-edge is the store's own refusal).
  const peer = catalog.saveTemplate({ projectId, environmentId, descriptor: { name: "API b", program: "node", args: ["service.cjs"], ports: [], runType: "long-lived" }, shared: [] });
  const launch = catalog.launchFor(taskId, projectId, template.serviceId, process.env);
  if (options.register !== false) {
    surface.services.register({ serviceId: launch.serviceId, descriptor: launch.descriptor, layers: launch.layers,
      templateVersion: String(launch.templateVersion), launchSource: "catalog" });
  }

  // main's own half: the REAL HostClient envelope handler bound to this child's
  // task id, exactly as `PerTaskHostRegistry.bindHostRequests` binds it.
  const mainClient = new HostClient(mainSide);
  mainClient.onServiceTemplateRequest(createServiceTemplateHandler(catalog, taskId));
  cleanups.push(() => { hostSide.removeAllListeners("message"); mainSide.removeAllListeners("message"); });

  let broker: Harness["broker"] | undefined;
  const host = new TaskWorkspaceHost(taskId, taskDir, diskTaskStore, () => "2026-09-22T10:00:00+08:00", () => [], undefined, undefined, undefined, undefined,
    (contextOptions) => {
      const caller = contextOptions.toolHost;
      if (!caller) throw new Error("tool-host-missing");
      broker = caller;
      return {
        open: async () => ({ tools: [...SDK_AGENT_TOOL_NAMES] }),
        prompt: async () => { throw new Error("no model turn in this suite"); },
        cancel: async () => {},
        seal: () => {},
        dispose: async () => {},
      } as never;
    },
    protectApplicationProfile(profile),
    () => agentServiceHostFor(taskId),
    () => serviceTemplateEditPortFor(taskId));

  await host.configureSdkProvider({
    config: { profileId: "p-11111111-2222-3333-4444-555555555555", baseUrl: "https://models.example.test/v1", modelId: "gpt-5-mini",
      contextWindow: 128000, maxTokens: 8192, authRef: "PIDOCK_PROVIDER_EXAMPLE", generation: 1 },
    credential: "synthetic-key",
  });
  if (!broker) throw Error("broker-not-captured");
  host.setPermission("main", "default");

  cleanups.push(async () => {
    for (const serviceId of surface.services.ids()) {
      try { await surface.driver().stop(serviceId); } catch { /* already stopped, never registered, or unreachable */ }
    }
    const pid = markerPid(taskDir);
    if (pid !== undefined) { try { process.kill(pid, "SIGKILL"); } catch { /* the child is gone */ } }
    await host.shutdownSdk().catch(() => {});
  });

  const captured = broker;
  const templatePort = serviceTemplateEditPortFor(taskId);
  const documentPath = join(profile, "service-templates.json");
  return {
    taskId, otherTaskId, taskDir, profile, projectId, environmentId, serviceId: launch.serviceId, peerServiceId: peer.serviceId, catalog, surface, broker: captured, host, templatePort, documentPath,
    document: () => readFileSync(documentPath, "utf8"),
    versions: () => ({ pinned: catalog.taskBindings(projectId, taskId).find((row) => row.binding.serviceId === launch.serviceId)!.binding.templateVersion,
      latest: catalog.listTemplates(projectId, environmentId).find((row) => row.serviceId === launch.serviceId)!.version,
      otherPinned: catalog.taskBindings(projectId, otherTaskId).find((row) => row.binding.serviceId === launch.serviceId)!.binding.templateVersion }),
    call: (args) => captured.call("main", { tool: TOOL, args }),
    callTool: (tool, args) => captured.call("main", { tool, args }),
  };
}

/** The real broker with the same options, so the approval timeout can be lowered or a port left unbound. */
function brokerWithOptions(f: Harness, options: { approvalTimeoutMs?: number; templates?: () => ServiceTemplateEditPort | undefined }): SdkAgentToolBroker {
  return new SdkAgentToolBroker({
    sessionKnown: (sessionId) => sessionId === "main",
    channel: (sessionId) => f.host.openSession(sessionId),
    persist: () => {},
    write: f.host,
    scope: (): SdkAgentToolScope => ({ taskDir: f.taskDir, taskRoot: join(f.taskDir, ".."), worktrees: [], primaryCheckouts: [], assertProtected: () => {} }),
    resolveRealPath: (path) => path,
    closing: () => false,
    services: () => f.surface,
    templates: options.templates ?? (() => f.templatePort),
    ...(options.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: options.approvalTimeoutMs } : {}),
  });
}

/** The one pending confirmation of this session, as the user's page reads it. */
function pending(f: Harness) {
  const row = f.host.listApprovals("main").find((approval) => approval.status === "pending");
  if (!row) throw Error("no pending confirmation");
  return row;
}

it("reviews the real diff from the persisted template, writes nothing while pending, and saves v+1 only after the approval", { timeout: 30_000 }, async () => {
  const f = await harness();
  const before = f.document();
  expect(f.versions()).toEqual({ pinned: 1, latest: 1, otherPinned: 1 });

  const call = f.call(editArgs(f.serviceId, "hello-b", { dependencies: [{ to: f.peerServiceId, kind: "call" }] }));
  // The confirmation names the service and the change (not a blank prompt).
  await until(() => f.host.listApprovals("main").some((row) => row.status === "pending"), "the confirmation to be minted");
  const asked = pending(f);
  expect(asked.tool).toBe(TOOL);
  expect(asked.target).toContain(`/services/${f.serviceId}`);
  expect(asked.operation).toContain(`共享模板 ${f.serviceId} v1 → v2`);
  expect(asked.operation).toContain("修改 1 行");
  // Nothing was written while the call was parked - the document is byte-identical.
  expect(f.document()).toBe(before);
  expect(f.versions()).toEqual({ pinned: 1, latest: 1, otherPinned: 1 });

  f.host.approve("main", asked.id);
  const outcome = await call;
  expect(outcome.outcome).toBe("ok");
  // The answer carries the REAL before/after rows, the version and the restart list.
  expect(outcome.text).toContain("共享模板：v1 → v2（v2）：已保存");
  expect(outcome.text).toContain("~ SERVICE_GREETING: hello-a → hello-b");
  expect(outcome.text).toContain("未启动、停止或重启任何进程。");
  // The write really landed: v2 is on disk, the pin of THIS task still says v1
  // (adopting a newer revision is an explicit step), and the other task is listed.
  expect(f.document()).not.toBe(before);
  expect(JSON.parse(f.document()).revisions.at(-1)).toMatchObject({ serviceId: f.serviceId, version: 2, environmentId: f.environmentId });
  expect(f.versions()).toEqual({ pinned: 1, latest: 2, otherPinned: 1 });
  expect(outcome.text).toContain(`需重启项（需其任务显式更新才会切换，本次未切换）：`);
  expect(outcome.text).toContain(`任务 ${f.taskId}`);
  // The dependency declaration rode the same revision and was validated by the store.
  expect(JSON.parse(f.document()).revisions.at(-1).dependencies).toEqual([{ to: f.peerServiceId, kind: "call" }]);
  // The confirmation really was spent, and only once.
  expect(f.host.openSession("main").snapshot().approvals.find((row) => row.id === asked.id)?.consumedAt).toBeDefined();
});

it("asks under auto too, and the write happens only after the approval", { timeout: 30_000 }, async () => {
  const f = await harness();
  f.host.setPermission("main", "auto");
  const before = f.document();

  const call = f.call(editArgs(f.serviceId, "hello-auto"));
  await until(() => f.host.listApprovals("main").some((row) => row.status === "pending"), "the auto-tier confirmation to be minted");
  // (m6) The tier the confirmation was minted for is `auto`; a re-check that
  // hard-codes `default` throws this approval away and the call reds here.
  expect(pending(f).permissionAtRequest).toBe("auto");
  expect(f.document()).toBe(before);
  f.host.approve("main", pending(f).id);
  expect(await call).toMatchObject({ outcome: "ok" });
  expect(f.versions().latest).toBe(2);
  expect(f.document()).not.toBe(before);
});

it("writes nothing when the confirmation is rejected, cancelled or expired", { timeout: 30_000 }, async () => {
  const f = await harness();
  const before = f.document();

  const rejected = f.call(editArgs(f.serviceId, "hello-rejected"));
  await until(() => f.host.listApprovals("main").some((row) => row.status === "pending"), "the first confirmation");
  f.host.reject("main", pending(f).id);
  expect(await rejected).toMatchObject({ outcome: "refused", code: "tool-refused:approval-rejected" });
  expect(f.document()).toBe(before);

  const cancelled = f.call(editArgs(f.serviceId, "hello-cancelled"));
  await until(() => f.host.listApprovals("main").some((row) => row.status === "pending"), "the second confirmation");
  f.host.cancel("main");
  expect(await cancelled).toMatchObject({ outcome: "refused", code: "tool-refused:approval-cancelled" });
  expect(f.document()).toBe(before);

  // The real broker with the production default lowered: an unanswered
  // confirmation expires and performs nothing.
  const expiring = brokerWithOptions(f, { approvalTimeoutMs: 120 });
  const expired = expiring.call("main", { tool: TOOL, args: editArgs(f.serviceId, "hello-expired") });
  await until(() => f.host.listApprovals("main").some((row) => row.status === "pending"), "the expiring confirmation");
  expect(await expired).toMatchObject({ outcome: "refused", code: "tool-refused:approval-expired" });
  expect(f.document()).toBe(before);
  // Three refusals, three byte-identical documents, and no revision was minted.
  expect(f.versions()).toEqual({ pinned: 1, latest: 1, otherPinned: 1 });
  expect(JSON.parse(f.document()).revisions).toHaveLength(2);
});

it("refuses the edit by name in a read-only session and leaves the document byte-identical", { timeout: 30_000 }, async () => {
  const f = await harness();
  f.host.setPermission("main", "read");
  const before = f.document();
  const refused = await refusedPromptly(f.call(editArgs(f.serviceId, "hello-readonly")));
  expect(refused.outcome).toBe("refused");
  expect(refused.code).toBe("tool-refused:gate-denied");
  expect(refused.text).toContain("只读");
  expect(f.document()).toBe(before);
  expect(f.host.listApprovals("main").some((row) => row.status === "pending")).toBe(false);
});

it("refuses a service this task has not bound, a retargeting argument, and an unbound channel", { timeout: 30_000 }, async () => {
  const f = await harness();
  const before = f.document();
  // A service id no binding of this task names (it exists on another project's
  // revision space in this store too): refused by name, nothing written.
  expect(await refusedPromptly(f.call(editArgs("s-99999999-9999-4999-8999-999999999999", "x")))).toMatchObject({ outcome: "refused", code: "tool-refused:unknown-service" });
  // (m4) The Agent may not name a project, an environment, a version or a task:
  // every one of them is an unknown argument, refused before main is reached.
  for (const smuggled of [{ projectId: f.projectId }, { environmentId: f.environmentId }, { expectedVersion: 1 },
    { taskId: f.otherTaskId }, { path: "/etc/passwd" }, { program: "/bin/sh" }]) {
    expect(await refusedPromptly(f.call(editArgs(f.serviceId, "hello-smuggled", smuggled))))
      .toMatchObject({ outcome: "refused", code: "tool-refused:invalid-arguments" });
  }
  // A malformed edit (rows that are not rows) is refused at the tool boundary.
  expect(await f.call({ ...editArgs(f.serviceId, "x"), shared: ["not-a-row"] })).toMatchObject({ code: "tool-refused:invalid-arguments" });
  // A Host whose main mounted no template channel refuses by name, never locally.
  const unwired = brokerWithOptions(f, { templates: () => undefined });
  expect(await unwired.call("main", { tool: TOOL, args: editArgs(f.serviceId, "hello-unwired") }))
    .toMatchObject({ outcome: "refused", code: "tool-refused:template-control-unavailable" });
  expect(f.document()).toBe(before);
  expect(f.host.listApprovals("main").some((row) => row.status === "pending")).toBe(false);
});

it("fails closed by name when the task's pinned version is no longer the latest revision", { timeout: 30_000 }, async () => {
  const f = await harness();
  // Someone else edits the shared template first (the human page path), so this
  // task's pin (v1) is stale.
  f.catalog.saveTemplate({ projectId: f.projectId, environmentId: f.environmentId, serviceId: f.serviceId, expectedVersion: 1,
    descriptor: { name: "API a", program: "node", args: ["service.cjs"], ports: [], runType: "long-lived" },
    shared: [{ key: "SERVICE_GREETING", value: "hello-human", secret: false }] });
  const before = f.document();
  expect(f.versions()).toEqual({ pinned: 1, latest: 2, otherPinned: 1 });

  // (m3) The derived expected version IS the binding pin: dropping it (deriving
  // the latest revision instead) lets this edit through and the assertion reds.
  const refused = await refusedPromptly(f.call(editArgs(f.serviceId, "hello-stale")));
  expect(refused).toMatchObject({ outcome: "refused", code: "tool-refused:template-version-conflict" });
  expect(refused.text).toContain("v1");
  expect(f.document()).toBe(before);
  expect(JSON.parse(f.document()).revisions).toHaveLength(3);
  expect(f.host.listApprovals("main").some((row) => row.status === "pending")).toBe(false);
});

it("refuses an approval whose document moved before the confirmation was spent", { timeout: 30_000 }, async () => {
  const f = await harness();
  const call = f.call(editArgs(f.serviceId, "hello-race"));
  await until(() => f.host.listApprovals("main").some((row) => row.status === "pending"), "the confirmation");
  const asked = pending(f);
  // Another writer lands between the shown diff and the confirmation.
  f.catalog.saveTemplate({ projectId: f.projectId, environmentId: f.environmentId, serviceId: f.serviceId, expectedVersion: 1,
    descriptor: { name: "API a", program: "node", args: ["service.cjs"], ports: [], runType: "long-lived" },
    shared: [{ key: "SERVICE_GREETING", value: "hello-human", secret: false }] });
  const afterForeign = f.document();
  f.host.approve("main", asked.id);
  // The write is refused by name: the revision the user saw is not the one on disk.
  expect(await call).toMatchObject({ outcome: "refused", code: "tool-refused:template-version-conflict" });
  expect(f.document()).toBe(afterForeign);
  expect(JSON.parse(f.document()).revisions).toHaveLength(3);
});

it("fails closed with nothing written when the pin is adopted to a newer revision between the review and the approval", { timeout: 30_000 }, async () => {
  const f = await harness();
  const call = f.call(editArgs(f.serviceId, "hello-adopted"));
  await until(() => f.host.listApprovals("main").some((row) => row.status === "pending"), "the confirmation");
  const asked = pending(f);
  expect(f.versions()).toEqual({ pinned: 1, latest: 1, otherPinned: 1 });
  // The page edits the shared template AND adopts the new revision for THIS task
  // while the confirmation is parked. The pin is now the latest again, so the pin
  // alone no longer tells the apply leg that the reviewed base moved: the write
  // would take v2 (with the row the page added there) as its base and drop it.
  f.catalog.saveTemplate({ projectId: f.projectId, environmentId: f.environmentId, serviceId: f.serviceId, expectedVersion: 1,
    descriptor: { name: "API a", program: "node", args: ["service.cjs"], ports: [], runType: "long-lived" },
    shared: [{ key: "SERVICE_GREETING", value: "hello-human", secret: false }, { key: "SERVICE_PAGE_ROW", value: "kept", secret: false }] });
  f.catalog.adoptTaskBinding({ projectId: f.projectId, taskId: f.taskId, serviceId: f.serviceId, templateVersion: 2 });
  const afterPage = f.document();
  expect(f.versions()).toEqual({ pinned: 2, latest: 2, otherPinned: 1 });

  f.host.approve("main", asked.id);
  // The pin the user confirmed the diff against is gone: refused by name, and
  // NOTHING lands - v2 and its page-added row survive byte-identically.
  expect(await call).toMatchObject({ outcome: "refused", code: "tool-refused:template-version-conflict" });
  expect(f.document()).toBe(afterPage);
  expect(f.versions()).toEqual({ pinned: 2, latest: 2, otherPinned: 1 });
  expect(JSON.parse(f.document()).revisions).toHaveLength(3);
});

it("cannot spend an auto-minted confirmation after the session tier changed", { timeout: 30_000 }, async () => {
  const f = await harness();
  f.host.setPermission("main", "auto");
  const before = f.document();
  const call = f.call(editArgs(f.serviceId, "hello-tier-change"));
  await until(() => f.host.listApprovals("main").some((row) => row.status === "pending"), "the confirmation");
  const asked = pending(f);
  // The tier the confirmation was minted for is gone: a confirmation must never
  // be spent under a tier the user did not confirm for it.
  f.host.setPermission("main", "default");
  f.host.approve("main", asked.id);
  expect(await call).toMatchObject({ outcome: "refused" });
  expect(f.document()).toBe(before);
  expect(f.versions().latest).toBe(1);
});

it("keeps the other task's pin and leaves the running child untouched", { timeout: 30_000 }, async () => {
  const f = await harness();
  f.host.setPermission("main", "auto");
  const started = await f.callTool("service.start", { serviceId: f.serviceId });
  // win32 (#7/#48): the "running child" this case protects comes from the
  // capability that is unbuilt on win32, where `service.start` is refused by its
  // own NAME because no Host-owned process tree exists to own, verify or stop.
  // So win32 pins that refusal, then runs the edit flow the case is really
  // about: an edit that neither started nor signalled anything is exactly what
  // it must prove on a platform that has no child to leave untouched. The POSIX
  // legs observing that same child before and after the edit stay byte-intact.
  if (process.platform === "win32") {
    expect(started).toMatchObject({ outcome: "refused", code: "tool-refused:unsupported-platform" });
    expect(markerPid(f.taskDir)).toBeUndefined();
    const beforeWin32 = f.document();
    const callWin32 = f.call(editArgs(f.serviceId, "hello-running"));
    await until(() => f.host.listApprovals("main").some((row) => row.status === "pending"), "the confirmation");
    expect(f.document()).toBe(beforeWin32);
    f.host.approve("main", pending(f).id);
    expect((await callWin32).outcome).toBe("ok");
    // Nothing was started or signalled by the edit either: the process the
    // refused start never created is still not there, so the running-instance
    // facts below (its pid, its `launchSource`, its restart-needed list) have no
    // subject on win32 and are left to the POSIX legs that can observe one.
    expect(markerPid(f.taskDir)).toBeUndefined();
    expect(f.versions()).toEqual({ pinned: 1, latest: 2, otherPinned: 1 });
    return;
  }
  expect(started.outcome).toBe("ok");
  await until(() => markerPid(f.taskDir) !== undefined, "the service child to report its pid");
  const pid = markerPid(f.taskDir)!;
  expect(alive(pid)).toBe(true);
  const before = f.document();

  const call = f.call(editArgs(f.serviceId, "hello-running"));
  await until(() => f.host.listApprovals("main").some((row) => row.status === "pending"), "the confirmation");
  expect(f.document()).toBe(before);
  f.host.approve("main", pending(f).id);
  const outcome = await call;
  expect(outcome.outcome).toBe("ok");

  // The real child is the same process, and the running instance still resolves
  // the revision it was started with: an edit never restarts anything.
  expect(markerPid(f.taskDir)).toBe(pid);
  expect(alive(pid)).toBe(true);
  const status = await f.callTool("service.status", { serviceId: f.serviceId });
  expect(status.text).toContain("lifecycle: running");
  expect(status.text).toContain("launchSource: catalog (template v1)");
  expect(publicServiceStatus(f.surface.services.get(f.serviceId)!).lastControl).toEqual({ action: "start", actor: "agent", label: "main" });
  // Every OTHER task keeps its own pin; only the shared revision moved.
  expect(f.versions()).toEqual({ pinned: 1, latest: 2, otherPinned: 1 });
  expect(outcome.text).toContain("需重启项");
});

it("edits a bound service this task has never started and claims no process action", { timeout: 30_000 }, async () => {
  const f = await harness({ register: false });
  // The task's service runtime holds nothing: a never-run bound service is
  // exactly the case this tool must still reach, because main owns the answer
  // to "did this task bind this service".
  expect(f.surface.services.ids()).toEqual([]);
  f.host.setPermission("main", "auto");
  const before = f.document();
  const call = f.call(editArgs(f.serviceId, "hello-unstarted"));
  await until(() => f.host.listApprovals("main").some((row) => row.status === "pending"), "the confirmation");
  expect(f.document()).toBe(before);
  f.host.approve("main", pending(f).id);
  const outcome = await call;
  expect(outcome).toMatchObject({ outcome: "ok" });
  expect(f.versions().latest).toBe(2);
  expect(outcome.text).toContain("未启动、停止或重启任何进程。");
  // Nothing was registered as a side effect: the service tools still answer from
  // this task's own runtime.
  expect(await f.callTool("service.status", { serviceId: f.serviceId }))
    .toMatchObject({ outcome: "refused", code: "tool-refused:unknown-service" });
});

it("declares the template tool in both lists, with the edit content as its whole argument surface", { timeout: 30_000 }, async () => {
  for (const name of SDK_AGENT_TOOL_NAMES) expect(PI_GATED_TOOL_NAMES).toContain(name);
  expect(SDK_AGENT_TOOL_NAMES).toContain(TOOL);
  expect(PI_GATED_TOOL_NAMES).toContain(TOOL);

  // A request envelope that smuggles a project/environment/version is refused by
  // the wire guard itself, before any handler runs.
  const smuggled: ServiceTemplateRequestParams = { workspaceId: "workspace-a", taskId: "task-a", op: "review",
    edit: { serviceId: "s-1", descriptor: {}, shared: [], projectId: "p-other" } as never };
  expect(isServiceTemplateRequest({ kind: "service-template-request", id: "x", params: smuggled })).toBe(false);
});
