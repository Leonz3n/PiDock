import { createPortal } from "react-dom";
import { Field, FieldGroup, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type MutableRefObject } from "react";
import { cn } from "../lib/utils";
import { Icon } from "./Icon";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  CREDENTIAL_TEXT,
  COST_FIELDS,
  COST_LABELS,
  EMPTY_COST,
  EMPTY_PROVIDER_DRAFT,
  LEVEL_TEXT,
  NATIVE_STATE_TEXT,
  PROVIDER_PROTOCOLS,
  PROVIDER_STATE_TEXT,
  REASONING_LEVELS,
  defaultThinkingLevel,
  discoveryMisses,
  draftFromView,
  draftIssues,
  draftRequest,
  parseDiscovery,
  parseProbe,
  parseSaved,
  providerCall,
  type DiscoveryRead,
  type FieldIssue,
  type ProviderDraft,
  type ProviderStatus,
  type ProviderView,
  type ProbeResult,
  type Row,
} from "../data/providerProfile";

/**
 * [PiDock T03] #138 S03 / S03B — the Provider list and its full-area form.
 *
 * S03 (list) and S03B (add/edit) are two states of the same pane, not a modal:
 * the form replaces the list area and keeps the same navigation. Every value
 * shown here came from main's `list`/`save` reply; there is no fixture
 * fallback, and the API key has no read path at all — the field starts empty
 * and only travels in the one `save` request that sets it.
 */

const field = "capability-input min-w-0 w-full";
const mono = "font-mono text-[11px] break-all";

/** Presets only fill the form; the protocol is always the one shown in the select. */
type Preset = { key: string; name: string; notes: string; protocol: string; baseUrl: string; models: Row[] };
const emptyRow = (): Row => ({ ...EMPTY_PROVIDER_DRAFT.models[0]!, cost: { ...EMPTY_COST } });
const presetRow = (id: string, reasoning = false, levels: string[] = []): Row =>
  ({ id, name: id, contextWindow: "128000", maxTokens: "8192", reasoning, levels, cost: { ...EMPTY_COST } });
const PRESETS: Preset[] = [
  { key: "deepseek", name: "DeepSeek", notes: "OpenAI 兼容端点 · 官方预设", protocol: "openai-completions", baseUrl: "https://api.deepseek.com/v1",
    models: [presetRow("deepseek-chat"), presetRow("deepseek-reasoner", true, ["low", "medium", "high"])] },
  { key: "openai", name: "OpenAI", notes: "官方预设 · Chat Completions", protocol: "openai-completions", baseUrl: "https://api.openai.com/v1",
    models: [presetRow("gpt-5-mini"), presetRow("gpt-5")] },
  { key: "anthropic", name: "Anthropic", notes: "官方预设 · Messages 协议", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com",
    models: [presetRow("claude-sonnet-4-5")] },
  { key: "local", name: "本机兼容端点", notes: "本地推理服务 · 端口与协议请核对", protocol: "openai-completions", baseUrl: "http://127.0.0.1:8080/v1",
    models: [presetRow("local-model")] },
];

const protocolLabel = (protocol: string) => PROVIDER_PROTOCOLS.find((item) => item.id === protocol)?.label ?? protocol;
const levelText = (level: string) => LEVEL_TEXT[level] ?? level;

