/**
 * [Pencil T05] ticket 140 会话工具审批的渲染层规则。
 *
 * 审批的**事实**在 Host：`task/listApprovals` 返回本任务（可按会话收窄）真实持久
 * 化的确认记录，`task/approve` / `task/reject` 是唯一的两个决定入口。本模块只
 * 做三件事，且不做第四件：
 *
 * 1. 严格解析 Host 的读数（字段缺失、任务身份不符的整条读数按不可解析处理，不猜）；
 * 2. 把一条记录映射成能让人核对的内容（工具、目标、真实际命令、载荷版本、会话）；
 * 3. 给出**精确键**的决定请求：`{sessionId, approvalId}`，不夹带任何 Host 不接收的
 *    字段（额外字段不会被 Host 记录，写进来就是伪报）。
 *
 * 它**不**计算有效期：确认的截止时间由 Host 的截止时钟判定（`approvalDeadline`），
 * 渲染层没有那次时钟的读数，凭 `requestedAt` 推算一个时间再显示「有效至 …」就是把
 * 猜的字当事实。这里只说「有效期由 Host 判定；过期后批准不会执行」。
 */

export type TaskApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type TaskApproval = {
  approvalId: string;
  sessionId: string;
  tool: string;
  target: string;
  /** [T06 #141] Host-resolved REAL path of `target`; `null` = Host could not resolve it (say so, never guess). */
  realTarget: string | null;
  /** [T06 #141] the linked original a shared-directory write really changes; `null` = not a linked original. */
  sharedOriginal: string | null;
  /** 真实际命令（`exec.run`），目标字段放不下时由 Host 记录。 */
  operation: string | null;
  payloadVersion: string;
  status: TaskApprovalStatus;
  executed: boolean;
  /** 记录里的会话不是本页当前会话：本页不代确认。 */
  foreign: boolean;
};

const APPROVAL_STATUSES: readonly TaskApprovalStatus[] = ["pending", "approved", "rejected", "expired"];

const toolLabel: Record<string, string> = {
  "fs.read": "读取文件",
  "fs.search": "搜索文件",
  "fs.write": "写入文件",
  "exec.run": "运行命令",
  "service.start": "启动服务",
  "service.stop": "停止服务",
  "service.template.update": "修改共享服务模板",
};

