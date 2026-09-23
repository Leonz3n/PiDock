/**
 * [PiDock 02] shell-backed Host adapter ([PiDock 02] #5, S6 batch 3).
 *
 * The renderer is sandboxed (`sandbox:true`, `contextIsolation:true`,
 * `nodeIntegration:false`) and must never import Node or Electron: every
 * method below goes through `window.pidock` (`shell/*` invoke channels
 * main allowlists). The adapter wraps a full `HostAdapter` fallback
 * (the in-memory model) for every read/local op that has no shell RPC yet;
 * task turns (`sendMessage`/`stopRun`/approvals/provision) and the service
 * lifecycle of Host-registered services (`setServiceRunning`) ride the real
 * `task/*` ops when the shell is connected and fail closed otherwise.
 *
 * Selection helper `resolveHostAdapter` picks the shell-backed adapter when
 * `window.pidock.taskOp` exists, the memory adapter otherwise. `stores/host`
 * keeps `memoryHost` as the default until the shell boot path wires this in.
 */
import type {
  HostAdapter,
  SendMessageResult,
} from "./hostAdapter";
import { instanceAddress, type ServiceTopologyView } from "./serviceTopology";
import { protocolBindingFromHost, type ProtocolBindingView } from "./protocolBinding";
import type {
  Approval,
  ApprovalStatus,
  AttentionItem,
  CleanupItem,
  CleanupRunResult,
  CleanupSelection,
  Reference,
  RunRecord,
  RunState,
  TaskLifecycleState,
  TaskWriteLockView,
  UsageCleanupScope,
  UsageRecord,
  WriteOrphanView,
} from "./types";
import { attentionItemFromHost, asHostAttentionItem } from "./attentionRules";
import {
  attentionThroughShell,
  markAttentionReadThroughShell,
  cleanupPreviewThroughShell,
  clearUsageThroughShell,
  compactSessionThroughShell,
  controlServiceThroughShell,
  controlTerminalThroughShell,
  deliveryInfoThroughShell,
  fileDiffThroughShell,
  filePreviewThroughShell,
  fileRootsThroughShell,
  fileTreeThroughShell,
  isShellConnected,
  lifecycleStateThroughShell,
  planServiceGroupThroughShell,
  planTerminalThroughShell,
  protocolStateThroughShell,
  runCleanupThroughShell,
  serviceRunRecordsThroughShell,
  setSessionModelThroughShell,
  setTaskArchivedThroughShell,
  setSessionThinkingThroughShell,
  shellTaskOp,
  sendMessageThroughShell,
  terminalHistoryThroughShell,
  terminalStateThroughShell,
  usageRecordsThroughShell,
  type ShellTaskOpResult,
} from "./shellBridge";
import {
  terminalHistoryFromHost,
  terminalPlanFromHost,
  terminalStateFromHost,
  workspaceDeliveryFromHost,
  workspaceDiffFromHost,
  workspacePreviewFromHost,
  workspaceRootsFromHost,
  workspaceTreeFromHost,
} from "./workspaceFiles";
import type {
  TerminalControlRequest,
  TerminalControlResultView,
  TerminalHistoryEntryView,
  TerminalPlanRequest,
  TerminalPlanView,
  TerminalStateView,
  WorkspaceBrowserRequest,
  WorkspaceBrowserView,
} from "./workspaceFiles";
import type { ProviderProfile } from "./types";
import type { SessionWriteState } from "./writeCoordination";
import type { UsageFilter } from "./hostAdapter";

