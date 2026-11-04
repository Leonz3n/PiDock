import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Icon } from "./Icon";
import { BRANCH_TEMPLATE_TOKEN, variableInputError, type ProjectInput, type SourceVerification } from "../data/desktopProjects";

/**
 * S10 `d0dQe` — 新建 / 编辑可复用工作空间.
 *
 * One dialog for both modes (`d0dQe` draws create; the board has no edit frame, so
 * edit reuses the same fields and only the title/primary label change). The page
 * owns the draft and the request; this component owns field validation, focus,
 * `Esc` and `⌘↵`, so a failed Host write can be shown without losing the input.
 *
 * It never invents data: no source id, no env id and no branch are minted here.
 */

const FIELD = "h-8 w-full min-w-0 rounded-[5px] border border-line bg-paper px-2.5 text-[12px] text-ink outline-none focus:border-accent";
const LABEL = "flex flex-col gap-1 text-[11px] font-semibold text-ink";
const HINT = "text-[10px] text-muted";
const KBD = "rounded-[3px] border border-line bg-bg px-1.5 py-0.5 font-mono text-[10px] text-muted";
const ADD = "inline-flex h-6 items-center gap-1 rounded-[4px] px-2 text-[10px] font-semibold";

type RowKind = "repositories" | "directories";
const ROW_LABEL: Record<RowKind, string> = { repositories: "仓库", directories: "目录" };
const ROW_TITLE: Record<RowKind, string> = { repositories: "Git 仓库", directories: "普通目录" };

function sourceErrors(rows: ProjectInput["repositories"], kind: RowKind): Record<number, string> {
  const errors: Record<number, string> = {};
  rows.forEach((row, index) => {
    const where = `${ROW_LABEL[kind]} ${index + 1}`;
    if (!row.name.trim() || !row.path.trim()) errors[index] = `${where}：请填写名称和以 / 开头的本机绝对路径`;
    else if (!/^(?:\/|[A-Za-z]:[\\/])/.test(row.path)) errors[index] = `${where}：请填写名称和以 / 开头的本机绝对路径`;
  });
  return errors;
}
function environmentErrors(rows: ProjectInput["environment"]): Record<number, string> {
  const errors: Record<number, string> = {};
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    // [Pencil T09] #144: the same reserved/credential refusals main enforces.
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.key)) {
      errors[index] = `环境变量 ${index + 1}：名称只能包含字母、数字或下划线，且不能以数字开头`;
      return;
    }
    if (seen.has(row.key)) {
      errors[index] = `环境变量 ${index + 1}：名称重复（${row.key}）`;
      return;
    }
    seen.add(row.key);
    const refusal = variableInputError(row.key, row.value);
    if (refusal !== null) errors[index] = `环境变量 ${index + 1}：${refusal}`;
  });
  return errors;
}

function FieldError({ children }: { children: ReactNode }) {
  return <p role="alert" className="text-[10px] text-destructive">{children}</p>;
}

