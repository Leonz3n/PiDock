import { useEffect, useState, type FormEvent } from "react";
import { Icon } from "./Icon";
import { commitCreation, currentCreation, prepareCreation, type CreationInput, type CreationIntentView } from "../data/desktopCreation";
import type { DesktopProject } from "../data/desktopProjects";
import type { PidockBridge } from "../data/shellBridge";

const button = "inline-flex min-h-8 items-center justify-center gap-1.5 border border-line bg-paper px-2.5 py-1 text-xs hover:bg-bg disabled:cursor-not-allowed disabled:opacity-50";
const field = "w-full min-w-0 border border-line bg-paper px-2 py-1.5 text-sm text-ink";

export function DesktopTaskCreation({ project, bridge, onCreated }: { project?: DesktopProject; bridge: PidockBridge; onCreated: (projectId: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [formProjectId, setFormProjectId] = useState<string | null>(null);
  const [intent, setIntent] = useState<CreationIntentView | null>(null);
  const [name, setName] = useState("");
  const [repos, setRepos] = useState<Record<string, { selected: boolean; remote: string; branch: string }>>({});
  const [directories, setDirectories] = useState<string[]>([]);
  const [sharedWriteConfirmed, setSharedWriteConfirmed] = useState(false);
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (typeof bridge.createTask !== "function") { setError("桌面壳真实任务创建接口不可用，请重启应用"); return; }
    void currentCreation(bridge).then((current) => {
      if (current?.state === "pending") { setIntent(current); setOpen(true); }
    }).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "创建记录读取失败"));
  }, [bridge]);
  const prepare = async (event: FormEvent) => {
    event.preventDefault();
    if (!project || project.id !== formProjectId) { setError("项目选择已变化，请选择原项目或取消后重新创建"); return; }
    const input: CreationInput = { projectId: project.id, name,
      repositories: project.repositories.filter((row) => repos[row.id]?.selected).map((row) => ({ sourceId: row.id, remote: repos[row.id]!.remote, remoteBranch: repos[row.id]!.branch })),
      directoryIds: directories, sharedWriteConfirmed, override };
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
      await commitCreation(bridge, intent.id);
      await onCreated(intent.projectId);
      setIntent(null); setOpen(false); setName(""); setRepos({}); setDirectories([]); setSharedWriteConfirmed(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "创建未完成，原任务身份已保留，请重试"); }
    finally { setBusy(false); }
  };
  return <>
    <button className={button} type="button" disabled={busy || !project || !project.repositories.length || typeof bridge.createTask !== "function"} title={!project ? "请先选择项目" : !project.repositories.length ? "当前创建流程至少需要一个 Git 仓库" : "创建真实任务"}
      onClick={() => { setFormProjectId(project?.id ?? null); setName(""); setRepos({}); setDirectories([]); setSharedWriteConfirmed(false); setOverride(false); setOpen(true); setError(null); }}><Icon name="plus" />任务</button>
    {error && <p role={typeof bridge.createTask === "function" ? "alert" : undefined} className="w-full text-xs text-[#ad4545]">{error}</p>}
    {open && <section className="w-full border-t border-line py-4 text-sm" aria-label="创建任务">
      {!intent && formProjectId && project?.id !== formProjectId && <p role="status" className="mb-2 text-xs text-[#ad4545]">项目选择已变化，请选择原项目或取消后重新创建。</p>}
      {intent ? <div className="space-y-2">
        <h2 className="font-semibold">任务路径预览 · {intent.name}</h2>
        <p className="break-all text-xs">{intent.taskDir}</p>
        <p className="text-xs">任务分支：{intent.branch}</p>
        {intent.repos.map((repo) => <p className="break-all text-xs" key={repo.id}>{repo.name} · {repo.remote}/{repo.remoteBranch} · {repo.commit} → {intent.taskDir}/{repo.repoDir}</p>)}
        {intent.directories.map((dir) => <p className="break-all text-xs" key={dir.id}>{dir.name} · {dir.path} → {intent.taskDir}/{dir.linkName}（共享可写）</p>)}
        <p className="text-xs text-muted">创建中断后会保留固定任务身份与提交；重试不会更新基线。未完成的工作区可能出现在未归属任务中。</p>
        <button className={button} type="button" disabled={busy} onClick={() => void commit()}>{busy ? "正在创建" : "确认创建 / 恢复"}</button>
      </div> : <form className="space-y-3" onSubmit={(event) => void prepare(event)}>
        <div className="flex items-center justify-between"><h2 className="font-semibold">从项目创建任务</h2><button className={button} type="button" disabled={busy} onClick={() => setOpen(false)}>取消</button></div>
        <label className="block text-xs">任务名称<input className={`${field} mt-1`} required maxLength={256} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <fieldset className="space-y-2"><legend className="font-semibold">仓库与远程基线</legend>
          {project?.repositories.map((repo) => <div className="grid gap-2 border-b border-line py-2" key={repo.id}>
            <label className="flex gap-2"><input type="checkbox" checked={repos[repo.id]?.selected ?? false} onChange={(event) => setRepos((old) => ({ ...old, [repo.id]: { selected: event.target.checked, remote: old[repo.id]?.remote ?? "", branch: old[repo.id]?.branch ?? "" } }))} />{repo.name}</label>
            <span className="break-all text-xs text-muted">{repo.path}</span>
            {repos[repo.id]?.selected && <div className="grid grid-cols-2 gap-2"><label className="text-xs">远程名称<input className={field} required placeholder="origin" value={repos[repo.id]?.remote ?? ""} onChange={(event) => setRepos((old) => ({ ...old, [repo.id]: { ...old[repo.id]!, remote: event.target.value } }))} /></label>
              <label className="text-xs">远程分支<input className={field} required placeholder="main" value={repos[repo.id]?.branch ?? ""} onChange={(event) => setRepos((old) => ({ ...old, [repo.id]: { ...old[repo.id]!, branch: event.target.value } }))} /></label></div>}
          </div>)}
        </fieldset>
        <fieldset className="space-y-1"><legend className="font-semibold">普通目录</legend>
          {project?.directories.map((dir) => <label className="flex gap-2 text-xs" key={dir.id}><input type="checkbox" checked={directories.includes(dir.id)} onChange={(event) => setDirectories((old) => event.target.checked ? [...old, dir.id] : old.filter((id) => id !== dir.id))} />{dir.name} · {dir.path}</label>)}
        </fieldset>
        {directories.length > 0 && <label className="flex items-start gap-2 text-xs"><input type="checkbox" required checked={sharedWriteConfirmed} onChange={(event) => setSharedWriteConfirmed(event.target.checked)} />我确认普通目录通过共享可写链接接入任务，后续写入会直接修改原始目录</label>}
        <label className="flex gap-2 text-xs"><input type="checkbox" checked={override} onChange={(event) => setOverride(event.target.checked)} />单次选择其他任务根（系统目录选择器）</label>
        <button className={button} type="submit" disabled={busy || project?.id !== formProjectId || !project?.repositories.length || !Object.values(repos).some((row) => row.selected)}>{busy ? "正在固定远程提交" : "固定基线并预览路径"}</button>
        {!project?.repositories.length && <p className="text-xs text-muted">当前创建流程至少需要一个 Git 仓库。</p>}
      </form>}
    </section>}
  </>;
}
