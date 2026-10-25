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
import { describeContextDisplay, REASONING_LABELS, REASONING_LEVELS } from "../data/providerState";
import { readSessionContext, writeSessionThinking, type SessionContextView } from "../data/sessionContext";
import { parseLifecycle } from "./DesktopArchivePage";
import { attachmentRefusal, attachmentSelectionReport, attachmentSourceLabel, classifyComposerAttachment, describeReferenceChip, referenceProvenance, referenceSourceLabel, type CandidateRow } from "../data/composerRules";
import type { Reference } from "../data/types";
import { DesktopToolDock, DESKTOP_TOOL_ICONS, DESKTOP_TOOL_LABELS, DESKTOP_TOOLS_UNWIRED, type DesktopTool } from "./DesktopToolDock";
import { DesktopTaskSources } from "./DesktopTaskSources";
import { BrandMark, LocalUserAvatar } from "./ui";
import { hostText } from "../data/workspaceFiles";

const sessionId = SDK_SESSION_ID;
type Turn = { taskId: string; sessionId: string; requestId: string; turnId: string; state: "accepted" | "done" | "cancelled" | "failed" | "interrupted"; error?: string; needsResync: boolean };
type Message = SdkMessage;
type Snapshot = { source: "sdk-jsonl"; sessionId: string; messages: Message[]; pending: boolean; interrupted: boolean };
type Attempt = { requestId: string; text: string; turnId?: string; phase: "starting" | "unknown" | "accepted" | "terminal"; state?: Turn["state"] };
/**
 * The 推理/上下文 entries read one Host readout (`task/sessionContext`). `reading`
 * is a named state of its own: while it is outstanding the composer shows no
 * level and no occupancy, because nothing has been read yet.
 */
type ContextRead = { phase: "reading" } | { phase: "read"; context: SessionContextView } | { phase: "failed"; error: string };
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

type ConversationProps = { taskId: string; name: string; roots: string; association: string; onBack: () => void; onOpenProviders: () => void; onArchived: () => void; onSourcesChanged?: () => void };
/**
 * [PiDock 16] (#16 盒 1) one attachment of this desktop draft. The production
 * turn is `window.pidock.sdkTurn` → SDK `session.prompt(text)`: a string-only
 * payload, so an attachment is page state here and is never part of the sent
 * text. `detail` is the mirrored rule's own line (size + page-only scope).
 */
type DraftAttachment = { id: string; name: string; detail: string };

/** One visible name per attachment row; a repeated file name reads （2）, （3）… */
function uniqueAttachmentName(name: string, taken: readonly string[]): string {
  if (!taken.includes(name)) return name;
  let index = 2;
  while (taken.includes(`${name}（${index}）`)) index += 1;
  return `${name}（${index}）`;
}

export function DesktopConversation(props: ConversationProps) {
  return <TaskConversation key={props.taskId} {...props} />;
}

