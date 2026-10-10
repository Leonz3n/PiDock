import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Button } from "./ui/button";
import { loadDesktopProjects, type DesktopProject } from "../data/desktopProjects";
import { readAppendReposView, type AppendReposView } from "../data/taskAppend";
import { appendTaskReposThroughShell, prepareStatusThroughShell, shellTaskPrepareResume, type PidockBridge } from "../data/shellBridge";
import { TaskPrepareRecovery } from "./TaskPrepareRecovery";

/**
 * Desktop 'add repositories' entry for an EXISTING task ([PiDock 03] #6).
 *
 * This is the production surface for appending sources: it drives
 * `shell/appendTaskRepos`, where main resolves each repository's source
 * checkout from the project registry, fetches and pins the exact remote commit
 * in that checkout, derives the required conflict scan itself, routes
 * `task/appendRepos` and executes the returned plan with real git. The page
 * therefore names project repository ids, remote names and baseline branches
 * only — it holds no path, no git and no scan.
 *
 * Honesty rules kept here:
 * - the project and its repositories come from the main-owned registry read
 *   (`loadDesktopProjects`), never from a page-side fixture; a task without a
 *   confirmed project association refuses by name instead of guessing;
 * - a failure keeps the selection and offers retry, and shows the real named
 *   refusal (fetch-failed / path-taken / branch-in-use / repo-unusable);
 * - the appended list shows the pinned full commit and the created worktree;
 * - a partial/failed append points at the ONE existing recovery surface
 *   (`TaskPrepareRecovery`, `task/prepareStatus` + `task/resumeAppend`), whose
 *   resume MAIN executes through the same validated append-plan rules, so an
 *   interrupted append is completed in product instead of left planned.
 */
