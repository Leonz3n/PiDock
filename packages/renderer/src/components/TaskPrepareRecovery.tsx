import { useState } from "react";
import { readRepoPrepareView, type RepoPrepareStatus, type RepoPrepareView } from "../data/multiRepoPrepare";
import type { ShellTaskOpResult } from "../data/shellBridge";

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

export function TaskPrepareRecovery({
  load,
  resume,
}: {
  /** Read-only per-repo status read (`task/prepareStatus`). */
  load: () => Promise<ShellTaskOpResult>;
  /**
   * Explicit resume (`task/resumeAppend`), called with ONLY the unfinished
   * repo dirs so a caller-supplied scan can be constrained to them.
   */
  resume: (input: { repoDirs: string[] }) => Promise<ShellTaskOpResult>;
}) {
  const [view, setView] = useState<RepoPrepareView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
  const inspect = async () => {
    setBusy(true);
    try {
      apply(await load());
    } finally {
      setBusy(false);
    }
  };
  const retryUnfinished = async () => {
    if (!view || view.retry.length === 0) return;
    setBusy(true);
    try {
      // Only the unfinished repos are handed to the resume.
      apply(await resume({ repoDirs: [...view.retry] }));
    } finally {
      setBusy(false);
    }
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
          onClick={() => void inspect()}
          className="rounded-md border border-line px-2 py-1 text-[11px] hover:bg-soft disabled:opacity-50"
        >
          检查准备状态
        </button>
        {view?.canResume ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void retryUnfinished()}
            className="rounded-md border border-line px-2 py-1 text-[11px] hover:bg-soft disabled:opacity-50"
          >
            继续准备未完成的仓库
          </button>
        ) : null}
      </div>
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
      {view && view.hold.length > 0 ? (
        <p role="status" className="mt-1 text-[11px] text-orange">
          以下路径已存在但不是本任务的工作副本，需要人工处理，不会自动覆盖：{view.hold.join("、")}
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
