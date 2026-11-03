/**
 * [#138] 渲染层的暂存回复序列闸门（`DesktopConversation` 的 `暂存回复 · 尚未核验`）。
 *
 * 真实 Electron 证据暴露的缺陷：`start` 的 ACK 与 Host 的 SSE 增量是同一条 IPC 上
 * 的两条路，增量可以在 ACK 被渲染层处理之前到达。旧实现按「当前回合 + 严格连续」
 * 判断，于是
 *
 * 1. ACK 之前到达的增量被静默丢弃（连 sequence 都不记账）；
 * 2. ACK 之后第一条被接受的增量 sequence 已经 > 1，`sequence !== last + 1` 成立，
 *    每条增量都触发一次 reconcile，而 reconcile 会清空 sequence 表与暂存文本——
 *    该回合的暂存区永远是空的（第一个回合之外都看不到流式回复）。
 *
 * 现在的顺序闸门：
 *
 * - ACK 之前只**暂存**（按 `turnId` 分组，有界），不渲染也不计账；
 * - ACK 起来时按 sequence 升序回放该回合的增量，第一条被接受的增量锚定基线
 *   （所以「从 3 开始」的增量照样能流式渲染，而不是被当成缺口）；
 * - 锚定之后仍要求严格连续：重复/回退的（≤ last）丢弃且不清空暂存；真正的缺口
 *   （> last + 1）返回 `resync`，由调用方走投影重读，绝不把增量拼进已核验历史。
 *
 * 这里不读任何 Host 状态，也不假设 `turnId` 的形状：它是不透明字符串。
 */

export type TurnStreamEvent = { turnId: string; sequence: unknown; type: unknown; text?: unknown };

export type TurnStreamIngest =
  | { kind: "staged"; text: string }
  /** No ACK yet: kept for the turn the ACK will name. */
  | { kind: "buffered" }
  /** Already applied (a replay/retry of the same sequence); the staging is kept. */
  | { kind: "duplicate" }
  /** Another turn's event, or a non-delta event that only advances the sequence. */
  | { kind: "ignored" }
  /** The caller must re-read the projection; nothing is appended to the history. */
  | { kind: "resync"; reason: "gap" | "invalid" | "too-long" };

/** Host 的 `turn/event` 一回合最多 256 条（main 的 `last >= 256` 是同一条界）。 */
const MAX_SEQUENCE = 256;
const MAX_TEXT = 16384;
const MAX_BUFFERED_EVENTS = 512;
const MAX_BUFFERED_CHARS = 65536;
const MAX_BUFFERED_TURNS = 8;

type BufferedEvent = { sequence: number; text: string };
type BufferedTurn = { events: BufferedEvent[]; chars: number; truncated: boolean };

export class TurnStream {
  /** The ACK'd turn this staging belongs to; `null` while the ACK is outstanding. */
  private turnId: string | null = null;
  /** Last applied sequence (0 = nothing applied yet). */
  private last = 0;
  private staged = "";
  private buffered = new Map<string, BufferedTurn>();

  /** The text to render now (`""` when this turn has no staged delta). */
  get text(): string { return this.staged; }

  /** Reset for a new attempt, a disconnect or a resync: nothing survives. */
  reset(): void {
    this.turnId = null;
    this.last = 0;
    this.staged = "";
    this.buffered.clear();
  }

