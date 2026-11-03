import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { EmptyState, Field } from "./ui";
import {
  deliveryCommitThroughShell,
  deliveryPlanThroughShell,
  deliveryPushThroughShell,
  isShellConnected,
  deliverySettingsThroughShell,
  saveDeliverySettingsThroughShell,
} from "../data/shellBridge";
import {
  copyTargetText,
  emptyStateText,
  outcomeLabel,
  prLine,
  summarizeOutcomes,
  type DeliveryPlanView,
  type PrGuidanceView,
  type RepoOutcomeView,
} from "../data/gitDelivery";

/**
 * [Pencil T13] #148 the delivery sheet (S07 `CbsS5` / S10 `d0dQe`).
 *
 * WHAT IT SHOWS, and what it will not show:
 * - One row per real worktree repository with the LOCAL branch and the push
 *   target the Host previewed from the saved convention + remote. An unset or
 *   invalid convention is named per row; no `task/<id>` default is invented
 *   and nothing here can be submitted while the plan is not ready.
 * - Commit and push are separate, explicit buttons. Their answers are listed
 *   per repository with the real git summary and the actual range, so a
 *   partial multi-repo outcome cannot read as a success.
 * - PR guidance is an instruction plus a link built from the actual remote;
 *   the sheet never claims a PR was created, and task completion never pushes.
 * - The patch-export boundary is stated beside it: a patch is a delivery aid,
 *   not proof of delivery.
 */