export function DesktopTaskSources({
  taskId,
  bridge,
  onClose,
  onAppended,
}: {
  taskId: string;
  bridge: PidockBridge;
  onClose: () => void;
  onAppended?: () => void;
}) {
  // The `bridge` prop is the same `window.pidock` instance the desktop shell
  // reads (DesktopConversation passes it through); the append and recovery
  // helpers below resolve that one global bridge, exactly like every other
  // desktop data call.
  const [project, setProject] = useState<DesktopProject | null>(null);
  const [projectError, setProjectError] = useState("");
  const [repos, setRepos] = useState<Record<string, { selected: boolean; remote: string; branch: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<AppendReposView | null>(null);
  const epoch = useRef(0);
  useEffect(() => {
    const request = ++epoch.current;
    void (async () => {
      try {
        const data = await loadDesktopProjects(bridge);
        if (epoch.current !== request) return;
        const association = data.associations.find((row) => row.taskId === taskId);
        if (!association || association.state !== "assigned" || association.projectId === null) {
          setProjectError(`任务与项目没有可确认的关联（${association?.state ?? "unknown"}），无法从项目登记选择仓库`);
          return;
        }
        const found = data.projects.find((row) => row.id === association.projectId);
        if (!found) {
          setProjectError("任务所属项目不可读取，无法从项目登记选择仓库");
          return;
        }
        setProject(found);
      } catch (failure) {
        if (epoch.current === request) {
          setProjectError(failure instanceof Error ? failure.message : "项目与任务读取失败，请重试");
        }
      }
    })();
    return () => {
      epoch.current += 1;
    };
  }, [bridge, taskId]);
  const selected = project?.repositories.filter((repo) => repos[repo.id]?.selected) ?? [];
  // The append payload requires a non-blank remote AND baseline branch for
  // every selected repository (main validates both); gate the primary action
  // on them so the first click can never be a guaranteed `invalid-payload`.
  const ready = selected.every(
    (repo) => (repos[repo.id]?.remote.trim() ?? "").length > 0 && (repos[repo.id]?.branch.trim() ?? "").length > 0,
  );
  const submit = async () => {
    if (!project || selected.length === 0) {
      setError("请选择要追加的仓库");
      return;
    }
    if (!ready) {
      setError("请为每个选中的仓库填写远程名称与远程分支");
      return;
    }
    const request = ++epoch.current;
    setBusy(true);
    setError("");
    try {
      const result = await appendTaskReposThroughShell({
        taskId,
        repositories: selected.map((repo) => ({
          sourceId: repo.id,
          remote: repos[repo.id]?.remote.trim() ?? "",
          remoteBranch: repos[repo.id]?.branch.trim() ?? "",
        })),
      });
      if (epoch.current !== request) return;
      if (!result.ok) {
        // The form keeps the selection and the named refusal stays visible:
        // the same button retries with the same intent.
        setError(result.error ?? "追加失败，已保留选择，请重试");
        return;
      }
      const parsed = readAppendReposView(result.payload, taskId);
      if (!parsed) {
        setError("追加结果无法核验，已保留选择，请重试");
        return;
      }
      setOutcome(parsed);
      if (parsed.appended.length > 0) onAppended?.();
    } catch (failure) {
      if (epoch.current === request) {
        setError(failure instanceof Error ? failure.message : "追加失败，已保留选择，请重试");
      }
    } finally {
      if (epoch.current === request) setBusy(false);
    }
  };
  return (
    <div role="dialog" aria-modal="true" aria-label="追加仓库" className="w-full max-w-[560px] rounded-[7px] border border-line bg-paper p-5 shadow-lg">
      <h2 className="text-base font-semibold">追加仓库</h2>
      <p className="mt-2 text-xs text-muted">
        本次追加会先在各仓库自己的检出里获取所选远程分支，全部获取成功后才按逐仓库固定的完整提交创建独立工作副本；
        已有仓库、基线、链接与运行状态保持不变。
      </p>
      {projectError ? <p role="alert" className="mt-3 border border-[#e0b4b4] bg-[#fdf3f3] p-2 text-xs text-[#ad4545]">{projectError}</p> : null}
      {project && project.repositories.length === 0 ? (
        <p className="mt-3 text-xs text-muted">该项目还没有登记仓库，请先在项目管理中添加。</p>
      ) : null}
      {project ? (
        <fieldset className="mt-3" disabled={busy}>
          <legend className="text-xs text-muted">选择要追加的仓库 · 本次获取的远程与基线分支</legend>
          <div className="mt-1.5 flex flex-col gap-2">
            {project.repositories.map((repo) => {
              const row = repos[repo.id];
              return (
                <div key={repo.id} className="grid gap-2 border-b border-line py-2">
                  <label className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      aria-label={repo.name}
                      checked={row?.selected ?? false}
                      disabled={busy}
                      onChange={(event) =>
                        setRepos((items) => ({
                          ...items,
                          [repo.id]: { selected: event.target.checked, remote: items[repo.id]?.remote ?? "", branch: items[repo.id]?.branch ?? "" },
                        }))
                      }
                    />
                    <span>
                      <strong className="block text-ink">{repo.name}</strong>
                      <small className="font-mono text-[11px] text-muted">{repo.path}</small>
                    </span>
                  </label>
                  {row?.selected ? (
                    <div className="grid grid-cols-2 gap-2 pl-6">
                      <label className="text-[11px] text-muted">
                        远程名称
                        <input
                          aria-label={`远程名称 ${repo.name}`}
                          placeholder="origin"
                          required
                          value={row.remote}
                          disabled={busy}
                          onChange={(event) => setRepos((items) => ({ ...items, [repo.id]: { ...items[repo.id]!, remote: event.target.value } }))}
                          className="mt-1 w-full border border-line bg-paper px-2 py-1 font-mono text-xs"
                        />
                      </label>
                      <label className="text-[11px] text-muted">
                        远程分支
                        <input
                          aria-label={`远程分支 ${repo.name}`}
                          placeholder="main"
                          required
                          value={row.branch}
                          disabled={busy}
                          onChange={(event) => setRepos((items) => ({ ...items, [repo.id]: { ...items[repo.id]!, branch: event.target.value } }))}
                          className="mt-1 w-full border border-line bg-paper px-2 py-1 font-mono text-xs"
                        />
                      </label>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </fieldset>
      ) : null}
      {error ? <p role="alert" className="mt-3 border border-[#e0b4b4] bg-[#fdf3f3] p-2 text-xs text-[#ad4545]">{error}</p> : null}
      {outcome ? (
        <div className="mt-3 text-xs" data-testid="append-outcome">
          {outcome.appended.length ? (
            <>
              <p className="font-semibold text-ink">本次已追加 {outcome.appended.length} 个仓库</p>
              <ul className="mt-1 flex flex-col gap-1">
                {outcome.appended.map((repo) => (
                  <li key={repo.repoDir} className="break-all">
                    {repo.name} · {repo.remote}/{repo.remoteBranch} · <span className="font-mono">{repo.commit}</span> → <span className="font-mono">{repo.worktree}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {outcome.skipped.length ? (
            <p className="mt-1 text-muted">
              已在任务中，未重复创建：{outcome.skipped.map((repo) => `${repo.name}（${repo.repoDir}）`).join("、")}
            </p>
          ) : null}
          {outcome.appended.length === 0 && outcome.skipped.length > 0 ? (
            <p className="mt-1 text-muted">本次没有新增仓库。</p>
          ) : null}
        </div>
      ) : null}
      {/* One recovery story: the append reports what it created; anything left
          unfinished is read and completed through the existing prepare surface,
          whose resume main EXECUTES (it never rebuilds or overwrites a created
          worktree, and it reports the real post-execution status back). */}
      <TaskPrepareRecovery
        load={() => prepareStatusThroughShell({ taskId })}
        resume={shellTaskPrepareResume(taskId)}
      />
      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted">已是任务成员的仓库会被跳过，不会创建第二个工作副本。</p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            关闭
          </Button>
          <Button type="button" disabled={busy || !project || selected.length === 0 || !ready} onClick={() => void submit()}>
            {busy ? "获取中…" : <><Icon name="plus" />获取最新基线并追加</>}
          </Button>
        </div>
      </div>
    </div>
  );
}
