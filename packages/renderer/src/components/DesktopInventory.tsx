import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "./Icon";
import { desktopMode, importDesktopTaskRoot } from "../data/desktopInventory";
import { loadDesktopProjects, parseDesktopProject, projectOperation, type DesktopProject, type DesktopProjects, type ProjectInput, type ProjectSource, type TaskAssociation } from "../data/desktopProjects";

export { desktopMode };

type View = { kind: "loading" | "error" | "ready"; data?: DesktopProjects; error?: string };
type Selection = { kind: "unassigned" } | { kind: "project"; id: string };
type PendingCreate = { id: string | null };
function reconciledDraft(input: ProjectInput, committed: DesktopProject, projectId: string): ProjectInput {
  const matches = (provided: ProjectInput["repositories"], saved: ProjectSource[]) =>
    provided.length === saved.length && provided.every((row, index) => row.name === saved[index]?.name && row.path === saved[index]?.path &&
      (row.id === undefined || row.id === saved[index]?.id));
  if (committed.id !== projectId || committed.description !== input.description ||
      !matches(input.repositories, committed.repositories) || !matches(input.directories, committed.directories)) {
    throw new Error("项目更新返回的来源身份不一致，请核对本机数据");
  }
  return { ...input, repositories: committed.repositories, directories: committed.directories };
}
const button = "inline-flex min-h-8 items-center justify-center gap-1.5 border border-line bg-paper px-2.5 py-1 text-xs hover:bg-bg disabled:cursor-not-allowed disabled:opacity-50";
const field = "w-full min-w-0 border border-line bg-paper px-2 py-1.5 text-sm text-ink";
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "本机数据操作失败，请重试";

function SourceFields({ label, rows, onChange }: { label: string; rows: ProjectInput["repositories"]; onChange: (next: ProjectInput["repositories"]) => void }) {
  return <fieldset className="space-y-2"><legend className="mb-2 text-xs font-semibold">{label}</legend>
    {rows.map((row, index) => <div key={row.id ?? index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_32px] gap-1">
      <input aria-label={`${label}名称 ${index + 1}`} className={field} placeholder="名称" value={row.name} required maxLength={256} onChange={(event) => onChange(rows.map((item, at) => at === index ? { ...item, name: event.target.value } : item))} />
      <input aria-label={`${label}路径 ${index + 1}`} className={field} placeholder="本机绝对路径" value={row.path} required onChange={(event) => onChange(rows.map((item, at) => at === index ? { ...item, path: event.target.value } : item))} />
      <button className={button} type="button" aria-label={`移除${label} ${index + 1}`} title={`移除${label}`} onClick={() => onChange(rows.filter((_, at) => at !== index))}><Icon name="close" /></button>
    </div>)}
    <button className={button} type="button" onClick={() => onChange([...rows, { name: "", path: "" }])}><Icon name="plus" />添加{label}</button>
  </fieldset>;
}

function ProjectForm({ current, input, onChange, busy, saveDisabled, onCancel, onSubmit }: { current?: DesktopProject; input: ProjectInput; onChange: (next: ProjectInput) => void; busy: boolean; saveDisabled?: boolean; onCancel: () => void; onSubmit: (input: ProjectInput) => Promise<void> }) {
  const submit = (event: FormEvent) => { event.preventDefault(); void onSubmit(input); };
  return <form onSubmit={submit} className="space-y-4 border-t border-line py-4">
    <h3 className="text-sm font-semibold">{current ? "编辑项目" : "创建项目"}</h3>
    <fieldset disabled={busy} className="space-y-4">
      <label className="block text-xs">项目名称<input className={`${field} mt-1`} value={input.name} required maxLength={256} onChange={(event) => onChange({ ...input, name: event.target.value })} /></label>
      <label className="block text-xs">描述<textarea className={`${field} mt-1`} value={input.description} maxLength={256} rows={2} onChange={(event) => onChange({ ...input, description: event.target.value })} /></label>
      <SourceFields label="仓库" rows={input.repositories} onChange={(repositories) => onChange({ ...input, repositories })} />
      <SourceFields label="目录" rows={input.directories} onChange={(directories) => onChange({ ...input, directories })} />
    </fieldset>
    <div className="flex gap-2"><button className={button} type="submit" disabled={busy || saveDisabled}>保存</button><button className={button} type="button" onClick={onCancel} disabled={busy}>取消</button></div>
  </form>;
}

