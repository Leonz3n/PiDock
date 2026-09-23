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

import {
  boundWorkspaceId,
  classifyControlCaller,
  resolveBrowserLogSession,
  routeHostTask,
  toolPlannerSpecForHostDispatch,
  validateHostTaskOp,
} from "./host-guards.js";
import { TaskWorkspaceHost, diskTaskStore } from "./task-host.js";
import type { ServiceRunObservation } from "../main/execution-ledger.js";
import { SharedPathCoordinator } from "./path-coordination.js";
import { TaskServiceRuntime } from "./service-runtime.js";
import { TaskServiceTopology } from "./service-topology.js";
import { TaskProtocolBinding } from "./protocol-binding.js";
import { TaskWorkspaceFiles } from "./workspace-files.js";
import { TaskTerminalRegistry, planTerminal, type TerminalPlan } from "../main/terminal-config.js";
import { TaskLifecycleHost } from "./task-lifecycle.js";
import { createLifecycleResources } from "./lifecycle-resources.js";
import { runAgentTerminalControl } from "./terminal-control.js";
import { writeClaimError } from "./write-coordination.js";
import { runAgentServiceControl } from "./service-control.js";
import { runAgentBrowserAction, runHumanBrowserAction, type BrowserGatewayPort } from "./browser-control.js";import { HostBrowserClient } from "../rpc/browser-client.js";
import { isBrowserAction } from "../main/browser-rules.js";
import {
  isHostTaskParams,
  isRpcRequest,
  type HostPingResult,
  type HostTaskResult,
  type HostVersionsResult,
  type RpcResponse,
  type TaskOpOrigin,
} from "../rpc/protocol.js";

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
    workspaceFiles = new TaskWorkspaceFiles(host.taskId, host.taskDir, host.store, undefined, () => [...privateSecretValues]);
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
  const planned = planTerminal({
    roots: files.roots(),
    taskId: host.taskId,
    taskDir: host.taskDir,
    rootId: record["rootId"],
    relative: record["relative"],
    program: record["program"],
    args: record["args"],
    layers: (layers as never) ?? { repoDefaults: [], shared: [], privateEntries: [], task: [] },
    cols: record["cols"],
    rows: record["rows"],
    owner,
    instanceId: String(record["instanceId"]),
    secrets: [...privateSecretValues],
  });
  if (!planned.ok) return { ok: false, error: planned.error };
  const { env, ...display } = planned.plan;
  void env;
  return { ok: true, plan: display, raw: planned.plan };
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
    serviceRuntime = new TaskServiceRuntime(host.taskDir);
  }
  return serviceRuntime;
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
        const runtime = serviceRuntime;
        if (!runtime || runtime.taskDir !== taskDir) return [];
        return runtime.runningAgentOwned().map((service) => ({
          resourceId: service.serviceId,
          kind: "service" as const,
          ownerSessionId: service.ownerSessionId,
          label: service.serviceId,
        }));
      },
      sharedPaths,
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
  if (!browserClient) browserClient = new HostBrowserClient(hostPort, boundWorkspaceId());
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
  const host = taskHostFor(taskId);
  if ("error" in host) return { ok: false, error: host.error };
  const record = asRecord(payload);
  try {
    switch (op) {
      case "task/provision": {
        const name = record["name"];
        const dirId = record["dirId"];
        const remoteBranch = record["remoteBranch"];
        const fetchedCommit = record["fetchedCommit"];
        if (
          typeof name !== "string" ||
          typeof dirId !== "string" ||
          typeof remoteBranch !== "string" ||
          typeof fetchedCommit !== "string"
        ) {
          return { ok: false, error: "invalid-payload: task/provision requires name/dirId/remoteBranch/fetchedCommit" };
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
      // #6 link probe: Host-side fs check whether a plain-dir source still
      // exists (report only — never creates, follows, or takes over).
      case "task/probeLink": {
        const sourcePath = record["sourcePath"];
        if (typeof sourcePath !== "string" || sourcePath.length === 0) {
          return { ok: false, error: "invalid-payload: task/probeLink requires sourcePath" };
        }
        const probed = host.probeLinkTarget(sourcePath);
        return { ok: true, payload: { ...probed } };
      }
      case "task/sendMessage": {
        const sessionId = record["sessionId"];
        const text = record["text"];
        if (typeof sessionId !== "string" || typeof text !== "string") {
          return { ok: false, error: "invalid-payload: task/sendMessage requires sessionId/text" };
        }
        // S6 batch 1 turn options (all optional, validated by
        // `validateHostTaskOp` above): per-turn provider/model selection
        // plus structured usage for the persisted call record.
        // S6 batch 3: scripted tool plan rides the same payload. Only
        // `tool`/`target`/`contentVersion` (plain data) cross the RPC
        // boundary; the planner is selected here by name (`toolPlan`):
        // `echo` replays the planned call so the real `exec.run` approval
        // path (`default` -> ask) is reachable end-to-end, `deny` forces
        // a denied-target call (fail-closed coverage). No executable
        // function is ever deserialized from the payload.
        const turn: Record<string, unknown> = {};
        for (const key of ["providerId", "model", "usageSource", "usage", "credentialRef", "references", "skillSource", "tool", "target", "contentVersion"] as const) {
          const value = record[key];
          if (value !== undefined) turn[key] = value;
        }
        const planner = toolPlannerSpecForHostDispatch(record);
        if (!planner.ok) return { ok: false, error: planner.error };
        if (planner.mode === "echo" || planner.mode === "deny") {
          const plannedTool = planner.tool;
          const plannedTarget = planner.target;
          const plannedVersion = planner.contentVersion;
          const plannedMode = planner.mode;
          (turn as Record<string, unknown>)["execute"] = (_call: unknown) => ({
            tool: plannedTool,
            target: plannedTarget,
            contentVersion: plannedVersion,
            output: plannedMode === "deny" ? "denied" : "planned",
          });
        }
        const result = host.sendMessage(sessionId, text, turn as never);
        return { ok: true, payload: { ...result } };
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
      // [PiDock 04] (#7) service ops: same fork binding as the task ops
      // above (via `serviceRuntimeFor`, which reuses the `taskHostFor`
      // guard, so unbound/foreign tasks fail closed identically).
      // Agent `service/start|service/stop` control goes through the #5
      // permission gate on the task's session channel: readonly denies,
      // default requires a verified live approval id, auto allows. A call
      // carrying a `sessionId` is always agent control; only a
      // session-less call is human-explicit. Renderer `actor` /
      // `approvalGranted` claims are never trusted, and only a Host-minted
      // `service-control`-scoped approval is accepted (`runAgentServiceControl`).
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
        try {
          const saved = services.register({
            serviceId,
            descriptor: descriptor as never,
            layers: serviceLayers as never,
            templateVersion,
          });
          return { ok: true, payload: { service: saved } };
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
          return { ok: true, payload: { plan } };
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
        if (typeof serviceId !== "string" || (action !== "start" && action !== "stop")) {
          return { ok: false, error: "invalid-payload: task/controlService requires serviceId/action" };
        }
        const caller = classifyControlCaller({
          sessionId: record["sessionId"],
          label: record["label"],
          origin,
        });
        if (!caller.ok) return { ok: false, error: caller.error };
        if (caller.kind === "agent") {
          const sessionId = caller.sessionId;
          // Agent control: tier, approval lookup, one-shot spend and the
          // act are one testable sequence (`runAgentServiceControl`),
          // driven by the session channel's live state — never by
          // caller-claimed booleans or actors.
          const channel = host.openSession(sessionId);
          return runAgentServiceControl({
            services,
            channel,
            sessionId,
            serviceId,
            action,
            approvalId: record["approvalId"],
            // [PiDock 09] (#11) box 3: the task write right constrains even
            // the `auto` tier (one task, one writer; reads never claim).
            write: host,
            persist: () => host.store.writeSession(host.taskDir, channel.snapshot()),
          });
        }
        // Human UI control: attested sender, labelled and auditable.
        try {
          if (action === "start") services.markStarted(serviceId, { kind: "human", label: caller.label });
          else services.markStopped(serviceId, { kind: "human", label: caller.label }, "user-request");
          return { ok: true, payload: { serviceId, action, actor: "human" } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "task/serviceStatus": {
        const services = serviceRuntimeFor(taskId);
        if ("error" in services) return { ok: false, error: services.error };
        const serviceId = record["serviceId"];
        if (typeof serviceId !== "string") {
          return { ok: false, error: "invalid-payload: task/serviceStatus requires serviceId" };
        }
        const status = services.get(serviceId);
        if (!status) return { ok: false, error: `unknown-service: ${serviceId} is not registered on this task` };
        // Secrets cross the Host boundary only as masked display values;
        // the resolved snapshot keeps real values Host-side.
        const masked = {
          ...status,
          resolved: status.resolved.map((entry) => ({
            ...entry,
            value: entry.secret ? "••••••••" : entry.value,
          })),
        };
        return { ok: true, payload: { service: masked } };
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
          return { ok: true, payload: { roots: files.roots(), taskDir: files.taskDir } };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
        const action = record["action"];
        const instanceId = String(record["instanceId"]);
        const caller = classifyControlCaller({ sessionId: record["sessionId"], label: record["label"], origin });
        if (!caller.ok) return { ok: false, error: caller.error };
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
              const instance = terminals.register(plan);
              return { ok: true, payload: { instanceId, action, actor: "human", instance } };
            } catch (error) {
              return { ok: false, error: error instanceof Error ? error.message : String(error) };
            } finally {
              host.releaseWrite(claim.claimId);
            }
          }
          const channel = host.openSession(caller.sessionId);
          return runAgentTerminalControl({
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
          });
        }
        // Stop: prove the exact process identity first (never by port), then
        // flip the state. The real kill belongs to the spawner slice; until it
        // lands an unspawned terminal has no pid and stop fails closed.
        if (caller.kind === "human") {
          const claim = host.claimWrite("human-ui", "auto", { kind: "terminal-control", label: `终端停止 ${instanceId}（用户显式操作）` });
          if (!claim.ok) return { ok: false, error: writeClaimError(claim) };
          try {
            const scope = terminals.stopScope(instanceId);
            if (!scope.ok) return { ok: false, error: scope.error };
            const instance = terminals.markExited(instanceId, { reason: "user-request" });
            return { ok: true, payload: { instanceId, action, actor: "human", scope: scope.scope, instance } };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          } finally {
            host.releaseWrite(claim.claimId);
          }
        }
        const channel = host.openSession(caller.sessionId);
        return runAgentTerminalControl({
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
            return terminals.markExited(instanceId, { reason: "agent-request" });
          },
        });
      }
      case "task/terminalState": {
        const terminals = terminalRegistryFor(taskId);
        if ("error" in terminals) return { ok: false, error: terminals.error };
        // `spawnImplemented: false` is the honest disclosure that this slice
        // plans and tracks terminals but owns no real pty yet.
        return {
          ok: true,
          payload: {
            spawnImplemented: false,
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
            return { ok: true, payload: { lifecycle: archived.record, plan: archived.plan } };
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
        try {
          const quit = lifecycle.quit();
          return { ok: true, payload: { quit } };
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
      default:
        return { ok: false, error: `unknown-op: ${op}` };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

hostPort.on("message", async (event: { data: unknown }) => {
  const message: unknown = event.data;
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
