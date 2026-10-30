/**
 * utilityProcess entry: per-task-workspace Node Host ([PiDock 02] #5).
 *
 * Runs as plain Node (no Chromium, no renderer, no CDP). Speaks the typed
 * `host/*` RPC protocol over the parent port and nothing else. `host/ping`
 * and `host/getVersions` prove the process boundary; `host/task` routes
 * task-scoped ops (provision/sendMessage/cancel/approve/reject) with the
 * same runtime payload validation main enforces. The Host never trusts a
 * renderer-chosen workspace: the routed ids must equal the Host's own
 * workspace binding.
 */

// Runs only inside utilityProcess: `process.parentPort` exists there and
// nowhere else (plain node has no such property). It is NOT exported from
// the `electron` module — it hangs off the Node `process` object.
interface UtilityParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
}

function getParentPort(): UtilityParentPort {
  const candidate = (process as unknown as Record<string, unknown>)["parentPort"];
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof (candidate as UtilityParentPort).postMessage !== "function" ||
    typeof (candidate as UtilityParentPort).on !== "function"
  ) {
    throw new Error("[host] no parent port: must run inside utilityProcess");
  }
  return candidate as UtilityParentPort;
}

const hostPort = getParentPort();
let started = false;

import {
  authorizeCodeObservation,
  authorizeServiceRegistration,
  boundWorkspaceId,
  buildTerminalEnv,
  classifyControlCaller,
  resolveBrowserLogSession,
  routeHostTask,
  serviceExecutionAdmitted,
  serviceLaunchSource,
  validateHostTaskOp,
} from "./host-guards.js";
import { ServiceOwnerInventory, unverifiedServiceOwnerInventoryResource } from "./service-owner-inventory.js";
import { SERVICE_STOP_CONFIRM_MS, SERVICE_STOP_GRACE_MS, TaskServiceProcesses } from "./service-processes.js";
import { diskServiceOwnershipLog } from "./service-ownership.js";
import { diskLaunchVerificationLog } from "./service-launch-verification.js";
import { serviceOwnerBootstrap, serviceOwnerRebind, type ServiceOwnerBootstrap, type ServiceOwnerCompletion } from "../rpc/service-host-binding.js";
import { TaskWorkspaceHost, diskTaskStore } from "./task-host.js";
import { SdkTurnTransport } from "./sdk-turn-transport.js";
import type { PromptContextEntry } from "./sdk-prompt-context.js";
import { validateExplicitTextProvider } from "./explicit-text-provider.js";
import { PiSdkTextKernel } from "./sdk-text-kernel.js";
import type { ServiceRunObservation } from "../main/execution-ledger.js";
import { SharedPathCoordinator } from "./path-coordination.js";
import { TaskServiceRuntime } from "./service-runtime.js";
import { runAgentServiceControl, runHumanServiceControl, type ServiceExecutionDriver } from "./service-control.js";
import { runServiceGroupStart, type GroupUnitStartResult, type ServiceGroupRunResult } from "./service-group-run.js";
import { tcpObservation } from "./service-linkage.js";
import type { SdkAgentServiceHost } from "./sdk-agent-tool-broker.js";
import { scanTaskServiceImportHints } from "./service-import.js";
import { publicServiceStartPreview, publicServiceStatus } from "./service-public.js";
import { probeServiceHealth } from "./service-health-probe.js";
import { declaredServicePorts } from "../main/service-config.js";
import { TaskServiceTopology, attemptRunBookkeeping } from "./service-topology.js";
import { TaskProtocolBinding } from "./protocol-binding.js";
import { shutdownDeadline } from "./shutdown-deadline.js";
import { HostTaskAdmission } from "./host-task-admission.js";
import { protectApplicationProfile, type TaskPathProtection } from "./protected-application-path.js";
import { TaskWorkspaceFiles } from "./workspace-files.js";
import { openExternalEditor } from "./open-editor.js";
import { TaskTerminalRegistry, planTerminal, type TerminalPlan } from "../main/terminal-config.js";
import { resolveHostShellProfiles, terminalLaunchFromRecord, terminalProfilesPayload } from "./terminal-profiles.js";
import { TaskLifecycleHost } from "./task-lifecycle.js";
import { createLifecycleResources } from "./lifecycle-resources.js";
import { runAgentTerminalControl } from "./terminal-control.js";
import { ptySpawnerAvailable, TerminalPtyDriver, resolvePtyRuntime } from "./terminal-pty-driver.js";
import { TaskTerminalSessions } from "./terminal-sessions.js";
import { writeClaimError } from "./write-coordination.js";
import { runAgentBrowserAction, runHumanBrowserAction, type BrowserGatewayPort } from "./browser-control.js";import { HostBrowserClient } from "../rpc/browser-client.js";
import { ServiceTemplateRequestClient, type ServiceTemplateEditPort } from "../rpc/service-template-request.js";
import { isBrowserAction } from "../main/browser-rules.js";
import type { RemoteEntryMode, RemotePendingRequest } from "../main/remote-rules.js";
import {
  isHostTaskParams,
  isRpcRequest,
  type HostPingResult,
  type HostTaskResult,
  type HostVersionsResult,
  type RpcResponse,
  type TaskOpOrigin,
} from "../rpc/protocol.js";

/** Editable schedule fields; anything else in the payload is an extra key. */
const SCHEDULE_SAVE_KEYS = [
  "scheduleId",
  "projectId",
  "name",
  "ruleText",
  "timezone",
  "prompt",
  "providerId",
  "model",
  "permission",
  "enabled",
  "sessionId",
  "label",
];

function workspaceOf(params: unknown): string {
  if (
    typeof params === "object" &&
    params !== null &&
    "workspaceId" in params &&
    typeof (params as { workspaceId?: unknown }).workspaceId === "string" &&
    ((params as { workspaceId: string }).workspaceId.length ?? 0) > 0
  ) {
    return (params as { workspaceId: string }).workspaceId;
  }
  return boundWorkspaceId();
}

function reply(response: RpcResponse): void {
  hostPort.postMessage(response);
}

// Single-task Host binding: one utilityProcess serves one task folder.
// `PIDOCK_TASK_ID` selects the task, `PIDOCK_TASK_DIR` its folder; both
// are fixed at fork time so an op naming another task can never continue with it.
// Lazily created on first dispatch so `host/ping` smoke paths that never
// touch tasks do not require the task env.
let workspaceHost: TaskWorkspaceHost | null = null;
let sdkTurns: SdkTurnTransport | null = null;
let sdkClosing = false;
let quitReceipt: Promise<ReturnType<TaskLifecycleHost["quit"]>> | undefined;
let serviceOwnerInventory: ServiceOwnerInventory | null = null;
let serviceScope: ServiceOwnerBootstrap | undefined;
let serviceCompletion: ServiceOwnerCompletion | undefined;
const serviceSubscribers = new Map<string | null, { receive(message: unknown): void; disconnected(): void }>();
function fenceServiceInventory(): void {
  serviceOwnerInventory?.fence();
  for (const subscriber of [...serviceSubscribers.values()]) subscriber.disconnected();
}
function ownerInventoryFor(host: TaskWorkspaceHost): ServiceOwnerInventory {
  return serviceOwnerInventory ??= new ServiceOwnerInventory(boundWorkspaceId(), host.taskId, host.taskDir, host, (scope, serviceId) => ({
    send: (request) => hostPort.postMessage({ kind: "service-owner-request", workspaceId: scope.workspaceId, taskId: scope.taskId,
      instanceId: scope.instanceId, epoch: scope.epoch, catalogRevision: scope.catalogRevision, serviceId, request }),
    subscribe: (receive, disconnected) => {
      if (serviceSubscribers.has(serviceId)) throw Error("service-owner-transport-unconfirmed");
      const subscriber = { receive, disconnected }; serviceSubscribers.set(serviceId, subscriber);
      return () => { if (serviceSubscribers.get(serviceId) === subscriber) serviceSubscribers.delete(serviceId); };
    },
  }));
}
async function handleServiceOwnerMessage(value: unknown): Promise<boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!["service-owner-bootstrap", "service-owner-rebind", "service-owner-ack", "service-owner-fenced"].includes(String(row.kind))) return false;
  try {
    const taskId = process.env["PIDOCK_TASK_ID"] ?? "";
    const host = taskHostFor(taskId); if ("error" in host) throw Error();
    const inventory = ownerInventoryFor(host);
    if (row.kind === "service-owner-bootstrap") {
      const scope = serviceOwnerBootstrap(value, boundWorkspaceId(), taskId);
      if (serviceScope) throw Error();
      serviceScope = scope;
      await inventory.bootstrap(scope);
      hostPort.postMessage({ kind: "service-owner-ready", workspaceId: scope.workspaceId, taskId: scope.taskId,
        instanceId: scope.instanceId, epoch: scope.epoch, catalogRevision: scope.catalogRevision });
    } else if (row.kind === "service-owner-rebind") {
      // [PiDock 04] (#7 slice) one explicit in-place replacement of this Host's
      // owner scope. Main may only name the instance this Host holds; the
      // replacement instance differs, so this cannot replay the scope it
      // replaces. The replaced inventory is sealed and its transport released
      // before the replacement subscribes - it owns no admissible child (the
      // managed binding is closed), so nothing running is killed or orphaned -
      // and a failure leaves this Host's owner state fenced and diagnosable.
      const previous = serviceScope;
      if (!previous) throw Error();
      const scope = serviceOwnerRebind(value, boundWorkspaceId(), taskId, previous.instanceId);
      const replaced = inventory;
      replaced.seal();
      fenceServiceInventory();
      for (const subscriber of [...serviceSubscribers.values()]) subscriber.disconnected();
      serviceSubscribers.clear();
      serviceOwnerInventory = null;
      serviceScope = scope;
      await ownerInventoryFor(host).bootstrap(scope);
      hostPort.postMessage({ kind: "service-owner-ready", workspaceId: scope.workspaceId, taskId: scope.taskId,
        instanceId: scope.instanceId, epoch: scope.epoch, catalogRevision: scope.catalogRevision });
    } else if (row.kind === "service-owner-fenced") {
      if (Object.keys(row).sort().join(",") !== "kind,taskId,workspaceId" || row.workspaceId !== boundWorkspaceId() || row.taskId !== taskId) throw Error();
      fenceServiceInventory();
    } else {
      const scope = serviceScope;
      if (!scope || Buffer.byteLength(JSON.stringify(value)) > 8192 || Object.keys(row).sort().join(",") !== "catalogRevision,epoch,instanceId,kind,reply,serviceId,taskId,workspaceId" ||
          row.workspaceId !== scope.workspaceId || row.taskId !== scope.taskId || row.instanceId !== scope.instanceId || row.epoch !== scope.epoch || row.catalogRevision !== scope.catalogRevision ||
          row.serviceId !== null && typeof row.serviceId !== "string") throw Error();
      const subscriber = serviceSubscribers.get(row.serviceId as string | null); if (!subscriber) throw Error();
      subscriber.receive(row.reply);
    }
  } catch { fenceServiceInventory(); }
  return true;
}

const taskAdmission = new HostTaskAdmission();
let sdkKernelFactory: (taskId: string, taskDir: string) => PiSdkTextKernel = (id, dir) => new PiSdkTextKernel(id, dir);

// [PiDock 09] (#11) cross-task real-path write coordination. One table for the
// whole Host process: plain-directory links are shared views of the original
// files, so two task folders writing the same resolved path (or an ancestor of
// it) must serialize even though each task has its own write right.
const sharedPaths = new SharedPathCoordinator();

// [PiDock 04] (#7) per-task service runtime, sibling to the workspace
// Host above: same fork binding (PIDOCK_TASK_ID/PIDOCK_TASK_DIR), no new
// process, no renderer trust change. Lazily created with the same guard.
let serviceRuntime: TaskServiceRuntime | null = null;

// [PiDock 05] (#10) per-task multi-service topology (units, ports,
// bindings, start groups, run records, stop scope). Same fork binding and
// lifetime as the runtime above; no separate process and no new trust.
let serviceTopology: TaskServiceTopology | null = null;

function serviceTopologyFor(taskId: string): TaskServiceTopology | { error: string } {
  const host = taskHostFor(taskId);
  if ("error" in host) return host;
  if (!serviceTopology || serviceTopology.taskDir !== host.taskDir || serviceTopology.taskId !== host.taskId) {
    serviceTopology = new TaskServiceTopology(host.taskId, host.taskDir);
  }
  return serviceTopology;
}

// [PiDock 08] (#14) per-task protocol generation + consumer binding state.
// Same fork binding and lifetime as the topology above; the plan paths it
// yields are checked against this task folder, so no op can act on another
// task's tree.
let protocolBinding: TaskProtocolBinding | null = null;

// [PiDock 10] (#15) per-task file access and terminal registry. Same fork
// binding and lifetime as the topology above; the file roots come from this
// task's record and every read is bounded + masked before it crosses back.
let workspaceFiles: TaskWorkspaceFiles | null = null;
let applicationPaths: TaskPathProtection | undefined;
function protectedPaths(): TaskPathProtection {
  if (!applicationPaths) applicationPaths = protectApplicationProfile(process.env["PIDOCK_PROTECTED_PROFILE"] ?? "");
  return applicationPaths;
}
let terminalRegistry: TaskTerminalRegistry | null = null;
/**
 * Task/private values seen in a registered service's private layer: previews
 * and diffs are scrubbed with them, so a credential stored for a service can
 * never be echoed back through the file panel.
 */
const privateSecretValues = new Set<string>();

function workspaceFilesFor(taskId: string): TaskWorkspaceFiles | { error: string } {
  const host = taskHostFor(taskId);
  if ("error" in host) return host;
  if (!workspaceFiles || workspaceFiles.taskDir !== host.taskDir || workspaceFiles.taskId !== host.taskId) {
    workspaceFiles = new TaskWorkspaceFiles(host.taskId, host.taskDir, host.store, undefined, () => [...privateSecretValues], protectedPaths());
  }
  return workspaceFiles;
}

function terminalRegistryFor(taskId: string): TaskTerminalRegistry | { error: string } {
  const host = taskHostFor(taskId);
  if ("error" in host) return host;
  if (!terminalRegistry || terminalRegistry.taskId !== host.taskId) {
    terminalRegistry = new TaskTerminalRegistry(host.taskId);
  }
  return terminalRegistry;
}

// [PiDock 10] (#15) the real PTY spawner. One driver per Host process holds the
// forked helpers (the native node-pty addon never loads in the Host), and one
// sessions object writes the registry above. Both bind to the same task as the
// registry they serve, so an output frame or a stop can only ever address this
// task's own instances.
let terminalDriver: TerminalPtyDriver | null = null;
let terminalSessions: TaskTerminalSessions | null = null;
function terminalSessionsFor(taskId: string): TaskTerminalSessions | { error: string } {
  const registry = terminalRegistryFor(taskId);
  if ("error" in registry) return registry;
  if (!terminalSessions || terminalSessions.registry !== registry) {
    terminalDriver ??= new TerminalPtyDriver({
      workspaceId: registry.taskId,
      runtime: resolvePtyRuntime,
      onOutput: (identity, sequence, data) => terminalSessions?.ingest(identity, sequence, data),
    });
    terminalSessions = new TaskTerminalSessions(registry, terminalDriver, () => [...privateSecretValues]);
  }
  return terminalSessions;
}

