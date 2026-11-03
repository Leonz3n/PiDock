import { describe, expect, it, vi } from "vitest";
import { availableReasoningLevels } from "./explicit-text-provider.js";
import { defaultThinkingLevel, switchSessionModel, type SessionSwitchPorts, type SwitchModelRow } from "./session-switch.js";
import type { SessionBinding } from "./session-index.js";

const row = (overrides: Partial<SwitchModelRow> = {}): SwitchModelRow => ({
  id: "model-a", name: "Model A", contextWindow: 128_000, maxTokens: 8_192, reasoning: false, ...overrides,
});

function ports(options: {
  sessions?: Record<string, { archived?: boolean; binding?: SessionBinding | null }>;
  models?: SwitchModelRow[];
  busy?: string[];
  turns?: Record<string, { turns: number; contextUsed: number | null }>;
  bindFails?: string;
} = {}): SessionSwitchPorts & { written: SessionBinding[]; rolledBack: number; bound: { sessionId: string; modelId: string; thinkingLevel?: string }[] } {
  const written: SessionBinding[] = [];
  const bound: { sessionId: string; modelId: string; thinkingLevel?: string }[] = [];
  const sessions = options.sessions ?? {};
  let rolledBack = 0;
  const api = {
    written, bound,
    get rolledBack() { return rolledBack; },
    provider: () => ({ profileId: "p-1", generation: 7, models: options.models ?? [row()] }),
    session: (sessionId: string) => {
      const session = sessions[sessionId];
      if (!session) throw new Error("session-unknown");
      return { id: sessionId, archived: session.archived === true, binding: session.binding ?? null };
    },
    busy: (sessionId: string) => (options.busy ?? []).includes(sessionId),
    digest: (sessionId: string) => options.turns?.[sessionId] ?? { turns: 0, contextUsed: null },
    persist: (binding: SessionBinding) => { written.push(binding); },
    bind: async (sessionId: string, binding: { modelId: string; thinkingLevel?: never }) => {
      if (options.bindFails) throw new Error(options.bindFails);
      bound.push({ sessionId, ...binding });
      return { modelId: binding.modelId, thinkingLevel: binding.thinkingLevel ?? "off" };
    },
    rollback: () => { rolledBack += 1; },
  };
  return api as unknown as SessionSwitchPorts & { written: SessionBinding[]; rolledBack: number; bound: { sessionId: string; modelId: string; thinkingLevel?: string }[] };
}