function TaskConversation({ taskId, name, roots, association, onBack, onOpenProviders, onArchived, onSourcesChanged }: ConversationProps) {
  const bridge = window.pidock;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const recovered = useRef(readReceipt(taskId));
  const [draft, setDraft] = useState(recovered.current.receipt?.text ?? "");
  const [draftError, setDraftError] = useState<string | null>(null);
  /**
   * [PiDock 15] (#15 盒 3) file references attached to this draft. The 文件 panel
   * hands in a candidate row built from the root it selected and the file it
   * previewed; the reference is completed HERE from `referenceProvenance()`
   * (`data/composerRules.ts`), the same call the `@` picker and the `/skills`
   * modal use, so a worktree entry pins the commit it knows and a
   * plain-directory link pins `null`, names its original target and never fakes
   * a Git version. Attaching one is page state: no Host op is issued, read or
   * write.
   */
  const [references, setReferences] = useState<Reference[]>([]);
  /**
   * [PiDock 16] (#16 盒 1) attachments picked with the composer's `+` entry.
   * They live in this component only: nothing is read, uploaded, stored, or sent,
   * and every row repeats that scope from the mirrored rule
   * (`attachmentSourceLabel`, `data/composerRules.ts`).
   */
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [attachmentReport, setAttachmentReport] = useState<string | null>(null);
  const attachmentInput = useRef<HTMLInputElement | null>(null);
  const attachmentSequence = useRef(0);
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
  const [openTools, setOpenTools] = useState<DesktopTool[]>([]);
  const [activeTool, setActiveTool] = useState<DesktopTool | null>(null);
  const [toolDockCollapsed, setToolDockCollapsed] = useState(false);
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [unwired, setUnwired] = useState<string | null>(null);
  const [contextRead, setContextRead] = useState<ContextRead>({ phase: "reading" });
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [thinkingError, setThinkingError] = useState<string | null>(null);
  const [thinkingBusy, setThinkingBusy] = useState(false);
  const contextAttempt = useRef(0);
  const [taskMenu, setTaskMenu] = useState(false);
  const [archivePrompt, setArchivePrompt] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const archiveCancelRef = useRef<HTMLButtonElement>(null);
  const closeTool = (closedTool: DesktopTool) => {
    const index = openTools.indexOf(closedTool);
    if (index < 0) return;
    const remaining = openTools.filter((item) => item !== closedTool);
    setOpenTools(remaining);
    if (activeTool === closedTool) {
      setActiveTool(remaining[Math.min(index, remaining.length - 1)] ?? null);
      setToolDockCollapsed(false);
    }
  };
  const toggleTool = (nextTool: DesktopTool) => {
    if (!openTools.includes(nextTool)) {
      setOpenTools([...openTools, nextTool]);
      setActiveTool(nextTool);
      setToolDockCollapsed(false);
    } else if (activeTool === nextTool) {
      if (toolDockCollapsed) setToolDockCollapsed(false);
      else closeTool(nextTool);
    } else {
      setActiveTool(nextTool);
      setToolDockCollapsed(false);
    }
  };
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
  const addFileReference = (row: CandidateRow) => {
    // The same id spelling and field set `TaskPage.chooseCompletion` records for
    // a picked candidate (`pages/TaskPage.tsx`), including this task as the
    // owner, so a reference can never be read as another task's file.
    const id = `task-${row.key}`;
    const reference: Reference = {
      id,
      kind: row.kind === "directory" ? "directory" : "file",
      label: row.value,
      detail: row.detail,
      taskId,
      ...referenceProvenance(row),
    };
    setReferences((current) => (current.some((entry) => entry.id === id) ? current : [...current, reference]));
  };
  const removeFileReference = (id: string) => setReferences((current) => current.filter((entry) => entry.id !== id));
  // [PiDock 16] (#16 盒 1): every picked file passes the mirrored pre-send rule
  // (`classifyComposerAttachment`) before it becomes a draft attachment, so an
  // oversized/unsupported file is refused BY NAME in the report instead of being
  // taken silently. A cancelled selection is an empty list and adds nothing.
  const addAttachments = (files: readonly File[]) => {
    const taken = attachments.map((entry) => entry.name);
    const refused: string[] = [];
    const accepted: DraftAttachment[] = [];
    for (const file of files) {
      const decision = classifyComposerAttachment({ name: file.name, size: file.size, type: file.type });
      if (!decision.ok) {
        refused.push(attachmentRefusal(decision, file.name.length > 0 ? file.name : "未命名文件"));
        continue;
      }
      attachmentSequence.current += 1;
      const id = `desktop-attach-${attachmentSequence.current}`;
      const { label, detail } = attachmentSourceLabel({ file, pasted: false, id });
      const name = uniqueAttachmentName(label.length > 0 ? label : "未命名文件", taken);
      taken.push(name);
      accepted.push({ id, name, detail });
    }
    if (accepted.length > 0) setAttachments((current) => [...current, ...accepted]);
    setAttachmentReport(attachmentSelectionReport({ added: accepted.length, refused }));
  };
  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((entry) => entry.id !== id));
    setAttachmentReport(null);
  };
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
  // Desktop tools follow the current product scope; built-in terminal is retired.
  // `DESKTOP_TOOLS_UNWIRED` remains the registry for any tool that loses its
  // Host path; a listed tool stays visible but opens the explicit 未接线 state.
  const toolIcons = (Object.keys(DESKTOP_TOOL_LABELS) as DesktopTool[]).map((tool) => ({
    icon: DESKTOP_TOOL_ICONS[tool],
    tool,
    label: DESKTOP_TOOL_LABELS[tool],
  }));
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
  const modelLabel = selectedProfile
    // The profile's OWN name and model identity: a blank one is named here, so a
    // selected profile never renders as a bare ` · `.
    ? `${hostText(selectedProfile.name, "Host 未上报配置名称")} · ${hostText(selectedProfile.modelId, "Host 未上报模型标识")}`
    : provider ? "未配置模型" : "正在读取模型";
  // [UI 对齐 S8c] #47: 推理 and 上下文 are read from the Host's own session state
  // (`task/sessionContext`), which the demo path has used since [PiDock 11] #9 and
  // which the shipped composer wrongly called 未接线. The attempt counter makes a
  // late answer from a previous read (or a replaced task) unable to overwrite the
  // current one, and the write's own post-write readout always wins over a read
  // that was already in flight.
  const loadSessionContext = useCallback(async () => {
    const attempt = contextAttempt.current + 1;
    contextAttempt.current = attempt;
    setContextRead({ phase: "reading" });
    const result = await readSessionContext({ taskId, sessionId });
    if (contextAttempt.current !== attempt) return;
    setContextRead(result.ok ? { phase: "read", context: result.context } : { phase: "failed", error: result.error });
  }, [taskId]);
  useEffect(() => { void loadSessionContext(); }, [loadSessionContext]);
  const chooseThinking = async (level: string) => {
    if (thinkingBusy) return;
    setThinkingBusy(true);
    setThinkingError(null);
    const result = await writeSessionThinking({ taskId, sessionId, level });
    setThinkingBusy(false);
    if (!result.ok) { setThinkingError(result.error); return; }
    contextAttempt.current += 1;
    setContextRead({ phase: "read", context: result.context });
    setThinkingOpen(false);
  };
  const readout = contextRead.phase === "read" ? contextRead.context : null;
  // Every state names itself: an outstanding/failed read is not a level, a catalog
  // the Host reports as unsupported is not a choice, and an unknown tier set is
  // never rendered as one of the tiers. `resolveSessionThinking`
  // (`shell/src/main/provider-config.ts:386`) is what decides these three.
  const thinkingLabel =
    readout === null
      ? contextRead.phase === "reading" ? "推理 · 未读取" : "推理 · 读取失败"
      : readout.thinkingCatalog === "unsupported"
        ? "推理 · 不支持"
        : readout.thinking.length > 0 ? `推理 · ${REASONING_LABELS[readout.thinking] ?? readout.thinking}（${readout.thinking}）` : "推理 · 跟随模型";
  const thinkingTitle =
    contextRead.phase === "reading"
      ? "正在读取 Host 会话推理档位；读取完成前不显示任何档位"
      : contextRead.phase === "failed" ? `Host 会话推理档位读取失败：${contextRead.error}`
      : readout?.thinkingCatalog === "unsupported" ? "Host 报告该模型不支持推理档位"
      : "本会话推理档位（来自 Host 会话读数）";
  // The one occupancy number this control shows is the Host's own `percent`
  // (`shell/src/main/pi-session.ts:727`, parsed in `data/sessionContext.ts:99`),
  // and every other number on the line is the Host's own field too. The ratio is
  // never recomputed here: a locally derived ratio printed as the Host's reading
  // drifts silently the day the Host changes what `percent` means, which is
  // exactly the one-number-two-sources claim this engagement forbids. The helper
  // stays for the 估算/待更新 marker, which labels the Host's `source` and is not
  // a number.
  const contextMarker = readout === null ? "" : describeContextDisplay({ used: readout.used, window: readout.window, source: readout.source }).marker;
  // The prototype's meta line (`prototypes/pidock-ui/app.js:56`) and the demo
  // composer's own readout (`pages/TaskPage.tsx`) share this wording. The Host
  // sends `percent: null` while the window is unknown, so the line says 占比未知
  // instead of printing a `0%` nobody measured.
  const contextLabel = readout === null
    ? `上下文 ${contextRead.phase === "reading" ? "未读取" : "读取失败"}`
    : `上下文 ${readout.used.toFixed(1)}k / ${readout.window > 0 ? `${readout.window}k` : "窗口未知"}${readout.percent === null ? " · 占比未知" : ` · ${readout.percent.toFixed(1)}%`}${contextMarker.length > 0 ? ` · ${contextMarker}` : ""}`;
  // The hover names the same Host identity the visible composer line shows, so a
  // blank `providerName`/`providerId`/`modelName`/`model` (`data/sessionContext.ts:68-75`
  // type-checks all four) is named here too instead of ending in a bare ` · `.
  const contextTitle = contextRead.phase === "reading"
    ? "正在读取 Host 会话占用读数；读取完成前不显示数字"
    : contextRead.phase === "failed" ? `Host 会话占用读数读取失败：${contextRead.error}`
    : readout === null ? "Host 未返回会话读数"
      : `${hostText(readout.providerName ?? readout.providerId, "Host 未上报配置名称")} · ${hostText(readout.modelName ?? readout.model, "Host 未上报模型标识")} · 已用 ${readout.used}k Tokens（来源 ${readout.source}）· 窗口 ${readout.window > 0 ? `${readout.window}k Tokens` : "未知"} · 占用比例 ${readout.percent === null ? "未知" : `${readout.percent.toFixed(1)}%`}；数字即 Host 会话读数，未做推断`;
  // The Token line keeps its bounded-window LABEL. Its hover names the Host's own
  // session total as read, and — when the two reads disagree in the one direction
  // that matters (Host total 0 while this window reports usage) — reports what
  // these two numbers show. The Host returned two numbers, not a cause, so the
  // clause says so instead of reading as a statement the Host made; it stays
  // scoped to this route because that is all that was read (a store that
  // accumulated would show its own number instead).
  const hostLedgerNote = readout === null ? ""
    : readout.tokens === 0 && recentTokens > 0
      ? ` Host 会话账本本次读数 0 tokens，而本窗口已报告 ${recentTokens} tokens；对照这两项读数，本路由的 SDK 回合用量未计入 Host 会话账本（此为本页两项读数的对照结论，并非 Host 返回的说明）。`
      : ` Host 会话账本读数 ${readout.tokens} tokens。`;
  return <TooltipProvider><main data-testid="desktop-conversation" className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-bg text-ink">
    <div className="shrink-0 border-b border-line bg-paper px-4 pt-3 below-mid:px-3">
      {/* #49: the shell column is 280-380px when a task page is open, and the
          prototype wraps the task header below 1180px (`.taskheader
          .between{flex-wrap:wrap}`) and stacks it below 720px. Without the wrap
          the fixed 288px actionset forced the `flex-1` title to 0 width, so the
          `Task workspace` eyebrow painted under the icons and the column grew
          an inner horizontal scrollbar. */}
      <div data-testid="desktop-conversation-header" className="flex min-w-0 flex-wrap items-start gap-3">
        <div data-testid="desktop-conversation-title" className="min-w-0 flex-1">
          <p data-testid="desktop-conversation-eyebrow" className="text-[10px] tracking-[1.4px] text-muted uppercase">Task workspace</p>
          <h1 className="mt-1 truncate text-[19px] font-semibold tracking-[-0.4px]">{name}</h1>
          <div className="mt-1.5 mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted">
            <span className="inline-flex min-w-0 items-center gap-1"><Icon name="branch" /><span className="truncate">{taskId}</span></span>
            <span className="inline-flex items-center gap-1"><Icon name="settings" />SDK · main</span>
            {/* Real property of this kernel: SDK tool wiring is absent. Keep the
                read-only summary and make the missing Agent tool path explicit. */}
            <Badge variant="soft">Agent 工具未接线</Badge>
            <Badge variant="soft">只读 · 无工具</Badge>
            <Badge>{ready ? "已连接" : invalidated ? "已失效" : "未连接"}</Badge>
          </div>
        </div>
        {/* `min-w-0 flex-wrap` (no `shrink-0`): a fixed 288px toolbar would overflow any
            shell column (the column never exceeds 380px), so it drops to its own line
            and wraps its icon buttons inside the column width instead. */}
        <div data-testid="desktop-conversation-toolbar" className="flex min-w-0 flex-wrap items-center gap-1 pb-1">
          {toolIcons.map((item) => {
            const unwiredReason = DESKTOP_TOOLS_UNWIRED.find((entry) => entry.id === item.tool)?.reason;
            return unwiredReason === undefined
              ? <Button key={item.icon} type="button" variant={activeTool === item.tool && !toolDockCollapsed ? "secondary" : "ghost"} size="icon-sm" onClick={() => toggleTool(item.tool)} aria-pressed={activeTool === item.tool && !toolDockCollapsed} title={`${item.label}面板（真实 Host）`} aria-label={item.label}><Icon name={item.icon} /></Button>
              : <Tooltip key={item.icon}><TooltipTrigger asChild>
                  <Button type="button" variant="ghost" size="icon-sm" onClick={() => setUnwired(item.label)} aria-label={`${item.label}（未接线）`} className="text-[#b3b9be]"><Icon name={item.icon} /></Button>
                </TooltipTrigger>
                <TooltipContent>{`${item.label}未接线：${unwiredReason}`}</TooltipContent>
              </Tooltip>;
          })}
          {openTools.length > 0 && toolDockCollapsed && <Button type="button" variant="outline" size="sm" onClick={() => setToolDockCollapsed(false)} aria-label="展开工具区"><Icon name="plus" />展开工具区</Button>}
          {/* [PiDock 03] (#6) the production append entry: repositories AND
              plain directories. Only a shell that really exposes the append
              channel shows it. */}
          {typeof bridge?.appendTaskRepos === "function" ? (
            <Button type="button" onClick={() => setSourcesOpen(true)} aria-label="追加仓库或目录" title="从项目登记中选择仓库或普通目录并追加到本任务"><Icon name="plus" /><span className="below-narrow:hidden">追加仓库或目录</span></Button>
          ) : null}
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
    {sourcesOpen && bridge?.appendTaskRepos ? <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4">
      <DesktopTaskSources
        taskId={taskId}
        bridge={bridge}
        onClose={() => setSourcesOpen(false)}
        onAppended={() => onSourcesChanged?.()}
      />
    </div> : null}
    {unwired && <p role="status" data-testid="desktop-unwired-tool" className="shrink-0 border-b border-line bg-soft px-4 py-1.5 text-[11px] text-muted">
      {unwired}面板未接线：{DESKTOP_TOOLS_UNWIRED.find((entry) => entry.label === unwired)?.reason ?? "生产读取路径尚未接线"}（不显示样例数据）
    </p>}
    <div className="flex min-h-0 min-w-0 flex-1">
    <div className={`flex min-h-0 min-w-0 flex-1 flex-col ${activeTool && !toolDockCollapsed ? "below-narrow:hidden" : ""}`}>
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
        {references.length > 0 && <div className="mb-2 min-w-0" data-testid="composer-file-references">
          <ul className="flex min-w-0 flex-wrap gap-1.5">
            {references.map((reference) => (
              <li key={reference.id} data-testid={`composer-file-reference-${reference.id}`} data-source-kind={reference.sourceKind ?? "none"} title={describeReferenceChip(reference)} className="flex min-w-0 flex-wrap items-baseline gap-1.5 rounded-full border border-line bg-soft px-2 py-0.5 text-[11px]">
                <span className="min-w-0 break-all font-mono text-ink">引用 · {reference.label}</span>
                <span className="shrink-0 text-muted">{referenceSourceLabel(reference)}</span>
                <span className="min-w-0 break-all text-muted">{reference.detail}</span>
                <button type="button" aria-label={`移除引用 ${reference.label}`} onClick={() => removeFileReference(reference.id)} className="shrink-0 text-muted">×</button>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-muted">引用只在本页输入区记录来源身份；当前 SDK 发送路径只发送文本，引用不随消息提交，也不会读取或写入文件。</p>
        </div>}
        {attachmentReport && <p role="status" data-testid="desktop-composer-attachment-report" className="mb-2 border-l-2 border-[#dfc99f] pl-2 text-[11px] text-[#9a6032]">{attachmentReport}</p>}
        {attachments.length > 0 && <div className="mb-2 min-w-0" data-testid="desktop-composer-attachments">
          <ul className="flex min-w-0 flex-wrap gap-1.5">
            {attachments.map((attachment) => (
              <li key={attachment.id} data-testid="desktop-composer-attachment" className="flex min-w-0 flex-wrap items-baseline gap-1.5 rounded-[7px] border border-line bg-soft px-2 py-0.5 text-[11px]">
                <span data-testid="desktop-composer-attachment-name" className="min-w-0 break-all font-mono text-ink">{attachment.name}</span>
                <span className="min-w-0 break-all text-muted">{attachment.detail}</span>
                <button type="button" aria-label={`移除附件 ${attachment.name}`} onClick={() => removeAttachment(attachment.id)} className="shrink-0 text-muted">×</button>
              </li>
            ))}
          </ul>
          <p data-testid="desktop-composer-attachment-scope" className="mt-1 text-[11px] text-muted">附件只在本页输入区保留：内容不上传、不读取，附件不会发给 Agent（当前 SDK 发送路径只发送文本，附件不随消息提交）。</p>
        </div>}
        <textarea aria-label="消息" value={draft} onChange={(event) => { const text = event.target.value; draftRevision.current++; setDraft(text); if (valid && connected && !invalidated) setDraftError(saveSdkDraft(taskId, text)); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); if (!blocked) void start(); } }} rows={2} maxLength={16384} className="w-full min-w-0 resize-y border-0 bg-transparent p-1 text-sm outline-none" placeholder="描述你想做什么（仅支持文本消息）" />
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted">
          <Tooltip><TooltipTrigger asChild><span tabIndex={0} aria-label="附件说明" className="inline-flex">
            <Button type="button" size="icon-sm" data-testid="desktop-composer-attach" aria-label="添加附件" onClick={() => attachmentInput.current?.click()} className="text-muted"><Icon name="plus" /></Button>
          </span></TooltipTrigger><TooltipContent>附件只在本页输入区保留：内容不上传、不读取，附件不会发给 Agent（当前 SDK 发送路径只发送文本）</TooltipContent></Tooltip>
          <input ref={attachmentInput} type="file" multiple aria-label="附件选择" data-testid="desktop-composer-file-input" className="hidden" onChange={(event) => { addAttachments(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          <Tooltip><TooltipTrigger asChild><span tabIndex={0} aria-label="权限说明" className="inline-flex">
            <Button type="button" size="sm" disabled aria-label="权限（未接线）：只读 · 无工具"><Icon name="shield" />只读 · 无工具</Button>
          </span></TooltipTrigger><TooltipContent>权限切换未接线；当前 SDK 回合无工具，不申请写权限</TooltipContent></Tooltip>
          <div className="relative">
            <Button type="button" size="sm" data-testid="composer-thinking" aria-haspopup="dialog" aria-expanded={thinkingOpen} title={thinkingTitle} disabled={contextRead.phase === "reading"} onClick={() => { setThinkingError(null); setThinkingOpen((open) => !open); }}>{thinkingLabel}<Icon name="down" className="h-3 w-3" /></Button>
            {thinkingOpen && <div role="dialog" aria-label="推理档位" className="absolute right-0 bottom-full z-30 mb-1 w-[248px] rounded-[7px] border border-line bg-paper p-2 text-left shadow-md">
              {contextRead.phase === "failed" ? <>
                <p className="px-1 pb-1 text-[10px] leading-5 text-muted">Host 会话推理档位读取失败：{contextRead.error}</p>
                <Button type="button" variant="ghost" size="sm" className="w-full justify-start" onClick={() => void loadSessionContext()}><Icon name="refresh" />重新读取 Host 读数</Button>
              </> : readout === null ? <p className="px-1 text-[10px] leading-5 text-muted">正在读取 Host 会话读数…</p> : readout.thinkingCatalog === "unsupported" ?
                <p className="px-1 text-[10px] leading-5 text-muted">Host 报告该模型不支持推理档位，本会话无可选档位。</p>
              : <>
                <p className="px-1 pb-1 text-[10px] leading-5 text-muted">{readout.thinkingCatalog === "declared" ? "Host 已声明该模型的可用档位集合并自行校验；被拒绝时显示 Host 原文。" : "Host 尚未声明该模型的可用档位，选中档位按模型目录执行；不认识的取值由 Host 拒绝并显示原文。"}</p>
                {REASONING_LEVELS.map((level) => <Button key={level} type="button" variant="ghost" size="sm" className="w-full justify-start" aria-pressed={readout.thinking === level} disabled={thinkingBusy} onClick={() => void chooseThinking(level)}>{REASONING_LABELS[level] ?? level}<span className="text-muted">{level}</span></Button>)}
              </>}
              {thinkingError && <p role="alert" className="mt-1 border border-[#e0b4b4] bg-[#fdf3f3] p-1.5 text-[10px] leading-5 break-words text-[#ad4545]">{thinkingError}</p>}
            </div>}
          </div>
          <Tooltip><TooltipTrigger asChild>
            <Button type="button" size="sm" onClick={onOpenProviders} title={provider ? PROVIDER_STATE_TEXT[provider.state] : "正在读取 Provider 配置"} data-testid="composer-model">{modelLabel}<Icon name="down" className="h-3 w-3" /></Button>
          </TooltipTrigger><TooltipContent>{provider ? PROVIDER_STATE_TEXT[provider.state] : "正在读取 Provider 配置"}</TooltipContent></Tooltip>
          <span data-testid="composer-context" title={contextTitle} className="min-w-0 break-words">{contextLabel}</span>
          <span data-testid="composer-usage" title={`${usageDetail}${hostLedgerNote}`} className="ml-auto min-w-0 break-words">{!usageSnapshot ? "近期用量未核验" : reportedMessages.length ? `近期已报告输入+输出 ${recentTokens} tokens` : "近期用量未报告"}</span>
          <Button type="submit" variant="default" size="icon" disabled={blocked || !draft.trim()} aria-label="发送" title="发送"><Icon name="arrow" /></Button>
        </div>
      </form>
    </div></div>
    </div>
    <DesktopToolDock
      taskId={taskId}
      tool={activeTool}
      tools={openTools}
      activeTool={activeTool}
      collapsed={toolDockCollapsed}
      onSelectTool={(selected) => { setActiveTool(selected); setToolDockCollapsed(false); }}
      onCloseTool={closeTool}
      onCollapse={() => setToolDockCollapsed(true)}
      onClose={() => { if (activeTool) closeTool(activeTool); }}
      onReferenceFile={addFileReference}
    />
    </div>
  </main></TooltipProvider>;
}
