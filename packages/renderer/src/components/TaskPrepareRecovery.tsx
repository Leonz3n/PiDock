import { useEffect, useRef, useState } from "react";
import { readRepoPrepareView, type RepoPrepareStatus, type RepoPrepareView } from "../data/multiRepoPrepare";
import { resumeAppendThroughShell, type ShellTaskOpResult } from "../data/shellBridge";

// Seam: [PiDock 03] (#6) partial-prepare recovery UI. The Host classifies the
// REAL worktree state and resumes only the unfinished repos; this panel shows
// the per-repo status with the Host's real reason and triggers the explicit
// human resume. It never runs on its own (no read and no resume on mount) and
// never fabricates a status or a conflict scan.

const STATUS_LABEL: Record<RepoPrepareStatus, string> = {
  created: "已创建",
  pending: "待准备",
  failed: "失败",
};

const DEFAULT_RESUME_UNAVAILABLE =
  "需要主进程扫描任务目录与目标仓库（`git worktree list`）后才能继续准备；当前调用方未提供该动作。";

/**
 * Production resume action for the shell surface. The sandboxed renderer
 * cannot scan, so it supplies NO conflict inputs: main derives
 * `takenPaths`/`branchesInUse` (and the target source checkouts) from the
 * task folder and the task's target repos, and the Host keeps requiring
 * both lists. `repoDirs` is the unfinished set the panel read (advisory):
 * the Host re-derives the authoritative set from the record and the real
 * worktrees, so the page never gates itself. Nothing is resumed on mount —
 * the human click is the only trigger.
 */
export function shellTaskPrepareResume(
  taskId: string,
): (input: { repoDirs: string[] }) => Promise<ShellTaskOpResult> {
  return () => resumeAppendThroughShell({ taskId });
}

export function TaskPrepareRecovery({
  load,
  resume,
  resumeUnavailableReason,
}: {
  /** Read-only per-repo status read (`task/prepareStatus`). */
  load: () => Promise<ShellTaskOpResult>;
  /**
   * Explicit resume (`task/resumeAppend`), called with the unfinished repo
   * dirs the panel read (advisory: the Host re-derives the authoritative retry
   * set). On the shell surface main produces the REQUIRED
   * `takenPaths`/`branchesInUse` scan and overwrites any page-supplied value;
   * a caller that cannot scan must omit this prop, and the control renders
   * disabled with the real reason instead of a doomed call.
   */
  resume?: (input: { repoDirs: string[] }) => Promise<ShellTaskOpResult>;
  /** Why the resume is unavailable; shown next to the disabled control. */
  resumeUnavailableReason?: string;
}) {
  const [view, setView] = useState<RepoPrepareView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Stale-response / unmount guard, matching the sibling async panels
  // (TaskServiceBinding/DesktopEnvironmentPage/ProjectServiceTemplates): a
  // response only applies when it is still the latest request.
  const epoch = useRef(0);
  useEffect(
    () => () => {
      epoch.current += 1;
    },
    [],
  );
  const apply = (result: ShellTaskOpResult): void => {
    if (!result.ok) {
      setError(result.error ?? "准备状态读取失败，已保留表单，请重试");
      return;
    }
    const parsed = readRepoPrepareView(result.payload);
    if (!parsed) {
      setError("准备状态返回异常，已保留表单，请重试");
      return;
    }
    setView(parsed);
    setError(null);
  };
  const run = async (request: number, action: () => Promise<ShellTaskOpResult>): Promise<void> => {
    setBusy(true);
    try {
      const result = await action();
      if (epoch.current !== request) return;
      apply(result);
    } finally {
      if (epoch.current === request) setBusy(false);
    }
  };
  const inspect = (): void => {
    const request = ++epoch.current;
    void run(request, load);
  };
  const retryUnfinished = (): void => {
    const current = view;
    if (!current || current.retry.length === 0 || !resume) return;
    const request = ++epoch.current;
    void run(request, () => resume({ repoDirs: [...current.retry] }));
  };
  return (
    <section aria-label="任务准备恢复" className="mt-3 rounded-md border border-line px-2.5 py-2">
      <p className="text-[11px] text-muted">
        按真实工作副本核对各仓库准备状态；已创建的工作副本不会被重建、重置或覆盖，未完成项可单独恢复。
      </p>
      <div className="mt-1.5 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={inspect}
          className="rounded-md border border-line px-2 py-1 text-[11px] hover:bg-soft disabled:opacity-50"
        >
          检查准备状态
        </button>
        {view?.canResume ? (
          <button
            type="button"
            disabled={busy || !resume}
            title={resume ? undefined : (resumeUnavailableReason ?? DEFAULT_RESUME_UNAVAILABLE)}
            onClick={retryUnfinished}
            className="rounded-md border border-line px-2 py-1 text-[11px] hover:bg-soft disabled:opacity-50"
          >
            继续准备未完成的仓库
          </button>
        ) : null}
      </div>
      {view?.canResume && !resume ? (
        <p className="mt-1 text-[11px] text-muted" data-testid="prepare-resume-unavailable">
          {resumeUnavailableReason ?? DEFAULT_RESUME_UNAVAILABLE}
        </p>
      ) : null}
      {view ? (
        <ul className="mt-2 flex flex-col gap-1" data-testid="prepare-status-rows">
          {view.rows.map((row) => (
            <li key={row.repoDir} className="text-[11px]">
              <span className="font-mono">{row.repoDir}</span> · {STATUS_LABEL[row.status]}
              {row.reason ? <span className="text-orange"> · {row.reason}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {view?.resumed ? (
        <p role="status" className="mt-1 text-[11px] text-orange" data-testid="prepare-resume-planned">
          已规划以下仓库的恢复，待执行：{view.retry.join("、")}。执行完成后请重新检查准备状态。
        </p>
      ) : null}
      {view && view.hold.length > 0 ? (
        <p role="status" className="mt-1 text-[11px] text-orange">
          以下仓库无法自动恢复，需要人工处理（不会自动覆盖、重置或重建）：{view.hold.join("、")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-[11px] text-orange">
          {error}
        </p>
      ) : null}
    </section>
  );
}