describe("[#139] per-session model switch policy", () => {
  it("declares only the levels a model actually supports, and never fabricates `off`", () => {
    expect(availableReasoningLevels({ reasoning: false })).toEqual([]);
    expect(availableReasoningLevels({ reasoning: true })).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(availableReasoningLevels({ reasoning: true, thinkingLevelMap: { off: null, minimal: "m", low: "l", xhigh: "xh" } }))
      .toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(defaultThinkingLevel(row({ reasoning: false }))).toBeNull();
    expect(defaultThinkingLevel(row({ reasoning: true }))).toBe("off");
    expect(defaultThinkingLevel(row({ reasoning: true, thinkingLevelMap: { off: null } }))).toBe("minimal");
  });

  it("switches the model, keeps the session and records the new binding", async () => {
    const p = ports({ sessions: { main: { binding: { profileId: "p-1", modelId: "model-a", thinkingLevel: null, generation: 7 } } },
      models: [row(), row({ id: "model-b", name: "Model B", contextWindow: 200_000 })] });
    const result = await switchSessionModel(p, { sessionId: "main", modelId: "model-b" });
    expect(result.binding).toMatchObject({ profileId: "p-1", modelId: "model-b", generation: 7 });
    expect(result.changed).toBe(true);
    expect(p.bound).toEqual([{ sessionId: "main", modelId: "model-b" }]);
    expect(p.written.at(-1)).toMatchObject({ modelId: "model-b" });
  });

  it("refuses by name before writing anything: unknown/archived session, unconfigured Provider, undeclared model", async () => {
    const noProvider = { ...ports(), provider: () => null };
    await expect(switchSessionModel(noProvider, { sessionId: "main", modelId: "model-a" })).rejects.toThrow("session-unknown");
    const unknownSession = ports({ sessions: {} });
    await expect(switchSessionModel(unknownSession, { sessionId: "main", modelId: "model-a" })).rejects.toThrow("session-unknown");
    const unconfigured = { ...ports({ sessions: { main: {} } }), provider: () => null };
    await expect(switchSessionModel(unconfigured, { sessionId: "main", modelId: "model-a" })).rejects.toThrow("provider-not-configured");
    const archived = ports({ sessions: { main: { archived: true } } });
    await expect(switchSessionModel(archived, { sessionId: "main", modelId: "model-a" })).rejects.toThrow("session-archived");
    const undeclared = ports({ sessions: { main: {} } });
    await expect(switchSessionModel(undeclared, { sessionId: "main", modelId: "model-z" })).rejects.toThrow("sdk-model-unknown");
    expect(undeclared.written).toEqual([]);
    expect(undeclared.bound).toEqual([]);
  });

  it("refuses while a turn is running instead of queueing the switch", async () => {
    const p = ports({ sessions: { main: {} }, busy: ["main"] });
    await expect(switchSessionModel(p, { sessionId: "main", modelId: "model-a" })).rejects.toThrow("sdk-session-busy");
    expect(p.written).toEqual([]);
    expect(p.bound).toEqual([]);
    // Another session being busy does not block this one.
    const other = ports({ sessions: { main: {}, "s-0badc0de": {} }, busy: ["s-0badc0de"] });
    await expect(switchSessionModel(other, { sessionId: "main", modelId: "model-a" })).resolves.toMatchObject({ sessionId: "main" });
  });

  it("refuses a model whose declared window cannot hold the stored context, and refuses unknown occupancy", async () => {
    const over = ports({ sessions: { main: {} }, models: [row({ id: "small", contextWindow: 1_000 })],
      turns: { main: { turns: 3, contextUsed: 4_096 } } });
    await expect(switchSessionModel(over, { sessionId: "main", modelId: "small" })).rejects.toThrow("sdk-context-over-limit");
    expect(over.written).toEqual([]);
    const unknown = ports({ sessions: { main: {} }, turns: { main: { turns: 2, contextUsed: null } } });
    await expect(switchSessionModel(unknown, { sessionId: "main", modelId: "model-a" })).rejects.toThrow("sdk-context-occupancy-unknown");
    expect(unknown.written).toEqual([]);
    // An empty session has no occupancy to compare: switching is allowed.
    const fresh = ports({ sessions: { main: {} }, turns: { main: { turns: 0, contextUsed: null } } });
    await expect(switchSessionModel(fresh, { sessionId: "main", modelId: "model-a" })).resolves.toMatchObject({ sessionId: "main" });
    // Exactly at the window is allowed (the window is the ceiling, not a margin).
    const exact = ports({ sessions: { main: {} }, models: [row({ contextWindow: 4_096 })], turns: { main: { turns: 1, contextUsed: 4_096 } } });
    await expect(switchSessionModel(exact, { sessionId: "main", modelId: "model-a" })).resolves.toMatchObject({ sessionId: "main" });
  });

  it("refuses an undeclared reasoning level and reports the SDK's own clamped level", async () => {
    const p = ports({ sessions: { main: {} }, models: [row({ reasoning: true, thinkingLevelMap: { off: null } })] });
    await expect(switchSessionModel(p, { sessionId: "main", modelId: "model-a", thinkingLevel: "off" })).rejects.toThrow("sdk-reasoning-unsupported");
    expect(p.written).toEqual([]);
    // `xhigh` is only declared when the model's map names it (Pi's own rule).
    await expect(switchSessionModel(p, { sessionId: "main", modelId: "model-a", thinkingLevel: "xhigh" })).rejects.toThrow("sdk-reasoning-unsupported");
    const clamped = ports({ sessions: { main: {} }, models: [row({ reasoning: true, thinkingLevelMap: { xhigh: "xh" } })] });
    // The kernel reports the clamped level; the policy stores what it will run with.
    clamped.bind = async () => ({ modelId: "model-a", thinkingLevel: "high" });
    const result = await switchSessionModel(clamped, { sessionId: "main", modelId: "model-a", thinkingLevel: "low" });
    expect(result.effectiveThinkingLevel).toBe("high");
    expect(result.binding.thinkingLevel).toBe("high");
  });

  it("rolls the session binding back when the kernel refuses the switch", async () => {
    const p = ports({ sessions: { main: {} }, bindFails: "sdk-session-busy" });
    await expect(switchSessionModel(p, { sessionId: "main", modelId: "model-a" })).rejects.toThrow("sdk-session-busy");
    expect(p.written).toHaveLength(1);
    expect(p.rolledBack).toBe(1);
  });

  it("keeps the existing level when the new model declares it, else uses the new model's default", async () => {
    const both = [row({ id: "a", reasoning: true }), row({ id: "b", reasoning: true })];
    const withLevel = ports({ sessions: { main: { binding: { profileId: "p-1", modelId: "a", thinkingLevel: "medium", generation: 7 } } }, models: both });
    expect((await switchSessionModel(withLevel, { sessionId: "main", modelId: "b" })).binding.thinkingLevel).toBe("medium");
    const narrowed = [row({ id: "a", reasoning: true }), row({ id: "b", reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null } })];
    const reset = ports({ sessions: { main: { binding: { profileId: "p-1", modelId: "a", thinkingLevel: "medium", generation: 7 } } }, models: narrowed });
    expect((await switchSessionModel(reset, { sessionId: "main", modelId: "b" })).binding.thinkingLevel).toBe("high");
    const noReasoning = [row({ id: "a", reasoning: true }), row({ id: "b", reasoning: false })];
    const plain = ports({ sessions: { main: { binding: { profileId: "p-1", modelId: "a", thinkingLevel: "medium", generation: 7 } } }, models: noReasoning });
    const switched = await switchSessionModel(plain, { sessionId: "main", modelId: "b" });
    expect(switched.binding.thinkingLevel).toBeNull();
    // No declared level at all: the readout stays unknown instead of claiming `off`.
    expect(switched.effectiveThinkingLevel).toBeNull();
  });

  it("changes nothing when the session is already bound to the same model and level", async () => {
    const p = ports({ sessions: { main: { binding: { profileId: "p-1", modelId: "model-a", thinkingLevel: null, generation: 7 } } } });
    const result = await switchSessionModel(p, { sessionId: "main", modelId: "model-a" });
    expect(result.changed).toBe(false);
  });

  it("does not touch the kernel when the target model is undeclared (no eviction, no model call)", async () => {
    const bind = vi.fn();
    const p = ports({ sessions: { main: {} } });
    p.bind = bind;
    await expect(switchSessionModel(p, { sessionId: "main", modelId: "nope" })).rejects.toThrow("sdk-model-unknown");
    expect(bind).not.toHaveBeenCalled();
  });
});