// [PiDock 14] (#17) per-task lifecycle state (archive/restore/cleanup records +
// resource identity verification). Same fork binding and lifetime as the
// registries above; it reads its own task record, so no op can name another
// task's folder or a renderer-chosen path.
let taskLifecycle: TaskLifecycleHost | null = null;

function lifecycleFor(taskId: string): TaskLifecycleHost | { error: string } {
  const host = taskHostFor(taskId);
  if ("error" in host) return host;
  if (!taskLifecycle || taskLifecycle.taskDir !== host.taskDir || taskLifecycle.taskId !== host.taskId) {
    taskLifecycle = new TaskLifecycleHost(
      host.taskId,
      host.taskDir,
      host.store,
      createLifecycleResources({
        host,
        services: () => {
          const topology = serviceTopologyFor(host.taskId);
          return "error" in topology ? null : topology;
        },
        terminals: () => {
          const terminals = terminalRegistryFor(host.taskId);
          return "error" in terminals ? null : terminals;
        },
        sessionIds: () => host.sessionIds(),
      }),
    );
  }
  return taskLifecycle;
}

/**
 * [PiDock 10] (#15) plan one built-in terminal for the addressed root: the
 * caller's kind decides the owner label, a `read` agent session is refused
 * before anything is planned (box 8), and the returned display plan keeps only
 * masked env rows — the real child env stays in `raw` for the Host registry.
 */
function terminalPlanFor(
  host: TaskWorkspaceHost,
  files: TaskWorkspaceFiles,
  record: Record<string, unknown>,
  caller: ReturnType<typeof classifyControlCaller>,
): { ok: true; plan: Omit<TerminalPlan, "env">; raw: TerminalPlan } | { ok: false; error: string } {
  if (!caller.ok) return { ok: false, error: caller.error };
  let owner: TerminalPlan["owner"];
  if (caller.kind === "agent") {
    const permission = host.permissionOf(caller.sessionId);
    if (permission === null) return { ok: false, error: `unknown-session: ${caller.sessionId} 不是本任务的会话` };
    if (permission === "read") {
      return { ok: false, error: "read 权限不提供终端与命令执行入口；请在会话中提升权限或改用人工操作" };
    }
    owner = { taskId: host.taskId, sessionId: caller.sessionId, label: `会话 ${caller.sessionId}` };
  } else {
    owner = { taskId: host.taskId, sessionId: null, label: caller.label };
  }
  const layers = record["layers"];
  // (#85) The caller names a shell PROFILE, never a shell string: main resolves
  // the profile's own program + argv from the platform table
  // (`main/terminal-config.ts`, probed by `./terminal-profiles.ts`). A record
  // that names neither a profile nor an explicit program is refused here rather
  // than defaulted, and a profile this host cannot run is refused by name with
  // the executable that was probed - never replaced by another shell.
  const launch = terminalLaunchOf(record);
  if (!launch.ok) return { ok: false, error: launch.error };
  const planned = planTerminal({
    roots: files.roots(),
    taskId: host.taskId,
    taskDir: host.taskDir,
    rootId: record["rootId"],
    relative: record["relative"],
    program: launch.program,
    args: launch.args,
    programSource: launch.programSource,
    layers: (layers as never) ?? { repoDefaults: [], shared: [], privateEntries: [], task: [] },
    cols: record["cols"],
    rows: record["rows"],
    owner,
    instanceId: String(record["instanceId"]),
    secrets: [...privateSecretValues],
  });
  if (!planned.ok) return { ok: false, error: planned.error };
  planned.plan.env = buildTerminalEnv(process.env, planned.plan.env);
  const { env, ...display } = planned.plan;
  void env;
  return { ok: true, plan: display, raw: planned.plan };
}

/**
 * Resolve the terminal launch a plan or start record asks for, and hand
 * `planTerminal` the provenance of its program.
 *
 * All of it lives in `./terminal-profiles.ts`: a record names a shell PROFILE id
 * (the renderer never names a shell), and main resolves that profile's own
 * program + argv, re-probing it on disk. The explicit `program`/`args` channel
 * stays exactly what #7 defined it as (an argv array whose blank/inline-env/
 * chaining/whitespace forms `planTerminal` refuses).
 */
function terminalLaunchOf(record: Record<string, unknown>): ReturnType<typeof terminalLaunchFromRecord> {
  return terminalLaunchFromRecord(record);
}

function protocolBindingFor(taskId: string): TaskProtocolBinding | { error: string } {
  const host = taskHostFor(taskId);
  if ("error" in host) return host;
  if (!protocolBinding || protocolBinding.taskDir !== host.taskDir || protocolBinding.taskId !== host.taskId) {
    protocolBinding = new TaskProtocolBinding(host.taskId, host.taskDir);
  }
  return protocolBinding;
}

/**
 * [PiDock 08] (#14) box 6: the protocol state needs to know which artifact
 * version a *running* instance really loaded. #10's run records carry that
 * observation (`protocolArtifact`); a record without it stays `null`=「未验证」,
 * so a stale instance is never counted as having loaded the new artifact.
 * Runs of services that are not protocol consumers are ignored here.
 */
function protocolRunsFor(taskId: string, binding: TaskProtocolBinding): Parameters<TaskProtocolBinding["state"]>[0] {
  const topology = serviceTopologyFor(taskId);
  if ("error" in topology) return [];
  const byService = new Map(
    binding
      .state()
      .consumers.filter((consumer): consumer is typeof consumer & { serviceId: string } => consumer.serviceId !== undefined)
      .map((consumer) => [consumer.serviceId, consumer.consumerId] as const),
  );
  return topology
    .runs()
    .filter((record) => record.endedAt === undefined)
    .flatMap((record) => {
      const consumerId = byService.get(record.serviceId);
      if (consumerId === undefined) return [];
      return [{ consumerId, runId: record.runId, loadedVersion: record.protocolArtifact?.version ?? null, running: true }];
    });
}

function serviceRuntimeFor(taskId: string): TaskServiceRuntime | { error: string } {
  const host = taskHostFor(taskId);
  if ("error" in host) return host;
  if (!serviceRuntime || serviceRuntime.taskDir !== host.taskDir) {
    // The task workspace's own launch-verification document ([PiDock 04] #7 box
    // 7): without it a verification would live only in this Host's memory and
    // the platform would read as unverified again after every restart.
    serviceRuntime = new TaskServiceRuntime(host.taskDir, undefined, diskLaunchVerificationLog(host.taskDir));
  }
  return serviceRuntime;
}

/**
 * [PiDock 04] (#7) the Host-owned real process driver for this task's
 * registered services: `TaskServiceProcesses` holds the process identity,
 * captures bounded redacted output and stops only its own registered child.
 * It is created next to the runtime (same fork binding, same lifetime) and
 * is reachable only from the gated `task/controlService` path. Windows
 * `start` stays refused inside the driver.
 */
let serviceProcesses: TaskServiceProcesses | null = null;
/**
 * The runtime the current driver was built for. `TaskServiceProcesses` stores
 * the task root's *realpath* while the Host stays bound to the raw
 * `PIDOCK_TASK_DIR` string, so comparing the two paths would mismatch for
 * every non-canonical spelling (`/tmp/...` on macOS, a symlinked home or an
 * override root) and silently rebuild the driver - dropping its
 * running-child map, so a stop answers `not-running`, a second start spawns a
 * duplicate and quit reports a clean stop behind live children. One Host
 * serves exactly one task runtime, so object identity is the correct check.
 */
let serviceProcessesFor: TaskServiceRuntime | null = null;
/** Real terminal state of this task's service children when the Host quit stopped them. */
let serviceStopReport: { serviceId: string; state: "stopped" }[] | undefined;
/** Turn ids the Host aborted before stopping children on quit ([#117] item 3). */
let abortedTurns: string[] | undefined;

/**
 * Normal Host quit stops every real service child this task owns before any
 * durable "closed" report is written. `stopAll` settles every attempt and
 * throws when a stop could not be confirmed, so an uncertain termination
 * fails the quit instead of producing a clean shutdown receipt. Each stop is
 * bounded by the driver (grace + confirm, all services in parallel), and
 * `stopAll` only resolves after a confirmed stop, so every reported id was
 * really stopped - an id with no runtime record is never invented as
 * `exited`.
 */
async function stopRegisteredServiceProcesses(): Promise<{ serviceId: string; state: "stopped" }[]> {
  const processes = serviceProcesses;
  if (!processes) return [];
  const ids = processes.ids();
  await processes.stopAll();
  return ids.map((serviceId) => ({ serviceId, state: "stopped" as const }));
}
function serviceDriverFor(taskId: string, services: TaskServiceRuntime): ServiceExecutionDriver {
  if (!serviceProcesses || serviceProcessesFor !== services) {
    serviceProcesses = new TaskServiceProcesses(
      services.taskDir,
      (serviceId, line) => services.recordOutput(serviceId, line),
      (serviceId, reason) => {
        // A child that ended on its own is no longer a running instance: close
        // its run record before the runtime flips the lifecycle, so the
        // registered tree ([PiDock 05] #10 box 8) never keeps a dead pid. The
        // record is always written before this handler can run - `start`
        // resolves on the spawn event and its caller's continuation drains as a
        // microtask, while the close event is a later macrotask - so a live
        // child cannot be missed here without also being missed by `stop`.
        closeServiceRun(taskId, services, serviceId, reason);
        services.markExited(serviceId, reason);
      },
      (line) => services.redactLine(line),
      SERVICE_STOP_GRACE_MS,
      SERVICE_STOP_CONFIRM_MS,
      // The durable launch identity of this task folder ([PiDock 04] #48).
      // Without it the driver is in-memory only: a detached child that
      // survives an abnormal Host/main exit would be invisible to the
      // durable layer, the next Host would answer `unknown-service` for it,
      // and the following start would spawn a second instance that no PiDock
      // path can stop. With it, a real start persists `(pid, nonce)` before
      // it resolves, a duplicate start is refused while that record
      // verifies, and a surviving recorded launch can be re-verified and
      // stopped by a later Host.
      diskServiceOwnershipLog({ taskId, taskDir: services.taskDir }),
    );
    serviceProcessesFor = services;
  }
  const processes = serviceProcesses;
  return {
    start: async (serviceId, owner) => {
      const plan = services.planRegisteredStart(serviceId);
      const pid = await processes.start(plan);
      // Only a start that really resolved with a child pid reaches this line,
      // and the pid is the driver's own return value - never a caller claim.
      recordServiceRun(taskId, services, plan.serviceId, pid, owner);
      return { pid };
    },
    stop: async (serviceId) => {
      await processes.stop(serviceId);
      closeServiceRun(taskId, services, serviceId, "stopped");
    },
  };
}

/**
 * Start the task's planned group ([PiDock 05] #10 box 4) — the production
 * caller `planStartGroups`/`verifyStepsFor` never had.
 *
 * Group start is a SEQUENCE OVER the existing gated dispatch, not a second
 * gate: every unit's start goes through the same `runHumanServiceControl` /
 * `runAgentServiceControl` the single `task/controlService` path uses, with the
 * same tier rules (a `read` session refuses, `default` parks on a one-shot
 * approval). No unit is spawned, signalled or re-planned here.
 *
 * Observation is real and separate from the plan: a unit's listening state comes
 * from a bounded TCP connect to the address its REGISTRATION declares (never the
 * plan's allocated port, which the launch does not use — see `planRegisteredStart`),
 * and each observation is attached to the unit's own run record through the
 * existing `verifyRun` shape.
 *
 * `start-failed` vs `refused`: the wrapped driver records whether the launch was
 * actually reached, so a gate refusal (before the driver) is `refused` and a
 * driver/launch failure is `start-failed`. The runner never guesses a state from
 * an error string.
 *
 * Reachability: this is the Host's `task/controlService {group:true}` capability,
 * and it has a shipped caller - main's `runTaskServiceGroup`
 * (`../main/runtime.ts`), reached from the dock's 整组启动 through
 * `shell/serviceCatalogOp {op:"runTaskServiceGroup"}`. See `docs/task-graph.md`
 * 「整组启动与真实互验」 for the named boundary (no dependency edge on that
 * route, so 已互验 stays unreachable there).
 */
async function runGroupServiceStart(input: {
  taskId: string;
  services: TaskServiceRuntime;
  topology: TaskServiceTopology;
  host: TaskWorkspaceHost;
  caller: { kind: "human"; label: string } | { kind: "agent"; sessionId: string };
  approvalId: unknown;
}): Promise<{ ok: true; value: ServiceGroupRunResult } | { ok: false; error: string }> {
  const { services, topology, host, caller } = input;
  const channel = caller.kind === "agent" ? host.openSession(caller.sessionId) : undefined;
  const baseDriver = serviceDriverFor(input.taskId, services);
  const startUnit = async ({ serviceId }: { unitId: string; serviceId: string }): Promise<GroupUnitStartResult> => {
    // The SAME precondition the single path applies, from the one shared helper.
    const precondition = catalogControlPrecondition(services, serviceId);
    if (precondition.kind !== "ok") {
      return {
        ok: false,
        kind: "refused",
        error: precondition.kind === "uncertain"
          ? precondition.error
          : `service-execution-unavailable: ${serviceId} 未由可信服务目录登记，无法执行`,
      };
    }
    let driverReached = false;
    let producedPid: number | undefined;
    const driver: ServiceExecutionDriver = {
      start: async (id, owner) => {
        driverReached = true;
        const result = await baseDriver.start(id, owner);
        producedPid = result.pid;
        return result;
      },
      stop: (id, owner) => baseDriver.stop(id, owner),
    };
    const acted = caller.kind === "human"
      ? await runHumanServiceControl({ services, driver, serviceId, action: "start", label: caller.label })
      : await runAgentServiceControl({
          services,
          driver,
          channel: channel as NonNullable<typeof channel>,
          sessionId: caller.sessionId,
          serviceId,
          action: "start",
          ...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
          write: host,
          persist: () => host.store.writeSession(host.taskDir, (channel as NonNullable<typeof channel>).snapshot()),
          executions: host.controlExecutions,
        });
    // The real pid the dispatch produced travels back, so the runner credits the
    // run record this start wrote instead of an older open record for the service.
    if (acted.ok) return producedPid === undefined ? { ok: true } : { ok: true, pid: producedPid };
    if (acted.error.startsWith("approval-required:")) return { ok: false, kind: "approval-required", error: acted.error };
    return { ok: false, kind: driverReached ? "start-failed" : "refused", error: acted.error };
  };
  const value = await runServiceGroupStart({
    topology,
    startUnit,
    observation: tcpObservation,
    // The address the launch is SET UP to bind, from this task's own
    // registration. A unit with no declared socket stays `not-probed`.
    registeredAddress: (serviceId) => {
      const record = services.get(serviceId);
      if (!record) return undefined;
      const [port] = declaredServicePorts(record.descriptor.ports, record.resolved);
      return port === undefined ? undefined : { host: "127.0.0.1", port };
    },
  });
  return { ok: true, value };
}

