import { afterEach, describe, expect, it, vi } from "vitest";
import { REASONING_LABELS, REASONING_LEVELS } from "../data/providerState";
import { parseSessionContext, readSessionContext, writeSessionThinking } from "../data/sessionContext";
import type { PidockBridge } from "../data/shellBridge";

/**
 * [UI 对齐 S8c] #47: `task/sessionContext` / `task/setSessionThinking` reach the
 * composer through this module, so the two ways it can lie are pinned here — a
 * shape the Host never promised must not become a half-read control, and a Host
 * refusal must stay the Host's own text instead of a value.
 */

const context = (overrides: Record<string, unknown> = {}) => ({
  providerId: "provider-anthropic",
  providerName: "Anthropic 官方",
  model: "claude-sonnet-4-5",
  modelName: "Claude Sonnet",
  availability: { status: "available" },
  window: 200,
  used: 24.8,
  source: "estimated",
  tokens: 4321,
  percent: 12.4,
  thinking: "high",
  thinkingCatalog: "declared",
  ...overrides,
});

afterEach(() => { delete window.pidock; vi.restoreAllMocks(); });

describe("parseSessionContext", () => {
  it("keeps the Host's own level, catalog and occupancy, and a null percent as null", () => {
    expect(parseSessionContext({ context: context({ percent: null, window: 0 }) })).toMatchObject({
      providerId: "provider-anthropic",
      model: "claude-sonnet-4-5",
      window: 0,
      used: 24.8,
      source: "estimated",
      tokens: 4321,
      percent: null,
      thinking: "high",
      thinkingCatalog: "declared",
    });
  });

  it.each([
    { label: "no context object", payload: {} },
    { label: "a non-object context", payload: { context: 7 } },
    { label: "a missing thinking tier", payload: { context: context({ thinking: undefined }) } },
    { label: "an unknown catalog", payload: { context: context({ thinkingCatalog: "declared-ish" }) } },
    { label: "an unknown occupancy source", payload: { context: context({ source: "measured" }) } },
    { label: "a negative occupancy", payload: { context: context({ used: -1 }) } },
    { label: "a non-numeric percent", payload: { context: context({ percent: "12.4" }) } },
    { label: "a non-numeric cumulative", payload: { context: context({ tokens: null }) } },
  ])("refuses $label instead of defaulting a field", ({ payload }) => {
    expect(() => parseSessionContext(payload)).toThrow("Host 会话读数返回异常");
  });

  it("labels every tier the Host can name", () => {
    for (const level of REASONING_LEVELS) expect(REASONING_LABELS[level]).toBeTruthy();
  });
});

describe("session read/write through the existing Host ops", () => {
  it("reads through task/sessionContext and reports a refusal as the Host's own text", async () => {
    const taskOp = vi.fn(async (_taskId: string, op: string) => op === "task/sessionContext"
      ? { ok: true, payload: { context: context() } }
      : { ok: false, error: "task-locked" });
    window.pidock = { taskOp } as unknown as PidockBridge;
    await expect(readSessionContext({ taskId: "task-a", sessionId: "main" })).resolves.toMatchObject({ ok: true, context: { tokens: 4321 } });
    expect(taskOp).toHaveBeenCalledWith("task-a", "task/sessionContext", { sessionId: "main" });

    taskOp.mockResolvedValueOnce({ ok: false, error: "task-unknown: 任务不存在" });
    await expect(readSessionContext({ taskId: "task-a", sessionId: "main" })).resolves.toEqual({ ok: false, error: "task-unknown: 任务不存在" });
  });

  it("writes only the session and the level, and returns the Host's post-write readout", async () => {
    const taskOp = vi.fn(async (_taskId: string, op: string, payload?: Record<string, unknown>) => op === "task/setSessionThinking"
      ? { ok: true, payload: { context: context({ thinking: String(payload?.["level"]) }) } }
      : { ok: false, error: "unexpected" });
    window.pidock = { taskOp } as unknown as PidockBridge;
    await expect(writeSessionThinking({ taskId: "task-a", sessionId: "main", level: "xhigh" })).resolves.toMatchObject({ ok: true, context: { thinking: "xhigh" } });
    expect(taskOp).toHaveBeenCalledWith("task-a", "task/setSessionThinking", { sessionId: "main", level: "xhigh" });
  });

  it("turns the Host's refusal wording and a malformed readout into `ok:false`, never a value", async () => {
    const taskOp = vi.fn(async (): Promise<{ ok: boolean; payload?: unknown; error?: string }> => ({ ok: false, error: "thinking-level-not-declared: 模型未声明该推理档位：max" }));
    window.pidock = { taskOp } as unknown as PidockBridge;
    await expect(writeSessionThinking({ taskId: "task-a", sessionId: "main", level: "max" }))
      .resolves.toEqual({ ok: false, error: "thinking-level-not-declared: 模型未声明该推理档位：max" });

    taskOp.mockResolvedValue({ ok: true, payload: { context: { thinking: "max" } } });
    await expect(readSessionContext({ taskId: "task-a", sessionId: "main" })).resolves.toEqual({ ok: false, error: "Host 会话读数返回异常" });
  });

  it("names a missing shell channel instead of assuming a Host round trip", async () => {
    window.pidock = {} as PidockBridge;
    const read = await readSessionContext({ taskId: "task-a", sessionId: "main" });
    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.error).toContain("内存模拟数据");
  });
});
