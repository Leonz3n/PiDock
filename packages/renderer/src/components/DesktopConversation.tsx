import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Icon } from "./Icon";
import { loadDesktopProjects, type DesktopProjects } from "../data/desktopProjects";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { PROVIDER_STATE_TEXT, parseProviderStatus, providerCall, type ProviderStatus } from "../data/providerProfile";
import { SDK_SESSION_ID, parseSdkSnapshot, type SdkMessage } from "../data/sdkSession";
import { readHostDraft, saveHostDraft } from "../data/draftStore";
import { executionStateThroughShell, setTaskArchivedThroughShell } from "../data/shellBridge";
import { executionStateFromHost, runRecordFromExecutionState, runStateOfExecution, type SessionExecutionView } from "../data/executionLedger";
import { executionLabel, executionStepLabel } from "../pages/executionView";
import {
  activateSession, archiveSession, createSession, deleteSession, readSessionReadout, readTaskSessions,
  REASONING_LEVEL_TEXT, renameSession, restoreSession, setSessionReasoning, switchSessionModel,
  type SessionList, type SessionReadout, type SessionThinkingLevel, type TaskSession,
} from "../data/taskSessions";
import { parseLifecycle } from "./DesktopArchivePage";
import { attachmentRefusal, attachmentSelectionReport, attachmentSourceLabel, classifyComposerAttachment, describeReferenceChip, referenceProvenance, referenceSourceLabel, type CandidateRow } from "../data/composerRules";
import type { Reference } from "../data/types";
import { DesktopToolDock, DESKTOP_TOOL_ICONS, DESKTOP_TOOL_LABELS, DESKTOP_TOOLS_UNWIRED, type DesktopTool } from "./DesktopToolDock";
import { DesktopTaskSources } from "./DesktopTaskSources";
import { BrandMark, LocalUserAvatar } from "./ui";
import { hostText } from "../data/workspaceFiles";

type Turn = { taskId: string; sessionId: string; requestId: string; turnId: string; state: "accepted" | "done" | "cancelled" | "failed" | "interrupted"; error?: string; needsResync: boolean };
type Message = SdkMessage;
type Snapshot = { source: "sdk-jsonl"; sessionId: string; messages: Message[]; pending: boolean; interrupted: boolean };
/**
 * [#117 第 1 项 / #16 盒 3] 随回合下发的引用与附件**身份**（类型、来源、路径）。
 * 只有 Host 能把它拼成 prompt 末尾那一段（`host/sdk-prompt-context.ts`）；
 * 渲染层不拼文本，也不读取文件内容。
 */
type TurnContext = {
  references?: { kind: string; label: string; source?: string; detail?: string }[];
  attachments?: { kind: "attachment"; label: string; detail?: string }[];
};
type Attempt = { requestId: string; text: string; context?: TurnContext; turnId?: string; phase: "starting" | "unknown" | "accepted" | "terminal"; state?: Turn["state"] };
/**
 * The 推理/上下文 entries read one Host readout (`task/sessionContext`). `reading`
 * is a named state of its own: while it is outstanding the composer shows no
 * level and no occupancy, because nothing has been read yet.
 */
/**
 * [#139] One session's readout (`task/sessionReadout`): identity, bound model,
 * declared reasoning levels and the numbers the real SDK session reported.
 * `reading`/`failed` are named states of their own — while one is outstanding the
 * page shows no level and no occupancy, because nothing has been read yet.
 */
