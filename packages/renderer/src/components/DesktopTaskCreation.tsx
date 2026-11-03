import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "./Icon";
import { abandonCreation, commitCreation, currentCreation, prepareCreation, CREATION_RETENTION_NOTICE, WORKSPACE_MODE_LABELS, type CreationInput, type CreationIntentView, type WorkspaceModeView } from "../data/desktopCreation";
import { BRANCH_TEMPLATE_TOKEN, sourceName, sourcePath, type DesktopProject } from "../data/desktopProjects";
import type { PidockBridge } from "../data/shellBridge";
import { hostText } from "../data/workspaceFiles";

const button = "inline-flex min-h-8 items-center justify-center gap-1.5 border border-line bg-paper px-2.5 py-1 text-xs hover:bg-bg disabled:cursor-not-allowed disabled:opacity-50";
const field = "w-full min-w-0 border border-line bg-paper px-2 py-1.5 text-sm text-ink";
const label = "flex min-w-0 flex-col gap-1 text-[11px] font-medium text-muted";
const kbd = "rounded-[3px] border border-line bg-bg px-1.5 py-0.5 font-mono text-[10px] text-muted";
const MODE_HINTS: Record<WorkspaceModeView, string> = {
  worktree: "为每个选中仓库创建独立 Worktree 与任务分支；原仓库保持不动，不覆盖未提交修改。",
  "existing-git": "直接使用已登记原检出：不创建 Worktree、不创建任务分支、不拉取/合并/重置；未提交修改保持原样，写入影响原文件。",
  "plain-dirs": "仅普通目录：共享原文件，不涉及 Git 仓库；写入影响原文件。",
};

/** The `{task-name}` token rendered as a display-only push target preview. */
function branchPreview(template: string | null, name: string): string {
  if (template === null) return "Host 未上报工作区分支模板";
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "task";
  return template.split(BRANCH_TEMPLATE_TOKEN).join(slug);
}