/**
 * Register the process identity a real start just produced in this task's
 * topology ([PiDock 05] #10 boxes 6/8). Until this slice `task/serviceRunRecords`
 * and `task/serviceStopScope` had no production writer: nothing ever called
 * `recordRun`, so the box-8 read answered empty while real children ran.
 *
 * What is written is deliberately split:
 * - OBSERVED BY MAIN: the code state — the worktree HEAD commit and whether the
 *   working tree is dirty — read by main's own bounded git read of the launch's
 *   verified cwd (`main/service-code-observation.ts`) and carried here by the
 *   trusted-catalog registration. Absent stays `unknown` by name: this Host
 *   cannot read a working tree, so it never fills the field in from a guess.
 * - OBSERVED HERE: the pid and the start time the `TaskServiceProcesses` start
 *   resolved with, and the actor the gate decided for.
 * - DECLARED: the port list, taken from the registration's own descriptor plus
 *   its own `PORT`-like resolved rows (`declaredServicePorts`). This Host owns
 *   no port probe, so the record says `portsSource: "declared"`.
 * - NOT READ: build freshness has no observation behind it — nothing in the
 *   service model names a build artifact or its commit — so `buildCommit` is
 *   never claimed and a clean tree reads 无法判断构建状态. A dirty tree reads
 *   `uncommitted-code` from the same observation, never `fresh`.
 * A registration whose read failed puts its named reason in this service's
 * bounded log instead of a code state, so `task/serviceRunRecords` showing
 * `unknown` while the failure is invisible cannot happen.
 * `recordRun` builds its own `startedAt`/`runId` so the record cannot be
 * back-dated by this caller.
 */
function recordServiceRun(
  taskId: string,
  services: TaskServiceRuntime,
  serviceId: string,
  pid: number,
  owner: "agent" | "human",
): void {
  const topology = serviceTopologyFor(taskId);
  if ("error" in topology) return;
  const registered = services.get(serviceId);
  // The failure to read the worktree is named in this service's own bounded log
  // (`task/serviceLog`), exactly like a refused bookkeeping write below: the run
  // record then says `unknown` and the reader can see WHY instead of reading an
  // absent observation as a clean tree.
  if (registered?.codeObservationFailure !== undefined) {
    services.recordOutput(serviceId, `代码状态未观测：${registered.codeObservationFailure}；本次运行记录按 unknown 记录`);
  }
  // The topology record is a read model, never the launch's authority: a refused
  // record must not turn a child that really started into a failure. It is NOT
  // swallowed either - the named refusal lands in this service's own bounded log
  // (`task/serviceLog`), so `task/serviceRunRecords` answering empty while a
  // child runs is visible instead of silent.
  const outcome = attemptRunBookkeeping(() =>
    topology.recordRun({
      serviceId,
      templateVersion: registered?.templateVersion ?? "unknown",
      ports: declaredServicePorts(registered?.descriptor.ports ?? [], registered?.resolved ?? []),
      portsSource: "declared",
      ...(registered?.code !== undefined ? { code: registered.code } : {}),
      pid,
      owner,
    }),
  );
  if (!outcome.ok) services.recordOutput(serviceId, `运行记录写入被拒绝：${outcome.reason}`);
}

/** Close the newest still-open run of one service; `false` when none was open. */
function closeServiceRun(taskId: string, services: TaskServiceRuntime, serviceId: string, reason: string): boolean {
  const topology = serviceTopologyFor(taskId);
  if ("error" in topology) return false;
  const open = [...topology.runs()].reverse().find((record) => record.serviceId === serviceId && record.endedAt === undefined);
  if (!open) return false;
  // Same boundary as `recordServiceRun`: a bookkeeping refusal never changes the
  // action that really happened, but it is named and logged, not swallowed.
  const outcome = attemptRunBookkeeping(() => topology.exitRun(open.runId, reason));
  if (!outcome.ok) services.recordOutput(serviceId, `运行记录关闭被拒绝：${outcome.reason}`);
  return outcome.ok;
}

/**
 * [PiDock 04] (#7 box 5) the Agent's service surface for one task: the SAME
 * `TaskServiceRuntime` the `task/registerService|serviceStatus|serviceLog` ops
 * answer from, the SAME `TaskServiceProcesses` driver `task/controlService`
 * uses (one registered-child map, so an Agent stop reaches the child a human
 * start spawned and never a second instance), the same durable-owner
 * uncertainty check, and this task's execution ledger. `taskHostFor` hands it
 * to `TaskWorkspaceHost`, which passes it to the Agent tool broker; exported so
 * the production wiring is what tests and callers drive, never a copy.
 */
export function agentServiceHostFor(taskId: string): SdkAgentServiceHost | undefined {
  const host = taskHostFor(taskId);
  if ("error" in host) return undefined;
  const services = serviceRuntimeFor(taskId);
  if ("error" in services) return undefined;
  return {
    services,
    driver: () => serviceDriverFor(taskId, services),
    refusal: (serviceId) => serviceOwnerStateRefusal(serviceId),
    executions: host.controlExecutions,
  };
}

/**
 * Durable service state stays authoritative for uncertainty: a service the
 * installed owner inventory already recorded as starting/running/stopping/
 * unconfirmed must not be re-launched as if nothing were known about it, and
 * a fresh runtime process must not hide that state behind `stopped`.
 *
 * The refusal also covers the two ways the durable owner *cannot answer*,
 * both of which the pre-slice Host answered fail-closed: a task Host forked
 * with `PIDOCK_SERVICE_OWNER_REQUIRED` that never received main's bootstrap
 * (catalog/store/lease failure, or a fence before the bootstrap), and an
 * inventory that is fenced or otherwise declines the status call. Only
 * `unknown-service` - an id the durable scope never listed - is not
 * uncertainty: a freshly bound catalog service legitimately has no durable
 * entry yet.
 *
 * The same check covers `stop`, so an uncertain durable state has no
 * Host-side cleanup path: that is deliberate - stopping could signal a
 * process the durable owner still owns, and the uncertainty has to be
 * resolved in the owner layer first. A confirmed `stopped`/`exited` state, a
 * registerable catalog service and an inventory that answers `unknown-service`
 * are the only ways control proceeds.
 */
function serviceOwnerStateRefusal(serviceId: string): string | null {
  if (!serviceOwnerInventory) {
    return process.env["PIDOCK_SERVICE_OWNER_REQUIRED"] === "1"
      ? "service-execution-uncertain: 服务所有者状态未确认"
      : null;
  }
  const status = serviceOwnerInventory.status(serviceId);
  if (!status.ok) {
    return status.error === "unknown-service" ? null : `service-execution-uncertain: ${status.error}`;
  }
  const state = (status.service as { state?: unknown }).state;
  if (state === "stopped" || state === "exited") return null;
  return `service-execution-uncertain: 服务已登记状态为 ${String(state)}，请先处理该状态后再启停`;
}

/**
 * The precondition BOTH service-control paths share before a catalog service may
 * be launched: it must come from the trusted catalog, and its durable owner
 * state must not be uncertain. `kind` says which rule failed so each caller can
 * keep its own refusal wording - the single `task/controlService` path falls back
 * to the owner inventory for an unregistered id, the group path refuses it by
 * name; both fail closed, and neither re-implements the rule.
 */
function catalogControlPrecondition(
  services: TaskServiceRuntime,
  serviceId: string,
): { kind: "ok" } | { kind: "unregistered" } | { kind: "uncertain"; error: string } {
  const registered = services.get(serviceId);
  if (!registered || registered.launchSource !== "catalog") return { kind: "unregistered" };
  const uncertain = serviceOwnerStateRefusal(serviceId);
  return uncertain === null ? { kind: "ok" } : { kind: "uncertain", error: uncertain };
}

function taskHostFor(taskId: string): TaskWorkspaceHost | { error: string } {
  const boundTaskId = process.env["PIDOCK_TASK_ID"];
  const taskDir = process.env["PIDOCK_TASK_DIR"];
  // Pure, unit-tested form of this rule is `routeTaskBinding` in
  // `host-guards.ts` (this file needs a utilityProcess parent port).
  if (typeof boundTaskId !== "string" || boundTaskId.length === 0) {
    return { error: "task-unbound: Host has no PIDOCK_TASK_ID/PIDOCK_TASK_DIR binding" };
  }
  if (typeof taskDir !== "string" || taskDir.length === 0) {
    return { error: "task-unbound: Host has no PIDOCK_TASK_ID/PIDOCK_TASK_DIR binding" };
  }
  if (taskId !== boundTaskId) {
    return { error: "task-unknown: this Host serves a different task" };
  }
  try { protectedPaths().assert(taskDir); }
  catch { return { error: "protected-application-path: 任务目录或应用私有目录身份不可用" }; }
  if (!workspaceHost || workspaceHost.taskId !== boundTaskId || workspaceHost.taskDir !== taskDir) {
    // [PiDock 09] (#11) write coordination reads the service runtime's
    // still-running agent-owned services lazily (the runtime is created on
    // first service op, after this closure exists).
    workspaceHost = new TaskWorkspaceHost(
      boundTaskId,
      taskDir,
      diskTaskStore,
      undefined,
      () => {
        // #90: a platform with no service execution cannot own a service-owner
        // inventory, so the requirement has no subject there and is treated as
        // the empty set instead of "required but never verifiable" - that
        // reading gated every write on win32. Where execution is admitted the
        // unverified orphan below is still injected, fail-closed as before.
        const owners = serviceOwnerInventory?.resources() ?? (serviceExecutionAdmitted() && process.env["PIDOCK_SERVICE_OWNER_REQUIRED"] === "1"
          ? [unverifiedServiceOwnerInventoryResource()] : []);
        const runtime = serviceRuntime;
        // [PiDock 10] (#15) a running terminal is an agent-owned resource too:
        // its owner session keeps the write right and another session sees it
        // as a leftover while it verifies it. A human-started terminal has no
        // session to coordinate with and is not an orphan.
        const terminals = terminalRegistry && terminalRegistry.taskId === boundTaskId
          ? terminalRegistry.list().filter((instance) => instance.lifecycle === "running").map((instance) => ({
            resourceId: instance.instanceId,
            kind: "process" as const,
            ownerSessionId: instance.owner.sessionId,
            label: `终端 ${instance.instanceId}`,
          }))
          : [];
        if (!runtime || runtime.taskDir !== taskDir) return [...owners, ...terminals];
        return [...owners, ...runtime.runningAgentOwned().map((service) => ({
          resourceId: service.serviceId,
          kind: "service" as const,
          ownerSessionId: service.ownerSessionId,
          label: service.serviceId,
        })), ...terminals];
      },
      sharedPaths,
      undefined,
      undefined,
      sdkKernelFactory,
      undefined,
      protectedPaths(),
      // [PiDock 04] (#7 box 5): the Agent's service tools get this task's own
      // runtime + driver + owner check lazily, so the model can start/stop a
      // task-bound service only through the one gate and the one driver.
      () => agentServiceHostFor(boundTaskId),
      // [PiDock 04] (#7 box 6): the shared-template edit is main's write, so the
      // Agent's tool asks main for the review and for the save; a Host without
      // this port refuses the tool by name.
      () => serviceTemplateEditPortFor(boundTaskId),
    );
  }
  return workspaceHost;
}

function asRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

/**
 * Service-side states this Host observed ([PiDock 17] #19 box 2): read from the
 * service runtime of this task (never from a caller claim), so the session state
 * and the service states are reported as two separate families. A task with no
 * runtime yet reports none — that is "no service observed", not "all stopped".
 */
function serviceObservationsFor(taskId: string): ServiceRunObservation[] {
  const runtime = serviceRuntimeFor(taskId);
  if ("error" in runtime) return [];
  return runtime.ids().flatMap((serviceId) => {
    const service = runtime.get(serviceId);
    if (!service) return [];
    return [
      {
        serviceId,
        running: service.lifecycle === "running",
        ...(service.lifecycle !== "running" && service.stoppedAt !== undefined ? { stopped: true } : {}),
      },
    ];
  });
}

/**
 * `repos` is fail-closed: present-but-not-a-string-array (e.g. `[123]`)
 * is an invalid payload, not silently coerced to `[]`.
 */
function asStrictStringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (typeof item !== "string") return null;
  }
  return value as string[];
}

/**
 * `mainCheckouts` is fail-closed: when present it must be a plain object
 * mapping repo names to path strings; anything else (arrays, strings,
 * nested objects) is rejected before it can enter an executable plan.
 */
function isMainCheckouts(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (typeof entry !== "string") return false;
  }
  return true;
}

// [PiDock 06] (#8) browser capability: the Agent Host holds no WebContents,
// so a browser action it has gated becomes one request to main over the
// same parent port `host/*` RPC uses. main owns the visible page and
// re-validates the handle, the navigation allowlist and the takeover state.
let browserClient: HostBrowserClient | null = null;

function browserClientFor(): HostBrowserClient {
  // Utility parent-port events wrap replies; the browser client consumes bare envelopes.
  if (!browserClient) browserClient = new HostBrowserClient({
    postMessage: (message) => hostPort.postMessage(message),
    on: (_event, listener) => { hostPort.on("message", (event: { data: unknown }) => listener(event.data)); },
  }, boundWorkspaceId());
  return browserClient;
}

function browserGatewayFor(taskId: string): BrowserGatewayPort {
  return {
    taskId,
    perform: (request) =>
      browserClientFor().perform({
        taskId,
        action: request.action,
        page: request.page,
        params: request.params,
        actor: request.actor,
      }),
  };
}

// [PiDock 04] (#7 box 6) the shared-template channel: the Agent Host holds
// catalog-derived facts, not the catalog store, so an Agent edit of a SHARED
// template becomes one request to main over the same parent port. main is the
// only writer; `main/service-catalog-ipc.ts` binds the handler to this child's
// own task id, and a Host whose main did not mount the handler is refused BY
// NAME (never a local fallback write).
let serviceTemplateClient: ServiceTemplateRequestClient | null = null;

/** Exported so tests and callers drive the production wiring itself, never a copy (`agentServiceHostFor`'s rule). */
export function serviceTemplateEditPortFor(taskId: string): ServiceTemplateEditPort {
  // Utility parent-port events wrap messages; the client consumes bare envelopes.
  serviceTemplateClient ??= new ServiceTemplateRequestClient({
    postMessage: (message) => hostPort.postMessage(message),
    on: (_event, listener) => { hostPort.on("message", (event: { data: unknown }) => listener(event.data)); },
  }, boundWorkspaceId(), taskId);
  return serviceTemplateClient;
}