export function DesktopDeliverySheet({ taskId }: { taskId: string }) {
  const [branchTemplate, setBranchTemplate] = useState("");
  const [remote, setRemote] = useState("");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [plan, setPlan] = useState<DeliveryPlanView | null>(null);
  const [message, setMessage] = useState("");
  const [outcomes, setOutcomes] = useState<RepoOutcomeView[]>([]);
  const [overall, setOverall] = useState("");
  const [pr, setPr] = useState<PrGuidanceView[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);

  const load = async () => {
    // The in-memory dev adapter has no repository, no remote and no git: the
    // sheet says so instead of pretending a delivery surface exists.
    if (!isShellConnected()) {
      setError("当前是内存模拟数据（不在桌面壳内）：没有真实 Git 仓库，提交、推送与 PR 引导都不可用。");
      return;
    }
    const request = ++epoch.current;
    const settingsResult = await deliverySettingsThroughShell(taskId);
    if (epoch.current !== request) return;
    if (!settingsResult.ok) {
      setError(settingsResult.error ?? "读取交付设置失败");
      return;
    }
    const settings = (settingsResult.payload as { settings?: { branchTemplate?: string; remote?: string; savedAt?: string | null } }).settings ?? {};
    setBranchTemplate(settings.branchTemplate ?? "");
    setRemote(settings.remote ?? "");
    setSavedAt(settings.savedAt ?? null);
    const planResult = await deliveryPlanThroughShell(taskId);
    if (epoch.current !== request) return;
    if (!planResult.ok) {
      setError(planResult.error ?? "读取交付预览失败");
      return;
    }
    const parsed = (planResult.payload as { plan?: DeliveryPlanView }).plan ?? null;
    if (!parsed) {
      setError("交付预览返回无法核验，请重试");
      return;
    }
    setPlan(parsed);
  };

  useEffect(() => {
    void load();
    return () => {
      epoch.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only on task switch
  }, [taskId]);

  const save = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await saveDeliverySettingsThroughShell({ taskId, branchTemplate, remote });
      if (!result.ok) {
        setError(result.error ?? "保存交付设置失败，未做任何改动");
        return;
      }
      const saved = (result.payload as { settings?: { savedAt?: string | null } }).settings;
      setSavedAt(saved?.savedAt ?? null);
      setNotice("已保存分支规范与推送目标；预览按新设置重新读取");
      await load();
    } finally {
      setBusy(false);
    }
  };

  /** Only ready rows take part; each branch is committed/pushed on its own. */
  const readyRows = (plan?.rows ?? []).filter((row) => row.problem === null && row.branch.length > 0);

  const runAction = async (kind: "commit" | "push") => {
    setBusy(true);
    setError("");
    setNotice("");
    setOutcomes([]);
    setPr([]);
    setOverall("");
    try {
      const branches = [...new Set(readyRows.map((row) => row.branch))];
      const collected: RepoOutcomeView[] = [];
      const guidance: PrGuidanceView[] = [];
      for (const branch of branches) {
        const repoIds = readyRows.filter((row) => row.branch === branch).map((row) => row.repoId);
        const result =
          kind === "commit"
            ? await deliveryCommitThroughShell({ taskId, branch, commitMessage: message, repoIds })
            : await deliveryPushThroughShell({ taskId, branch, repoIds });
        if (!result.ok) {
          setError(result.error ?? `${kind === "commit" ? "提交" : "推送"}失败，未做任何改动`);
          continue;
        }
        const payload = result.payload as { outcomes?: RepoOutcomeView[]; pr?: PrGuidanceView[] };
        collected.push(...(payload.outcomes ?? []));
        guidance.push(...(payload.pr ?? []));
      }
      setOutcomes(collected);
      setPr(guidance);
      setOverall(summarizeOutcomes(collected).overall);
    } finally {
      setBusy(false);
    }
  };

  const empty = plan ? emptyStateText(plan) : null;

  return (
    <section className="flex flex-col gap-3 text-xs" data-testid="delivery-sheet">
      <p className="text-muted">
        提交与推送只在你点击按钮后发生，不自动执行；任务完成不会推送或创建远端分支，也不会强推、合并或变基。
      </p>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <Field label="分支规范">
          <input
            aria-label="分支规范"
            value={branchTemplate}
            onChange={(event) => setBranchTemplate(event.target.value)}
            placeholder="如 ticket/{taskId}-{slug}"
            className="w-full rounded-md border border-line px-2 py-1.5 text-xs"
            data-testid="delivery-branch-template"
          />
        </Field>
        <Field label="推送目标远程">
          <input
            aria-label="推送目标远程"
            value={remote}
            onChange={(event) => setRemote(event.target.value)}
            placeholder="如 origin"
            className="w-full rounded-md border border-line px-2 py-1.5 text-xs"
            data-testid="delivery-remote"
          />
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void save()} disabled={busy} data-testid="delivery-save-settings">
          保存分支规范与推送目标
        </Button>
        <small className="text-muted" data-testid="delivery-saved-at">
          {savedAt ? `已保存于 ${savedAt}` : "尚未保存：未设置即没有可预览的分支与推送目标"}
        </small>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-danger" data-testid="delivery-error">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="text-xs text-muted" data-testid="delivery-notice">
          {notice}
        </p>
      ) : null}
      {empty ? <EmptyState>{empty}</EmptyState> : null}
      {plan && plan.rows.length > 0 ? (
        <ul className="flex flex-col gap-2" data-testid="delivery-rows">
          {plan.rows.map((row) => (
            <li key={row.repoId} className="rounded-md border border-line px-3 py-2" data-testid={`delivery-row-${row.repoId}`}>
              <strong className="block font-mono text-[11px] text-ink">{row.name}</strong>
              <div className="mt-1 flex flex-col gap-0.5">
                <span data-testid={`delivery-row-${row.repoId}-branch`}>
                  本地分支：{row.problem ? "—" : row.branch}
                </span>
                <span data-testid={`delivery-row-${row.repoId}-target`}>
                  推送目标：{copyTargetText(row) || "—"}
                </span>
                <span className="text-muted" data-testid={`delivery-row-${row.repoId}-remote`}>
                  远程地址：{row.remoteUrl ?? "未解析到远程地址"}
                </span>
                {row.problem ? (
                  <span className="text-danger" data-testid={`delivery-row-${row.repoId}-problem`}>
                    {row.problem.code}: {row.problem.message}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {readyRows.length > 0 ? (
        <>
          <Field label="提交说明">
            <input
              aria-label="提交说明"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="描述当前任务的代码变更"
              className="w-full rounded-md border border-line px-2 py-1.5 text-xs"
              data-testid="delivery-commit-message"
            />
          </Field>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || message.trim().length === 0}
              onClick={() => void runAction("commit")}
              data-testid="delivery-commit"
            >
              提交所选仓库
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void runAction("push")} data-testid="delivery-push">
              推送到目标远程
            </Button>
          </div>
        </>
      ) : null}
      {outcomes.length > 0 ? (
        <div className="flex flex-col gap-2" data-testid="delivery-outcomes">
          <strong className="text-ink" data-testid="delivery-overall">
            {overall}
          </strong>
          <ul className="flex flex-col gap-1">
            {outcomes.map((outcome) => (
              <li key={outcome.repoId} className="rounded-md border border-line px-3 py-2" data-testid={`delivery-outcome-${outcome.repoId}`}>
                <strong className="block font-mono text-[11px] text-ink">{outcome.repoId}</strong>
                <span data-testid={`delivery-outcome-${outcome.repoId}-status`}>
                  {outcomeLabel(outcome.status)}（{outcome.branch}）
                </span>
                <span className="block text-muted" data-testid={`delivery-outcome-${outcome.repoId}-summary`}>
                  {outcome.summary}
                </span>
                <span className="block text-muted">
                  {outcome.files.length > 0 ? `范围：${outcome.files.join("、")}` : "范围：无文件改动"}
                </span>
                {prLine(pr.find((entry) => entry.repoId === outcome.repoId)) ? (
                  <span className="block break-all text-ink" data-testid={`delivery-outcome-${outcome.repoId}-pr`}>
                    {(() => {
                      const guidance = pr.find((entry) => entry.repoId === outcome.repoId);
                      const url = guidance?.url ?? null;
                      return url ? (
                        <a href={url} target="_blank" rel="noreferrer" className="underline">
                          {prLine(guidance)}
                        </a>
                      ) : (
                        prLine(guidance)
                      );
                    })()}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <small className="text-muted" data-testid="delivery-patch-boundary">
        导出补丁仍可用：只包含相对 HEAD 的已跟踪改动，不含未跟踪文件；补丁存在不代表已提交、已推送或已创建 PR。
      </small>
    </section>
  );
}
