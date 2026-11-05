import { type SidebarAction } from "./SidebarMenu";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Message as ChatMessage, MessageContent, MessageHeader } from "./ui/message";
import { Bubble, BubbleContent } from "./ui/bubble";
import { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerButton } from "./ui/message-scroller";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { cn } from "../lib/utils";
import { ConversationMarkdown } from "./ConversationMarkdown";
import { Icon } from "./Icon";
import { loadDesktopProjects, type DesktopProjects } from "../data/desktopProjects";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { PROVIDER_STATE_TEXT, parseProviderStatus, providerCall, type ProviderStatus } from "../data/providerProfile";
import { SDK_SESSION_ID, parseSdkSnapshot, type SdkMessage } from "../data/sdkSession";
import { readHostDraft, saveHostDraft } from "../data/draftStore";
import { executionStateThroughShell, fileStatThroughShell, listApprovalsThroughShell, resolveApprovalThroughShell, setTaskArchivedThroughShell, shellTaskOp } from "../data/shellBridge";
import { DesktopApprovalCard, type ApprovalRead } from "./DesktopApprovalCard";
import { DesktopDeliverySheet } from "./DesktopDeliverySheet";
import { TaskActionMenu, type TaskActionMenuItem } from "./TaskActionMenu";
import { approvalFailureText, approvalRequest, parseTaskApprovals, type ApprovalDecision, type TaskApproval } from "../data/toolApproval";
import { executionStateFromHost, runRecordFromExecutionState, runStateOfExecution, type SessionExecutionView } from "../data/executionLedger";
import { executionLabel, executionStepLabel } from "../pages/executionView";
import { TurnStream } from "../data/turnStream";
import {
  activateSession, archiveSession, createSession, deleteSession, formatWindow, mergeSessionList, readSessionReadout, readTaskSessions,
  REASONING_LEVEL_TEXT, renameSession, restoreSession, sessionActionRows, setSessionReasoning, stopSession, switchSessionModel,
  type SessionActionId, type SessionLifecycleReply, type SessionList, type SessionReadout, type SessionThinkingLevel, type TaskSession,
} from "../data/taskSessions";
import { definiteTurnRefusal } from "../data/turnRefusal";
import { parseLifecycle } from "./DesktopArchivePage";
import { attachmentRefusal, attachmentSelectionReport, attachmentSourceLabel, classifyComposerAttachment, describeReferenceChip, referenceProvenance, referenceSourceLabel, type CandidateRow } from "../data/composerRules";
import type { Reference } from "../data/types";
import { DesktopToolDock, DESKTOP_TOOL_ICONS, DESKTOP_TOOL_LABELS, DESKTOP_TOOLS_UNWIRED, type DesktopTool } from "./DesktopToolDock";
import { DesktopTaskSources } from "./DesktopTaskSources";
import { BrandMark, LocalUserAvatar } from "./ui";
import { hostText } from "../data/workspaceFiles";
import { REFERENCE_KIND_TEXT, referenceFileFact, referenceFileIssue, referenceIssues, referenceRootFacts, referenceRootId, referenceSendRefusal, rootReferenceIssue, type ReferenceIssue } from "../data/referenceGuard";
import { splitPromptContext } from "../data/historyReferences";
import { useDraftStore } from "../stores/drafts";

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
/** [Pencil T19] #145 one keystroke burst becomes one Host draft write. */
const DRAFT_SAVE_DEBOUNCE_MS = 200;
// One SDK subscription belongs to the sender. Complete a stale subscribe and
// its teardown before another session can install its subscription on that sender.
const subscriptionWork = new WeakMap<object, Promise<void>>();
function enqueueSubscription<T>(bridge: object | undefined, work: () => Promise<T>): Promise<T> {
  if (!bridge) return Promise.reject(new Error("桌面壳 SDK 接口不可用"));
  const previous = subscriptionWork.get(bridge) ?? Promise.resolve();
  const result = previous.then(work, work);
  subscriptionWork.set(bridge, result.then(() => {}, () => {}));
  return result;
}
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
type ConversationProps = TaskFacts & { sidebarAction?: SidebarAction | null; onSidebarActionConsumed?: () => void; onSessionSelected?: (sessionId: string) => void; toolbarTarget?: HTMLElement | null; taskId: string; /** [#139] the session the sidebar asked for; omitted = the task's active session. */ initialSessionId?: string; name: string; roots: string; association: string; onBack: () => void; onOpenProviders: () => void; onArchived: () => void; onSourcesChanged?: () => void };
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
    <section data-testid="desktop-execution-card" aria-label="会话执行状态" className="min-w-0 rounded-md border border-line bg-paper px-3 py-1.5">
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
function ExecutionStateCard({ taskId, sessionId: session, read, approvals }: { taskId: string; sessionId: string; read: ExecutionRead; approvals: readonly TaskApproval[] }) {
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
  const reported = runStateOfExecution(read.view.session) ?? record?.state;
  // [Pencil T05] ticket 140: a tool call parked on a pending confirmation is still an
  // `executing` turn in the Host's execution ledger, so the card used to say
  // 执行中 while the approval card asked for a decision. The REAL pending record
  // (`task/listApprovals`) wins: 等待确认 until that record is settled, then the
  // ledger's own state (执行中/…) returns. A foreign session's record never
  // turns THIS session's card into a waiting state.
  const pendingApproval = approvals.some((approval) => approval.status === "pending" && !approval.foreign);
  const state = pendingApproval ? "approval" : reported;
  if (state === undefined) {
    return <ExecutionCardSection>
      <details className="text-[11px] text-muted"><summary className="cursor-pointer">执行状态未报告</summary><p role="status" data-testid="desktop-execution-unreported">Host 未上报执行状态：本页不推断未上报的状态；有执行记录时以 Host 执行账本为准。</p></details>
    </ExecutionCardSection>;
  }
  return <ExecutionCardSection>
    <div className="flex min-w-0 flex-wrap items-center gap-2"><strong data-testid="desktop-execution-state" className="text-[11px] font-medium text-ink">执行状态 · {executionLabel(state)}</strong>
    {record?.summary ? <p data-testid="desktop-execution-summary" className="min-w-0 truncate text-[10px] text-muted">{record.summary}</p> : null}
    {record && record.steps.length > 0 ? <details data-testid="desktop-execution-steps" className="text-[10px] text-muted">
      <summary className="cursor-pointer">执行步骤（完成 {record.steps.filter((step) => step.state === "done").length} / 共 {record.steps.length}）</summary>
      <ol className="mt-1 flex flex-wrap gap-1.5">
        {record.steps.map((step) => <li key={step.label} className="rounded border border-line bg-paper px-1.5 py-0.5">
          <span className={step.state === "failed" ? "text-[#9a6032]" : step.state === "skipped" ? "text-muted/70" : "text-ink"}>{step.label}</span>
          <span className="ml-1 text-muted">{executionStepLabel(step.state)}</span>
        </li>)}
      </ol>
    </details> : null}</div>
  </ExecutionCardSection>;
}

