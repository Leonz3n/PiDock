import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { Button } from "./ui/button";
import { DesktopTaskCreation } from "./DesktopTaskCreation";
import { DesktopConversation } from "./DesktopConversation";
import { DesktopTaskFacts } from "./DesktopTaskFacts";
import { desktopMode, importDesktopTaskRoot } from "../data/desktopInventory";
import { abandonCreation, commitCreation, currentCreation, CREATION_RETENTION_NOTICE, type CreationIntentView } from "../data/desktopCreation";
import { DESKTOP_LABELS, DesktopRootErrors, DesktopShell, type DesktopLocalPageKey, type DesktopView } from "./DesktopShell";
import { DesktopProjectOverview } from "./DesktopProjectOverview";
import { DesktopUnassignedTasks } from "./DesktopUnassignedTasks";
import { DesktopWorkspaceDialog } from "./DesktopWorkspaceDialog";
import { DesktopWorkspaceDeleteDialog } from "./DesktopWorkspaceDeleteDialog";
import { DesktopUsagePage } from "./DesktopUsagePage";
import { DesktopSchedulesPage } from "./DesktopSchedulesPage";
import { DesktopArchivePage, parseLifecycle } from "./DesktopArchivePage";
import { DesktopAttentionPage } from "./DesktopAttentionPage";
import { DesktopEnvironmentPage } from "./DesktopEnvironmentPage";
import { DesktopCapabilitiesPage } from "./DesktopCapabilitiesPage";
import { DesktopSettingsPage } from "./DesktopSettingsPage";
import { lifecycleStateThroughShell } from "../data/shellBridge";
import { loadDesktopProjects, parseDesktopProject, projectDeleteBlockers, projectDraft, projectName, projectOperation,
  projectRegistryHealth, recoverProjectRegistry, sourceName, sourcePath, verifyProjectSources, type DesktopProject,
  type DesktopProjects, type ProjectInput, type ProjectRegistryHealth, type ProjectSource, type SourceVerification,
  type TaskAssociation } from "../data/desktopProjects";
import { hostText } from "../data/workspaceFiles";
import { useAppearanceStore, watchSystemAppearance } from "../stores/appearance";

export { desktopMode };

type View = { kind: "loading" | "error" | "ready"; data?: DesktopProjects; error?: string };
type Selection = { kind: "unassigned" } | { kind: "project"; id: string };
type PendingCreate = { id: string | null };
function reconciledDraft(input: ProjectInput, committed: DesktopProject, projectId: string): ProjectInput {
  const matches = (provided: ProjectInput["repositories"], saved: ProjectSource[]) =>
    provided.length === saved.length && provided.every((row, index) => row.name === saved[index]?.name && row.path === saved[index]?.path &&
      (row.id === undefined || row.id === saved[index]?.id));
  // A Host that omits the settings (`null`) cannot reconcile them; that is
  // reported by the page, not treated as a silent mismatch of identical fields.
  const settingsMatch = (committed.environment === null || JSON.stringify(committed.environment) === JSON.stringify(input.environment)) &&
    (committed.branchTemplate === null || committed.branchTemplate === input.branchTemplate);
  if (committed.id !== projectId || committed.name !== input.name || committed.description !== input.description || !settingsMatch ||
      !matches(input.repositories, committed.repositories) || !matches(input.directories, committed.directories)) {
    throw new Error("工作空间更新返回的身份不一致，请核对本机数据");
  }
  return { ...input, repositories: committed.repositories, directories: committed.directories,
    environment: committed.environment ?? input.environment, branchTemplate: committed.branchTemplate ?? input.branchTemplate };
}
const FILE_STATE_LABEL: Record<"ok" | "missing" | "invalid", string> = { ok: "可用", missing: "缺失", invalid: "损坏" };
const button = "inline-flex min-h-8 items-center justify-center gap-1.5 border border-line bg-paper px-2.5 py-1 text-xs hover:bg-bg disabled:cursor-not-allowed disabled:opacity-50";
const field = "w-full min-w-0 border border-line bg-paper px-2 py-1.5 text-sm text-ink";
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "本机数据操作失败，请重试";
const emptyBridge = {};

function Sources({ title, rows }: { title: string; rows: ProjectSource[] }) {
  return <section className="mt-5"><h3 className="text-xs font-semibold text-muted">{title} · {rows.length}</h3>
    {rows.length ? <ul className="mt-2 divide-y divide-line border-y border-line">{rows.map((row) => <li key={row.id} className="min-w-0 py-2 text-xs"><strong className="block font-medium">{sourceName(row)}</strong><span className="block break-all text-muted">{sourcePath(row)}</span></li>)}</ul> : <p className="mt-2 text-xs text-muted">暂无{title}</p>}
  </section>;
}

