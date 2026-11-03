import { describe, expect, it } from "vitest";
import { TurnStream } from "../data/turnStream";

/**
 * [#138] The staging gate, unit-level.
 *
 * Locks the defect the real-Electron capture found: deltas that arrive before
 * the start ACK were dropped uncounted, so after the ACK the first accepted
 * delta's `sequence` was already > 1 and the "must be last + 1" rule cleared the
 * staging on every event. The gate now buffers pre-ACK deltas per turn, anchors
 * the first accepted delta of a turn, drops duplicates without clearing, and
 * only asks for a projection re-read on a real gap.
 */
const TURN = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";
const delta = (sequence: number, text: string, turnId = TURN) => ({ turnId, sequence, type: "delta", text });

describe("turn stream ordering gate", () => {
  it("stages nothing for another turn and ignores its deltas after the ACK", () => {
    const stream = new TurnStream();
    stream.ack(TURN);
    expect(stream.ingest(delta(1, "other", OTHER))).toEqual({ kind: "ignored" });
    expect(stream.text).toBe("");
    expect(stream.ingest(delta(1, "mine"))).toEqual({ kind: "staged", text: "mine" });
  });

  it("replays pre-ACK deltas in sequence order and anchors a stream that starts at 3", () => {
    const stream = new TurnStream();
    // Out-of-order arrival before the ACK: the ACK must replay by sequence.
    expect(stream.ingest(delta(4, "D"))).toEqual({ kind: "buffered" });
    expect(stream.ingest(delta(3, "C"))).toEqual({ kind: "buffered" });
    expect(stream.ingest(delta(5, "E"))).toEqual({ kind: "buffered" });
    expect(stream.text).toBe("");
    const acked = stream.ack(TURN);
    expect(acked).toEqual({ text: "CDE", resync: false });
    expect(stream.text).toBe("CDE");
    // The baseline is now 5, so the live stream continues at 6.
    expect(stream.ingest(delta(6, "F"))).toEqual({ kind: "staged", text: "CDEF" });
  });

  it("keeps staging through duplicate and late deltas instead of clearing it", () => {
    const stream = new TurnStream();
    stream.ack(TURN);
    expect(stream.ingest(delta(1, "a"))).toEqual({ kind: "staged", text: "a" });
    expect(stream.ingest(delta(2, "b"))).toEqual({ kind: "staged", text: "ab" });
    // A replay of an applied delta is not a gap: the staged text survives.
    expect(stream.ingest(delta(2, "b"))).toEqual({ kind: "duplicate" });
    expect(stream.ingest(delta(1, "a"))).toEqual({ kind: "duplicate" });
    expect(stream.text).toBe("ab");
    expect(stream.ingest(delta(3, "c"))).toEqual({ kind: "staged", text: "abc" });
  });

  it("asks for a resync only on a real gap after the anchor", () => {
    const stream = new TurnStream();
    stream.ack(TURN);
    stream.ingest(delta(1, "a"));
    expect(stream.ingest(delta(3, "c"))).toEqual({ kind: "resync", reason: "gap" });
    // The gate itself is not the caller: `resync` is a request, not a mutation.
    expect(stream.resync(TURN)).toBe("a");
  });

  it("refuses invalid, over-long and out-of-range events by name", () => {
    const stream = new TurnStream();
    stream.ack(TURN);
    for (const sequence of [0, -1, 1.5, Number.NaN, "2", null]) {
      expect(stream.ingest({ turnId: TURN, sequence, type: "delta", text: "x" })).toEqual({ kind: "resync", reason: "invalid" });
    }
    expect(stream.ingest(delta(257, "x"))).toEqual({ kind: "resync", reason: "too-long" });
    expect(stream.ingest({ turnId: TURN, sequence: 1, type: "delta", text: "x".repeat(16385) })).toEqual({ kind: "resync", reason: "invalid" });
    expect(stream.text).toBe("");
    // A non-delta event only advances the sequence; it stages no text.
    expect(stream.ingest({ turnId: TURN, sequence: 1, type: "usage" })).toEqual({ kind: "ignored" });
    expect(stream.ingest(delta(2, "y"))).toEqual({ kind: "staged", text: "y" });
  });

  it("keeps a same-turn projection resync honest and clears on another turn", () => {
    const stream = new TurnStream();
    stream.ack(TURN);
    stream.ingest(delta(1, "kept"));
    // The after-ACK reconcile of the SAME turn must not throw the staging away.
    expect(stream.resync(TURN)).toBe("kept");
    expect(stream.text).toBe("kept");
    // Another turn (or a terminal turn) starts from nothing.
    expect(stream.resync(OTHER)).toBe("");
    expect(stream.resync(null)).toBe("");
    expect(stream.ingest(delta(1, "late"))).toEqual({ kind: "buffered" });
    expect(stream.text).toBe("");
    expect(stream.resync(TURN)).toBe("late");
  });

  it("drops an over-large pre-ACK replay as a whole and asks for a resync", () => {
    const stream = new TurnStream();
    for (let index = 1; index <= 513; index += 1) stream.ingest(delta(index, "x"));
    expect(stream.ack(TURN)).toEqual({ text: "", resync: true });
    expect(stream.text).toBe("");
  });

  it("a fresh attempt after reset stages only its own turn", () => {
    const stream = new TurnStream();
    stream.ack(TURN);
    stream.ingest(delta(1, "old"));
    stream.reset();
    expect(stream.text).toBe("");
    stream.ingest(delta(1, "before-ack"));
    expect(stream.ack(TURN)).toEqual({ text: "before-ack", resync: false });
    expect(stream.ingest(delta(1, "old", OTHER))).toEqual({ kind: "ignored" });
  });
});
