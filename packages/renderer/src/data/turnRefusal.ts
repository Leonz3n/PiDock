/**
 * [#139] Was a refused turn a DEFINITE refusal, or is its outcome unknown?
 *
 * Real-Electron evidence for #139 caught a `task-locked` refusal (another
 * session of the SAME task holds the one running turn) rendered as
 * 「请求结果未知」. That is the wrong claim: the Host refused before the turn
 * existed, the endpoint never saw the prompt, and no reply can be missing. The
 * user needs the busy state and the retry-by-request-id, not a warning to go
 * verify history.
 *
 * This classifier only names refusals that are decidable from the error text the
 * Host returned. Anything else (`invoke timeout`, a dropped IPC call, an
 * unparseable answer) stays UNKNOWN — the opposite mistake would be worse.
 */

export type TurnRefusal = {
  /** The task is busy: another session of this task holds the running turn. */
  busy: boolean;
  /** The exact sentence the composer shows; it quotes the Host's own reason. */
  notice: string;
};

/** Refusals the Host produces before a turn starts, so no reply can be missing. */
const DEFINITE_REFUSALS: ReadonlyArray<{ code: string; busy: boolean }> = [
  { code: "task-locked", busy: true },
  { code: "sdk-session-busy", busy: true },
  { code: "session-archived", busy: false },
  { code: "session-unknown", busy: false },
  { code: "permission-denied", busy: false },
  { code: "invalid-payload", busy: false },
];

export function definiteTurnRefusal(error: string): TurnRefusal | null {
  const text = error.trim();
  const matched = DEFINITE_REFUSALS.find((entry) => text === entry.code || text.startsWith(`${entry.code}:`) ||
    text.startsWith(`${entry.code} `) || text.startsWith(`${entry.code}：`));
  if (matched === undefined) return null;
  return {
    busy: matched.busy,
    notice: matched.busy
      ? `忙碌：${text}；这是 Host 的明确拒绝，本次请求未开始（不是「结果未知」）；对方结束后可按原 ID 重试`
      : `明确拒绝：${text}；本次请求未开始（不是「结果未知」），可按原 ID 重试`,
  };
}