export function DesktopInventory() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [selection, setSelection] = useState<Selection>({ kind: "unassigned" });
  const [form, setForm] = useState<"create" | "edit" | null>(null);
  const formRef = useRef(form);
  formRef.current = form;
  const [draft, setDraft] = useState<ProjectInput | null>(null);
  /** The workspace the edit dialog opened for; `null` in create mode. */
  const [editProjectId, setEditProjectId] = useState<string | null>(null);
  /** The source a 修复路径 click asked the edit dialog to focus. */
  const [repairSourceId, setRepairSourceId] = useState<string | null>(null);
  /** Per-source verification for the selected workspace, keyed by main's source id. */
  const [sourceReport, setSourceReport] = useState<{ projectId: string; statuses: Record<string, SourceVerification> } | null>(null);
  const [sourceReportError, setSourceReportError] = useState<{ projectId: string; message: string } | null>(null);
  /** The delete flow: `tasks === null` while main's blocker list is being read. */
  const [deleting, setDeleting] = useState<{ projectId: string; tasks: { taskId: string; name: string; state: TaskAssociation["state"] }[] | null; error: string | null } | null>(null);
  const [registryHealth, setRegistryHealth] = useState<ProjectRegistryHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const pendingCreateRef = useRef<PendingCreate | null>(null);
  const [editNeedsReview, setEditNeedsReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rootRetryPending, setRootRetryPending] = useState(false);
  const [rootRetryError, setRootRetryError] = useState<string | null>(null);
  const rootRetryRef = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingCreation, setPendingCreation] = useState<CreationIntentView | null>(null);
  const [creationNotice, setCreationNotice] = useState<{ taskId: string; message: string } | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [activeTask, setActiveTask] = useState<{ id: string; name: string; roots: string; association: string } | null>(null);
  const [factsActiveSession, setFactsActiveSession] = useState<{ taskId: string; sessionId: string | null } | null>(null);
  const reportActiveSession = useCallback((taskId: string, sessionId: string | null) => setFactsActiveSession({ taskId, sessionId }), []);
  /** [#139] The session the sidebar asked the open task page to show; `undefined` = the task's active session. */
  const [conversationToolbar, setConversationToolbar] = useState<HTMLDivElement | null>(null);
  const [conversationOpen, setConversationOpen] = useState(false);
  const [sessionFocus, setSessionFocus] = useState<string | undefined>(undefined);
  /** 能力管理 and 本机设置 — the 系统 group's two local pages, each a real page (#24). */
  const [localPage, setLocalPage] = useState<DesktopLocalPageKey | null>(null);
  // [UI 对齐 S8e] #47: 项目总览 is the project page; the create/claim/transfer/
  // unlink management surface it links to is a separate view (原型 A 的「项目管理」).
  const [manage, setManage] = useState(false);
  const [creationEntry, setCreationEntry] = useState(0);
  // [UI 对齐 S8e] #47: Token 用量 reads the same real SDK JSONL projection the
  // conversation shows, one selected task at a time.
  const [usageTaskId, setUsageTaskId] = useState<string | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [lifecycleIndex, setLifecycleIndex] = useState<{ data: DesktopProjects; activeIds: Set<string>; errors: string[] } | null>(null);
  // Prototype A opens on the first project. An explicit pick (shell nav or the
  // management list) wins and is never overridden by a later reread.
  const pinned = useRef(false);
  const entryEpoch = useRef(0);
  const openTask = async (taskId: string, sessionId?: string) => {
    if (rootRetryRef.current) return;
    const epoch = ++entryEpoch.current;
    setBusy(true); setActionError(null);
    try {
      const fresh = await loadDesktopProjects(window.pidock ?? {});
      if (epoch !== entryEpoch.current) return;
      setView({ kind: "ready", data: fresh });
      const row = fresh.associations.find((item) => item.taskId === taskId);
      const task = fresh.inventory.tasks.find((item) => item.taskId === taskId);
      if (!task || !row || (row.state !== "assigned" && row.state !== "unassigned") || fresh.inventory.roots.some((root) => root.state !== "ready")) throw new Error("任务或任务根不可用，请重新选择");
      const lifecycle = await lifecycleStateThroughShell(taskId);
      if (epoch !== entryEpoch.current) return;
      if (!lifecycle.ok) throw new Error(lifecycle.error ?? "任务归档状态读取失败");
      if (parseLifecycle(lifecycle.payload, taskId).archived) throw new Error("该任务已归档，请先从已归档页恢复");
      setFactsActiveSession(null);
      setSessionFocus(sessionId);
      setConversationOpen(sessionId !== undefined);
      setActiveTask({ id: taskId, name: task.name, roots: JSON.stringify(fresh.inventory.roots), association: JSON.stringify(row) });
    } catch (error) { if (epoch === entryEpoch.current) setActionError(errorMessage(error)); }
    finally { if (epoch === entryEpoch.current) setBusy(false); }
  };
  const load = useCallback(async (inPlace = false): Promise<boolean> => {
    if (!inPlace) setView({ kind: "loading" });
    setPendingCreation(null);
    setRootRetryError(null);
    try {
      const bridge = window.pidock ?? {};
      const data = await loadDesktopProjects(bridge);
      let current: CreationIntentView | null = null;
      if (typeof bridge.createTask === "function") {
        try {
          const intent = await currentCreation(bridge);
          if (intent?.state === "pending") current = intent;
        } catch {
          // An unreadable intent is not evidence that any task is unfinished.
        }
      }
      setPendingCreation(current);
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
      if (!pinned.current && pending === null) {
        setSelection((current) => current.kind === "project" ? current : data.projects[0] ? { kind: "project", id: data.projects[0].id } : current);
      }
      return true;
    }
    catch (error) {
      if (inPlace) setRootRetryError(errorMessage(error));
      else {
        setView({ kind: "error", error: errorMessage(error) });
        // A failed read must still say whether the backup can fix it (#136 bullet 4).
        setRegistryHealth(null);
        setHealthError(null);
        if (typeof (window.pidock ?? {}).projectOp === "function") {
          void projectRegistryHealth(window.pidock ?? {}).then(setRegistryHealth).catch((health) => setHealthError(errorMessage(health)));
        }
      }
      return false;
    }
  }, []);
  const retryRoots = async () => {
    // Shell and management expose the same reread; lock before React rerenders either.
    if (busy || rootRetryRef.current) return;
    rootRetryRef.current = true;
    setBusy(true);
    setRootRetryPending(true);
    try { await load(true); }
    finally { rootRetryRef.current = false; setRootRetryPending(false); setBusy(false); }
  };
  useEffect(() => { void load(); }, [load]);
  // [Pencil T14] #149: 外观 applies from the first paint, on every desktop page —
  // not only while 设置 is open. `hydrate` reads PiDock's own preference from
  // main and `watchSystemAppearance` re-resolves 跟随系统 when the OS flips.
  useEffect(() => {
    void useAppearanceStore.getState().hydrate();
    return watchSystemAppearance();
  }, []);
  useEffect(() => {
    if (view.kind === "ready" && selection.kind === "project" &&
        !view.data?.projects.some((project) => project.id === selection.id)) {
      setSelection({ kind: "unassigned" });
      setForm(null);
      setDraft(null);
    }
  }, [view, selection]);
  useEffect(() => {
    if (view.kind !== "ready" || !view.data) return;
    const current = view.data;
    let live = true;
    void Promise.all(current.inventory.tasks.map(async (task) => {
      try {
        const response = await lifecycleStateThroughShell(task.taskId);
        if (!response.ok) throw new Error(response.error ?? "读取失败");
        return { taskId: task.taskId, archived: parseLifecycle(response.payload, task.taskId).archived, error: "" };
      } catch (error) {
        return { taskId: task.taskId, archived: true, error: `${task.name}：${errorMessage(error)}` };
      }
    })).then((states) => {
      if (live) setLifecycleIndex({ data: current, activeIds: new Set(states.filter((row) => !row.archived).map((row) => row.taskId)), errors: states.map((row) => row.error).filter(Boolean) });
    });
    return () => { live = false; };
  }, [view]);
  // #136 bullet 4: main stats every source of the selected workspace on read, so a
  // moved repository is a per-source fact with a repair path, not a broken card.
  useEffect(() => {
    setSourceReport(null);
    setSourceReportError(null);
    if (view.kind !== "ready" || selection.kind !== "project") return;
    const projectId = selection.id;
    if (typeof (window.pidock ?? {}).projectOp !== "function") return;
    let live = true;
    void verifyProjectSources(window.pidock ?? {}, projectId).then((report) => {
      if (!live) return;
      setSourceReport({ projectId, statuses: Object.fromEntries(report.sources.map((row) => [row.id, row])) });
    }).catch((error) => { if (live) setSourceReportError({ projectId, message: errorMessage(error) }); });
    return () => { live = false; };
  }, [view, selection]);
  const run = async (action: () => Promise<unknown>) => {
    if (rootRetryRef.current) return;
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
  const finishPendingCreation = async (intent: CreationIntentView, action: "commit" | "abandon") => {
    if (rootRetryRef.current) return;
    if (action === "abandon" && !window.confirm(`放弃本次创建？${CREATION_RETENTION_NOTICE}。`)) return;
    setBusy(true);
    setActionError(null);
    setCreationNotice(null);
    let message: string | null = null;
    let failure: string | null = null;
    try {
      const bridge = window.pidock ?? emptyBridge;
      if (action === "commit") await commitCreation(bridge, intent.id);
      else message = await abandonCreation(bridge, intent.id);
    } catch (error) {
      failure = errorMessage(error);
    }
    const refreshed = await load();
    if (message) setCreationNotice({ taskId: intent.taskId, message });
    if (failure) setActionError(refreshed ? failure : `${failure}；当前本机状态无法核验`);
    else if (!refreshed) setActionError("操作结果无法核验，请重试读取本机数据");
    setBusy(false);
  };
  const data = view.data;
  const selected = selection.kind === "project" ? data?.projects.find((item) => item.id === selection.id) : undefined;
  const project = selected;
  const shown = project ? data?.associations.filter((row) => row.projectId === project.id) : data?.associations.filter((row) => row.projectId === null);
  const taskMap = new Map(data?.inventory.tasks.map((task) => [task.taskId, task]));
  const submit = async (input: ProjectInput) => {
    // Trimmed once, here: main refuses surrounding whitespace as invalid input.
    const payload: ProjectInput = { ...input, name: input.name.trim(), branchTemplate: input.branchTemplate.trim(),
      repositories: input.repositories.map((row) => ({ ...row, name: row.name.trim(), path: row.path.trim() })),
      directories: input.directories.map((row) => ({ ...row, name: row.name.trim(), path: row.path.trim() })) };
    const target = form === "edit" ? data?.projects.find((item) => item.id === editProjectId) : undefined;
    if (form === "edit" && !target) {
      // An edit whose workspace is no longer in the authoritative list must fail by
      // name. Falling through to the create branch would silently duplicate it.
      setActionError("要编辑的工作空间已不在本机清单中，请关闭对话框后重新选择");
      return;
    }
    if (form === "edit" && target) {
      // One `update` carries name + description + sources + settings: a single
      // registry write, so a rename can no longer half-commit (#136 bullet 2).
      await run(async () => {
        const updated = await projectOperation(window.pidock ?? {}, { op: "update", projectId: target.id, input: payload });
        try { setDraft(reconciledDraft(payload, parseDesktopProject(updated), target.id)); }
        catch (error) { setEditNeedsReview(true); throw error; }
      });
    } else await run(async () => {
      const created = await projectOperation(window.pidock ?? {}, { op: "create", input: payload });
      try {
        const { id } = parseDesktopProject(created);
        pendingCreateRef.current = { id };
        setPendingCreate({ id });
      } catch {
        pendingCreateRef.current = { id: null };
        setPendingCreate({ id: null });
        throw new Error("工作空间创建返回异常，无法确认身份；请检查本机数据，勿重复创建");
      }
    });
  };
  const openCreateWorkspace = () => {
    setForm("create");
    setEditProjectId(null);
    setRepairSourceId(null);
    setDraft(projectDraft());
    setActionError(null);
    setEditNeedsReview(false);
  };
  const openEditWorkspace = (projectId: string) => {
    const target = data?.projects.find((item) => item.id === projectId);
    if (!target) return;
    setForm("edit");
    setEditProjectId(projectId);
    setRepairSourceId(null);
    setDraft(projectDraft(target));
    setActionError(null);
    setEditNeedsReview(false);
  };
  const closeWorkspaceDialog = () => { setForm(null); setDraft(null); setEditProjectId(null); setRepairSourceId(null); setEditNeedsReview(false); };
  const readBlockers = async (projectId: string, clear: boolean) => {
    if (clear) setDeleting({ projectId, tasks: null, error: null });
    try {
      const blockers = await projectDeleteBlockers(window.pidock ?? {}, projectId);
      const names = new Map((data?.inventory.tasks ?? []).map((task) => [task.taskId, task.name]));
      setDeleting({ projectId, tasks: blockers.tasks.map((row) => ({ ...row, name: names.get(row.taskId) ?? row.taskId })), error: null });
    } catch (error) {
      // Unknown blockers stay unknown: an empty list would claim "nothing blocks
      // deletion" without main having said so.
      setDeleting({ projectId, tasks: null, error: errorMessage(error) });
    }
  };
  const openDelete = async (projectId: string) => { await readBlockers(projectId, true); };
  const confirmDelete = async (projectId: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await projectOperation(window.pidock ?? {}, { op: "delete", projectId });
      setDeleting(null);
      await load();
    } catch (error) {
      setDeleting((current) => current ? { ...current, error: errorMessage(error) } : current);
      if (!(await load())) setActionError(errorMessage(error));
    } finally { setBusy(false); }
  };
  const blockerAction = async (projectId: string, request: Parameters<NonNullable<NonNullable<typeof window.pidock>["projectOp"]>>[0]) => {
    await operate(request);
    await readBlockers(projectId, false);
  };
  const recoverRegistry = async () => {
    if (busy) return;
    if (!window.confirm("从 projects.json.bak 恢复项目注册表？恢复前会校验备份，当前不可用的文件保留为 projects.json.invalid。")) return;
    setBusy(true);
    setHealthError(null);
    try {
      await recoverProjectRegistry(window.pidock ?? {});
      setRegistryHealth(null);
      await load();
    } catch (error) {
      setHealthError(errorMessage(error));
      setView((current) => current.kind === "error" ? current : { kind: "error", error: "项目注册表恢复失败" });
    } finally { setBusy(false); }
  };
  // Workspace content stays mounted while a dedicated management window replaces
  // the navigation; returning preserves its task, session, draft and scroll.
  const ready = view.kind === "ready" ? view.data : undefined;
  const shellTasks = useMemo(() => (ready?.inventory.tasks ?? []).map((task) => ({
    ...task,
    projectId: ready?.associations.find((row) => row.taskId === task.taskId)?.projectId ?? null,
  })), [ready]);
  // Every Project name the shell shows comes from here, so a blank one is named
  // once at this producer instead of at each surface (`data/desktopProjects.ts`
  // `projectName`). The breadcrumb, the bottom strip, the workspace card's avatar
  // and the 环境与服务 project choice all read this list.
  const shellProjects = useMemo(() => (ready?.projects ?? []).map((project) => ({
    id: project.id, name: projectName(project), description: project.description,
    // A count is only shown when the lifecycle read completed: `null` says 未核验.
    taskCount: lifecycleIndex?.data === ready && lifecycleIndex !== null
      ? shellTasks.filter((task) => task.projectId === project.id).length
      : null,
  })), [ready, shellTasks, lifecycleIndex]);
  const lifecycleReady = lifecycleIndex?.data === ready && lifecycleIndex !== null;
  const activeTasks = lifecycleReady ? shellTasks.filter((task) => lifecycleIndex?.activeIds.has(task.taskId)) : [];
  const selectedProject = selection.kind === "project" ? shellProjects.find((project) => project.id === selection.id) : undefined;
  const environmentProject = selectedProject ?? shellProjects[0];
  const shellView: DesktopView = schedulesOpen
      ? { view: "schedules" }
    : archiveOpen
      ? { view: "archive" }
    : attentionOpen
      ? { view: "attention" }
    : environmentOpen
      ? { view: "env" }
    : usageOpen
      ? { view: "usage" }
    : localPage
      ? { view: localPage }
      : activeTask
        ? { view: "task", taskId: activeTask.id, sessionId: conversationOpen ? sessionFocus : undefined }
        : selection.kind === "project" && selectedProject
          ? { view: "project", projectId: selectedProject.id }
          : { view: "unassigned" };
  const navigate = (next: DesktopView) => {
    setActionError(null);
    setForm(null);
    setDraft(null);
    setEditNeedsReview(false);
    if (next.view === "task") {
      // [#139] The sidebar's session rows name a session; opening the task from
      // anywhere else clears the focus so the Host's active session is shown.
      setLocalPage(null);
      setUsageOpen(false);
      setSchedulesOpen(false);
      setArchiveOpen(false);
      setAttentionOpen(false);
      setEnvironmentOpen(false);
      setUsageTaskId(null);
      void openTask(next.taskId, next.sessionId);
      return;
    }
    entryEpoch.current++;
    setUsageOpen(next.view === "usage");
    setSchedulesOpen(next.view === "schedules");
    setArchiveOpen(next.view === "archive");
    setAttentionOpen(next.view === "attention");
    setEnvironmentOpen(next.view === "env");
    if (next.view === "project" || next.view === "unassigned") setManage(false);
    if (next.view === "usage") { setUsageTaskId(activeTask?.id ?? (shellTasks[0]?.taskId ?? null)); return; }
    if (next.view === "schedules" || next.view === "archive" || next.view === "attention" || next.view === "env") { setActiveTask(null); setLocalPage(null); return; }
    // Any other page leaves the usage view. 能力管理 keeps the task it was
    // opened from: 选用 is recorded on that task and Esc returns to it.
    setUsageTaskId(null);
    // [Pencil T14] #149 设置 keeps the task it was opened from too: returning
    // restores that task's session, draft and focus unchanged.
    if (next.view !== "capabilities" && next.view !== "settings") setActiveTask(null);
    setLocalPage(next.view === "capabilities" || next.view === "settings" ? next.view : null);
    if (next.view === "project") { pinned.current = true; setSelection({ kind: "project", id: next.projectId }); }
    if (next.view === "unassigned") { pinned.current = true; setSelection({ kind: "unassigned" }); }
  };
  const activeProject = activeTask
    ? shellProjects.find((project) => project.id === shellTasks.find((task) => task.taskId === activeTask.id)?.projectId)
    : undefined;
  const returnToWorkspace = () => {
    navigate(activeProject ? { view: "project", projectId: activeProject.id } : { view: "unassigned" });
    void load();
  };
  // #24: the task header's branch / repository-count chips read the SAME
  // `listTasks` row the sidebar card renders (`shellTasks`), so the two surfaces
  // cannot disagree and no second read is issued. A row that is absent (or a
  // Host that reported nothing) stays `undefined`/`null` — the header names that
  // instead of inventing a branch or a repository count.
  const activeTaskSummary = activeTask ? shellTasks.find((task) => task.taskId === activeTask.id) : undefined;
  const breadcrumb = environmentOpen
    ? { ...(environmentProject ? { project: environmentProject.name } : { project: "尚无项目" }), page: "环境与服务" }
    : attentionOpen
    ? { project: "所有项目", page: "需要处理" }
    : archiveOpen
    ? { ...(selectedProject ? { project: selectedProject.name } : {}), page: "已归档" }
    : schedulesOpen
    ? { ...(selectedProject ? { project: selectedProject.name } : {}), page: "定时任务" }
    : usageOpen
    ? { ...(activeProject ? { project: activeProject.name } : selectedProject ? { project: selectedProject.name } : {}), page: "Token 用量" }
    : localPage
    ? { ...(selectedProject ? { project: selectedProject.name } : {}), page: DESKTOP_LABELS[localPage] }
    : activeTask
    ? { ...(activeProject ? { project: activeProject.name } : {}), task: activeTask.name }
    : selectedProject
      ? { project: selectedProject.name, page: manage ? "项目管理" : "工作空间总览" }
      : selection.kind === "unassigned"
        ? { project: data?.projectsInitialized === false ? "项目映射未建立" : "未归属任务", page: manage ? "项目管理" : undefined }
        : {};
  const editingProject = form === "edit" ? data?.projects.find((item) => item.id === editProjectId) ?? null : null;
  const deleteProject = deleting ? data?.projects.find((item) => item.id === deleting.projectId) ?? null : null;
  const shell = (children: ReactNode) => <DesktopShell
    view={shellView}
    onNavigate={navigate}
    projects={shellProjects}
    projectsInitialized={data?.projectsInitialized ?? true}
    unassignedCount={lifecycleReady ? data?.associations.filter((row) => row.projectId === null).length ?? 0 : null}
    onNewTask={() => {
      navigate(selection.kind === "project" ? { view: "project", projectId: selection.id } : { view: "unassigned" });
      setSessionFocus(undefined);
      setManage(true);
      setCreationEntry((value) => value + 1);
    }}
    management={localPage === "capabilities" ? <DesktopCapabilitiesPage taskId={activeTask?.id ?? null} taskName={activeTask?.name ?? null} onBack={() => setLocalPage(null)} />
      : localPage === "settings" ? <DesktopSettingsPage taskName={activeTask?.name ?? null} onBack={() => setLocalPage(null)} /> : undefined}
    onNewWorkspace={openCreateWorkspace}
    tasks={activeTasks}
    allTaskCount={shellTasks.length}
    lifecyclePending={!lifecycleReady}
    lifecycleErrors={lifecycleReady ? lifecycleIndex?.errors ?? [] : []}
    roots={ready?.inventory.roots ?? []}
    rootRetry={{ busy, pending: rootRetryPending, error: rootRetryError, run: () => void retryRoots() }}
    breadcrumb={breadcrumb}
    headerFacts={activeTask && conversationOpen ? <DesktopTaskFacts compact taskId={activeTask.id} taskName={activeTask.name} bridge={window.pidock ?? emptyBridge} onBack={() => setConversationOpen(false)} /> : undefined}
    headerActions={activeTask && conversationOpen ? <div ref={setConversationToolbar} className="min-w-0" /> : activeTask && !conversationOpen ? <>
      <Button type="button" size="sm" variant="default" disabled={factsActiveSession?.taskId !== activeTask.id || factsActiveSession.sessionId === null} onClick={() => { if (factsActiveSession?.sessionId) { setSessionFocus(factsActiveSession.sessionId); setConversationOpen(true); } }}>进入活跃对话</Button>
      <Button type="button" size="sm" variant="outline" onClick={returnToWorkspace}>返回工作空间总览</Button>
    </> : !activeTask && !manage && !usageOpen && !schedulesOpen && !archiveOpen && !attentionOpen && !environmentOpen && selection.kind === "project" ? <>
      <Button type="button" size="sm" variant="default" onClick={() => { setManage(true); setCreationEntry((value) => value + 1); }}>在此工作空间新建任务</Button>
      <Button type="button" size="sm" variant="outline" onClick={() => openEditWorkspace(selection.id)}>添加来源仓库/目录</Button>
    </> : undefined}
  >
    {children}
    {form && draft ? <DesktopWorkspaceDialog
      mode={form}
      draft={draft}
      onChange={setDraft}
      onCancel={closeWorkspaceDialog}
      onSubmit={() => void submit(draft)}
      busy={busy}
      error={actionError}
      saveDisabled={editNeedsReview || pendingCreate !== null}
      sourceStatus={form === "edit" && editingProject && sourceReport?.projectId === editingProject.id ? sourceReport.statuses : undefined}
      focusSourceId={repairSourceId}
    /> : null}
    {deleting ? <DesktopWorkspaceDeleteDialog
      projectName={deleteProject ? projectName(deleteProject) : deleting.projectId}
      tasks={deleting.tasks}
      projects={shellProjects.filter((item) => item.id !== deleting.projectId)}
      busy={busy}
      error={deleting.error}
      onCancel={() => setDeleting(null)}
      onDelete={() => void confirmDelete(deleting.projectId)}
      onTransfer={(taskId, toProjectId) => void blockerAction(deleting.projectId, { op: "transfer", taskId, fromProjectId: deleting.projectId, toProjectId })}
      onUnlink={(taskId) => void blockerAction(deleting.projectId, { op: "unlink", taskId, expectedProjectId: deleting.projectId })}
    /> : null}
  </DesktopShell>;
  if (environmentOpen) return shell(<DesktopEnvironmentPage projects={shellProjects} projectId={environmentProject?.id ?? null} taskCount={environmentProject ? shellTasks.filter((task) => task.projectId === environmentProject.id).length : 0} tasks={environmentProject ? activeTasks.filter((task) => task.projectId === environmentProject.id) : []} tasksPending={!lifecycleReady} onSelectProject={(id) => { pinned.current = true; setSelection({ kind: "project", id }); }} />);
  if (attentionOpen) return shell(<DesktopAttentionPage tasks={activeTasks} projects={shellProjects} lifecyclePending={!lifecycleReady} lifecycleErrors={lifecycleIndex?.errors ?? []} onOpenTask={(taskId) => navigate({ view: "task", taskId, sessionId: "main" })} />);
  if (archiveOpen) return shell(<DesktopArchivePage tasks={shellTasks} onRestored={() => { void load(); }} />);
  if (schedulesOpen) return shell(<DesktopSchedulesPage tasks={shellTasks} onOpenTask={(taskId) => navigate({ view: "task", taskId })} onOpenSession={(taskId, sessionId) => navigate({ view: "task", taskId, sessionId })} />);
  if (usageOpen) return shell(<DesktopUsagePage
    tasks={shellTasks}
    taskId={usageTaskId}
    onSelectTask={(taskId) => { setActiveTask(null); setUsageTaskId(taskId); }}
  />);
  // Task facts and conversations are separate destinations; only an explicit
  // session choice mounts the SDK conversation. Disk identities stay Host-owned.
  if (activeTask) return shell(conversationOpen ? <div className="flex h-full min-h-0 flex-col">
    <div className="min-h-0 flex-1">
      <DesktopConversation toolbarTarget={conversationToolbar} key={activeTask.id} initialSessionId={sessionFocus} taskId={activeTask.id} name={activeTask.name} branch={activeTaskSummary?.branch ?? ""} repoCount={activeTaskSummary?.repoCount ?? null} roots={activeTask.roots} association={activeTask.association} onBack={() => setConversationOpen(false)} onOpenProviders={() => navigate({ view: "capabilities" })} onArchived={() => { navigate({ view: "archive" }); void load(); }} onSourcesChanged={() => { void load(true); }} />
    </div>
  </div> : <DesktopTaskFacts headerInShell destinationActive={localPage === null} onActiveSession={reportActiveSession} taskId={activeTask.id} taskName={activeTask.name} bridge={window.pidock ?? emptyBridge}
    onOpenSession={(sessionId) => { setSessionFocus(sessionId); setConversationOpen(true); }}
    onBack={returnToWorkspace}
    onRepair={() => { if (activeProject) openEditWorkspace(activeProject.id); }} />);
  if (view.kind !== "ready" || !data) return <main className="grid min-h-screen place-items-center bg-bg px-6 text-ink" data-testid="desktop-inventory">
    <div className="w-full max-w-[620px]">
      {/* A submitted write whose authoritative reread failed must stay visible: dropping
          it here would let the user retry a create that already committed. */}
      {actionError && <p role="alert" className="mb-3 text-sm text-[#ad4545]">{actionError}</p>}
      {creationNotice && <p role="status" className="mb-3 text-sm text-muted">{creationNotice.message}</p>}
      {view.kind === "loading"
        ? <p role="status" className="text-sm text-muted">正在读取本机项目与任务</p>
        : <div className="border border-line bg-paper p-4 text-sm">
          <p role="alert">{view.error}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className={button} type="button" onClick={() => void load()}>重试</button>
            {/* #136 bullet 4: corruption is a named state with a recovery path, not a dead end. */}
            {registryHealth?.recoverable ? <button className={button} type="button" disabled={busy} onClick={() => void recoverRegistry()}>从备份恢复</button> : null}
          </div>
          {registryHealth ? <p className="mt-2 text-[11px] text-muted" data-testid="registry-health">
            项目注册表：主文件 {FILE_STATE_LABEL[registryHealth.primary]} · 备份 {FILE_STATE_LABEL[registryHealth.backup]}
            {registryHealth.recoverable ? "；可显式从备份恢复" : "；没有可用的恢复来源"}
          </p> : null}
          {healthError ? <p className="mt-2 text-[11px] text-[#805c28]" aria-live="polite">注册表状态读取失败：{healthError}</p> : null}
        </div>}
    </div>
  </main>;
  const overviewProject = selection.kind === "project" ? data.projects.find((item) => item.id === selection.id) ?? null : null;
  const workspaceOverview = (target: DesktopProject) => shell(<>
    {actionError && <p role="alert" className="mb-3 text-sm text-[#ad4545]">{actionError}</p>}
    <DesktopProjectOverview
      project={target}
      tasks={activeTasks}
      lifecyclePending={!lifecycleReady || (lifecycleIndex?.errors.length ?? 0) > 0}
      associations={data.associations}
      roots={data.inventory.roots}
      projectsInitialized={data.projectsInitialized}
      onOpenTask={(taskId) => navigate({ view: "task", taskId })}
      onManage={() => setManage(true)}
      onManageDirectories={() => openEditWorkspace(target.id)}
      onEdit={() => openEditWorkspace(target.id)}
      onRepairSource={(sourceId) => { openEditWorkspace(target.id); setRepairSourceId(sourceId); }}
      onDelete={() => void openDelete(target.id)}
      sourceStatus={sourceReport?.projectId === target.id ? sourceReport.statuses : null}
      sourceStatusError={sourceReportError?.projectId === target.id ? sourceReportError.message : null}
      creationIncompleteTaskId={pendingCreation?.taskId ?? null}
      onCreateTask={() => { setManage(true); setActionError(null); }}
      unassignedCounts={{
        claimable: data.associations.filter((row) => row.projectId === null && row.state === "unassigned").length,
        unavailable: data.associations.filter((row) => row.projectId === null && row.state !== "unassigned").length,
      }}
    />
  </>);
  if (!manage) return overviewProject ? workspaceOverview(overviewProject) : shell(<DesktopUnassignedTasks
    tasks={activeTasks}
    associations={data.associations}
    projects={shellProjects}
    lifecyclePending={!lifecycleReady}
    projectsInitialized={data.projectsInitialized}
    busy={busy}
    creationIncompleteTaskId={pendingCreation?.taskId ?? null}
    onOpenTask={(taskId) => navigate({ view: "task", taskId })}
    onClaim={(taskId, projectId) => void operate({ op: "claim", taskId, projectId })}
    onManage={() => { pinned.current = true; setManage(true); }}
  />);
  return shell(<div className="mx-auto w-full max-w-[1100px] px-4 py-5" data-testid="desktop-inventory">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h1 className="text-lg font-semibold">工作空间与任务</h1>
        <div className="flex gap-2"><button className={button} type="button" disabled={busy || pendingCreate !== null} onClick={openCreateWorkspace}><Icon name="plus" />新建工作空间</button>
          <button className={button} type="button" disabled={busy} onClick={() => void importRoot()}><Icon name="folder" />找回任务根</button></div></div>
      <DesktopTaskCreation key={creationEntry} openOnMount={creationEntry > 0} project={project} bridge={window.pidock ?? emptyBridge} onCreated={async (projectId, taskId) => {
        if (!(await load())) throw new Error("任务已创建，但本机清单无法核验；请重试读取");
        // Land on the NEW task's facts view (S08), not the project overview.
        setSelection({ kind: "project", id: projectId });
        setConversationOpen(false);
        await openTask(taskId);
      }} />
      {actionError && <p role="alert" className="mb-3 text-sm text-[#ad4545]">{actionError}</p>}
      {pendingCreate && <button className={`${button} mb-3`} type="button" onClick={() => void load()}>重新核验</button>}
      <div className="mb-3 flex flex-wrap gap-2">
        <button className={button} type="button" onClick={() => setManage(false)}>返回工作空间总览</button>
      </div>
      <div className="grid gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="项目导航" className="min-w-0 border-b border-line pb-3 md:border-b-0 md:border-r md:pr-4">
          <h2 className="mb-2 text-xs font-semibold text-muted">工作空间 · {data.projects.length}</h2>
          <div className="flex gap-1 overflow-x-auto md:block md:space-y-1">{data.projects.map((item) => <button type="button" key={item.id} onClick={() => { pinned.current = true; setSelection({ kind: "project", id: item.id }); setForm(null); setDraft(null); setActionError(null); }} className={`block min-w-0 shrink-0 px-2 py-2 text-left text-sm md:w-full md:truncate ${project?.id === item.id ? "bg-paper font-semibold" : "hover:bg-paper"}`}>{projectName(item)}</button>)}</div>
          {!data.projects.length && <p className="text-xs text-muted">{data.projectsInitialized ? "暂无工作空间" : "项目映射未建立"}</p>}
          <button type="button" className={`mt-3 block px-2 py-2 text-left text-sm ${!project ? "bg-paper font-semibold" : "hover:bg-paper"}`} onClick={() => { pinned.current = true; setSelection({ kind: "unassigned" }); setForm(null); setDraft(null); setActionError(null); }}>{data.projectsInitialized ? "未归属任务" : "项目映射未建立"} · {data.associations.filter((row) => row.projectId === null).length}</button>
        </nav>
        <div className="min-w-0">
          {project ? <><div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><h2 className="text-base font-semibold">{projectName(project)}</h2><p className="mt-1 text-xs text-muted">{hostText(project.description, "Host 未上报项目说明")}</p></div>
            <div className="flex gap-2"><button className={button} type="button" disabled={busy} onClick={() => openEditWorkspace(project.id)}><Icon name="settings" />编辑</button><button className={button} type="button" disabled={busy} onClick={() => void openDelete(project.id)}><Icon name="archive" />删除</button></div></div>
            <Sources title="仓库" rows={project.repositories} /><Sources title="普通目录" rows={project.directories} /></> : <h2 className="text-base font-semibold">{data.projectsInitialized ? "未归属任务" : "项目映射未建立"}</h2>}
          <section className="mt-6"><h3 className="border-b border-line pb-2 text-xs font-semibold text-muted">任务 · {shown?.length ?? 0}</h3>
            {!shown?.length && <p className="py-5 text-sm text-muted">{project ? "此项目暂无任务" : "已检查的任务根暂无未归属任务"}</p>}
            <ul className="divide-y divide-line">{shown?.map((row) => <TaskRow key={row.taskId} row={row} name={taskMap.get(row.taskId)?.name ?? row.taskId} projects={data.projects} choice={choice[row.taskId] ?? ""} setChoice={(value) => setChoice((prev) => ({ ...prev, [row.taskId]: value }))} busy={busy} open={() => navigate({ view: "task", taskId: row.taskId })} act={operate} recovery={{ creation: pendingCreation?.taskId === row.taskId ? pendingCreation : null, notice: creationNotice?.taskId === row.taskId ? creationNotice.message : null, onFinish: (intent, action) => void finishPendingCreation(intent, action) }} />)}</ul>
          </section>
          <DesktopRootErrors roots={data.inventory.roots} busy={busy} retryPending={rootRetryPending} retryError={rootRetryError} onRetry={() => void retryRoots()} className="mt-3 empty:hidden" />
          <p className="mt-5 text-xs text-muted">仅显示默认及已登记任务根；其他位置需明确找回。</p>
        </div>
      </div>
    </div>);
}

