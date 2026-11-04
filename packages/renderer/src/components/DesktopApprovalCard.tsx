import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  APPROVAL_EXPIRY_TEXT,
  APPROVAL_IMPACT_TEXT,
  approvalRealTargetText,
  SHARED_ROOT_IMPACT_TEXT,
  approvalRefusal,
  approvalStatusText,
  approvalToolLabel,
  type ApprovalDecision,
  type TaskApproval,
} from "../data/toolApproval";

/**
 * [Pencil T05] ticket 140 会话内的审批卡（S01 的 `approval-preview` 位置，密度不变、
 * 不新增导航）。
 *
 * 这张卡只呈现 Host 已经记录的确认，并把两个决定交给 `task/approve` /
 * `task/reject`：
 *  - 批准：Host 重新校验（路径仍在任务内、目标未变、操作未执行）后最多执行一次；
 *  - 拒绝：终态，不产生副作用；
 *  - 过期、已处理、其他会话的确认：具名拒绝，卡片不给可点的「批准」。
 *
 * 诚实边界：拒绝原因只在本页记录（Host 的确认记录没有原因字段），因此它显示为
 * 「本页记录」而不是「已提交给 Host」。有效期的判定在 Host，本卡不推算时间。
 */
export type ApprovalRead =
  | { phase: "reading" }
  | { phase: "failed"; error: string }
  | { phase: "read"; approvals: TaskApproval[] };

export type ApprovalCardProps = {
  read: ApprovalRead;
  /** 提交一次决定；返回具名失败文本，`null` 表示 Host 接受。 */
  onResolve: (approval: TaskApproval, decision: ApprovalDecision) => Promise<string | null>;
};

