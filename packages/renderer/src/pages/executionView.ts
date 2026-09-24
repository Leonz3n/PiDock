import type { Approval, ApprovalStatus, RunRecord, RunState, Session } from "../data/types";
import { runStateLabel } from "./runState";

/**
 * [UI 对齐 05] (#29) 会话执行状态卡（原型 `executionPanel()`，
 * `prototypes/pidock-ui/closure.js`）。
 *
 * 原型把状态卡插在消息区之前：`section.execution-panel[aria-label="会话执行状态"]`
 * 里是状态标题（`closureLabels`）＋该状态允许的入口，随后是「其它会话正在执行」
 * 提示、阶段说明、等待确认预览，以及失败/过期各一行说明。这里只放可判定的规则
 * （状态来源、入口集合、卡片可见性、跨会话提示），渲染留在 `TaskPage`。
 *
 * 状态一律来自 Host 数据：待确认请求（`listApprovals`）、实时运行记录
 * （`stores/events.ts` 的 `runs`）与会话 `runState`。渲染层不估算进度或时长。
 */

/** 原型给每个状态配的入口，数组顺序即渲染顺序。 */
export type ExecutionAction = "stop" | "approve" | "reject" | "retry" | "dismiss";

export function executionActions(state: RunState): ExecutionAction[] {
  if (state === "running") return ["stop"];
  if (state === "approval") return ["approve", "reject"];
  if (state === "failed") return ["retry"];
  if (state === "expired") return ["dismiss"];
  return [];
}

export const EXECUTION_ACTION_LABEL: Record<ExecutionAction, string> = {
  stop: "停止执行",
  approve: "批准本次操作",
  reject: "拒绝",
  retry: "检查并重试",
  dismiss: "标记已处理",
};

/** 状态标题：与原型 `closureLabels` 同一套中文，复用仓库唯一的 `RunState` 文案表。 */
export function executionLabel(state: RunState): string {
  return runStateLabel(state);
}

/** 本会话的待确认请求（同一会话可能同时有多条）。 */
export function pendingApprovalsFor(
  approvals: readonly Approval[],
  taskId: string,
  sessionId: string,
): Approval[] {
  return approvals.filter(
    (approval) => approval.taskId === taskId && approval.sessionId === sessionId && approval.status === "pending",
  );
}

/**
 * 状态来源优先级：待确认请求 > 实时运行记录 > 会话 `runState`。
 *
 * 待确认优先是因为「等待确认」是当前唯一需要用户动作的状态；记录次之（它是本轮
 * 回合的最新事件）；两者都没有时才回落 Host 持久化的会话状态（刷新后记录不再存在，
 * 这条回退让卡片仍然说真话）。
 */
export function executionStateOf(input: {
  sessionRunState: RunState;
  record?: RunRecord;
  pendingApproval?: Approval;
}): RunState {
  if (input.pendingApproval) return "approval";
  if (input.record && input.record.state !== "idle") return input.record.state;
  return input.sessionRunState;
}

/**
 * 结果行只描述与卡片状态对应的那条请求：状态是「已拒绝」「确认已过期」时给最近一条同状态的
 * 记录，状态是「执行中」时给正在执行的那条批准记录，其余状态没有对应记录。
 *
 * 取「数组里第一条非待确认」会张冠李戴：卡片写着「执行中」，行里却报另一条早就被拒绝的请求
 * （[UI 对齐 05] #29 review P2-A）。最近一条按 `requestedAt` 判定——`Approval` 没有解决时间戳，
 * 而同一会话的请求只会按提交顺序被审阅。
 */
export function outcomeApprovalFor(
  approvals: readonly Approval[],
  taskId: string,
  sessionId: string,
  state: RunState,
): Approval | undefined {
  const status: ApprovalStatus | undefined =
    state === "rejected" ? "rejected" : state === "expired" ? "expired" : state === "running" ? "approved" : undefined;
  if (!status) return undefined;
  return approvals
    .filter((item) => item.taskId === taskId && item.sessionId === sessionId && item.status === status)
    .reduce<Approval | undefined>((latest, item) => {
      if (latest === undefined) return item;
      const itemAt = Date.parse(item.requestedAt);
      const latestAt = Date.parse(latest.requestedAt);
      return Number.isNaN(itemAt) || Number.isNaN(latestAt) ? latest : itemAt > latestAt ? item : latest;
    }, undefined);
}

/**
 * 空闲且本任务其它会话也都不忙时不出卡（#29 验收 6）。本会话空闲但其它会话在跑/等确认
 * 时仍然出卡：跨会话提示要出现在“为什么我现在不能执行”的地方（验收 5）。
 * 「标记已处理」只压掉被处理的那个状态——状态再次变化（新的回合、新的确认）时卡片
 * 重新出现，与原型 `attentionDismissed` 一致。
 */
export function executionCardVisible(input: {
  state: RunState;
  dismissedState?: RunState | undefined;
  otherBusy?: boolean | undefined;
}): boolean {
  if (input.state === "idle") return input.otherBusy === true;
  return input.state !== input.dismissedState;
}

/** 本任务其它会话正在执行或等待确认时的提示（原型 `other >= 0` 分支）。 */
export function otherBusySession(
  sessions: readonly Session[],
  activeSessionId: string,
  stateOf: (session: Session) => RunState,
): Session | undefined {
  return sessions.find(
    (session) => session.id !== activeSessionId && (stateOf(session) === "running" || stateOf(session) === "approval"),
  );
}
