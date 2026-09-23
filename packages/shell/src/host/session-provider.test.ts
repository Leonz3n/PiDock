import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskWorkspaceHost, memoryTaskStore } from "./task-host.js";
import { resetPiSequencesForTests } from "../main/pi-session.js";
import type { ProviderProfileRow } from "../main/provider-config.js";

const TASK_DIR = join(mkdtempSync(join(tmpdir(), "pidock-11-")), "task-abcdef12");

const ANTHROPIC: ProviderProfileRow = {
  id: "provider-anthropic",
  name: "Anthropic 官方",
  protocol: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  authRef: "anthropic-key",
  enabled: true,
  models: [
    { id: "claude-sonnet-4-5", name: "Claude Sonnet", contextWindow: 200, supportsImages: true, thinking: { mode: "custom", levels: ["off", "low", "high"], default: "low" } },
    { id: "claude-haiku-4-5", contextWindow: 200 },
  ],
};

const LOCAL: ProviderProfileRow = {
  id: "provider-local",
  name: "本地推理",
  protocol: "openai-chat-completions",
  baseUrl: "http://127.0.0.1:11434/v1",
  enabled: true,
  models: [{ id: "本地 Qwen", contextWindow: 32, thinking: { mode: "custom", levels: ["low", "medium"], default: "low" } }],
};

function host(store = memoryTaskStore()) {
  return { host: new TaskWorkspaceHost("task-a", TASK_DIR, store, () => "2026-09-22T10:00:00+08:00"), store };
}

function withCatalog(taskHost: TaskWorkspaceHost, catalog: ProviderProfileRow[] = [ANTHROPIC, LOCAL]) {
  taskHost.setProviderCatalog(catalog);
}

beforeEach(() => {
  resetPiSequencesForTests();
});

describe("[PiDock 11] provider catalog + session identity", () => {
  it("validates catalog entries fail-closed (auth value instead of a reference is rejected)", () => {
    const { host: taskHost } = host();
    expect(() => taskHost.setProviderCatalog([{ ...ANTHROPIC, authRef: "sk-live-abcdefghijklmnop" }])).toThrow(/auth-ref-looks-like-secret/);
    expect(() => taskHost.setProviderCatalog([{ ...ANTHROPIC, protocol: "gemini" }])).toThrow(/protocol-unsupported/);
    expect(() => taskHost.setProviderCatalog([{ ...ANTHROPIC, id: "" }])).toThrow(/needs an id/);
    expect(taskHost.providerCatalog()).toEqual([]);
  });

  it("reports the selected provider/model, declared window and cumulative tokens", () => {
    const { host: taskHost } = host();
    withCatalog(taskHost);
    const context = taskHost.sessionContext({ sessionId: "main" });
    expect(context).toMatchObject({
      providerId: "provider-anthropic",
      providerName: "Anthropic 官方",
      model: "claude-sonnet-4-5",
      modelName: "Claude Sonnet",
      window: 200,
      used: 0,
      source: "actual",
      tokens: 0,
      availability: { status: "available" },
    });
    expect(context.percent).toBe(0);
  });

  it("reports an unavailable configuration instead of silently choosing another (missing/disabled/model-removed)", () => {
    const store = memoryTaskStore();
    const first = new TaskWorkspaceHost("task-a", TASK_DIR, store, () => "2026-09-22T10:00:00+08:00");
    first.setProviderCatalog([ANTHROPIC, LOCAL]);
    first.setSessionModel({ sessionId: "main", providerId: "provider-anthropic", model: "claude-haiku-4-5" });

    // Reopen the same task with a catalog where the provider is gone: the
    // persisted identity is reported unavailable, never rerouted.
    const restarted = new TaskWorkspaceHost("task-a", TASK_DIR, store, () => "2026-09-23T10:00:00+08:00");
    restarted.setProviderCatalog([LOCAL]);
    expect(restarted.sessionContext({ sessionId: "main" })).toMatchObject({
      providerId: "provider-anthropic",
      providerName: null,
      model: "claude-haiku-4-5",
      availability: { status: "missing" },
    });

    const disabled = new TaskWorkspaceHost("task-a", TASK_DIR, store, () => "2026-09-23T10:00:00+08:00");
    disabled.setProviderCatalog([{ ...ANTHROPIC, enabled: false }, LOCAL]);
    expect(disabled.sessionContext({ sessionId: "main" }).availability.status).toBe("disabled");

    const modelGone = new TaskWorkspaceHost("task-a", TASK_DIR, store, () => "2026-09-23T10:00:00+08:00");
    modelGone.setProviderCatalog([{ ...ANTHROPIC, models: [ANTHROPIC.models[0]] }, LOCAL]);
    expect(modelGone.sessionContext({ sessionId: "main" }).availability.status).toBe("model-unavailable");
  });
});