function Sources({ title, rows }: { title: string; rows: ProjectSource[] }) {
  return <section className="mt-5"><h3 className="text-xs font-semibold text-muted">{title} · {rows.length}</h3>
    {rows.length ? <ul className="mt-2 divide-y divide-line border-y border-line">{rows.map((row) => <li key={row.id} className="min-w-0 py-2 text-xs"><strong className="block font-medium">{row.name}</strong><span className="block break-all text-muted">{row.path}</span></li>)}</ul> : <p className="mt-2 text-xs text-muted">暂无{title}</p>}
  </section>;
}

export function DesktopInventory() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [selection, setSelection] = useState<Selection>({ kind: "unassigned" });
  const [form, setForm] = useState<"create" | "edit" | null>(null);
  const formRef = useRef(form);
  formRef.current = form;
  const [draft, setDraft] = useState<ProjectInput | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const pendingCreateRef = useRef<PendingCreate | null>(null);
  const [editNeedsReview, setEditNeedsReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const load = useCallback(async (): Promise<boolean> => {
    setView({ kind: "loading" });
    try {
      const data = await loadDesktopProjects(window.pidock ?? {});
      const pending = pendingCreateRef.current;
      if (pending) {
        if (pending.id && data.projects.some((project) => project.id === pending.id)) {
          pendingCreateRef.current = null;
          setPendingCreate(null);
          if (formRef.current === "create") {
            setSelection({ kind: "project", id: pending.id });
            setForm(null);
            setDraft(null);
            setActionError(null);
          }
        } else {
          setView({ kind: "ready", data });
          setActionError(pending.id ? "项目创建已提交，但尚未在本机清单中确认；请重新核验，勿重复创建" : "项目创建返回异常，无法确认身份；请检查本机数据，勿重复创建");
          return false;
        }
      }
      setView({ kind: "ready", data });
      return true;
    }
    catch (error) { setView({ kind: "error", error: errorMessage(error) }); return false; }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (view.kind === "ready" && selection.kind === "project" &&
        !view.data?.projects.some((project) => project.id === selection.id)) {
      setSelection({ kind: "unassigned" });
      setForm(null);
      setDraft(null);
    }
  }, [view, selection]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(errorMessage(error));
      if (!(await load())) setActionError(`${errorMessage(error)}；当前本机状态无法核验`);
      setBusy(false);
      return;
    }
    if (await load()) { setForm(null); setDraft(null); setChoice({}); setEditNeedsReview(false); }
    else if (pendingCreateRef.current) setActionError("项目创建已提交，但尚未在本机清单中确认；请重新核验，勿重复创建");
    else setActionError("操作结果无法核验，请重试读取本机数据");
    setBusy(false);
  };
  const operate = (request: Parameters<NonNullable<NonNullable<typeof window.pidock>["projectOp"]>>[0]) => run(() => projectOperation(window.pidock ?? {}, request));
  const importRoot = () => run(async () => { await importDesktopTaskRoot(window.pidock ?? {}); });
  const data = view.data;
  const selected = selection.kind === "project" ? data?.projects.find((item) => item.id === selection.id) : undefined;
  const project = selected;
  const shown = project ? data?.associations.filter((row) => row.projectId === project.id) : data?.associations.filter((row) => row.projectId === null);
  const taskMap = new Map(data?.inventory.tasks.map((task) => [task.taskId, task]));
  const submit = async (input: ProjectInput) => {
    if (form === "edit" && project) {
      const details = { description: input.description, repositories: input.repositories, directories: input.directories };
      // Each operation is independently committed. An error forces a fresh read.
      await run(async () => {
        const updated = await projectOperation(window.pidock ?? {}, { op: "update", projectId: project.id, input: details });
        try { setDraft(reconciledDraft(input, parseDesktopProject(updated), project.id)); }
        catch (error) { setEditNeedsReview(true); throw error; }
        if (input.name !== project.name) {
          try { await projectOperation(window.pidock ?? {}, { op: "rename", projectId: project.id, name: input.name }); }
          catch (error) { throw new Error(`项目资料已保存，但重命名失败：${errorMessage(error)}；请核对已写入的资料后重试`); }
        }
      });
    } else await run(async () => {
      const created = await projectOperation(window.pidock ?? {}, { op: "create", input });
      try {
        const { id } = parseDesktopProject(created);
        pendingCreateRef.current = { id };
        setPendingCreate({ id });
      } catch {
        pendingCreateRef.current = { id: null };
        setPendingCreate({ id: null });
        throw new Error("项目创建返回异常，无法确认身份；请检查本机数据，勿重复创建");
      }
    });
  };
  return <main className="min-h-screen bg-bg text-ink" data-testid="desktop-inventory">
    <header className="flex items-center justify-between border-b border-line bg-paper px-4 py-3 text-sm font-semibold">PiDock <span className="text-xs font-normal text-muted">本机工作区</span></header>
    <div className="mx-auto w-full max-w-[1100px] px-4 py-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h1 className="text-lg font-semibold">项目与任务</h1>
        <div className="flex gap-2"><button className={button} type="button" disabled={busy || pendingCreate !== null} onClick={() => { setForm("create"); setDraft({ name: "", description: "", repositories: [], directories: [] }); setActionError(null); }}><Icon name="plus" />项目</button>
          <button className={button} type="button" disabled={busy} onClick={() => void importRoot()}><Icon name="folder" />找回任务根</button>
          <button className={button} type="button" disabled title="真实任务创建尚未接线" aria-label="创建任务（尚未接线）"><Icon name="plus" />任务</button></div></div>
      {actionError && <p role="alert" className="mb-3 text-sm text-[#ad4545]">{actionError}</p>}
      {pendingCreate && view.kind === "ready" && <button className={`${button} mb-3`} type="button" onClick={() => void load()}>重新核验</button>}
      {view.kind === "loading" && <p role="status" className="text-sm text-muted">正在读取本机项目与任务</p>}
      {view.kind === "error" && <div role="alert" className="border border-line bg-paper p-4 text-sm"><p>{view.error}</p><button className={`${button} mt-3`} type="button" onClick={() => void load()}>重试</button></div>}
      {view.kind === "ready" && data && <div className="grid gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="项目导航" className="min-w-0 border-b border-line pb-3 md:border-b-0 md:border-r md:pr-4">
          <h2 className="mb-2 text-xs font-semibold text-muted">项目 · {data.projects.length}</h2>
          <div className="flex gap-1 overflow-x-auto md:block md:space-y-1">{data.projects.map((item) => <button type="button" key={item.id} onClick={() => { setSelection({ kind: "project", id: item.id }); setForm(null); setDraft(null); setActionError(null); }} className={`block min-w-0 shrink-0 px-2 py-2 text-left text-sm md:w-full md:truncate ${project?.id === item.id ? "bg-paper font-semibold" : "hover:bg-paper"}`}>{item.name}</button>)}</div>
          {!data.projects.length && <p className="text-xs text-muted">暂无项目</p>}
          <button type="button" className={`mt-3 block px-2 py-2 text-left text-sm ${!project ? "bg-paper font-semibold" : "hover:bg-paper"}`} onClick={() => { setSelection({ kind: "unassigned" }); setForm(null); setDraft(null); setActionError(null); }}>未归属任务 · {data.associations.filter((row) => row.projectId === null).length}</button>
        </nav>
        <div className="min-w-0">
          {form === "create" && draft && <ProjectForm input={draft} onChange={setDraft} busy={busy} saveDisabled={pendingCreate !== null} onCancel={() => { setForm(null); setDraft(null); }} onSubmit={submit} />}
          {project ? <><div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><h2 className="text-base font-semibold">{project.name}</h2><p className="mt-1 text-xs text-muted">{project.description}</p></div>
            <div className="flex gap-2"><button className={button} type="button" disabled={busy} onClick={() => { setForm("edit"); setEditNeedsReview(false); setDraft({ name: project.name, description: project.description, repositories: project.repositories, directories: project.directories }); }}><Icon name="settings" />编辑</button><button className={button} type="button" disabled={busy} onClick={() => { if (window.confirm(`删除项目「${project.name}」？关联任务必须先解绑或转移。`)) void operate({ op: "delete", projectId: project.id }); }}><Icon name="archive" />删除</button></div></div>
            {form === "edit" && draft && <ProjectForm key={project.id} current={project} input={draft} onChange={setDraft} busy={busy} saveDisabled={editNeedsReview} onCancel={() => { setForm(null); setDraft(null); setEditNeedsReview(false); }} onSubmit={submit} />}
            <Sources title="仓库" rows={project.repositories} /><Sources title="普通目录" rows={project.directories} /></> : <h2 className="text-base font-semibold">未归属任务</h2>}
          <section className="mt-6"><h3 className="border-b border-line pb-2 text-xs font-semibold text-muted">任务 · {shown?.length ?? 0}</h3>
            {!shown?.length && <p className="py-5 text-sm text-muted">{project ? "此项目暂无任务" : "已检查的任务根暂无未归属任务"}</p>}
            <ul className="divide-y divide-line">{shown?.map((row) => <TaskRow key={row.taskId} row={row} name={taskMap.get(row.taskId)?.name ?? row.taskId} projects={data.projects} choice={choice[row.taskId] ?? ""} setChoice={(value) => setChoice((prev) => ({ ...prev, [row.taskId]: value }))} busy={busy} act={operate} />)}</ul>
          </section>
          {data.inventory.roots.filter((root) => root.state === "error").map((root) => <p role="alert" key={root.label} className="mt-3 text-xs text-[#ad4545]">{root.label}：{root.message}</p>)}
          <p className="mt-5 text-xs text-muted">仅显示默认及已登记任务根；其他位置需明确找回。真实任务创建与 Agent 对话尚未接线。</p>
        </div>
      </div>}
    </div>
  </main>;
}

