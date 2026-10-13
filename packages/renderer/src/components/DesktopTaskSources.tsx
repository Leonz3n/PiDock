import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Button } from "./ui/button";
import { loadDesktopProjects, sourceName, sourcePath, type DesktopProject } from "../data/desktopProjects";
import { readAppendReposView, type AppendReposView } from "../data/taskAppend";
import { appendTaskReposThroughShell, prepareStatusThroughShell, shellTaskPrepareResume, type PidockBridge } from "../data/shellBridge";
import { TaskPrepareRecovery } from "./TaskPrepareRecovery";

/**
 * Desktop append surface for an EXISTING task ([PiDock 03] #6): repositories
 * AND plain directories.
 *
 * This is the production surface for appending sources: it drives
 * `shell/appendTaskRepos`, where main resolves each repository's source
 * checkout from the project registry, fetches and pins the exact remote commit
 * in that checkout, derives the required conflict scan itself, routes
 * `task/appendRepos` and executes the returned plan with real git. Plain
 * directories are resolved from the same registry and appended as shared
 * links (`task/appendDirs`, `sharedWriteConfirmed` required). The page
 * therefore names project repository ids, remote names, baseline branches and
 * directory ids only — it holds no path, no git and no scan.
 *
 * Honesty rules kept here:
 * - the project and its repositories come from the main-owned registry read
 *   (`loadDesktopProjects`), never from a page-side fixture; a task without a
 *   confirmed project association refuses by name instead of guessing;
 * - a failure keeps the selection and offers retry, and shows the real named
 *   refusal (fetch-failed / path-taken / branch-in-use / repo-unusable);
 * - the appended list shows the pinned full commit and the created worktree;
 * - the ordering is stated, not implied: a plain-directory link is created and
 *   recorded BEFORE the repo worktrees are made, so the copy never claims the
 *   whole append is one all-or-nothing step (a worktree failure leaves the
 *   recorded links behind, and re-appending skips them);
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
  const [directories, setDirectories] = useState<string[]>([]);
  const [sharedWriteConfirmed, setSharedWriteConfirmed] = useState(false);
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
  const selectedDirs = project?.directories.filter((dir) => directories.includes(dir.id)) ?? [];
  // The append payload requires a non-blank remote AND baseline branch for
  // every selected repository (main validates both); gate the primary action
  // on them so the first click can never be a guaranteed `invalid-payload`.
  const ready = selected.every(
    (repo) => (repos[repo.id]?.remote.trim() ?? "").length > 0 && (repos[repo.id]?.branch.trim() ?? "").length > 0,
  );
  const submit = async () => {
    // A new submission invalidates the previous outcome: a stale success must
    // never sit next to a fresh refusal.
    setOutcome(null);
    if (!project || (selected.length === 0 && selectedDirs.length === 0)) {
      setError("请选择要追加的仓库或目录");
      return;
    }
    if (selected.length > 0 && !ready) {
      setError("请为每个选中的仓库填写远程名称与远程分支");
      return;
    }
    if (selectedDirs.length > 0 && !sharedWriteConfirmed) {
      setError("请确认普通目录的共享写入风险");
      return;
    }
    const request = ++epoch.current;
    setBusy(true);
    setError("");
    try {
      const result = await appendTaskReposThroughShell({
        taskId,
        ...(selected.length > 0
          ? {
              repositories: selected.map((repo) => ({
                sourceId: repo.id,
                remote: repos[repo.id]?.remote.trim() ?? "",
                remoteBranch: repos[repo.id]?.branch.trim() ?? "",
              })),
            }
          : {}),
        ...(selectedDirs.length > 0 ? { directoryIds: directories, sharedWriteConfirmed } : {}),
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
      if (parsed.appended.length > 0 || (parsed.appendedDirs?.length ?? 0) > 0) onAppended?.();
    } catch (failure) {
      if (epoch.current === request) {
        setError(failure instanceof Error ? failure.message : "追加失败，已保留选择，请重试");
      }
    } finally {
      if (epoch.current === request) setBusy(false);
    }
  };
  return (
    <div role="dialog" aria-modal="true" aria-label="追加仓库或目录" className="w-full max-w-[560px] rounded-[7px] border border-line bg-paper p-5 shadow-lg">
      <h2 className="text-base font-semibold">追加仓库或目录</h2>
      <p className="mt-2 text-xs text-muted">
        本次追加先在各仓库自己的检出里获取所选远程分支，全部获取成功后才固定逐仓库的完整提交；
        普通目录链接会在这之前先接入并登记，随后才创建仓库工作副本。
        因此若某个仓库的工作副本创建失败，已登记的链接与已固定的基线会保留（重新追加会跳过它们，不会重复创建），
        未完成的仓库请通过下方的任务准备恢复继续；已有仓库、基线与运行状态保持不变。
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
              const name = sourceName(repo);
              return (
                <div key={repo.id} className="grid gap-2 border-b border-line py-2">
                  <label className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      aria-label={name}
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
                      <strong className="block text-ink">{name}</strong>
                      <small className="font-mono text-[11px] text-muted">{sourcePath(repo)}</small>
                    </span>
                  </label>
                  {row?.selected ? (
                    <div className="grid grid-cols-2 gap-2 pl-6">
                      <label className="text-[11px] text-muted">
                        远程名称
                        <input
                          aria-label={`远程名称 ${name}`}
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
                          aria-label={`远程分支 ${name}`}
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
      {project && project.directories.length > 0 ? (
        <fieldset className="mt-3" disabled={busy}>
          <legend className="text-xs text-muted">选择要追加的普通目录 · 软链接共享原文件</legend>
          <div className="mt-1.5 flex flex-col gap-2">
            {project.directories.map((dir) => (
              <label key={dir.id} className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  aria-label={sourceName(dir)}
                  checked={directories.includes(dir.id)}
                  disabled={busy}
                  onChange={(event) =>
                    setDirectories((items) =>
                      event.target.checked ? [...items, dir.id] : items.filter((id) => id !== dir.id),
                    )
                  }
                />
                <span>
                  <strong className="block text-ink">{sourceName(dir)}</strong>
                  <small className="font-mono text-[11px] text-muted">{sourcePath(dir)}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {directories.length > 0 ? (
        <label className="mt-2 flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            required
            checked={sharedWriteConfirmed}
            disabled={busy}
            onChange={(event) => setSharedWriteConfirmed(event.target.checked)}
          />
          我确认普通目录通过共享可写链接接入任务，后续写入会直接修改原始目录
        </label>
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
          {outcome.appendedDirs?.length ? (
            <>
              <p className="mt-2 font-semibold text-ink">本次已追加 {outcome.appendedDirs.length} 个普通目录</p>
              <ul className="mt-1 flex flex-col gap-1">
                {outcome.appendedDirs.map((dir) => (
                  <li key={dir.directoryId} className="break-all">
                    {dir.name} · <span className="font-mono">{dir.linkPath}</span> → 原始目标 <span className="font-mono">{dir.sourcePath}</span>（共享原文件，非独立副本）
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {outcome.skippedDirs?.length ? (
            <p className="mt-1 text-muted">
              普通目录已在任务中，未重复创建：{outcome.skippedDirs.map((dir) => `${dir.name}（${dir.linkName}）`).join("、")}
            </p>
          ) : null}
          {outcome.appended.length === 0 && outcome.skipped.length > 0 && !outcome.appendedDirs?.length && !outcome.skippedDirs?.length ? (
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
        <p className="text-[11px] text-muted">已是任务成员且工作副本完好的仓库会被跳过，不会创建第二个工作副本；记录存在但工作副本缺失或不符时会按名拒绝，请先通过任务准备恢复处理。</p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            关闭
          </Button>
          <Button
            type="button"
            disabled={
              busy ||
              !project ||
              (selected.length === 0 && selectedDirs.length === 0) ||
              (selected.length > 0 && !ready) ||
              (selectedDirs.length > 0 && !sharedWriteConfirmed)
            }
            onClick={() => void submit()}
          >
            {busy ? "处理中…" : <><Icon name="plus" />{selectedDirs.length > 0 && selected.length === 0 ? "追加目录" : "获取最新基线并追加"}</>}
          </Button>
        </div>
      </div>
    </div>
  );
}
