/**
 * Shared per-op payload guards for `host/task` routing ([PiDock 02] #5).
 *
 * Lives in its own module so both the main sender-side check (`runtime.ts`)
 * and the utilityProcess Host (`host.ts`) validate the same rules without
 * importing an Electron entry point into unit tests. `host.ts` re-exports
 * `validateHostTaskOp` for backward-compatible imports.
 */
import { isHostTaskOp, isTaskOpOrigin, type HostTaskOp } from "../rpc/protocol.js";
import { isAbsoluteTaskRoot } from "../main/task-provision.js";
import { PI_GATED_TOOL_NAMES } from "../main/pi-session.js";
import { isBrowserAction, isPageRef } from "../main/browser-rules.js";

export const DEFAULT_WORKSPACE_ID = "s1-default-workspace";

export type HostTaskRouteResult = "routable" | "task-workspace-mismatch" | "invalid-params";

/**
 * Pure routing rule shared by the Host handler and unit tests: the routed
 * workspace must equal the Host's own binding, and the envelope must name
 * a task, a known op and an object payload. `host.ts` enforces this before
 * dispatching; the string-compare test below exercises this function
 * directly because `host.ts` requires a utilityProcess parent port.
 */
export function routeHostTask(params: unknown, boundWorkspaceId: string): HostTaskRouteResult {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return "invalid-params";
  const record = params as Record<string, unknown>;
  const workspaceId = record["workspaceId"];
  const taskId = record["taskId"];
  const op = record["op"];
  if (typeof workspaceId !== "string" || workspaceId.length === 0) return "invalid-params";
  if (typeof taskId !== "string" || taskId.length === 0) return "invalid-params";
  if (!isHostTaskOp(op)) return "invalid-params";
  const payload = record["payload"];
  if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload))) {
    return "invalid-params";
  }
  if (workspaceId !== boundWorkspaceId) return "task-workspace-mismatch";
  return "routable";
}

export function boundWorkspaceId(): string {
  return process.env["PIDOCK_WORKSPACE_ID"] ?? DEFAULT_WORKSPACE_ID;
}

export type ToolPlannerSpec =
  | { ok: true; mode: "none" }
  | { ok: true; mode: "deny"; tool: string; target: string; contentVersion: string }
  | { ok: true; mode: "echo"; tool: string; target: string; contentVersion: string }
  | { ok: false; error: string };

/**
 * Pure form of the `toolPlan` dispatch `host.ts` enforces before calling
 * `TaskWorkspaceHost.sendMessage`: `toolPlan` requires a gated `tool`
 * (`echo` additionally requires `target`); `deny` forces the
 * out-of-task `/etc/passwd` target so the denial path is coverable.
 * Tested directly because `host.ts` needs a utilityProcess parent port.
 */
export function buildToolPlannerSpec(input: {
  tool?: unknown;
  target?: unknown;
  contentVersion?: unknown;
  toolPlan?: unknown;
}): ToolPlannerSpec {
  const { tool, target, toolPlan } = input;
  const contentVersion = typeof input.contentVersion === "string" && input.contentVersion.length > 0 ? input.contentVersion : "v1";
  if (toolPlan === undefined) return { ok: true, mode: "none" };
  if (toolPlan !== "echo" && toolPlan !== "deny") {
    return { ok: false, error: "invalid-payload: task/sendMessage.toolPlan must be echo/deny" };
  }
  if (typeof tool !== "string" || tool.length === 0) {
    return { ok: false, error: "invalid-payload: task/sendMessage.tool is required when toolPlan is present" };
  }
  if (!PI_GATED_TOOL_NAMES.includes(tool)) {
    return { ok: false, error: `invalid-payload: task/sendMessage.tool is not a gated tool: ${tool}` };
  }
  if (toolPlan === "deny") {
    return { ok: true, mode: "deny", tool, target: "/etc/passwd", contentVersion };
  }
  if (typeof target !== "string" || target.length === 0) {
    return { ok: false, error: "invalid-payload: task/sendMessage.target is required when toolPlan is echo" };
  }
  return { ok: true, mode: "echo", tool, target, contentVersion };
}

export function toolPlannerSpecForOp(op: string, payload: unknown): ToolPlannerSpec | null {
  if ((op as HostTaskOp) !== "task/sendMessage") return null;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, error: "invalid-payload: task/sendMessage requires a payload object" };
  }
  const record = payload as Record<string, unknown>;
  if (record["toolPlan"] === undefined && record["tool"] === undefined) return { ok: true, mode: "none" };
  return buildToolPlannerSpec({
    tool: record["tool"],
    target: record["target"],
    contentVersion: record["contentVersion"],
    toolPlan: record["toolPlan"],
  });
}

