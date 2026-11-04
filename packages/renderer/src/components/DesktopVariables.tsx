import { useCallback, useEffect, useState } from "react";
import {
  deleteTaskVariable,
  deleteWorkspaceVariable,
  readTaskVariables,
  readWorkspaceVariables,
  saveTaskVariable,
  saveWorkspaceVariable,
  variableInputError,
  type EffectiveVariableView,
  type TaskVariablesView,
  type VariableRowView,
} from "../data/desktopProjects";
import { shellBridge, type PidockBridge } from "../data/shellBridge";

/**
 * [Pencil T09] #144 · S07/S08: the effective variables of one task with the
 * layer each value came from. Edits are exact-key IPC (`setTaskVariable` /
 * `removeTaskVariable`), so deleting an override restores workspace
 * inheritance instead of writing an empty shadow row.
 *
 * Boundary stated in the panel: main resolves the effective values when the
 * task's Host starts. A running Host/turn keeps the environment it was forked
 * with; the next start sees the edit. Values here are shared and non-secret —
 * credential-shaped names are refused by main and by this form.
 */
/** Stable fallback: a fresh `{}` per render would restart every load effect. */
const NO_BRIDGE: PidockBridge = {};
const BUTTON = "inline-flex min-h-6 items-center gap-1 rounded-[3px] border border-line bg-paper px-1.5 text-[10px] text-ink hover:bg-bg disabled:opacity-50";
const INPUT = "min-w-0 rounded-[3px] border border-line bg-paper px-1.5 py-1 font-mono text-[10px] text-ink outline-none focus:border-accent";

function ScopeBadge({ scope }: { scope: "workspace" | "task" }) {
  return <span data-testid={`variable-scope-${scope}`}
    className={`shrink-0 rounded-[3px] border px-1 py-[1px] text-[9px] font-semibold ${scope === "task" ? "border-[#dfc99f] text-[#9a6032]" : "border-line text-accent"}`}>
    {scope === "task" ? "任务覆盖" : "工作区继承"}
  </span>;
}

function Rows({ rows, overrides, busy, onOverride, onRestore }: {
  rows: EffectiveVariableView[];
  overrides: VariableRowView[];
  busy: boolean;
  onOverride: (key: string) => void;
  onRestore: (key: string) => void;
}) {
  if (rows.length === 0) return <p className="mt-1 text-[10px] text-muted">工作区尚未配置变量，也没有任务覆盖。</p>;
  return <ul aria-label="生效环境变量" className="mt-1.5 divide-y divide-line rounded-[5px] border border-line bg-bg">
    {rows.map((row) => {
      const overridden = overrides.some((override) => override.key === row.key);
      return <li key={row.key} data-testid={`variable-${row.key}`} className="flex flex-wrap items-center justify-between gap-2 px-2 py-1.5">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-ink">
            <ScopeBadge scope={row.scope} />
            <span className="break-all">{row.key} = {row.value}</span>
          </p>
          {row.scope === "task" && <p className="mt-0.5 break-all font-mono text-[9px] text-muted">工作区值 {row.inheritedValue === null ? "（工作区未定义此键）" : row.inheritedValue} · 删除覆盖即恢复继承</p>}
        </div>
        <div className="flex shrink-0 gap-1">
          {row.scope === "task" || overridden
            ? <button type="button" className={BUTTON} disabled={busy} onClick={() => onRestore(row.key)}>删除覆盖</button>
            : <button type="button" className={BUTTON} disabled={busy} onClick={() => onOverride(row.key)}>覆盖此键</button>}
        </div>
      </li>;
    })}
  </ul>;
}