function shellResultError(result: ShellTaskOpResult, fallback: string): Error {
  const message = typeof result.error === "string" && result.error.length > 0 ? result.error : fallback;
  return new Error(message);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * [PiDock 14] (#17) Host cleanup preview -> the renderer's cleanup rows. The
 * Host owns the disposition (`remove` / `keep-copy` / `keep`) and the detail;
 * the renderer only formats them, so no removal decision is made here.
 */
function cleanupItemsFromHost(preview: unknown): CleanupItem[] {
  const items = asRecord(preview)["items"];
  if (!Array.isArray(items)) return [];
  const rows: CleanupItem[] = [];
  for (const entry of items) {
    const item = asRecord(entry);
    const resource = typeof item["resource"] === "string" ? item["resource"] : null;
    const detail = typeof item["detail"] === "string" ? item["detail"] : "";
    if (resource === null) continue;
    const disposition =
      item["disposition"] === "remove" || item["disposition"] === "keep-copy" || item["disposition"] === "keep" ? item["disposition"] : undefined;
    rows.push({
      ...(typeof item["id"] === "string" ? { id: item["id"] } : {}),
      resource,
      // The disposition label leads the action; `cleanupRows` renders it.
      action: "",
      detail,
      ...(disposition !== undefined ? { disposition } : {}),
    });
  }
  return rows;
}

/** [PiDock 14] (#17) Host cleanup run -> receipt/recovery/items, or `undefined`. */
function cleanupResultFromHost(cleanup: unknown): CleanupRunResult {
  const record = asRecord(cleanup);
  const receipt = asRecord(record["receipt"]);
  const recovery = Array.isArray(record["recovery"]) ? record["recovery"] : [];
  const ranAt = typeof receipt["ranAt"] === "string" ? receipt["ranAt"] : null;
  return {
    items: cleanupItemsFromHost(record),
    receipt:
      ranAt === null
        ? null
        : {
            ranAt,
            keptPosition: typeof receipt["keptPosition"] === "string" ? receipt["keptPosition"] : null,
            exports: Array.isArray(receipt["exports"]) ? receipt["exports"].filter((entry): entry is string => typeof entry === "string") : [],
            removed: Array.isArray(receipt["removed"]) ? receipt["removed"].filter((entry): entry is string => typeof entry === "string") : [],
            partialFailure: receipt["partialFailure"] === true,
          },
    recovery: recovery
      .map((entry) => asRecord(entry))
      .filter((entry) => typeof entry["item"] === "string" && typeof entry["reason"] === "string")
      .map((entry) => ({ item: entry["item"] as string, reason: entry["reason"] as string })),
    ...(typeof record["error"] === "string" ? { error: record["error"] as string } : {}),
  };
}

/**
 * [PiDock 14] (#17) Host lifecycle readout -> the archive page's state. The
 * identity verdicts carry the Host's own reason, so a task whose worktree or
 * live process no longer matches its record reads as unverified instead of
 * being trusted because a pid or a port answered.
 */
function lifecycleStateFromHost(lifecycle: unknown): TaskLifecycleState | null {
  const view = asRecord(lifecycle);
  const taskId = typeof view["taskId"] === "string" ? view["taskId"] : null;
  if (taskId === null || typeof view["archived"] !== "boolean") return null;
  const cleanup = asRecord(view["cleanup"]);
  const ranAt = typeof cleanup["ranAt"] === "string" ? cleanup["ranAt"] : null;
  const resources = asRecord(view["resources"]);
  const worktrees = Array.isArray(resources["worktrees"]) ? resources["worktrees"] : [];
  const processes = Array.isArray(resources["processes"]) ? resources["processes"] : [];
  return {
    taskId,
    archived: view["archived"],
    archivedAt: typeof view["archivedAt"] === "string" ? view["archivedAt"] : null,
    restoredAt: typeof view["restoredAt"] === "string" ? view["restoredAt"] : null,
    schedulePaused: view["schedulePaused"] === true,
    cleanup:
      ranAt === null
        ? null
        : {
            ranAt,
            keptPosition: typeof cleanup["keptPosition"] === "string" ? cleanup["keptPosition"] : null,
            exports: Array.isArray(cleanup["exports"]) ? cleanup["exports"].filter((entry): entry is string => typeof entry === "string") : [],
            removed: Array.isArray(cleanup["removed"]) ? cleanup["removed"].filter((entry): entry is string => typeof entry === "string") : [],
            partialFailure: cleanup["partialFailure"] === true,
          },
    recovery: (Array.isArray(view["recovery"]) ? view["recovery"] : [])
      .map((entry) => asRecord(entry))
      .filter((entry) => typeof entry["item"] === "string" && typeof entry["reason"] === "string")
      .map((entry) => ({ item: entry["item"] as string, reason: entry["reason"] as string })),
    usageDetails: typeof view["usageDetails"] === "number" ? view["usageDetails"] : 0,
    worktrees: worktrees.map((entry) => {
      const row = asRecord(entry);
      const verdict = asRecord(row["verdict"]);
      return {
        repoDir: typeof row["repoDir"] === "string" ? row["repoDir"] : "",
        ok: verdict["ok"] === true,
        code: typeof verdict["code"] === "string" ? verdict["code"] : "unknown",
        reason: typeof verdict["reason"] === "string" ? verdict["reason"] : "",
      };
    }),
    processes: processes.map((entry) => {
      const row = asRecord(entry);
      const verdict = row["verdict"] === null || row["verdict"] === undefined ? null : asRecord(row["verdict"]);
      return {
        kind: typeof row["kind"] === "string" ? row["kind"] : "unknown",
        id: typeof row["id"] === "string" ? row["id"] : "",
        running: row["running"] === true,
        ok: verdict === null ? null : verdict["ok"] === true,
        reason: verdict !== null && typeof verdict["reason"] === "string" ? verdict["reason"] : "",
      };
    }),
  };
}

/** Host `write.sessions[]` row ([PiDock 09] #11) -> the navigation's state. */
type HostWriteSession = SessionWriteState & { label?: string };

const USAGE_KINDS = ["turn", "compaction", "branch-summary", "model-tool"] as const;
const USAGE_END_STATES = ["completed", "failed", "cancelled", "awaiting-approval"] as const;
const USAGE_COMPLETENESS = ["reported", "partial", "missing"] as const;

function asNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Host usage-detail envelope -> the renderer's row shape ([PiDock 12] #12).
 * A detail missing a required field is dropped rather than rendered as a
 * half-row with zeroes, so a malformed Host answer cannot under-count usage.
 */
function asUsageRecord(value: unknown, projectId: string): UsageRecord | undefined {
  const detail = asRecord(value);
  const sessionId = detail["sessionId"];
  const id = detail["id"];
  const providerId = detail["providerId"];
  const taskId = detail["taskId"];
  const model = detail["requestModel"];
  const kind = USAGE_KINDS.find((candidate) => candidate === detail["kind"]);
  const endState = USAGE_END_STATES.find((candidate) => candidate === detail["endState"]);
  const usage = asRecord(detail["usage"]);
  const completeness = USAGE_COMPLETENESS.find((candidate) => candidate === usage["completeness"]);
  const input = asNonNegative(usage["input"]);
  const output = asNonNegative(usage["output"]);
  const cacheRead = asNonNegative(usage["cacheRead"]);
  const cacheWrite = asNonNegative(usage["cacheWrite"]);
  if (
    typeof id !== "string" ||
    typeof taskId !== "string" ||
    typeof sessionId !== "string" ||
    typeof providerId !== "string" ||
    typeof model !== "string" ||
    typeof detail["at"] !== "string" ||
    kind === undefined ||
    endState === undefined ||
    completeness === undefined ||
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  ) {
    return undefined;
  }
  const reasoning = asNonNegative(usage["reasoning"]);
  const responseModel = typeof detail["responseModel"] === "string" ? (detail["responseModel"] as string) : undefined;
  return {
    id,
    taskId,
    projectId,
    sessionId,
    providerId,
    providerVersion: typeof detail["providerVersion"] === "string" ? (detail["providerVersion"] as string) : "unversioned",
    model,
    ...(responseModel !== undefined ? { responseModel } : {}),
    kind,
    endState,
    completeness,
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(reasoning !== undefined ? { reasoning } : {}),
    at: detail["at"] as string,
  };
}

/** Adapter filter -> the Host filter envelope (project is applied locally). */
function usageFilterPayload(filter: UsageFilter): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const key of ["sessionId", "providerId", "from", "to", "kind"] as const) {
    const value = filter[key];
    if (value !== undefined) payload[key] = value;
  }
  return payload;
}

function asWriteSessionState(value: unknown): HostWriteSession | undefined {
  const record = asRecord(value);
  const sessionId = record["sessionId"];
  const role = record["role"];
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
  if (role !== "owner" && role !== "waiting" && role !== "readonly" && role !== "idle") return undefined;
  const label = typeof record["label"] === "string" ? record["label"] : undefined;
  const queuePosition = typeof record["queuePosition"] === "number" ? record["queuePosition"] : undefined;
  return { sessionId, role, ...(label !== undefined ? { label } : {}), ...(queuePosition !== undefined ? { queuePosition } : {}) };
}

function asWriteOrphan(value: unknown): WriteOrphanView | undefined {
  const record = asRecord(value);
  const resourceId = record["resourceId"];
  if (typeof resourceId !== "string" || resourceId.length === 0) return undefined;
  const kind = record["kind"];
  const ownerSessionId = typeof record["ownerSessionId"] === "string" ? record["ownerSessionId"] : null;
  const label = typeof record["label"] === "string" ? record["label"] : undefined;
  return {
    resourceId,
    kind: kind === "service" || kind === "process" ? kind : "other",
    ownerSessionId,
    ...(label !== undefined ? { label } : {}),
  };
}

function asDerivedExecution(value: unknown): { sessionId: string; label: string } | undefined {
  const record = asRecord(value);
  const sessionId = record["sessionId"];
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
  return { sessionId, label: typeof record["label"] === "string" ? (record["label"] as string) : "派生执行" };
}

/**
 * `task/sendMessage` result envelope -> renderer `SendMessageResult`.
 *
 * The Host speaks `PiRunState` (`done`/`approval`/`failed`/`cancelled`;
 * transport-only `idle`/`running` must never arrive here). Map to the
 * renderer vocabulary: `done->completed`, `cancelled->stopped`.
 */
