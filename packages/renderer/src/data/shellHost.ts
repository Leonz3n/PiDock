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
import type { ApprovalStatus, Reference, RunRecord, RunState } from "./types";
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

/** `task/sendMessage` result envelope -> renderer `SendMessageResult`. */
function toSendMessageResult(taskId: string, sessionId: string, result: ShellTaskOpResult): SendMessageResult {
  if (!result.ok) throw shellResultError(result, "任务操作失败，已保留输入，请重试");
  const payload = asRecord(result.payload);
  const state = payload["state"];
  if (state !== "completed" && state !== "failed" && state !== "approval" && state !== "stopped") {
    throw new Error("invalid-payload: 任务操作返回异常，请重试");
  }
  const run: RunRecord = {
    id: typeof payload["callId"] === "string" ? (payload["callId"] as string) : `run-${Date.now()}`,
    taskId,
    sessionId,
    state: state as RunState,
    startedAt: new Date().toISOString(),
    summary: state === "approval" ? "等待确认" : state === "failed" ? "执行失败，已保留现场" : "已完成",
    steps: [{ label: state === "approval" ? "等待确认" : "运行工具", state: state === "failed" ? "failed" : "done" }],
  };
  return { state: state as SendMessageResult["state"], run };
}

/**
 * Wrap a memory-backed `HostAdapter` with shell-routed task turns. Reads and
 * local-only ops delegate to the fallback; `sendMessage`/`stopRun`/
 * approvals/provision ride `window.pidock` when connected.
 */
export function createShellHostAdapter(fallback: HostAdapter): HostAdapter {
  return new Proxy(fallback, {
    get(target, property, receiver) {
      if (property === "sendMessage") {
        return async (taskId: string, sessionId: string, text: string, references: Reference[]) => {
          if (!isShellConnected()) return (target as HostAdapter).sendMessage(taskId, sessionId, text, references);
          // Plain chat turn: no scripted tool plan, so the Host runs its
          // default plan (fs.write note under the task dir, gated allow).
          const result = await sendMessageThroughShell({ taskId, sessionId, text });
          void references;
          return toSendMessageResult(taskId, sessionId, result);
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
          const found = await (target as HostAdapter).getApproval(approvalId);
          if (!isShellConnected()) return (target as HostAdapter).resolveApproval(approvalId, status);
          if (!found) throw new Error("确认请求不存在");
          const op = status === "approved" ? "task/approve" : "task/reject";
          const result = await shellTaskOp(found.taskId, op, { sessionId: found.sessionId, approvalId });
          if (!result.ok) throw shellResultError(result, "确认操作失败，请重试");
          return (target as HostAdapter).resolveApproval(approvalId, status);
        };
      }
      if (property === "listApprovals" || property === "getApproval" || property === "simulateExpiry") {
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
