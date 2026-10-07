import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "./Icon";
import { loadDesktopProjects, type DesktopProjects } from "../data/desktopProjects";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { PROVIDER_STATE_TEXT, parseProviderStatus, providerCall, type ProviderStatus } from "../data/providerProfile";
import { SDK_SESSION_ID, parseSdkSnapshot, type SdkMessage } from "../data/sdkSession";
import { readSdkDraft, saveSdkDraft } from "../data/sdkDraft";
import { setTaskArchivedThroughShell } from "../data/shellBridge";
import { parseLifecycle } from "./DesktopArchivePage";
import { DesktopToolDock, DESKTOP_TOOLS_UNWIRED, type DesktopTool } from "./DesktopToolDock";
import { BrandMark, LocalUserAvatar } from "./ui";

const sessionId = SDK_SESSION_ID;
type Turn = { taskId: string; sessionId: string; requestId: string; turnId: string; state: "accepted" | "done" | "cancelled" | "failed" | "interrupted"; error?: string; needsResync: boolean };
type Message = SdkMessage;
type Snapshot = { source: "sdk-jsonl"; sessionId: string; messages: Message[]; pending: boolean; interrupted: boolean };
type Attempt = { requestId: string; text: string; turnId?: string; phase: "starting" | "unknown" | "accepted" | "terminal"; state?: Turn["state"] };
type Receipt = { schema: 1; taskId: string; sessionId: "main"; requestId: string; text: string };
const receiptKey = (taskId: string) => `pidock-sdk-main-pending-v1:${encodeURIComponent(taskId)}`;
function readReceipt(taskId: string): { receipt: Receipt | null; error: string | null } {
  try {
    const raw = localStorage.getItem(receiptKey(taskId));
    if (raw === null) return { receipt: null, error: null };
    if (raw.length > 131072) throw new Error("invalid receipt size");
    const value: unknown = JSON.parse(raw);
    if (!object(value) || Object.keys(value).sort().join(",") !== "requestId,schema,sessionId,taskId,text" ||
        value.schema !== 1 || value.taskId !== taskId || value.sessionId !== sessionId ||
        typeof value.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.requestId) ||
        typeof value.text !== "string" || !value.text.trim() || new TextEncoder().encode(value.text).length > 16384) throw new Error("invalid receipt");
    return { receipt: value as Receipt, error: null };
  } catch { return { receipt: null, error: "本机待确认请求记录不可读取；已禁止发送，请检查此应用的本机数据" }; }
}
function saveReceipt(taskId: string, requestId: string, text: string): void {
  if (!text.trim() || new TextEncoder().encode(text).length > 16384) throw new Error("消息超过 SDK 16 KiB 上限");
  const existing = readReceipt(taskId);
  if (existing.error || (existing.receipt && (existing.receipt.requestId !== requestId || existing.receipt.text !== text))) throw new Error("本机待确认请求记录无法核验，已禁止新请求");
  const value: Receipt = { schema: 1, taskId, sessionId, requestId, text };
  localStorage.setItem(receiptKey(taskId), JSON.stringify(value));
  if (localStorage.getItem(receiptKey(taskId)) !== JSON.stringify(value)) throw new Error("本机请求记录无法保存，未发送");
}
function clearReceipt(taskId: string, requestId: string): void {
  const saved = readReceipt(taskId);
  if (saved.error || (saved.receipt && saved.receipt.requestId !== requestId)) throw new Error("本机待确认请求记录身份不一致，已禁止发送");
  if (!saved.receipt) return;
  localStorage.removeItem(receiptKey(taskId));
  if (localStorage.getItem(receiptKey(taskId)) !== null) throw new Error("本机请求记录无法清除，已禁止发送");
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const errorText = (value: unknown) => value instanceof Error ? value.message : "SDK 连接失败，请重新核验";
const parseSnapshot = parseSdkSnapshot;
function parseTurn(value: unknown, taskId: string, requestId: string): Turn | null {
  if (value === null) return null;
  if (!object(value) || value.taskId !== taskId || value.sessionId !== sessionId || value.requestId !== requestId ||
      typeof value.turnId !== "string" || !/^[a-f0-9-]{36}$/.test(value.turnId) ||
      !["accepted", "done", "cancelled", "failed", "interrupted"].includes(String(value.state)) ||
      typeof value.needsResync !== "boolean") throw new Error("SDK 请求状态返回异常");
  return value as Turn;
}
function allowed(data: DesktopProjects, taskId: string): boolean {
  const association = data.associations.find((row) => row.taskId === taskId);
  return data.inventory.tasks.some((task) => task.taskId === taskId) &&
    (association?.state === "assigned" || association?.state === "unassigned") &&
    data.inventory.roots.every((root) => root.state === "ready");
}

type ConversationProps = { taskId: string; name: string; roots: string; association: string; onBack: () => void; onOpenProviders: () => void; onArchived: () => void };
export function DesktopConversation(props: ConversationProps) {
  return <TaskConversation key={props.taskId} {...props} />;
}

function TaskConversation({ taskId, name, roots, association, onBack, onOpenProviders, onArchived }: ConversationProps) {
  const bridge = window.pidock;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const recovered = useRef(readReceipt(taskId));
  const [draft, setDraft] = useState(recovered.current.receipt?.text ?? "");
  const [draftError, setDraftError] = useState<string | null>(null);
  const draftLoaded = useRef(false);
  const draftRevision = useRef(0);
  const [receiptError, setReceiptError] = useState(recovered.current.error);
  const [attempt, setAttempt] = useState<Attempt | null>(recovered.current.receipt ? { ...recovered.current.receipt, phase: "unknown" } : null);
  const attemptRef = useRef<Attempt | null>(recovered.current.receipt ? { ...recovered.current.receipt, phase: "unknown" } : null);
  const [stream, setStream] = useState("");
  const streamRef = useRef("");
  const [notice, setNotice] = useState("正在连接 SDK 会话");
  const [valid, setValid] = useState(false);
  const [connected, setConnected] = useState(false);
  const [invalidated, setInvalidated] = useState(false);
  const generation = useRef(0);
  const sequence = useRef(new Map<string, number>());
  const busy = useRef(false);
  const composing = useRef(false);
  const rootsRef = useRef(roots);
  const setCurrent = (next: Attempt | null) => { attemptRef.current = next; setAttempt(next); };
  const request = useCallback(async (action: string, fields: Record<string, unknown> = {}) => {
    if (!bridge?.sdkTurn) throw new Error("桌面壳 SDK 接口不可用");
    const result = await bridge.sdkTurn({ action, taskId, sessionId, ...fields });
    if (!result || result.ok !== true || !object(result.payload)) throw new Error(result?.error || "SDK 响应不可用");
    return result.payload;
  }, [bridge, taskId]);
  const verify = useCallback(async () => {
    const data = await loadDesktopProjects(bridge ?? {});
    if (JSON.stringify(data.inventory.roots) !== rootsRef.current || !allowed(data, taskId) ||
        JSON.stringify(data.associations.find((row) => row.taskId === taskId)) !== association) throw new Error("任务或任务根已变化，请返回列表重新选择");
  }, [association, bridge, taskId]);
  const reconcile = useCallback(async (epoch: number, requestId?: string) => {
    const result = requestId ? await request("status", { requestId }) : null;
    const turn = result ? parseTurn(result.turn, taskId, requestId!) : null;
    const projection = parseSnapshot((await request("projection")));
    if (epoch !== generation.current || attemptRef.current?.requestId !== requestId) return;
    sequence.current.clear(); streamRef.current = ""; setStream(""); setSnapshot(projection);
    if (requestId && turn && attemptRef.current) {
      if (turn.state !== "accepted") {
        try { clearReceipt(taskId, requestId); setReceiptError(null); }
        catch { setReceiptError("本机待确认请求记录无法清除，已禁止发送；请核验本机数据"); }
      }
      setCurrent({ ...attemptRef.current, turnId: turn.turnId, phase: turn.state === "accepted" ? "accepted" : "terminal", state: turn.state });
    }
    else if (requestId && attemptRef.current) setCurrent({ ...attemptRef.current, phase: "unknown" });
    setNotice(turn ? turn.state === "accepted" ? "正在等待模型" : turn.state === "done" ? "已从 SDK 历史核验" : `执行${turn.state === "cancelled" ? "已取消" : "未完成"}${turn.error ? `：${turn.error}` : ""}` :
      requestId ? "请求状态未知；可按原 ID 重试，不能发送新消息" : projection.interrupted ? "会话上次执行中断，请核验后继续" : projection.pending ? "会话正在执行，请等待" : "");
  }, [request, taskId]);
  const [connectionKey, setConnectionKey] = useState(0);
  const [tool, setTool] = useState<DesktopTool | null>(null);
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [unwired, setUnwired] = useState<string | null>(null);
  const [taskMenu, setTaskMenu] = useState(false);
  const [archivePrompt, setArchivePrompt] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const archiveCancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (archivePrompt) archiveCancelRef.current?.focus();
  }, [archivePrompt]);
  useEffect(() => {
    if (!taskMenu && !archivePrompt) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (archivePrompt && !archiveBusy) setArchivePrompt(false);
      else if (!archivePrompt) setTaskMenu(false);
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [taskMenu, archivePrompt, archiveBusy]);
  useEffect(() => {
    if (invalidated) { setConnected(false); setValid(false); return; }
    const epoch = ++generation.current;
    const generationRef = generation;
    const poll = window.setInterval(() => {
      const current = attemptRef.current;
      if (!current || current.phase !== "accepted" || generationRef.current !== epoch) return;
      void request("status", { requestId: current.requestId }).then((result) => {
        const turn = parseTurn(result.turn, taskId, current.requestId);
        if (generationRef.current === epoch && turn && turn.state !== "accepted")
          return reconcile(epoch, current.requestId);
      }).catch(() => { if (generationRef.current === epoch) disconnect("状态连接中断，请重新连接"); });
    }, 1000);
    let off: (() => void) | undefined;
    let subscribed = false;
    const active = () => generation.current === epoch;
    const disconnect = (reason: string) => {
      if (!active()) return;
      setValid(false); setConnected(false); streamRef.current = ""; setStream(""); sequence.current.clear(); setNotice(reason);
      off?.(); off = undefined;
      if (subscribed) void request("unsubscribe").catch(() => {});
    };
    const onEvent = (raw: unknown) => {
      if (!active() || !object(raw)) return;
      if (raw.kind === "needs-resync") {
        if (raw.taskId === taskId && raw.sessionId === sessionId) { streamRef.current = ""; setStream(""); void reconcile(epoch, attemptRef.current?.requestId).catch(() => disconnect("连接中断，请重新连接")); }
        return;
      }
      if (raw.kind === "sdk-turn-status" && object(raw.turn)) {
        const current = attemptRef.current;
        if (current && current.turnId === raw.turn.turnId && raw.turn.taskId === taskId && raw.turn.sessionId === sessionId)
          void reconcile(epoch, current.requestId).catch(() => disconnect("状态读取失败，请重新连接"));
        return;
      }
      if (raw.kind !== "sdk-turn-event" || !object(raw.event)) return;
      const event = raw.event;
      const current = attemptRef.current;
      if (event.taskId !== taskId || event.sessionId !== sessionId || !current?.turnId || current.turnId !== event.turnId || current.phase !== "accepted") return;
      const last = sequence.current.get(current.turnId) ?? 0;
      if (!Number.isSafeInteger(event.sequence) || event.sequence !== last + 1 || last >= 256) {
        streamRef.current = ""; setStream(""); void reconcile(epoch, current.requestId).catch(() => disconnect("事件缺口，请重新连接")); return;
      }
      sequence.current.set(current.turnId, event.sequence as number);
      if (event.type === "delta") {
        if (typeof event.text !== "string" || event.text.length > 16384) { void reconcile(epoch, current.requestId).catch(() => disconnect("事件异常，请重新连接")); return; }
        const next = streamRef.current + event.text;
        if (next.length > 16384) {
          streamRef.current = ""; setStream(""); void reconcile(epoch, current.requestId).catch(() => disconnect("事件超限，请重新连接"));
        } else { streamRef.current = next; setStream(next); }
      }
    };
    const connect = async () => {
      try {
        await verify();
        if (!active()) return;
        if (!draftLoaded.current) {
          const saved = readSdkDraft(taskId);
          draftLoaded.current = true;
          setDraftError(saved.error);
          if (saved.text !== null && draftRevision.current === 0) setDraft(saved.text);
        }
        if (!bridge?.onSdkTurnEvent) throw new Error("SDK 事件接口不可用");
        off = bridge.onSdkTurnEvent(onEvent);
        const reply = await request("subscribe", attemptRef.current ? { requestId: attemptRef.current.requestId } : {});
        if (!active()) { off?.(); void request("unsubscribe").catch(() => {}); return; }
        subscribed = true;
        if (reply.taskId !== taskId || reply.sessionId !== sessionId) throw new Error("SDK 订阅身份异常");
        const projection = parseSnapshot(reply.snapshot);
        setSnapshot(projection); setValid(true); setConnected(true);
        if (attemptRef.current) await reconcile(epoch, attemptRef.current.requestId);
        else setNotice(projection.interrupted ? "会话上次执行中断" : projection.pending ? "会话正在执行，请等待" : "");
      } catch (error) { disconnect(errorText(error)); }
    };
    void connect();
    return () => { if (generationRef.current === epoch) generationRef.current++; window.clearInterval(poll); off?.(); if (subscribed) void request("unsubscribe").catch(() => {}); };
  }, [bridge, connectionKey, invalidated, reconcile, request, taskId, verify]);
  const refresh = async () => {
    const epoch = generation.current;
    try { await verify(); if (epoch !== generation.current) return; await reconcile(epoch, attemptRef.current?.requestId); if (epoch === generation.current) setValid(true); }
    catch (error) { setValid(false); setConnected(false); setNotice(errorText(error)); setInvalidated(true); }
  };
  const start = async (reuse = false) => {
    if (busy.current || !connected || !valid || receiptError || (!reuse && (attemptRef.current?.phase === "unknown" || attemptRef.current?.phase === "accepted" || snapshot?.pending))) return;
    const text = reuse ? attemptRef.current?.text : draft;
    if (!text?.trim()) return;
    const submittedRevision = draftRevision.current;
    busy.current = true;
    const epoch = generation.current;
    try {
      await verify();
      if (epoch !== generation.current) return;
      const current: Attempt = reuse && attemptRef.current ? { ...attemptRef.current, phase: "starting" } : { requestId: crypto.randomUUID(), text, phase: "starting" };
      saveReceipt(taskId, current.requestId, current.text);
      setCurrent(current); setNotice("等待 Host 确认请求"); streamRef.current = ""; setStream(""); sequence.current.clear();
      let result;
      try { result = await request("start", { requestId: current.requestId, text: current.text }); }
      catch (error) {
        if (epoch !== generation.current) return;
        if (errorText(error).includes("provider-not-configured") || errorText(error).includes("invalid-prompt")) {
          try { clearReceipt(taskId, current.requestId); setCurrent(null); setNotice(`无法发送：${errorText(error)}`); }
          catch { setReceiptError("本机待确认请求记录无法清除，已禁止发送；请核验本机数据"); }
        } else { setCurrent({ ...current, phase: "unknown" }); setNotice(`请求结果未知：${errorText(error)}；请核验或按原 ID 重试`); }
        return;
      }
      if (epoch !== generation.current) return;
      const turn = parseTurn(result.turn, taskId, current.requestId);
      if (!turn) throw new Error("SDK ACK 缺少请求身份");
      setCurrent({ ...current, turnId: turn.turnId, phase: turn.state === "accepted" ? "accepted" : "terminal", state: turn.state });
      setNotice(turn.state === "accepted" ? "正在等待模型" : "正在核验 SDK 历史");
      if (turn.state === "accepted" && !reuse && draftRevision.current === submittedRevision) {
        setDraft("");
        setDraftError(saveSdkDraft(taskId, ""));
      }
      await reconcile(epoch, current.requestId);
    } catch (error) {
      if (epoch === generation.current) { setValid(false); setNotice(errorText(error)); setInvalidated(true); }
    } finally { busy.current = false; }
  };
  const stop = async () => {
    const current = attemptRef.current;
    if (!current?.turnId || current.phase !== "accepted" || !valid) return;
    const epoch = generation.current;
    try { await request("cancel", { turnId: current.turnId }); await reconcile(epoch, current.requestId); }
    catch (error) { if (epoch === generation.current) setNotice(`停止结果未知：${errorText(error)}；请核验`); }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); void start(); };
  const blocked = !valid || !connected || !!receiptError || snapshot?.pending || attempt?.phase === "starting" || attempt?.phase === "unknown" || attempt?.phase === "accepted";
  const archive = async () => {
    if (archiveBusy || blocked || busy.current) { setArchiveError("会话执行或请求状态未核验，不能归档；请先核验或停止执行"); return; }
    setArchiveBusy(true);
    setArchiveError("");
    let issued = false;
    try {
      await verify();
      // A turn can start after opening the confirmation dialog. Check the
      // authoritative SDK projection again immediately before the Host write.
      const current = parseSnapshot(await request("projection"));
      if (current.pending || attemptRef.current?.phase === "unknown" || attemptRef.current?.phase === "accepted" || busy.current) {
        throw new Error("会话仍在执行或请求结果未知，不能归档");
      }
      issued = true;
      const result = await setTaskArchivedThroughShell({ taskId, archived: true });
      if (!result.ok) throw new Error(result.error ?? "归档失败");
      if (!parseLifecycle(result.payload, taskId).archived) throw new Error("归档结果无法核验，请刷新归档状态");
      onArchived();
    } catch (error) {
      if (issued) setInvalidated(true);
      setArchiveError(issued ? `${errorText(error)}；结果可能已写入，请返回任务列表或已归档页核验` : errorText(error));
    } finally { setArchiveBusy(false); }
  };
  // Prototype A task workspace ([UI 对齐 S8b/S8c] #47): eyebrow, title, icon toolbar,
  // meta chips, the real session tab strip, message chrome, and a composer whose
  // entries are either real or explicitly marked 未接线. Nothing here fabricates a
  // service, tool, attachment or session that the real Host does not have.
  const ready = valid && connected;
  const usageSnapshot = ready ? snapshot : null;
  const reportedMessages = usageSnapshot?.messages.filter((message) => message.usage !== null) ?? [];
  const recentTokens = reportedMessages.reduce((sum, message) => sum + message.usage!.input + message.usage!.output, 0);
  const unreportedReplies = usageSnapshot?.messages.filter((message) => message.role === "assistant" && message.usage === null).length ?? 0;
  const usageDetail = `最近最多 80 条 SDK 消息；不是会话累计，可能不含更早用量。${unreportedReplies ? `${unreportedReplies} 条助手消息未报告用量。` : ""}`;
  // S8d: `文件`/`终端` are wired to real Host ops; the rest stay visible but
  // unwired, with the Host-side reason instead of a silent no-op.
  const toolIcons: { icon: "file" | "terminal" | "server" | "globe" | "chart" | "link"; tool?: DesktopTool; unwiredId?: string; label: string }[] = [
    { icon: "server", unwiredId: "runtime", label: "运行" },
    { icon: "globe", unwiredId: "browser", label: "浏览器" },
    { icon: "file", tool: "files", label: "文件" },
    { icon: "terminal", tool: "terminal", label: "终端" },
    { icon: "chart", unwiredId: "logs", label: "日志" },
    { icon: "link", tool: "protocol", label: "协议" },
  ];
  // The provider is mounted here as well as at the app root: this component is
  // also rendered standalone (tests, embedded surfaces).
  // Prototype A keeps the model entry in the composer, not in a strip above the
  // history, so this is read-only summary text plus a way into the real
  // 模型与 Provider page. Sending still fails closed with the Host's own reason.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const status = parseProviderStatus(await providerCall(taskId, { op: "list" }));
        if (live) setProvider(status);
      } catch { if (live) setProvider(null); }
    })();
    return () => { live = false; };
  }, [taskId]);
  const selectedProfile = provider?.state === "configured" ? provider.profiles.find((entry) => entry.id === provider.profileId) : undefined;
  const modelLabel = selectedProfile ? `${selectedProfile.name} · ${selectedProfile.modelId}` : provider ? "未配置模型" : "正在读取模型";
  return <TooltipProvider><main data-testid="desktop-conversation" className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-bg text-ink">
    <div className="shrink-0 border-b border-line bg-paper px-4 pt-3 below-mid:px-3">
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] tracking-[1.4px] text-muted uppercase">Task workspace</p>
          <h1 className="mt-1 truncate text-[19px] font-semibold tracking-[-0.4px]">{name}</h1>
          <div className="mt-1.5 mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted">
            <span className="inline-flex min-w-0 items-center gap-1"><Icon name="branch" /><span className="truncate">{taskId}</span></span>
            <span className="inline-flex items-center gap-1"><Icon name="settings" />SDK · main</span>
            {/* Real property of this kernel: tools are disabled for SDK turns. */}
            <Badge variant="soft">只读 · 无工具</Badge>
            <Badge>{ready ? "已连接" : invalidated ? "已失效" : "未连接"}</Badge>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 pb-1">
          {toolIcons.map((item) => item.tool
            ? <Button key={item.icon} type="button" variant={tool === item.tool ? "secondary" : "ghost"} size="icon-sm" onClick={() => setTool(tool === item.tool ? null : item.tool!)} aria-pressed={tool === item.tool} title={`${item.label}面板（真实 Host）`} aria-label={item.label}><Icon name={item.icon} /></Button>
            : <Tooltip key={item.icon}><TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => setUnwired(item.label)} aria-label={`${item.label}（未接线）`} className="text-[#b3b9be]"><Icon name={item.icon} /></Button>
              </TooltipTrigger>
              <TooltipContent>{`${item.label}未接线：${DESKTOP_TOOLS_UNWIRED.find((entry) => entry.id === item.unwiredId)?.reason ?? ""}`}</TooltipContent>
            </Tooltip>)}
          <div className="relative">
            <Button type="button" variant="ghost" size="icon-sm" aria-label="任务操作" aria-expanded={taskMenu} onClick={() => setTaskMenu((open) => !open)}><Icon name="more" /></Button>
            {taskMenu && <div className="absolute top-full right-0 z-20 min-w-[150px] rounded-[7px] border border-line bg-paper p-1 shadow-sm">
              <Button type="button" variant="ghost" className="w-full justify-start" onClick={() => { setTaskMenu(false); setArchiveError(""); setArchivePrompt(true); }}><Icon name="archive" />归档当前任务</Button>
            </div>}
          </div>
          <Button type="button" disabled={!connected} onClick={() => void refresh()} title={connected ? "核验 SDK 会话与任务身份" : "等待 SDK 会话连接后核验"}><Icon name="refresh" /><span className="below-narrow:hidden">核验</span></Button>
          <Button type="button" size="icon" onClick={onBack} aria-label="返回任务列表" title="返回任务列表"><Icon name="arrow" className="-rotate-90" /></Button>
        </div>
      </div>
      <div className="flex items-end gap-1 text-[12px]" role="tablist" aria-label="会话">
        {/* #45: production serves exactly one session, `main`; other sessions are not discovered yet. */}
        <span role="tab" aria-selected className="border-b-2 border-accent px-2 pb-2 font-semibold text-ink">main</span>
        <span className="pb-2 pl-1 text-[11px] text-muted">仅 main 会话</span>
      </div>
    </div>
    {archivePrompt && <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4">
      <div role="dialog" aria-modal="true" aria-label="归档当前任务" className="w-full max-w-[440px] rounded-[7px] border border-line bg-paper p-5 shadow-lg">
        <h2 className="text-base font-semibold">归档当前任务</h2>
        <p className="mt-3 text-xs leading-6 text-muted">归档会停止所属执行、使未执行确认失效并暂停定时任务；代码和历史保留。恢复后服务与定时任务不会自动启动。清理需要单独处理。</p>
        {blocked && !archiveError && <p role="status" className="mt-3 text-xs text-muted">会话尚未连接、正在执行或请求状态未核验；请先完成核验或停止执行。</p>}
        {archiveError && <p role="alert" className="mt-3 border border-[#e0b4b4] bg-[#fdf3f3] p-2 text-xs text-[#ad4545]">{archiveError}</p>}
        <div className="mt-5 flex justify-end gap-2">
          {invalidated && <Button type="button" variant="outline" onClick={onArchived}>查看归档状态</Button>}
          <Button ref={archiveCancelRef} type="button" variant="outline" disabled={archiveBusy} onClick={() => setArchivePrompt(false)}>取消</Button>
          <Button type="button" disabled={archiveBusy || blocked} onClick={() => void archive()}>{archiveBusy ? "归档中…" : "确认归档"}</Button>
        </div>
      </div>
    </div>}
    {unwired && <p role="status" data-testid="desktop-unwired-tool" className="shrink-0 border-b border-line bg-soft px-4 py-1.5 text-[11px] text-muted">
      {unwired}面板未接线：{DESKTOP_TOOLS_UNWIRED.find((entry) => entry.label === unwired)?.reason ?? "生产读取路径尚未接线"}（不显示样例数据）
    </p>}
    <div className="flex min-h-0 min-w-0 flex-1">
    <div className={`flex min-h-0 min-w-0 flex-1 flex-col ${tool ? "below-narrow:hidden" : ""}`}>
    <section aria-label="SDK 对话历史" className="mx-auto w-full max-w-[820px] min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto px-3 py-4">
      <p className="text-xs text-muted">SDK JSONL 已确认历史 · 最近最多 80 条</p>
      {snapshot && !snapshot.messages.length && <p className="py-8 text-center text-sm text-muted">尚未开始 · 无 SDK 会话记录</p>}
      {snapshot?.messages.map((message, index) => <article key={index} className="min-w-0 text-sm">
        <div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
          {message.role === "user" ? <LocalUserAvatar /> : <BrandMark size="sm" />}
          <span className="font-semibold text-ink">{message.role === "user" ? "你" : "Pi"}</span>
          <span>实现与验证</span>
        </div>
        <div className={`min-w-0 rounded-[10px] border px-3 py-2 ${message.role === "user" ? "border-line bg-paper" : "border-line bg-paper"}`}>
          <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.text}</p>
        </div>
        {message.usage && <p className="mt-1 text-xs text-muted">SDK 用量 · 输入 {message.usage.input} / 输出 {message.usage.output} / 缓存读取 {message.usage.cacheRead} / 写入 {message.usage.cacheWrite}</p>}
      </article>)}
      {stream && <article className="min-w-0 border-l-2 border-ink pl-3 text-sm"><p className="mb-1 text-xs text-muted">暂存回复 · 尚未核验</p><p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{stream}</p></article>}
    </section>
    <div className="shrink-0 border-t border-line bg-paper px-3 py-3"><div className="mx-auto max-w-[820px] min-w-0">
      {draftError && <p role="alert" className="mb-2 break-words text-xs text-[#ad4545]">{draftError}</p>}
      {receiptError && <p role="alert" className="mb-2 break-words text-xs text-[#ad4545]">{receiptError}</p>}
      {notice && <p role="status" className="mb-2 break-words text-xs text-muted">{notice}</p>}
      <div className="mb-2 flex flex-wrap gap-2">{invalidated ? <Button type="button" onClick={onBack}>返回任务列表</Button> : (!connected || !valid) && <Button type="button" onClick={() => setConnectionKey((key) => key + 1)}>重新连接</Button>}
        {attempt?.phase === "unknown" && <Button type="button" onClick={() => void refresh()}>查询原请求</Button>}
        {attempt?.phase === "unknown" && <Button type="button" disabled={!valid} onClick={() => void start(true)}>按原 ID 重试</Button>}
        {attempt?.phase === "accepted" && <Button type="button" onClick={() => void stop()}><Icon name="stop" />停止</Button>}
      </div>
      <form onSubmit={submit} className="min-w-0 rounded-[10px] border border-line bg-bg p-2">
        <textarea aria-label="消息" value={draft} onChange={(event) => { const text = event.target.value; draftRevision.current++; setDraft(text); if (valid && connected && !invalidated) setDraftError(saveSdkDraft(taskId, text)); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); if (!blocked) void start(); } }} rows={2} maxLength={16384} className="w-full min-w-0 resize-y border-0 bg-transparent p-1 text-sm outline-none" placeholder="描述你想做什么（仅支持文本消息）" />
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted">
          <Tooltip><TooltipTrigger asChild><span tabIndex={0} aria-label="附件说明" className="inline-flex">
            <Button type="button" size="icon-sm" disabled aria-label="附件（未接线）" className="text-[#b3b9be]"><Icon name="plus" /></Button>
          </span></TooltipTrigger><TooltipContent>附件未接线；当前会话仅支持文本消息</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild><span tabIndex={0} aria-label="权限说明" className="inline-flex">
            <Button type="button" size="sm" disabled aria-label="权限（未接线）：只读 · 无工具"><Icon name="shield" />只读 · 无工具</Button>
          </span></TooltipTrigger><TooltipContent>权限切换未接线；当前 SDK 回合无工具，不申请写权限</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild><span tabIndex={0} aria-label="推理设置说明" className="inline-flex">
            <Button type="button" size="sm" disabled>推理（未接线）</Button>
          </span></TooltipTrigger><TooltipContent>推理设置未接线；此处不表示模型的推理能力或当前档位</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild>
            <Button type="button" size="sm" onClick={onOpenProviders} title={provider ? PROVIDER_STATE_TEXT[provider.state] : "正在读取 Provider 配置"} data-testid="composer-model">{modelLabel}<Icon name="down" className="h-3 w-3" /></Button>
          </TooltipTrigger><TooltipContent>{provider ? PROVIDER_STATE_TEXT[provider.state] : "正在读取 Provider 配置"}</TooltipContent></Tooltip>
          <span title={usageDetail} className="ml-auto min-w-0 break-words">{!usageSnapshot ? "近期用量未核验" : reportedMessages.length ? `近期已报告输入+输出 ${recentTokens} tokens` : "近期用量未报告"}</span>
          <Button type="submit" variant="default" size="icon" disabled={blocked || !draft.trim()} aria-label="发送" title="发送"><Icon name="arrow" /></Button>
        </div>
      </form>
    </div></div>
    </div>
    <DesktopToolDock taskId={taskId} tool={tool} onClose={() => setTool(null)} />
    </div>
  </main></TooltipProvider>;
}