  /**
   * The `start` ACK named `turnId` (or `null` when the turn is already terminal).
   * Replays the deltas that arrived before the ACK, in sequence order.
   */
  ack(turnId: string | null): { text: string; resync: boolean } {
    if (turnId === null) { this.reset(); return { text: "", resync: false }; }
    if (this.turnId !== turnId) { this.turnId = turnId; this.last = 0; this.staged = ""; }
    const pending = this.buffered.get(turnId);
    // Only the ACK'd turn can still become current; other turns' buffered deltas
    // belong to turns this page will never stage.
    this.buffered.clear();
    if (!pending) return { text: this.staged, resync: false };
    if (pending.truncated) {
      // The pre-ACK replay did not fit the bounded buffer: stage nothing rather
      // than a reply with a hole in it, and let the caller re-read the projection.
      this.staged = ""; this.last = 0;
      return { text: "", resync: true };
    }
    for (const event of [...pending.events].sort((left, right) => left.sequence - right.sequence)) {
      // The first buffered delta anchors the baseline: a replay may start at 1,
      // or (if this page subscribed late) at any later suffix of the turn.
      if (this.last === 0) this.last = event.sequence - 1;
      if (event.sequence <= this.last) continue; // duplicate inside the replay
      // A hole means an earlier delta never arrived; stop instead of staging a
      // reply with a missing chunk in the middle.
      if (event.sequence !== this.last + 1) break;
      this.last = event.sequence;
      this.staged += event.text;
    }
    if (this.staged.length > MAX_TEXT) { this.staged = ""; this.last = 0; return { text: "", resync: true }; }
    return { text: this.staged, resync: false };
  }

  /**
   * A projection/status read: the same live turn keeps its staging (the deltas
   * that already arrived are still the truth), any other turn starts empty.
   */
  resync(turnId: string | null): string {
    if (turnId !== null && turnId === this.turnId) return this.staged;
    this.turnId = null; this.last = 0; this.staged = "";
    if (turnId === null) { this.buffered.clear(); return ""; }
    return this.ack(turnId).text;
  }

  ingest(event: TurnStreamEvent): TurnStreamIngest {
    const sequence = event.sequence;
    if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) return { kind: "resync", reason: "invalid" };
    const at = sequence as number;
    if (this.turnId === null) return this.beforeAck(event, at);
    if (event.turnId !== this.turnId) return { kind: "ignored" };
    if (this.last !== 0 && at <= this.last) return { kind: "duplicate" };
    if (at > MAX_SEQUENCE) return { kind: "resync", reason: "too-long" };
    // The first observed delta anchors the baseline; after that the stream must
    // be contiguous (a hole is a real gap, not a late subscription).
    const base = this.last === 0 ? at - 1 : this.last;
    if (at !== base + 1) return { kind: "resync", reason: "gap" };
    const isDelta = event.type === "delta";
    if (isDelta && (typeof event.text !== "string" || event.text.length > MAX_TEXT)) return { kind: "resync", reason: "invalid" };
    if (isDelta && this.staged.length + (event.text as string).length > MAX_TEXT) return { kind: "resync", reason: "too-long" };
    // Only a validated event moves the sequence: a refused one leaves the gate
    // exactly where it was.
    this.last = at;
    if (!isDelta) return { kind: "ignored" };
    this.staged += event.text as string;
    return { kind: "staged", text: this.staged };
  }

  /** Before the ACK only deltas matter, and only as text for the future turn. */
  private beforeAck(event: TurnStreamEvent, at: number): TurnStreamIngest {
    if (event.type !== "delta" || typeof event.text !== "string" || event.text.length > MAX_TEXT) return { kind: "ignored" };
    const known = this.buffered.get(event.turnId);
    const entry = known ?? { events: [], chars: 0, truncated: false };
    if (known === undefined && this.buffered.size >= MAX_BUFFERED_TURNS) return { kind: "ignored" };
    if (entry.truncated || at > MAX_SEQUENCE || entry.events.length >= MAX_BUFFERED_EVENTS ||
        entry.chars + event.text.length > MAX_BUFFERED_CHARS) {
      // Bounded: an overflowing replay is dropped as a whole (never a hole).
      entry.truncated = true;
      entry.events = [];
      entry.chars = 0;
      this.buffered.set(event.turnId, entry);
      return { kind: "buffered" };
    }
    entry.events.push({ sequence: at, text: event.text });
    entry.chars += event.text.length;
    this.buffered.set(event.turnId, entry);
    return { kind: "buffered" };
  }
}