function toSendMessageResult(taskId: string, sessionId: string, result: ShellTaskOpResult): SendMessageResult {
  if (!result.ok) throw shellResultError(result, "任务操作失败，已保留输入，请重试");
  const payload = asRecord(result.payload);
  const hostState = payload["state"];
  const state =
    hostState === "done"
      ? "completed"
      : hostState === "cancelled"
        ? "stopped"
        : hostState;
  if (state !== "completed" && state !== "failed" && state !== "approval" && state !== "stopped") {
    throw new Error("invalid-payload: 任务操作返回异常，请重试");
  }
  const approvalId = typeof payload["approvalId"] === "string" ? (payload["approvalId"] as string) : undefined;
  const run: RunRecord = {
    id: typeof payload["callId"] === "string" ? (payload["callId"] as string) : `run-${Date.now()}`,
    taskId,
    sessionId,
    state: state as RunState,
    startedAt: new Date().toISOString(),
    summary: state === "approval" ? "等待确认" : state === "failed" ? "执行失败，已保留现场" : "已完成",
    steps: [
      {
        label: state === "approval" ? (approvalId ? `等待确认 ${approvalId}` : "等待确认") : "运行工具",
        state: state === "failed" ? "failed" : "done",
      },
    ],
  };
  return { state: state as SendMessageResult["state"], run, ...(approvalId ? { approvalId } : {}) };
}

/**
 * Wrap a memory-backed `HostAdapter` with shell-routed task turns. Reads and
 * local-only ops delegate to the fallback; `sendMessage`/`stopRun`/
 * approvals/provision ride `window.pidock` when connected.
 */
type PendingShellApproval = {
  approvalId: string;
  taskId: string;
  sessionId: string;
  title: string;
  tool?: string;
  target?: string;
  /** Payload version the Host minted the confirmation for ([PiDock 17] #19). */
  contentVersion?: string;
  requestedAt: string;
};

function toShellApproval(entry: PendingShellApproval): Approval {
  const expiresAt = new Date(Date.parse(entry.requestedAt) + 15 * 60 * 1000).toISOString();
  const tool = entry.tool ?? "";
  const target = entry.target ?? "";
  const title = tool.length > 0 && target.length > 0 ? `${tool} ${target}` : entry.title;
  return {
    id: entry.approvalId,
    taskId: entry.taskId,
    sessionId: entry.sessionId,
    title,
    command: title,
    cwd: "",
    impact: approvalImpact({ tool, target, permission: "" }),
    payloadVersion: entry.contentVersion ?? "v1",
    status: "pending",
    executed: false,
    requestedAt: entry.requestedAt,
    expiresAt,
  };
}

type HostApprovalRecord = {
  id: string;
  sessionId: string;
  tool: string;
  target: string;
  status: string;
  executed: boolean;
  /** Real payload version the Host minted ([PiDock 17] #19 box 3). */
  contentVersion?: string;
  permissionAtRequest?: string;
};

function asHostApprovalRecord(value: unknown): HostApprovalRecord | undefined {
  const record = asRecord(value);
  if (typeof record["id"] !== "string" || typeof record["sessionId"] !== "string") return undefined;
  if (typeof record["tool"] !== "string" || typeof record["target"] !== "string") return undefined;
  if (typeof record["status"] !== "string") return undefined;
  return {
    id: record["id"] as string,
    sessionId: record["sessionId"] as string,
    tool: record["tool"] as string,
    target: record["target"] as string,
    status: record["status"] as string,
    executed: record["executed"] === true,
    ...(typeof record["contentVersion"] === "string" && record["contentVersion"].length > 0
      ? { contentVersion: record["contentVersion"] as string }
      : {}),
    ...(typeof record["permissionAtRequest"] === "string" && record["permissionAtRequest"].length > 0
      ? { permissionAtRequest: record["permissionAtRequest"] as string }
      : {}),
  };
}

/**
 * [PiDock 17] (#19 box 3) 影响 shown on the confirmation card, composed from the
 * real gated tool/target and the tier the request was minted under — never a
 * fixed string that hides what the approval would do.
 */
function approvalImpact(input: { tool: string; target: string; permission: string }): string {
  const tier = input.permission === "read" ? "只读" : input.permission === "auto" ? "自动执行" : input.permission === "default" ? "默认权限" : undefined;
  const where = input.target.length > 0 ? `命中 ${input.target}` : "任务范围内";
  return tier === undefined ? `执行 ${input.tool}，${where}` : `以「${tier}」执行 ${input.tool}，${where}`;
}

// Host records carry no `requestedAt`: the renderer mints a 15m-from-view
// window per view. A day-old pending Host approval therefore renders as
// fresh until Host-side reopen-expiry marks it expired (fail-safe: expiry
// only ever shortens, never extends, the true age).
function toApprovalFromHostRecord(taskId: string, record: HostApprovalRecord): Approval {
  const title = `${record.tool} ${record.target}`;
  const requestedAt = new Date().toISOString();
  return {
    id: record.id,
    taskId,
    sessionId: record.sessionId,
    title,
    command: title,
    cwd: "",
    impact: approvalImpact({ tool: record.tool, target: record.target, permission: record.permissionAtRequest ?? "" }),
    payloadVersion: record.contentVersion ?? "v1",
    status: record.status as Approval["status"],
    executed: record.executed,
    requestedAt,
    expiresAt: new Date(Date.parse(requestedAt) + 15 * 60 * 1000).toISOString(),
  };
}

/**
 * Redacted provider catalog for the Host switch/gate ([PiDock 11] #9): ids,
 * names, protocols and per-model declarations only. The auth *reference value*
 * never crosses this boundary — the Host only needs availability/window data.
 */
async function shellProviderCatalog(fallback: HostAdapter): Promise<Record<string, unknown>[]> {
  const workspace = await fallback.getWorkspace();
  return workspace.providers.map((provider: ProviderProfile) => ({
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    enabled: provider.enabled,
    models: provider.models.map((model) => ({
      id: model.id,
      ...(model.name !== undefined ? { name: model.name } : {}),
      contextWindow: model.contextWindow,
      ...(model.maxOutput !== undefined ? { maxOutput: model.maxOutput } : {}),
      ...(model.supportsImages !== undefined ? { supportsImages: model.supportsImages } : {}),
      ...(model.thinking !== undefined ? { thinking: model.thinking } : {}),
    })),
  }));
}