/**
 * `host.ts` uses `toolPlannerSpecForOp` as the single entry for the
 * scripted tool-plan decision: `validateHostTaskOp` already ran it for
 * the sender side, and Host dispatch re-runs it before injecting the
 * `execute` closure. Keeps both layers on one pure rule instead of
 * drifting (a late `host.ts`-only check would accept-then-reject).
 */
export function toolPlannerSpecForHostDispatch(record: Record<string, unknown>): ToolPlannerSpec {
  const spec = toolPlannerSpecForOp("task/sendMessage", record);
  return spec ?? { ok: true, mode: "none" };
}

/**
 * Pure actor classification for task-scoped control ops ([PiDock 04] #7
 * service control, [PiDock 06] #8 task browser).
 *
 * A payload `sessionId` is agent control and always goes through the
 * session permission gate. A session-less call is human-UI control only
 * when the trusted main process stamped the `shell-ui` origin on the
 * envelope (sender-bound attestation, see `TaskOpOrigin`): a raw
 * session-less call from any other route (agent tool dispatch over the
 * parent port, in-Host tool calls) is rejected, so a caller cannot shed
 * its session — or omit it — to claim the ungated human path.
 * Tested directly because `host.ts` needs a utilityProcess parent port.
 */
export type ServiceControlCaller =
  | { ok: true; kind: "agent"; sessionId: string }
  | { ok: true; kind: "human"; label: string }
  | { ok: false; error: string };

export function classifyControlCaller(input: {
  sessionId?: unknown;
  label?: unknown;
  origin?: unknown;
}): ServiceControlCaller {
  if (input.sessionId !== undefined) {
    if (typeof input.sessionId !== "string" || input.sessionId.length === 0) {
      return { ok: false, error: "invalid-payload: task/controlService.sessionId must be a non-empty string" };
    }
    return { ok: true, kind: "agent", sessionId: input.sessionId };
  }
  if (!isTaskOpOrigin(input.origin)) {
    return {
      ok: false,
      error: "permission-denied: 无会话的界面操作需要受信任来源，已拒绝",
    };
  }
  const label =
    typeof input.label === "string" && input.label.trim().length > 0 ? input.label : "用户显式操作";
  return { ok: true, kind: "human", label };
}

/** Fork-time task binding: one utilityProcess serves one task folder. */
export interface HostTaskBinding {
  taskId: string;
  taskDir: string;
}

export type TaskBindingRoute = "routable" | "task-unbound" | "task-unknown";

/**
 * Pure form of the per-task binding rule `host.ts` enforces before
 * dispatching: the Host must be bound at fork time (`PIDOCK_TASK_ID` +
 * `PIDOCK_TASK_DIR`), and the op must name the bound task. A routed call
 * naming any other task is rejected even though the envelope itself is
 * well-formed. Tested directly because `host.ts` needs a utilityProcess
 * parent port.
 */
export function routeTaskBinding(
  taskId: unknown,
  boundTaskId: unknown,
  boundTaskDir: unknown,
): TaskBindingRoute {
  if (typeof boundTaskId !== "string" || boundTaskId.length === 0) return "task-unbound";
  if (typeof boundTaskDir !== "string" || boundTaskDir.length === 0) return "task-unbound";
  if (typeof taskId !== "string" || taskId.length === 0) return "task-unknown";
  if (taskId !== boundTaskId) return "task-unknown";
  return "routable";
}

/**
 * Fork-time env for `utilityProcess.fork`: binds the workspace and,
 * when given, the single task folder this Host serves. Partial bindings
 * fail closed here so main never forks a Host that silently serves the
 * wrong task. Pure (base env injected) so unit tests cover it without
 * Electron; `runtime.ts createHost` is the only production caller.
 */