export function DesktopProvidersPanel({
  headerSlot,
  taskId,
  taskName,
  status,
  error,
  onReload,
  onBack,
}: {
  headerSlot?: HTMLElement | null;
  taskId: string | null;
  taskName: string | null;
  status: ProviderStatus | null;
  /** A read/act failure from the page (already bounded text). */
  error: string;
  /** Re-read the list after a write or a refused act. */
  onReload: () => Promise<void>;
  /** Esc with no form open leaves 能力管理. */
  onBack: () => void;
}) {
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [presetKey, setPresetKey] = useState<string | null>(null);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<DiscoveryRead | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [conflict, setConflict] = useState<{ state: string; draft: ProviderDraft } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  /** Set when the list already names an external edit: deleting needs a second, explicit act. */
  const [deleteConflict, setDeleteConflict] = useState<{ id: string; state: string } | null>(null);
  /** The model/level the user picked per profile, before 选用 is pressed. */
  const [choice, setChoice] = useState<Record<string, { modelId: string; level: string }>>({});
  const formRef = useRef<HTMLFormElement | null>(null);
  // Reentrancy guard: `busy` is React state, so two handlers firing in the same
  // event (the window shortcut and the form's own ⌘↵) would both see `false`
  // and send two `save` requests. A ref flips synchronously.
  const busyRef = useRef(false);

  const occupied = useMemo(() => new Set((status?.profiles ?? []).map((view) => view.baseUrl)), [status]);
  const issueFor = (name: string) => issues.find((issue) => issue.field === name)?.message;
  const patch = (changes: Partial<ProviderDraft>) => setDraft((current) => current === null ? current : { ...current, ...changes });
  const patchRow = (index: number, changes: Partial<Row>) =>
    setDraft((current) => current === null ? current : { ...current, models: current.models.map((row, at) => at === index ? { ...row, ...changes } : row) });

  const applyPreset = (preset: Preset) => {
    setPresetKey(preset.key);
    setDraft((current) => ({
      ...(current ?? EMPTY_PROVIDER_DRAFT),
      name: preset.name, notes: preset.notes, protocol: preset.protocol as ProviderDraft["protocol"], baseUrl: preset.baseUrl,
      models: preset.models.map((row) => ({ ...row, cost: { ...row.cost } })), modelId: preset.models[0]?.id ?? "",
    }));
    setIssues([]);
  };

  const openCreate = () => {
    setDraft({ ...EMPTY_PROVIDER_DRAFT, models: [emptyRow()] });
    setPresetKey(null);
    setIssues([]); setDiscovery(null); setProbe(null); setConflict(null); setNotice(""); setShowKey(false);
  };
  const openEdit = (view: ProviderView) => {
    setDraft(draftFromView(view));
    setPresetKey(null);
    setIssues([]); setDiscovery(null); setProbe(null); setConflict(null); setNotice(""); setShowKey(false);
  };
  const closeForm = () => {
    setDraft(null); setPresetKey(null); setIssues([]); setDiscovery(null); setProbe(null); setConflict(null); setNotice(""); setShowKey(false);
  };

  // Esc closes the form; with no form it leaves the page (the prototype's
  // "返回保留任务上下文"). Cmd/Ctrl+Enter is the form's save shortcut.
  useEffect(() => {
    if (draft === null) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeForm(); }
      else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => {
    if (draft !== null) return;
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onBack(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, onBack]);

  const save = async (current: ProviderDraft, reconcile: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      // A defining edit changes what Pi is told; the reply carries the new
      // status, so the list does not need a second read to be honest.
      const request = draftRequest(current);
      const payload = parseSaved(await providerCall({ op: "save", ...request, ...(reconcile ? { reconcile: true } : {}) }));
      if (!payload.written) {
        // A managed entry edited outside PiDock is named and left untouched.
        setConflict({ state: payload.conflict ?? "modified", draft: current });
        setNotice("");
        return;
      }
      setConflict(null);
      setNotice(`已写入 models.json：pidock-${payload.profile.id}`);
      closeForm();
      await onReload();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Provider 保存失败");
    } finally { busyRef.current = false; setBusy(false); }
  };

  function submit() {
    if (draft === null || busyRef.current) return;
    const found = draftIssues(draft, status?.profiles ?? []);
    setIssues(found);
    if (found.length > 0) { formRef.current?.querySelector<HTMLElement>("[data-invalid='true']")?.focus(); return; }
    void save(draft, false);
  }

  const discover = async () => {
    if (draft === null || busy) return;
    setBusy(true);
    setDiscovery(null);
    setDiscovering(true);
    try {
      const payload = parseDiscovery(await providerCall({
        op: "discover", protocol: draft.protocol, baseUrl: draft.baseUrl.trim(),
        ...(draft.id === undefined ? {} : { profileId: draft.id }),
        ...(draft.apiKey.length > 0 ? { apiKey: draft.apiKey } : {}),
      }));
      setDiscovery(payload);
    } catch (caught) {
      // Not a main status: the attempt never produced one (bridge refusal or a
      // payload outside the four-status contract). Kept distinct from `failure`.
      setDiscovery({ status: "refused", candidates: [], message: caught instanceof Error ? caught.message : "模型列表获取失败" });
    } finally { setBusy(false); setDiscovering(false); }
  };

  const testConnection = async () => {
    if (draft === null || busy) return;
    setBusy(true);
    setProbe(null);
    try {
      setProbe(parseProbe(await providerCall({
        op: "probe", protocol: draft.protocol, baseUrl: draft.baseUrl.trim(), modelId: draft.modelId.trim(),
        ...(draft.id === undefined ? {} : { profileId: draft.id }),
        ...(draft.apiKey.length > 0 ? { apiKey: draft.apiKey } : {}),
      })));
    } catch (caught) {
      setProbe({ ok: false, code: "refused", message: caught instanceof Error ? caught.message : "连通性测试失败", status: null, latencyMs: null });
    } finally { setBusy(false); }
  };

  const act = async (request: Record<string, unknown>, failure: string) => {
    setBusy(true);
    try {
      await providerCall(request);
      setNotice("");
      await onReload();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : failure);
      await onReload();
    } finally { setBusy(false); }
  };

  /**
   * Deleting destroys the managed entry — including a version someone edited in
   * `models.json` — so an externally changed/removed entry is named and needs a
   * second, explicit act (main refuses it without `reconcile` anyway).
   */
  const requestDelete = (view: ProviderView) => {
    setDeleteConflict(null);
    if (view.native.state === "modified" || view.native.state === "removed") {
      setDeleteConflict({ id: view.id, state: view.native.state });
      setPendingDelete(null);
      return;
    }
    setPendingDelete(view.id);
  };
  const confirmDelete = async (view: ProviderView, reconcile: boolean) => {
    await act({ op: "remove", profileId: view.id, ...(taskId === null ? {} : { taskId }), ...(reconcile ? { reconcile: true } : {}) }, "Provider 删除失败");
    setPendingDelete(null);
    setDeleteConflict(null);
  };

  if (draft !== null) return <ProviderForm
    headerSlot={headerSlot} discovering={discovering} draft={draft} presetKey={presetKey} issues={issues} notice={notice} conflict={conflict} busy={busy} showKey={showKey}
    discovery={discovery} probe={probe} formRef={formRef} issueFor={issueFor}
    onPatch={patch} onPatchRow={patchRow} onApplyPreset={applyPreset} onToggleReasoning={(index, reasoning) => patchRow(index, {
      // A newly declared reasoning model declares 关闭 first and nothing else
      // until the user ticks the levels the endpoint documents.
      reasoning, levels: reasoning ? (draft.models[index]?.levels.length ? draft.models[index]!.levels : ["off"]) : [],
    })} onToggleLevel={(index, level) => {
      const row = draft.models[index];
      if (!row) return;
      patchRow(index, { levels: row.levels.includes(level) ? row.levels.filter((item) => item !== level) : [...row.levels, level] });
    }}
    onAddRow={() => setDraft((current) => current === null ? current : { ...current, models: [...current.models, emptyRow()] })}
    onRemoveRow={(index) => setDraft((current) => {
      if (current === null) return current;
      const models = current.models.filter((_row, at) => at !== index);
      return { ...current, models, modelId: models.some((row) => row.id.trim() === current.modelId) ? current.modelId : (models[0]?.id ?? "") };
    })}
    onAddCandidate={(id) => {
      setDraft((current) => {
        if (current === null || current.models.some((row) => row.id === id)) return current;
        return { ...current, models: [...current.models, { ...emptyRow(), id, name: id }],
          modelId: current.modelId === "" ? id : current.modelId };
      });
    }}
    onToggleKey={() => setShowKey((shown) => !shown)}
    onDiscover={() => void discover()} onProbe={() => void testConnection()}
    onSubmit={() => submit()} onCancel={closeForm}
    onReconcile={() => { if (conflict) void save({ ...conflict.draft }, true); }}
  />;

  return <>
    {headerSlot ? createPortal(<><span>模型服务 (Providers)</span><span className="ml-3 truncate text-[11px] font-normal text-muted">管理与配置 Pi Agent 模型服务商与 API Key</span></>, headerSlot) : null}
    <div data-testid="providers-panel" className="min-w-0">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-[18px] font-semibold text-ink">Pi 供应商列表 <span className="text-[11px] font-normal text-muted">（共 {status?.profiles.length ?? "—"} 个配置项）</span></h2>
      <div className="flex items-center gap-3">
        <input type="search" aria-label="搜索供应商 / 模型名称" placeholder="搜索供应商 / 模型名称…" className="capability-input w-[240px] below-narrow:w-[180px]" value={query} onChange={(event) => setQuery(event.target.value)} />
        <Button type="button" onClick={openCreate}><span aria-hidden>＋</span>添加供应商</Button>
      </div>
      <span data-testid="providers-state" className="sr-only">{status ? PROVIDER_STATE_TEXT[status.state] : error ? "读取失败" : "读取中…"}</span>
    </div>

    {error ? <p role="alert" className="mt-3 border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p> : null}
    {notice ? <p role="status" className="mt-3 text-[11px] text-muted">{notice}</p> : null}

    {taskId === null ? <p data-testid="providers-task-required" className="mt-3 text-[11px] text-muted">
      尚未打开任务：打开任务后可选用模型；配置保存至本机，密钥不回显。
    </p> : <p className="mt-3 text-[11px] text-muted">当前任务：{taskName ?? taskId} · 选用只影响这个任务的会话</p>}

    <section className="mt-5" aria-label="已添加">
      <h2 className="text-xs font-semibold text-muted">已添加 · {status?.profiles.length ?? "—"}</h2>
      {status === null
        ? <p className="mt-2 text-xs text-muted">{error ? "配置不可用，请检查文件后重试。" : "正在读取本机 Provider 配置…"}</p>
        : status.profiles.length === 0
          ? <p data-testid="providers-empty" className="mt-2 border border-line bg-paper px-4 py-8 text-center text-xs leading-6 text-muted">
            还没有 Provider。添加一份真实端点后，它会同时出现在这里与 Pi 的 models.json 中。
          </p>
          : <ul className="mt-2 flex flex-col gap-2">{status.profiles.filter((view) => `${view.name} ${view.models.map((model) => `${model.id} ${model.name}`).join(" ")}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map((view) => {
              // The level shown is the one a 选用 would send: the user's pick, or
              // main's own default (`high` when declared) — never a guess and
              // never silently the weakest tier.
              const chosenModelId = choice[view.id]?.modelId ?? view.modelId;
              const chosen = view.models.find((model) => model.id === chosenModelId) ?? view.models[0]!;
              const defaultLevel = defaultThinkingLevel(chosen.reasoningLevels);
              const level = choice[view.id]?.level ?? defaultLevel ?? "";
              const chosenLevel = chosen.reasoningLevels.includes(level) ? level : defaultLevel;
              const isCurrent = status.profileId === view.id && status.state !== "not-configured";
              return <li key={view.id}
              data-testid={`provider-card-${view.id}`} data-selected={isCurrent} className={cn("provider-row rounded-lg border border-line bg-paper px-4 py-3", isCurrent && "border-accent")}>
            <div className="flex min-w-0 items-center gap-3">
            <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-md bg-soft", isCurrent && "text-accent")}><Icon name="server" /></span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-sm font-medium text-ink">{view.name}</strong>
                {isCurrent ? <Badge variant="accent">当前任务已选用</Badge> : null}
                <span className="truncate text-[10px] text-muted">{view.models.length} 个模型 · {view.models.map((model) => model.id).join("、")}</span>
              </div>
              <p className="truncate font-mono text-[10px] text-muted" title={view.baseUrl}>{view.baseUrl}</p>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => openEdit(view)}>编辑</Button>
            </div>
            <details className="provider-details mt-1">
              <summary className="cursor-pointer text-[10px] text-muted">模型选择与配置操作</summary>
              <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-muted">
                <Badge variant="soft">{protocolLabel(view.protocol)}</Badge>
                <Badge variant="soft">{CREDENTIAL_TEXT[view.credentialSource]}</Badge>
                <Badge variant="outline">{view.credentialAvailable ? "密钥可用" : "密钥缺失"}</Badge>
                <span>{NATIVE_STATE_TEXT[view.native.state]}</span>
                {isCurrent ? <span data-testid={`provider-current-${view.id}`}>当前任务已选用 · {status.modelId} · 推理 {status.thinkingLevel ? levelText(status.thinkingLevel) : "无"}</span> : null}
              </div>
              {view.notes ? <p className="mt-1 text-[11px] text-muted">{view.notes}</p> : null}
              <p className="mt-1 flex flex-wrap gap-1 text-[11px] text-muted">
                {view.models.slice(0, 4).map((model) => <span key={model.id} className="border border-line px-1.5">
                  {model.id}{model.reasoning ? " · 推理" : ""}{
                    model.reasoning && model.reasoningLevels.length === 0 ? " · 无可用档位" : ""}{
                    model.cost === null ? "" : " · 已声明价格"}
                </span>)}
                {view.models.length > 4 ? <span>+{view.models.length - 4}</span> : null}
              </p>
              <p className="mt-1 text-[10px] text-muted">默认模型：{view.modelId} · 上下文 {view.contextWindow.toLocaleString("en-US")} tokens · 最大输出 {view.maxTokens.toLocaleString("en-US")} · 默认推理档位：{defaultThinkingLevel(view.models.find((model) => model.id === view.modelId)?.reasoningLevels ?? []) === null ? "无可用档位" : levelText(defaultThinkingLevel(view.models.find((model) => model.id === view.modelId)?.reasoningLevels ?? [])!)}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select aria-label={`选用模型（${view.name}）`} className={field} value={chosenModelId}
                onChange={(event) => {
                  const model = view.models.find((row) => row.id === event.target.value);
                  setChoice((current) => ({ ...current, [view.id]: {
                    modelId: event.target.value,
                    level: defaultThinkingLevel(model?.reasoningLevels ?? []) ?? "",
                  } }));
                }}>
                {view.models.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
              </select>
              {chosen.reasoningLevels.length === 0
                ? <span data-testid={`provider-levels-missing-${view.id}`} className="text-[10px] text-destructive">无可用档位</span>
                : <select aria-label={`推理档位（${view.name}）`} className={field} value={chosenLevel ?? ""}
                    onChange={(event) => setChoice((current) => ({ ...current, [view.id]: { modelId: chosenModelId, level: event.target.value } }))}>
                    {chosen.reasoningLevels.map((option) => <option key={option} value={option}>{levelText(option)}</option>)}
                  </select>}
              <Button type="button" disabled={busy || taskId === null || chosen.reasoningLevels.length === 0}
                title={taskId === null ? "请先打开一个任务" : chosen.reasoningLevels.length === 0 ? "这个模型没有可用推理档位，无法选用" : undefined}
                onClick={() => void act({ op: "select", ...(taskId === null ? {} : { taskId }), profileId: view.id, modelId: chosenModelId,
                  ...(chosenLevel === null ? {} : { thinkingLevel: chosenLevel }) }, "Provider 选用失败")}>
                选用
              </Button>
              {pendingDelete === view.id
                ? <>
                  <Button type="button" disabled={busy} onClick={() => void confirmDelete(view, false)}>确认删除</Button>
                  <Button type="button" onClick={() => setPendingDelete(null)}>取消</Button>
                </>
                : <Button type="button" onClick={() => requestDelete(view)}>删除</Button>}
            </div>
            {deleteConflict?.id === view.id ? <div role="alert" className="mt-2 basis-full border border-attention/40 bg-attention-soft px-3 py-2 text-[11px] text-attention">
              <p>models.json 里的 <code className={mono}>pidock-{view.id}</code> 已被外部{NATIVE_STATE_TEXT[deleteConflict.state as keyof typeof NATIVE_STATE_TEXT] ?? "修改"}：
                确认删除会连同外部版本一起移除。</p>
              <div className="mt-2 flex gap-2">
                <Button type="button" disabled={busy} onClick={() => void confirmDelete(view, true)}>确认删除外部版本</Button>
                <Button type="button" onClick={() => setDeleteConflict(null)}>保留它</Button>
              </div>
            </div> : null}
            </details>
          </li>; })}</ul>}
      {status && status.profiles.length > 0 && !status.profiles.some((view) => `${view.name} ${view.models.map((model) => `${model.id} ${model.name}`).join(" ")}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ? <p className="py-6 text-xs text-muted">没有匹配的供应商</p> : null}
    </section>

    <section className="mt-6" aria-label="可添加">
      <h2 className="text-xs font-semibold text-muted">可添加 · 预设</h2>
      <p className="mt-1 text-[11px] text-muted">预设填入地址、协议与模型，保存前可修改。</p>
      <ul className="mt-2 flex flex-col gap-2">{PRESETS.filter((preset) => !occupied.has(preset.baseUrl)).map((preset) =>
        <li key={preset.key} className="flex min-h-[62px] flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-paper px-4 py-2">
          <span className="min-w-0"><strong className="text-xs font-medium">{preset.name}</strong>
            <span className={`mt-0.5 block text-muted ${mono}`}>{preset.baseUrl}</span></span>
          <Button type="button" onClick={() => applyPreset(preset)}>激活</Button>
        </li>)}</ul>
    </section>
  </div></>;
}

function ProviderForm({
  headerSlot, discovering, draft, presetKey, issues, notice, conflict, busy, showKey, discovery, probe, formRef, issueFor,
  onPatch, onPatchRow, onApplyPreset, onToggleReasoning, onToggleLevel, onAddRow, onRemoveRow, onAddCandidate,
  onToggleKey, onDiscover, onProbe, onSubmit, onCancel, onReconcile,
}: {
  headerSlot?: HTMLElement | null; discovering: boolean;
  draft: ProviderDraft; presetKey: string | null; issues: FieldIssue[]; notice: string;
  conflict: { state: string; draft: ProviderDraft } | null; busy: boolean; showKey: boolean;
  discovery: DiscoveryRead | null; probe: ProbeResult | null;
  formRef: MutableRefObject<HTMLFormElement | null>; issueFor: (name: string) => string | undefined;
  onPatch: (changes: Partial<ProviderDraft>) => void; onPatchRow: (index: number, changes: Partial<Row>) => void;
  onApplyPreset: (preset: Preset) => void; onToggleReasoning: (index: number, reasoning: boolean) => void;
  onToggleLevel: (index: number, level: string) => void;
  onAddRow: () => void; onRemoveRow: (index: number) => void; onAddCandidate: (id: string) => void;
  onToggleKey: () => void; onDiscover: () => void; onProbe: () => void; onSubmit: () => void;
  onCancel: () => void; onReconcile: () => void;
}) {
  const error = (name: string) => {
    const message = issueFor(name);
    return message ? <p className="mt-1 text-[10px] text-destructive">{message}</p> : null;
  };
  // Ids the last successful listing did not contain: informational only.
  const misses = discoveryMisses(draft, discovery);
  const nextPreset = () => {
    const at = PRESETS.findIndex((preset) => preset.key === presetKey);
    onApplyPreset(PRESETS[(at + 1) % PRESETS.length]!);
  };
  const submit = (event: FormEvent) => { event.preventDefault(); onSubmit(); };
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onSubmit(); }
  };
  const heading = <><Button type="button" size="sm" onClick={onCancel}>← 返回供应商列表 · Esc</Button><h2 className="ml-3 truncate text-[14px] font-semibold">{draft.id === undefined ? "添加供应商" : `编辑供应商：${draft.name}`}</h2><span className="ml-3 text-[11px] font-normal text-muted">写入 models.json</span></>;
  return <>
    {headerSlot ? createPortal(heading, headerSlot) : heading}
    <form ref={formRef} data-testid="provider-form" data-form-open="true" onSubmit={submit} onKeyDown={keys} className="provider-form min-w-0 rounded-lg border border-line bg-paper p-5">

    {presetKey === null ? <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-sidebar px-3 py-2">
      <p className="text-xs text-muted">手动配置协议、地址与模型，或使用供应商预设。</p>
      <Button type="button" onClick={nextPreset}>使用预设</Button>
    </div> : <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-sidebar px-3 py-2">
      <p className="text-xs text-muted">已载入预设 <strong>{PRESETS.find((preset) => preset.key === presetKey)?.name}</strong>：协议与地址已填入，仍可修改。</p>
      <div className="flex gap-2"><Button type="button" onClick={nextPreset}>更换预设</Button>
        <Button type="button" onClick={() => onPatch({ name: "", notes: "", baseUrl: "", models: [{ id: "", name: "", contextWindow: "128000", maxTokens: "8192", reasoning: false, levels: [], cost: { ...EMPTY_COST } }], modelId: "" })}>清空</Button></div>
    </div>}

    {notice ? <p role="alert" className="mt-3 border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{notice}</p> : null}
    {conflict ? <div role="alert" className="mt-3 border border-attention/40 bg-attention-soft px-3 py-2 text-xs text-attention">
      <p>models.json 里的 <code className={mono}>pidock-{conflict.draft.id}</code> 已被外部改动（{NATIVE_STATE_TEXT[conflict.state as keyof typeof NATIVE_STATE_TEXT] ?? "已修改"}），PiDock 没有覆盖它。</p>
      <div className="mt-2 flex gap-2"><Button type="button" disabled={busy} onClick={onReconcile}>用这份表单覆盖外部修改</Button>
        <Button type="button" onClick={onCancel}>保留外部版本</Button></div>
    </div> : null}

    <FieldGroup className="provider-fields mt-4 grid grid-cols-2 gap-x-4 gap-y-3 below-narrow:grid-cols-1">
      <Field data-invalid={Boolean(issueFor("name"))}>
        <FieldLabel htmlFor="provider-name">名称 *</FieldLabel>
        <Input id="provider-name" aria-label="名称" value={draft.name} aria-invalid={Boolean(issueFor("name"))} data-invalid={issueFor("name") ? "true" : undefined} onChange={(event) => onPatch({ name: event.target.value })} placeholder="例如 DeepSeek 官方" />{error("name")}
      </Field>
      <Field><FieldLabel htmlFor="provider-notes">备注（可选）</FieldLabel><Input id="provider-notes" aria-label="备注" value={draft.notes} onChange={(event) => onPatch({ notes: event.target.value })} />{error("notes")}</Field>
      <Field><FieldLabel htmlFor="provider-protocol">接口格式 *</FieldLabel>
        <select id="provider-protocol" aria-label="接口格式" className={field} value={draft.protocol} onChange={(event) => onPatch({ protocol: event.target.value as ProviderDraft["protocol"] })}>
          {PROVIDER_PROTOCOLS.map((protocol) => <option key={protocol.id} value={protocol.id}>{protocol.label}</option>)}
        </select>{error("protocol")}
      </Field>
      <Field data-invalid={Boolean(issueFor("baseUrl"))}><FieldLabel htmlFor="provider-base">Base URL *</FieldLabel>
        <Input id="provider-base" aria-label="Base URL" value={draft.baseUrl} aria-invalid={Boolean(issueFor("baseUrl"))} data-invalid={issueFor("baseUrl") ? "true" : undefined} onChange={(event) => onPatch({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" />{error("baseUrl")}
      </Field>
      <Field><FieldLabel htmlFor="credential-kind">凭据来源</FieldLabel><select id="credential-kind" className={field} value={draft.credentialKind} onChange={(event) => onPatch({ credentialKind: event.target.value === "env" ? "env" : "store" })}>
        <option value="store">密钥保存在本机（safeStorage 加密）</option><option value="env">从环境变量读取引用</option>
      </select></Field>
      {draft.credentialKind === "store" ? <Field data-invalid={Boolean(issueFor("apiKey"))}>
        <FieldLabel htmlFor="provider-key">API Key *</FieldLabel>
        <div className="flex gap-2"><Input id="provider-key" aria-label="API Key" type={showKey ? "text" : "password"} autoComplete="off" spellCheck={false} value={draft.apiKey} aria-invalid={Boolean(issueFor("apiKey"))} data-invalid={issueFor("apiKey") ? "true" : undefined} placeholder={draft.hasStoredKey ? "已保存的密钥不会显示；留空保留" : "sk-…"} onChange={(event) => onPatch({ apiKey: event.target.value })} />
        <Button type="button" onClick={onToggleKey} aria-label={showKey ? "隐藏密钥" : "显示密钥"}>{showKey ? "隐藏" : "显示"}</Button></div>{error("apiKey")}
        <p className="text-[10px] text-muted">{draft.hasStoredKey ? "已保存一份密钥：留空表示继续使用它。" : "密钥仅存本机加密存储，不回显。"}</p>
      </Field> : <Field data-invalid={Boolean(issueFor("authRef"))}><FieldLabel htmlFor="provider-env">环境变量名</FieldLabel>
        <Input id="provider-env" aria-label="环境变量名" value={draft.authRef} aria-invalid={Boolean(issueFor("authRef"))} data-invalid={issueFor("authRef") ? "true" : undefined} onChange={(event) => onPatch({ authRef: event.target.value })} />{error("authRef")}
      </Field>}
    </FieldGroup>

    <section className="mt-4" aria-label="模型">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-semibold text-muted">模型 · {draft.models.length}</h2>
        <label className="flex min-w-0 items-center gap-2 text-[10px] text-muted">默认模型<select aria-label="默认模型" className="capability-input max-w-[240px]" value={draft.modelId} onChange={(event) => onPatch({ modelId: event.target.value })}><option value="">请选择</option>{draft.models.filter((row) => row.id.trim() !== "").map((row) => <option key={row.id} value={row.id}>{row.id}</option>)}</select>{error("modelId")}</label>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={onAddRow}>手动添加</Button>
          <Button type="button" disabled={busy || draft.baseUrl.trim() === ""} onClick={onDiscover}>获取模型列表</Button>
        </div>
      </div>
      {error("models")}
      {discovering ? <p role="status" className="mt-2 text-[11px] text-muted">正在获取模型列表；已保留手动输入…</p> : null}
      {discovery ? <div className="mt-2 border border-line bg-soft px-3 py-2 text-[11px]">
        <p className="text-muted">{discovery.message}</p>
        {discovery.status === "success" ? <ul aria-label="可选模型" className="mt-2 flex flex-wrap gap-1">
          {discovery.candidates.map((id) => <li key={id}><button type="button" onClick={() => onAddCandidate(id)}
            className="border border-line bg-paper px-1.5 py-0.5 text-[11px] hover:bg-bg">＋ {id}</button></li>)}
        </ul> : null}
        {/* A miss is a note, not an error: a manually typed id stays saveable. */}
        {misses.length > 0 ? <p data-testid="discovery-misses" className="mt-2 text-muted">
          以下模型 ID 不在这次列表里，仍可手动保存：{misses.join("、")}
        </p> : null}
      </div> : null}
      <div className="mt-2 flex flex-col gap-2">
        {draft.models.map((row, index) => <div key={index} className="model-row rounded-md bg-sidebar p-3">
          <FieldGroup className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 below-narrow:grid-cols-1">
            <Field data-invalid={Boolean(issueFor(`models.${index}.id`))}><FieldLabel htmlFor={`model-id-${index}`}>模型 ID *（手动输入 + 下拉选择）</FieldLabel>
              <Input id={`model-id-${index}`} aria-label={`模型 ID ${index + 1}`} value={row.id} aria-invalid={Boolean(issueFor(`models.${index}.id`))} data-invalid={issueFor(`models.${index}.id`) ? "true" : undefined} onChange={(event) => onPatchRow(index, { id: event.target.value })} />{error(`models.${index}.id`)}
              {discovery?.status === "success" ? <select aria-label={`已发现模型 ${index + 1}`} className={field} value="" onChange={(event) => { if (event.target.value) onPatchRow(index, { id: event.target.value }); }}><option value="">下拉选择模型</option>{discovery.candidates.map((id) => <option key={id} value={id}>{id}</option>)}</select> : null}
            </Field>
            <Field><FieldLabel htmlFor={`model-name-${index}`}>显示名称</FieldLabel><Input id={`model-name-${index}`} aria-label={`显示名称 ${index + 1}`} value={row.name} onChange={(event) => onPatchRow(index, { name: event.target.value })} />{error(`models.${index}.name`)}</Field>
            <Field><FieldLabel htmlFor={`model-reasoning-${index}`}>思维链推理</FieldLabel><label className="flex h-8 items-center gap-2 text-[11px]"><input id={`model-reasoning-${index}`} type="checkbox" aria-label={`思维链推理 ${index + 1}`} checked={row.reasoning} onChange={(event) => onToggleReasoning(index, event.target.checked)} />{row.reasoning ? "开启" : "仅关闭"}</label>{error(`models.${index}.reasoning`)}
              {row.reasoning ? <div className="flex flex-wrap gap-1">{REASONING_LEVELS.map((level) => <label key={level} className={cn("cursor-pointer rounded border px-1 text-[10px]", row.levels.includes(level) ? "border-accent text-ink" : "border-line text-muted")}><input type="checkbox" className="sr-only" aria-label={`${levelText(level)}档位 ${index + 1}`} checked={row.levels.includes(level)} onChange={() => onToggleLevel(index, level)} />{levelText(level)}</label>)}{row.levels.length === 0 ? <p className="text-[10px] text-destructive">无可用档位</p> : null}</div> : null}
            </Field>
          </FieldGroup>
          <details className="mt-2"><summary className="cursor-pointer text-[10px] text-muted">窗口、输出与价格声明</summary>
            <FieldGroup className="mt-2 grid grid-cols-2 gap-3 below-narrow:grid-cols-1">
              <Field><FieldLabel htmlFor={`model-context-${index}`}>上下文窗口</FieldLabel><Input id={`model-context-${index}`} aria-label={`上下文窗口 ${index + 1}`} inputMode="numeric" value={row.contextWindow} onChange={(event) => onPatchRow(index, { contextWindow: event.target.value })} />{error(`models.${index}.contextWindow`)}</Field>
              <Field><FieldLabel htmlFor={`model-output-${index}`}>最大输出</FieldLabel><Input id={`model-output-${index}`} aria-label={`最大输出 ${index + 1}`} inputMode="numeric" value={row.maxTokens} onChange={(event) => onPatchRow(index, { maxTokens: event.target.value })} />{error(`models.${index}.maxTokens`)}</Field>
              {COST_FIELDS.map((key) => <Field key={key}><FieldLabel htmlFor={`cost-${index}-${key}`}>{COST_LABELS[key]}</FieldLabel><Input id={`cost-${index}-${key}`} aria-label={`${COST_LABELS[key]} ${index + 1}`} value={row.cost[key]} placeholder={COST_LABELS[key]} onChange={(event) => onPatchRow(index, { cost: { ...row.cost, [key]: event.target.value } })} /></Field>)}
            </FieldGroup>{error(`models.${index}.cost`)}
          </details>
          {draft.models.length > 1 ? <Button type="button" size="sm" variant="ghost" onClick={() => onRemoveRow(index)}>移除</Button> : null}
        </div>)}
      </div>
      <p className="mt-1 text-[10px] text-muted">窗口、推理与价格是本机声明；价格四项未填全则保持未知。模型 ID 可继续手动编辑。</p>

    </section>

    <section className="mt-4 flex flex-wrap items-start justify-between gap-3 border-t border-line pt-3">
      <div className="min-w-0">
        <Button type="button" disabled={busy || draft.baseUrl.trim() === "" || draft.modelId.trim() === ""} onClick={onProbe}>
          {busy ? "测试中…" : "测试连通性"}
        </Button>
        {probe ? <p data-testid="probe-result" className={`mt-1 text-[11px] ${probe.ok ? "text-ink" : "text-destructive"}`}>
          {probe.ok ? `连通 · ${probe.latencyMs ?? "?"} ms` : `失败 · ${probe.message}`}{probe.status === null ? "" : ` · HTTP ${probe.status}`}
        </p> : null}
      </div>
      <div className="flex gap-2">
        <Button type="button" variant="default" disabled={busy} onClick={onSubmit}>保存并写入 models.json</Button>
        <Button type="button" onClick={onCancel}>取消</Button>
      </div>
    </section>
    {issues.length > 0 ? <p role="alert" className="mt-2 text-[11px] text-destructive">
      还有 {issues.length} 项需要修正：{issues.slice(0, 3).map((issue) => issue.message).join("；")}
    </p> : null}
  </form></>;
}
