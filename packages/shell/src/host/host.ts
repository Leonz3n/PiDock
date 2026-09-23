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

import { boundWorkspaceId, classifyServiceControlCaller, routeHostTask, toolPlannerSpecForHostDispatch, validateHostTaskOp } from "./host-guards.js";
import { TaskWorkspaceHost, diskTaskStore } from "./task-host.js";
import { TaskServiceRuntime } from "./service-runtime.js";
import { runAgentServiceControl } from "./service-control.js";
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

// [PiDock 04] (#7) per-task service runtime, sibling to the workspace
// Host above: same fork binding (PIDOCK_TASK_ID/PIDOCK_TASK_DIR), no new
// process, no renderer trust change. Lazily created with the same guard.
let serviceRuntime: TaskServiceRuntime | null = null;

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
    workspaceHost = new TaskWorkspaceHost(boundTaskId, taskDir, diskTaskStore);
  }
  return workspaceHost;
}

function asRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
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

function dispatchTaskOp(
  taskId: string,
  op: string,
  payload: unknown,
  /** Main-stamped sender attestation (absent on unattested routes). */
  origin?: TaskOpOrigin,
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
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
        host.cancel(sessionId);
        return { ok: true, payload: { sessionId } };
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
        // `classifyServiceControlCaller` rule: a payload `sessionId` is
        // agent control, a session-less call is human UI control only
        // with main's sender-bound `shell-ui` attestation — so a caller
        // can neither spoof `actor` nor drop its session to reach the
        // ungated human path.
        if (typeof serviceId !== "string" || (action !== "start" && action !== "stop")) {
          return { ok: false, error: "invalid-payload: task/controlService requires serviceId/action" };
        }
        const caller = classifyServiceControlCaller({
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
      default:
        return { ok: false, error: `unknown-op: ${op}` };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

hostPort.on("message", (event: { data: unknown }) => {
  const message: unknown = event.data;
  if (!isRpcRequest(message)) {
    reply({ kind: "response", id: "unknown", ok: false, error: "invalid-request" });
    return;
  }
  const workspaceId = workspaceOf(message.params);
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
    const result = dispatchTaskOp(taskParams.taskId, taskParams.op, taskParams.payload ?? {}, taskParams.origin);
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