export function DesktopApprovalCard({ read, onResolve }: ApprovalCardProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [outcome, setOutcome] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const busyRef = useRef(false);
  const decide = useCallback(async (approval: TaskApproval, decision: ApprovalDecision) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(approval.approvalId);
    setFailure(null);
    setOutcome(null);
    const refused = approvalRefusal(approval);
    if (refused !== null) { setBusy(null); busyRef.current = false; setFailure(refused); return; }
    const error = await onResolve(approval, decision);
    setBusy(null);
    busyRef.current = false;
    if (error !== null) { setFailure(error); return; }
    setOutcome(
      decision === "approved"
        ? `已批准「${approvalToolLabel(approval.tool)}」：Host 重新校验后最多执行一次。`
        : `已拒绝「${approvalToolLabel(approval.tool)}」，未执行。${reason.trim() ? `本页记录的拒绝原因：${reason.trim()}` : ""}`,
    );
    setReason("");
  }, [onResolve, reason]);

  useEffect(() => {
    const pending = read.phase === "read" ? read.approvals.find(approval => approval.status === "pending" && !approval.foreign) : undefined;
    if (!pending) return;
    const keyboard = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
      if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
        event.preventDefault();
        event.stopPropagation();
        void decide(pending, event.key === "Escape" ? "rejected" : "approved");
      }
    };
    window.addEventListener("keydown", keyboard, true);
    return () => window.removeEventListener("keydown", keyboard, true);
  }, [read, decide]);

  if (read.phase === "reading") {
    return (
      <section data-testid="desktop-approval-card" aria-label="工具审批" className="min-w-0 rounded-md border border-line bg-paper px-3 py-2">
        <p role="status" className="text-[11px] text-muted">正在读取 Host 的确认记录…</p>
      </section>
    );
  }
  if (read.phase === "failed") {
    return (
      <section data-testid="desktop-approval-card" aria-label="工具审批" className="min-w-0 rounded-md border border-line bg-paper px-3 py-2">
        <p role="status" data-testid="desktop-approval-error" className="break-words border-l-2 border-[#dfc99f] pl-2 text-[11px] text-[#9a6032]">
          确认记录读取失败：{read.error || "Host 未说明原因"}。本页不显示未读到的确认，也不提供批准入口。
        </p>
      </section>
    );
  }
  const pending = read.approvals.filter((approval) => approval.status === "pending" && !approval.foreign);
  const settled = read.approvals.filter((approval) => approval.status !== "pending" || approval.foreign);
  if (read.approvals.length === 0) {
    return (
      <section data-testid="desktop-approval-card" aria-label="工具审批" className="sr-only">
        <p role="status" data-testid="desktop-approval-empty" className="text-[11px] text-muted">本会话没有待确认的工具操作；Host 的记录为空，不是读取失败。</p>
      </section>
    );
  }


  return (
    <section data-testid="desktop-approval-card" aria-label="工具审批" className="flex min-w-0 flex-col gap-2">
      {pending.map((approval) => (
        <div key={approval.approvalId} data-testid={`desktop-approval-${approval.approvalId}`} className="min-w-0 rounded-lg border border-attention bg-attention-soft px-3.5 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <strong className="text-[12px] text-ink">待批准：{approvalToolLabel(approval.tool)}</strong>
            <Badge variant="soft">{approval.tool}</Badge>
            <span data-testid="desktop-approval-session" className="text-[10px] text-muted">会话 · {approval.sessionId}</span>
            <span data-testid="desktop-approval-version" className="ml-auto text-[10px] text-muted">载荷版本 · {approval.payloadVersion}</span>
          </div>
          <p data-testid="desktop-approval-target" className="mt-0.5 break-all text-[11px] text-ink">目标：{approval.target || "（Host 未记录目标）"}</p>
          {approval.operation !== null && (
            <p data-testid="desktop-approval-operation" className="my-2 whitespace-pre-wrap rounded border border-line bg-paper px-2 py-1.5 font-mono text-[11px] break-all text-ink">实际执行参数：{approval.operation}</p>
          )}
          <p data-testid="desktop-approval-real-target" className="mt-0.5 break-all text-[11px] text-ink">{approvalRealTargetText(approval)}</p>
          <details className="mt-1 text-[10px] text-muted"><summary className="cursor-pointer">安全边界与拒绝原因</summary>
          <p data-testid="desktop-approval-impact" className="mt-0.5 break-words text-[10px] leading-4 text-muted">{APPROVAL_IMPACT_TEXT}</p>
          <p data-testid="desktop-approval-shared" className="break-words text-[10px] leading-4 text-muted">{SHARED_ROOT_IMPACT_TEXT}</p>
          <p data-testid="desktop-approval-expiry" className="break-words text-[10px] leading-4 text-muted">{APPROVAL_EXPIRY_TEXT}</p>
          <label className="mt-1 block text-[10px] text-muted">
            拒绝原因（可选 · 仅本页记录，Host 确认记录没有原因字段）
            <input
              aria-label="拒绝原因"
              value={reason}
              maxLength={200}
              onChange={(event) => setReason(event.target.value)}
              className="mt-0.5 w-full rounded-[5px] border border-line bg-bg px-1.5 py-1 text-[11px] text-ink"
            />
          </label>
          </details>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Button type="button" size="sm" disabled={busy !== null} data-testid="desktop-approval-approve" onClick={() => void decide(approval, "approved")}>批准</Button>
            <Button type="button" size="sm" variant="outline" disabled={busy !== null} data-testid="desktop-approval-deny" onClick={() => void decide(approval, "rejected")}>拒绝</Button>
            <span className="text-[10px] text-muted">批准后 Host 重新校验目标与身份；同一确认不会被执行两次。</span>
          </div>
        </div>
      ))}
      {settled.length > 0 && (
        <ul data-testid="desktop-approval-settled" className="mt-1 flex flex-col gap-0.5">
          {settled.map((approval) => (
            <li key={approval.approvalId} data-testid={`desktop-approval-settled-${approval.approvalId}`} className="break-words text-[10px] text-muted">
              {approvalToolLabel(approval.tool)} · {approvalStatusText(approval)} · 会话 {approval.sessionId} · 载荷版本 {approval.payloadVersion}
              {approval.foreign ? " · 其他会话的确认，本页不代确认" : ""}
            </li>
          ))}
        </ul>
      )}
      {failure !== null && <p role="alert" data-testid="desktop-approval-failure" className="mt-1 break-words border border-[#e0b4b4] bg-[#fdf3f3] p-1.5 text-[10px] leading-5 text-[#ad4545]">{failure}</p>}
      {outcome !== null && <p role="status" data-testid="desktop-approval-outcome" className="mt-1 break-words text-[10px] leading-5 text-muted">{outcome}</p>}
    </section>
  );
}
