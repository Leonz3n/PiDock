/**
 * [PiDock 02] shell-backed Host adapter ([PiDock 02] #5, S6 batch 3).
 *
 * The renderer is sandboxed (`sandbox:true`, `contextIsolation:true`,
 * `nodeIntegration:false`) and must never import Node or Electron: every
 * method below goes through `window.pidock` (`shell/*` invoke channels
 * main allowlists). The adapter wraps a full `HostAdapter` fallback
 * (the in-memory model) for every read/local op that has no shell RPC yet;
 * task turns (`sendMessage`/`stopRun`/approvals/provision) ride the real
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
import type { Approval, ApprovalStatus, Reference, RunRecord, RunState } from "./types";
import {
  isShellConnected,
  shellTaskOp,
  sendMessageThroughShell,
  type ShellTaskOpResult,
} from "./shellBridge";

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
    impact: "桌面壳 Host 审批",
    payloadVersion: "v1",
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
  };
}

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
    impact: "桌面壳 Host 审批",
    payloadVersion: "v1",
    status: record.status as Approval["status"],
    executed: record.executed,
    requestedAt,
    expiresAt: new Date(Date.parse(requestedAt) + 15 * 60 * 1000).toISOString(),
  };
}

export function createShellHostAdapter(fallback: HostAdapter): HostAdapter {
  // Shell turns never populate the memory fallback, so bridged approvals
  // are tracked here by (taskId, sessionId, approvalId) and resolved
  // directly via `task/approve|reject` — never via fallback lookup.
  // `listApprovals`/`getApproval` merge these synthetics so the UI can
  // render and resolve a shell approval without an approval-listing RPC.
  const pendingShellApprovals = new Map<string, PendingShellApproval>();
  // Tasks known to have a shell Host (seen via sendMessage/listApprovals).
  // `getApproval(approvalId)` names no task, so Host probing fans out
  // over these ids; unknown ids fall back to memory, else fail closed.
  const knownShellTaskIds = new Set<string>();
  return new Proxy(fallback, {
    get(target, property, receiver) {
      if (property === "sendMessage") {
        return async (taskId: string, sessionId: string, text: string, references: Reference[]) => {
          if (!isShellConnected()) return (target as HostAdapter).sendMessage(taskId, sessionId, text, references);
          // Plain chat turn: no scripted tool plan, so the Host runs its
          // default plan (fs.write note under the task dir, gated allow).
          // Structured refs ride as plain data (`references` verbatim +
          // the single `$` skill pick as `skillSource`); the Host persists
          // them without interpreting them.
          const skill = references.find((reference) => reference.kind === "skill");
          const result = await sendMessageThroughShell({
            taskId,
            sessionId,
            text,
            references: references.map((reference) => ({ ...reference })),
            ...(skill ? { skillSource: skill.id } : {}),
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
            pendingShellApprovals.set(approvalId, {
              approvalId,
              taskId,
              sessionId,
              title: "等待确认",
              ...(tool ? { tool } : {}),
              ...(target ? { target } : {}),
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
            return { ...toShellApproval(pending), status, executed: status === "approved" };
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
          if (isShellConnected()) {
            for (const trackedTask of [...knownShellTaskIds].sort()) {
              const result = await shellTaskOp(trackedTask, "task/getApproval", { approvalId });
              if (result.ok) {
                const record = asHostApprovalRecord(asRecord(result.payload)["approval"]);
                if (record) {
                  knownShellTaskIds.add(trackedTask);
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
          // replace the synthetic merge; a failed RPC keeps the local
          // synthetics + memory fixture merge (fail-open read, never throw).
          if (isShellConnected()) {
            const result = await shellTaskOp(taskId, "task/listApprovals", {});
            if (result.ok) {
              knownShellTaskIds.add(taskId);
              const raw = asRecord(result.payload)["approvals"];
              if (Array.isArray(raw)) {
                const listed = raw
                  .map(asHostApprovalRecord)
                  .filter((record): record is HostApprovalRecord => record !== undefined)
                  .map((record) => toApprovalFromHostRecord(taskId, record));
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
      if (property === "simulateExpiry") {
        // Approval reads stay local until the Host exposes an approval
        // listing RPC (S6 batch 3 scope: turns + resolve only).
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