function TaskRow({ row, name, projects, choice, setChoice, busy, act }: { row: TaskAssociation; name: string; projects: DesktopProject[]; choice: string; setChoice: (value: string) => void; busy: boolean; act: (request: Parameters<NonNullable<NonNullable<typeof window.pidock>["projectOp"]>>[0]) => Promise<void> }) {
  const options = projects.filter((project) => project.id !== row.projectId);
  return <li className="min-w-0 py-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0"><strong className="block truncate font-medium">{name}</strong><span className="text-xs text-muted">{row.taskId}{row.state === "needs-repair" ? " · 关联待修复" : row.state === "unavailable" ? " · 任务不可用，请检查任务根" : ""}</span></div>
    <div className="flex flex-wrap gap-1"><select className={`${field} max-w-[145px]`} aria-label={`${name} 目标项目`} value={choice} disabled={busy || row.state === "needs-repair" || row.state === "unavailable"} onChange={(event) => setChoice(event.target.value)}><option value="">选择项目</option>{options.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
      <button type="button" className={button} disabled={busy || !choice || row.state === "needs-repair" || row.state === "unavailable"} onClick={() => void act(row.projectId ? { op: "transfer", taskId: row.taskId, fromProjectId: row.projectId, toProjectId: choice } : { op: "claim", taskId: row.taskId, projectId: choice })}>{row.projectId ? "转移" : "认领"}</button>
      {row.projectId && <button type="button" className={button} disabled={busy} onClick={() => void act({ op: "unlink", taskId: row.taskId, expectedProjectId: row.projectId! })}>解绑</button>}</div></div></li>;
}