export function DesktopWorkspaceDialog({
  mode,
  draft,
  onChange,
  onCancel,
  onSubmit,
  busy,
  error,
  saveDisabled,
  sourceStatus,
  focusSourceId,
}: {
  mode: "create" | "edit";
  draft: ProjectInput;
  onChange: (next: ProjectInput) => void;
  onCancel: () => void;
  onSubmit: () => void;
  busy: boolean;
  /** A Host refusal; shown here so the typed values stay put for a retry. */
  error?: string | null;
  saveDisabled?: boolean;
  /** Per-source verification, keyed by main's source id. A row with no entry is unverified. */
  sourceStatus?: Record<string, SourceVerification>;
  /** The S07 修复路径 target: the row whose path input must take focus on open. */
  focusSourceId?: string | null;
}) {
  const [attempted, setAttempted] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const pathRefs = useRef<Record<string, HTMLInputElement | null>>({});
  // Read once: the repair target is chosen when the dialog opens, not on every render.
  const openFocus = useRef(focusSourceId ?? null);
  const title = mode === "create" ? "新建工作空间" : "编辑工作空间";
  const sourceLabel = "关联 Git 仓库与目录 *";

  const nameError = draft.name.trim() ? "" : "请填写工作空间名称";
  const templateError = draft.branchTemplate.trim() ? "" : "请填写分支模板";
  const repositoryErrors = sourceErrors(draft.repositories, "repositories");
  const directoryErrors = sourceErrors(draft.directories, "directories");
  const variableErrors = environmentErrors(draft.environment);
  const noSources = draft.repositories.length + draft.directories.length === 0 ? "请至少登记一个 Git 仓库或普通目录" : "";
  const invalid = Boolean(nameError || templateError || noSources) ||
    Object.keys(repositoryErrors).length > 0 || Object.keys(directoryErrors).length > 0 || Object.keys(variableErrors).length > 0;

  const submit = useCallback(() => {
    setAttempted(true);
    if (invalid || busy || saveDisabled) {
      nameRef.current?.focus();
      return;
    }
    onSubmit();
  }, [busy, invalid, onSubmit, saveDisabled]);

  // Initial focus and focus restoration: a dialog that drops the keyboard user's
  // place is a regression at 720×560 as much as at 1440×900.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // A repair that lands on the name field makes the user hunt for the row again.
    const repair = openFocus.current ? pathRefs.current[openFocus.current] : null;
    const focusInside = () => {
      const preferred = repair ?? nameRef.current;
      (preferred && !preferred.matches(":disabled") ? preferred : dialogRef.current)?.focus();
    };
    focusInside();
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialogRef.current?.contains(event.target)) focusInside();
    };
    document.addEventListener("focusin", containFocus);
    return () => { document.removeEventListener("focusin", containFocus); if (opener && document.contains(opener)) opener.focus(); };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (busy) return;
      if (event.key === "Escape") { event.preventDefault(); onCancel(); return; }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel, submit]);

  // Focus trap: Tab/Shift+Tab cycle inside the dialog only.
  const trap = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])");
    if (!focusable || focusable.length === 0) { event.preventDefault(); dialogRef.current?.focus(); return; }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const updateRows = (kind: RowKind, rows: ProjectInput["repositories"]) => onChange({ ...draft, [kind]: rows });
  const rows = (kind: RowKind, values: ProjectInput["repositories"], errors: Record<number, string>) => (
    <div className="flex flex-col gap-1.5">
      {values.map((row, index) => {
        const status = row.id === undefined ? undefined : sourceStatus?.[row.id];
        return <div key={row.id ?? `${kind}-${index}`} className="rounded-[5px] border border-line bg-paper px-2.5 py-1.5">
          <div className="creation-source-fields flex items-center gap-2">
            <Icon name={kind === "repositories" ? "branch" : "folder"} className="shrink-0 text-muted" />
            <input aria-label={`${ROW_LABEL[kind]}名称 ${index + 1}`} className={FIELD} placeholder={`${ROW_TITLE[kind]}名称`}
              value={row.name} maxLength={256} disabled={busy}
              onChange={(event) => updateRows(kind, values.map((item, at) => at === index ? { ...item, name: event.target.value } : item))} />
            <input aria-label={`${ROW_LABEL[kind]}路径 ${index + 1}`} className={`${FIELD} font-mono text-[11px]`} placeholder="本机绝对路径"
              value={row.path} disabled={busy}
              ref={(element) => { pathRefs.current[row.id ?? `${kind}-${index}`] = element; }}
              onChange={(event) => updateRows(kind, values.map((item, at) => at === index ? { ...item, path: event.target.value } : item))} />
            {status?.status === "ok" ? <Badge variant="soft" className="shrink-0">路径可用</Badge> : null}
            {status?.status === "not-directory" ? <Badge variant="soft" className="shrink-0 text-attention">不是目录</Badge> : null}
            {status?.status === "missing" ? <>
              <Badge variant="soft" className="shrink-0 text-attention">来源缺失</Badge>
              <Button type="button" size="sm" variant="outline" disabled={busy}
                onClick={() => pathRefs.current[row.id ?? `${kind}-${index}`]?.focus()}>修复路径</Button>
            </> : null}
            <Button type="button" size="icon-sm" variant="ghost" aria-label={`移除${ROW_LABEL[kind]} ${index + 1}`}
              title={`移除${ROW_LABEL[kind]}`} disabled={busy}
              onClick={() => updateRows(kind, values.filter((_, at) => at !== index))}>
              <Icon name="close" />
            </Button>
          </div>
          {attempted && errors[index] ? <FieldError>{errors[index]}</FieldError> : null}
          {status?.status === "missing" && status.error ? <p className={HINT}>系统返回 {status.error}，请确认路径后重试</p> : null}
        </div>;
      })}
    </div>
  );

  return (
    <div role="presentation" onClick={() => { if (!busy) onCancel(); }}
      className="creation-backdrop">
      <div role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={dialogRef} onKeyDown={trap}
        onClick={(event) => event.stopPropagation()}
        className="creation-dialog creation-workspace-dialog">
        <header className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 gap-2.5">
            <span aria-hidden className="grid size-[30px] shrink-0 place-items-center rounded-[6px] bg-soft text-accent">
              <Icon name="branch" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[16px] font-semibold tracking-[-0.2px] text-ink">{title}</h2>
              <p className="mt-0.5 text-[11px] text-muted">聚合多 Git 仓库与目录资产，保存共享环境变量与统一远程分支模板</p>
            </div>
          </div>
          <span className={KBD} aria-hidden>Esc</span>
        </header>

        {error ? <p role="alert" className="mt-3 rounded-[5px] border border-destructive bg-paper px-2.5 py-1.5 text-[11px] text-destructive">{error}</p> : null}

        <fieldset disabled={busy} className="mt-4 flex flex-col gap-3.5 border-0 p-0">
          <div className="flex flex-wrap gap-3.5">
            <label className={`${LABEL} w-[280px] max-w-full`} htmlFor="workspace-name">工作空间名称 *
              <input id="workspace-name" ref={nameRef} aria-label="工作空间名称 *" className={FIELD} value={draft.name}
                maxLength={256} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
              {attempted && nameError ? <FieldError>{nameError}</FieldError> : null}
            </label>
            <label className={`${LABEL} min-w-[220px] flex-1`} htmlFor="workspace-description">描述与业务用途
              <input id="workspace-description" aria-label="描述与业务用途" className={FIELD} value={draft.description}
                maxLength={256} onChange={(event) => onChange({ ...draft, description: event.target.value })} />
            </label>
          </div>

          <section className="flex flex-col gap-1.5" aria-label={sourceLabel}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[11px] font-semibold text-ink">{sourceLabel}</h3>
              <div className="flex gap-1.5">
                <Button type="button" size="sm" variant="outline" className={ADD}
                  onClick={() => updateRows("repositories", [...draft.repositories, { name: "", path: "" }])}>
                  <Icon name="plus" />添加 Git 仓库
                </Button>
                <Button type="button" size="sm" variant="outline" className={ADD}
                  onClick={() => updateRows("directories", [...draft.directories, { name: "", path: "" }])}>
                  <Icon name="plus" />添加普通目录
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-1.5 rounded-[6px] border border-line bg-bg p-2">
              {rows("repositories", draft.repositories, repositoryErrors)}
              {rows("directories", draft.directories, directoryErrors)}
              {draft.repositories.length + draft.directories.length === 0
                ? <p className={HINT}>尚未登记来源。下属任务只能从这里登记的 Git 仓库与目录中选择。</p> : null}
              {attempted && noSources ? <FieldError>{noSources}</FieldError> : null}
            </div>
          </section>

          <div className="flex flex-wrap gap-3.5">
            <div role="group" aria-label="工作空间全局环境变量 *" className="flex min-w-[260px] flex-1 flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[11px] font-semibold text-ink">工作空间全局环境变量 *</h3>
                <Button type="button" size="sm" variant="ghost" className={ADD} disabled={busy}
                  onClick={() => onChange({ ...draft, environment: [...draft.environment, { key: "", value: "" }] })}>
                  <Icon name="plus" />添加变量
                </Button>
              </div>
              <div className="flex flex-col gap-1.5 rounded-[5px] border border-line bg-bg p-2">
                {draft.environment.length === 0 ? <p className={HINT}>尚未添加变量。</p> : null}
                {draft.environment.map((row, index) => <div key={`env-${index}`}>
                  <div className="flex items-center gap-1.5">
                    <input aria-label={`环境变量名 ${index + 1}`} className={`${FIELD} font-mono text-[11px]`} placeholder="KEY"
                      value={row.key} disabled={busy}
                      onChange={(event) => onChange({ ...draft, environment: draft.environment.map((item, at) => at === index ? { ...item, key: event.target.value } : item) })} />
                    <input aria-label={`环境变量值 ${index + 1}`} className={`${FIELD} font-mono text-[11px]`} placeholder="value"
                      value={row.value} disabled={busy}
                      onChange={(event) => onChange({ ...draft, environment: draft.environment.map((item, at) => at === index ? { ...item, value: event.target.value } : item) })} />
                    <Button type="button" size="icon-sm" variant="ghost" aria-label={`移除变量 ${index + 1}`} disabled={busy}
                      onClick={() => onChange({ ...draft, environment: draft.environment.filter((_, at) => at !== index) })}>
                      <Icon name="close" />
                    </Button>
                  </div>
                  {attempted && variableErrors[index] ? <FieldError>{variableErrors[index]}</FieldError> : null}
                </div>)}
                <p className={HINT}>下属任务默认继承这些共享变量；可在任务事实中逐键覆盖。私有凭据不在此处保存。</p>
              </div>
            </div>

            <div className="flex min-w-[260px] flex-1 flex-col gap-1.5">
              <h3 className="text-[11px] font-semibold text-ink">Git 远程分支模板 *</h3>
              <div className="flex flex-col gap-1.5 rounded-[5px] border border-line bg-bg p-2">
                <label className="flex items-center gap-2 text-[10px] text-muted" htmlFor="workspace-branch-template">模板
                  <input id="workspace-branch-template" aria-label="Git 远程分支模板 *"
                    className={`${FIELD} max-w-[240px] font-mono text-[11px]`} value={draft.branchTemplate} maxLength={128}
                    onChange={(event) => onChange({ ...draft, branchTemplate: event.target.value })} />
                </label>
                {attempted && templateError ? <FieldError>{templateError}</FieldError> : null}
                <p className={HINT}>工作空间分支约定（标记 {BRANCH_TEMPLATE_TOKEN}）；创建任务时在交付设置中核对实际分支与推送目标，推送仍需明确操作。</p>
              </div>
            </div>
          </div>
        </fieldset>

        <footer className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <p className="text-[10px] text-muted">保存后即可在侧栏展开该工作空间，随时启动多任务与多会话。</p>
          <div className="flex gap-2">
            <Button type="button" onClick={onCancel} disabled={busy}>取消</Button>
            <Button type="button" variant="default" onClick={submit} disabled={busy || saveDisabled} aria-keyshortcuts="Meta+Enter Control+Enter">
              {mode === "create" ? "创建工作区并保存配置" : "保存更改"}<span className={KBD} aria-hidden>⌘↵</span>
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