function TaskConversation({ sidebarAction, onSidebarActionConsumed, onSessionSelected, toolbarTarget, taskId, initialSessionId, name, branch, repoCount, roots, association, onBack, onOpenProviders, onArchived, onSourcesChanged }: ConversationProps) {
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
  /** True once the reader has chosen a session in this mount; see `loadSessions`. */
  const picked = useRef(initialSessionId !== undefined);
  const [activeSessionId, setActiveSessionId] = useState<string>(initialSessionId ?? SDK_SESSION_ID);
  const sessionId = activeSessionId;
  const sessions = sessionList.phase === "read" ? sessionList.list.sessions : [];
  const activeSession = sessions.find((session) => session.id === sessionId) ?? null;
  const historyReadOnly = activeSession?.archived === true;
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const renameInput = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  /**
   * [#146] Delete is the only irreversible session action, so it is always asked
   * for explicitly. The dialog names the real impact (history + drafts go, the
   * task workspace and the user's own directories stay, scheduled history keeps
   * an explicit deleted state); nothing is deleted by a single click.
   */
  const deleteCancel = useRef<HTMLButtonElement>(null);
  const [deletePrompt, setDeletePrompt] = useState<TaskSession | null>(null);
  /** What a lifecycle write really did (`已停止 1 个回合` / `该会话没有执行中的回合`). */
  const [lifecycleNotice, setLifecycleNotice] = useState<string | null>(null);
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
  /**
   * [Pencil T10] #145 发送前的引用重检结果。`issues` 按芯片 id 命名，芯片上直接
   * 标出原因；发送被拒绝时草稿和引用都留在本会话，不丢输入也绝不静默改来源。
   */
  const [referenceProblems, setReferenceProblems] = useState<ReferenceIssue[]>([]);
  const [referenceReport, setReferenceReport] = useState<string | null>(null);
  const messageInput = useRef<HTMLTextAreaElement | null>(null);
  const attachmentInput = useRef<HTMLInputElement | null>(null);
  const attachmentSequence = useRef(0);
  const draftLoaded = useRef(false);
  const draftRevision = useRef(0);
  /**
   * [#117 第 7 项 / 业主定 A] The draft lives in the Host now. Writes are
   * debounced and serialized behind one slot: the newest payload wins, an
   * in-flight save finishes first, and nothing is dropped silently — the last
   * one always reaches the Host.
   *
   * [Pencil T19] #145 B1: a save is NOT gated on the SDK connection. The Host
   * task process can store a draft before `subscribe` settles; gating on
   * `valid && connected` dropped exactly the text typed while the page was
   * connecting (the evidence's "readDraft returns null" case). A refusal is
   * named and the payload stays pending, so the next connect/keystroke retries.
   */
  type DraftPayload = { sessionId: string; text: string; references: Reference[]; revision: number };
  const draftSave = useRef<{
    timer?: ReturnType<typeof setTimeout>;
    pending?: DraftPayload;
  }>({});
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const [receiptError, setReceiptError] = useState(recovered.current.error);
  const [attempt, setAttempt] = useState<Attempt | null>(recovered.current.receipt ? { ...recovered.current.receipt, phase: "unknown" } : null);
  const attemptRef = useRef<Attempt | null>(recovered.current.receipt ? { ...recovered.current.receipt, phase: "unknown" } : null);
  const [toolPreviews, setToolPreviews] = useState<{ turnId: string; callId: string; tool: string; text: string; failed?: boolean }[]>([]);
  const [stream, setStream] = useState("");
  const streamRef = useRef("");
  const [notice, setNotice] = useState("正在连接 SDK 会话");
  const [valid, setValid] = useState(false);
  const [connected, setConnected] = useState(false);
  const [invalidated, setInvalidated] = useState(false);
  const generation = useRef(0);
  /**
   * [#138] 暂存回复的顺序闸门：ACK 之前的增量先按回合暂存，ACK 时回放并按首条增量
   * 锚定基线；重复/回退丢弃且不清空暂存，只有真正的缺口才 resync。
   */
  const turnStream = useRef(new TurnStream());
  const busy = useRef(false);
  const composing = useRef(false);
  const rootsRef = useRef(roots);
  const setCurrent = (next: Attempt | null) => { attemptRef.current = next; setAttempt(next); };
  /**
   * [#139] Drafts are per session, so a queued payload carries its OWN session id:
   * switching sessions while a save is in flight must not write the old text into
   * the new session (or the new text into the old one).
   */
  const writeDraft = useCallback((payload: DraftPayload) => {
    void (async () => {
      // An emptied composer is stored as an EMPTY draft, not as "no draft":
      // the composer tells "cleared" apart from "never saved" (a pending
      // receipt's text fills the box only when no draft record exists), so
      // clearing here would revive the text of an already-acknowledged send.
      const failure = await saveHostDraft(taskId, { text: payload.text, references: payload.references }, payload.sessionId);
      if (payload.sessionId === sessionIdRef.current) setDraftError(failure);
      if (failure !== null && payload.sessionId === sessionIdRef.current &&
          payload.revision === draftRevision.current && draftSave.current.pending === undefined) {
        // Keep the newest unsaved text: a refused write is named and retried
        // by the next keystroke/connect instead of silently disappearing.
        draftSave.current.pending = payload;
      }
    })();
  }, [taskId]);
  /**
   * Hand the newest pending text to the Host's per-key chain immediately. The
   * chain lives in `draftStore`, so an unmount/remount cannot read the older
   * record: the read awaits every write enqueued before it.
   */
  const runDraftSaves = useCallback(() => {
    const state = draftSave.current;
    const payload = state.pending;
    if (payload === undefined) return;
    state.pending = undefined;
    writeDraft(payload);
  }, [writeDraft]);
  /** Write the newest draft immediately (send acknowledged, switch, unmount). */
  const flushDraftSave = useCallback((next?: { text: string; references: Reference[] }) => {
    const state = draftSave.current;
    if (next !== undefined) state.pending = { sessionId, ...next, revision: draftRevision.current };
    if (state.timer !== undefined) { clearTimeout(state.timer); state.timer = undefined; }
    runDraftSaves();
  }, [runDraftSaves, sessionId]);
  const queueDraftSave = useCallback((next: { text: string; references: Reference[] }) => {
    const state = draftSave.current;
    state.pending = { sessionId, ...next, revision: draftRevision.current };
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      runDraftSaves();
    }, DRAFT_SAVE_DEBOUNCE_MS);
  }, [runDraftSaves, sessionId]);
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
    // [#138] A projection read is a resync, not a reason to drop the staging of
    // the SAME live turn: the deltas that already arrived are still unverified
    // text. A different (or no) turn starts with nothing staged.
    streamRef.current = turnStream.current.resync(turn?.state === "accepted" ? turn.turnId : null);
    setStream(streamRef.current); setSnapshot(projection);
    if (requestId && turn && attemptRef.current) {
      if (turn.state !== "accepted") {
        try { clearReceipt(taskId, sessionId, requestId); setReceiptError(null); }
        catch { setReceiptError("本机待确认请求记录无法清除，已禁止发送；请核验本机数据"); }
        // [#139] The turn settled: its request is now in this session's JSONL,
        // so the context/usage readout changes here — not only on switch.
        readoutRefresh.current();
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
  // [Pencil T05] ticket 140 本会话真实的确认记录（`task/listApprovals`）：待批准的工具调用
  // 只有从这里来。`reading`/`failed` 是各自具名的状态，读取失败不渲染成「无待确认」。
  const [approvalRead, setApprovalRead] = useState<ApprovalRead>({ phase: "reading" });
  const [modelOpen, setModelOpen] = useState(false);
  const [thinkingError, setThinkingError] = useState<string | null>(null);
  const [thinkingBusy, setThinkingBusy] = useState(false);
  const readoutAttempt = useRef(0);
  /**
   * [#139] The turn's own settle is a readout change: the Host derives `used`
   * from this session's JSONL, which only has the new request AFTER the turn
   * lands. `reconcile` calls this on terminal (done/failed/cancelled/
   * interrupted); it re-reads quietly so the settled numbers appear without
   * blanking the header to 未读取 for a frame.
   */
  const readoutRefresh = useRef<() => void>(() => {});
  const executionReadAttempt = useRef(0);
  const approvalReadAttempt = useRef(0);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [archiveMode, setArchiveMode] = useState<"archive-only" | "archive-and-cleanup">("archive-only");
  const [archivePrompt, setArchivePrompt] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const taskActionsRef = useRef<HTMLButtonElement>(null);
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
  // The delivery sheet is a modal surface of its own; Escape closes it without
  // reaching the archive prompt (the two are never open together).
  useEffect(() => {
    if (!deliveryOpen) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDeliveryOpen(false);
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [deliveryOpen]);
  // Metadata refreshes keep the live session subscription. Reconnecting on each
  // list object can let the previous unsubscribe revoke a pending new subscribe.
  const awaitingSessionList = sessionList.phase === "reading";
  const emptySessionList = sessionList.phase === "read" && sessionList.list.sessions.length === 0;
  useEffect(() => {
    if (invalidated) { setConnected(false); setValid(false); return; }
    // [#139] Wait for the session list before connecting: a page that subscribed
    // to the `main` fallback first and then jumped to the Host's active session
    // would show one session's history for a frame and issue a needless subscribe.
    if (awaitingSessionList) return;
    // A task whose sessions were all deleted has NO session to address. The page
    // says so and offers 新建会话 instead of subscribing to an id the Host does
    // not have (or inventing an empty one).
    if (emptySessionList) {
      setConnected(false); setValid(false); setSnapshot(null); setNotice("本任务暂无会话：新建一个会话后才能对话");
      return;
    }
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
    const unsubscribe = () => { void enqueueSubscription(bridge, () => request("unsubscribe")).catch(() => {}); };
    const disconnect = (reason: string) => {
      if (!active()) return;
      setValid(false); setConnected(false); streamRef.current = ""; setStream(""); turnStream.current.reset(); setNotice(reason);
      off?.(); off = undefined;
      if (subscribed) unsubscribe();
    };
    const onEvent = (raw: unknown) => {
      if (!active() || !object(raw)) return;
      if (raw.kind === "needs-resync") {
        if (raw.taskId === taskId && raw.sessionId === sessionId) { turnStream.current.reset(); streamRef.current = ""; setStream(""); void reconcile(epoch, attemptRef.current?.requestId).catch(() => disconnect("连接中断，请重新连接")); }
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
      if (event.taskId !== taskId || event.sessionId !== sessionId || typeof event.turnId !== "string") return;
      // [#138] The ACK and the Host's deltas travel two different IPC paths: a
      // delta can arrive before `start` has written `turnId`. The gate buffers
      // those pre-ACK deltas for the turn the ACK will name, anchors the first
      // accepted delta of a turn (a late subscription starts at 3, not at 1),
      // drops duplicates/replays without clearing the staging, and asks for a
      // projection re-read only on a real sequence gap.
      const outcome = turnStream.current.ingest({ turnId: event.turnId, sequence: event.sequence, type: event.type, text: event.text });
      if ((event.type === "tool_preview" || event.type === "tool_result") && outcome.kind !== "duplicate" && outcome.kind !== "resync" &&
          typeof event.callId === "string" && event.callId.length <= 160 && typeof event.tool === "string" && event.tool.length <= 256 && typeof event.text === "string" && event.text.length <= 4200) {
        const preview = { turnId: event.turnId, callId: event.callId, tool: event.tool, text: event.text, ...(event.type === "tool_result" ? { failed: event.failed === true } : {}) };
        setToolPreviews(rows => [...rows.filter(row => row.turnId !== preview.turnId || row.callId !== preview.callId), preview].slice(-16));
      }
      if (outcome.kind === "staged") { streamRef.current = outcome.text; setStream(outcome.text); }
      else if (outcome.kind === "resync") {
        turnStream.current.reset();
        streamRef.current = ""; setStream("");
        void reconcile(epoch, attemptRef.current?.requestId).catch(() => disconnect(`事件${outcome.reason === "gap" ? "缺口" : "异常"}，请重新连接`));
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
          } else if (draftRevision.current > 0) {
            // Text typed while the page was still connecting is local-only:
            // write it now that the session is live, instead of leaving the
            // Host record null (the T10 evidence defect).
            flushDraftSave();
          }
        }
        if (!bridge?.onSdkTurnEvent) throw new Error("SDK 事件接口不可用");
        off = bridge.onSdkTurnEvent(onEvent);
        const reply = await enqueueSubscription(bridge, async () => {
          if (!active()) return null;
          const result = await request("subscribe", attemptRef.current ? { requestId: attemptRef.current.requestId } : {});
          if (!active()) { await request("unsubscribe").catch(() => {}); return null; }
          subscribed = true;
          return result;
        });
        if (!reply || !active()) { off?.(); return; }
        if (reply.taskId !== taskId || reply.sessionId !== sessionId) throw new Error("SDK 订阅身份异常");
        const projection = parseSnapshot(reply.snapshot, sessionId);
        setSnapshot(projection); setValid(true); setConnected(true);
        if (attemptRef.current) await reconcile(epoch, attemptRef.current.requestId);
        else setNotice(projection.interrupted ? "会话上次执行中断" : projection.pending ? "会话正在执行，请等待" : "");
      } catch (error) { disconnect(errorText(error)); }
    };
    void connect();
    return () => { if (generationRef.current === epoch) generationRef.current++; window.clearInterval(poll); off?.(); if (subscribed) unsubscribe(); };
  }, [bridge, connectionKey, flushDraftSave, invalidated, queueDraftSave, reconcile, request, sessionId, awaitingSessionList, emptySessionList, taskId, verify]);
  const refresh = async () => {
    const epoch = generation.current;
    try { await verify(); if (epoch !== generation.current) return; await reconcile(epoch, attemptRef.current?.requestId); if (epoch === generation.current) setValid(true); }
    catch (error) { setValid(false); setConnected(false); setNotice(errorText(error)); setInvalidated(true); }
  };
  /**
   * [Pencil T10] #145 发送前的引用重检。两步：芯片自身身份（无需宿主）与 Host 真实
   * 读到的 `task/fileRoots`。根目录读不到也算一个具名问题：不假定引用可用，不把
   * 无法核对的来源当作已发送。
   */
  const verifyReferences = async (list: readonly Reference[]): Promise<ReferenceIssue[]> => {
    const issues = referenceIssues(list, taskId);
    const named = new Set(issues.map((issue) => issue.id));
    const pending = list.filter((reference) => !named.has(reference.id) && reference.kind !== "attachment" && reference.kind !== "skill");
    if (pending.length === 0) return issues;
    const failed = (message: string, references: readonly Reference[] = pending): ReferenceIssue[] =>
      [...issues, ...references.map((reference) => ({ id: reference.id, label: reference.label, message }))];
    let read;
    try { read = await shellTaskOp(taskId, "task/fileRoots"); }
    catch (error) { return failed(`来源重检失败：${error instanceof Error ? error.message : String(error)}；请重试或重新选择引用`); }
    if (!read.ok) return failed(`来源重检失败：${read.error}；请重试或重新选择引用`);
    const facts = referenceRootFacts(read.payload);
    if (facts.error !== null) return failed(facts.error);
    // [Pencil T19] #145 B2: the root alone is not the reference. After the root
    // identity matches, ask the Host whether the file itself is STILL at that
    // recorded source path (`task/fileStat`), so a file moved on disk is refused
    // by name even though its chip and root still look valid.
    const needsStat: Reference[] = [];
    for (const reference of pending) {
      const message = rootReferenceIssue(reference, facts.roots);
      if (message !== null) issues.push({ id: reference.id, label: reference.label, message });
      else needsStat.push(reference);
    }
    for (const reference of needsStat) {
      const rootId = referenceRootId(reference, facts.roots);
      if (rootId === null || reference.relativePath === undefined) {
        issues.push({ id: reference.id, label: reference.label, message: "来源已失效（无法定位引用的来源路径），请重新选择来源" });
        continue;
      }
      let stat;
      try { stat = await fileStatThroughShell({ taskId, rootId, relative: reference.relativePath }); }
      catch (error) {
        issues.push({ id: reference.id, label: reference.label, message: `来源重检失败：${error instanceof Error ? error.message : String(error)}；请重试或重新选择引用` });
        continue;
      }
      if (!stat.ok) {
        issues.push({ id: reference.id, label: reference.label, message: `来源重检失败：${stat.error}；请重试或重新选择引用` });
        continue;
      }
      const file = referenceFileFact(stat.payload);
      if (file.fact === null) {
        issues.push({ id: reference.id, label: reference.label, message: file.error ?? "来源重检失败：Host 未上报文件状态；请重试或重新选择引用" });
        continue;
      }
      const message = referenceFileIssue(reference, file.fact);
      if (message !== null) issues.push({ id: reference.id, label: reference.label, message });
    }
    return issues;
  };
  const start = async (reuse = false) => {
    if (historyReadOnly || busy.current || !connected || !valid || receiptError || (!reuse && (attemptRef.current?.phase === "unknown" || attemptRef.current?.phase === "accepted" || snapshot?.pending))) return;
    const text = reuse ? attemptRef.current?.text : draft;
    if (!text?.trim()) return;
    // A send writes the draft NOW (before any slow verification/refusal path):
    // a debounce timer must not leave the send-time text unsaved or let the
    // empty post-ACK clear race an older queued write.
    if (!reuse) flushDraftSave({ text, references });
    // [Pencil T10] #145 引用先重检再发送：芯片上的来源身份与 Host 真实读到的任务
    // 根目录对比，失效／跨任务／越界的来源按名字提示修正。草稿与引用都留在本会话，
    // 发送被拒绝时不丢输入也不静默改用源仓库或另一个任务里的同名文件。按原 ID 重试
    // 沿用已接受的上下文，不再重检（Host 指纹会拒绝被改过的上下文）。
    if (!reuse) {
      // A refused send must not be able to race a second click: the same guard
      // the turn uses (`busy`) is held across the re-check and released on refusal.
      busy.current = true;
      let problems: ReferenceIssue[];
      try { problems = await verifyReferences(references); }
      catch (error) {
        problems = references.map((reference) => ({ id: reference.id, label: reference.label, message: `来源重检失败：${error instanceof Error ? error.message : String(error)}；请重试或重新选择引用` }));
      }
      if (problems.length > 0) busy.current = false;
      setReferenceProblems(problems);
      const refusal = referenceSendRefusal(problems);
      setReferenceReport(refusal);
      if (refusal !== null) return;
    }
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
      setCurrent(current); setNotice("等待 Host 确认请求"); streamRef.current = ""; setStream(""); turnStream.current.reset();
      let result;
      try { result = await request("start", { requestId: current.requestId, text: current.text, ...(carriesContext ? context : {}) }); }
      catch (error) {
        if (epoch !== generation.current) return;
        if (errorText(error).includes("provider-not-configured") || errorText(error).includes("invalid-prompt")) {
          try { clearReceipt(taskId, sessionId, current.requestId); setCurrent(null); setNotice(`无法发送：${errorText(error)}`); }
          catch { setReceiptError("本机待确认请求记录无法清除，已禁止发送；请核验本机数据"); }
        } else {
          // [#139] A DEFINITE refusal (`task-locked`/`sdk-session-busy`) never
          // started a turn: it is busy/refused, not an unknown outcome. The
          // request id is kept so the retry the evidence exercised still works.
          const refusal = definiteTurnRefusal(errorText(error));
          setCurrent({ ...current, phase: "unknown" });
          setNotice(refusal === null ? `请求结果未知：${errorText(error)}；请核验或按原 ID 重试` : refusal.notice);
        }
        return;
      }
      if (epoch !== generation.current) return;
      const turn = parseTurn(result.turn, taskId, sessionId, current.requestId);
      if (!turn) throw new Error("SDK ACK 缺少请求身份");
      // [#138] Replay the deltas that beat the ACK, then keep staging from there.
      const staged = turnStream.current.ack(turn.state === "accepted" ? turn.turnId : null);
      streamRef.current = staged.text; setStream(staged.text);
      setCurrent({ ...current, turnId: turn.turnId, phase: turn.state === "accepted" ? "accepted" : "terminal", state: turn.state });
      setNotice(turn.state === "accepted" ? "正在等待模型" : "正在核验 SDK 历史");
      if (turn.state === "accepted" && !reuse) {
        if (draftRevision.current === submittedRevision) {
          setDraft("");
          // Clearing is immediate and exact-key: the sent text must not linger
          // in a debounce timer while the acknowledged turn settles.
          flushDraftSave({ text: "", references: [] });
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
    // [Pencil T10] #145 a new chip is unverified until the next send re-checks it.
    setReferenceProblems([]);
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
      queueDraftSave({ text: draft, references: next });
      return next;
    });
  };
  const removeFileReference = (id: string) => setReferences((current) => {
    setReferenceProblems((problems) => problems.filter((entry) => entry.id !== id));
    setReferenceReport(null);
    const next = current.filter((entry) => entry.id !== id);
    queueDraftSave({ text: draft, references: next });
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
  const blocked = historyReadOnly || !valid || !connected || !!receiptError || snapshot?.pending || attempt?.phase === "starting" || attempt?.phase === "unknown" || attempt?.phase === "accepted";
  const archive = async (mode: "archive-only" | "archive-and-cleanup" = "archive-only") => {
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
      // [T12] #147: "仅归档保留副本" sends no mode (the Host default) and keeps
      // every worktree; "归档并清理" only opens the guarded per-repo cleanup.
      const result = await setTaskArchivedThroughShell({ taskId, archived: true, ...(mode === "archive-and-cleanup" ? { mode } : {}) });
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
   * [Pencil T05] ticket 140 本会话的确认记录。和上面同一条既有读取节奏：挂载、会话切换、
   * 回合阶段变化时各读一次，不自己开定时器。批准/拒绝之后由 `resolveToolApproval`
   * 直接重读一次，因此卡片上看到的是 Host 结算后的状态，而不是本页的乐观猜测。
   */
  const loadApprovals = useCallback(async () => {
    const attempt = ++approvalReadAttempt.current;
    const result = await listApprovalsThroughShell({ taskId, sessionId });
    if (approvalReadAttempt.current !== attempt) return;
    if (!result.ok) { setApprovalRead({ phase: "failed", error: result.error ?? "" }); return; }
    const approvals = parseTaskApprovals(result.payload, taskId, sessionId);
    if (approvals === null) {
      setApprovalRead({ phase: "failed", error: `Host 返回的确认记录无法解析：${hostAnswerText(result.payload)}` });
      return;
    }
    setApprovalRead({ phase: "read", approvals });
  }, [sessionId, taskId]);
  useEffect(() => {
    void loadApprovals();
    return () => { approvalReadAttempt.current += 1; };
  }, [attemptPhase, loadApprovals]);
  // A command may ask for approval long after its ACK. Re-read the existing
  // Host API while a turn is live; an idle conversation owns no polling timer.
  useEffect(() => {
    if (attemptPhase !== "accepted" && !snapshot?.pending) return;
    const timer = window.setInterval(() => { void loadApprovals(); }, 750);
    return () => { window.clearInterval(timer); approvalReadAttempt.current += 1; };
  }, [attemptPhase, snapshot?.pending, loadApprovals]);
  /**
   * 一次决定：`task/approve` 或 `task/reject`，载荷只有 `{sessionId, approvalId}`。
   * 成功返回 `null`，失败返回具名原因（Host 自己的文本 + 一句可行动说明）；本页不
   * 把失败当成已处理，也不重试同一确认。执行读数一并重读：批准的操作用一条新的
   * Host 记录出现，而不是本页写上的「已执行」。
   */
  const resolveToolApproval = async (approval: TaskApproval, decision: ApprovalDecision): Promise<string | null> => {
    const request = approvalRequest(approval, decision);
    const result = await resolveApprovalThroughShell({ taskId, op: request.op, ...request.payload });
    if (!result.ok) return approvalFailureText(result.error);
    await loadApprovals();
    const execution = await executionStateThroughShell({ taskId, sessionId });
    if (execution.ok) {
      const view = executionStateFromHost(execution.payload);
      if (view !== null) setExecutionRead({ phase: "read", view });
    }
    return null;
  };
  /**
   * [#139] Adopt a list reply. The Host now carries the same `provider` row in
   * every read AND write reply; merging keeps a partial reply from nulling the
   * provider the page already had (the model menu is the only way to switch
   * models). `sessions`/`activeSessionId` always come from the reply.
   */
  const applyList = useCallback((list: SessionList) => setSessionList((current) => ({
    phase: "read",
    list: mergeSessionList(current.phase === "read" ? current.list : null, list),
  })), []);
  /**
   * [#139] The session list is the page's only session truth. It is read once
   * per task (and after every session write), and a failed read is a named state:
   * the page then keeps addressing the migrated `main` session, which the Host
   * always keeps for a task that predates this ticket.
   */
  const loadSessions = useCallback(async () => {
    const result = await readTaskSessions(taskId);
    if (!result.ok) { setSessionList({ phase: "failed", error: result.error }); return; }
    applyList(result.list);
    // The Host's active pointer wins on the first read; once the reader has picked
    // a session, only a session that no longer exists (archived or deleted) moves
    // them — never a silent jump back.
    const target = result.list.activeSessionId ?? result.list.sessions.find((session) => !session.archived)?.id ?? SDK_SESSION_ID;
    setActiveSessionId((current) => {
      const present = result.list.sessions.some((session) => session.id === current && (!session.archived || initialSessionId === current));
      return picked.current && present ? current : target;
    });
  }, [applyList, taskId, initialSessionId]);
  useEffect(() => { void loadSessions(); }, [loadSessions]);
  // The sidebar's session rows navigate here: an explicitly named session wins
  // over the task's stored active pointer until the user picks another one.
  useEffect(() => {
    if (initialSessionId !== undefined) { picked.current = true; setActiveSessionId((current) => (current === initialSessionId ? current : initialSessionId)); }
  }, [initialSessionId]);
  /**
   * [Pencil T10] #145 切换会话后把焦点放回输入区（键盘流程不因切换而中断）：
   * 每个会话自己的草稿照常从 Host 恢复，焦点不跟随上一个会话残留。
   */
  useEffect(() => {
    messageInput.current?.focus();
  }, [sessionId]);
  // Leaving the page flushes the newest draft; a timer must not die with the
  // component and take the last keystrokes with it.
  useEffect(() => () => { flushDraftSave(); }, [flushDraftSave]);
  /**
   * [#139] Switching a session is a re-subscribe: every per-session value this
   * page held (draft, references, attachments, pending receipt, snapshot, stream)
   * is reloaded from the Host for the session being entered. The outgoing
   * session's draft was already saved per keystroke, so nothing typed is lost and
   * nothing is cross-delivered.
   */
  const resetForSession = useCallback((next: string) => {
    // The outgoing session's newest text is written NOW, before the switch can
    // take over the page state; a debounce timer must not follow the new id.
    flushDraftSave();
    const receipt = readReceipt(taskId, next);
    draftRevision.current = 0;
    draftLoaded.current = false;
    draftSave.current.pending = undefined;
    setDraft(receipt.receipt?.text ?? "");
    setToolPreviews([]);
    setReferences([]);
    setReferenceProblems([]);
    setReferenceReport(null);
    setAttachments([]);
    setAttachmentReport(null);
    setDraftError(null);
    setReceiptError(receipt.error);
    setCurrent(receipt.receipt ? { ...receipt.receipt, phase: "unknown" } : null);
    streamRef.current = ""; setStream(""); turnStream.current.reset();
    setSnapshot(null); setInvalidated(false); setConnected(false); setValid(false);
    setNotice("正在连接 SDK 会话");
    picked.current = true;
    setActiveSessionId(next);
    // Report only a completed local transition. Echoing every list read to the
    // parent can overwrite a newer sidebar destination with the previous id.
    onSessionSelected?.(next);
  }, [flushDraftSave, taskId, onSessionSelected]);
  const switchToSession = async (target: TaskSession) => {
    if (target.id === sessionId) { setSessionsOpen(false); return; }
    if (target.archived) { setSessionNotice(`「${target.name}」已归档，不能继续对话；请先恢复。`); return; }
    setSessionBusy(true); setSessionNotice(null);
    const result = await activateSession(taskId, target.id);
    setSessionBusy(false);
    if (!result.ok) { setSessionNotice(result.error); return; }
    applyList(result.list);
    resetForSession(target.id);
    setSessionsOpen(false);
  };
  const newSession = async (name?: string) => {
    if (sessionBusy) return;
    setSessionBusy(true); setSessionNotice(null);
    const result = await createSession(taskId, name === undefined ? {} : { name });
    setSessionBusy(false);
    if (!result.ok) { setSessionNotice(result.error); return; }
    applyList(result.list);
    const created = result.list.sessions.find((session) => session.id === result.list.activeSessionId);
    if (created) resetForSession(created.id);
    setSessionsOpen(false);
  };
  const applySessionWrite = (result: { ok: true; list: SessionList } | { ok: false; error: string }) => {
    if (!result.ok) { setSessionNotice(result.error); return; }
    applyList(result.list);
  };
  /** [#146] Adopt a lifecycle reply and say what actually happened, never more. */
  const applyLifecycleWrite = (action: SessionActionId, session: TaskSession, result: ({ ok: true } & SessionLifecycleReply) | { ok: false; error: string }): boolean => {
    if (!result.ok) { setSessionNotice(`${session.name}：${result.error}`); return false; }
    applyList(result.list);
    const verb = action === "stop" ? "停止" : action === "archive" ? "归档" : action === "delete" ? "删除" : action;
    setLifecycleNotice(result.stopped
      ? `已先停止「${session.name}」的 ${result.abortedTurnIds.length} 个执行回合并等待结算，然后完成${verb}`
      : `「${session.name}」没有正在执行的回合，已直接完成${verb}`);
    return true;
  };
  const renameOne = async () => {
    if (renaming === null || sessionBusy) return;
    setSessionBusy(true);
    const result = await renameSession(taskId, renaming.id, renaming.name);
    applySessionWrite(result);
    setSessionBusy(false);
    if (result.ok) setRenaming(null);
  };
  const archiveOne = async (id: string) => {
    if (sessionBusy) return;
    const session = sessions.find((entry) => entry.id === id);
    if (!session) return;
    setSessionBusy(true);
    const result = await archiveSession(taskId, id);
    setSessionBusy(false);
    // Archiving the session being shown moves the page to the next real one;
    // an archived session is read-only and never takes another turn.
    if (applyLifecycleWrite("archive", session, result) && id === sessionId) {
      const next = result.ok ? result.list.activeSessionId : null;
      if (next !== null) resetForSession(next);
    }
  };
  const stopOne = async (id: string) => {
    if (sessionBusy) return;
    const session = sessions.find((entry) => entry.id === id);
    if (!session) return;
    setSessionBusy(true);
    const result = await stopSession(taskId, id);
    setSessionBusy(false);
    applyLifecycleWrite("stop", session, result);
    // The stopped turn's terminal state is the Host's; re-read it instead of
    // painting a local "已停止" that the JSONL may not agree with.
    if (result.ok && id === sessionId) void reconcile(generation.current, attemptRef.current?.requestId);
  };
  const restoreOne = async (id: string) => {
    if (sessionBusy) return;
    setSessionBusy(true);
    // Restore keeps the history and replays nothing: no turn, no approval, no
    // tool is sent by this path (the Host only clears the archive flag).
    applySessionWrite(await restoreSession(taskId, id));
    setSessionBusy(false);
  };
  const deleteOne = async (id: string) => {
    if (sessionBusy) return;
    const session = sessions.find((entry) => entry.id === id) ?? deletePrompt;
    if (!session) return;
    setSessionBusy(true);
    const result = await deleteSession(taskId, id);
    setSessionBusy(false);
    setDeletePrompt(null);
    const deleted = applyLifecycleWrite("delete", session, result);
    // [Pencil T10] #145 删除会话要连带它的草稿与待确认记录：Host 侧会话记录随
    // 会话一起消失，本机这条会话的 pending receipt 也必须删掉，否则下一次读取会
    // 把已删除会话的文字当成"还没核验的请求"提示出来。
    if (deleted) {
      useDraftStore.getState().forget(taskId, id);
      const pending = readReceipt(taskId, id);
      if (pending.receipt !== null) {
        try { clearReceipt(taskId, id, pending.receipt.requestId); }
        catch { setNotice("会话已删除，但本机待确认请求记录无法清除；请核验本机数据"); }
      }
    }
    if (deleted && id === sessionId) {
      const next = result.ok ? result.list.activeSessionId : null;
      if (next !== null) resetForSession(next);
      else { setSnapshot(null); setValid(false); setConnected(false); setActiveSessionId(SDK_SESSION_ID); }
    }
  };

  // Consume a navigation intent only after the authoritative list arrives. The
  // same handlers own cancellation, drafts, receipts and confirmation everywhere.
  const consumedSidebarAction = useRef<number | null>(null);
  useEffect(() => {
    if (!sidebarAction || sidebarAction.taskId !== taskId || consumedSidebarAction.current === sidebarAction.token || sessionBusy || sessionList.phase === "reading") return;
    consumedSidebarAction.current = sidebarAction.token;
    const consume = () => onSidebarActionConsumed?.();
    if (sessionList.phase !== "read") { consume(); setSessionNotice("会话列表未核验，无法执行侧栏操作；请重试读取"); return; }
    if (sidebarAction.action === "archive-task" || sidebarAction.action === "cleanup-task") {
      setArchiveMode(sidebarAction.action === "cleanup-task" ? "archive-and-cleanup" : "archive-only"); setArchivePrompt(true); consume(); return;
    }
    if (sidebarAction.action === "new") { void newSession().finally(consume); return; }
    const target = sessions.find((entry) => entry.id === sidebarAction.sessionId);
    if (!target) { consume(); setSessionNotice("会话已不存在，请重新选择"); return; }
    switch (sidebarAction.action) {
      case "rename": setSessionsOpen(true); setRenaming({ id: target.id, name: target.name }); consume(); break;
      case "delete": setDeletePrompt(target); consume(); break;
      case "archive": void archiveOne(target.id).finally(consume); break;
      case "restore": void restoreOne(target.id).finally(consume); break;
      case "stop": void stopOne(target.id).finally(consume); break;
    }
    // These event handlers intentionally read this render's verified identity;
    // token consumption prevents rerenders/StrictMode from replaying mutations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarAction, sessionList.phase, sessionBusy, taskId, onSidebarActionConsumed]);

  /**
   * [#139] 推理/上下文/模型 read ONE session readout (`task/sessionReadout`),
   * which the Host derives from this session's own SDK JSONL and its bound model —
   * not from the legacy `task/sessionContext` defaults. `null` means unknown.
   * The attempt counter makes a late answer from a replaced read (or from the
   * session the user just left) unable to overwrite the current one.
   */
  const loadReadout = useCallback(async (mode: "show" | "quiet" = "show") => {
    const attempt = readoutAttempt.current + 1;
    readoutAttempt.current = attempt;
    if (mode === "show") setReadoutRead({ phase: "reading" });
    const result = await readSessionReadout(taskId, sessionId);
    if (readoutAttempt.current !== attempt) return;
    if (result.ok) setReadoutRead({ phase: "read", readout: result.readout });
    // A quiet refresh (the turn settled) keeps the previous numbers on a failed
    // re-read instead of replacing them with an older "failed" state.
    else if (mode === "show") setReadoutRead({ phase: "failed", error: result.error });
  }, [sessionId, taskId]);
  // `reconcile` (declared earlier) refreshes through this ref so a settled turn
  // re-reads the same readout the switch path reads.
  useEffect(() => {
    readoutRefresh.current = () => { void loadReadout("quiet"); };
    return () => { readoutRefresh.current = () => {}; };
  }, [loadReadout]);
  // A readout is only read for a session the page has actually resolved; before
  // the list answers there is no session to read.
  useEffect(() => { if (sessionList.phase === "reading") return; void loadReadout(); }, [loadReadout, sessionList.phase]);
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
    // [#139] An unbound session says so: "该模型不支持推理" would claim a model
    // fact nobody read. Only a BOUND model can be unsupported.
    : boundModel === null ? "推理 · 未绑定模型"
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
    void loadSessions();
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
    : `上下文 ${readout.context.used === null ? "未报告" : `${(readout.context.used / 1000).toFixed(1)}k`} / ${readout.context.window === null ? "窗口未知" : formatWindow(readout.context.window)}`;
  const contextTitle = readoutRead.phase === "reading"
    ? "正在读取本会话的 SDK 上下文占用；读取完成前不显示数字"
    : readoutRead.phase === "failed" ? `本会话上下文读数读取失败：${readoutRead.error}`
    : readout === null ? "Host 未返回会话读数"
      : `本会话最近一次请求的提示词占用 ${readout.context.used === null ? "未报告（未知）" : `${readout.context.used} tokens`} · 绑定模型窗口 ${readout.context.window === null ? "未知" : `${readout.context.window} tokens`} · 来源 ${readout.context.source}；SDK 未报告时保持未知，不按 0 显示`;
  // [Pencil T13] ticket 148: both task-level surfaces the real Electron page could not
  // reach are entries of the SAME `任务操作` menu the web task page uses. A task
  // with zero repositories has no Git delivery to review, so that entry is
  // omitted (the sheet would have no row); an unreported count is not zero.
  const taskMenuItems: TaskActionMenuItem[] = [
    ...(repoCount === null || repoCount > 0
      ? [{ id: "delivery", label: "审阅与交付", detail: "逐仓库审阅变更；提交与推送需显式触发", onSelect: () => { setArchiveError(""); setDeliveryOpen(true); } }]
      : []),
    { id: "archive-task", label: "归档当前任务", detail: "停止执行并保留代码、会话与草稿", onSelect: () => { setArchiveError(""); setArchivePrompt(true); } },
  ];

  return <TooltipProvider><main data-testid="desktop-conversation" aria-label={`${name} · 会话`} className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-bg text-ink">
    <div className="flex min-h-0 min-w-0 flex-1">
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", activeTool && !toolDockCollapsed && "below-narrow:hidden")}>
    {(() => {
      const toolbar = <div data-testid="desktop-conversation-header" className="flex min-w-0 items-center gap-2">
        <span data-testid="desktop-session-identity" title={`会话 · ${activeSession?.name ?? sessionId}`} className="max-w-32 truncate text-[11px] text-muted">会话 · {activeSession?.name ?? sessionId}{activeSession?.archived ? " · 已归档" : ""}</span>
        <details className="conversation-actions relative">
          <summary aria-label="会话与工具操作" className="cursor-pointer list-none rounded border border-line px-2 py-0.5 text-muted">···</summary>
          <div data-testid="desktop-conversation-toolbar" className="conversation-actions-menu absolute right-0 top-full flex w-72 flex-wrap gap-1 rounded-md border border-line bg-paper p-2 shadow-md">
            <span data-testid="desktop-session-meta" className="flex w-full flex-col gap-1 text-[10px] text-muted" title={contextTitle}>
              <span data-testid="desktop-session-model">模型 · {boundModel?.name ?? (sessionList.phase === "read" ? "未绑定模型" : "未读取")}</span>
              <span data-testid="desktop-session-reasoning">推理 · {readoutRead.phase !== "read" ? (readoutRead.phase === "reading" ? "未读取" : "读取失败") : boundModel === null ? "未绑定模型" : reasoningLevels.length === 0 ? "该模型不支持" : thinkingLevel === null ? "跟随模型" : REASONING_LEVEL_TEXT[thinkingLevel] ?? thinkingLevel}</span>
              <span data-testid="desktop-session-context">{contextLabel}</span>
              <span>{ready ? "已连接" : invalidated ? "已失效" : "未连接"}</span>
            </span>
            <span data-testid="desktop-conversation-branch" className="w-full truncate text-[11px]">{hostText(branch, "Host 未上报分支")}</span>
            <span data-testid="desktop-conversation-repo-count" className="w-full text-[11px]">{repoCount === null ? "Host 未上报仓库数" : `${repoCount} 仓库`}</span>
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
          {/* The shared `任务操作` menu (#27) is the ONE task-actions surface: the
              desktop page previously carried a hand-written archive-only popover,
              so `data-testid=task-action-menu` and the 审阅与交付 entry (ticket 148)
              never existed here even though the trigger announced a menu. */}
          <TaskActionMenu items={taskMenuItems} triggerRef={taskActionsRef} />
          <Button type="button" disabled={!connected} onClick={() => void refresh()} title={connected ? "核验 SDK 会话与任务身份" : "等待 SDK 会话连接后核验"}><Icon name="refresh" /><span className="below-narrow:hidden">核验</span></Button>
          <Button type="button" size="icon" onClick={onBack} aria-label="返回任务列表" title="返回任务列表"><Icon name="arrow" className="-rotate-90" /></Button>
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
        {sessions.length === 0 && sessionList.phase === "read" && <span data-testid="desktop-sessions-empty" className="pb-2 text-[11px] text-[#9a6032]">本任务暂无会话；新建一个会话后才能对话</span>}
      </div>
          </div>
        </details>
      </div>;
      return toolbarTarget ? createPortal(toolbar, toolbarTarget) : <div className="flex shrink-0 justify-end px-4 py-1">{toolbar}</div>;
    })()}
    <MessageScrollerProvider><MessageScroller className="min-h-0 flex-1">
    <MessageScrollerViewport data-testid="desktop-conversation-scroll" tabIndex={0} role="region" aria-label="对话消息">
    <MessageScrollerContent className="mx-auto w-full max-w-[800px] gap-4 px-4 pt-5 pb-4">
    <ExecutionStateCard taskId={taskId} sessionId={sessionId} read={executionRead} approvals={approvalRead.phase === "read" ? approvalRead.approvals : []} />
    {/* [Pencil T05] ticket 140 S01 的审批位：只呈现 Host 已记录的确认，批准/拒绝走
        `task/approve|reject`。没有待确认时也说明「记录为空」，不把空读数当成功。 */}

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
    {unwired && <p role="status" data-testid="desktop-unwired-tool" className="border-b border-line bg-soft px-4 py-1.5 text-[11px] text-muted">
      {unwired}面板未接线：{DESKTOP_TOOLS_UNWIRED.find((entry) => entry.label === unwired)?.reason ?? "生产读取路径尚未接线"}（不显示样例数据）
    </p>}
    <section data-testid="desktop-message-column" aria-label="SDK 对话历史" className="flex min-w-0 flex-col gap-4">
      {snapshot && !snapshot.messages.length && <p className="py-8 text-center text-sm text-muted">尚未开始 · 无 SDK 会话记录</p>}
      {snapshot?.messages.map((message, index) => {
        // [Pencil T10] #145 历史里的来源芯片：Host 拼在提示词末尾的身份清单单独
        // 渲染为芯片，正文不再把这段尾注当作用户打字。无法解析时整条消息原样显示。
        const parsed = message.role === "user" ? splitPromptContext(message.text) : { text: message.text, references: [] };
        return (<article key={index} className="min-w-0 text-[13px]"><ChatMessage><MessageContent>
        <MessageHeader className="gap-2 px-0 text-[12px] below-mid:text-[11px]">
          {message.role === "user" ? <LocalUserAvatar /> : <BrandMark size="sm" />}
          <span className="font-semibold text-ink">{message.role === "user" ? "你" : "Pi"}</span>
        </MessageHeader>
        <Bubble variant={message.role === "user" ? "outline" : "ghost"} className="w-full"><BubbleContent className="w-full">
          {message.role === "assistant" ? <ConversationMarkdown text={parsed.text} /> : <p className="whitespace-pre-wrap break-words text-[13px] below-mid:text-[11px] [overflow-wrap:anywhere]">{parsed.text}</p>}
        </BubbleContent></Bubble>
        {parsed.references.length > 0 && <div data-testid="history-references" className="mt-1 min-w-0">
          <ul className="flex min-w-0 flex-wrap gap-1.5">
            {parsed.references.map((entry, entryIndex) => <li key={entryIndex} data-testid="history-reference" data-reference-kind={entry.kind} title={[entry.source, entry.detail].filter(Boolean).join(" · ")} className="flex min-w-0 flex-wrap items-baseline gap-1.5 rounded-full border border-line bg-soft px-2 py-0.5 text-[11px]">
              <span className="shrink-0 text-muted">{REFERENCE_KIND_TEXT[entry.kind as Reference["kind"]] ?? entry.kind}</span>
              <span className="min-w-0 break-all font-mono text-ink">{entry.label}</span>
              {entry.source && <span className="min-w-0 break-all text-muted">{entry.source}</span>}
              {entry.detail && <span className="min-w-0 break-all text-muted">{entry.detail}</span>}
            </li>)}
          </ul>
          <p className="mt-1 text-[11px] text-muted">本条消息附带以上来源；Host 附带的是身份清单，内容由 Agent 用工具读取。</p>
        </div>}
        {message.usage && <details className="mt-1 text-[10px] text-muted"><summary className="cursor-pointer">用量</summary><p>SDK 用量 · 输入 {message.usage.input} / 输出 {message.usage.output} / 缓存读取 {message.usage.cacheRead} / 写入 {message.usage.cacheWrite}</p></details>}
      </MessageContent></ChatMessage></article>);
      })}
      {stream && <article className="min-w-0 border-l-2 border-ink pl-3 text-sm"><p className="mb-1 text-xs text-muted">暂存回复 · 尚未核验</p><ConversationMarkdown text={stream} /></article>}
    </section>
    {toolPreviews.filter(row => row.turnId === attempt?.turnId).map(row => <section key={row.callId} data-testid="desktop-tool-preview" className="min-w-0 rounded-md border border-line bg-sidebar px-3 py-2 text-[11px]">
      <div className="flex items-center justify-between gap-2"><strong className="font-mono">{row.tool}</strong><span className={row.failed ? "text-destructive" : "text-muted"}>{row.failed === undefined ? "参数预览 · 不用于审批" : row.failed ? "工具失败" : "工具结果"}</span></div>
      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono [overflow-wrap:anywhere]">{row.text}</pre>
    </section>)}
    <DesktopApprovalCard key={sessionId} read={approvalRead} onResolve={resolveToolApproval} />
    </MessageScrollerContent>
    </MessageScrollerViewport>
    <MessageScrollerButton aria-label="滚动到最新消息" />
    </MessageScroller></MessageScrollerProvider>
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
    <div data-testid="desktop-composer-container" className="shrink-0 px-4 pt-2 pb-4"><div className="mx-auto max-w-[768px] min-w-0">
      {draftError && <p role="alert" className="mb-2 break-words text-xs text-[#ad4545]">{draftError}</p>}
      {referenceReport && <p role="alert" data-testid="composer-reference-refusal" className="mb-2 break-words text-xs text-[#ad4545]">{referenceReport}</p>}
      {receiptError && <p role="alert" className="mb-2 break-words text-xs text-[#ad4545]">{receiptError}</p>}
      {notice && <p role="status" className={cn("mb-2 break-words text-xs text-muted", notice === "已从 SDK 历史核验" && "sr-only")}>{notice}</p>}
      <div className="mb-2 flex flex-wrap gap-2">{invalidated ? <Button type="button" onClick={onBack}>返回任务列表</Button> : (!connected || !valid) && <Button type="button" onClick={() => setConnectionKey((key) => key + 1)}>重新连接</Button>}
        {attempt?.phase === "unknown" && <Button type="button" onClick={() => void refresh()}>查询原请求</Button>}
        {attempt?.phase === "unknown" && <Button type="button" disabled={!valid} onClick={() => void start(true)}>按原 ID 重试</Button>}
        {attempt?.phase === "accepted" && <Button type="button" onClick={() => void stop()}><Icon name="stop" />停止</Button>}
      </div>
      {/* [Pencil T10] #145 S01/S06 的浮动 Composer：S01 内联对话里与紧凑窗口共用
          这一个输入区（同一份文字、引用、模型与推理、权限、发送/停止逻辑），没有
          第二份实现；它就是该列底部钉住的最后一格，900 与 560 高度都可达。 */}
      <form onSubmit={submit} data-testid="desktop-composer" data-surface="floating" className="min-w-0 rounded-[10px] border border-line bg-paper px-3 py-2 shadow-xs">
        {references.length > 0 && <div className="mb-2 min-w-0" data-testid="composer-file-references">
          <ul className="flex min-w-0 flex-wrap gap-1.5">
            {references.map((reference) => {
              const problem = referenceProblems.find((entry) => entry.id === reference.id);
              return (
              <li key={reference.id} data-testid={`composer-file-reference-${reference.id}`} data-source-kind={reference.sourceKind ?? "none"} data-reference-state={problem ? "invalid" : "ok"} title={problem ? problem.message : describeReferenceChip(reference)} className={`flex min-w-0 flex-wrap items-baseline gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${problem ? "border-[#e0b4b4] bg-[#fdf3f3]" : "border-line bg-soft"}`}>
                <span className="min-w-0 break-all font-mono text-ink">引用 · {reference.label}</span>
                <span className="shrink-0 text-muted">{REFERENCE_KIND_TEXT[reference.kind]}</span>
                <span className="shrink-0 text-muted">{referenceSourceLabel(reference)}</span>
                <span className="min-w-0 break-all text-muted">{reference.detail}</span>
                {problem && <span data-testid={`composer-file-reference-problem-${reference.id}`} role="status" className="min-w-0 break-words text-[#ad4545]">{problem.message}</span>}
                <button type="button" aria-label={`移除引用 ${reference.label}`} onClick={() => removeFileReference(reference.id)} className="shrink-0 text-muted">×</button>
              </li>
              );
            })}
          </ul>
          <p className="mt-1 text-[11px] text-muted">引用随消息提交：Host 会把类型、来源与路径附在提示词末尾，供 Agent 定位；发送前会重检来源身份（失效／越界按名字提示重新选择）。引用不把文件内容伪装成正文：内容由 Agent 用工具读取，Host 不改写来源。</p>
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
        <textarea ref={messageInput} aria-label="消息" readOnly={historyReadOnly} value={draft} onChange={(event) => { const text = event.target.value; draftRevision.current++; setDraft(text); queueDraftSave({ text, references }); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); if (!blocked) void start(); } }} rows={1} maxLength={16384} className="block max-h-32 w-full min-w-0 resize-none overflow-y-auto border-0 bg-transparent py-0 text-[12px] leading-[22px] outline-none" placeholder="输入后续指导 Agent，使用 @ 引用工作区文件，使用 $ 调用技能…" />
        <div className="conversation-composer-controls mt-1 flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted">
          <Tooltip><TooltipTrigger asChild><span tabIndex={0} aria-label="附件说明" className="inline-flex">
            <Button type="button" size="icon-sm" data-testid="desktop-composer-attach" aria-label="添加附件" onClick={() => attachmentInput.current?.click()} className="h-[26px] w-[26px] text-muted"><Icon name="plus" /></Button>
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
          <div data-testid="composer-model-reasoning" className="ml-auto flex min-w-0 items-center gap-1 rounded-md border border-line">
          <div className="relative min-w-0">
            <Button type="button" variant="ghost" size="sm" data-testid="composer-model" aria-haspopup="menu" aria-expanded={modelOpen}
              title={boundModel === null ? "本会话尚未绑定模型：先在「能力管理 → Providers」完成配置" : `${boundModel.name} · ID ${boundModel.id} · 窗口 ${boundModel.contextWindow} tokens · 切换模型保留本会话历史`}
              onClick={() => { setThinkingError(null); setModelOpen((open) => !open); }}>
              <span data-testid="composer-model-name" className="max-w-36 truncate">{boundModel === null ? (sessionList.phase === "read" ? "未绑定模型" : "正在读取模型") : boundModel.name}</span><Icon name="down" />
            </Button>
            {modelOpen && <div role="menu" aria-label="会话模型" className="absolute right-0 bottom-full z-30 mb-1 w-[280px] rounded-[7px] border border-line bg-paper p-2 text-left shadow-md">
              {providerModels.length === 0 ? <p className="px-1 text-[10px] leading-5 text-muted">Host 未返回当前 Provider 的模型列表；切换模型不可用。</p> : <>
                <p className="px-1 pb-1 text-[10px] leading-5 text-muted">切换只改本会话的绑定：历史与 JSONL 不变，后续回合用新模型。窗口装不下本会话上下文或回合进行中时，Host 会按名字拒绝。</p>
                {providerModels.map((row) => <Button key={row.id} type="button" role="menuitemradio" aria-checked={row.id === boundModelId} variant="ghost" size="sm" className="w-full justify-start" disabled={thinkingBusy} onClick={() => void chooseModel(row.id)}><span className="min-w-0 flex-1 truncate" title={`${row.name} · ${row.id}`}><span data-model-name>{row.name}</span><span className="block truncate text-[10px] text-muted">{row.id}</span></span><span className="ml-auto text-muted">{formatWindow(row.contextWindow)} · {row.reasoningLevels.length === 0 ? "无推理档位" : `${row.reasoningLevels.length} 档`}</span></Button>)}
                <Button type="button" variant="ghost" size="sm" className="mt-1 w-full justify-start" onClick={() => { setModelOpen(false); onOpenProviders(); }}><Icon name="settings" />能力管理 · Providers</Button>
              </>}
              {thinkingError && <p role="alert" className="mt-1 border border-[#e0b4b4] bg-[#fdf3f3] p-1.5 text-[10px] leading-5 break-words text-[#ad4545]">{thinkingError}</p>}
            </div>}
          </div>
          <div data-testid="composer-reasoning" role="group" aria-label="推理档位" title={thinkingLabel} className="min-w-0">
            {readoutRead.phase !== "read" ? <span className="px-1 text-[10px] text-muted">{readoutRead.phase === "reading" ? "推理档位未读取" : "推理档位读取失败"}</span>
              : boundModel === null ? <span className="px-1 text-[10px] text-muted">未绑定模型</span>
              : reasoningLevels.length === 0 ? <span className="px-1 text-[10px] text-muted">无推理档位</span>
              : <ToggleGroup type="single" size="sm" aria-label="推理档位" value={thinkingLevel ?? ""} disabled={thinkingBusy} onValueChange={(level) => { if (level) void chooseThinking(level as SessionThinkingLevel); }}>
                {reasoningLevels.map((level) => <ToggleGroupItem key={level} value={level} aria-label={REASONING_LEVEL_TEXT[level] ?? level}>{REASONING_LEVEL_TEXT[level] ?? level}</ToggleGroupItem>)}
              </ToggleGroup>}
          </div>
          </div>
          {thinkingError && !modelOpen && <span role="alert" className="min-w-0 break-words text-[10px] text-[#ad4545]">{thinkingError}</span>}
          <span data-testid="composer-context" title={contextTitle} className="min-w-0 truncate text-[10px]">{contextLabel}</span>
          <span data-testid="composer-usage" title={`${usageDetail} 本会话 SDK 累计：${readout?.usage ? `输入 ${readout.usage.input} / 输出 ${readout.usage.output} / 缓存读 ${readout.usage.cacheRead} / 写 ${readout.usage.cacheWrite}（${readout.turns} 条回复）` : "SDK 未报告"}`} className="sr-only">
            {!usageSnapshot ? "近期用量未核验" : reportedMessages.length ? `近期已报告输入+输出 ${recentTokens} tokens` : "近期用量未报告"}
          </span>
          <Button type="submit" variant="default" size="icon-sm" disabled={blocked || !draft.trim()} aria-label="发送" title="发送" className="h-[26px] w-[26px]"><Icon name="arrow" /></Button>
        </div>
      </form>
    </div></div>
    <Dialog open={archivePrompt} onOpenChange={(open) => { if (!archiveBusy) setArchivePrompt(open); }}>
      <DialogContent aria-labelledby={undefined} aria-label="归档当前任务" onCloseAutoFocus={(event) => { event.preventDefault(); taskActionsRef.current?.focus(); }} onOpenAutoFocus={(event) => { event.preventDefault(); archiveCancelRef.current?.focus(); }} onEscapeKeyDown={(event) => { if (archiveBusy) event.preventDefault(); }} onInteractOutside={(event) => event.preventDefault()}>
        <DialogHeader><DialogTitle>任务收尾：归档与受管资源清理确认</DialogTitle><DialogDescription>当前任务：{name}</DialogDescription></DialogHeader>
        <div className="rounded-lg bg-sunken p-3 text-[11px] leading-5"><strong>安全清理检查项（受管生命周期保护）</strong><p>归档只停止正在执行的 Agent 回合；已在运行的服务与终端不会被它停止。未执行确认会失效、定时任务暂停，代码和历史保留。恢复后服务与定时任务不会自动启动，清理需要单独处理。</p><p>归档并清理：先归档，再到已归档页逐个仓库检查未提交与未交付修改（未知交付状态不当作已交付），选择保留／导出／清理后才会移除身份核验通过的本任务工作副本。</p></div>
        <fieldset className="flex flex-col gap-2" disabled={archiveBusy}><legend className="mb-3 font-semibold">选择处理方式：</legend>
          <label className="flex items-start gap-2 rounded-lg border border-line p-3"><input type="radio" name="archive-mode" checked={archiveMode === "archive-only"} onChange={() => setArchiveMode("archive-only")} /><span><strong>仅归档任务（保留独立 worktree 副本与目录）</strong><span className="mt-1 block text-[11px] text-muted">仅归档保留副本：保留每个仓库的工作副本，不删除任何文件。任务移至「已归档」，之后可恢复并继续会话。</span></span></label>
          <label className="flex items-start gap-2 rounded-lg border border-destructive bg-danger-soft p-3"><input type="radio" name="archive-mode" checked={archiveMode === "archive-and-cleanup"} onChange={() => setArchiveMode("archive-and-cleanup")} /><span><strong className="text-destructive">归档并清理独立 worktree（先核验安全范围）</strong><span className="mt-1 block text-[11px] text-muted">先归档；下一步逐仓库预览并确认。原始仓库、普通目录保留，不自动提交、推送或删除。</span></span></label>
        </fieldset>
        {blocked && !archiveError && <p role="status" className="text-xs text-muted">会话尚未连接、正在执行或请求状态未核验；请先完成核验或停止执行。</p>}
        {archiveError && <p role="alert" className="break-words text-xs text-destructive">{archiveError}</p>}
        <DialogFooter><span className="mr-auto text-[11px] text-muted">恢复不会自动重新触发定时任务</span>{invalidated && <Button type="button" variant="outline" onClick={onArchived}>查看归档状态</Button>}<Button ref={archiveCancelRef} type="button" variant="outline" disabled={archiveBusy} onClick={() => setArchivePrompt(false)}>取消</Button><Button type="button" variant={archiveMode === "archive-and-cleanup" ? "destructive" : "default"} disabled={archiveBusy || blocked} onClick={() => void archive(archiveMode)}>{archiveBusy ? "归档中…" : archiveMode === "archive-only" ? "确认归档" : "归档并清理…"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    {/* [Pencil T13] ticket 148 S07 `CbsS5` / S10 `d0dQe`: the delivery sheet the
        `审阅与交付` menu entry opens. It is the same `DesktopDeliverySheet` the
        web task page's modal mounts, so the real Host ops are the only source. */}
    {deliveryOpen && <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" role="presentation">
      <div role="dialog" aria-modal="true" aria-label="审阅与交付" data-testid="desktop-delivery-dialog" className="max-h-[90vh] w-[min(880px,100%)] overflow-y-auto rounded-[10px] border border-line bg-paper p-4 shadow-lg">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold">审阅与交付</h2>
            <p className="mt-0.5 text-[11px] leading-5 text-muted">逐仓库审阅变更；提交与推送需显式触发，任务完成不推送。补丁是交付辅助，不是交付证明。</p>
          </div>
          <Button type="button" size="sm" variant="ghost" aria-label="关闭审阅与交付" onClick={() => setDeliveryOpen(false)}>×</Button>
        </div>
        <div className="mt-3 min-w-0"><DesktopDeliverySheet taskId={taskId} /></div>
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
    {!sessionsOpen && sessionNotice && <p role="alert" className="shrink-0 border-b border-line bg-paper px-4 py-2 text-[11px] text-destructive">{sessionNotice}</p>}
    {!sessionsOpen && lifecycleNotice && <p role="status" className="shrink-0 border-b border-line bg-soft px-4 py-2 text-[11px] text-ink">{lifecycleNotice}</p>}
    <Dialog open={sessionsOpen} onOpenChange={(open) => { if (!sessionBusy) { setSessionsOpen(open); if (!open) setRenaming(null); } }}>
      <DialogContent aria-label="全部会话" data-testid="session-panel" onOpenAutoFocus={(event) => { if (renaming) { event.preventDefault(); renameInput.current?.focus(); } }}>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <DialogTitle>全部会话</DialogTitle>
            <DialogDescription>一个任务可有多个会话，共享同一工作区与仓库；每个会话有自己的上下文、模型绑定与 SDK JSONL。</DialogDescription>
          </div>
          <Button type="button" size="sm" variant="ghost" aria-label="关闭会话列表" onClick={() => { setSessionsOpen(false); setRenaming(null); }}>×</Button>
        </div>
        {sessionNotice && <p role="alert" data-testid="session-notice" className="mt-2 rounded-[6px] border border-[#e0b4b4] bg-[#fdf3f3] p-2 text-[11px] leading-5 break-words text-[#ad4545]">{sessionNotice}</p>}
        {lifecycleNotice && <p role="status" data-testid="session-lifecycle-notice" className="mt-2 rounded-[6px] border border-line bg-soft p-2 text-[11px] leading-5 break-words text-ink">{lifecycleNotice}</p>}
        <ul className="mt-3 space-y-1.5">
          {sessions.length === 0 && <li className="text-[11px] text-muted">本任务还没有会话。</li>}
          {sessions.map((session) => <li key={session.id} data-testid={`session-row-${session.id}`} className={`rounded-[7px] border p-2 ${session.id === sessionId ? "border-accent bg-soft" : "border-line"}`}>
            {renaming?.id === session.id ? <form className="flex min-w-0 items-center gap-1.5" onSubmit={(event) => { event.preventDefault(); void renameOne(); }}>
              <input ref={renameInput} aria-label="会话名称" value={renaming.name} maxLength={40} autoFocus className="min-w-0 flex-1 rounded-[5px] border border-line bg-bg px-1.5 py-1 text-[12px]" onChange={(event) => setRenaming({ id: session.id, name: event.target.value })} />
              <Button type="submit" size="sm" disabled={sessionBusy || !renaming.name.trim() || renaming.name === session.name}>保存</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(null)}>取消</Button>
            </form> : <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{session.name}</span>
              {session.id === sessionId && <Badge variant="soft">当前</Badge>}
              {session.archived && <Badge variant="soft">已归档</Badge>}
              <span className="text-[10px] text-muted">{session.binding?.modelId ?? "跟随任务模型"} · {session.id}</span>
            </div>}
            <div className="mt-1 flex flex-wrap items-center gap-1" data-testid={`session-actions-${session.id}`}>
              {sessionActionRows(session, { current: session.id === sessionId }).map((action) => (
                <Button
                  key={action.id}
                  type="button"
                  size="sm"
                  variant="ghost"
                  data-testid={`session-${action.id}-${session.id}`}
                  disabled={sessionBusy || !action.enabled}
                  title={action.reason ?? `${action.label}「${session.name}」`}
                  onClick={() => {
                    if (action.id === "resume") void switchToSession(session);
                    else if (action.id === "stop") void stopOne(session.id);
                    else if (action.id === "archive") void archiveOne(session.id);
                    else if (action.id === "restore") void restoreOne(session.id);
                    else setDeletePrompt(session);
                  }}
                >
                  {action.label}
                </Button>
              ))}
              <Button type="button" size="sm" variant="ghost" disabled={sessionBusy} onClick={() => setRenaming({ id: session.id, name: session.name })}>重命名</Button>
            </div>
          </li>)}
        </ul>
        <div className="mt-3 flex items-center gap-2">
          <Button type="button" size="sm" disabled={sessionBusy || sessions.length >= 50} onClick={() => void newSession()}><Icon name="plus" />新建会话</Button>
          <span className="text-[10px] text-muted">新会话从零开始：不复用任何会话的历史，也不会沿用已删除会话的身份。删除会话会同时删除它的 SDK 记录，无法恢复。</span>
        </div>
      </DialogContent>
    </Dialog>
    {/* [#146] 删除确认：先说明真实影响，再执行。历史与草稿随会话删除；任务工作
        区与用户自己的原始目录不受影响；定时任务历史保留，并明确显示「会话已删除」。 */}
    <Dialog open={deletePrompt !== null} onOpenChange={(open) => { if (!open && !sessionBusy) setDeletePrompt(null); }}>
      {deletePrompt && <DialogContent aria-label="删除会话" data-testid="session-delete-confirm" onOpenAutoFocus={(event) => { event.preventDefault(); deleteCancel.current?.focus(); }}>
        <DialogTitle>删除会话「{deletePrompt.name}」</DialogTitle>
        <DialogDescription>删除不可恢复。如果你只是想让它不再出现在对话里，请用「归档」：归档保留全部历史且只读。</DialogDescription>
        <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-4 text-[11px] leading-5 text-ink">
          <li>本会话的记录、SDK JSONL 转录与执行日志会被删除。</li>
          <li>本会话的未发送草稿与待确认请求记录会被丢弃。</li>
          <li>任务工作区、仓库与用户原始目录不受影响：这里只删除会话记录，不删除工作区或来源文件。</li>
          <li>引用过本会话的定时任务执行记录会保留，并明确标记「会话已删除」（T18 边界）。</li>
          {deletePrompt.archived ? null : <li>若该会话正在执行：Host 会先中止回合、等待结算并释放工具与待确认操作，然后才删除。</li>}
        </ul>
        <div className="mt-4 flex justify-end gap-2">
          <Button ref={deleteCancel} type="button" variant="outline" disabled={sessionBusy} onClick={() => setDeletePrompt(null)}>取消</Button>
          <Button type="button" data-testid="session-delete-confirm-button" disabled={sessionBusy} onClick={() => void deleteOne(deletePrompt.id)}>{sessionBusy ? "删除中…" : "确认删除"}</Button>
        </div>
      </DialogContent>}
    </Dialog>
  </main></TooltipProvider>;
}