export function DesktopTaskCreation({ project, bridge, onCreated }: {
  project?: DesktopProject;
  bridge: PidockBridge;
  onCreated: (projectId: string, taskId: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [formProjectId, setFormProjectId] = useState<string | null>(null);
  const [intent, setIntent] = useState<CreationIntentView | null>(null);
  const [mode, setMode] = useState<WorkspaceModeView>("worktree");
  const [name, setName] = useState("");
  const [repos, setRepos] = useState<Record<string, { selected: boolean; remote: string; branch: string }>>({});
  const [directories, setDirectories] = useState<string[]>([]);
  const [sharedWriteConfirmed, setSharedWriteConfirmed] = useState(false);
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const submitRef = useRef<() => void>(() => undefined);
  const currentName = name;

  const resetSelections = useCallback(() => {
    setName(""); setRepos({}); setDirectories([]); setSharedWriteConfirmed(false); setOverride(false);
  }, []);
  useEffect(() => {
    if (typeof bridge.createTask !== "function") { setError("桌面壳真实任务创建接口不可用，请重启应用"); return; }
    void currentCreation(bridge).then((current) => {
      if (current?.state === "pending") {
        setIntent(current); setMode(current.workspaceMode); setOpen(true);
      }
    }).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "创建记录读取失败"));
  }, [bridge]);

  const projectRepos = project?.repositories ?? [];
  const gitModesAvailable = projectRepos.length > 0;
  // A project with no Git repository cannot use either Git mode (main refuses
  // it), so the form opens in 仅普通目录 instead of offering a doomed choice.
  const openForm = () => {
    const initial: WorkspaceModeView = projectRepos.length > 0 ? "worktree" : "plain-dirs";
    setFormProjectId(project?.id ?? null);
    setMode(initial);
    resetSelections();
    setIntent(null);
    setOpen(true);
    setError(null);
    setNotice(null);
    // Esc / 取消 only close the dialog; main still holds the pending intent and
    // refuses a second `prepare` (`已有待完成的任务`). Read it back so reopening
    // shows the resumable preview instead of a form that cannot be submitted.
    if (typeof bridge.createTask === "function") {
      void currentCreation(bridge).then((current) => {
        if (current?.state === "pending") { setIntent(current); setMode(current.workspaceMode); }
      }).catch(() => undefined);
    }
  };
  const close = () => { if (!busy) { setOpen(false); setIntent(null); } };

  const hasSelectedRepos = Object.values(repos).some((row) => row.selected);
  const hasSelectedDirs = directories.length > 0;
  const selectedRepos = projectRepos.filter((row) => repos[row.id]?.selected);
  const selectedReady = selectedRepos.every((row) => {
    const entry = repos[row.id]!;
    if (!entry.remote.trim()) return false;
    return mode === "existing-git" || Boolean(entry.branch.trim());
  });
  const noSelections = mode === "plain-dirs" ? !hasSelectedDirs : !hasSelectedRepos;
  const submitDisabled = busy || project?.id !== formProjectId || !currentName.trim() || noSelections || !selectedReady ||
    (hasSelectedDirs && !sharedWriteConfirmed);

  const prepare = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!project || project.id !== formProjectId) { setError("项目选择已变化，请选择原项目或取消后重新创建"); return; }
    if (submitDisabled) { nameRef.current?.focus(); return; }
    const input: CreationInput = {
      projectId: project.id, name, workspaceMode: mode,
      repositories: projectRepos.filter((row) => repos[row.id]?.selected).map((row) => ({
        sourceId: row.id, remote: repos[row.id]!.remote.trim(),
        // Existing-git uses the checkout's current branch, read by main; the
        // renderer never invents a branch name for a shared original.
        remoteBranch: mode === "existing-git" ? "" : repos[row.id]!.branch.trim(),
      })),
      directoryIds: directories, sharedWriteConfirmed, override,
    };
    setBusy(true); setError(null);
    try {
      const result = await prepareCreation(bridge, input);
      if (result) setIntent(result);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法预览任务路径"); }
    finally { setBusy(false); }
  };
  const commit = async () => {
    if (!intent) return;
    setBusy(true); setError(null);
    try {
      const taskId = await commitCreation(bridge, intent.id);
      await onCreated(intent.projectId, taskId);
      setIntent(null); setOpen(false); resetSelections(); setMode("worktree");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "创建未完成，原任务身份已保留，请重试"); }
    finally { setBusy(false); }
  };
  const abandon = async () => {
    if (!intent || !window.confirm(`放弃本次创建并生成新任务身份？${CREATION_RETENTION_NOTICE}；已关联到项目的任务需要先在「项目管理」里解绑，才能放弃。`)) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      // #88: main answers with what it did **not** delete; the user needs that
      // sentence before creating a replacement, so it is not dropped.
      setNotice(await abandonCreation(bridge, intent.id));
      setIntent(null); setOpen(false); resetSelections(); setMode("worktree");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "放弃创建失败，请恢复原任务"); }
    finally { setBusy(false); }
  };

  // Keyboard: Esc closes, ⌘↵ submits — the S02 dialog contract. Focus starts
  // on the task name and Tab stays inside the dialog at 720×560. The handler
  // reads the latest submit through a ref, so it is not re-registered (and does
  // not steal focus) on every keystroke.
  submitRef.current = () => { if (intent) void commit(); else void prepare(); };
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    nameRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submitRef.current(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (opener && document.contains(opener)) opener.focus();
    };
    // `close` only reads `busy`, which is checked inside the handler closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const trap = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])");
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0]!, last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const hasSourcesInProject = Boolean(project && (project.repositories.length > 0 || project.directories.length > 0));
  const primaryLabel = intent ? "确认创建 / 恢复"
    : hasSelectedRepos ? (mode === "existing-git" ? "读取原检出并预览" : "固定基线并预览路径")
    : "预览路径";
  const previewText = intent ? null : mode === "worktree" && hasSelectedRepos
    ? `⚡ 自动创建隔离 Worktree：${selectedRepos.length} 个仓库，原仓库保持安全隔离`
    : mode === "existing-git"
      ? "直接使用已登记的原检出（共享原文件）；不创建 Worktree、不创建任务分支"
      : "仅普通目录：共享原文件，不涉及 Git";

  return <>
    <button className={button} type="button" disabled={busy || !project || !hasSourcesInProject || typeof bridge.createTask !== "function"}
      title={!project ? "请先选择项目" : !hasSourcesInProject ? "当前创建流程至少需要一个仓库或目录" : "创建真实任务"}
      onClick={openForm}><Icon name="plus" />任务</button>
    {error && <p role={typeof bridge.createTask === "function" ? "alert" : undefined} className="w-full text-xs text-[#ad4545]">{error}</p>}
    {notice && <p role="status" className="w-full text-xs text-muted">{notice}</p>}
    {open && <div role="presentation" onClick={close}
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 py-6">
      <div role="dialog" aria-modal="true" aria-label="新建任务" ref={dialogRef} onKeyDown={trap}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-[720px] rounded-[10px] border border-line bg-paper p-6 shadow-xl">
        <section role="region" aria-label="创建任务">
        <header className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 gap-2.5">
            <span aria-hidden className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[6px] bg-soft text-accent"><Icon name="branch" /></span>
            <div className="min-w-0">
              <h2 className="text-[16px] font-semibold tracking-[-0.2px] text-ink">{intent ? `任务路径预览 · ${intent.name}` : "新建任务 (New Task)"}</h2>
              <p className="mt-0.5 text-[11px] text-muted">选择任务工作区模式与来源；普通目录共享原文件，已有 Git 目录直接使用原检出</p>
            </div>
          </div>
          <button type="button" className={kbd} aria-label="关闭新建任务" onClick={close} disabled={busy}>Esc</button>
        </header>
        <div className="mt-4">
          {!intent && formProjectId && project?.id !== formProjectId && <p role="status" className="mb-2 text-xs text-[#ad4545]">项目选择已变化，请选择原项目或取消后重新创建。</p>}
          {intent ? <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted">任务工作区模式：<strong className="text-ink">{WORKSPACE_MODE_LABELS[intent.workspaceMode]}</strong></p>
              <span className={kbd}>任务 {intent.taskId}</span>
            </div>
            <div className="rounded-[5px] border border-line bg-bg px-3 py-2">
              <p className="break-all font-mono text-xs text-ink">{intent.taskDir}</p>
              <p className="mt-1 text-xs text-muted">{intent.workspaceMode === "existing-git"
                // A shared original gets no task branch at all: naming one here
                // would invent a branch that never exists.
                ? "任务分支：不创建（直接使用原检出的当前分支）"
                : `任务分支：${hostText(intent.branch, "Host 未上报任务分支")}`}</p>
            </div>
            {intent.workspaceMode === "existing-git"
              ? intent.repos.map((repo) => <p className="break-all text-xs" key={repo.id}>
                  {hostText(repo.name, "Host 未上报仓库名称")} · 原检出 {hostText(repo.path, "Host 未上报原检出路径")} · 当前分支 {hostText(repo.remoteBranch, "Host 未上报当前分支")} · HEAD {hostText(repo.commit, "Host 未上报提交")}（共享原文件，不创建 Worktree 或任务分支）
                </p>)
              : intent.repos.map((repo) => <p className="break-all text-xs" key={repo.id}>
                  {hostText(repo.name, "Host 未上报仓库名称")} · {hostText(repo.remote, "Host 未上报远程名")}/{hostText(repo.remoteBranch, "Host 未上报远程分支")} · {hostText(repo.commit, "Host 未上报提交")} → {intent.taskDir}/{hostText(repo.repoDir, "Host 未上报目录名")}
                  <span className="text-accent"> · ⚡ 自动创建隔离 Worktree</span>
                </p>)}
            {intent.directories.map((dir) => <p className="break-all text-xs" key={dir.id}>{hostText(dir.name, "Host 未上报目录名称")} · {hostText(dir.path, "Host 未上报目录路径")} → {intent.taskDir}/{hostText(dir.linkName, "Host 未上报链接名")}（共享可写）</p>)}
            <p className="text-xs text-muted">创建中断后会保留固定任务身份与提交；重试不会更新基线。未完成的工作区可能出现在未归属任务中。</p>
            <div className="flex flex-wrap justify-end gap-2">
              <button className={button} type="button" disabled={busy} onClick={close}>取消</button>
              <button className={button} type="button" disabled={busy} onClick={() => void abandon()}>放弃并重新创建</button>
              <button className={button} type="button" aria-label="确认创建 / 恢复" disabled={busy} onClick={() => void commit()}>{busy ? "正在创建" : "确认创建 / 恢复"} <span className={kbd}>⌘↵</span></button>
            </div>
          </div> : <form className="flex flex-col gap-3" onSubmit={(event) => void prepare(event)}>
            <div className="flex flex-wrap gap-3">
              <div className={`${label} w-[190px]`}>所属工作区 *<span className="truncate border border-line bg-bg px-2 py-1.5 text-sm text-ink" title={project?.name}>{project?.name ?? "请先选择工作区"}</span></div>
              <label className={`${label} min-w-[200px] flex-1`}>任务目标 / 名称 *
                <input ref={nameRef} aria-label="任务名称" className={field} required maxLength={256} value={name}
                  onChange={(event) => setName(event.target.value)} />
              </label>
            </div>
            <fieldset className="border-0 p-0">
              <legend className="text-[11px] font-medium text-muted">任务工作区模式 *</legend>
              <div className="mt-1 flex flex-wrap gap-3 rounded-[6px] border border-line bg-bg px-2.5 py-2">
                {(["worktree", "existing-git", "plain-dirs"] as const).map((value) => {
                  const disabled = busy || (value !== "plain-dirs" && !gitModesAvailable);
                  return <label key={value} className={`flex items-center gap-1.5 text-xs ${disabled ? "opacity-50" : ""}`}>
                    <input type="radio" name="workspace-mode" value={value} checked={mode === value} disabled={disabled}
                      onChange={() => { setMode(value); if (value === "plain-dirs") setRepos({}); }} />
                    {WORKSPACE_MODE_LABELS[value]}
                  </label>;
                })}
              </div>
              <p className="mt-1 text-[11px] text-muted">{MODE_HINTS[mode]}</p>
            </fieldset>
            <fieldset className="min-w-0 border-0 p-0">
              <legend className="flex w-full items-center justify-between gap-2 text-[11px] font-medium text-muted">
                <span>关联工作区仓库与目录 *</span>
                <span className="text-accent">已选 {selectedRepos.length} 个仓库 · {directories.length} 个目录</span>
              </legend>
              <div className="mt-1 flex max-h-[220px] flex-col gap-1.5 overflow-y-auto rounded-[6px] border border-line bg-bg p-2">
                {projectRepos.map((repo) => {
                  const entry = repos[repo.id];
                  const disabled = busy || mode === "plain-dirs";
                  return <div key={repo.id} className={`rounded-[5px] border bg-paper px-2.5 py-1.5 ${entry?.selected && mode !== "plain-dirs" ? "border-accent" : "border-line"}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label className="flex min-w-0 items-center gap-2 text-xs font-medium">
                        <input type="checkbox" checked={mode !== "plain-dirs" && (entry?.selected ?? false)} disabled={disabled}
                          onChange={(event) => setRepos((old) => ({ ...old, [repo.id]: { selected: event.target.checked, remote: old[repo.id]?.remote ?? "", branch: old[repo.id]?.branch ?? "" } }))} />
                        {sourceName(repo)}
                      </label>
                      <span className="min-w-0 truncate font-mono text-[10px] text-muted" title={sourcePath(repo)}>{sourcePath(repo)}</span>
                    </div>
                    {entry?.selected && mode !== "plain-dirs" && <div className="mt-1.5 flex flex-wrap gap-2">
                      <label className={`${label} w-[130px]`}>远程名称
                        <input className={field} aria-label="远程名称" required placeholder="origin" value={entry.remote}
                          onChange={(event) => setRepos((old) => ({ ...old, [repo.id]: { ...old[repo.id]!, remote: event.target.value } }))} />
                      </label>
                      {mode === "worktree" ? <label className={`${label} w-[160px]`}>远程基线分支
                        <input className={field} aria-label="远程分支" required placeholder="main" value={entry.branch}
                          onChange={(event) => setRepos((old) => ({ ...old, [repo.id]: { ...old[repo.id]!, branch: event.target.value } }))} />
                      </label> : <p className="self-end text-[10px] text-muted">使用该目录当前检出的分支（由 Host 读取）</p>}
                    </div>}
                  </div>;
                })}
                {project?.directories.map((dir) => <label key={dir.id} className="flex items-center justify-between gap-2 rounded-[5px] border border-line bg-paper px-2.5 py-1.5 text-xs">
                  <span className="flex min-w-0 items-center gap-2">
                    <input type="checkbox" checked={directories.includes(dir.id)} disabled={busy}
                      onChange={(event) => setDirectories((old) => event.target.checked ? [...old, dir.id] : old.filter((id) => id !== dir.id))} />
                    <span className="truncate">{sourceName(dir)} · {sourcePath(dir)}</span>
                  </span>
                  <span className="shrink-0 text-[10px] text-muted">{directories.includes(dir.id) ? "共享原文件" : "未勾选"}</span>
                </label>)}
                {!hasSourcesInProject && <p className="text-xs text-muted">当前工作区至少需要一个仓库或目录。</p>}
              </div>
              <p className="mt-1 text-[11px] text-muted">{previewText}</p>
            </fieldset>
            {hasSelectedDirs && <label className="flex items-start gap-2 text-[11px] text-muted">
              <input type="checkbox" required checked={sharedWriteConfirmed} onChange={(event) => setSharedWriteConfirmed(event.target.checked)} />
              我确认普通目录通过共享可写链接接入任务，后续写入会直接修改原始目录
            </label>}
            <div className="grid gap-2 rounded-[6px] border border-line bg-bg px-2.5 py-2 sm:grid-cols-2">
              <div className="min-w-0">
                <p className="text-[11px] font-medium text-muted">运行环境变量（继承自工作区）</p>
                {project?.environment === null ? <p className="mt-1 text-[10px] text-muted">Host 未上报工作区环境变量</p>
                  : (project?.environment ?? []).length === 0 ? <p className="mt-1 text-[10px] text-muted">工作区未存储环境变量</p>
                  : <><ul className="mt-1 space-y-0.5 font-mono text-[10px] text-ink">{(project?.environment ?? []).slice(0, 3).map((row) => <li key={row.key} className="truncate">• {row.key}={row.value}</li>)}</ul>
                    <p className="mt-1 text-[10px] text-muted">已读取 {(project?.environment ?? []).length} 个工作区变量（仅展示；任务级注入见 #144）</p></>}
              </div>
              <div className="min-w-0">
                <p className="text-[11px] font-medium text-muted">推送到远程仓库时自动创建分支</p>
                <p className="mt-1 truncate font-mono text-[10px] text-accent" title={branchPreview(project?.branchTemplate ?? null, name)}>origin/{branchPreview(project?.branchTemplate ?? null, name)}</p>
                <p className="mt-1 text-[10px] text-muted">仅预览工作区分支模板；本任务创建不会推送，远端分支与 PR 见 #148</p>
              </div>
            </div>
            <label className="flex gap-2 text-[11px] text-muted"><input type="checkbox" checked={override} disabled={busy} onChange={(event) => setOverride(event.target.checked)} />单次选择其他任务根（系统目录选择器）</label>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="max-w-[380px] text-[10px] text-muted">创建失败会保留本机待完成意图，可用同一身份重试；不会覆盖原始仓库或目录。写入按本任务审批，跨任务隔离尚未完成（T06）。</p>
              <div className="flex gap-1">
                <button className={button} type="button" disabled={busy} onClick={close}>取消</button>
                <button className={button} type="submit" aria-label={primaryLabel} disabled={submitDisabled}>{busy ? "正在读取来源" : primaryLabel} <span className={kbd}>⌘↵</span></button>
              </div>
            </div>
          </form>}
        </div>
        </section>
      </div>
    </div>}
  </>;
}