describe("[PiDock 11] model switch", () => {
  it("switches model, follows the target window and logs the switch event", () => {
    const { host: taskHost } = host();
    withCatalog(taskHost);
    taskHost.sendMessage("main", "先跑一轮", {
      usageSource: "actual",
      usage: { input: 120, output: 30 },
    });
    const before = taskHost.sessionContext({ sessionId: "main" });
    expect(before.tokens).toBe(150);

    const result = taskHost.setSessionModel({ sessionId: "main", providerId: "provider-local", model: "本地 Qwen" });
    expect(result.context).toMatchObject({ providerId: "provider-local", model: "本地 Qwen", window: 32 });
    expect(result.switchEvent).toMatchObject({
      from: { providerId: "provider-anthropic", model: "claude-sonnet-4-5" },
      to: { providerId: "provider-local", model: "本地 Qwen" },
      reason: "human-switch",
    });
    // Cumulative tokens survive the switch; history keeps its own attribution.
    expect(result.context.tokens).toBe(150);
    const snapshot = taskHost.openSession("main").snapshot();
    expect(snapshot.calls[0]).toMatchObject({ providerId: "provider-anthropic", model: "claude-sonnet-4-5" });
    expect(snapshot.switches).toHaveLength(1);
  });

  it("refuses while a round/tool is running and keeps model, history and draft intact", () => {
    const { host: taskHost } = host();
    withCatalog(taskHost);
    const turn = taskHost.sendMessage("main", "运行命令", {
      tool: "exec.run",
      target: `${TASK_DIR}/run.sh`,
      execute: (call) => ({ tool: call.tool, kind: call.kind, target: call.target, contentVersion: call.contentVersion, output: "pending" }),
    });
    expect(turn.state).toBe("approval");
    taskHost.saveDraft("main", { text: "未发送草稿" });
    expect(() => taskHost.setSessionModel({ sessionId: "main", providerId: "provider-local", model: "本地 Qwen" })).toThrow(/busy-round/);
    const context = taskHost.sessionContext({ sessionId: "main" });
    expect(context.model).toBe("claude-sonnet-4-5");
    expect(taskHost.openSession("main").currentDraft?.text).toBe("未发送草稿");
  });

  it("refuses a disabled provider and a model that is not in the catalog", () => {
    const { host: taskHost } = host();
    withCatalog(taskHost, [{ ...ANTHROPIC, enabled: false }, LOCAL]);
    expect(() => taskHost.setSessionModel({ sessionId: "main", providerId: "provider-anthropic", model: "claude-haiku-4-5" })).toThrow(
      /provider-disabled/,
    );
    expect(() => taskHost.setSessionModel({ sessionId: "main", providerId: "provider-ghost", model: "x" })).toThrow(/model-unavailable/);
    expect(() => taskHost.setSessionModel({ sessionId: "main", providerId: "provider-anthropic", model: "not-configured" })).toThrow(/model-unavailable/);
  });

  it("applies strict context bounds: over-limit refuses, equal and smaller pass", () => {
    const { host: taskHost } = host();
    withCatalog(taskHost);
    taskHost.recordSessionContext({ sessionId: "main", used: 201, source: "actual" });
    expect(() => taskHost.setSessionModel({ sessionId: "main", providerId: "provider-anthropic", model: "claude-haiku-4-5" })).toThrow(
      /context-over-limit/,
    );
    // The refusal leaves occupancy, model and history untouched (no auto-compact/truncate).
    expect(taskHost.sessionContext({ sessionId: "main" })).toMatchObject({ model: "claude-sonnet-4-5", used: 201 });

    taskHost.recordSessionContext({ sessionId: "main", used: 200, source: "actual" });
    expect(taskHost.setSessionModel({ sessionId: "main", providerId: "provider-anthropic", model: "claude-haiku-4-5" }).context.model).toBe(
      "claude-haiku-4-5",
    );

    taskHost.recordSessionContext({ sessionId: "main", used: 199, source: "estimated" });
    expect(taskHost.setSessionModel({ sessionId: "main", providerId: "provider-anthropic", model: "claude-sonnet-4-5" }).context.window).toBe(200);
  });

  it("refuses to switch while the occupancy is pending and allows it after a fresh reading", () => {
    const { host: taskHost } = host();
    withCatalog(taskHost);
    taskHost.recordSessionContext({ sessionId: "main", used: 180, source: "actual" });
    const compacted = taskHost.compactSession({ sessionId: "main" });
    expect(compacted).toMatchObject({ used: 9.2, source: "pending" });
    expect(() => taskHost.setSessionModel({ sessionId: "main", providerId: "provider-local", model: "本地 Qwen" })).toThrow(
      /context-occupancy-unknown/,
    );
    taskHost.recordSessionContext({ sessionId: "main", used: 9.2, source: "estimated" });
    expect(taskHost.setSessionModel({ sessionId: "main", providerId: "provider-local", model: "本地 Qwen" }).context.window).toBe(32);
  });

  it("keeps cumulative tokens across compaction (compaction never zeroes consumption)", () => {
    const { host: taskHost } = host();
    withCatalog(taskHost);
    taskHost.sendMessage("main", "一轮", { usageSource: "actual", usage: { input: 100, output: 25 } });
    taskHost.recordSessionContext({ sessionId: "main", used: 120, source: "actual" });
    const context = taskHost.compactSession({ sessionId: "main" });
    expect(context.tokens).toBe(125);
    expect(context.source).toBe("pending");
  });
});

