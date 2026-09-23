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
import { PI_USAGE_GROUP_BY, PI_USAGE_KINDS, type PiUsageGroupBy } from "../main/usage-ledger.js";
import { isUsageKindName } from "./task-store.js";
import { isBrowserAction, isPageRef } from "../main/browser-rules.js";
import { isExternalResourceKind } from "../main/service-runs.js";
import { checkReferencePayload } from "../main/composer-references.js";

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

/** Shared root-id shape check for the [PiDock 10] (#15) file/terminal ops. */
function isNonEmptyRootId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUsageGroupBy(value: unknown): value is PiUsageGroupBy {
  return typeof value === "string" && (PI_USAGE_GROUP_BY as readonly string[]).includes(value);
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

/**
 * Session a user's browser marker is logged into ([PiDock 06] #8): a named
 * session must already exist, so a typo cannot silently create a new
 * conversation; without a name the task's first persisted session is the
 * current one (multi-session routing is #9/#11).
 */
export function resolveBrowserLogSession(
  requested: string,
  knownSessionIds: readonly string[],
): { ok: true; sessionId: string } | { ok: false; error: string } {
  if (requested.length === 0) {
    return { ok: true, sessionId: knownSessionIds[0] ?? "main" };
  }
  if (!knownSessionIds.includes(requested)) {
    return { ok: false, error: `unknown-session: ${requested} 不存在，标记未发送` };
  }
  return { ok: true, sessionId: requested };
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
    // [PiDock 13] (#16) box 15: the Host persists references verbatim, so the
    // provenance itself is checked fail-closed here — an out-of-source path,
    // an unknown kind or a plain-directory link claiming a Git version never
    // reaches the session or a stored draft.
    if (Array.isArray(references)) {
      for (let index = 0; index < references.length; index += 1) {
        const checked = checkReferencePayload(references[index]);
        if (!checked.ok) {
          return { ok: false, error: `invalid-payload: task/sendMessage.references[${index}].${checked.error}` };
        }
      }
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
    // [PiDock 13] (#16) box 14/15: a stored draft reference carries the same
    // provenance rules as a live send, so a restored draft cannot bind to a
    // source the Host would refuse to send.
    if (Array.isArray(references)) {
      for (let index = 0; index < references.length; index += 1) {
        const checked = checkReferencePayload(references[index]);
        if (!checked.ok) {
          return { ok: false, error: `invalid-payload: task/saveDraft.references[${index}].${checked.error}` };
        }
      }
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
  // [PiDock 09] (#11) write-coordination read: no caller-chosen input, so only
  // the envelope shape is checked here (an empty payload is a full read).
  if (op === "task/sessionStates") {
    if (payload !== undefined && !isRecord(payload)) {
      return { ok: false, error: "invalid-payload: task/sessionStates payload must be an object" };
    }
    return { ok: true };
  }
  // [PiDock 12] #12 usage reads/cleanup: envelope shape only here, semantics
  // (time bounds, grouping dimension, cleanup scope) are validated against
  // the ledger rules in `usage-ledger.ts` and applied by the Host.
  if (op === "task/usageRecords") {
    if (payload !== undefined && !isRecord(payload)) {
      return { ok: false, error: "invalid-payload: task/usageRecords payload must be an object" };
    }
    const usagePayload = payload ?? {};
    for (const key of ["sessionId", "providerId", "model", "from", "to"] as const) {
      const value = usagePayload[key];
      if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
        return { ok: false, error: `invalid-payload: task/usageRecords.${key} must be a non-empty string` };
      }
    }
    const kind = usagePayload["kind"];
    if (kind !== undefined && !isUsageKindName(kind)) {
      return { ok: false, error: `invalid-payload: task/usageRecords.kind must be ${PI_USAGE_KINDS.join("/")}` };
    }
    const groupBy = usagePayload["groupBy"];
    if (groupBy !== undefined && !isUsageGroupBy(groupBy)) {
      return { ok: false, error: `invalid-payload: task/usageRecords.groupBy must be ${PI_USAGE_GROUP_BY.join("/")}` };
    }
    return { ok: true };
  }
  if (op === "task/clearUsage") {
    if (!isRecord(payload)) {
      return { ok: false, error: "invalid-payload: task/clearUsage requires a payload object" };
    }
    const scope = payload["scope"];
    if (!isRecord(scope)) {
      return { ok: false, error: "invalid-payload: task/clearUsage.scope must be an object" };
    }
    if (scope["kind"] === "all") return { ok: true };
    if (scope["kind"] === "session") {
      const sessionId = scope["sessionId"];
      if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
        return { ok: false, error: "invalid-payload: task/clearUsage.scope.sessionId must be a non-empty string" };
      }
      return { ok: true };
    }
    if (scope["kind"] === "before") {
      const before = scope["before"];
      if (typeof before !== "string" || before.trim().length === 0) {
        return { ok: false, error: "invalid-payload: task/clearUsage.scope.before must be a non-empty string" };
      }
      return { ok: true };
    }
    return { ok: false, error: "invalid-payload: task/clearUsage.scope.kind must be all/session/before" };
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
  // [PiDock 05] (#10) multi-service topology: shape-check the plan request
  // here (semantic validation — unit/repo rules, port allocation, binding
  // conflicts — runs Host-side in `TaskServiceTopology.setPlan`, which
  // throws and becomes an `{ok:false}` envelope). The run-record and
  // stop-scope ops are reads over the Host's registry.
  if (op === "task/planServiceGroup") {
    if (!isRecord(payload)) return { ok: false, error: "invalid-payload: task/planServiceGroup requires a payload object" };
    const units = payload["units"];
    if (
      !Array.isArray(units) ||
      !units.every(
        (entry) =>
          isRecord(entry) &&
          typeof entry["unitId"] === "string" &&
          entry["unitId"].trim().length > 0 &&
          typeof entry["serviceId"] === "string" &&
          typeof entry["name"] === "string" &&
          (entry["location"] === "local" || entry["location"] === "remote") &&
          (entry["repoDir"] === undefined || typeof entry["repoDir"] === "string") &&
          (entry["runType"] === undefined ||
            entry["runType"] === "long-lived" ||
            entry["runType"] === "prepare" ||
            entry["runType"] === "one-shot"),
      )
    ) {
      return { ok: false, error: "invalid-payload: task/planServiceGroup.units must be an array of {unitId, serviceId, name, location}" };
    }
    const selectedRepoDirs = payload["selectedRepoDirs"];
    if (selectedRepoDirs !== undefined && (!Array.isArray(selectedRepoDirs) || !selectedRepoDirs.every((entry) => typeof entry === "string"))) {
      return { ok: false, error: "invalid-payload: task/planServiceGroup.selectedRepoDirs must be a string array" };
    }
    const dependencies = payload["dependencies"];
    if (
      dependencies !== undefined &&
      (!Array.isArray(dependencies) ||
        !dependencies.every(
          (entry) =>
            isRecord(entry) &&
            typeof entry["from"] === "string" &&
            entry["from"].trim().length > 0 &&
            typeof entry["to"] === "string" &&
            entry["to"].trim().length > 0 &&
            (entry["kind"] === "call" || entry["kind"] === "prestart"),
        ))
    ) {
      return { ok: false, error: "invalid-payload: task/planServiceGroup.dependencies must be an array of {from, to, kind}" };
    }
    const requests = payload["requests"];
    if (
      requests !== undefined &&
      (!Array.isArray(requests) ||
        !requests.every((entry) => isRecord(entry) && typeof entry["unitId"] === "string" && typeof entry["port"] === "number"))
    ) {
      return { ok: false, error: "invalid-payload: task/planServiceGroup.requests must be an array of {unitId, port}" };
    }
    const reservations = payload["reservations"];
    if (
      reservations !== undefined &&
      (!Array.isArray(reservations) ||
        !reservations.every(
          (entry) =>
            isRecord(entry) &&
            typeof entry["port"] === "number" &&
            (entry["owner"] === "external" || entry["owner"] === "task") &&
            (entry["taskId"] === undefined || typeof entry["taskId"] === "string") &&
            (entry["unitId"] === undefined || typeof entry["unitId"] === "string") &&
            (entry["serviceId"] === undefined || typeof entry["serviceId"] === "string") &&
            (entry["note"] === undefined || typeof entry["note"] === "string"),
        ))
    ) {
      return { ok: false, error: "invalid-payload: task/planServiceGroup.reservations must be an array of {port, owner}" };
    }
    const rules = payload["rules"];
    if (
      rules !== undefined &&
      (!Array.isArray(rules) ||
        !rules.every(
          (entry) =>
            isRecord(entry) &&
            typeof entry["key"] === "string" &&
            entry["key"].trim().length > 0 &&
            typeof entry["unitId"] === "string" &&
            (entry["kind"] === "url" || entry["kind"] === "host-port") &&
            (entry["template"] === undefined || typeof entry["template"] === "string"),
        ))
    ) {
      return { ok: false, error: "invalid-payload: task/planServiceGroup.rules must be an array of {key, unitId, kind}" };
    }
    const layers = payload["layers"];
    if (layers !== undefined) {
      if (!isRecord(layers)) return { ok: false, error: "invalid-payload: task/planServiceGroup.layers must be an object" };
      for (const layerName of ["repoDefaults", "shared", "privateEntries", "task"] as const) {
        const rows = layers[layerName];
        if (
          !Array.isArray(rows) ||
          !rows.every(
            (row) => isRecord(row) && typeof row["key"] === "string" && typeof row["value"] === "string" && typeof row["secret"] === "boolean",
          )
        ) {
          return { ok: false, error: `invalid-payload: task/planServiceGroup.layers.${layerName} must be an array of config rows` };
        }
      }
    }
    const environment = payload["environment"];
    if (environment !== undefined && typeof environment !== "string") {
      return { ok: false, error: "invalid-payload: task/planServiceGroup.environment must be a string" };
    }
    const externalResources = payload["externalResources"];
    if (
      externalResources !== undefined &&
      (!Array.isArray(externalResources) ||
        !externalResources.every(
          (entry) =>
            isRecord(entry) &&
            typeof entry["resourceId"] === "string" &&
            entry["resourceId"].trim().length > 0 &&
            typeof entry["name"] === "string" &&
            isExternalResourceKind(entry["kind"]) &&
            (entry["isolatedByTask"] === undefined || typeof entry["isolatedByTask"] === "boolean"),
        ))
    ) {
      return { ok: false, error: "invalid-payload: task/planServiceGroup.externalResources must be an array of {resourceId, name, kind}" };
    }
    const runTypes = payload["runTypes"];
    if (runTypes !== undefined) {
      if (!isRecord(runTypes)) return { ok: false, error: "invalid-payload: task/planServiceGroup.runTypes must be an object" };
      for (const value of Object.values(runTypes)) {
        if (value !== "long-lived" && value !== "prepare" && value !== "one-shot") {
          return { ok: false, error: "invalid-payload: task/planServiceGroup.runTypes values must be long-lived/prepare/one-shot" };
        }
      }
    }
    return { ok: true };
  }
  // [PiDock 08] (#14) task-local protocol generation + consumer binding:
  // envelope shape only here; semantic validation (protocol repo is not a
  // consumer, unique consumer/repo, task-scoped plan paths) runs Host-side in
  // `TaskProtocolBinding.setPlan`, and generation/binding results are
  // caller-reported observations, never fabricated.
  if (op === "task/planProtocol") {
    if (!isRecord(payload)) return { ok: false, error: "invalid-payload: task/planProtocol requires a payload object" };
    const protocol = payload["protocol"];
    if (
      !isRecord(protocol) ||
      typeof protocol["repoDir"] !== "string" ||
      typeof protocol["goGenDir"] !== "string" ||
      typeof protocol["tsGenDir"] !== "string"
    ) {
      return { ok: false, error: "invalid-payload: task/planProtocol.protocol must be {repoDir, goGenDir, tsGenDir}" };
    }
    if (payload["mode"] !== "release" && payload["mode"] !== "local") {
      return { ok: false, error: "invalid-payload: task/planProtocol.mode must be release/local" };
    }
    const steps = payload["steps"];
    if (
      steps !== undefined &&
      (!Array.isArray(steps) ||
        !steps.every(
          (entry) =>
            isRecord(entry) &&
            (entry["kind"] === "generate" || entry["kind"] === "postprocess") &&
            typeof entry["program"] === "string" &&
            Array.isArray(entry["args"]) &&
            entry["args"].every((arg) => typeof arg === "string") &&
            typeof entry["cwd"] === "string" &&
            (entry["note"] === undefined || typeof entry["note"] === "string"),
        ))
    ) {
      return { ok: false, error: "invalid-payload: task/planProtocol.steps must be an array of {kind, program, args, cwd}" };
    }
    const consumers = payload["consumers"];
    if (
      !Array.isArray(consumers) ||
      !consumers.every(
        (entry) =>
          isRecord(entry) &&
          typeof entry["consumerId"] === "string" &&
          entry["consumerId"].trim().length > 0 &&
          typeof entry["name"] === "string" &&
          typeof entry["repoDir"] === "string" &&
          (entry["language"] === "go" || entry["language"] === "ts") &&
          typeof entry["releaseDependency"] === "string" &&
          (entry["serviceId"] === undefined || typeof entry["serviceId"] === "string") &&
          (entry["linkScript"] === undefined || typeof entry["linkScript"] === "string") &&
          (entry["linkTarget"] === undefined || typeof entry["linkTarget"] === "string"),
      )
    ) {
      return { ok: false, error: "invalid-payload: task/planProtocol.consumers must be an array of {consumerId, name, repoDir, language, releaseDependency}" };
    }
    const acknowledged = payload["acknowledged"];
    if (acknowledged !== undefined && (!Array.isArray(acknowledged) || !acknowledged.every((entry) => typeof entry === "string"))) {
      return { ok: false, error: "invalid-payload: task/planProtocol.acknowledged must be a string array" };
    }
    return { ok: true };
  }
  if (op === "task/protocolState") {
    if (payload !== undefined && !isRecord(payload)) {
      return { ok: false, error: "invalid-payload: task/protocolState payload must be an object" };
    }
    return { ok: true };
  }
  if (op === "task/recordProtocolRun") {
    if (!isRecord(payload)) return { ok: false, error: "invalid-payload: task/recordProtocolRun requires a payload object" };
    if (typeof payload["generatedVersion"] !== "string") {
      return { ok: false, error: "invalid-payload: task/recordProtocolRun.generatedVersion must be a string" };
    }
    if (typeof payload["ok"] !== "boolean") {
      return { ok: false, error: "invalid-payload: task/recordProtocolRun.ok must be a boolean" };
    }
    if (payload["note"] !== undefined && typeof payload["note"] !== "string") {
      return { ok: false, error: "invalid-payload: task/recordProtocolRun.note must be a string" };
    }
    const toolchain = payload["toolchain"];
    if (toolchain !== undefined) {
      if (!isRecord(toolchain) || typeof toolchain["platform"] !== "string") {
        return { ok: false, error: "invalid-payload: task/recordProtocolRun.toolchain must be {platform, probe?}" };
      }
      const probe = toolchain["probe"];
      if (
        probe !== undefined &&
        (!isRecord(probe) ||
          !Object.values(probe).every(
            (entry) =>
              isRecord(entry) &&
              typeof entry["ok"] === "boolean" &&
              (entry["version"] === undefined || typeof entry["version"] === "string") &&
              (entry["note"] === undefined || typeof entry["note"] === "string"),
          ))
      ) {
        return { ok: false, error: "invalid-payload: task/recordProtocolRun.toolchain.probe must be {[tool]: {ok, version?}}" };
      }
    }
    const depsInstalled = payload["depsInstalled"];
    if (
      depsInstalled !== undefined &&
      (!Array.isArray(depsInstalled) ||
        !depsInstalled.every((entry) => isRecord(entry) && typeof entry["consumerId"] === "string" && typeof entry["installed"] === "boolean"))
    ) {
      return { ok: false, error: "invalid-payload: task/recordProtocolRun.depsInstalled must be an array of {consumerId, installed}" };
    }
    const resolutions = payload["resolutions"];
    if (
      resolutions !== undefined &&
      (!Array.isArray(resolutions) ||
        !resolutions.every(
          (entry) =>
            isRecord(entry) &&
            typeof entry["consumerId"] === "string" &&
            typeof entry["path"] === "string" &&
            (entry["version"] === undefined || entry["version"] === null || typeof entry["version"] === "string"),
        ))
    ) {
      return { ok: false, error: "invalid-payload: task/recordProtocolRun.resolutions must be an array of {consumerId, path, version?}" };
    }
    const runtimeReachable = payload["runtimeReachable"];
    if (runtimeReachable !== undefined) {
      if (!isRecord(runtimeReachable) || typeof runtimeReachable["ok"] !== "boolean" || typeof runtimeReachable["detail"] !== "string") {
        return { ok: false, error: "invalid-payload: task/recordProtocolRun.runtimeReachable must be {ok, detail}" };
      }
    }
    return { ok: true };
  }
  if (op === "task/serviceRunRecords") {
    if (payload !== undefined && !isRecord(payload)) {
      return { ok: false, error: "invalid-payload: task/serviceRunRecords payload must be an object" };
    }
    return { ok: true };
  }
  if (op === "task/serviceStopScope") {
    if (payload !== undefined && !isRecord(payload)) {
      return { ok: false, error: "invalid-payload: task/serviceStopScope payload must be an object" };
    }
    const instanceId = isRecord(payload) ? payload["instanceId"] : undefined;
    if (instanceId !== undefined && (typeof instanceId !== "string" || instanceId.trim().length === 0)) {
      return { ok: false, error: "invalid-payload: task/serviceStopScope.instanceId must be a non-empty string" };
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
  // [PiDock 11] (#9) provider/model/context ops: the catalog and the per-model
  // declarations are shape-checked here (semantic validation — profile rules,
  // switch gate — runs Host-side in `provider-config.ts`/`TaskWorkspaceHost`).
  if (op === "task/setProviderCatalog") {
    if (!isRecord(payload)) return { ok: false, error: "invalid-payload: task/setProviderCatalog requires a payload object" };
    const catalog = payload["catalog"];
    if (!Array.isArray(catalog) || !catalog.every((entry) => isRecord(entry))) {
      return { ok: false, error: "invalid-payload: task/setProviderCatalog.catalog must be an array of provider objects" };
    }
    return { ok: true };
  }
  if (op === "task/sessionContext" || op === "task/compactSession") {
    if (!isRecord(payload)) return { ok: false, error: `invalid-payload: ${op} requires a payload object` };
    const sessionId = payload["sessionId"];
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return { ok: false, error: `invalid-payload: ${op}.sessionId must be a non-empty string` };
    }
    const catalog = payload["catalog"];
    if (catalog !== undefined && (!Array.isArray(catalog) || !catalog.every((entry) => isRecord(entry)))) {
      return { ok: false, error: `invalid-payload: ${op}.catalog must be an array of provider objects` };
    }
    return { ok: true };
  }
  if (op === "task/setSessionModel") {
    if (!isRecord(payload)) return { ok: false, error: "invalid-payload: task/setSessionModel requires a payload object" };
    for (const key of ["sessionId", "providerId", "model"] as const) {
      const value = payload[key];
      if (typeof value !== "string" || value.trim().length === 0) {
        return { ok: false, error: `invalid-payload: task/setSessionModel.${key} must be a non-empty string` };
      }
    }
    const reason = payload["reason"];
    if (reason !== undefined && reason !== "human-switch" && reason !== "agent-switch") {
      return { ok: false, error: "invalid-payload: task/setSessionModel.reason must be human-switch/agent-switch" };
    }
    const catalog = payload["catalog"];
    if (catalog !== undefined && (!Array.isArray(catalog) || !catalog.every((entry) => isRecord(entry)))) {
      return { ok: false, error: "invalid-payload: task/setSessionModel.catalog must be an array of provider objects" };
    }
    return { ok: true };
  }
  if (op === "task/setSessionThinking") {
    if (!isRecord(payload)) return { ok: false, error: "invalid-payload: task/setSessionThinking requires a payload object" };
    const sessionId = payload["sessionId"];
    const level = payload["level"];
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return { ok: false, error: "invalid-payload: task/setSessionThinking.sessionId must be a non-empty string" };
    }
    // An empty level is the "clear/skip" request; the Host decides whether the
    // model may turn reasoning off (fail-closed) instead of rejecting the shape.
    if (typeof level !== "string") {
      return { ok: false, error: "invalid-payload: task/setSessionThinking.level must be a string" };
    }
    const catalog = payload["catalog"];
    if (catalog !== undefined && (!Array.isArray(catalog) || !catalog.every((entry) => isRecord(entry)))) {
      return { ok: false, error: "invalid-payload: task/setSessionThinking.catalog must be an array of provider objects" };
    }
    return { ok: true };
  }
  // [PiDock 10] (#15) file browsing / diff / delivery: envelope shape only
  // here. Which roots exist, whether a path escapes them and how much of an
  // answer may cross the boundary are decided Host-side
  // (`host/workspace-files.ts` + `main/workspace-files.ts`).
  if (op === "task/fileRoots" || op === "task/terminalState") {
    if (payload !== undefined && !isRecord(payload)) {
      return { ok: false, error: `invalid-payload: ${op} payload must be an object` };
    }
    return { ok: true };
  }
  if (op === "task/fileTree" || op === "task/filePreview" || op === "task/fileDiff" || op === "task/deliveryInfo") {
    if (!isRecord(payload)) return { ok: false, error: `invalid-payload: ${op} requires a payload object` };
    const rootId = payload["rootId"];
    if (typeof rootId !== "string" || rootId.trim().length === 0) {
      return { ok: false, error: `invalid-payload: ${op}.rootId must be a non-empty string` };
    }
    const relative = payload["relative"];
    if (relative !== undefined && typeof relative !== "string") {
      return { ok: false, error: `invalid-payload: ${op}.relative must be a string` };
    }
    // A preview reads one file: an explicit relative path is required.
    if (op === "task/filePreview" && (typeof relative !== "string" || relative.trim().length === 0)) {
      return { ok: false, error: "invalid-payload: task/filePreview.relative must be a non-empty string" };
    }
    return { ok: true };
  }
  if (op === "task/terminalHistory") {
    if (!isRecord(payload)) return { ok: false, error: "invalid-payload: task/terminalHistory requires a payload object" };
    const instanceId = payload["instanceId"];
    if (typeof instanceId !== "string" || instanceId.trim().length === 0) {
      return { ok: false, error: "invalid-payload: task/terminalHistory.instanceId must be a non-empty string" };
    }
    const limit = payload["limit"];
    if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0)) {
      return { ok: false, error: "invalid-payload: task/terminalHistory.limit must be a positive integer" };
    }
    return { ok: true };
  }
  if (op === "task/planTerminal") {
    if (!isRecord(payload)) return { ok: false, error: "invalid-payload: task/planTerminal requires a payload object" };
    const instanceId = payload["instanceId"];
    if (typeof instanceId !== "string" || instanceId.trim().length === 0) {
      return { ok: false, error: "invalid-payload: task/planTerminal.instanceId must be a non-empty string" };
    }
    if (typeof payload["program"] !== "string") {
      return { ok: false, error: "invalid-payload: task/planTerminal.program must be a string" };
    }
    const terminalLayers = payload["layers"];
    if (typeof terminalLayers !== "object" || terminalLayers === null || Array.isArray(terminalLayers)) {
      return { ok: false, error: "invalid-payload: task/planTerminal.layers must be an object" };
    }
    if (!isNonEmptyRootId(payload["rootId"])) {
      return { ok: false, error: "invalid-payload: task/planTerminal.rootId must be a non-empty string" };
    }
    const terminalArgs = payload["args"];
    if (terminalArgs !== undefined && (!Array.isArray(terminalArgs) || !terminalArgs.every((entry) => typeof entry === "string"))) {
      return { ok: false, error: "invalid-payload: task/planTerminal.args must be an array of strings" };
    }
    for (const key of ["cols", "rows"] as const) {
      const value = payload[key];
      if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value))) {
        return { ok: false, error: `invalid-payload: task/planTerminal.${key} must be an integer` };
      }
    }
    return { ok: true };
  }
  if (op === "task/terminalControl") {
    if (!isRecord(payload)) return { ok: false, error: "invalid-payload: task/terminalControl requires a payload object" };
    const instanceId = payload["instanceId"];
    const action = payload["action"];
    if (typeof instanceId !== "string" || instanceId.trim().length === 0) {
      return { ok: false, error: "invalid-payload: task/terminalControl.instanceId must be a non-empty string" };
    }
    if (action !== "start" && action !== "stop") {
      return { ok: false, error: "invalid-payload: task/terminalControl.action must be start/stop" };
    }
    const sessionId = payload["sessionId"];
    if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.trim().length === 0)) {
      return { ok: false, error: "invalid-payload: task/terminalControl.sessionId must be a non-empty string" };
    }
    if (action === "start") {
      if (typeof payload["program"] !== "string") {
        return { ok: false, error: "invalid-payload: task/terminalControl.program must be a string when starting" };
      }
      if (!isNonEmptyRootId(payload["rootId"])) {
        return { ok: false, error: "invalid-payload: task/terminalControl.rootId must be a non-empty string when starting" };
      }
      const startLayers = payload["layers"];
      if (typeof startLayers !== "object" || startLayers === null || Array.isArray(startLayers)) {
        return { ok: false, error: "invalid-payload: task/terminalControl.layers must be an object when starting" };
      }
      const startArgs = payload["args"];
      if (startArgs !== undefined && (!Array.isArray(startArgs) || !startArgs.every((entry) => typeof entry === "string"))) {
        return { ok: false, error: "invalid-payload: task/terminalControl.args must be an array of strings" };
      }
      for (const key of ["cols", "rows"] as const) {
        const value = payload[key];
        if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value))) {
          return { ok: false, error: `invalid-payload: task/terminalControl.${key} must be an integer` };
        }
      }
    }
    return { ok: true };
  }
  // [PiDock 14] (#17) lifecycle: reads carry no caller-chosen target (the
  // Host reads its own task folder), archive/restore are explicit human-UI
  // actions refused for an agent session, and cleanup requires the task to be
  // archived plus an export selection whose shape is checked here.
  if (op === "task/lifecycleState") {
    if (payload !== undefined && !isRecord(payload)) {
      return { ok: false, error: "invalid-payload: task/lifecycleState payload must be an object" };
    }
    return { ok: true };
  }
  if (op === "task/archive" || op === "task/restore") {
    if (payload !== undefined && !isRecord(payload)) {
      return { ok: false, error: `invalid-payload: ${op} payload must be an object` };
    }
    const label = payload === undefined ? undefined : payload["label"];
    if (label !== undefined && typeof label !== "string") {
      return { ok: false, error: `invalid-payload: ${op}.label must be a string` };
    }
    return { ok: true };
  }
  if (op === "task/quit") {
    if (payload !== undefined && !isRecord(payload)) {
      return { ok: false, error: "invalid-payload: task/quit payload must be an object" };
    }
    const label = payload === undefined ? undefined : payload["label"];
    if (label !== undefined && typeof label !== "string") {
      return { ok: false, error: "invalid-payload: task/quit.label must be a string" };
    }
    return { ok: true };
  }
  if (op === "task/cleanupPreview" || op === "task/runCleanup") {
    if (!isRecord(payload)) return { ok: false, error: `invalid-payload: ${op} requires a payload object` };
    const selection = payload["selection"];
    if (typeof selection !== "object" || selection === null || Array.isArray(selection)) {
      return { ok: false, error: `invalid-payload: ${op}.selection must be an object` };
    }
    for (const key of ["exportSessions", "exportDrafts", "exportUsage"] as const) {
      if (typeof (selection as Record<string, unknown>)[key] !== "boolean") {
        return { ok: false, error: `invalid-payload: ${op}.selection.${key} must be a boolean` };
      }
    }
    const keepRoot = payload["keepRoot"];
    if (keepRoot !== undefined && (typeof keepRoot !== "string" || keepRoot.trim().length === 0)) {
      return { ok: false, error: `invalid-payload: ${op}.keepRoot must be a non-empty string` };
    }
    const label = payload["label"];
    if (label !== undefined && typeof label !== "string") {
      return { ok: false, error: `invalid-payload: ${op}.label must be a string` };
    }
    return { ok: true };
  }
  // [PiDock 17] (#19) execution state + attention reads.
  if (op === "task/executionState") {
    if (!isRecord(payload)) return { ok: false, error: "invalid-payload: task/executionState requires a payload object" };
    const sessionId = payload["sessionId"];
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return { ok: false, error: "invalid-payload: task/executionState.sessionId must be a non-empty string" };
    }
    const services = payload["services"];
    if (services !== undefined) {
      if (!Array.isArray(services)) return { ok: false, error: "invalid-payload: task/executionState.services must be an array" };
      for (const entry of services) {
        if (!isRecord(entry)) return { ok: false, error: "invalid-payload: task/executionState.services entries must be objects" };
        const serviceId = entry["serviceId"];
        if (typeof serviceId !== "string" || serviceId.trim().length === 0) {
          return { ok: false, error: "invalid-payload: task/executionState.services.serviceId must be a non-empty string" };
        }
        if (typeof entry["running"] !== "boolean") {
          return { ok: false, error: "invalid-payload: task/executionState.services.running must be a boolean" };
        }
      }
    }
    return { ok: true };
  }
  if (op === "task/attention") {
    if (!isRecord(payload)) return { ok: false, error: "invalid-payload: task/attention requires a payload object" };
    return { ok: true };
  }
  if (op === "task/markAttentionRead") {
    if (!isRecord(payload)) return { ok: false, error: "invalid-payload: task/markAttentionRead requires a payload object" };
    const itemIds = payload["itemIds"];
    if (!Array.isArray(itemIds) || itemIds.length === 0 || itemIds.some((id) => typeof id !== "string" || id.length === 0)) {
      return { ok: false, error: "invalid-payload: task/markAttentionRead.itemIds must be a non-empty string array" };
    }
    return { ok: true };
  }
  if (payload !== undefined && !isRecord(payload)) {
    return { ok: false, error: `invalid-payload: ${op} payload must be an object` };
  }
  return { ok: true };
}