export function DesktopTaskVariables({ taskId, bridge }: { taskId: string; bridge?: PidockBridge }) {
  const api = bridge ?? shellBridge() ?? NO_BRIDGE;
  const [view, setView] = useState<TaskVariablesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setView(await readTaskVariables(api, taskId)); }
    catch (failure) { setView(null); setError(failure instanceof Error ? failure.message : "任务变量读取失败"); }
  }, [api, taskId]);
  useEffect(() => { void load(); }, [load]);

  const write = async (action: () => Promise<TaskVariablesView>) => {
    setBusy(true); setFormError(null);
    try { setView(await action()); setError(null); }
    catch (failure) { setFormError(failure instanceof Error ? failure.message : "任务变量写入失败"); }
    finally { setBusy(false); }
  };
  const save = () => {
    const refusal = variableInputError(key.trim(), value);
    if (refusal !== null) { setFormError(refusal); return; }
    void write(async () => {
      const next = await saveTaskVariable(api, taskId, key.trim(), value);
      setKey(""); setValue("");
      return next;
    });
  };
  const restore = (target: string) => void write(() => deleteTaskVariable(api, taskId, target));
  const edit = (target: string) => {
    const current = view?.effective.find((row) => row.key === target);
    setKey(target);
    setValue(current?.scope === "task" ? current.value : current?.value ?? "");
  };

  return <section aria-label="任务环境变量" data-testid="desktop-task-variables" className="mt-2 rounded-[6px] border border-line bg-paper px-3 py-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-[11px] font-semibold text-ink">环境变量（工作区继承 · 任务覆盖）</h3>
      <span className="text-[9px] text-muted">变更在任务 Host 下次启动时生效；运行中的会话保持原环境</span>
    </div>
    {error !== null && <p role="alert" className="mt-1 text-[10px] text-[#ad4545]">{error}</p>}
    {view === null && error === null && <p role="status" className="mt-1 text-[10px] text-muted">正在读取生效变量…</p>}
    {view !== null && <>
      <Rows rows={view.effective} overrides={view.overrides} busy={busy} onOverride={edit} onRestore={restore} />
      {view.refused.length > 0 && <p role="alert" data-testid="variables-refused" className="mt-1 break-all text-[10px] text-[#9a6032]">
        以下旧变量未注入（保留名称或凭据形态，按名列出）：{view.refused.map((row) => row.key).join("、")}
      </p>}
      <div className="mt-2 grid gap-1.5 below-narrow:grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
        <label className="min-w-0 text-[10px] text-muted">变量名
          <input aria-label="任务变量名" className={`${INPUT} mt-0.5 w-full`} value={key} placeholder="如 NODE_ENV" onChange={(event) => setKey(event.target.value)} />
        </label>
        <label className="min-w-0 text-[10px] text-muted">任务值
          <input aria-label="任务变量值" className={`${INPUT} mt-0.5 w-full`} value={value} placeholder="覆盖工作区的值（非密文）" onChange={(event) => setValue(event.target.value)} />
        </label>
        <button type="button" className={`${BUTTON} self-end`} disabled={busy} onClick={save}>保存任务覆盖</button>
      </div>
      {formError !== null && <p role="alert" className="mt-1 text-[10px] text-[#ad4545]">{formError}</p>}
      <p className="mt-1 text-[9px] leading-4 text-muted">
        共享值只保存非密文；凭据请使用 Provider 凭据 / <span className="font-mono">$ENV</span> 引用。PATH/HOME/PIDOCK_*/凭据形态名称会被拒绝。
      </p>
    </>}
  </section>;
}

/** S07 workspace-level editor: exact-key add/edit/delete with the same refusals. */
export function DesktopWorkspaceVariables({ projectId, bridge, initialRows, compact = false }: {
  compact?: boolean;
  projectId: string;
  bridge?: PidockBridge;
  /**
   * Rows main already reported with the workspace (`project.environment`). When
   * present the panel renders them without a second read; each exact-key write
   * returns the updated workspace rows. `undefined` triggers a read (standalone).
   */
  initialRows?: VariableRowView[] | null;
}) {
  const api = bridge ?? shellBridge() ?? NO_BRIDGE;
  const [rows, setRows] = useState<VariableRowView[] | null>(initialRows === undefined ? null : initialRows);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try { setRows(await readWorkspaceVariables(api, projectId)); }
    catch (failure) { setRows(null); setError(failure instanceof Error ? failure.message : "工作空间变量读取失败"); }
  }, [api, projectId]);
  useEffect(() => { if (initialRows === undefined) void load(); }, [load, initialRows]);

  const write = async (action: () => Promise<VariableRowView[]>) => {
    setBusy(true);
    try { setRows(await action()); setError(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "工作空间变量写入失败"); }
    finally { setBusy(false); }
  };
  const save = () => {
    const refusal = variableInputError(key.trim(), value);
    if (refusal !== null) { setError(refusal); return; }
    void write(async () => {
      const next = await saveWorkspaceVariable(api, projectId, key.trim(), value);
      setKey(""); setValue("");
      return next;
    });
  };

  return <div className="rounded-[5px] bg-bg px-3 py-2" data-testid="desktop-workspace-variables">
    {error !== null && <p role="alert" className="text-[10px] text-[#ad4545]">{error}</p>}
    {rows === null && error === null && <p role="status" className="text-[10px] text-muted">正在读取工作空间变量…</p>}
    {rows !== null && (rows.length === 0
      ? <p className="text-[10px] text-muted">尚未配置工作空间变量；下属任务默认继承此处值。</p>
      : <ul aria-label="工作空间环境变量" className="flex flex-col gap-1 font-mono text-[10px] text-ink">
        {rows.map((row) => <li key={row.key} data-testid={`workspace-variable-${row.key}`} className="flex flex-wrap items-center justify-between gap-1 break-all">
          <span>• {row.key} = {row.value}</span>
          <span className="flex gap-1">
            <button type="button" className={BUTTON} disabled={busy} onClick={() => { setKey(row.key); setValue(row.value); }}>编辑</button>
            <button type="button" className={BUTTON} disabled={busy} onClick={() => void write(() => deleteWorkspaceVariable(api, projectId, row.key))}>删除</button>
          </span>
        </li>)}
      </ul>)}
    <details open={compact ? undefined : true}>
      <summary className="cursor-pointer text-[10px] text-accent">添加或编辑变量</summary>
    <div className="mt-1.5 grid gap-1.5 below-narrow:grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
      <input aria-label="工作空间变量名" className={INPUT} value={key} placeholder="变量名（如 NODE_ENV）" onChange={(event) => setKey(event.target.value)} />
      <input aria-label="工作空间变量值" className={INPUT} value={value} placeholder="共享值（非密文）" onChange={(event) => setValue(event.target.value)} />
      <button type="button" className={BUTTON} disabled={busy} onClick={save}>保存变量</button>
    </div>
    </details>
    <p className="mt-1 text-[10px] text-muted">逐键保存；任务默认继承，单任务覆盖在任务事实中编辑。运行中的任务在下次启动时读取新值。</p>
  </div>;
}