/**
 * Session a browser action is logged into when the caller does not name
 * one: the task's persisted sessions are the only ones that exist, so the
 * first is the current single-session conversation ([PiDock 09] #11 will
 * carry an explicit session id once multiple sessions share a task).
 */
/**
 * Async since [PiDock 06] (#8): a browser action is decided in the Host but
 * performed by main (which owns the visible page), so dispatch awaits one
 * bounded round trip. Every other op stays synchronous.
 */
async function dispatchTaskOp(
  taskId: string,
  op: string,
  payload: unknown,
  /** Main-stamped sender attestation (absent on unattested routes). */
  origin?: TaskOpOrigin,
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; error: string }> {
  if (op === "task/quit") return performTaskOp(taskId, op, payload, origin);
  if (sdkClosing && (op.startsWith("task/sdk") || op === "task/sendMessage")) return { ok: false, error: "sdk-host-closing" };
  try { return await taskAdmission.run(() => performTaskOp(taskId, op, payload, origin)); }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : "task-operation-failed" }; }
}

async function performTaskOp(
  taskId: string, op: string, payload: unknown, origin?: TaskOpOrigin,
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; error: string }> {
  const host = taskHostFor(taskId);
  if ("error" in host) return { ok: false, error: host.error };
  const record = asRecord(payload);
  try {
    if (op.startsWith("task/sdk") || op === "task/sendMessage") {
      if (sdkClosing) throw new Error("sdk-host-closing");
      if (!origin || origin.kind !== "shell-ui") throw new Error("permission-denied: SDK turns require a shell sender");
      if (op === "task/sdkProvider") {
        // Installing or clearing the Provider selection must not race a live
        // turn: a journal that is still open means a model request is in
        // flight, and a mid-turn context swap would split one turn across two
        // model identities.
        sdkTurns?.assertTerminalCommitted();
        const provider = record["provider"];
        if (provider === null) {
          await host.configureSdkProvider(null);
          sdkTurns = null;
          return { ok: true, payload: { configured: false } };
        }
        if (typeof provider !== "object" || provider === null || Array.isArray(provider)) throw new Error("invalid-sdk-provider");
        const binding = provider as Record<string, unknown>;
        const result = await host.configureSdkProvider({
          config: validateExplicitTextProvider(binding["config"]),
          credential: binding["credential"] as string,
          workspaceId: boundWorkspaceId(),
        });
        // The transport holds the previous kernel/context; re-create it so the
        // new isolated context serves subsequent turns. Durable journals make
        // this safe: nothing is replayed, and status reads still resolve.
        sdkTurns = null;
        return { ok: true, payload: { configured: true, generation: result.generation } };
      }
      const sessionId = record["sessionId"];
      if (typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(sessionId)) throw new Error("invalid-sdk-session");
      sdkTurns ??= new SdkTurnTransport(taskId, host.taskDir, host.sdkTextKernel());
      if (op === "task/sdkProjection") return { ok: true, payload: sdkTurns.projection(sessionId) };
      if (op === "task/sdkStatus") {
        if (typeof record["requestId"] !== "string") throw new Error("invalid-sdk-request");
        return { ok: true, payload: { turn: sdkTurns.status(sessionId, record["requestId"]) } };
      }
      if (op === "task/sdkStart" || op === "task/sendMessage") {
        if (typeof record["requestId"] !== "string" || typeof record["text"] !== "string") throw new Error("invalid-sdk-request");
        const turn = await sdkTurns.start(sessionId, record["requestId"], record["text"], (sdkEvent) => {
          hostPort.postMessage({ kind: "sdk-turn-event", event: sdkEvent });
        }, (terminal) => hostPort.postMessage({ kind: "sdk-turn-status", turn: terminal }),
        { ...(record["references"] !== undefined ? { references: record["references"] as PromptContextEntry[] } : {}),
          ...(record["attachments"] !== undefined ? { attachments: record["attachments"] as PromptContextEntry[] } : {}) });
        return { ok: true, payload: { turn } };
      }
      if (op === "task/sdkCancel") {
        if (typeof record["turnId"] !== "string") throw new Error("invalid-sdk-turn");
        return { ok: true, payload: { turn: await sdkTurns.cancel(sessionId, record["turnId"]) } };
      }
    }
    switch (op) {
      case "task/provision": {
        const name = record["name"];
        const dirId = record["dirId"];
        const remoteBranch = typeof record["remoteBranch"] === "string" ? (record["remoteBranch"] as string) : "";
        const fetchedCommit = typeof record["fetchedCommit"] === "string" ? (record["fetchedCommit"] as string) : "";
        if (typeof name !== "string" || typeof dirId !== "string") {
          return { ok: false, error: "invalid-payload: task/provision requires name/dirId" };
        }
        const branch = typeof record["branch"] === "string" ? (record["branch"] as string) : undefined;
        const rootOverride = typeof record["rootOverride"] === "string" ? (record["rootOverride"] as string) : undefined;
        const repos = asStrictStringArray(record["repos"]);
        if (repos === null) {
          return { ok: false, error: "invalid-payload: task/provision.repos must be a string array" };
        }
        const mainCheckouts = record["mainCheckouts"];
        const checkouts =
          mainCheckouts === undefined
            ? undefined
            : isMainCheckouts(mainCheckouts)
              ? (mainCheckouts as Record<string, string>)
              : null;
        if (checkouts === null) {
          return { ok: false, error: "invalid-payload: task/provision.mainCheckouts must map repo names to path strings" };
        }
        // #6 multi-repo + plain-dir fields (all optional, all fail-closed
        // inside `host.provision`): `repoSelections` (per-repo remote +
        // baseline), `fetchedCommits` (per-repo pinned commits), and
        // `plainDirs` ({directoryId, sourcePath} link snapshots — shared
        // views of the originals, never copies).
        const repoSelections = record["repoSelections"];
        const selections =
          repoSelections === undefined
            ? undefined
            : Array.isArray(repoSelections) &&
                repoSelections.every(
                  (entry) =>
                    typeof entry === "object" &&
                    entry !== null &&
                    !Array.isArray(entry) &&
                    typeof (entry as Record<string, unknown>)["repoDir"] === "string" &&
                    typeof (entry as Record<string, unknown>)["remote"] === "string" &&
                    typeof (entry as Record<string, unknown>)["remoteBranch"] === "string" &&
                    typeof (entry as Record<string, unknown>)["mainCheckoutDir"] === "string",
                )
              ? (repoSelections as { repoDir: string; remote: string; remoteBranch: string; mainCheckoutDir: string }[])
              : null;
        if (selections === null) {
          return { ok: false, error: "invalid-payload: task/provision.repoSelections must be an array of {repoDir, remote, remoteBranch, mainCheckoutDir}" };
        }
        const fetchedCommits = record["fetchedCommits"];
        const commits =
          fetchedCommits === undefined
            ? undefined
            : isMainCheckouts(fetchedCommits)
              ? (fetchedCommits as Record<string, string>)
              : null;
        if (commits === null) {
          return { ok: false, error: "invalid-payload: task/provision.fetchedCommits must map repo names to commit strings" };
        }
        const plainDirs = record["plainDirs"];
        const dirs =
          plainDirs === undefined
            ? undefined
            : Array.isArray(plainDirs) &&
                plainDirs.every(
                  (entry) =>
                    typeof entry === "object" &&
                    entry !== null &&
                    !Array.isArray(entry) &&
                    typeof (entry as Record<string, unknown>)["directoryId"] === "string" &&
                    typeof (entry as Record<string, unknown>)["sourcePath"] === "string",
                )
              ? (plainDirs as { directoryId: string; sourcePath: string }[])
              : null;
        if (dirs === null) {
          return { ok: false, error: "invalid-payload: task/provision.plainDirs must be an array of {directoryId, sourcePath}" };
        }
        const hasRepos = (selections !== undefined && selections.length > 0) || (repos !== undefined && repos.length > 0);
        const hasPlainDirs = dirs !== undefined && dirs.length > 0;
        if (hasRepos || !hasPlainDirs) {
          if (!remoteBranch || !fetchedCommit) {
            return { ok: false, error: "invalid-payload: task/provision requires name/dirId/remoteBranch/fetchedCommit" };
          }
        }
        // `host.provision` returns the persisted record AND the executable
        // plan (real cwds; empty only in the sense of zero ops). Both ride
        // the `host/task` result payload so a caller can persist-then-execute
        // without re-deriving git ops from the record.
        const { record: saved, plan } = host.provision({
          name,
          dirId,
          branch,
          rootOverride,
          remoteBranch,
          fetchedCommit,
          repos,
          mainCheckouts: checkouts,
          repoSelections: selections,
          fetchedCommits: commits,
          plainDirs: dirs,
        });
        return { ok: true, payload: { ...saved, plan } };
      }
      // #6 append: only repos not already in the task are fetched/planned
      // (existing baselines + running state untouched; busy sessions are
      // NOT silently rebound — the caller refreshes them at an explicit
      // boundary from the returned `appended` list).
      case "task/appendRepos": {
        const appendSelections = record["repoSelections"];
        if (!Array.isArray(appendSelections)) {
          return { ok: false, error: "invalid-payload: task/appendRepos requires repoSelections" };
        }
        const fetched = record["fetchedCommits"];
        if (typeof fetched !== "object" || fetched === null || Array.isArray(fetched)) {
          return { ok: false, error: "invalid-payload: task/appendRepos requires fetchedCommits" };
        }
        const appendBranch = typeof record["branch"] === "string" ? (record["branch"] as string) : undefined;
        const appendCheckouts = record["mainCheckouts"];
        const appendCheckoutMap =
          appendCheckouts === undefined
            ? undefined
            : isMainCheckouts(appendCheckouts)
              ? (appendCheckouts as Record<string, string>)
              : null;
        if (appendCheckoutMap === null) {
          return { ok: false, error: "invalid-payload: task/appendRepos.mainCheckouts must map repo names to path strings" };
        }
        const taken = Array.isArray(record["takenPaths"]) ? (record["takenPaths"] as string[]) : undefined;
        const inUse = Array.isArray(record["branchesInUse"]) ? (record["branchesInUse"] as string[]) : undefined;
        try {
          const appended = host.appendRepos({
            repoSelections: appendSelections as { repoDir: string; remote: string; remoteBranch: string; mainCheckoutDir: string }[],
            fetchedCommits: fetched as Record<string, string>,
            branch: appendBranch,
            mainCheckouts: appendCheckoutMap,
            takenPaths: taken,
            branchesInUse: inUse,
          });
          return { ok: true, payload: { ...appended.record, plan: appended.plan, appended: appended.appended, skipped: appended.skipped } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "task/appendDirs": {
        const plainDirs = record["plainDirs"];
        if (!Array.isArray(plainDirs)) {
          return { ok: false, error: "invalid-payload: task/appendDirs requires plainDirs" };
        }
        try {
          const appended = host.appendDirs({
            plainDirs: plainDirs as { directoryId: string; sourcePath: string }[],
          });
          return { ok: true, payload: { ...appended.record, appended: appended.appended, skipped: appended.skipped } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      // #6 resume: classify each selected repo from the REAL worktree on
      // disk and retry only the unfinished ones. Created worktrees are
      // never re-created/reset/refetched; a present path that is not this
      // task's worktree is held and reported, never overwritten. The
      // caller-scanned conflict gate stays REQUIRED (Host-side fail-closed);
      // on the renderer route main derives and overwrites it.
      case "task/resumeAppend": {
        const resumeCheckouts = record["mainCheckouts"];
        const resumeCheckoutMap =
          resumeCheckouts === undefined
            ? undefined
            : isMainCheckouts(resumeCheckouts)
              ? (resumeCheckouts as Record<string, string>)
              : null;
        if (resumeCheckoutMap === null) {
          return { ok: false, error: "invalid-payload: task/resumeAppend.mainCheckouts must map repo names to path strings" };
        }
        const resumeFetched = record["fetchedCommits"];
        const resumeFetchedMap =
          resumeFetched === undefined ? undefined : isMainCheckouts(resumeFetched) ? (resumeFetched as Record<string, string>) : null;
        if (resumeFetchedMap === null) {
          return { ok: false, error: "invalid-payload: task/resumeAppend.fetchedCommits must map repo names to commit strings" };
        }
        const resumePrepareErrors = record["prepareErrors"];
        const resumePrepareMap =
          resumePrepareErrors === undefined
            ? undefined
            : typeof resumePrepareErrors === "object" &&
                resumePrepareErrors !== null &&
                !Array.isArray(resumePrepareErrors)
              ? (resumePrepareErrors as Record<string, { code: string; message: string }>)
              : null;
        if (resumePrepareMap === null) {
          return { ok: false, error: "invalid-payload: task/resumeAppend.prepareErrors must map repo names to {code, message}" };
        }
        const resumeTaken = Array.isArray(record["takenPaths"]) ? (record["takenPaths"] as string[]) : undefined;
        const resumeInUse = Array.isArray(record["branchesInUse"]) ? (record["branchesInUse"] as string[]) : undefined;
        const resumeBranch = typeof record["branch"] === "string" ? (record["branch"] as string) : undefined;
        try {
          const resumed = host.resumeAppend({
            branch: resumeBranch,
            mainCheckouts: resumeCheckoutMap,
            fetchedCommits: resumeFetchedMap,
            takenPaths: resumeTaken,
            branchesInUse: resumeInUse,
            prepareErrors: resumePrepareMap,
          });
          return {
            ok: true,
            payload: {
              ...resumed.record,
              plan: resumed.plan,
              outcomes: resumed.outcomes,
              created: resumed.created,
              pending: resumed.pending,
              failed: resumed.failed,
              retry: resumed.retry,
              hold: resumed.hold,
              resumed: resumed.resumed,
            },
          };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      // #6 prepare read: read-only per-repo classification (created /
      // pending / failed with the real reason). No plan and no write, so the
      // caller-scanned conflict gate is not involved; the resume WRITE still
      // requires it.
      case "task/prepareStatus": {
        try {
          return { ok: true, payload: { ...host.prepareStatus() } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      // #6 link probe: Host-side, real-fs report of a plain-directory link's
      // TARGET shape (真实目录 / 失效 / 嵌套 / 循环 / 具名 unknown) plus the
      // per-platform link capability. Report only — never creates, repairs,
      // follows through or deletes a link. The caller-named path must be one of
      // THIS task's own recorded link sources (`probeDeclaredLinkSource`);
      // anything else is refused by name, before any filesystem read.
      case "task/probeLink": {
        const sourcePath = record["sourcePath"];
        if (typeof sourcePath !== "string" || sourcePath.length === 0) {
          return { ok: false, error: "invalid-payload: task/probeLink requires sourcePath" };
        }
        const probed = host.probeDeclaredLinkSource(sourcePath);
        if (!probed.ok) return { ok: false, error: probed.error };
        return { ok: true, payload: { ...probed.report } };
      }
      case "task/cancel": {
        const sessionId = record["sessionId"];
        if (typeof sessionId !== "string") {
          return { ok: false, error: "invalid-payload: task/cancel requires sessionId" };
        }
        // [PiDock 09] (#11) box 2/5: stop cancels the waiting turn, expires
        // its confirmation and drops the session's write right (claims,
        // derived executions, queue slot), then reports the coordination
        // state so the navigation shows the new holder/queue immediately.
        const state = host.cancel(sessionId);
        return { ok: true, payload: { sessionId, write: state.write, orphans: state.orphans, derived: state.derived } };
      }
      // [PiDock 09] (#11) session states + write coordination read: one
      // per-session readout (permission, run state, pending confirmation,
      // last activity) plus who holds the write right, who queues and which
      // agent-owned resources are still running without a claim.
      case "task/sessionStates": {
        const state = host.writeState();
        return { ok: true, payload: { write: state.write, sessions: state.sessions, orphans: state.orphans, derived: state.derived } };
      }
      case "task/approve": {
        const sessionId = record["sessionId"];
        const approvalId = record["approvalId"];
        if (typeof sessionId !== "string" || typeof approvalId !== "string") {
          return { ok: false, error: "invalid-payload: task/approve requires sessionId/approvalId" };
        }
        const callId = host.approve(sessionId, approvalId);
        return { ok: true, payload: { sessionId, approvalId, callId } };
      }
      case "task/reject": {
        const sessionId = record["sessionId"];
        const approvalId = record["approvalId"];
        if (typeof sessionId !== "string" || typeof approvalId !== "string") {
          return { ok: false, error: "invalid-payload: task/reject requires sessionId/approvalId" };
        }
        host.reject(sessionId, approvalId);
        return { ok: true, payload: { sessionId, approvalId } };
      }
      case "task/saveDraft": {
        const sessionId = record["sessionId"];
        const text = record["text"];
        if (typeof sessionId !== "string" || typeof text !== "string") {
          return { ok: false, error: "invalid-payload: task/saveDraft requires sessionId/text" };
        }
        const draft: { text: string; references?: unknown[]; skillSource?: string } = { text };
        if (record["references"] !== undefined) draft.references = record["references"] as unknown[];
        if (typeof record["skillSource"] === "string") draft.skillSource = record["skillSource"] as string;
        host.saveDraft(sessionId, draft);
        return { ok: true, payload: { sessionId } };
      }
      case "task/readDraft": {
        const sessionId = record["sessionId"];
        if (typeof sessionId !== "string") {
          return { ok: false, error: "invalid-payload: task/readDraft requires sessionId" };
        }
        return { ok: true, payload: { sessionId, draft: host.readDraft(sessionId) } };
      }
      case "task/clearDraft": {
        const sessionId = record["sessionId"];
        if (typeof sessionId !== "string") {
          return { ok: false, error: "invalid-payload: task/clearDraft requires sessionId" };
        }
        host.clearDraft(sessionId);
        return { ok: true, payload: { sessionId } };
      }
      case "task/setPermission": {
        const sessionId = record["sessionId"];
        const permission = record["permission"];
        if (typeof sessionId !== "string") {
          return { ok: false, error: "invalid-payload: task/setPermission requires sessionId" };
        }
        if (permission !== "read" && permission !== "default" && permission !== "auto") {
          return { ok: false, error: "invalid-payload: task/setPermission.permission must be read/default/auto" };
        }
        host.setPermission(sessionId, permission);
        return { ok: true, payload: { sessionId, permission } };
      }
      case "task/listApprovals": {
        const sessionId = record["sessionId"];
        if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.trim().length === 0)) {
          return { ok: false, error: "invalid-payload: task/listApprovals.sessionId must be a non-empty string" };
        }
        const approvals = host.listApprovals(typeof sessionId === "string" ? sessionId : undefined);
        return { ok: true, payload: { approvals } };
      }
      case "task/getApproval": {
        const approvalId = record["approvalId"];
        if (typeof approvalId !== "string" || approvalId.trim().length === 0) {
          return { ok: false, error: "invalid-payload: task/getApproval requires approvalId" };
        }
        const approval = host.getApproval(approvalId);
        if (!approval) return { ok: false, error: "确认请求不存在" };
        return { ok: true, payload: { approval } };
      }
      // [PiDock 04] (#7) service ops share the fork-time task binding.
      // Registration currently accepts only main-attested human UI callers; the
      // Agent's shared-template edit has its own path ([PiDock 04] #7 box 6,
      // `main/service-catalog-ipc.ts`) and never registers a service. Execution
      // remains disabled until real process ownership, cleanup and cross-platform
      // stop pass.
      // Reads return allowlisted display projections, never raw launch env.
      case "task/registerService": {
        const services = serviceRuntimeFor(taskId);
        if ("error" in services) return { ok: false, error: services.error };
        const serviceId = record["serviceId"];
        const descriptor = record["descriptor"];
        const serviceLayers = record["layers"];
        const templateVersion = record["templateVersion"];
        if (typeof serviceId !== "string" || serviceId.trim().length === 0) {
          return { ok: false, error: "invalid-payload: task/registerService requires serviceId" };
        }
        if (typeof descriptor !== "object" || descriptor === null || Array.isArray(descriptor)) {
          return { ok: false, error: "invalid-payload: task/registerService requires descriptor" };
        }
        if (typeof serviceLayers !== "object" || serviceLayers === null || Array.isArray(serviceLayers)) {
          return { ok: false, error: "invalid-payload: task/registerService requires layers" };
        }
        if (typeof templateVersion !== "string" || templateVersion.trim().length === 0) {
          return { ok: false, error: "invalid-payload: task/registerService requires templateVersion" };
        }
        const authorization = authorizeServiceRegistration({ sessionId: record["sessionId"], origin });
        if (!authorization.ok) return { ok: false, error: authorization.error };
        // [PiDock 05] (#10 box 6) the worktree observation is main's own read, so
        // only main's `service-catalog` registration may carry it: a `shell-ui`
        // registration (the renderer's own `shell/taskOp` path) is refused by
        // name, and a contradictory payload is refused too. Nothing is stored
        // before both checks pass.
        const observation = authorizeCodeObservation({ origin, code: record["code"], codeObservationFailure: record["codeObservationFailure"] });
        if (!observation.ok) return { ok: false, error: observation.error };
        try {
          const saved = services.register({
            serviceId,
            descriptor: descriptor as never,
            layers: serviceLayers as never,
            templateVersion,
            launchSource: serviceLaunchSource(origin),
            ...(record["code"] !== undefined ? { code: record["code"] as { commit?: string; dirty: boolean } } : {}),
            ...(typeof record["codeObservationFailure"] === "string" ? { codeObservationFailure: record["codeObservationFailure"] as string } : {}),
          });
          return { ok: true, payload: { service: { serviceId: saved.serviceId, templateVersion: saved.templateVersion, lifecycle: saved.lifecycle, launchSource: saved.launchSource } } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "task/planServiceStart": {
        const services = serviceRuntimeFor(taskId);
        if ("error" in services) return { ok: false, error: services.error };
        const serviceId = record["serviceId"];
        const cwd = record["cwd"];
        if (typeof serviceId !== "string" || typeof cwd !== "string") {
          return { ok: false, error: "invalid-payload: task/planServiceStart requires serviceId/cwd" };
        }
        try {
          const plan = services.planStart(serviceId, cwd);
          return { ok: true, payload: { plan: publicServiceStartPreview(plan) } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "task/controlService": {
        const services = serviceRuntimeFor(taskId);
        if ("error" in services) return { ok: false, error: services.error };
        const serviceId = record["serviceId"];
        const action = record["action"];
        // Renderer-supplied `actor` / `approvalGranted` are claims, never
        // trust signals. The caller kind comes from the pure
        // `classifyControlCaller` rule: a payload `sessionId` is
        // agent control, a session-less call is human UI control only
        // with main's sender-bound `shell-ui` attestation — so a caller
        // can neither spoof `actor` nor drop its session to reach the
        // ungated human path.
        if (action !== "start" && action !== "stop") {
          return { ok: false, error: "invalid-payload: task/controlService requires action" };
        }
        const caller = classifyControlCaller({
          sessionId: record["sessionId"],
          label: record["label"],
          origin,
        });
        if (!caller.ok) return { ok: false, error: caller.error };
        // [PiDock 05] (#10 box 4) group start: the SAME op, the SAME gate, run
        // in the plan's order with a real listening/linkage observation per
        // unit. No new op is added — `HOST_TASK_OPS` stays exactly as it was —
        // and every unit still goes through the one gated dispatch below.
        if (record["group"] === true) {
          if (action !== "start") return { ok: false, error: "invalid-payload: task/controlService.group 仅支持 action=start" };
          const topology = serviceTopologyFor(taskId);
          if ("error" in topology) return { ok: false, error: topology.error };
          const host = taskHostFor(taskId);
          if ("error" in host) return { ok: false, error: host.error };
          const started = await runGroupServiceStart({ taskId, services, topology, host, caller, approvalId: record["approvalId"] });
          return started.ok ? { ok: true, payload: { group: started.value } } : { ok: false, error: started.error };
        }
        if (typeof serviceId !== "string" || serviceId.trim().length === 0) {
          return { ok: false, error: "invalid-payload: task/controlService requires serviceId" };
        }
        // A service registered on this task is executed by the Host's own
        // registered process identity; only a `catalog` registration carries
        // an executable launch (see `serviceLaunchSource`). Everything else - 
        // unregistered ids, `ui`-only registrations, an unconfirmed durable
        // owner state - keeps the previous fail-closed answer and never
        // flips a lifecycle flag as if a process had run.
        const precondition = catalogControlPrecondition(services, serviceId);
        if (precondition.kind === "unregistered") {
          if (services.get(serviceId)?.launchSource === "ui") {
            return { ok: false, error: "service-execution-unavailable: 仅可信服务目录登记的服务可执行；该服务由界面登记。请改用可信服务目录登记的服务" };
          }
          return serviceOwnerInventory ? serviceOwnerInventory.control()
            : { ok: false, error: "service-execution-unavailable: 仅可信服务目录登记的服务可执行；该服务未由可信服务目录登记。请通过可信服务目录登记后再执行" };
        }
        if (precondition.kind === "uncertain") return { ok: false, error: precondition.error };
        const driver = serviceDriverFor(taskId, services);
        if (caller.kind === "human") {
          const result = await runHumanServiceControl({ services, driver, serviceId, action, label: caller.label });
          return result.ok ? { ok: true, payload: result.payload } : { ok: false, error: result.error };
        }
        const channel = host.openSession(caller.sessionId);
        const result = await runAgentServiceControl({
          services,
          driver,
          channel,
          sessionId: caller.sessionId,
          serviceId,
          action,
          approvalId: record["approvalId"],
          // [PiDock 09] (#11) box 3: a service start/stop holds the task write right.
          write: host,
          persist: () => host.store.writeSession(host.taskDir, channel.snapshot()),
          executions: host.controlExecutions,
        });
        return result.ok ? { ok: true, payload: result.payload } : { ok: false, error: result.error };
      }
      case "task/serviceStatus": {
        // A service registered on this task answers with its real process
        // state; the owner inventory keeps answering for everything else.
        const registered = serviceRuntimeFor(taskId);
        if (!("error" in registered)) {
          const serviceId = record["serviceId"];
          const serviceRecord = typeof serviceId === "string" ? registered.get(serviceId) : undefined;
          if (serviceRecord) {
            // A live registry record must not contradict the control path: when
            // the durable owner state keeps control fail-closed, the read
            // reports the same uncertainty instead of a bare `stopped`.
            const uncertain = serviceOwnerStateRefusal(serviceRecord.serviceId);
            if (uncertain) return { ok: false, error: uncertain };
            // [PiDock 04] (#7 box 5) the declared 健康检查 is really probed on
            // this read: one bounded attempt against the PINNED revision's own
            // target, only while the service's process is alive. A read cannot
            // start/stop anything, and the probe's outcome never touches
            // `lifecycle` - a dead process is still the only thing that makes
            // `lifecycle` `stopped`.
            const health = await probeServiceHealth({
              healthCheck: serviceRecord.descriptor.healthCheck,
              running: serviceRecord.lifecycle === "running",
            });
            return { ok: true, payload: { service: publicServiceStatus(serviceRecord, undefined, undefined, health) } };
          }
        }
        if (serviceOwnerInventory || process.env["PIDOCK_SERVICE_OWNER_REQUIRED"] === "1") {
          const serviceId = record["serviceId"];
          if (typeof serviceId !== "string") return { ok: false, error: "invalid-payload" };
          const status = ownerInventoryFor(host).status(serviceId);
          return status.ok ? { ok: true, payload: { service: status.service } } : status;
        }
        const services = serviceRuntimeFor(taskId);
        if ("error" in services) return { ok: false, error: services.error };
        const serviceId = record["serviceId"];
        if (typeof serviceId !== "string") {
          return { ok: false, error: "invalid-payload: task/serviceStatus requires serviceId" };
        }
        const status = services.get(serviceId);
        if (!status) return { ok: false, error: `unknown-service: ${serviceId} is not registered on this task` };
        return { ok: true, payload: { service: publicServiceStatus(status) } };
      }
      case "task/serviceLog": {
        const services = serviceRuntimeFor(taskId);
        if ("error" in services) return { ok: false, error: services.error };
        const serviceId = record["serviceId"];
        if (typeof serviceId !== "string") {
          return { ok: false, error: "invalid-payload: task/serviceLog requires serviceId" };
        }
        const limit = typeof record["limit"] === "number" ? (record["limit"] as number) : 50;
        try {
          return { ok: true, payload: { log: services.serviceLog(serviceId, limit) } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      // [PiDock 05] (#10) multi-service topology. Planning is not execution:
      // it decides units, ports, variable bindings and start groups, while
      // the only path that flips a lifecycle is still the gated
      // `task/controlService`. A plan request may be human-UI (attested, no
      // session) or agent (named session, opened here — an unknown id is
      // persisted like #7/#8 do) — `classifyControlCaller` keeps a raw
      // session-less caller from rewriting the task plan, and the actor is
      // recorded on the plan for audit.
      case "task/planServiceGroup": {
        // GUARD, stated at the seam: this op WRITES the task's plan, and the units
        // it accepts come from its caller — the dock's own topology read sends the
        // visible projection, which carries no declaration-derived edge and no
        // rules/layers. That is acceptable for exactly one reason: a page plan
        // cannot decide a start. Main writes the plan from its own catalog on EVERY
        // group start (`runtime.ts runTaskServiceGroup` → `planBoundServiceGroup`,
        // immediately before the single `task/controlService {group:true}`), so
        // what `runServiceGroupStart` reads here is always main's freshly derived
        // plan — never a renderer-shaped one. A future reader must not mistake the
        // `units` below for trusted input: the trusted inputs are the ones main's
        // `shell/taskOp` route refuses a page for naming (`dependencies`/`rules`/
        // `layers`), and `main/service-group-caller.test.ts` pins the plan-before-
        // start order that keeps this seam harmless.
        const topology = serviceTopologyFor(taskId);
        if ("error" in topology) return { ok: false, error: topology.error };
        const caller = classifyControlCaller({
          sessionId: record["sessionId"],
          label: record["label"],
          origin,
        });
        if (!caller.ok) return { ok: false, error: caller.error };
        if (caller.kind === "agent") {
          const host = taskHostFor(taskId);
          if ("error" in host) return { ok: false, error: host.error };
          host.openSession(caller.sessionId);
        }
        const actor = caller.kind === "human" ? `human:${caller.label}` : `agent:${caller.sessionId}`;
        try {
          const plan = topology.setPlan({
            units: record["units"] as never,
            selectedRepoDirs: asStrictStringArray(record["selectedRepoDirs"]) ?? undefined,
            dependencies: (record["dependencies"] ?? []) as never,
            runTypes: (record["runTypes"] ?? {}) as never,
            requests: (record["requests"] ?? []) as never,
            reservations: (record["reservations"] ?? []) as never,
            rules: (record["rules"] ?? []) as never,
            layers: (record["layers"] ?? { repoDefaults: [], shared: [], privateEntries: [], task: [] }) as never,
            environment: typeof record["environment"] === "string" ? (record["environment"] as string) : "",
            externalResources: (record["externalResources"] ?? []) as never,
          });
          return { ok: true, payload: { plan, actor } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "task/serviceRunRecords": {
        const topology = serviceTopologyFor(taskId);
        if ("error" in topology) return { ok: false, error: topology.error };
        return { ok: true, payload: { records: topology.runs(), registered: topology.registeredIdentities() } };
      }
      case "task/serviceStopScope": {
        const topology = serviceTopologyFor(taskId);
        if ("error" in topology) return { ok: false, error: topology.error };
        const instanceId = record["instanceId"];
        try {
          const scope = topology.stopScope(typeof instanceId === "string" ? instanceId : undefined);
          return { ok: true, payload: { scope } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      // [PiDock 08] (#14) task-local protocol generation + consumer binding.
      // `task/planProtocol` replaces the plan (release dependencies vs. this
      // task's artifact) and `task/recordProtocolRun` records what a real
      // generation/binding run observed; `task/protocolState` is the read.
      // Both writes use the same caller classification as #7/#10: a
      // session-less request must carry the main-stamped shell-UI attestation,
      // an agent request is opened on its own session. Nothing is fabricated —
      // the generated version, toolchain probe, install state and resolutions
      // all come from the caller, and a consumer is only marked bound when its
      // reported resolution really verifies.
      case "task/planProtocol": {
        const binding = protocolBindingFor(taskId);
        if ("error" in binding) return { ok: false, error: binding.error };
        const caller = classifyControlCaller({ sessionId: record["sessionId"], label: record["label"], origin });
        if (!caller.ok) return { ok: false, error: caller.error };
        if (caller.kind === "agent") {
          const host = taskHostFor(taskId);
          if ("error" in host) return { ok: false, error: host.error };
          host.openSession(caller.sessionId);
        }
        const actor = caller.kind === "human" ? `human:${caller.label}` : `agent:${caller.sessionId}`;
        try {
          const state = binding.setPlan(
            {
              protocol: record["protocol"] as never,
              mode: record["mode"] as never,
              steps: (record["steps"] ?? []) as never,
              consumers: record["consumers"] as never,
              acknowledged: (record["acknowledged"] ?? []) as never,
            },
            protocolRunsFor(taskId, binding),
          );
          return { ok: true, payload: { state, actor } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "task/protocolState": {
        const binding = protocolBindingFor(taskId);
        if ("error" in binding) return { ok: false, error: binding.error };
        return { ok: true, payload: { state: binding.state(protocolRunsFor(taskId, binding)) } };
      }
      case "task/recordProtocolRun": {
        const binding = protocolBindingFor(taskId);
        if ("error" in binding) return { ok: false, error: binding.error };
        const caller = classifyControlCaller({ sessionId: record["sessionId"], label: record["label"], origin });
        if (!caller.ok) return { ok: false, error: caller.error };
        if (caller.kind === "agent") {
          const host = taskHostFor(taskId);
          if ("error" in host) return { ok: false, error: host.error };
          host.openSession(caller.sessionId);
        }
        const actor = caller.kind === "human" ? `human:${caller.label}` : `agent:${caller.sessionId}`;
        try {
          const state = binding.recordResult(
            {
              generatedVersion: record["generatedVersion"] as never,
              ok: record["ok"] as never,
              ...(record["note"] !== undefined ? { note: record["note"] as string } : {}),
              ...(record["toolchain"] !== undefined ? { toolchain: record["toolchain"] as never } : {}),
              ...(record["depsInstalled"] !== undefined ? { depsInstalled: record["depsInstalled"] as never } : {}),
              ...(record["resolutions"] !== undefined ? { resolutions: record["resolutions"] as never } : {}),
              ...(record["runtimeReachable"] !== undefined ? { runtimeReachable: record["runtimeReachable"] as never } : {}),
            },
            protocolRunsFor(taskId, binding),
          );
          return { ok: true, payload: { state, actor } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      // [PiDock 06] (#8) task browser: one gated action against the visible
      // task page. The tier, the approval and the page binding are read
      // from the session channel (`runAgentBrowserAction`); main validates
      // the handle, the navigation allowlist and the takeover state before
      // touching the page. A session-less call is the attested human path,
      // exactly like service control above; a user marker additionally
      // enters the session conversation.
      case "task/browserAction": {
        const action = record["action"];
        if (!isBrowserAction(action)) {
          return { ok: false, error: "invalid-payload: task/browserAction requires a known browser action" };
        }
        const caller = classifyControlCaller({
          sessionId: record["sessionId"],
          label: record["label"],
          origin,
        });
        if (!caller.ok) return { ok: false, error: caller.error };
        const gateway = browserGatewayFor(taskId);
        const params =
          typeof record["params"] === "object" && record["params"] !== null && !Array.isArray(record["params"])
            ? (record["params"] as Record<string, unknown>)
            : {};
        if (caller.kind === "agent") {
          const channel = host.openSession(caller.sessionId);
          const result = await runAgentBrowserAction({
            gateway,
            channel,
            sessionId: caller.sessionId,
            taskId,
            action,
            ...(record["page"] !== undefined ? { page: record["page"] } : {}),
            params,
            ...(record["approvalId"] !== undefined ? { approvalId: record["approvalId"] } : {}),
            ...(typeof record["contentVersion"] === "string" ? { contentVersion: record["contentVersion"] as string } : {}),
            taskDir: host.taskDir,
            // [PiDock 09] (#11) box 3: a page change holds the task write right.
            write: host,
            persist: () => host.store.writeSession(host.taskDir, channel.snapshot()),
            // [PiDock 14] (#17) the browser action opens its own execution
            // record, so the gate's outcome is what `task/executionState` reads.
            executions: host.controlExecutions,
          });
          return result.ok ? { ok: true, payload: result.payload } : { ok: false, error: result.error };
        }
        const requested = typeof record["targetSessionId"] === "string" ? (record["targetSessionId"] as string).trim() : "";
        // A named session must exist: a typo must not silently create a new
        // conversation for the user's marker.
        const resolved = resolveBrowserLogSession(requested, host.sessionIds());
        if (!resolved.ok) return { ok: false, error: resolved.error };
        const channel = host.openSession(resolved.sessionId);
        const result = await runHumanBrowserAction({
          gateway,
          action,
          ...(record["page"] !== undefined ? { page: record["page"] } : {}),
          params,
          label: caller.label,
          taskId,
          channel,
          persist: () => host.store.writeSession(host.taskDir, channel.snapshot()),
        });
        return result.ok ? { ok: true, payload: result.payload } : { ok: false, error: result.error };
      }
      // [PiDock 11] (#9) provider/model/context ops. The catalog is redacted
      // app-level data (ids/names/protocols/model declarations, never an auth
      // reference); the Host validates it with the same profile rules as the
      // form and owns the switch gate (busy -> availability -> context bound).
      case "task/setProviderCatalog": {
        const catalog = record["catalog"];
        if (!Array.isArray(catalog)) {
          return { ok: false, error: "invalid-payload: task/setProviderCatalog.catalog must be an array" };
        }
        try {
          const stored = host.setProviderCatalog(catalog);
          return { ok: true, payload: { catalog: stored } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "task/sessionContext": {
        const sessionId = record["sessionId"];
        if (typeof sessionId !== "string") {
          return { ok: false, error: "invalid-payload: task/sessionContext requires sessionId" };
        }
        try {
          const context = host.sessionContext({
            sessionId,
            ...(record["catalog"] !== undefined ? { catalog: record["catalog"] as unknown[] } : {}),
          });
          return { ok: true, payload: { context } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "task/setSessionModel": {
        const sessionId = record["sessionId"];
        const providerId = record["providerId"];
        const model = record["model"];
        if (typeof sessionId !== "string" || typeof providerId !== "string" || typeof model !== "string") {
          return { ok: false, error: "invalid-payload: task/setSessionModel requires sessionId/providerId/model" };
        }
        const reason = record["reason"];
        try {
          const switched = host.setSessionModel({
            sessionId,
            providerId,
            model,
            ...(reason === "human-switch" || reason === "agent-switch" ? { reason } : {}),
            ...(record["catalog"] !== undefined ? { catalog: record["catalog"] as unknown[] } : {}),
          });
          return { ok: true, payload: { context: switched.context, switchEvent: switched.switchEvent } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "task/setSessionThinking": {
        const sessionId = record["sessionId"];
        const level = record["level"];
        if (typeof sessionId !== "string" || typeof level !== "string") {
          return { ok: false, error: "invalid-payload: task/setSessionThinking requires sessionId/level" };
        }
        try {
          const context = host.setSessionThinking({
            sessionId,
            level,
            ...(record["catalog"] !== undefined ? { catalog: record["catalog"] as unknown[] } : {}),
          });
          return { ok: true, payload: { context } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "task/compactSession": {
        const sessionId = record["sessionId"];
        if (typeof sessionId !== "string") {
          return { ok: false, error: "invalid-payload: task/compactSession requires sessionId" };
        }
        try {
          const context = host.compactSession({
            sessionId,
            ...(record["catalog"] !== undefined ? { catalog: record["catalog"] as unknown[] } : {}),
          });
          return { ok: true, payload: { context } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      // [PiDock 12] #12 usage read/cleanup. A read op: it takes no caller
      // input beyond the filter, writes only the task's own usage ledger, and
      // never touches a conversation, so no tier/approval is involved.
      case "task/usageRecords": {
        const filter: Record<string, unknown> = {};
        for (const key of ["sessionId", "providerId", "model", "from", "to", "kind", "groupBy"] as const) {
          const value = record[key];
          if (value !== undefined) filter[key] = value;
        }
        try {
          const report = host.usageReport(filter as never);
          return { ok: true, payload: { report, dimensions: host.usageDimensions() } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "task/clearUsage": {
        const scope = record["scope"];
        try {
          const result = host.clearUsage(scope as never);
          return { ok: true, payload: { ...result } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      // [PiDock 10] (#15) file browsing, diff and delivery. Reads only: the
      // roots come from this task's record, every path is validated against
      // one root, and the answer is bounded + masked before it is returned.
      // A plain-directory link keeps its shared identity and has no Git view
      // or delivery entry point (`main/workspace-files.ts` owns those rules).
      case "task/fileRoots": {
        const files = workspaceFilesFor(taskId);
        if ("error" in files) return { ok: false, error: files.error };
        try {
          // [PiDock 03] (#6 box 6) the roots readout observes each worktree's OWN
          // branch and uncommitted state (`observedRoots`) and keeps the pinned
          // baseline branch as a separate declared field, so two tasks sharing
          // one repo can never read as the same branch.
          return { ok: true, payload: { roots: files.observedRoots(), taskDir: files.taskDir } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "task/serviceImportHints": {
        const files = workspaceFilesFor(taskId);
        if ("error" in files) return { ok: false, error: files.error };
        const rootId = record["rootId"];
        if (typeof rootId !== "string" || rootId.trim().length === 0 || Object.keys(record).length !== 1) {
          return { ok: false, error: "invalid-payload: task/serviceImportHints requires only rootId" };
        }
        try {
          const scan = scanTaskServiceImportHints({ taskDir: files.taskDir, roots: files.roots(), protection: protectedPaths() }, rootId);
          return { ok: true, payload: { scan } };
        } catch (error) {
          return { ok: false, error: error instanceof Error && /^(unknown-worktree|path-out-of-scope):/.test(error.message)
            ? error.message : "import-read-failed: 无法读取选定仓库配置" };
        }
      }
      case "task/fileTree": {
        const files = workspaceFilesFor(taskId);
        if ("error" in files) return { ok: false, error: files.error };
        const result = files.tree({ rootId: record["rootId"], relative: record["relative"] });
        return result.ok ? { ok: true, payload: { tree: result.tree } } : { ok: false, error: result.error };
      }
      case "task/filePreview": {
        const files = workspaceFilesFor(taskId);
        if ("error" in files) return { ok: false, error: files.error };
        const result = files.preview({ rootId: record["rootId"], relative: record["relative"] });
        return result.ok ? { ok: true, payload: { preview: result.preview } } : { ok: false, error: result.error };
      }
      case "task/fileDiff": {
        const files = workspaceFilesFor(taskId);
        if ("error" in files) return { ok: false, error: files.error };
        const result = files.diff({ rootId: record["rootId"], relative: record["relative"] });
        return result.ok
          ? { ok: true, payload: { path: result.path, diff: result.diff, truncated: result.truncated, attribution: result.attribution } }
          : { ok: false, error: result.error };
      }
      case "task/deliveryInfo": {
        const files = workspaceFilesFor(taskId);
        if ("error" in files) return { ok: false, error: files.error };
        const result = files.delivery({ rootId: record["rootId"] });
        return result.ok ? { ok: true, payload: { target: result.target } } : { ok: false, error: result.error };
      }
      // [PiDock 10] (#15 box 28) 从任务打开外部编辑器. The Host is the actor: it
      // resolves the same root the file tree shows, re-probes the user's
      // configured program immediately before the spawn, and spawns it with
      // argv (never a shell). The program comes from main's own settings
      // read; page code cannot reach this op. The launch writes nothing.
      case "task/openEditor": {
        const files = workspaceFilesFor(taskId);
        if ("error" in files) return { ok: false, error: files.error };
        const opened = await openExternalEditor({ files, payload: record, origin });
        return opened.ok ? { ok: true, payload: { launch: opened.launch } } : { ok: false, error: opened.error };
      }
      // [PiDock 10] (#15, #85) the platform's selectable shell profiles: the
      // renderer asks main what this machine offers and which one is the default
      // instead of naming a shell itself. A read: nothing is spawned or written.
      case "task/terminalProfiles": {
        return { ok: true, payload: terminalProfilesPayload(resolveHostShellProfiles()) };
      }
      // [PiDock 10] (#15) built-in terminal. Planning resolves the selected
      // root's cwd + the #7 environment and returns only masked rows: the real
      // child env never crosses the boundary, and the plan is not an execution.
      case "task/planTerminal": {
        const files = workspaceFilesFor(taskId);
        if ("error" in files) return { ok: false, error: files.error };
        const caller = classifyControlCaller({ sessionId: record["sessionId"], label: record["label"], origin });
        if (!caller.ok) return { ok: false, error: caller.error };
        const event = terminalPlanFor(host, files, record, caller);
        return event.ok ? { ok: true, payload: { plan: event.plan } } : { ok: false, error: event.error };
      }
      case "task/terminalControl": {
        const files = workspaceFilesFor(taskId);
        if ("error" in files) return { ok: false, error: files.error };
        const terminals = terminalRegistryFor(taskId);
        if ("error" in terminals) return { ok: false, error: terminals.error };
        const sessions = terminalSessionsFor(taskId);
        if ("error" in sessions) return { ok: false, error: sessions.error };
        const action = record["action"];
        const instanceId = String(record["instanceId"]);
        const caller = classifyControlCaller({ sessionId: record["sessionId"], label: record["label"], origin });
        if (!caller.ok) return { ok: false, error: caller.error };
        if (action === "input" || action === "resize") {
          // Raw terminal input/window control is the human takeover surface
          // ([PiDock 10] #15 box 4). An Agent session is refused rather than
          // handed an un-reviewed write channel into a running process; its
          // approved start/stop path is unchanged.
          if (caller.kind === "agent") {
            return { ok: false, error: "permission-denied: 终端输入与窗口调整只允许界面显式操作，不能由 Agent 会话发起" };
          }
          const claim = host.claimWrite("human-ui", "auto", { kind: "terminal-control", label: `终端${action === "input" ? "输入" : "调整窗口"} ${instanceId}（用户显式操作）` });
          if (!claim.ok) return { ok: false, error: writeClaimError(claim) };
          try {
            if (action === "input") {
              const data = record["data"];
              if (typeof data !== "string" || data.length === 0) {
                return { ok: false, error: "invalid-payload: task/terminalControl.data must be a non-empty string when typing" };
              }
              const typed = await sessions.input(instanceId, data);
              return typed.ok ? { ok: true, payload: { instanceId, action, actor: "human" } } : { ok: false, error: typed.error };
            }
            const cols = record["cols"], rows = record["rows"];
            if (typeof cols !== "number" || typeof rows !== "number") {
              return { ok: false, error: "invalid-payload: task/terminalControl.cols/rows must be integers when resizing" };
            }
            const resized = await sessions.resize(instanceId, cols, rows);
            return resized.ok
              ? { ok: true, payload: { instanceId, action, actor: "human", instance: resized.instance } }
              : { ok: false, error: resized.error };
          } finally {
            host.releaseWrite(claim.claimId);
          }
        }
        if (action === "start") {
          const planned = terminalPlanFor(host, files, record, caller);
          if (!planned.ok) return { ok: false, error: planned.error };
          const plan = planned.raw;
          if (caller.kind === "human") {
            // Human-explicit start: labelled, still under the task write right
            // so it cannot run alongside another session's side effect.
            const claim = host.claimWrite("human-ui", "auto", { kind: "terminal-control", label: `终端启动 ${instanceId}（用户显式操作）` });
            if (!claim.ok) return { ok: false, error: writeClaimError(claim) };
            try {
              terminals.register(plan);
              const started = await sessions.start({ plan, sessionId: null });
              return started.ok
                ? { ok: true, payload: { instanceId, action, actor: "human", instance: started.instance } }
                : { ok: false, error: started.error };
            } catch (error) {
              return { ok: false, error: error instanceof Error ? error.message : String(error) };
            } finally {
              host.releaseWrite(claim.claimId);
            }
          }
          const channel = host.openSession(caller.sessionId);
          const tier = host.permissionOf(caller.sessionId) ?? "default";
          // The real fork is the side effect the write right covers: the outer
          // claim is held across the gated start *and* the spawn, so another
          // session cannot write beside a terminal that is being created. The
          // sequence's own same-session claim nests inside this one.
          const claim = tier === "read" ? { ok: true as const, claimId: "" } : host.claimWrite(caller.sessionId, tier, { kind: "terminal-control", label: `终端启动 ${instanceId}（Agent 会话）` });
          if (!claim.ok) return { ok: false, error: writeClaimError(claim) };
          try {
            const result = runAgentTerminalControl({
              registry: terminals,
              channel,
              taskDir: host.taskDir,
              sessionId: caller.sessionId,
              instanceId,
              action: "start",
              approvalId: record["approvalId"],
              write: host,
              persist: () => host.store.writeSession(host.taskDir, channel.snapshot()),
              act: () => terminals.register(plan),
              // [PiDock 14] (#17) the terminal control opens its own execution
              // record, so the gate's outcome is what `task/executionState` reads.
              executions: host.controlExecutions,
            });
            if (!result.ok) return result;
            const started = await sessions.start({ plan, sessionId: caller.sessionId });
            return started.ok
              ? { ok: true, payload: { ...result.payload, instance: started.instance } }
              : { ok: false, error: started.error };
          } finally {
            if (claim.claimId) host.releaseWrite(claim.claimId);
          }
        }
        // Stop: the spawner signals only the group this Host recorded. A
        // terminal with no recorded pid/pgid, no matching live session, or a
        // driver that cannot prove the tree drained fails closed and keeps
        // running - stop never pretends the process is gone.
        if (caller.kind === "human") {
          const claim = host.claimWrite("human-ui", "auto", { kind: "terminal-control", label: `终端停止 ${instanceId}（用户显式操作）` });
          if (!claim.ok) return { ok: false, error: writeClaimError(claim) };
          try {
            const stopped = await sessions.stop(instanceId, "user-request");
            return stopped.ok
              ? { ok: true, payload: { instanceId, action, actor: "human", instance: stopped.instance } }
              : { ok: false, error: stopped.error };
          } finally {
            host.releaseWrite(claim.claimId);
          }
        }
        const channel = host.openSession(caller.sessionId);
        const tier = host.permissionOf(caller.sessionId) ?? "default";
        const claim = tier === "read" ? { ok: true as const, claimId: "" } : host.claimWrite(caller.sessionId, tier, { kind: "terminal-control", label: `终端停止 ${instanceId}（Agent 会话）` });
        if (!claim.ok) return { ok: false, error: writeClaimError(claim) };
        try {
          const result = runAgentTerminalControl({
            registry: terminals,
            channel,
            taskDir: host.taskDir,
            sessionId: caller.sessionId,
            instanceId,
            action: "stop",
            approvalId: record["approvalId"],
            write: host,
            persist: () => host.store.writeSession(host.taskDir, channel.snapshot()),
            act: () => {
              const scope = terminals.stopScope(instanceId);
              if (!scope.ok) throw new Error(scope.error);
              return terminals.get(instanceId)!;
            },
            executions: host.controlExecutions,
          });
          if (!result.ok) return result;
          const stopped = await sessions.stop(instanceId, "agent-request");
          return stopped.ok
            ? { ok: true, payload: { ...result.payload, instance: stopped.instance } }
            : { ok: false, error: stopped.error };
        } finally {
          if (claim.claimId) host.releaseWrite(claim.claimId);
        }
      }
      case "task/terminalState": {
        const terminals = terminalRegistryFor(taskId);
        if ("error" in terminals) return { ok: false, error: terminals.error };
        // The spawner is wired: the state now reports the real pid/pgid this
        // task's Host spawned, and `processKnown` is the honest per-instance
        // disclosure of whether a process identity was recorded at all.
        // `spawnImplemented` reports whether this Host can really fork the helper
        // (the worker's own platform gate): a Host that cannot spawn must not
        // claim a capability it fails on, so the renderer keeps its residual
        // warning instead of losing it while every start fails.
        return {
          ok: true,
          payload: {
            spawnImplemented: ptySpawnerAvailable(),
            instances: terminals.list().map((instance) => ({ ...instance, processKnown: instance.processId !== undefined })),
          },
        };
      }
      case "task/terminalHistory": {
        const terminals = terminalRegistryFor(taskId);
        if ("error" in terminals) return { ok: false, error: terminals.error };
        const limit = typeof record["limit"] === "number" ? (record["limit"] as number) : 50;
        try {
          return { ok: true, payload: { history: terminals.history(String(record["instanceId"]), limit) } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      // [PiDock 14] (#17) lifecycle: the Host reads its own task folder and
      // record, so the readout cannot be pointed at another task. Archive /
      // restore / cleanup are app-level human-UI actions: a call naming an
      // agent session is refused instead of letting an Agent archive itself.
      case "task/lifecycleState": {
        const lifecycle = lifecycleFor(taskId);
        if ("error" in lifecycle) return { ok: false, error: lifecycle.error };
        try {
          return { ok: true, payload: { lifecycle: lifecycle.state() } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "task/archive":
      case "task/restore": {
        if (record["sessionId"] !== undefined) {
          return { ok: false, error: "permission-denied: 归档／恢复只允许界面显式操作，不能由 Agent 会话发起" };
        }
        const caller = classifyControlCaller({ label: record["label"], origin });
        if (!caller.ok) return { ok: false, error: caller.error };
        const lifecycle = lifecycleFor(taskId);
        if ("error" in lifecycle) return { ok: false, error: lifecycle.error };
        try {
          if (op === "task/archive") {
            const archived = lifecycle.archive();
            // [PiDock 18] (#20) box 6: archiving pauses this task's schedules too.
            const pausedSchedules = host.pauseSchedulesForArchive();
            return { ok: true, payload: { lifecycle: archived.record, plan: archived.plan, pausedSchedules } };
          }
          const restored = lifecycle.restore();
          return { ok: true, payload: { lifecycle: restored.record, scheduleResumed: restored.scheduleResumed, servicesStarted: restored.servicesStarted } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "task/quit": {
        if (record["sessionId"] !== undefined) {
          return { ok: false, error: "permission-denied: 明确退出只允许界面显式操作，不能由 Agent 会话发起" };
        }
        const caller = classifyControlCaller({ label: record["label"], origin });
        if (!caller.ok) return { ok: false, error: caller.error };
        const lifecycle = lifecycleFor(taskId);
        if ("error" in lifecycle) return { ok: false, error: lifecycle.error };
        taskAdmission.seal();
        host.sealExecution();
        if (serviceOwnerInventory || process.env["PIDOCK_SERVICE_OWNER_REQUIRED"] === "1") ownerInventoryFor(host).seal();
        sdkClosing = true;
        sdkTurns?.seal();
        try {
          quitReceipt ??= (async () => {
            // [#117 第 3 项 / A] The Agent is aborted FIRST: an in-flight turn is
            // stopped before any service or terminal child, so it cannot issue
            // one more tool call (and start one more child) while the Host is
            // reaping them. A failed abort is remembered, not fatal - the
            // detached children below have no other stop path, so their
            // termination must not sit behind the Agent stage.
            let abortFailure: unknown;
            try {
              const aborted = await shutdownDeadline(sdkTurns ? sdkTurns.abortAll() : Promise.resolve<string[]>([]), 15_000, "sdk-turns-abort-unconfirmed");
              if (aborted.length > 0) abortedTurns = aborted;
            } catch (error) { abortFailure = error; }
            // Real service children are stopped before the Agent/SDK stages: a
            // detached child (reserved process group, ignored stdin) has no
            // other stop path once this op seals control, so its termination
            // must not depend on the SDK/turn stages succeeding. The driver
            // bounds each stop and stops every service in parallel.
            const stoppedServices = await shutdownDeadline(stopRegisteredServiceProcesses(), 15_000, "service-processes-shutdown-unconfirmed");
            if (stoppedServices.length > 0) serviceStopReport = stoppedServices;
            // [PiDock 10] (#15) the real PTY helper and its session leader have
            // no other stop path once the Host exits (they are not in the Host's
            // process group), so every running terminal is contained before the
            // Agent/SDK stages. Failing to prove one keeps the quit failed.
            await shutdownDeadline(terminalSessions ? terminalSessions.stopAll("host-quit") : Promise.resolve(), 15_000, "terminal-processes-shutdown-unconfirmed");
            // The Agent stage that fails the quit is reported only after every
            // child above has been stopped: the order is Agent -> children -> SDK.
            if (abortFailure) throw abortFailure;
            await workspaceHost?.shutdownSdk();
            await shutdownDeadline(Promise.resolve(sdkTurns?.waitForTerminal()), 15_000, "sdk-turns-shutdown-unconfirmed");
            sdkTurns = null;
            await shutdownDeadline(taskAdmission.drain(), 15_000, "task-operations-shutdown-unconfirmed");
            host.assertExecutionSettled();
            if (serviceOwnerInventory) serviceCompletion = await shutdownDeadline(serviceOwnerInventory.close(), 15_000, "service-owner-shutdown-unconfirmed");
            return lifecycle.quit();
          })();
          const quit = await quitReceipt;
          return { ok: true, payload: { quit, ...(serviceCompletion ? { serviceOwner: serviceCompletion } : {}),
            ...(abortedTurns ? { abortedTurns } : {}),
            ...(serviceStopReport ? { serviceProcesses: serviceStopReport } : {}) } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "task/cleanupPreview": {
        const lifecycle = lifecycleFor(taskId);
        if ("error" in lifecycle) return { ok: false, error: lifecycle.error };
        const selection = record["selection"] as { exportSessions: boolean; exportDrafts: boolean; exportUsage: boolean };
        try {
          return { ok: true, payload: { preview: lifecycle.cleanupPreview({ selection, keepRoot: record["keepRoot"] as string | undefined }) } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "task/runCleanup": {
        if (record["sessionId"] !== undefined) {
          return { ok: false, error: "permission-denied: 清理只允许界面显式操作，不能由 Agent 会话发起" };
        }
        const caller = classifyControlCaller({ label: record["label"], origin });
        if (!caller.ok) return { ok: false, error: caller.error };
        const lifecycle = lifecycleFor(taskId);
        if ("error" in lifecycle) return { ok: false, error: lifecycle.error };
        const selection = record["selection"] as { exportSessions: boolean; exportDrafts: boolean; exportUsage: boolean };
        try {
          return { ok: true, payload: { cleanup: lifecycle.runCleanup({ selection, keepRoot: record["keepRoot"] as string | undefined }) } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      // [PiDock 17] (#19) execution state + cross-project attention reads.
      // Pure reads of this task's ledger, plus the service states this Host
      // observed itself (never a caller claim); no write right, no session and no
      // approval is involved, and the reader never re-executes anything.
      case "task/executionState": {
        const host = taskHostFor(taskId);
        if ("error" in host) return { ok: false, error: host.error };
        const sessionId = record["sessionId"] as string;
        const services = serviceObservationsFor(taskId);
        return { ok: true, payload: { state: host.executionState(sessionId, services) } };
      }
      case "task/attention": {
        const host = taskHostFor(taskId);
        if ("error" in host) return { ok: false, error: host.error };
        const { taskName, items } = host.attention();
        return { ok: true, payload: { taskName, items } };
      }
      case "task/markAttentionRead": {
        const host = taskHostFor(taskId);
        if ("error" in host) return { ok: false, error: host.error };
        const itemIds = record["itemIds"] as string[];
        return { ok: true, payload: { ...host.markAttentionRead(itemIds) } };
      }
      // [PiDock 18] (#20) scheduled tasks. The Host owns the rule validation, the
      // plan and the trigger records; a trigger creates its own session in this
      // task folder through the normal turn path (permission + write lock +
      // confirmations unchanged), and there is no timer: `scheduleEvaluate` is
      // the explicit due-trigger evaluation.
      case "task/scheduleList": {
        const host = taskHostFor(taskId);
        if ("error" in host) return { ok: false, error: host.error };
        try {
          return { ok: true, payload: { schedules: host.listSchedules(), templates: host.scheduleTemplates() } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "task/scheduleTemplates": {
        const host = taskHostFor(taskId);
        if ("error" in host) return { ok: false, error: host.error };
        return { ok: true, payload: { templates: host.scheduleTemplates() } };
      }
      case "task/schedulePreview": {
        const host = taskHostFor(taskId);
        if ("error" in host) return { ok: false, error: host.error };
        const preview = host.schedulePreview({
          ruleText: record["ruleText"] as string,
          timezone: record["timezone"] as string,
          ...(typeof record["after"] === "string" ? { after: record["after"] as string } : {}),
        });
        return { ok: true, payload: { preview } };
      }
      case "task/scheduleSave": {
        if (record["sessionId"] !== undefined) {
          return { ok: false, error: "permission-denied: 定时配置只允许界面显式操作，不能由 Agent 会话发起" };
        }
        const host = taskHostFor(taskId);
        if ("error" in host) return { ok: false, error: host.error };
        const result = host.saveSchedule({
          ...(typeof record["scheduleId"] === "string" ? { scheduleId: record["scheduleId"] as string } : {}),
          ...(typeof record["projectId"] === "string" ? { projectId: record["projectId"] as string } : {}),
          name: record["name"] as string,
          ruleText: record["ruleText"] as string,
          timezone: record["timezone"] as string,
          prompt: record["prompt"] as string,
          providerId: record["providerId"] as string,
          model: record["model"] as string,
          permission: record["permission"] as "read" | "default" | "auto",
          ...(typeof record["enabled"] === "boolean" ? { enabled: record["enabled"] as boolean } : {}),
          extraKeys: Object.keys(record).filter((key) => !SCHEDULE_SAVE_KEYS.includes(key)),
        });
        return result.ok ? { ok: true, payload: { schedule: result.schedule } } : { ok: false, error: `${result.code}: ${result.message}` };
      }
      case "task/scheduleApplyTemplate": {
        const host = taskHostFor(taskId);
        if ("error" in host) return { ok: false, error: host.error };
        const result = host.applyScheduleTemplate(record["scheduleId"] as string, record["templateId"] as string);
        return result.ok ? { ok: true, payload: { schedule: result.schedule } } : { ok: false, error: `${result.code}: ${result.message}` };
      }
      case "task/scheduleSetEnabled": {
        const host = taskHostFor(taskId);
        if ("error" in host) return { ok: false, error: host.error };
        const result = host.setScheduleEnabled(record["scheduleId"] as string, record["enabled"] as boolean);
        return result.ok ? { ok: true, payload: { schedule: result.schedule } } : { ok: false, error: `${result.code}: ${result.message}` };
      }
      case "task/scheduleRemove": {
        const host = taskHostFor(taskId);
        if ("error" in host) return { ok: false, error: host.error };
        return { ok: true, payload: { ...host.removeSchedule(record["scheduleId"] as string) } };
      }
      case "task/scheduleRunNow": {
        // 立即运行 creates a real execution and session: an agent session must not
        // mint one for itself, so this stays a human-UI-only action.
        if (record["sessionId"] !== undefined) {
          return { ok: false, error: "permission-denied: 立即运行只允许界面显式操作，不能由 Agent 会话发起" };
        }
        const caller = classifyControlCaller({ label: record["label"], origin });
        if (!caller.ok) return { ok: false, error: caller.error };
        const host = taskHostFor(taskId);
        if ("error" in host) return { ok: false, error: host.error };
        try {
          return { ok: true, payload: { run: host.runScheduleNow(record["scheduleId"] as string) } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "task/scheduleRuns": {
        const host = taskHostFor(taskId);
        if ("error" in host) return { ok: false, error: host.error };
        const scheduleId = typeof record["scheduleId"] === "string" ? (record["scheduleId"] as string) : undefined;
        return { ok: true, payload: { runs: host.scheduleRuns(scheduleId) } };
      }
      case "task/scheduleEvaluate": {
        const host = taskHostFor(taskId);
        if ("error" in host) return { ok: false, error: host.error };
        try {
          return { ok: true, payload: { runs: host.evaluateSchedules(), schedules: host.listSchedules() } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      // [PiDock 19] (#21) remote access. The entry read, the pairing exchange and
      // the request decision are what a remote caller may reach; minting the QR
      // code, confirming/rejecting a device, rotating or revoking a credential,
      // switching the entry mode and main's Gateway connection report are
      // desktop-only, so they refuse an agent session and require the
      // sender-attested `shell-ui` origin (the same rule as 立即运行).
      case "task/remoteState": {
        const host = taskHostFor(taskId);
        if ("error" in host) return { ok: false, error: host.error };
        return { ok: true, payload: { ...host.remoteState() } };
      }
      case "task/remoteAudit": {
        const host = taskHostFor(taskId);
        if ("error" in host) return { ok: false, error: host.error };
        return { ok: true, payload: { audits: host.remoteAudits() } };
      }
      case "task/remoteEntryMode": {
        const caller = classifyControlCaller({ label: record["label"], origin });
        if (!caller.ok) return { ok: false, error: caller.error };
        const host = taskHostFor(taskId);
        if ("error" in host) return { ok: false, error: host.error };
        return {
          ok: true,
          payload: {
            ...host.setRemoteEntryMode(record["mode"] as RemoteEntryMode, {
              ...(typeof record["endpoint"] === "string" ? { endpoint: record["endpoint"] as string } : {}),
              ...(typeof record["hostId"] === "string" ? { hostId: record["hostId"] as string } : {}),
              ...(typeof record["baseUrl"] === "string" ? { baseUrl: record["baseUrl"] as string } : {}),
            }),
          },
        };
      }
      case "task/remotePairMint": {
        if (record["sessionId"] !== undefined) {
          return { ok: false, error: "permission-denied: 配对凭据只允许桌面显式生成，不能由 Agent 会话发起" };
        }
        const caller = classifyControlCaller({ label: record["label"], origin });
        if (!caller.ok) return { ok: false, error: caller.error };
        const host = taskHostFor(taskId);
        if ("error" in host) return { ok: false, error: host.error };
        const minted = host.mintPairing(typeof record["ttlMs"] === "number" ? { ttlMs: record["ttlMs"] as number } : {});
        return minted.ok ? { ok: true, payload: { ...minted.payload } } : { ok: false, error: `${minted.code}: ${minted.message}` };
      }
      case "task/remotePairCancel": {
        const caller = classifyControlCaller({ label: record["label"], origin });
        if (!caller.ok) return { ok: false, error: caller.error };
        const host = taskHostFor(taskId);
        if ("error" in host) return { ok: false, error: host.error };
        const cancelled = host.cancelPairing();
        return cancelled.ok ? { ok: true, payload: { ...cancelled.payload } } : { ok: false, error: `${cancelled.code}: ${cancelled.message}` };
      }
      case "task/remotePairExchange": {
        // The phone's exchange: it never names a session and gets no right until
        // the desktop confirmed the device.
        const host = taskHostFor(taskId);
        if ("error" in host) return { ok: false, error: host.error };
        const exchanged = host.exchangePairing({
          credentialId: record["credentialId"] as string,
          secret: record["secret"] as string,
          deviceName: record["deviceName"] as string,
          permissions: Array.isArray(record["permissions"]) ? (record["permissions"] as unknown[]) : [],
        });
        return exchanged.ok ? { ok: true, payload: { ...exchanged.payload } } : { ok: false, error: `${exchanged.code}: ${exchanged.message}` };
      }
      case "task/remoteDeviceConfirm": {
        if (record["sessionId"] !== undefined) {
          return { ok: false, error: "permission-denied: 设备确认只允许桌面显式操作，不能由 Agent 会话发起" };
        }
        const caller = classifyControlCaller({ label: record["label"], origin });
        if (!caller.ok) return { ok: false, error: caller.error };
        const host = taskHostFor(taskId);
        if ("error" in host) return { ok: false, error: host.error };
        const confirmed = host.confirmRemoteDevice(
          record["deviceId"] as string,
          Array.isArray(record["permissions"]) ? (record["permissions"] as unknown[]) : undefined,
        );
        return confirmed.ok ? { ok: true, payload: { ...confirmed.payload } } : { ok: false, error: `${confirmed.code}: ${confirmed.message}` };
      }
      case "task/remoteDeviceReject":
      case "task/remoteDeviceRevoke":
      case "task/remoteDeviceRotate": {
        if (record["sessionId"] !== undefined) {
          return { ok: false, error: "permission-denied: 设备管理只允许桌面显式操作，不能由 Agent 会话发起" };
        }
        const caller = classifyControlCaller({ label: record["label"], origin });
        if (!caller.ok) return { ok: false, error: caller.error };
        const host = taskHostFor(taskId);
        if ("error" in host) return { ok: false, error: host.error };
        const deviceId = record["deviceId"] as string;
        const result =
          op === "task/remoteDeviceReject"
            ? host.rejectRemoteDevice(deviceId)
            : op === "task/remoteDeviceRevoke"
              ? host.revokeRemoteDevice(deviceId)
              : host.rotateRemoteDevice(deviceId);
        return result.ok ? { ok: true, payload: { ...result.payload } } : { ok: false, error: `${result.code}: ${result.message}` };
      }
      case "task/remoteAuthorize": {
        const host = taskHostFor(taskId);
        if ("error" in host) return { ok: false, error: host.error };
        const authorized = host.authorizeRemote({ deviceId: record["deviceId"] as string, op: record["op"] as string });
        return authorized.ok ? { ok: true, payload: { ...authorized.payload } } : { ok: false, error: `${authorized.code}: ${authorized.message}` };
      }
      case "task/remoteReconnectPlan": {
        const host = taskHostFor(taskId);
        if ("error" in host) return { ok: false, error: host.error };
        const plan = host.remoteReconnectPlan(
          record["deviceId"] as string,
          Array.isArray(record["pending"]) ? (record["pending"] as RemotePendingRequest[]) : [],
          Array.isArray(record["deliveredKeys"]) ? (record["deliveredKeys"] as string[]) : [],
        );
        return plan.ok ? { ok: true, payload: { ...plan.payload } } : { ok: false, error: `${plan.code}: ${plan.message}` };
      }
      case "task/remoteGatewayEvent": {
        // The Gateway connection verdict is a main-reported fact: it decides whether
        // every later gateway-mode request is allowed, so an agent session cannot
        // flip it and a caller needs the sender-attested `shell-ui` origin.
        if (record["sessionId"] !== undefined) {
          return { ok: false, error: "permission-denied: Gateway 连接状态只由主进程上报，不能由 Agent 会话发起" };
        }
        const caller = classifyControlCaller({ label: record["label"], origin });
        if (!caller.ok) return { ok: false, error: caller.error };
        const host = taskHostFor(taskId);
        if ("error" in host) return { ok: false, error: host.error };
        const event = host.remoteGatewayEvent({
          action: record["action"] as "connected" | "disconnected",
          ...(typeof record["error"] === "string" ? { error: record["error"] as string } : {}),
        });
        return event.ok ? { ok: true, payload: { ...event.payload } } : { ok: false, error: `${event.code}: ${event.message}` };
      }
      default:
        return { ok: false, error: `unknown-op: ${op}` };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function startHost(kernelFactory?: (taskId: string, taskDir: string) => PiSdkTextKernel): void {
  if (started) throw new Error("host-already-started");
  started = true;
  if (kernelFactory) sdkKernelFactory = kernelFactory;
  hostPort.on("message", async (event: { data: unknown }) => {
  const message: unknown = event.data;
  if (await handleServiceOwnerMessage(message)) return;
  if (!isRpcRequest(message)) {
    reply({ kind: "response", id: "unknown", ok: false, error: "invalid-request" });
    return;
  }  const workspaceId = workspaceOf(message.params);
  if (message.method === "host/ping") {
    const payload: HostPingResult = { pong: true, workspaceId, hostTime: Date.now() };
    reply({ kind: "response", id: message.id, ok: true, payload });
    return;
  }
  if (message.method === "host/getVersions") {
    const payload: HostVersionsResult = {
      node: process.versions["node"] ?? "unknown",
      v8: process.versions["v8"] ?? "unknown",
      workspaceId,
    };
    reply({ kind: "response", id: message.id, ok: true, payload });
    return;
  }
  if (message.method === "host/task") {
    // The Host is bound to one workspace (env at fork time). A routed call
    // naming any other workspace is rejected even though the envelope
    // itself is well-formed — main already compared sender vs payload.
    // `routeHostTask` is the pure, unit-tested form of this rule.
    const taskParams: unknown = message.params;
    const bound = boundWorkspaceId();
    const route = routeHostTask(taskParams, bound);
    if (route === "task-workspace-mismatch") {
      reply({ kind: "response", id: message.id, ok: false, error: "task-workspace-mismatch" });
      return;
    }
    if (route === "invalid-params" || !isHostTaskParams(taskParams)) {
      reply({ kind: "response", id: message.id, ok: false, error: "invalid-params" });
      return;
    }
    const perOp = validateHostTaskOp(taskParams.op, taskParams.payload);
    if (!perOp.ok) {
      reply({ kind: "response", id: message.id, ok: false, error: perOp.error });
      return;
    }
    const result = await dispatchTaskOp(taskParams.taskId, taskParams.op, taskParams.payload ?? {}, taskParams.origin);
    if (!result.ok) {
      reply({ kind: "response", id: message.id, ok: false, error: result.error });
      return;
    }
    const payload: HostTaskResult = {
      workspaceId: bound,
      taskId: taskParams.taskId,
      op: taskParams.op,
      payload: { ...result.payload, hostTime: Date.now() },
    };
    reply({ kind: "response", id: message.id, ok: true, payload });
    return;
  }
  reply({ kind: "response", id: message.id, ok: false, error: "unknown-method" });
});

  // Let the parent know the host is alive (bounded, single line).
  process.stdout.write(`[host] ready node=${process.versions["node"] ?? "unknown"}\n`);
}