export function buildHostEnv(
  baseEnv: Record<string, string | undefined>,
  workspaceId: string,
  task?: HostTaskBinding,
): Record<string, string> {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("invalid-payload: workspaceId must be a non-empty string");
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === "string") env[key] = value;
  }
  env["PIDOCK_WORKSPACE_ID"] = workspaceId;
  if (task !== undefined) {
    if (typeof task.taskId !== "string" || task.taskId.length === 0) {
      throw new Error("invalid-payload: taskId must be a non-empty string");
    }
    if (typeof task.taskDir !== "string" || !isAbsoluteTaskRoot(task.taskDir)) {
      throw new Error("invalid-payload: taskDir must be an absolute task root");
    }
    env["PIDOCK_TASK_ID"] = task.taskId;
    env["PIDOCK_TASK_DIR"] = task.taskDir;
  }
  return env;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Per-op payload validation (S1 minimal scope). provision/sendMessage reuse
 * the embedded guards; cancel/approve/reject keep an opaque object payload.
 * Unknown ops can never reach here (isHostTaskParams rejects them).
 */
export function validateHostTaskOp(
  op: string,
  payload: unknown,
): { ok: true } | { ok: false; error: string } {
  if (!isHostTaskOp(op)) return { ok: false, error: "unknown-op" };
  if (op === "task/provision") {
    if (!isRecord(payload))
      return {
        ok: false,
        error: "invalid-payload: task/provision requires a payload object",
      };
    // #6 multi-repo + plain-dir fields (all optional, shape-checked here;
    // semantic validation — per-repo pin gates, link snapshots — runs in
    // `TaskWorkspaceHost.provision`). Unknown shapes fail closed.
    for (const key of ["repoSelections", "fetchedCommits", "mainCheckouts", "plainDirs"] as const) {
      const value = payload[key];
      if (value === undefined) continue;
      if (key === "repoSelections") {
        if (
          !Array.isArray(value) ||
          !value.every(
            (entry) =>
              typeof entry === "object" &&
              entry !== null &&
              !Array.isArray(entry) &&
              typeof (entry as Record<string, unknown>)["repoDir"] === "string" &&
              typeof (entry as Record<string, unknown>)["remote"] === "string" &&
              typeof (entry as Record<string, unknown>)["remoteBranch"] === "string" &&
              typeof (entry as Record<string, unknown>)["mainCheckoutDir"] === "string",
          )
        ) {
          return { ok: false, error: "invalid-payload: task/provision.repoSelections must be an array of {repoDir, remote, remoteBranch, mainCheckoutDir}" };
        }
        continue;
      }
      if (key === "plainDirs") {
        if (
          !Array.isArray(value) ||
          !value.every(
            (entry) =>
              typeof entry === "object" &&
              entry !== null &&
              !Array.isArray(entry) &&
              typeof (entry as Record<string, unknown>)["directoryId"] === "string" &&
              typeof (entry as Record<string, unknown>)["sourcePath"] === "string",
          )
        ) {
          return { ok: false, error: "invalid-payload: task/provision.plainDirs must be an array of {directoryId, sourcePath}" };
        }
        continue;
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { ok: false, error: `invalid-payload: task/provision.${key} must be a string->string map` };
      }
      for (const entry of Object.values(value as Record<string, unknown>)) {
        if (typeof entry !== "string") {
          return { ok: false, error: `invalid-payload: task/provision.${key} must be a string->string map` };
        }
      }
    }
    // S2 dispatch shape: Host-owned provision fields (name/dirId/baseline).
    // The S1 transport shape (root/dirId) stays accepted for sender-side
    // compatibility until the renderer form migrates to the S2 fields.
    const dirId = payload["dirId"];
    if (typeof dirId !== "string" || !/^task-[0-9a-f]{8}$/.test(dirId)) {
      return {
        ok: false,
        error: "invalid-payload: task/provision.dirId must match task-oooooooo",
      };
    }
    if ("root" in payload) {
      const root = payload["root"];
      if (typeof root !== "string" || root.trim().length === 0) {
        return {
          ok: false,
          error: "invalid-payload: task/provision.root must be a non-empty string",
        };
      }
      return { ok: true };
    }
    for (const key of ["name", "remoteBranch", "fetchedCommit"] as const) {
      const value = payload[key];
      if (typeof value !== "string" || value.trim().length === 0) {
        return {
          ok: false,
          error: `invalid-payload: task/provision.${key} must be a non-empty string`,
        };
      }
    }
    return { ok: true };
  }
  // #6 append + link probe (shape-checked here; semantic gates run Host-side).
  if (op === "task/appendRepos") {
    if (!isRecord(payload))
      return { ok: false, error: "invalid-payload: task/appendRepos requires a payload object" };
    if (!Array.isArray(payload["repoSelections"])) {
      return { ok: false, error: "invalid-payload: task/appendRepos requires repoSelections" };
    }
    const fetched = payload["fetchedCommits"];
    if (typeof fetched !== "object" || fetched === null || Array.isArray(fetched)) {
      return { ok: false, error: "invalid-payload: task/appendRepos requires fetchedCommits" };
    }
    // Caller-scanned conflict inputs are REQUIRED (never silently `[]`):
    // `appendRepos` fails closed without them so the path/branch gate
    // cannot be skipped by omitting the scan.
    if (!Array.isArray(payload["takenPaths"]) || !Array.isArray(payload["branchesInUse"])) {
      return { ok: false, error: "invalid-payload: task/appendRepos requires caller-scanned takenPaths + branchesInUse" };
    }
    return { ok: true };
  }
  if (op === "task/probeLink") {
    if (!isRecord(payload))
      return { ok: false, error: "invalid-payload: task/probeLink requires a payload object" };
    const sourcePath = payload["sourcePath"];
    if (typeof sourcePath !== "string" || sourcePath.length === 0) {
      return { ok: false, error: "invalid-payload: task/probeLink requires sourcePath" };
    }
    return { ok: true };
  }
  if (op === "task/sendMessage") {
    if (!isRecord(payload))
      return {
        ok: false,
        error: "invalid-payload: task/sendMessage requires a payload object",
      };
    const sessionId = payload["sessionId"];
    const text = payload["text"];
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return {
        ok: false,
        error:
          "invalid-payload: task/sendMessage.sessionId must be a non-empty string",
      };
    }
    if (typeof text !== "string" || text.trim().length === 0) {
      return {
        ok: false,
        error: "invalid-payload: task/sendMessage.text must be a non-empty string",
      };
    }
    // S6 batch 1 turn options ride the same payload (all optional, all
    // fail-closed): provider/model override for per-turn selection,
    // usage counters + source for the persisted call record. `stream` is
    // a local Host-side callback and never crosses the RPC boundary.
    // S6 batch 2: structured input refs (`references`) + skill source
    // (`skillSource`) ride verbatim for send-record association; the Host
    // persists them but never interprets them.
    for (const key of ["providerId", "model"] as const) {
      const value = payload[key];
      if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
        return { ok: false, error: `invalid-payload: task/sendMessage.${key} must be a non-empty string` };
      }
    }
    const usageSource = payload["usageSource"];
    // Intentional asymmetry with `normalizeCallUsage` (pi-session.ts): the
    // internal `approve()` path mints `usageSource:"approval"` for the
    // executed call, but clients can never mint it — a client-supplied
    // `"approval"` is fail-closed here so usage provenance stays honest.
    if (
      usageSource !== undefined &&
      usageSource !== "actual" &&
      usageSource !== "estimated" &&
      usageSource !== "unreported" &&
      usageSource !== "test-double"
    ) {
      return { ok: false, error: "invalid-payload: task/sendMessage.usageSource must be actual/estimated/unreported/test-double" };
    }
    const usage = payload["usage"];
    if (usage !== undefined) {
      if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
        return { ok: false, error: "invalid-payload: task/sendMessage.usage must be an object" };
      }
      for (const key of ["input", "output", "cacheRead"] as const) {
        const value = (usage as Record<string, unknown>)[key];
        if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
          return { ok: false, error: `invalid-payload: task/sendMessage.usage.${key} must be a non-negative number` };
        }
      }
    }
    const credentialRef = payload["credentialRef"];
    if (credentialRef !== undefined && (typeof credentialRef !== "string" || credentialRef.trim().length === 0)) {
      return { ok: false, error: "invalid-payload: task/sendMessage.credentialRef must be a non-empty reference" };
    }
    const skillSource = payload["skillSource"];
    if (skillSource !== undefined && (typeof skillSource !== "string" || skillSource.trim().length === 0)) {
      return { ok: false, error: "invalid-payload: task/sendMessage.skillSource must be a non-empty string" };
    }
    const references = payload["references"];
    if (references !== undefined && !Array.isArray(references)) {
      return { ok: false, error: "invalid-payload: task/sendMessage.references must be an array" };
    }
    // S6 batch 3: scripted tool plan rides the same payload (all optional,
    // all fail-closed). `tool` must name a gated tool, `target` a non-empty
    // string (the task-dir containment check stays Host-side in
    // `previewGate`), `contentVersion` a non-empty string. No executable
    // function ever crosses the RPC boundary: the planner is selected by
    // the Host from `toolPlan` (echo/deny only), never deserialized.
    const tool = payload["tool"];
    if (tool !== undefined && (typeof tool !== "string" || tool.trim().length === 0)) {
      return { ok: false, error: "invalid-payload: task/sendMessage.tool must be a non-empty string" };
    }
    const target = payload["target"];
    if (target !== undefined && (typeof target !== "string" || target.trim().length === 0)) {
      return { ok: false, error: "invalid-payload: task/sendMessage.target must be a non-empty string" };
    }
    const contentVersion = payload["contentVersion"];
    if (contentVersion !== undefined && (typeof contentVersion !== "string" || contentVersion.trim().length === 0)) {
      return { ok: false, error: "invalid-payload: task/sendMessage.contentVersion must be a non-empty string" };
    }
    const toolPlan = payload["toolPlan"];
    if (toolPlan !== undefined && toolPlan !== "echo" && toolPlan !== "deny") {
      return { ok: false, error: 'invalid-payload: task/sendMessage.toolPlan must be echo/deny' };
    }
    // Dual-layer parity with Host dispatch (`host.ts` enforces
    // `buildToolPlannerSpec` before injecting the `execute` closure):
    // `toolPlan` requires a gated `tool` (`echo` additionally requires
    // `target`), so the sender side fails closed early instead of
    // forwarding a combo the Host later rejects.
    const planner = buildToolPlannerSpec({
      tool: payload["tool"],
      target: payload["target"],
      contentVersion: payload["contentVersion"],
      toolPlan: payload["toolPlan"],
    });
    if (!planner.ok) return { ok: false, error: planner.error };
    return { ok: true };
  }
  // S6 batch 2 follow-up: draft/permission ops are Host-reachable (P1).
  // `task/saveDraft` stores an unsent composer draft (never auto-sends);
  // `task/clearDraft` drops it; `task/setPermission` mutates future turns
  // only (forward-only, never rewrites the in-flight approval).
  if (op === "task/saveDraft") {
    if (!isRecord(payload))
      return { ok: false, error: "invalid-payload: task/saveDraft requires a payload object" };
    const sessionId = payload["sessionId"];
    const text = payload["text"];
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return { ok: false, error: "invalid-payload: task/saveDraft.sessionId must be a non-empty string" };
    }
    if (typeof text !== "string") {
      return { ok: false, error: "invalid-payload: task/saveDraft.text must be a string" };
    }
    const references = payload["references"];
    if (references !== undefined && !Array.isArray(references)) {
      return { ok: false, error: "invalid-payload: task/saveDraft.references must be an array" };
    }
    const skillSource = payload["skillSource"];
    if (skillSource !== undefined && (typeof skillSource !== "string" || skillSource.trim().length === 0)) {
      return { ok: false, error: "invalid-payload: task/saveDraft.skillSource must be a non-empty string" };
    }
    return { ok: true };
  }
  if (op === "task/clearDraft") {
    if (!isRecord(payload))
      return { ok: false, error: "invalid-payload: task/clearDraft requires a payload object" };
    const sessionId = payload["sessionId"];
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return { ok: false, error: "invalid-payload: task/clearDraft.sessionId must be a non-empty string" };
    }
    return { ok: true };
  }
  if (op === "task/setPermission") {
    if (!isRecord(payload))
      return { ok: false, error: "invalid-payload: task/setPermission requires a payload object" };
    const sessionId = payload["sessionId"];
    const permission = payload["permission"];
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return { ok: false, error: "invalid-payload: task/setPermission.sessionId must be a non-empty string" };
    }
    if (permission !== "read" && permission !== "default" && permission !== "auto") {
      return { ok: false, error: "invalid-payload: task/setPermission.permission must be read/default/auto" };
    }
    return { ok: true };
  }
  // S6 final wiring: approval listing reads (`task/listApprovals` +
  // `task/getApproval`) are Host-reachable so the renderer shell adapter
  // lists real Host approvals instead of merging local synthetics. Both
  // carry an optional `sessionId` filter (empty/absent = all sessions);
  // anything else is fail-closed.
  if (op === "task/listApprovals") {
    if (payload !== undefined && !isRecord(payload)) {
      return { ok: false, error: "invalid-payload: task/listApprovals payload must be an object" };
    }
    const record = isRecord(payload) ? payload : {};
    const sessionId = record["sessionId"];
    if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.trim().length === 0)) {
      return { ok: false, error: "invalid-payload: task/listApprovals.sessionId must be a non-empty string" };
    }
    return { ok: true };
  }
  if (op === "task/getApproval") {
    if (!isRecord(payload))
      return { ok: false, error: "invalid-payload: task/getApproval requires a payload object" };
    const approvalId = payload["approvalId"];
    if (typeof approvalId !== "string" || approvalId.trim().length === 0) {
      return { ok: false, error: "invalid-payload: task/getApproval.approvalId must be a non-empty string" };
    }
    return { ok: true };
  }
  // [PiDock 04] (#7) service ops: envelope shape only here (fail-closed
  // on missing ids); semantic validation (descriptor guard, env
  // resolution, gate tiers) runs Host-side in `service-runtime.ts` via
  // `host.ts` dispatch so unit tests cover both layers.
  if (op === "task/registerService") {
    if (!isRecord(payload))
      return { ok: false, error: "invalid-payload: task/registerService requires a payload object" };
    const serviceId = payload["serviceId"];
    const descriptor = payload["descriptor"];
    const serviceLayers = payload["layers"];
    const templateVersion = payload["templateVersion"];
    if (typeof serviceId !== "string" || serviceId.trim().length === 0) {
      return { ok: false, error: "invalid-payload: task/registerService.serviceId must be a non-empty string" };
    }
    if (typeof descriptor !== "object" || descriptor === null || Array.isArray(descriptor)) {
      return { ok: false, error: "invalid-payload: task/registerService.descriptor must be an object" };
    }
    if (typeof serviceLayers !== "object" || serviceLayers === null || Array.isArray(serviceLayers)) {
      return { ok: false, error: "invalid-payload: task/registerService.layers must be an object" };
    }
    if (typeof templateVersion !== "string" || templateVersion.trim().length === 0) {
      return { ok: false, error: "invalid-payload: task/registerService.templateVersion must be a non-empty string" };
    }
    return { ok: true };
  }
  if (op === "task/planServiceStart" || op === "task/serviceStatus" || op === "task/serviceLog") {
    if (!isRecord(payload))
      return { ok: false, error: `invalid-payload: ${op} requires a payload object` };
    const serviceId = payload["serviceId"];
    if (typeof serviceId !== "string" || serviceId.trim().length === 0) {
      return { ok: false, error: `invalid-payload: ${op}.serviceId must be a non-empty string` };
    }
    return { ok: true };
  }
  if (op === "task/controlService") {
    if (!isRecord(payload))
      return { ok: false, error: "invalid-payload: task/controlService requires a payload object" };
    const serviceId = payload["serviceId"];
    const action = payload["action"];
    if (typeof serviceId !== "string" || serviceId.trim().length === 0) {
      return { ok: false, error: "invalid-payload: task/controlService.serviceId must be a non-empty string" };
    }
    if (action !== "start" && action !== "stop") {
      return { ok: false, error: "invalid-payload: task/controlService.action must be start/stop" };
    }
    return { ok: true };
  }
  // [PiDock 06] (#8) task browser: envelope shape only here (known action,
  // page handle shape when present, actor ids); page ownership, the
  // navigation allowlist, takeover state, evidence bounds and the agent
  // permission gate all run later on the authoritative side
  // (`browser-gateway.ts` in main, `browser-control.ts` in the Host).
  if (op === "task/browserAction") {
    if (!isRecord(payload))
      return { ok: false, error: "invalid-payload: task/browserAction requires a payload object" };
    const action = payload["action"];
    if (!isBrowserAction(action)) {
      return { ok: false, error: "invalid-payload: task/browserAction.action must be a known browser action" };
    }
    const page = payload["page"];
    if (page !== undefined && !isPageRef(page)) {
      return { ok: false, error: "invalid-payload: task/browserAction.page must be {taskId?, pageId, webContentsId?}" };
    }
    const sessionId = payload["sessionId"];
    if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.trim().length === 0)) {
      return { ok: false, error: "invalid-payload: task/browserAction.sessionId must be a non-empty string" };
    }
    const targetSessionId = payload["targetSessionId"];
    if (targetSessionId !== undefined && (typeof targetSessionId !== "string" || targetSessionId.trim().length === 0)) {
      return { ok: false, error: "invalid-payload: task/browserAction.targetSessionId must be a non-empty string" };
    }
    const params = payload["params"];
    if (params !== undefined && !isRecord(params)) {
      return { ok: false, error: "invalid-payload: task/browserAction.params must be an object" };
    }
    return { ok: true };
  }
  if (payload !== undefined && !isRecord(payload)) {
    return { ok: false, error: `invalid-payload: ${op} payload must be an object` };
  }
  return { ok: true };
}
