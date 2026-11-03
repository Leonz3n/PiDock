/**
 * [Pencil T13] #148 the delivery sheet's view model.
 *
 * Pure formatting only: the Host owns the real branches, push targets and git
 * outcomes, so nothing here can invent a success. Two rules the UI relies on:
 * an outcome is named in the user's words AND keeps git's own summary, and a
 * PR line is always an instruction ("打开创建 PR"), never "已创建".
 */

export type RepoOutcomeStatus =
  | "success"
  | "no-changes"
  | "auth-failure"
  | "remote-reject"
  | "partial-failure"
  | "locked"
  | "not-a-repository"
  | "failed";

export interface DeliveryRow {
  repoId: string;
  name: string;
  repoPath: string;
  branch: string;
  remote: string;
  pushTarget: string;
  remoteUrl: string | null;
  problem: { code: string; message: string } | null;
}

export interface DeliveryPlanView {
  branchTemplate: string;
  remote: string;
  slug: string;
  ready: boolean;
  rows: DeliveryRow[];
  problem: { code: string; message: string } | null;
}

export interface RepoOutcomeView {
  repoId: string;
  repoPath: string;
  branch: string;
  remote: string;
  status: RepoOutcomeStatus;
  summary: string;
  files: string[];
  commit: string | null;
  pushedTo: string | null;
}

export interface PrGuidanceView {
  repoId: string;
  supported: boolean;
  host: string;
  url: string | null;
  text: string;
}

/** The user-facing name of each real outcome; the raw status stays for tests. */
export const OUTCOME_LABELS: Record<RepoOutcomeStatus, string> = {
  success: "成功",
  "no-changes": "无变更",
  "auth-failure": "认证失败",
  "remote-reject": "远端拒绝",
  "partial-failure": "部分失败",
  locked: "仓库被占用",
  "not-a-repository": "不是 Git 仓库",
  failed: "失败",
};

export function outcomeLabel(status: string): string {
  return OUTCOME_LABELS[status as RepoOutcomeStatus] ?? `未识别结果（${status}）`;
}

/** One honest line per repository: label, real summary, and the range. */
export function outcomeLine(outcome: RepoOutcomeView): string {
  const label = outcomeLabel(outcome.status);
  const range = outcome.files.length > 0 ? `${outcome.files.length} 个文件` : "无文件改动";
  const detail = outcome.summary.length > 0 ? `：${outcome.summary}` : "";
  return `${label}（${outcome.branch || "无分支"} · ${range}）${detail}`;
}

export interface DeliverySummary {
  overall: string;
  lines: string[];
  /** True when at least one repository failed while another succeeded. */
  partial: boolean;
}

/** Aggregate a multi-repo answer without hiding a per-repo failure. */
export function summarizeOutcomes(outcomes: readonly RepoOutcomeView[]): DeliverySummary {
  if (outcomes.length === 0) return { overall: "本次没有仓库参与交付", lines: [], partial: false };
  const failed = outcomes.filter((entry) => entry.status !== "success" && entry.status !== "no-changes");
  const succeeded = outcomes.filter((entry) => entry.status === "success");
  const overall =
    failed.length === 0
      ? succeeded.length === 0
        ? "全部仓库无变更"
        : `全部仓库成功（${succeeded.length}）`
      : succeeded.length > 0
        ? `部分失败：${succeeded.length} 个成功，${failed.length} 个失败`
        : `全部失败（${failed.length}）`;
  return { overall, lines: outcomes.map(outcomeLine), partial: failed.length > 0 && succeeded.length > 0 };
}

/** Honest empty states: "nothing here" always says why. */
export function emptyStateText(plan: DeliveryPlanView): string | null {
  if (plan.rows.length === 0) return "本任务没有可交付的 Git worktree 仓库；已有 Git 目录与普通目录不参与交付。";
  if (plan.problem) return plan.problem.message;
  return null;
}

/** A copyable line for the sheet's branch cell (never a fabricated target). */
export function copyTargetText(row: DeliveryRow): string {
  return row.problem ? "" : row.pushTarget;
}

/** PR guidance is an instruction plus the link; it never says "已创建". */
export function prLine(guidance: PrGuidanceView | undefined): string | null {
  if (!guidance) return null;
  if (guidance.url) return `打开创建 PR：${guidance.url}`;
  return guidance.text.length > 0 ? guidance.text : "请在远端仓库手动打开创建 PR。";
}