type ReadoutRead = { phase: "reading" } | { phase: "read"; readout: SessionReadout } | { phase: "failed"; error: string };
type SessionListRead = { phase: "reading" } | { phase: "read"; list: SessionList } | { phase: "failed"; error: string };
type Receipt = { schema: 1; taskId: string; sessionId: string; requestId: string; text: string };
const receiptKey = (taskId: string, sessionId: string) => `pidock-sdk-pending-v1:${encodeURIComponent(taskId)}:${encodeURIComponent(sessionId)}`;
function readReceipt(taskId: string, sessionId: string): { receipt: Receipt | null; error: string | null } {
  try {
    const raw = localStorage.getItem(receiptKey(taskId, sessionId));
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
function saveReceipt(taskId: string, sessionId: string, requestId: string, text: string): void {
  if (!text.trim() || new TextEncoder().encode(text).length > 16384) throw new Error("消息超过 SDK 16 KiB 上限");
  const existing = readReceipt(taskId, sessionId);
  if (existing.error || (existing.receipt && (existing.receipt.requestId !== requestId || existing.receipt.text !== text))) throw new Error("本机待确认请求记录无法核验，已禁止新请求");
  const value: Receipt = { schema: 1, taskId, sessionId, requestId, text };
  localStorage.setItem(receiptKey(taskId, sessionId), JSON.stringify(value));
  if (localStorage.getItem(receiptKey(taskId, sessionId)) !== JSON.stringify(value)) throw new Error("本机请求记录无法保存，未发送");
}
function clearReceipt(taskId: string, sessionId: string, requestId: string): void {
  const saved = readReceipt(taskId, sessionId);
  if (saved.error || (saved.receipt && saved.receipt.requestId !== requestId)) throw new Error("本机待确认请求记录身份不一致，已禁止发送");
  if (!saved.receipt) return;
  localStorage.removeItem(receiptKey(taskId, sessionId));
  if (localStorage.getItem(receiptKey(taskId, sessionId)) !== null) throw new Error("本机请求记录无法清除，已禁止发送");
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const errorText = (value: unknown) => value instanceof Error ? value.message : "SDK 连接失败，请重新核验";
const parseSnapshot = parseSdkSnapshot;
function parseTurn(value: unknown, taskId: string, sessionId: string, requestId: string): Turn | null {
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

/**
 * #24 the task's own facts from the inventory row the shell already read
 * (`listTasks` → `DesktopTaskSummary`). They are passed in, never re-read here:
 * `repoCount: null` and a blank `branch` are the Host's unreported cases and are
 * named in the header instead of being filled in.
 */
type TaskFacts = { branch: string; repoCount: number | null };
type ConversationProps = TaskFacts & { taskId: string; /** [#139] the session the sidebar asked for; omitted = the task's active session. */ initialSessionId?: string; name: string; roots: string; association: string; onBack: () => void; onOpenProviders: () => void; onArchived: () => void; onSourcesChanged?: () => void };
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

/**
 * #24 the desktop task page's execution-status read. This route has no live
 * store and no approvals list, so `task/executionState` is its only source: an
 * outstanding read, a refused read and a readout the Host left empty are each a
 * named state, and none of them is rendered as a state nobody reported.
 */
type ExecutionRead =
  | { phase: "reading" }
  | { phase: "failed"; error: string }
  | { phase: "read"; view: SessionExecutionView };

/** The Host's answer as text, so a refusal can be quoted instead of paraphrased. */
function hostAnswerText(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text.length > 240 ? `${text.slice(0, 240)}…` : text;
  } catch { return String(value); }
}

function ExecutionCardSection({ children }: { children: ReactNode }) {
  return (
    <section data-testid="desktop-execution-card" aria-label="会话执行状态" className="shrink-0 border-b border-line bg-soft px-4 py-1.5 below-mid:px-3">
      {children}
    </section>
  );
}

/**
 * #24 会话执行状态 card on the desktop task workspace. It repeats the existing
 * view model instead of re-deriving it: `runStateOfExecution`/`executionLabel`
 * (the web card's own label table) and `runRecordFromExecutionState` (the same
 * record shape `TaskPage` renders). The stop entry is NOT duplicated here — the
 * composer's 停止 button stays the single one.
 */
function ExecutionStateCard({ taskId, sessionId: session, read }: { taskId: string; sessionId: string; read: ExecutionRead }) {
  if (read.phase === "reading") {
    return <ExecutionCardSection><p role="status" className="text-[11px] text-muted">正在读取 Host 执行状态…</p></ExecutionCardSection>;
  }
  if (read.phase === "failed") {
    return <ExecutionCardSection>
      <p role="status" data-testid="desktop-execution-error" className="break-words border-l-2 border-[#dfc99f] pl-2 text-[11px] text-[#9a6032]">
        执行状态读取失败：{read.error || "Host 未说明原因"}。本页不显示未读到的状态；请核验后重试。
      </p>
    </ExecutionCardSection>;
  }
  const record = runRecordFromExecutionState(taskId, session, read.view);
  const state = runStateOfExecution(read.view.session) ?? record?.state;
  if (state === undefined) {
    return <ExecutionCardSection>
      <p role="status" data-testid="desktop-execution-unreported" className="break-words text-[11px] text-muted">
        Host 未上报执行状态：本页不推断未上报的状态；有执行记录时以 Host 执行账本为准。
      </p>
    </ExecutionCardSection>;
  }
  return <ExecutionCardSection>
    <strong data-testid="desktop-execution-state" className="text-xs font-semibold text-ink">执行状态 · {executionLabel(state)}</strong>
    {record?.summary ? <p data-testid="desktop-execution-summary" className="mt-0.5 break-words text-[11px] text-muted">{record.summary}</p> : null}
    {record && record.steps.length > 0 ? <details data-testid="desktop-execution-steps" className="mt-1 text-[11px] text-muted">
      <summary className="cursor-pointer">执行步骤（完成 {record.steps.filter((step) => step.state === "done").length} / 共 {record.steps.length}）</summary>
      <ol className="mt-1 flex flex-wrap gap-1.5">
        {record.steps.map((step) => <li key={step.label} className="rounded border border-line bg-paper px-1.5 py-0.5">
          <span className={step.state === "failed" ? "text-[#9a6032]" : step.state === "skipped" ? "text-muted/70" : "text-ink"}>{step.label}</span>
          <span className="ml-1 text-muted">{executionStepLabel(step.state)}</span>
        </li>)}
      </ol>
    </details> : null}
  </ExecutionCardSection>;
}

function TaskConversation({ taskId, initialSessionId, name, branch, repoCount, roots, association, onBack, onOpenProviders, onArchived, onSourcesChanged }: ConversationProps) {
  const bridge = window.pidock;
  /**
   * [#139] Which session this page is showing. The Host's session list is the
   * only source: the page opens the task's ACTIVE session and switches by
   * re-subscribing to the chosen one. `main` is the id the historical single
   * session migrates to and the only id addressable when the list cannot be
   * read, so it is the fallback with a named "未读取" state — never a guess at a
   * session the Host did not report.
   */
  const [sessionList, setSessionList] = useState<SessionListRead>({ phase: "reading" });
  const [activeSessionId, setActiveSessionId] = useState<string>(initialSessionId ?? SDK_SESSION_ID);
  const sessionId = activeSessionId;
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const recovered = useRef(readReceipt(taskId, sessionId));
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
  /**
   * [#117 第 7 项 / 业主定 A] The draft lives in the Host now, so every keystroke
   * would be an IPC round trip. Writes are serialized behind one slot: the
   * newest payload wins, an in-flight save finishes first, and nothing is
   * dropped silently — the last one always reaches the Host.
   */
  const draftSave = useRef<{ running: boolean; pending?: { sessionId: string; text: string; references: Reference[] } }>({ running: false });
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
  /**
   * [#139] Drafts are per session, so a queued payload carries its OWN session id:
   * switching sessions while a save is in flight must not write the old text into
   * the new session (or the new text into the old one).
   */
  const queueDraftSave = useCallback((next: { text: string; references: Reference[] }) => {
    const state = draftSave.current;
    state.pending = { sessionId, ...next };
    if (state.running) return;
    state.running = true;
    void (async () => {
      try {
        while (state.pending !== undefined) {
          const payload = state.pending;
          state.pending = undefined;
          // An emptied composer is stored as an EMPTY draft, not as "no draft":
          // the composer tells "cleared" apart from "never saved" (a pending
          // receipt's text fills the box only when no draft record exists), so
          // clearing here would revive the text of an already-acknowledged send.
          const failure = await saveHostDraft(taskId, { text: payload.text, references: payload.references }, payload.sessionId);
          if (payload.sessionId === sessionId) setDraftError(failure);
        }
      } finally { state.running = false; }
    })();
  }, [sessionId, taskId]);
  const request = useCallback(async (action: string, fields: Record<string, unknown> = {}) => {
    if (!bridge?.sdkTurn) throw new Error("桌面壳 SDK 接口不可用");
    const result = await bridge.sdkTurn({ action, taskId, sessionId, ...fields });
    if (!result || result.ok !== true || !object(result.payload)) throw new Error(result?.error || "SDK 响应不可用");
    return result.payload;
  }, [bridge, sessionId, taskId]);
  const verify = useCallback(async () => {
    const data = await loadDesktopProjects(bridge ?? {});
    if (JSON.stringify(data.inventory.roots) !== rootsRef.current || !allowed(data, taskId) ||
        JSON.stringify(data.associations.find((row) => row.taskId === taskId)) !== association) throw new Error("任务或任务根已变化，请返回列表重新选择");
  }, [association, bridge, taskId]);
  const reconcile = useCallback(async (epoch: number, requestId?: string) => {
    const result = requestId ? await request("status", { requestId }) : null;
    const turn = result ? parseTurn(result.turn, taskId, sessionId, requestId!) : null;
    const projection = parseSnapshot((await request("projection")), sessionId);
    if (epoch !== generation.current || attemptRef.current?.requestId !== requestId) return;
    sequence.current.clear(); streamRef.current = ""; setStream(""); setSnapshot(projection);
    if (requestId && turn && attemptRef.current) {
      if (turn.state !== "accepted") {
        try { clearReceipt(taskId, sessionId, requestId); setReceiptError(null); }
        catch { setReceiptError("本机待确认请求记录无法清除，已禁止发送；请核验本机数据"); }
      }
      setCurrent({ ...attemptRef.current, turnId: turn.turnId, phase: turn.state === "accepted" ? "accepted" : "terminal", state: turn.state });
    }
    else if (requestId && attemptRef.current) setCurrent({ ...attemptRef.current, phase: "unknown" });
    setNotice(turn ? turn.state === "accepted" ? "正在等待模型" : turn.state === "done" ? "已从 SDK 历史核验" : `执行${turn.state === "cancelled" ? "已取消" : "未完成"}${turn.error ? `：${turn.error}` : ""}` :
      requestId ? "请求状态未知；可按原 ID 重试，不能发送新消息" : projection.interrupted ? "会话上次执行中断，请核验后继续" : projection.pending ? "会话正在执行，请等待" : "");
  }, [request, sessionId, taskId]);
  const [connectionKey, setConnectionKey] = useState(0);
  const [openTools, setOpenTools] = useState<DesktopTool[]>([]);
  const [activeTool, setActiveTool] = useState<DesktopTool | null>(null);
  const [toolDockCollapsed, setToolDockCollapsed] = useState(false);
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [unwired, setUnwired] = useState<string | null>(null);
  const [readoutRead, setReadoutRead] = useState<ReadoutRead>({ phase: "reading" });
  const [executionRead, setExecutionRead] = useState<ExecutionRead>({ phase: "reading" });
  const [modelOpen, setModelOpen] = useState(false);
  const [thinkingError, setThinkingError] = useState<string | null>(null);
  const [thinkingBusy, setThinkingBusy] = useState(false);
  const readoutAttempt = useRef(0);
  const executionReadAttempt = useRef(0);
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
        const turn = parseTurn(result.turn, taskId, sessionId, current.requestId);
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
          draftLoaded.current = true;
          const saved = await readHostDraft(taskId, sessionId);
          if (!active()) return;
          setDraftError(saved.error);
          // The Host is the source of truth for both halves: the text and the
          // references the user had attached when the draft was last saved.
          if (saved.draft && draftRevision.current === 0) {
            setDraft(saved.draft.text);
            setReferences(saved.draft.references);
          }
        }
        if (!bridge?.onSdkTurnEvent) throw new Error("SDK 事件接口不可用");
        off = bridge.onSdkTurnEvent(onEvent);
        const reply = await request("subscribe", attemptRef.current ? { requestId: attemptRef.current.requestId } : {});
        if (!active()) { off?.(); void request("unsubscribe").catch(() => {}); return; }
        subscribed = true;
        if (reply.taskId !== taskId || reply.sessionId !== sessionId) throw new Error("SDK 订阅身份异常");
        const projection = parseSnapshot(reply.snapshot, sessionId);
        setSnapshot(projection); setValid(true); setConnected(true);
        if (attemptRef.current) await reconcile(epoch, attemptRef.current.requestId);
        else setNotice(projection.interrupted ? "会话上次执行中断" : projection.pending ? "会话正在执行，请等待" : "");
      } catch (error) { disconnect(errorText(error)); }
    };
    void connect();
    return () => { if (generationRef.current === epoch) generationRef.current++; window.clearInterval(poll); off?.(); if (subscribed) void request("unsubscribe").catch(() => {}); };
  }, [bridge, connectionKey, invalidated, queueDraftSave, reconcile, request, sessionId, taskId, verify]);
  const refresh = async () => {
    const epoch = generation.current;
    try { await verify(); if (epoch !== generation.current) return; await reconcile(epoch, attemptRef.current?.requestId); if (epoch === generation.current) setValid(true); }
    catch (error) { setValid(false); setConnected(false); setNotice(errorText(error)); setInvalidated(true); }
  };
  const start = async (reuse = false) => {
    if (busy.current || !connected || !valid || receiptError || (!reuse && (attemptRef.current?.phase === "unknown" || attemptRef.current?.phase === "accepted" || snapshot?.pending))) return;
    const text = reuse ? attemptRef.current?.text : draft;
    if (!text?.trim()) return;
    // A reference/attachment is part of what the Host fingerprints: a replay
    // reuses the exact context it was accepted with, otherwise the Host would
    // refuse the request id as `idempotency-mismatch`.
    const submittedReferences = references;
    const submittedAttachments = attachments;
    const context: TurnContext = reuse && attemptRef.current?.context
      ? attemptRef.current.context
      : {
          ...(references.length > 0 ? {
            references: references.map((reference) => {
              const source = referenceSourceLabel(reference);
              return { kind: reference.kind, label: reference.label, ...(source ? { source } : {}), ...(reference.detail ? { detail: reference.detail } : {}) };
            }),
          } : {}),
          ...(attachments.length > 0 ? {
            attachments: attachments.map((attachment) => ({ kind: "attachment" as const, label: attachment.name, ...(attachment.detail ? { detail: attachment.detail } : {}) })),
          } : {}),
        };
    const carriesContext = Object.keys(context).length > 0;
    const submittedRevision = draftRevision.current;
    busy.current = true;
    const epoch = generation.current;
    try {
      await verify();
      if (epoch !== generation.current) return;
      const current: Attempt = reuse && attemptRef.current
        ? { ...attemptRef.current, phase: "starting" }
        : { requestId: crypto.randomUUID(), text, phase: "starting", ...(carriesContext ? { context } : {}) };
      saveReceipt(taskId, sessionId, current.requestId, current.text);
      setCurrent(current); setNotice("等待 Host 确认请求"); streamRef.current = ""; setStream(""); sequence.current.clear();
      let result;
      try { result = await request("start", { requestId: current.requestId, text: current.text, ...(carriesContext ? context : {}) }); }
      catch (error) {
        if (epoch !== generation.current) return;
        if (errorText(error).includes("provider-not-configured") || errorText(error).includes("invalid-prompt")) {
          try { clearReceipt(taskId, sessionId, current.requestId); setCurrent(null); setNotice(`无法发送：${errorText(error)}`); }
          catch { setReceiptError("本机待确认请求记录无法清除，已禁止发送；请核验本机数据"); }
        } else { setCurrent({ ...current, phase: "unknown" }); setNotice(`请求结果未知：${errorText(error)}；请核验或按原 ID 重试`); }
        return;
      }
      if (epoch !== generation.current) return;
      const turn = parseTurn(result.turn, taskId, sessionId, current.requestId);
      if (!turn) throw new Error("SDK ACK 缺少请求身份");
      setCurrent({ ...current, turnId: turn.turnId, phase: turn.state === "accepted" ? "accepted" : "terminal", state: turn.state });
      setNotice(turn.state === "accepted" ? "正在等待模型" : "正在核验 SDK 历史");
      if (turn.state === "accepted" && !reuse) {
        if (draftRevision.current === submittedRevision) {
          setDraft("");
          queueDraftSave({ text: "", references: [] });
        }
        // Only the chips that were part of this turn leave the composer; a
        // reference added while the request was in flight stays.
        setReferences((list) => (list === submittedReferences ? [] : list));
        setAttachments((list) => (list === submittedAttachments ? [] : list));
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
    setReferences((current) => {
      if (current.some((entry) => entry.id === id)) return current;
      const next = [...current, reference];
      // A reference is part of the draft the Host stores: attaching one without
      // typing anything must still survive a restart.
      if (valid && connected && !invalidated) queueDraftSave({ text: draft, references: next });
      return next;
    });
  };
  const removeFileReference = (id: string) => setReferences((current) => {
    const next = current.filter((entry) => entry.id !== id);
    if (valid && connected && !invalidated) queueDraftSave({ text: draft, references: next });
    return next;
  });
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
      const current = parseSnapshot(await request("projection"), sessionId);
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
        const status = parseProviderStatus(await providerCall({ taskId, op: "list" }));
        if (live) setProvider(status);
      } catch { if (live) setProvider(null); }
    })();
    return () => { live = false; };
  }, [taskId]);
  // #24 the execution-status read. `task/executionState` is a read only — no
  // write right, no session and no approval — and the page owns no timer for it:
  // it is re-read once per attempt phase this page already observes
  // (`starting` → `accepted` → `terminal`), which is the existing SDK-event path.
  // A late answer from a replaced read is dropped by the attempt counter, and the
  // cleanup invalidates the in-flight read on unmount or phase change.
  const attemptPhase = attempt?.phase;
  useEffect(() => {
    const attempt = ++executionReadAttempt.current;
    void executionStateThroughShell({ taskId, sessionId }).then((result) => {
      if (executionReadAttempt.current !== attempt) return;
      if (!result.ok) { setExecutionRead({ phase: "failed", error: result.error ?? "" }); return; }
      const view = executionStateFromHost(result.payload);
      if (view === null) {
        setExecutionRead({ phase: "failed", error: `Host 返回的执行状态无法解析：${hostAnswerText(result.payload)}` });
        return;
      }
      setExecutionRead({ phase: "read", view });
    });
    return () => { executionReadAttempt.current += 1; };
    // [#139] The execution readout is per SESSION: switching sessions re-reads it.
  }, [attemptPhase, sessionId, taskId]);
  /**
   * [#139] The session list is the page's only session truth. It is read once
   * per task (and after every session write), and a failed read is a named state:
   * the page then keeps addressing the migrated `main` session, which the Host
   * always keeps for a task that predates this ticket.
   */
  const loadSessions = useCallback(async (options: { adoptActive?: boolean } = {}) => {
    const result = await readTaskSessions(taskId);
    if (!result.ok) { setSessionList({ phase: "failed", error: result.error }); return; }
    setSessionList({ phase: "read", list: result.list });
    if (options.adoptActive !== false) {
      const target = result.list.activeSessionId ?? result.list.sessions.find((session) => !session.archived)?.id ?? SDK_SESSION_ID;
      setActiveSessionId((current) => (result.list.sessions.some((session) => session.id === current && !session.archived) ? current : target));
    }
  }, [taskId]);
  useEffect(() => { void loadSessions(); }, [loadSessions]);
  // The sidebar's session rows navigate here: an explicitly named session wins
  // over the task's stored active pointer until the user picks another one.
  useEffect(() => {
    if (initialSessionId !== undefined) setActiveSessionId((current) => (current === initialSessionId ? current : initialSessionId));
  }, [initialSessionId]);
  const sessions = sessionList.phase === "read" ? sessionList.list.sessions : [];
  const activeSession = sessions.find((session) => session.id === sessionId) ?? null;
  /**
   * [#139] Switching a session is a re-subscribe: every per-session value this
   * page held (draft, references, attachments, pending receipt, snapshot, stream)
   * is reloaded from the Host for the session being entered. The outgoing
   * session's draft was already saved per keystroke, so nothing typed is lost and
   * nothing is cross-delivered.
   */
  const resetForSession = useCallback((next: string) => {
    const receipt = readReceipt(taskId, next);
    draftRevision.current = 0;
    draftLoaded.current = false;
    draftSave.current.pending = undefined;
    setDraft(receipt.receipt?.text ?? "");
    setReferences([]);
    setAttachments([]);
    setAttachmentReport(null);
    setDraftError(null);
    setReceiptError(receipt.error);
    setCurrent(receipt.receipt ? { ...receipt.receipt, phase: "unknown" } : null);
    streamRef.current = ""; setStream(""); sequence.current.clear();
    setSnapshot(null); setInvalidated(false); setConnected(false); setValid(false);
    setNotice("正在连接 SDK 会话");
    setActiveSessionId(next);
  }, [taskId]);
  const switchToSession = async (target: TaskSession) => {
    if (target.id === sessionId) { setSessionsOpen(false); return; }
    if (target.archived) { setSessionNotice(`「${target.name}」已归档，不能继续对话；请先恢复。`); return; }
    setSessionBusy(true); setSessionNotice(null);
    const result = await activateSession(taskId, target.id);
    setSessionBusy(false);
    if (!result.ok) { setSessionNotice(result.error); return; }
    setSessionList({ phase: "read", list: result.list });
    resetForSession(target.id);
    setSessionsOpen(false);
  };
  const newSession = async (name?: string) => {
    if (sessionBusy) return;
    setSessionBusy(true); setSessionNotice(null);
    const result = await createSession(taskId, name === undefined ? {} : { name });
    setSessionBusy(false);
    if (!result.ok) { setSessionNotice(result.error); return; }
    setSessionList({ phase: "read", list: result.list });
    const created = result.list.sessions.find((session) => session.id === result.list.activeSessionId);
    if (created) resetForSession(created.id);
    setSessionsOpen(false);
  };
  const applySessionWrite = (result: { ok: true; list: SessionList } | { ok: false; error: string }) => {
    if (!result.ok) { setSessionNotice(result.error); return; }
    setSessionList({ phase: "read", list: result.list });
  };
  const renameOne = async () => {
    if (renaming === null || sessionBusy) return;
    setSessionBusy(true);
    applySessionWrite(await renameSession(taskId, renaming.id, renaming.name));
    setSessionBusy(false);
    setRenaming(null);
  };
  const archiveOne = async (id: string) => {
    if (sessionBusy) return;
    setSessionBusy(true);
    const result = await archiveSession(taskId, id);
    setSessionBusy(false);
    applySessionWrite(result);
    // Archiving the session being shown moves the page to the next real one.
    if (result.ok && id === sessionId) {
      const next = result.list.activeSessionId;
      if (next !== null) resetForSession(next);
    }
  };
  const restoreOne = async (id: string) => {
    if (sessionBusy) return;
    setSessionBusy(true);
    applySessionWrite(await restoreSession(taskId, id));
    setSessionBusy(false);
  };
  const deleteOne = async (id: string) => {
    if (sessionBusy) return;
    setSessionBusy(true);
    const result = await deleteSession(taskId, id);
    setSessionBusy(false);
    applySessionWrite(result);
    if (result.ok && id === sessionId) {
      const next = result.list.activeSessionId;
      if (next !== null) resetForSession(next);
      else { setSnapshot(null); setValid(false); setConnected(false); setActiveSessionId(SDK_SESSION_ID); }
    }
  };

  /**
   * [#139] 推理/上下文/模型 read ONE session readout (`task/sessionReadout`),
   * which the Host derives from this session's own SDK JSONL and its bound model —
   * not from the legacy `task/sessionContext` defaults. `null` means unknown.
   * The attempt counter makes a late answer from a replaced read (or from the
   * session the user just left) unable to overwrite the current one.
   */
  const loadReadout = useCallback(async () => {
    const attempt = readoutAttempt.current + 1;
    readoutAttempt.current = attempt;
    setReadoutRead({ phase: "reading" });
    const result = await readSessionReadout(taskId, sessionId);
    if (readoutAttempt.current !== attempt) return;
    setReadoutRead(result.ok ? { phase: "read", readout: result.readout } : { phase: "failed", error: result.error });
  }, [sessionId, taskId]);
  useEffect(() => { void loadReadout(); }, [loadReadout]);
  const readout = readoutRead.phase === "read" ? readoutRead.readout : null;
  /** The model this session is actually bound to: its own binding, else the installed default. */
  const boundModelId = readout?.session.binding?.modelId
    ?? (sessionList.phase === "read" ? sessionList.list.provider?.modelId : undefined)
    ?? null;
  const providerModels = sessionList.phase === "read" ? sessionList.list.provider?.models ?? [] : [];
  const boundModel = readout?.model ?? providerModels.find((row) => row.id === boundModelId) ?? null;
  /** Only the levels THIS model declares; a model without reasoning offers none (never a fake `off`). */
  const reasoningLevels = readout?.reasoningLevels ?? providerModels.find((row) => row.id === boundModelId)?.reasoningLevels ?? [];
  const thinkingLevel = readout?.session.binding?.thinkingLevel ?? null;
  const thinkingLabel = readoutRead.phase === "reading"
    ? "正在读取推理档位"
    : readoutRead.phase === "failed" ? `推理档位读取失败：${readoutRead.error}`
    : reasoningLevels.length === 0 ? "该模型不支持推理档位"
    : `推理 · ${thinkingLevel === null ? "跟随模型" : REASONING_LEVEL_TEXT[thinkingLevel] ?? thinkingLevel}`;

  const chooseModel = async (modelId: string, level?: SessionThinkingLevel) => {
    if (thinkingBusy) return;
    setThinkingBusy(true);
    setThinkingError(null);
    const result = await switchSessionModel(taskId, sessionId, modelId, level);
    setThinkingBusy(false);
    if (!result.ok) { setThinkingError(result.error); return; }
    readoutAttempt.current += 1;
    setReadoutRead({ phase: "read", readout: result.readout });
    setModelOpen(false);
    void loadSessions({ adoptActive: false });
  };
  const chooseThinking = async (level: SessionThinkingLevel) => {
    if (thinkingBusy) return;
    setThinkingBusy(true);
    setThinkingError(null);
    const result = await setSessionReasoning(taskId, sessionId, level);
    setThinkingBusy(false);
    if (!result.ok) { setThinkingError(result.error); return; }
    readoutAttempt.current += 1;
    setReadoutRead({ phase: "read", readout: result.readout });
  };
  /** `used` is the prompt size of this session's last request; `null` is unknown, never 0. */
  const contextLabel = readout === null
    ? `上下文 ${readoutRead.phase === "reading" ? "未读取" : "读取失败"}`
    : `上下文 ${readout.context.used === null ? "未报告" : `${(readout.context.used / 1000).toFixed(1)}k`} / ${readout.context.window === null ? "窗口未知" : `${Math.round(readout.context.window / 1000)}k`}`;
  const contextTitle = readoutRead.phase === "reading"
    ? "正在读取本会话的 SDK 上下文占用；读取完成前不显示数字"
    : readoutRead.phase === "failed" ? `本会话上下文读数读取失败：${readoutRead.error}`
    : readout === null ? "Host 未返回会话读数"
      : `本会话最近一次请求的提示词占用 ${readout.context.used === null ? "未报告（未知）" : `${readout.context.used} tokens`} · 绑定模型窗口 ${readout.context.window === null ? "未知" : `${readout.context.window} tokens`} · 来源 ${readout.context.source}；SDK 未报告时保持未知，不按 0 显示`;

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
            {/* #24: the branch and repository count the sidebar card already shows
                (`DesktopShell.tsx` `TaskNavCard`), rendered from the SAME inventory
                row passed down by `DesktopInventory` — no second `listTasks` read and
                no locally derived count. A fact the Host did not report is named:
                a blank chip, an `undefined`, or a guessed `main` would each claim
                knowledge this read does not have. */}
            <Badge data-testid="desktop-conversation-branch" variant="soft" title="本任务分支 · 来自 Host 任务清单" className={`max-w-full ${branch.length > 0 ? "" : "border-[#dfc99f] text-[#9a6032]"}`}>
              <Icon name="branch" /><span className="min-w-0 truncate">{hostText(branch, "Host 未上报分支")}</span>
            </Badge>
            <Badge data-testid="desktop-conversation-repo-count" variant="soft" title="本任务仓库数 · 来自 Host 任务清单" className={repoCount === null ? "border-[#dfc99f] text-[#9a6032]" : undefined}>
              <Icon name="folder" />{repoCount === null ? "Host 未上报仓库数" : `${repoCount} 仓库`}
            </Badge>
            <span data-testid="desktop-session-identity" className="inline-flex min-w-0 items-center gap-1" title="当前会话 · 由 Host 会话索引拥有">
              <Icon name="settings" /><span className="truncate">会话 · {activeSession?.name ?? sessionId}</span>
              {activeSession?.archived ? <Badge variant="soft">已归档</Badge> : null}
            </span>
            {/* [PiDock 02m] #5: this kernel's tool path is real, so the header
                carries the two facts a reader can check instead of the old
                claim that it had none. `installSdkProvider` always hands the
                Host's `SdkAgentToolBroker` to the model context
                (`task-host.ts`); the kernel offers exactly the declared task
                tools and refuses to run if the session reports anything else
                (`sdk-text-kernel.ts`); and every mutating call claims the task
                write right before its effect, with a read-tier session refused
                (`sdk-agent-tool-broker.ts` `runWithGate`). What is NOT claimed
                here is a confirmation per write: under `default` only command
                and browser tools ask (`pi-session.ts` `previewGate`). */}
            <Badge variant="soft">工具由 Host 代执行</Badge>
            <Badge variant="soft">写操作受 Host 写权约束</Badge>
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
      {/* [#139] S01's session rows / S08's session list, in the conversation's own
          header: the task's sessions with the active marker, a 新建会话 entry and
          the full list. Nothing here is a tab bar of conversations the Host does
          not have — every row is a session the Host reported. */}
      <div data-testid="desktop-session-strip" className="flex flex-wrap items-end gap-1 text-[12px]" role="tablist" aria-label="会话">
        {sessionList.phase === "reading" && <span className="pb-2 text-[11px] text-muted">正在读取会话列表…</span>}
        {sessionList.phase === "failed" && <span data-testid="desktop-session-list-error" role="status" className="pb-2 text-[11px] text-[#9a6032]">会话列表读取失败：{sessionList.error}；当前仅能寻址 main 会话</span>}
        {sessions.filter((session) => !session.archived).slice(0, 4).map((session) => (
          <button key={session.id} type="button" role="tab" aria-selected={session.id === sessionId} data-testid={`session-tab-${session.id}`}
            title={`${session.name} · ${session.binding?.modelId ?? "跟随任务模型"}`}
            onClick={() => void switchToSession(session)}
            className={`max-w-[180px] truncate border-b-2 px-2 pb-2 ${session.id === sessionId ? "border-accent font-semibold text-ink" : "border-transparent text-muted hover:text-ink"}`}>
            {session.name}
          </button>
        ))}
        {sessions.filter((session) => !session.archived).length > 4 && <span className="pb-2 text-[11px] text-muted">+{sessions.filter((session) => !session.archived).length - 4}</span>}
        <Button type="button" size="sm" variant="ghost" data-testid="session-new" disabled={sessionBusy} onClick={() => void newSession()}><Icon name="plus" />新建会话</Button>
        <Button type="button" size="sm" variant="ghost" data-testid="session-all" onClick={() => setSessionsOpen(true)}>全部会话 {sessions.length}</Button>
        {sessions.length === 0 && sessionList.phase === "read" && <span className="pb-2 text-[11px] text-muted">本任务暂无会话；新建一个即拥有全新上下文</span>}
      </div>
    </div>
    <ExecutionStateCard taskId={taskId} sessionId={sessionId} read={executionRead} />
    {/* [Pencil T07] ticket 142: a created task lands on its `main` conversation entry
        even when no Provider/model is configured. The entry names that missing
        configuration and routes to 能力管理 → Providers; it never picks a
        profile, never sends a turn and never calls a model on its own. */}
    {provider !== null && provider.state !== "configured" && (
      <div role="status" data-testid="provider-requirement"
        className="shrink-0 border-b border-line bg-soft px-4 py-2 text-[11px] leading-5 text-[#9a6032] below-mid:px-3">
        <p>
          尚未配置可用的 Provider / 模型（{PROVIDER_STATE_TEXT[provider.state]}）：任务已创建，但本任务不会自动选择或调用模型。
          请先在「能力管理 → Providers」完成配置后，再在此会话开始对话。
        </p>
        <Button type="button" size="sm" variant="outline" className="mt-1" onClick={onOpenProviders} aria-label="前往能力管理 · Providers 配置模型">
          前往能力管理 · Providers
        </Button>
      </div>
    )}
    {archivePrompt && <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4">
      <div role="dialog" aria-modal="true" aria-label="归档当前任务" className="w-full max-w-[440px] rounded-[7px] border border-line bg-paper p-5 shadow-lg">
        <h2 className="text-base font-semibold">归档当前任务</h2>
        <p className="mt-3 text-xs leading-6 text-muted">归档只停止正在执行的 Agent 回合；已在运行的服务与终端不会被它停止。未执行确认会失效、定时任务暂停，代码和历史保留。恢复后服务与定时任务不会自动启动，清理需要单独处理。</p>
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
    {sessionsOpen && <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label="全部会话" data-testid="session-panel">
      <div className="max-h-[80vh] w-[min(560px,100%)] overflow-y-auto rounded-[10px] border border-line bg-paper p-4 shadow-lg">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold">全部会话</h2>
            <p className="mt-0.5 text-[11px] text-muted">一个任务可有多个会话，共享同一工作区与仓库；每个会话有自己的上下文、模型绑定与 SDK JSONL。</p>
          </div>
          <Button type="button" size="sm" variant="ghost" aria-label="关闭会话列表" onClick={() => { setSessionsOpen(false); setRenaming(null); }}>×</Button>
        </div>
        {sessionNotice && <p role="alert" data-testid="session-notice" className="mt-2 rounded-[6px] border border-[#e0b4b4] bg-[#fdf3f3] p-2 text-[11px] leading-5 break-words text-[#ad4545]">{sessionNotice}</p>}
        <ul className="mt-3 space-y-1.5">
          {sessions.length === 0 && <li className="text-[11px] text-muted">本任务还没有会话。</li>}
          {sessions.map((session) => <li key={session.id} data-testid={`session-row-${session.id}`} className={`rounded-[7px] border p-2 ${session.id === sessionId ? "border-accent bg-soft" : "border-line"}`}>
            {renaming?.id === session.id ? <form className="flex min-w-0 items-center gap-1.5" onSubmit={(event) => { event.preventDefault(); void renameOne(); }}>
              <input aria-label="会话名称" value={renaming.name} maxLength={40} autoFocus className="min-w-0 flex-1 rounded-[5px] border border-line bg-bg px-1.5 py-1 text-[12px]" onChange={(event) => setRenaming({ id: session.id, name: event.target.value })} />
              <Button type="submit" size="sm" disabled={sessionBusy || !renaming.name.trim() || renaming.name === session.name}>保存</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(null)}>取消</Button>
            </form> : <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{session.name}</span>
              {session.id === sessionId && <Badge variant="soft">当前</Badge>}
              {session.archived && <Badge variant="soft">已归档</Badge>}
              <span className="text-[10px] text-muted">{session.binding?.modelId ?? "跟随任务模型"} · {session.id}</span>
            </div>}
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <Button type="button" size="sm" variant="ghost" disabled={sessionBusy || session.archived || session.id === sessionId} onClick={() => void switchToSession(session)}>{session.archived ? "已归档" : session.id === sessionId ? "当前会话" : "继续对话"}</Button>
              <Button type="button" size="sm" variant="ghost" disabled={sessionBusy} onClick={() => setRenaming({ id: session.id, name: session.name })}>重命名</Button>
              {session.archived
                ? <Button type="button" size="sm" variant="ghost" disabled={sessionBusy} onClick={() => void restoreOne(session.id)}>恢复</Button>
                : <Button type="button" size="sm" variant="ghost" disabled={sessionBusy} onClick={() => void archiveOne(session.id)}>归档</Button>}
              <Button type="button" size="sm" variant="ghost" disabled={sessionBusy} onClick={() => void deleteOne(session.id)}>删除</Button>
            </div>
          </li>)}
        </ul>
        <div className="mt-3 flex items-center gap-2">
          <Button type="button" size="sm" disabled={sessionBusy || sessions.length >= 50} onClick={() => void newSession()}><Icon name="plus" />新建会话</Button>
          <span className="text-[10px] text-muted">新会话从零开始：不复用任何会话的历史。删除会话会同时删除它的 SDK 记录，无法恢复。</span>
        </div>
      </div>
    </div>}
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
          <p className="mt-1 text-[11px] text-muted">引用随消息提交：Host 会把类型、来源与路径附在提示词末尾，供 Agent 定位；引用不读取也不写入文件，文件内容不在提示词里。</p>
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
          <p data-testid="desktop-composer-attachment-scope" className="mt-1 text-[11px] text-muted">附件随消息提交：Host 只附上名称与来源行，内容不上传、不读取，Agent 拿到的是清单而不是文件。</p>
        </div>}
        <textarea aria-label="消息" value={draft} onChange={(event) => { const text = event.target.value; draftRevision.current++; setDraft(text); if (valid && connected && !invalidated) queueDraftSave({ text, references }); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); if (!blocked) void start(); } }} rows={2} maxLength={16384} className="w-full min-w-0 resize-y border-0 bg-transparent p-1 text-sm outline-none" placeholder="描述你想做什么（仅支持文本消息）" />
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted">
          <Tooltip><TooltipTrigger asChild><span tabIndex={0} aria-label="附件说明" className="inline-flex">
            <Button type="button" size="icon-sm" data-testid="desktop-composer-attach" aria-label="添加附件" onClick={() => attachmentInput.current?.click()} className="text-muted"><Icon name="plus" /></Button>
          </span></TooltipTrigger><TooltipContent>附件随消息提交：Host 只附上名称与来源行，内容不上传、不读取，Agent 拿到的是清单而不是文件</TooltipContent></Tooltip>
          <input ref={attachmentInput} type="file" multiple aria-label="附件选择" data-testid="desktop-composer-file-input" className="hidden" onChange={(event) => { addAttachments(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          <Tooltip><TooltipTrigger asChild><span tabIndex={0} aria-label="权限说明" className="inline-flex">
            <Button type="button" size="sm" disabled aria-label="权限（未接线）：本页不能切换档位"><Icon name="shield" />权限（未接线）</Button>
          </span></TooltipTrigger><TooltipContent>权限切换未接线：本页不能改档位。工具已接线，由 Host 决定并代执行；写操作受 Host 权限档位与任务写权约束 —— 只读档拒绝一切写与命令，默认档下命令类工具先要一次确认，文件写入只在任务工作副本内</TooltipContent></Tooltip>
          {/* [#139] 模型胶囊 + 紧凑推理分段 + 上下文占用: the three entries the
              composer shows for this SESSION. The model pill opens this
              session's own model menu (切换保留历史); the segmented control lists
              only the levels the bound model declares — a model without
              reasoning offers none, and no `off` is fabricated for it. */}
          <div className="relative">
            <Button type="button" size="sm" data-testid="composer-model" aria-haspopup="menu" aria-expanded={modelOpen}
              title={boundModel === null ? "本会话尚未绑定模型：先在「能力管理 → Providers」完成配置" : `${boundModel.name} · 窗口 ${boundModel.contextWindow} tokens · 切换模型保留本会话历史`}
              onClick={() => { setThinkingError(null); setModelOpen((open) => !open); }}>
              <span data-testid="composer-model-name">{boundModel === null ? (provider ? "未配置模型" : "正在读取模型") : boundModel.name}</span><Icon name="down" className="h-3 w-3" />
            </Button>
            {modelOpen && <div role="menu" aria-label="会话模型" className="absolute right-0 bottom-full z-30 mb-1 w-[280px] rounded-[7px] border border-line bg-paper p-2 text-left shadow-md">
              {providerModels.length === 0 ? <p className="px-1 text-[10px] leading-5 text-muted">Host 未返回当前 Provider 的模型列表；切换模型不可用。</p> : <>
                <p className="px-1 pb-1 text-[10px] leading-5 text-muted">切换只改本会话的绑定：历史与 JSONL 不变，后续回合用新模型。窗口装不下本会话上下文或回合进行中时，Host 会按名字拒绝。</p>
                {providerModels.map((row) => <Button key={row.id} type="button" role="menuitemradio" aria-checked={row.id === boundModelId} variant="ghost" size="sm" className="w-full justify-start" disabled={thinkingBusy} onClick={() => void chooseModel(row.id)}>{row.name}<span className="ml-auto text-muted">{Math.round(row.contextWindow / 1000)}k · {row.reasoningLevels.length === 0 ? "无推理档位" : `${row.reasoningLevels.length} 档`}</span></Button>)}
                <Button type="button" variant="ghost" size="sm" className="mt-1 w-full justify-start" onClick={() => { setModelOpen(false); onOpenProviders(); }}><Icon name="settings" />能力管理 · Providers</Button>
              </>}
              {thinkingError && <p role="alert" className="mt-1 border border-[#e0b4b4] bg-[#fdf3f3] p-1.5 text-[10px] leading-5 break-words text-[#ad4545]">{thinkingError}</p>}
            </div>}
          </div>
          <div data-testid="composer-reasoning" role="group" aria-label="推理档位" title={thinkingLabel} className="inline-flex min-w-0 items-center gap-0.5 rounded-[6px] border border-line bg-soft px-0.5">
            {readoutRead.phase !== "read" ? <span className="px-1.5 py-0.5 text-[10px] text-muted">{readoutRead.phase === "reading" ? "推理档位未读取" : "推理档位读取失败"}</span>
              : reasoningLevels.length === 0 ? <span className="px-1.5 py-0.5 text-[10px] text-muted">无推理档位</span>
              : reasoningLevels.map((level: SessionThinkingLevel) => <Button key={level} type="button" size="sm" variant={level === thinkingLevel ? "secondary" : "ghost"} aria-pressed={level === thinkingLevel} disabled={thinkingBusy} className="h-6 px-1.5 text-[10px]" onClick={() => void chooseThinking(level)}>{REASONING_LEVEL_TEXT[level] ?? level}</Button>)}
          </div>
          {thinkingError && readoutRead.phase === "read" && <span role="alert" className="min-w-0 break-words text-[10px] text-[#ad4545]">{thinkingError}</span>}
          <span data-testid="composer-context" title={contextTitle} className="min-w-0 break-words">{contextLabel}</span>
          <span data-testid="composer-usage" title={`${usageDetail} 本会话 SDK 累计：${readout?.usage ? `输入 ${readout.usage.input} / 输出 ${readout.usage.output} / 缓存读 ${readout.usage.cacheRead} / 写 ${readout.usage.cacheWrite}（${readout.turns} 条回复）` : "SDK 未报告"}`} className="ml-auto min-w-0 break-words">
            {!usageSnapshot ? "近期用量未核验" : reportedMessages.length ? `近期已报告输入+输出 ${recentTokens} tokens` : "近期用量未报告"}
          </span>
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