export function approvalToolLabel(tool: string): string {
  return toolLabel[tool] ?? tool;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * 一条 `task/listApprovals` 读数（`{approvals: HostApprovalListing[]}`）。
 * 返回 `null` 表示读数不可用（不是「没有待确认」）：调用方必须把 `null` 显示成
 * 读取失败，不能渲染成「无待确认」。
 */
export function parseTaskApprovals(payload: unknown, taskId: string, sessionId: string): TaskApproval[] | null {
  const approvals = object(payload) ? payload["approvals"] : undefined;
  if (!Array.isArray(approvals)) return null;
  const rows: TaskApproval[] = [];
  for (const entry of approvals) {
    if (!object(entry) || entry["taskId"] !== taskId) return null;
    const approvalId = entry["id"];
    const rowSession = entry["sessionId"];
    const tool = entry["tool"];
    const target = entry["target"];
    const payloadVersion = entry["contentVersion"];
    const status = entry["status"];
    if (!text(approvalId) || !text(rowSession) || !text(tool) || typeof target !== "string" || !text(payloadVersion)) return null;
    if (!APPROVAL_STATUSES.includes(status as never)) return null;
    if (typeof entry["executed"] !== "boolean") return null;
    rows.push({
      approvalId,
      sessionId: rowSession,
      tool,
      target,
      realTarget: text(entry["realTarget"]) ? (entry["realTarget"] as string) : null,
      sharedOriginal: text(entry["sharedOriginal"]) ? (entry["sharedOriginal"] as string) : null,
      operation: text(entry["operation"]) ? (entry["operation"] as string) : null,
      payloadVersion,
      status: status as TaskApprovalStatus,
      executed: entry["executed"] as boolean,
      foreign: rowSession !== sessionId,
    });
  }
  return rows;
}

/** 本次批准/拒绝要发的那个 op 与它的**全部**载荷键。 */
export type ApprovalDecision = "approved" | "rejected";

export type ApprovalRequest = { op: "task/approve" | "task/reject"; payload: { sessionId: string; approvalId: string } };

export function approvalRequest(approval: TaskApproval, decision: ApprovalDecision): ApprovalRequest {
  return {
    op: decision === "approved" ? "task/approve" : "task/reject",
    payload: { sessionId: approval.sessionId, approvalId: approval.approvalId },
  };
}

/** 一条确认在本页能不能被点：具名原因，不是禁用而无解释。 */
export function approvalRefusal(approval: TaskApproval): string | null {
  if (approval.foreign) return `该确认属于会话 ${approval.sessionId}，不是当前会话；只能回到原会话处理`;
  if (approval.status === "expired") return "该确认已过期：批准不会执行任何操作，需重新发起请求";
  if (approval.status === "rejected") return "该确认已被拒绝，不能再次执行";
  if (approval.status === "approved") return approval.executed ? "该确认已执行并结算，不能重复执行" : "该确认已批准但未结算；不能重复确认";
  return null;
}

/**
 * 三条必须让读者看到的影响，按真实语义分开写：
 * - 批准只授权**这一次**，不授权未来；
 * - 普通目录链接不是副本，写入直接改动原始目录的真实文件；
 * - [T06 #141] 跨任务／跨 Host 进程的共享真实路径由 Host 的写协调互斥（已接线），
 *   外部编辑器的写入按 ADR 0006 明确豁免。
 */
export const APPROVAL_IMPACT_TEXT =
  "批准仅授权这一次操作，不自动授权未来执行；拒绝、过期和停止都不产生副作用。";
export const SHARED_ROOT_IMPACT_TEXT =
  "本任务的普通目录链接不是副本：写入直接改动原始目录的真实文件。共享真实路径（含祖先／后代重叠）的受管写入在任务之间与 Host 进程之间互斥，被拒时 Host 说明实际持有者；外部编辑器的写入不受此约束（ADR 0006）。";
export const APPROVAL_EXPIRY_TEXT = "有效期由 Host 判定；过期后批准不会执行。";

/**
 * 批准的**真实目标**：批准前必须看得到按 `realpath` 解析后的路径，以及它是否
 * 是某个共享原目录（写入真的改那里）。Host 未解析时不猜、不显示词法路径充当真实路径。
 */
export function approvalRealTargetText(approval: TaskApproval): string {
  const real = approval.realTarget;
  if (real === null) return "真实路径：Host 未解析该目标；批准前无法确认它落到哪里";
  if (approval.sharedOriginal !== null) {
    return `真实路径（解析后）：${real} · 位于共享原目录 ${approval.sharedOriginal}（不是副本，写入直接改动原文件）`;
  }
  return `真实路径（解析后）：${real} · 任务私有路径（不是共享原目录）`;
}

/**
 * Host 拒绝一段确认时给出的具名原因（`task/approve|reject` 的 `{ok:false,error}`）。
 * 原样保留 Host 的文本，只把已知的几类翻成读者能行动的一句话；未知一律前置
 * 「Host 拒绝：」，不吞掉原因也不改写成成功。
 */
export function approvalFailureText(error: string | undefined): string {
  const value = (error ?? "").trim();
  if (value.length === 0) return "Host 未说明原因，确认未生效";
  if (value.includes("确认请求不存在")) return "该确认请求不存在（可能已被处理或属于其他任务/会话），未执行";
  if (value.includes("不可重放") || value.includes("已处理")) return `该确认已处理，不能重复执行：${value}`;
  if (value.includes("过期") || value.includes("expired")) return `该确认已过期，未执行：${value}`;
  if (value.includes("不匹配") || value.includes("mismatch")) return `确认身份与本次操作不匹配，未执行：${value}`;
  return `Host 拒绝：${value}`;
}

/** 一条已结算确认的状态词（不把「已批准」当成「已执行」）。 */
export function approvalStatusText(approval: TaskApproval): string {
  if (approval.status === "pending") return "待批准";
  if (approval.status === "expired") return "已过期（未执行）";
  if (approval.status === "rejected") return "已拒绝（未执行）";
  return approval.executed ? "已批准 · 已执行" : "已批准 · 未结算";
}
