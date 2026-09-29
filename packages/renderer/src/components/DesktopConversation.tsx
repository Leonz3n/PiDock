import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "./Icon";
import { loadDesktopProjects, type DesktopProjects } from "../data/desktopProjects";

const sessionId = "main";
const button = "inline-flex min-h-8 items-center justify-center gap-1.5 border border-line bg-paper px-2.5 py-1 text-xs hover:bg-bg disabled:cursor-not-allowed disabled:opacity-50";
type Turn = { taskId: string; sessionId: string; requestId: string; turnId: string; state: "accepted" | "done" | "cancelled" | "failed" | "interrupted"; error?: string; needsResync: boolean };
type Message = { role: "user" | "assistant"; text: string; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null };
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
function parseSnapshot(value: unknown): Snapshot {
  if (!object(value) || value.source !== "sdk-jsonl" || value.sessionId !== sessionId || !Array.isArray(value.messages) ||
      value.messages.length > 80 || typeof value.pending !== "boolean" || typeof value.interrupted !== "boolean") throw new Error("SDK 历史返回异常");
  const messages = value.messages.map((item: unknown) => {
    if (!object(item) || !["user", "assistant"].includes(String(item.role)) || typeof item.text !== "string" ||
        !(item.usage === null || (object(item.usage) && ["input", "output", "cacheRead", "cacheWrite"].every((key) => Number.isSafeInteger((item.usage as Record<string, unknown>)[key]) && Number((item.usage as Record<string, unknown>)[key]) >= 0)))) throw new Error("SDK 消息返回异常");
    return item as Message;
  });
  return { source: "sdk-jsonl", sessionId, messages, pending: value.pending, interrupted: value.interrupted };
}
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

export function DesktopConversation({ taskId, name, roots, association, onBack }: { taskId: string; name: string; roots: string; association: string; onBack: () => void }) {
  const bridge = window.pidock;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const recovered = useRef(readReceipt(taskId));
  const [draft, setDraft] = useState(recovered.current.receipt?.text ?? "");
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
      const originalText = attemptRef.current.text;
      if (turn.state !== "accepted") {
        try { clearReceipt(taskId, requestId); setReceiptError(null); setDraft((text) => text === originalText ? "" : text); }
        catch { setReceiptError("本机待确认请求记录无法清除，已禁止发送；请核验本机数据"); }
      }
      setCurrent({ ...attemptRef.current, turnId: turn.turnId, phase: turn.state === "accepted" ? "accepted" : "terminal", state: turn.state });
    }
    else if (requestId && attemptRef.current) setCurrent({ ...attemptRef.current, phase: "unknown" });
    setNotice(turn ? turn.state === "accepted" ? "正在等待模型" : turn.state === "done" ? "已从 SDK 历史核验" : `执行${turn.state === "cancelled" ? "已取消" : "未完成"}${turn.error ? `：${turn.error}` : ""}` :
      requestId ? "请求状态未知；可按原 ID 重试，不能发送新消息" : projection.interrupted ? "会话上次执行中断，请核验后继续" : projection.pending ? "会话正在执行，请等待" : "");
  }, [request, taskId]);
  const [connectionKey, setConnectionKey] = useState(0);
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
      if (turn.state === "accepted") setDraft("");
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
  return <main data-testid="desktop-conversation" className="flex h-screen min-h-0 min-w-0 flex-col overflow-hidden bg-bg text-ink">
    <header className="flex min-w-0 items-center gap-3 border-b border-line bg-paper px-3 py-2">
      <button type="button" className={button} onClick={onBack} aria-label="返回任务列表" title="返回任务列表"><Icon name="arrow" className="-rotate-90" /></button>
      <div className="min-w-0"><h1 className="truncate text-sm font-semibold">{name}</h1><p className="truncate text-xs text-muted">{taskId} · SDK / main</p></div>
      <button type="button" className={`${button} ml-auto`} onClick={() => void refresh()} title="核验状态"><Icon name="refresh" /><span>核验</span></button>
    </header>
    <section aria-label="SDK 对话历史" className="mx-auto w-full max-w-[820px] min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto px-3 py-4">
      <p className="text-xs text-muted">SDK JSONL 已确认历史 · 最近最多 80 条</p>
      {snapshot && !snapshot.messages.length && <p className="py-8 text-center text-sm text-muted">尚未开始 · 无 SDK 会话记录</p>}
      {snapshot?.messages.map((message, index) => <article key={index} className="min-w-0 border-b border-line pb-3 text-sm"><div className="mb-1 text-xs font-semibold text-muted">{message.role === "user" ? "你" : "Agent"}</div><p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.text}</p>{message.usage && <p className="mt-2 text-xs text-muted">SDK 用量 · 输入 {message.usage.input} / 输出 {message.usage.output} / 缓存读取 {message.usage.cacheRead} / 写入 {message.usage.cacheWrite}</p>}</article>)}
      {stream && <article className="min-w-0 border-l-2 border-ink pl-3 text-sm"><p className="mb-1 text-xs text-muted">暂存回复 · 尚未核验</p><p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{stream}</p></article>}
    </section>
    <div className="border-t border-line bg-paper px-3 py-3"><div className="mx-auto max-w-[820px] min-w-0">
      {receiptError && <p role="alert" className="mb-2 break-words text-xs text-[#ad4545]">{receiptError}</p>}
      {notice && <p role="status" className="mb-2 break-words text-xs text-muted">{notice}</p>}
      <div className="mb-2 flex flex-wrap gap-2">{invalidated ? <button className={button} type="button" onClick={onBack}>返回任务列表</button> : (!connected || !valid) && <button className={button} type="button" onClick={() => setConnectionKey((key) => key + 1)}>重新连接</button>}
        {attempt?.phase === "unknown" && <button className={button} type="button" onClick={() => void refresh()}>查询原请求</button>}
        {attempt?.phase === "unknown" && <button className={button} type="button" disabled={!valid} onClick={() => void start(true)}>按原 ID 重试</button>}
        {attempt?.phase === "accepted" && <button className={button} type="button" onClick={() => void stop()}><Icon name="stop" />停止</button>}
      </div>
      <form onSubmit={submit} className="flex min-w-0 items-end gap-2"><textarea aria-label="消息" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!blocked) void start(); } }} rows={2} maxLength={16384} className="min-w-0 flex-1 resize-y border border-line bg-bg p-2 text-sm" placeholder="发送给 Agent" /><button className={button} type="submit" disabled={blocked || !draft.trim()} aria-label="发送" title="发送"><Icon name="arrow" /></button></form>
    </div></div>
  </main>;
}