describe("[PiDock 11] session reasoning level", () => {
  it("sets a declared level and refuses an undeclared one", () => {
    const { host: taskHost } = host();
    withCatalog(taskHost);
    expect(taskHost.setSessionThinking({ sessionId: "main", level: "high" })).toMatchObject({ thinking: "high", thinkingCatalog: "declared" });
    expect(() => taskHost.setSessionThinking({ sessionId: "main", level: "max" })).toThrow(/thinking-level-not-declared/);
    expect(taskHost.sessionContext({ sessionId: "main" }).thinking).toBe("high");
  });

  it("refuses clearing a model that cannot turn reasoning off, and follows the catalog otherwise", () => {
    const { host: taskHost } = host();
    withCatalog(taskHost);
    taskHost.setSessionModel({ sessionId: "main", providerId: "provider-local", model: "本地 Qwen" });
    expect(() => taskHost.setSessionThinking({ sessionId: "main", level: "" })).toThrow(/thinking-required/);
    // Catalog unknown (model declares no tiers): an explicit level is accepted,
    // clearing is refused because "off" cannot be claimed.
    const unknownCatalog: ProviderProfileRow = { ...LOCAL, id: "provider-plain", models: [{ id: "plain-1", contextWindow: 64 }] };
    withCatalog(taskHost, [unknownCatalog, LOCAL]);
    taskHost.setSessionModel({ sessionId: "main", providerId: "provider-plain", model: "plain-1" });
    expect(taskHost.setSessionThinking({ sessionId: "main", level: "high" })).toMatchObject({ thinking: "high", thinkingCatalog: "catalog-unknown" });
    expect(() => taskHost.setSessionThinking({ sessionId: "main", level: "" })).toThrow(/thinking-catalog-unknown/);
  });

  it("drops a stale reasoning preference on switch instead of coercing it", () => {
    const { host: taskHost } = host();
    withCatalog(taskHost);
    taskHost.setSessionThinking({ sessionId: "main", level: "high" });
    const result = taskHost.setSessionModel({ sessionId: "main", providerId: "provider-local", model: "本地 Qwen" });
    expect(result.switchEvent.droppedThinking).toBe("high");
    expect(result.context).toMatchObject({ thinking: "low", thinkingCatalog: "declared" });
    expect(result.context.thinking).toBe("low");
  });

  it("persists identity, context, reasoning level and switch log across a restart", () => {
    const store = memoryTaskStore();
    const first = new TaskWorkspaceHost("task-a", TASK_DIR, store, () => "2026-09-22T10:00:00+08:00");
    first.setProviderCatalog([ANTHROPIC, LOCAL]);
    first.setSessionThinking({ sessionId: "main", level: "high" });
    first.recordSessionContext({ sessionId: "main", used: 12, source: "estimated" });
    first.setSessionModel({ sessionId: "main", providerId: "provider-local", model: "本地 Qwen" });

    const restarted = new TaskWorkspaceHost("task-a", TASK_DIR, store, () => "2026-09-23T10:00:00+08:00");
    restarted.setProviderCatalog([ANTHROPIC, LOCAL]);
    expect(restarted.sessionContext({ sessionId: "main" })).toMatchObject({
      providerId: "provider-local",
      model: "本地 Qwen",
      window: 32,
      used: 12,
      source: "estimated",
      thinking: "low",
    });
    expect(restarted.openSession("main").modelSwitchEvents).toHaveLength(1);
  });
});