export function createShellHostAdapter(fallback: HostAdapter): HostAdapter {
  // Shell turns never populate the memory fallback, so bridged approvals
  // are tracked here by (taskId, sessionId, approvalId) and resolved
  // directly via `task/approve|reject` — never via fallback lookup.
  // `listApprovals`/`getApproval` merge synthetics the Host does not (yet)
  // list, so the UI can render and resolve a fresh shell approval before
  // the Host persists it.
  const pendingShellApprovals = new Map<string, PendingShellApproval>();
  // Tasks known to have a shell Host (seen via sendMessage/listApprovals).
  // `getApproval(approvalId)` names no task, so Host probing fans out
  // over these ids; unknown ids fall back to memory, else fail closed.
  const knownShellTaskIds = new Set<string>();
  // Host-only approvals seen via `task/listApprovals` / `task/getApproval`
  // (other session, restart, another tab): tracked so `resolveApproval`
  // can route `task/approve|reject` with the listed (taskId, sessionId)
  // without a prior `sendMessage` in this page session.
  const listedShellApprovals = new Map<string, { taskId: string; record: HostApprovalRecord }>();
  // [PiDock 17] (#19) which task Host produced each attention item: the id is
  // opaque (a task id may contain dashes), so the route back for a read is
  // remembered at listing time instead of parsed back out of the id.
  const attentionSource = new Map<string, string>();
  return new Proxy(fallback, {
    get(target, property, receiver) {
      if (property === "sendMessage") {
        return async (taskId: string, sessionId: string, text: string, references: Reference[]) => {
          if (!isShellConnected()) return (target as HostAdapter).sendMessage(taskId, sessionId, text, references);
          // Plain chat turn: no scripted tool plan, so the Host runs its
          // default plan (fs.write note under the task dir, gated allow).
          // Structured refs ride as plain data (`references` verbatim +
          // the single `$` skill pick as `skillSource`); the Host persists
          // them without interpreting them. The reference's capability id is
          // the source of record, so the `$` picker and the `/skills` modal
          // send the same value.
          const skill = references.find((reference) => reference.kind === "skill");
          const result = await sendMessageThroughShell({
            taskId,
            sessionId,
            text,
            references: references.map((reference) => ({ ...reference })),
            ...(skill ? { skillSource: skill.sourceId ?? skill.id } : {}),
          });
          const sent = toSendMessageResult(taskId, sessionId, result);
          // Track the Host's approval id (never the fallback's) so
          // `resolveApproval`/`getApproval`/`listApprovals` can render it
          // without an approval-listing RPC. `approvalId` rides the
          // `task/sendMessage` result payload (see `HostTurnResult`);
          // `tool`/`target` ride the same payload so the synthetic
          // approval shows what awaits approval, not just "等待确认".
          const approvalId = sent.approvalId;
          if (sent.state === "approval" && typeof approvalId === "string" && approvalId.length > 0) {
            const payloadRecord = asRecord(result.payload);
            const tool = typeof payloadRecord["tool"] === "string" ? (payloadRecord["tool"] as string) : undefined;
            const target = typeof payloadRecord["target"] === "string" ? (payloadRecord["target"] as string) : undefined;
            const contentVersion = typeof payloadRecord["contentVersion"] === "string" ? (payloadRecord["contentVersion"] as string) : undefined;
            pendingShellApprovals.set(approvalId, {
              approvalId,
              taskId,
              sessionId,
              title: "等待确认",
              ...(tool ? { tool } : {}),
              ...(target ? { target } : {}),
              ...(contentVersion ? { contentVersion } : {}),
              requestedAt: new Date().toISOString(),
            });
            knownShellTaskIds.add(taskId);
          }
          return sent;
        };
      }
      if (property === "stopRun") {
        return async (taskId: string, sessionId: string) => {
          if (!isShellConnected()) return (target as HostAdapter).stopRun(taskId, sessionId);
          const result = await shellTaskOp(taskId, "task/cancel", { sessionId });
          if (!result.ok) throw shellResultError(result, "停止执行失败，请重试");
        };
      }
      if (property === "resolveApproval") {
        return async (approvalId: string, status: ApprovalStatus) => {
          if (!isShellConnected()) return (target as HostAdapter).resolveApproval(approvalId, status);
          const pending = pendingShellApprovals.get(approvalId);
          if (pending) {
            const op = status === "approved" ? "task/approve" : "task/reject";
            const result = await shellTaskOp(pending.taskId, op, { sessionId: pending.sessionId, approvalId });
            if (!result.ok) throw shellResultError(result, "确认操作失败，请重试");
            pendingShellApprovals.delete(approvalId);
            listedShellApprovals.delete(approvalId);
            return { ...toShellApproval(pending), status, executed: status === "approved" };
          }
          // Host-only approval seen via listing (other session, restart,
          // another tab): resolve directly via task/approve|reject.
          const listed = listedShellApprovals.get(approvalId);
          if (listed) {
            const op = status === "approved" ? "task/approve" : "task/reject";
            const result = await shellTaskOp(listed.taskId, op, { sessionId: listed.record.sessionId, approvalId });
            if (!result.ok) throw shellResultError(result, "确认操作失败，请重试");
            pendingShellApprovals.delete(approvalId);
            listedShellApprovals.delete(approvalId);
            return { ...toApprovalFromHostRecord(listed.taskId, listed.record), status, executed: status === "approved" };
          }
          // Probe the Host (task/getApproval over known tasks) before the
          // memory fallback: covers Host approvals never listed in this tab.
          for (const trackedTask of [...knownShellTaskIds].sort()) {
            let probed: ShellTaskOpResult;
            try {
              probed = await shellTaskOp(trackedTask, "task/getApproval", { approvalId });
            } catch {
              continue;
            }
            if (probed.ok) {
              const record = asHostApprovalRecord(asRecord(probed.payload)["approval"]);
              if (record) {
                const op = status === "approved" ? "task/approve" : "task/reject";
                const result = await shellTaskOp(trackedTask, op, { sessionId: record.sessionId, approvalId });
                if (!result.ok) throw shellResultError(result, "确认操作失败，请重试");
                pendingShellApprovals.delete(approvalId);
                listedShellApprovals.delete(approvalId);
                return { ...toApprovalFromHostRecord(trackedTask, record), status, executed: status === "approved" };
              }
            }
          }
          // No shell approval with this id: fall back to memory (local-only
          // approvals such as the dev/demo fixtures), else fail closed.
          const found = await (target as HostAdapter).getApproval(approvalId);
          if (found) return (target as HostAdapter).resolveApproval(approvalId, status);
          throw new Error("确认请求不存在");
        };
      }
      if (property === "getApproval") {
        return async (approvalId: string) => {
          const pending = pendingShellApprovals.get(approvalId);
          if (pending) return toShellApproval(pending);
          // Bridged read first: the Host owns persisted approvals
          // (`task/getApproval`); the memory fallback covers local-only
          // fixtures, else fail closed with `undefined` (matches the
          // `HostAdapter.getApproval` absent contract). `getApproval`
          // names no task, so Host probing fans out over tasks this
          // adapter has seen (`knownShellTaskIds`); only a `found`
          // record counts — `{ok:false}` / malformed records never
          // resolve (fall through to memory, never throw).
          // Bridged detail never throws: a rejected bridge (transport
          // failure) falls through to the memory fallback below, matching
          // the never-throw read contract.
          if (isShellConnected()) {
            for (const trackedTask of [...knownShellTaskIds].sort()) {
              let result: ShellTaskOpResult;
              try {
                result = await shellTaskOp(trackedTask, "task/getApproval", { approvalId });
              } catch {
                continue;
              }
              if (result.ok) {
                const record = asHostApprovalRecord(asRecord(result.payload)["approval"]);
                if (record) {
                  knownShellTaskIds.add(trackedTask);
                  listedShellApprovals.set(approvalId, { taskId: trackedTask, record });
                  return toApprovalFromHostRecord(trackedTask, record);
                }
              }
            }
          }
          return (target as HostAdapter).getApproval(approvalId);
        };
      }
      if (property === "listApprovals") {
        return async (taskId: string) => {
          const local = await (target as HostAdapter).listApprovals(taskId);
          // Bridged listing first: real Host approvals (`task/listApprovals`)
          // replace the synthetic merge; a failed or rejected RPC keeps the
          // local synthetics + memory fixture merge (fail-open read,
          // never throw).
          if (isShellConnected()) {
            let result: ShellTaskOpResult;
            try {
              result = await shellTaskOp(taskId, "task/listApprovals", {});
            } catch {
              result = { ok: false };
            }
            if (result.ok) {
              knownShellTaskIds.add(taskId);
              const raw = asRecord(result.payload)["approvals"];
              if (Array.isArray(raw)) {
                const records = raw
                  .map(asHostApprovalRecord)
                  .filter((record): record is HostApprovalRecord => record !== undefined);
                for (const record of records) {
                  listedShellApprovals.set(record.id, { taskId, record });
                }
                const listed = records.map((record) => toApprovalFromHostRecord(taskId, record));
                const listedIds = new Set(listed.map((approval) => approval.id));
                // Merge local synthetics the Host does not (yet) know:
                // the stub above returns `[]`, but a fresh `sendMessage`
                // approval is tracked locally before the Host persists it.
                const pending = [...pendingShellApprovals.values()]
                  .filter((entry) => entry.taskId === taskId && !listedIds.has(entry.approvalId))
                  .map(toShellApproval);
                return [...listed, ...pending, ...local.filter((approval) => !listedIds.has(approval.id))];
              }
            }
          }
          const shell = [...pendingShellApprovals.values()]
            .filter((entry) => entry.taskId === taskId)
            .map(toShellApproval);
          return [...shell, ...local];
        };
      }
      if (property === "getAttention") {
        return async (): Promise<AttentionItem[]> => {
          const local = await (target as HostAdapter).getAttention();
          if (!isShellConnected()) return local;
          // [PiDock 17] (#19) the Host owns the execution ledger, so its items
          // (real approvals/failures/unread completions) come from
          // `task/attention` per known task; the memory projection keeps the
          // tasks no Host answered for, exactly like the usage fan-out.
          const workspace = await (target as HostAdapter).getWorkspace();
          const projectName = new Map(workspace.projects.map((project) => [project.id, project.name]));
          const remote: AttentionItem[] = [];
          const answered = new Set<string>();
          for (const task of workspace.tasks) {
            let result: ShellTaskOpResult;
            try {
              result = await attentionThroughShell(task.id);
            } catch {
              result = { ok: false };
            }
            if (!result.ok) continue;
            const items = asRecord(result.payload)["items"];
            if (!Array.isArray(items)) continue;
            answered.add(task.id);
            for (const entry of items) {
              const item = asHostAttentionItem(entry);
              // A Host item of another task (or a read one) is not this list's.
              if (!item || item.taskId !== task.id || item.read) continue;
              attentionSource.set(item.id, task.id);
              remote.push(attentionItemFromHost(item, { id: task.projectId, name: projectName.get(task.projectId) ?? task.projectId }));
            }
          }
          if (answered.size === 0) return local;
          return [...remote, ...local.filter((item) => !answered.has(item.taskId))];
        };
      }
      if (property === "markAttentionRead") {
        return async (taskId: string, itemIds: string[]) => {
          if (!isShellConnected()) return (target as HostAdapter).markAttentionRead(taskId, itemIds);
          // Only the ids this task's Host produced go over RPC; the rest belong
          // to the memory projection and are cleared there, so one read never
          // silently marks another adapter's item as read.
          const hostIds = itemIds.filter((id) => attentionSource.get(id) === taskId);
          const localIds = itemIds.filter((id) => attentionSource.get(id) !== taskId);
          const cleared: string[] = [];
          const kept: string[] = [];
          if (hostIds.length > 0) {
            let result: ShellTaskOpResult;
            try {
              result = await markAttentionReadThroughShell({ taskId, itemIds: hostIds });
            } catch {
              result = { ok: false };
            }
            if (result.ok) {
              const payload = asRecord(result.payload);
              const hostCleared = Array.isArray(payload["cleared"]) ? (payload["cleared"] as unknown[]).filter((id): id is string => typeof id === "string") : [];
              const hostKept = Array.isArray(payload["kept"]) ? (payload["kept"] as unknown[]).filter((id): id is string => typeof id === "string") : [];
              cleared.push(...hostCleared);
              kept.push(...hostKept);
              for (const id of hostCleared) attentionSource.delete(id);
            } else {
              kept.push(...hostIds);
            }
          }
          if (localIds.length > 0) {
            const local = await (target as HostAdapter).markAttentionRead(taskId, localIds);
            cleared.push(...local.cleared);
            kept.push(...local.kept);
          }
          return { cleared, kept };
        };
      }
      if (property === "sessionWriteStates") {
        return async (taskId: string) => {
          if (!isShellConnected()) return (target as HostAdapter).sessionWriteStates(taskId);
          // [PiDock 09] (#11): the Host owns the write coordination. A Host
          // that cannot answer (older build, unbound task) falls back to the
          // memory view instead of inventing a holder.
          const result = await shellTaskOp(taskId, "task/sessionStates", {});
          if (!result.ok) return (target as HostAdapter).sessionWriteStates(taskId);
          const payload = asRecord(result.payload);
          const write = asRecord(payload["write"]);
          const owner = typeof write["owner"] === "string" ? (write["owner"] as string) : null;
          const waiting = Array.isArray(write["waiting"]) ? (write["waiting"] as unknown[]).filter((item): item is string => typeof item === "string") : [];
          const orphans = Array.isArray(payload["orphans"])
            ? (payload["orphans"] as unknown[]).map(asWriteOrphan).filter((item): item is WriteOrphanView => item !== undefined)
            : [];
          const rawSessions = Array.isArray(write["sessions"]) ? (write["sessions"] as unknown[]) : [];
          const ownerRole = rawSessions.map(asWriteSessionState).find((state) => state?.sessionId === owner);
          const derived = Array.isArray(payload["derived"])
            ? (payload["derived"] as unknown[]).map(asDerivedExecution).filter((item): item is { sessionId: string; label: string } => item !== undefined)
            : [];
          const writeLock: TaskWriteLockView = {
            owner,
            waiting,
            ...(ownerRole?.label !== undefined ? { ownerLabel: ownerRole.label } : {}),
            orphans,
            derived,
          };
          const sessions = rawSessions
            .map(asWriteSessionState)
            .filter((state): state is SessionWriteState => state !== undefined);
          return { writeLock, sessions };
        };
      }
      if (property === "getUsage") {
        return async (filter: UsageFilter = {}) => {
          const local = await (target as HostAdapter).getUsage(filter);
          if (!isShellConnected()) return local;
          // [PiDock 12] #12: the Host owns the usage ledger, so the report is
          // read from it per known task and mapped back to the renderer shape.
          // A Host that cannot answer (older build, unbound task) keeps the
          // memory rows instead of showing an empty page.
          const workspace = await (target as HostAdapter).getWorkspace();
          const taskIds = filter.taskId !== undefined ? [filter.taskId] : workspace.tasks.map((task) => task.id);
          const projectOfTask = new Map(workspace.tasks.map((task) => [task.id, task.projectId]));
          const remote: UsageRecord[] = [];
          let answeredByHost = false;
          for (const taskId of taskIds) {
            let result: ShellTaskOpResult;
            try {
              result = await usageRecordsThroughShell({ taskId, filter: usageFilterPayload(filter) });
            } catch {
              result = { ok: false };
            }
            if (!result.ok) continue;
            const report = asRecord(asRecord(result.payload)["report"]);
            const details = Array.isArray(report["details"]) ? (report["details"] as unknown[]) : [];
            for (const detail of details) {
              const mapped = asUsageRecord(detail, projectOfTask.get(taskId) ?? "");
              if (mapped !== undefined) remote.push(mapped);
            }
            answeredByHost = true;
          }
          if (!answeredByHost) return local;
          const otherTasks = local.filter((record) => !taskIds.includes(record.taskId));
          const rows = [...remote, ...otherTasks];
          // The project dimension is not part of the Host envelope, so that
          // one filter is applied here (the Host already narrowed the rest).
          return filter.projectId === undefined ? rows : rows.filter((record) => record.projectId === filter.projectId);
        };
      }
      if (property === "clearUsage") {
        return async (scope: UsageCleanupScope) => {
          if (!isShellConnected()) return (target as HostAdapter).clearUsage(scope);
          // The scope names no task, so it fans out over the tasks the app
          // knows: each Host clears its own ledger and the counts add up.
          const workspace = await (target as HostAdapter).getWorkspace();
          let removed = 0;
          let remaining = 0;
          let description = "";
          let answeredByHost = false;
          for (const task of workspace.tasks) {
            let result: ShellTaskOpResult;
            try {
              result = await clearUsageThroughShell({ taskId: task.id, scope });
            } catch {
              result = { ok: false };
            }
            if (!result.ok) continue;
            answeredByHost = true;
            const payload = asRecord(result.payload);
            if (typeof payload["removed"] === "number") removed += payload["removed"];
            if (typeof payload["remaining"] === "number") remaining += payload["remaining"];
            if (typeof payload["description"] === "string") description = payload["description"];
          }
          if (!answeredByHost) return (target as HostAdapter).clearUsage(scope);
          // The memory fallback mirrors the same call so a mixed workspace
          // (some tasks Host-backed, some fixture) stays consistent.
          await (target as HostAdapter).clearUsage(scope);
          return { removed, remaining, description };
        };
      }
      if (property === "setServiceRunning") {
        return async (taskId: string, serviceId: string, running: boolean) => {
          if (!isShellConnected()) return (target as HostAdapter).setServiceRunning(taskId, serviceId, running);
          // Shell Host owns the lifecycle of the services it knows.
          // Probe registration first (`task/serviceStatus`): a service the
          // Host has not registered (renderer has no registration path yet)
          // keeps the memory fallback instead of failing closed on
          // `unknown-service`. A Host-known service is controlled by the
          // Host — no `sessionId`, so the Host classifies it as the
          // attested human-UI path and labels it.
          let probe: ShellTaskOpResult;
          try {
            probe = await shellTaskOp(taskId, "task/serviceStatus", { serviceId });
          } catch {
            probe = { ok: false };
          }
          if (!probe.ok) return (target as HostAdapter).setServiceRunning(taskId, serviceId, running);
          const result = await controlServiceThroughShell({ taskId, serviceId, action: running ? "start" : "stop" });
          if (!result.ok) throw shellResultError(result, "服务启停失败，请重试");
        };
      }
      if (property === "protocolBinding") {
        return async (taskId: string): Promise<ProtocolBindingView> => {
          const local = await (target as HostAdapter).protocolBinding(taskId);
          if (!isShellConnected()) return local;
          // [PiDock 08] (#14) Prefer the Host's own protocol state (actual
          // generated version, per-consumer binding/staleness, toolchain,
          // switch blockers). A Host with no plan yet (or a failing
          // round-trip) keeps the memory projection instead of an empty view.
          const result = await protocolStateThroughShell(taskId);
          if (!result.ok) return local;
          return protocolBindingFromHost(taskId, result.payload) ?? local;
        };
      }
      if (property === "serviceTopology") {
        return async (taskId: string): Promise<ServiceTopologyView> => {
          const local = await (target as HostAdapter).serviceTopology(taskId);
          if (!isShellConnected()) return local;
          // [PiDock 05] (#10) Prefer the Host's own plan (final ports, task
          // bindings, start groups, run records). The request is derived from
          // the visible projection, so a Host that has no plan yet (or a
          // failing round-trip) keeps the memory view instead of an empty one.
          const units = local.units.map((unit) => ({
            unitId: unit.unitId,
            serviceId: unit.serviceId,
            name: unit.name,
            ...(unit.repoDir !== undefined ? { repoDir: unit.repoDir } : {}),
            location: unit.location,
            runType: unit.runType,
          }));
          const requests = local.units
            .filter((unit) => unit.location === "local")
            .map((unit) => {
              const address = local.routing.find((entry) => entry.unitId === unit.unitId)?.target;
              const port = address?.kind === "local-instance" ? address.port : undefined;
              return port !== undefined ? { unitId: unit.unitId, port } : undefined;
            })
            .filter((entry): entry is { unitId: string; port: number } => entry !== undefined);
          const environmentLabel = local.routing
            .flatMap((entry) => (entry.target.kind === "remote" ? [entry.target.environment] : []))
            .find((label) => label.length > 0);
          const plan = await planServiceGroupThroughShell({
            taskId,
            units,
            dependencies: local.units.flatMap((unit) =>
              unit.dependencies.map((dependency) => ({ from: unit.unitId, to: dependency.to, kind: dependency.kind })),
            ),
            requests,
            // The environment label the memory projection uses
            // (`environment?.name ?? task.environmentId`) is carried on its
            // remote routing target; reuse it instead of sending the task id
            // as the environment, and omit it when the task has no remote unit.
            ...(environmentLabel !== undefined ? { environment: environmentLabel } : {}),
          });
          const records = await serviceRunRecordsThroughShell(taskId);
          const payload = plan.ok ? asRecord(plan.payload)["plan"] : undefined;
          const planRecord = asRecord(payload);
          const hostRecords = records.ok ? asRecord(records.payload)["records"] : undefined;
          const merged: typeof local = { ...local };
          if (plan.ok && typeof payload === "object" && payload !== null) {
            const assignments = Array.isArray(planRecord["assignments"]) ? planRecord["assignments"] : [];
            const reallocated = new Map(
              (Array.isArray(planRecord["reallocated"]) ? planRecord["reallocated"] : [])
                .map((entry) => asRecord(entry))
                .map((entry) => [entry["unitId"], entry["after"]] as const),
            );
            merged.routing = local.routing.map((entry) => {
              const moved = reallocated.get(entry.unitId);
              if (typeof moved !== "number" || entry.target.kind !== "local-instance") return entry;
              return {
                ...entry,
                target: { ...entry.target, port: moved, address: instanceAddress(taskId, entry.target.serviceId, moved) },
              };
            });
            const hostGroups = planRecord["groups"];
            if (Array.isArray(hostGroups)) {
              merged.groups = hostGroups.map((group) => {
                const record = asRecord(group);
                return {
                  groupId: String(record["groupId"] ?? ""),
                  members: Array.isArray(record["members"]) ? record["members"].map(String) : [],
                  reason: (record["reason"] ?? "single") as "prestart" | "listener-group" | "single",
                  bidirectional: record["bidirectional"] === true,
                  verify: Array.isArray(record["verify"]) ? record["verify"].map(String) : [],
                };
              });
            }
            const hostDiagnostics = planRecord["diagnostics"];
            if (Array.isArray(hostDiagnostics) && hostDiagnostics.length > 0) {
              merged.diagnostics = hostDiagnostics.map((entry) => {
                const record = asRecord(entry);
                return {
                  code: String(record["code"] ?? "unknown"),
                  message: String(record["message"] ?? ""),
                  ...(typeof record["hint"] === "string" ? { hint: record["hint"] } : {}),
                };
              });
            }
            const knownLimits = planRecord["knownLimits"];
            if (Array.isArray(knownLimits)) merged.knownLimits = knownLimits.map(String);
            // Assignments the Host decided are authoritative even when a unit
            // has no endpoint variable yet.
            for (const assignment of assignments.map(asRecord)) {
              const unitId = assignment["unitId"];
              const port = assignment["port"];
              if (typeof unitId !== "string" || typeof port !== "number") continue;
              merged.routing = merged.routing.map((entry) =>
                entry.unitId === unitId && entry.target.kind === "local-instance"
                  ? { ...entry, target: { ...entry.target, port, address: instanceAddress(taskId, entry.target.serviceId, port) } }
                  : entry,
              );
            }
          }
          if (Array.isArray(hostRecords)) {
            const byService = new Map(
              hostRecords.map(asRecord).map((record) => [record["serviceId"], record] as const),
            );
            merged.records = local.records.map((entry) => {
              const run = byService.get(entry.serviceId);
              if (!run) return entry;
              return {
                ...entry,
                run: {
                  runId: String(run["runId"] ?? ""),
                  templateVersion: String(run["templateVersion"] ?? ""),
                  codeState: (asRecord(run["codeState"])["kind"] ?? "unknown") as "committed-clean" | "uncommitted" | "unknown",
                  buildFreshness: (run["buildFreshness"] ?? "unknown") as "fresh" | "stale-build" | "uncommitted-code" | "unknown",
                  ports: Array.isArray(run["ports"]) ? run["ports"].map(Number) : [],
                  processIdentity: {
                    owner: asRecord(run["processIdentity"])["owner"] === "agent" ? "agent" : "human",
                    pid: Number(asRecord(run["processIdentity"])["pid"] ?? 0),
                    startedAt: String(asRecord(run["processIdentity"])["startedAt"] ?? ""),
                  },
                  logRef: String(run["logRef"] ?? ""),
                  startedAt: String(run["startedAt"] ?? ""),
                  verifications: [],
                },
              };
            });
          }
          return merged;
        };
      }
      // [PiDock 11] (#9) provider/model/context ops. The Host owns the switch
      // gate (busy round/tool -> availability -> strict context bound) and
      // validates the redacted catalog it receives; the fallback adapter then
      // mirrors the accepted selection into the visible session state. A Host
      // refusal throws before the mirror runs, so the visible model, history
      // and draft stay untouched.
      if (property === "setSessionModel") {
        return async (taskId: string, sessionId: string, providerId: string, model: string) => {
          if (!isShellConnected()) return (target as HostAdapter).setSessionModel(taskId, sessionId, providerId, model);
          const catalog = await shellProviderCatalog(target as HostAdapter);
          const result = await setSessionModelThroughShell({ taskId, sessionId, providerId, model, reason: "human-switch", catalog });
          if (!result.ok) throw shellResultError(result, "切换模型失败，请重试");
          return (target as HostAdapter).setSessionModel(taskId, sessionId, providerId, model);
        };
      }
      if (property === "setSessionThinking") {
        return async (taskId: string, sessionId: string, level: string) => {
          if (!isShellConnected()) return (target as HostAdapter).setSessionThinking(taskId, sessionId, level);
          const catalog = await shellProviderCatalog(target as HostAdapter);
          const result = await setSessionThinkingThroughShell({ taskId, sessionId, level, catalog });
          if (!result.ok) throw shellResultError(result, "设置推理档位失败，请重试");
          return (target as HostAdapter).setSessionThinking(taskId, sessionId, level);
        };
      }
      if (property === "compactSessionContext") {
        return async (taskId: string, sessionId: string) => {
          if (!isShellConnected()) return (target as HostAdapter).compactSessionContext(taskId, sessionId);
          const catalog = await shellProviderCatalog(target as HostAdapter);
          const result = await compactSessionThroughShell({ taskId, sessionId, catalog });
          if (!result.ok) throw shellResultError(result, "上下文压缩失败，请重试");
          return (target as HostAdapter).compactSessionContext(taskId, sessionId);
        };
      }
      // [PiDock 10] (#15) file browsing: the Host owns the roots and every
      // read (bounded + masked). A round-trip that fails or a root the Host
      // does not know falls back to the in-memory projection instead of an
      // empty tree that would read like "no files".
      if (property === "workspaceBrowser") {
        return async (taskId: string, request: WorkspaceBrowserRequest = {}): Promise<WorkspaceBrowserView> => {
          const local = await (target as HostAdapter).workspaceBrowser(taskId, request);
          const rootsResult = await fileRootsThroughShell(taskId);
          const rootsPayload = rootsResult.ok ? workspaceRootsFromHost(rootsResult.payload) : undefined;
          if (!rootsPayload || rootsPayload.roots.length === 0) return local;
          const rootId = request.rootId ?? rootsPayload.roots[0]?.id;
          if (rootId === undefined) return local;
          const relative = request.relative ?? "";
          const treeResult = await fileTreeThroughShell({ taskId, rootId, ...(relative.length > 0 ? { relative } : {}) });
          const tree = treeResult.ok ? workspaceTreeFromHost(treeResult.payload) : undefined;
          if (!tree) return local;
          const selected: NonNullable<WorkspaceBrowserView["selected"]> = { rootId, relative, tree };
          const previewResult = await filePreviewThroughShell({ taskId, rootId, relative });
          const preview = previewResult.ok ? workspacePreviewFromHost(previewResult.payload) : undefined;
          if (preview) selected.preview = preview;
          const diffResult = await fileDiffThroughShell({ taskId, rootId, ...(relative.length > 0 ? { relative } : {}) });
          const diff = diffResult.ok ? workspaceDiffFromHost(diffResult.payload) : undefined;
          if (diff) selected.diff = diff;
          const deliveryResult = await deliveryInfoThroughShell({ taskId, rootId });
          const delivery = deliveryResult.ok ? workspaceDeliveryFromHost(deliveryResult.payload) : undefined;
          if (delivery) selected.delivery = delivery;
          return { taskId, taskDir: rootsPayload.taskDir, roots: rootsPayload.roots, selected };
        };
      }
      // [PiDock 10] (#15) terminal: the Host owns the cwd/env resolution and
      // the permission gate. A Host refusal (`read` session, broken env layer)
      // throws so the panel shows the reason instead of a plan that cannot run.
      if (property === "planTerminal") {
        return async (taskId: string, request: TerminalPlanRequest): Promise<TerminalPlanView> => {
          if (!isShellConnected()) return (target as HostAdapter).planTerminal(taskId, request);
          const result = await planTerminalThroughShell({
            taskId,
            instanceId: request.instanceId,
            rootId: request.rootId,
            program: request.program,
            ...(request.args !== undefined ? { args: request.args } : {}),
            ...(request.cols !== undefined ? { cols: request.cols } : {}),
            ...(request.rows !== undefined ? { rows: request.rows } : {}),
            ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
            ...(request.label !== undefined ? { label: request.label } : {}),
          });
          if (!result.ok) throw shellResultError(result, "终端计划失败，请重试");
          const plan = terminalPlanFromHost(result.payload);
          if (!plan) throw shellResultError(result, "终端计划失败，请重试");
          return plan;
        };
      }
      if (property === "controlTerminal") {
        return async (taskId: string, request: TerminalControlRequest): Promise<TerminalControlResultView> => {
          if (!isShellConnected()) return (target as HostAdapter).controlTerminal(taskId, request);
          const result = await controlTerminalThroughShell({
            taskId,
            instanceId: request.instanceId,
            action: request.action,
            ...(request.rootId !== undefined ? { rootId: request.rootId } : {}),
            ...(request.program !== undefined ? { program: request.program } : {}),
            ...(request.args !== undefined ? { args: request.args } : {}),
            ...(request.cols !== undefined ? { cols: request.cols } : {}),
            ...(request.rows !== undefined ? { rows: request.rows } : {}),
            ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
            ...(request.label !== undefined ? { label: request.label } : {}),
            ...(request.approvalId !== undefined ? { approvalId: request.approvalId } : {}),
          });
          if (!result.ok) throw shellResultError(result, "终端操作失败，请重试");
          const payload = asRecord(result.payload);
          const state = await terminalStateThroughShell(taskId);
          const instances = state.ok ? terminalStateFromHost(state.payload)?.instances : undefined;
          const instanceId = typeof payload["instanceId"] === "string" ? (payload["instanceId"] as string) : request.instanceId;
          const instance = instances?.find((entry) => entry.instanceId === instanceId);
          return {
            instanceId,
            action: request.action,
            actor: payload["actor"] === "agent" ? "agent" : "human",
            ...(instance !== undefined ? { instance } : {}),
          };
        };
      }
      if (property === "terminalState") {
        return async (taskId: string): Promise<TerminalStateView> => {
          const local = await (target as HostAdapter).terminalState(taskId);
          if (!isShellConnected()) return local;
          const result = await terminalStateThroughShell(taskId);
          if (!result.ok) return local;
          return terminalStateFromHost(result.payload) ?? local;
        };
      }
      if (property === "terminalHistory") {
        return async (taskId: string, instanceId: string, limit?: number): Promise<TerminalHistoryEntryView[]> => {
          if (!isShellConnected()) return (target as HostAdapter).terminalHistory(taskId, instanceId, limit);
          const result = await terminalHistoryThroughShell({ taskId, instanceId, ...(limit !== undefined ? { limit } : {}) });
          if (!result.ok) return (target as HostAdapter).terminalHistory(taskId, instanceId, limit);
          return terminalHistoryFromHost(result.payload) ?? (await (target as HostAdapter).terminalHistory(taskId, instanceId, limit));
        };
      }
      // [PiDock 14] (#17) archive / restore / cleanup / lifecycle readout.
      // Archiving and cleaning are explicit app-level actions: the Host
      // refuses a payload that carries a `sessionId` and attests the human-UI
      // origin itself. A task neither the Host nor the fixtures know falls
      // back to memory and then surfaces the Host error, never a silent no-op.
      if (property === "archiveTask" || property === "restoreTask") {
        return async (taskId: string) => {
          if (!isShellConnected()) return (target as HostAdapter)[property](taskId);
          const archived = property === "archiveTask";
          let result: ShellTaskOpResult;
          try {
            result = await setTaskArchivedThroughShell({ taskId, archived, label: archived ? "任务归档" : "任务恢复" });
          } catch {
            result = { ok: false };
          }
          if (result.ok) {
            await (target as HostAdapter)[property](taskId).catch(() => undefined);
            return;
          }
          const fallback = await (target as HostAdapter)[property](taskId).then(() => null).catch((error: unknown) => error);
          if (fallback === null) return;
          throw shellResultError(result, archived ? "归档失败，请重试" : "恢复失败，请重试");
        };
      }
      if (property === "lifecycleState") {
        return async (taskId: string) => {
          if (!isShellConnected()) return (target as HostAdapter).lifecycleState(taskId);
          let result: ShellTaskOpResult;
          try {
            result = await lifecycleStateThroughShell(taskId);
          } catch {
            result = { ok: false };
          }
          if (result.ok) {
            const view = lifecycleStateFromHost(asRecord(result.payload)["lifecycle"]);
            if (view !== null) return view;
          }
          return (target as HostAdapter).lifecycleState(taskId);
        };
      }
      if (property === "previewCleanup") {
        return async (taskId: string, selection?: CleanupSelection) => {
          const chosen = selection ?? { exportSessions: false, exportDrafts: false, exportUsage: false };
          if (!isShellConnected()) return (target as HostAdapter).previewCleanup(taskId, chosen);
          let result: ShellTaskOpResult;
          try {
            result = await cleanupPreviewThroughShell({ taskId, selection: chosen });
          } catch {
            result = { ok: false };
          }
          if (result.ok) {
            const preview = asRecord(result.payload)["preview"];
            if (asRecord(preview)["items"] !== undefined) return cleanupItemsFromHost(preview);
          }
          // The Host does not own this task (fixture) or refused: the memory
          // projection answers when it can, else the Host error surfaces — it
          // names the real refusal for a Host-owned task, while the memory
          // projection would only say "任务不存在".
          const fallback = await (target as HostAdapter).previewCleanup(taskId, chosen).then((items) => items).catch((error: unknown) => error);
          if (!(fallback instanceof Error)) return fallback;
          throw shellResultError(result, "生成清理清单失败，请重试");
        };
      }
      if (property === "runCleanup") {
        return async (taskId: string, selection: CleanupSelection) => {
          if (!isShellConnected()) return (target as HostAdapter).runCleanup(taskId, selection);
          let result: ShellTaskOpResult;
          try {
            result = await runCleanupThroughShell({ taskId, selection, label: "清理任务" });
          } catch {
            result = { ok: false };
          }
          if (result.ok) {
            const cleanup = asRecord(result.payload)["cleanup"];
            if (asRecord(cleanup)["items"] !== undefined) return cleanupResultFromHost(cleanup);
          }
          const fallback = await (target as HostAdapter).runCleanup(taskId, selection).then((run) => run).catch((error: unknown) => error);
          if (!(fallback instanceof Error)) return fallback;
          throw shellResultError(result, "清理失败，请重试");
        };
      }
      if (property === "simulateExpiry") {
        // Expiry simulation stays local; approval listing/detail now
        // bridge the Host (`task/listApprovals`/`task/getApproval`).
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Adapter selection: shell-backed when `window.pidock.taskOp` exists
 * (Electron shell), the memory fallback otherwise (Vite dev, tests).
 * Renderer-no-Node holds: this module only reads `window.pidock`.
 */
export function resolveHostAdapter(fallback: HostAdapter): HostAdapter {
  if (!isShellConnected()) return fallback;
  return createShellHostAdapter(fallback);
}