function TaskRow({ row, name, projects, choice, setChoice, busy, open, act, recovery }: { row: TaskAssociation; name: string; projects: DesktopProject[]; choice: string; setChoice: (value: string) => void; busy: boolean; open: () => void; act: (request: Parameters<NonNullable<NonNullable<typeof window.pidock>["projectOp"]>>[0]) => Promise<void>; recovery: { creation: CreationIntentView | null; notice: string | null; onFinish: (intent: CreationIntentView, action: "commit" | "abandon") => void } }) {
  const options = projects.filter((project) => project.id !== row.projectId);
  return <li className="min-w-0 py-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0"><strong className="block truncate font-medium">{name}</strong><span className="text-xs text-muted">{row.taskId}{row.state === "needs-repair" ? " · 关联待修复" : row.state === "unavailable" ? " · 任务不可用，请检查任务根" : ""}</span>
      {recovery.creation && <div className="mt-2 max-w-2xl border-l-2 border-[#dfc99f] pl-2"><strong className="text-xs font-semibold text-[#9a6032]">创建未完成</strong><p className="mt-1 text-xs text-muted">这项任务的创建尚未完成。你可以恢复完成；也可以放弃（{CREATION_RETENTION_NOTICE}）。</p>
        <div className="mt-2 flex flex-wrap gap-1"><button type="button" className={button} disabled={busy} onClick={() => recovery.onFinish(recovery.creation!, "commit")}>恢复完成</button><button type="button" className={button} disabled={busy} onClick={() => recovery.onFinish(recovery.creation!, "abandon")}>放弃创建</button></div>
      </div>}
      {recovery.notice && <p role="status" className="mt-2 text-xs text-muted">{recovery.notice}</p>}
    </div>
    <div className="flex flex-wrap gap-1"><button type="button" className={button} disabled={busy || row.state === "needs-repair" || row.state === "unavailable"} onClick={open}>进入工作区</button><select className={`${field} max-w-[145px]`} aria-label={`${name} 目标项目`} value={choice} disabled={busy || row.state === "needs-repair" || row.state === "unavailable"} onChange={(event) => setChoice(event.target.value)}><option value="">选择项目</option>{options.map((project) => <option key={project.id} value={project.id}>{projectName(project)}</option>)}</select>
      <button type="button" className={button} disabled={busy || !choice || row.state === "needs-repair" || row.state === "unavailable"} onClick={() => void act(row.projectId ? { op: "transfer", taskId: row.taskId, fromProjectId: row.projectId, toProjectId: choice } : { op: "claim", taskId: row.taskId, projectId: choice })}>{row.projectId ? "转移" : "认领"}</button>
      {row.projectId && <button type="button" className={button} disabled={busy} onClick={() => void act({ op: "unlink", taskId: row.taskId, expectedProjectId: row.projectId! })}>解绑</button>}</div></div></li>;
}
