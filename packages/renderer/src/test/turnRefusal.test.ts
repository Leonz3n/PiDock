/**
 * [#139] A definite Host refusal is not an unknown outcome.
 *
 * The real-Electron evidence caught `task-locked` — another session of this task
 * holds the running turn — rendered as 「请求结果未知：…请核验或按原 ID 重试」.
 * Nothing was unknown: the Host refused before the turn existed. This pins the
 * classification so the composer can say 忙碌/明确拒绝 for a decidable refusal and
 * keep 「结果未知」 only for errors that really are undecidable.
 */
import { describe, expect, it } from "vitest";
import { definiteTurnRefusal } from "../data/turnRefusal";

describe("[#139] turn refusal classification", () => {
  it("names a task-locked refusal as busy, never as unknown", () => {
    const refusal = definiteTurnRefusal("task-locked: 同一任务同时只能有一个会话执行");
    expect(refusal).not.toBeNull();
    expect(refusal?.busy).toBe(true);
    expect(refusal?.notice).toContain("忙碌");
    expect(refusal?.notice).toContain("明确拒绝");
    expect(refusal?.notice).toContain("task-locked: 同一任务同时只能有一个会话执行");
    // The sentence may CONTRAST with the old wording; it must not CLAIM it.
    expect(refusal?.notice.startsWith("请求结果未知")).toBe(false);
    expect(refusal?.notice).not.toContain("请核验");
    // The retry the evidence exercised stays available.
    expect(refusal?.notice).toContain("按原 ID 重试");
  });

  it("treats a bare task-locked and a session-busy refusal the same way", () => {
    expect(definiteTurnRefusal("task-locked")?.busy).toBe(true);
    expect(definiteTurnRefusal("sdk-session-busy: 该会话正在执行回合")?.busy).toBe(true);
  });

  it("names the other decided refusals without calling them busy", () => {
    for (const text of ["session-archived", "session-unknown", "permission-denied: 只读档", "invalid-payload: task/sdkStart.text"]) {
      const refusal = definiteTurnRefusal(text);
      expect({ text, busy: refusal?.busy }).toEqual({ text, busy: false });
      expect({ text, refused: refusal?.notice.startsWith("明确拒绝：") }).toEqual({ text, refused: true });
    }
  });

  it("keeps an undecidable failure unknown instead of guessing a refusal", () => {
    // A dropped IPC call really is unknown: claiming "definitely refused" would
    // tell the user no reply can be missing when it may be.
    for (const text of ["invoke timeout", "SDK 响应不可用", "task-locked-by-someone-else", ""]) {
      expect({ text, refusal: definiteTurnRefusal(text) }).toEqual({ text, refusal: null });
    }
  });
});
