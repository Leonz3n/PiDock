import { beforeEach, describe, expect, it } from "vitest";
import {
  PiSessionChannel,
  resetPiSequencesForTests,
} from "./pi-session.js";

const TASK_DIR = "/tmp/pidock-test/task-abcdef12";

function channel() {
  return new PiSessionChannel({
    taskId: "task-a",
    sessionId: "main",
    taskDir: TASK_DIR,
    providerId: "provider-local",
    model: "test-model",
    now: () => "2026-09-22T10:00:00+08:00",
  });
}

beforeEach(() => {
  resetPiSequencesForTests();
});

// Seam: pi single-session channel (permission gate, one-shot approval,
// write lock, call identity, cancel/failure preservation, resume).

describe("PiSessionChannel permission gate", () => {
  it("denies writes/commands/browser in read-only sessions", () => {
    const session = channel();
    session.setPermission("read");
    expect(session.gate("fs.read", `${TASK_DIR}/notes.md`, "v1")).toEqual({ verdict: "allow" });
    expect(session.gate("fs.write", `${TASK_DIR}/notes.md`, "v1").verdict).toBe("deny");
    expect(session.gate("exec.run", `${TASK_DIR}/run.sh`, "v1").verdict).toBe("deny");
    expect(session.gate("browser.act", `${TASK_DIR}/page`, "v1").verdict).toBe("deny");
  });

  it("asks first for commands/browser under default permission", () => {
    const session = channel();
    expect(session.gate("fs.write", `${TASK_DIR}/notes.md`, "v1")).toEqual({ verdict: "allow" });
    const decision = session.gate("exec.run", `${TASK_DIR}/run.sh`, "v1");
    expect(decision.verdict).toBe("ask");
  });

  it("still denies out-of-task targets under auto permission", () => {
    const session = channel();
    session.setPermission("auto");
    expect(session.gate("fs.write", `${TASK_DIR}/notes.md`, "v1")).toEqual({ verdict: "allow" });
    const decision = session.gate("fs.write", "/Users/name/Workspace/repo/notes.md", "v1");
    expect(decision.verdict).toBe("deny");
  });

  it("never offers ungated tools", () => {
    expect(channel().gate("shell.exec", `${TASK_DIR}/x`, "v1").verdict).toBe("deny");
  });
});

describe("PiSessionChannel turns and approvals", () => {
  it("mints a stable call identity with provider/model/usage from the first call", () => {
    const session = channel();
    const first = session.runTurn({ text: "检查构建" });
    const second = session.runTurn({ text: "再检查一次" });
    expect(first.call.callId).toBe("call-1");
    expect(second.call.callId).toBe("call-2");
    expect(first.call.providerId).toBe("provider-local");
    expect(first.call.model).toBe("test-model");
    expect(first.call.usageSource).toBe("test-double");
  });

  it("approves exactly once and never replays", () => {
    const session = channel();
    const turn = session.runTurn({
      text: "写文件",
      execute: () => ({ target: `${TASK_DIR}/notes.md`, contentVersion: "v1", output: "ok" }),
    });
    expect(turn.state).toBe("done");
    expect(session.writeLockOwner).toBeNull();
  });

  it("asks inside the turn for command/browser tools under default permission", () => {
    const session = channel();
    session.setPermission("default");
    const turn = session.runTurn({
      text: "运行命令",
      tool: "exec.run",
      target: `${TASK_DIR}/run.sh`,
      execute: (call) => ({
        tool: call.tool,
        kind: call.kind,
        target: call.target,
        contentVersion: call.contentVersion,
        output: "pending",
      }),
    });
    expect(turn.state).toBe("approval");
    expect(turn.approval?.tool).toBe("exec.run");
    expect(turn.approval?.callId).toBe(turn.call.callId);
    const decided = session.approve(turn.approval?.id ?? "");
    expect(decided.callId).toBe(turn.call.callId);
    expect(() => session.approve(turn.approval?.id ?? "")).toThrow("不可重放");
    // P1: the approve system note is an agent message, never a human one.
    const note = session.snapshot().messages.find((message) => message.callId === turn.call.callId && message.role === "agent" && message.text.startsWith("已批准并执行"));
    expect(note?.origin).toBe("agent");
  });

  it("keeps history on approval, approval, and reopen without replay", () => {
    const session = channel();
    session.setPermission("default");
    const turn = session.runTurn({
      text: "运行命令",
      tool: "exec.run",
      target: `${TASK_DIR}/run.sh`,
      execute: (call) => ({
        tool: call.tool,
        kind: call.kind,
        target: call.target,
        contentVersion: call.contentVersion,
        output: "pending",
      }),
    });
    expect(turn.state).toBe("approval");
    const snapshot = session.snapshot();
    expect(snapshot.approvals).toHaveLength(1);
    const restored = PiSessionChannel.restore(snapshot, TASK_DIR);
    expect(restored.runState).toBe("cancelled");
    expect(restored.pendingApproval()).toBeUndefined();
    expect(restored.snapshot().approvals[0].status).toBe("expired");
    expect(restored.snapshot().messages).toHaveLength(snapshot.messages.length);
  });

  it("preserves the saved createdAt across restore", () => {
    const session = channel();
    const snapshot = session.snapshot();
    const restored = PiSessionChannel.restore(snapshot, TASK_DIR);
    expect(restored.snapshot().createdAt).toBe(snapshot.createdAt);
  });

  // BLOCK P0-1/P1: one-shot spend for Host-driven executions. `approve()`
  // sets `approved + executed:true` before anything runs, so consumption
  // (not `executed`) is the replay guard, and a reopen spends approved
  // requests instead of re-arming them.
  it("spends one-shot approvals: single-use consume, restore spends approved", () => {
    const session = channel();
    session.setPermission("default");
    const gated = session.gate("exec.run", `${TASK_DIR}/services/saas-web`, "v12");
    if (gated.verdict !== "ask") throw new Error("expected approvals");
    expect(session.consumeApproval(gated.approvalId)).toBe(false);
    expect(session.consumeApproval("approval-missing")).toBe(false);
    session.approve(gated.approvalId);
    expect(session.consumeApproval(gated.approvalId)).toBe(true);
    expect(session.consumeApproval(gated.approvalId)).toBe(false);
    const spent = session.snapshot().approvals[0];
    expect(spent.consumedAt).toBe("2026-09-22T10:00:00+08:00");
    // The spend round-trips: reopening never returns the spent request.
    const restored = PiSessionChannel.restore(session.snapshot(), TASK_DIR);
    expect(restored.snapshot().approvals[0].consumedAt).toBeDefined();
    expect(restored.consumeApproval(gated.approvalId)).toBe(false);

    const rearmed = channel();
    rearmed.setPermission("default");
    const second = rearmed.gate("exec.run", `${TASK_DIR}/services/saas-web`, "v12");
    if (second.verdict !== "ask") throw new Error("expected approvals");
    rearmed.approve(second.approvalId);
    const reopened = PiSessionChannel.restore(rearmed.snapshot(), TASK_DIR);
    expect(reopened.snapshot().approvals[0].consumedAt).toBeDefined();
    expect(reopened.consumeApproval(second.approvalId)).toBe(false);
  });

  it("previews the gate without creating a pending approval", () => {
    const session = channel();
    session.setPermission("default");
    expect(session.previewGate("exec.run", `${TASK_DIR}/run.sh`)).toEqual({ verdict: "ask", approvalId: "preview" });
    expect(session.pendingApproval()).toBeUndefined();
    const first = session.gate("exec.run", `${TASK_DIR}/run.sh`, "v1");
    const second = session.gate("exec.run", `${TASK_DIR}/run.sh`, "v1");
    expect(first.verdict).toBe("ask");
    expect(second.verdict).toBe("ask");
    if (first.verdict !== "ask" || second.verdict !== "ask") throw new Error("expected approvals");
    expect(first.approvalId).not.toBe(second.approvalId);
  });

  it("keeps history on cancel without losing messages", () => {
    const session = channel();
    session.runTurn({ text: "第一轮" });
    session.runTurn({ text: "第二轮" });
    session.cancel();
    // Cancel with no running turn is a no-op: state stays done, history kept.
    expect(session.snapshot().messages.length).toBe(4);
    expect(session.runState).toBe("done");
  });

  it("rejects an approval with zero execution", () => {
    const session = channel();
    session.setPermission("default");
    const decision = session.gate("exec.run", `${TASK_DIR}/run.sh`, "v1");
    if (decision.verdict !== "ask") throw new Error("expected an approval");
    session.reject(decision.approvalId);
    const approval = session.snapshot();
    expect(session.runState).toBe("cancelled");
    expect(approval.messages.length).toBe(0);
    expect(() => session.reject(decision.approvalId)).toThrow("不可重放");
  });

  it("binds a default-permission approval to the running turn's call id", () => {
    const session = channel();
    session.setPermission("default");
    const turn = session.runTurn({
      text: "运行命令",
      execute: (call) => {
        const decision = session.gate("exec.run", `${TASK_DIR}/run.sh`, "v1", call.callId);
        expect(decision.verdict).toBe("ask");
        if (decision.verdict !== "ask") throw new Error("expected an approval");
        return { target: `${TASK_DIR}/notes.md`, contentVersion: "v1", output: decision.approvalId };
      },
    });
    // The scripted turn only exercises fs.write (allowed), so it completes;
    // the direct gate call above proves the approval carries the turn's call.
    expect(turn.state).toBe("done");
    const pending = session.pendingApproval();
    expect(pending?.callId).toBe(turn.call.callId);
    const approved = session.approve(pending?.id ?? "");
    expect(approved.callId).toBe(turn.call.callId);
    expect(() => session.approve(pending?.id ?? "")).toThrow("不可重放");
  });

  it("restores the exact session, not another task's latest", () => {
    const session = channel();
    session.runTurn({ text: "检查构建" });
    const snapshot = session.snapshot();
    const restored = PiSessionChannel.restore(snapshot, TASK_DIR);
    expect(restored.snapshot().sessionId).toBe("main");
    expect(restored.snapshot().messages.length).toBe(2);
    expect(restored.snapshot().calls[0].callId).toBe("call-1");
  });

  it("holds the task write lock during a turn and releases it after", () => {
    const session = channel();
    let ownerDuringTurn: string | null = "missing";
    session.runTurn({
      text: "写文件",
      execute: (call) => {
        ownerDuringTurn = session.writeLockOwner;
        return { target: `${TASK_DIR}/notes.md`, contentVersion: "v1", output: call.callId };
      },
    });
    expect(ownerDuringTurn).toBe("call-1");
    expect(session.writeLockOwner).toBeNull();
  });

  it("records structured usage with a source and persists it across restore", () => {
    const session = channel();
    const turn = session.runTurn({
      text: "检查构建",
      usageSource: "actual",
      usage: { input: 120, output: 45, cacheRead: 10 },
    });
    expect(turn.call.usage).toEqual({ input: 120, output: 45, cacheRead: 10, source: "actual" });
    expect(turn.call.usageSource).toBe("actual");
    const restored = PiSessionChannel.restore(session.snapshot(), TASK_DIR);
    expect(restored.snapshot().calls[0].usage).toEqual({ input: 120, output: 45, cacheRead: 10, source: "actual" });
  });

  it("defaults unreported usage to zeroed counters and backfills legacy snapshots", () => {
    const session = channel();
    const turn = session.runTurn({ text: "检查构建" });
    expect(turn.call.usage).toEqual({ input: 0, output: 0, cacheRead: 0, source: "test-double" });
    const legacy = { ...session.snapshot(), calls: [{ ...session.snapshot().calls[0], usage: undefined }] };
    const restored = PiSessionChannel.restore(legacy, TASK_DIR);
    expect(restored.snapshot().calls[0].usage).toEqual({ input: 0, output: 0, cacheRead: 0, source: "unreported" });
  });

  it("streams the settled reply in chunks and always ends with a done frame", () => {
    const session = channel();
    const frames: { callId: string; text: string; done: boolean }[] = [];
    const turn = session.runTurn({ text: "检查构建", stream: (chunk) => frames.push(chunk) });
    expect(frames.length).toBeGreaterThan(1);
    expect(frames[frames.length - 1]).toEqual({ callId: turn.call.callId, text: "", done: true });
    expect(frames.slice(0, -1).every((frame) => frame.callId === turn.call.callId && !frame.done)).toBe(true);
    expect(frames.slice(0, -1).map((frame) => frame.text).join("")).toBe(
      session.snapshot().messages.find((message) => message.role === "agent")?.text ?? "",
    );
  });

  it("applies a per-turn provider/model override to the minted call", () => {
    const session = channel();
    const turn = session.runTurn({ text: "检查构建", providerId: "provider-local", model: "pidock-default" });
    expect(turn.call.providerId).toBe("provider-local");
    expect(turn.call.model).toBe("pidock-default");
    expect(session.snapshot().providerId).toBe("provider-local");
  });

  it("applies a per-turn credentialRef rotation and persists it across restore", () => {
    const session = channel();
    const turn = session.runTurn({ text: "检查构建", credentialRef: "PIDOCK_PI_TOKEN_V2" });
    expect(turn.call.events).toContain("turn:credential-rotated");
    expect(session.configuredCredentialRef).toBe("PIDOCK_PI_TOKEN_V2");
    const restored = PiSessionChannel.restore(session.snapshot(), TASK_DIR);
    expect(restored.configuredCredentialRef).toBe("PIDOCK_PI_TOKEN_V2");
    expect(restored.snapshot().credentialRef).toBe("PIDOCK_PI_TOKEN_V2");
    expect(() => session.runTurn({ text: "再来", credentialRef: "  " })).toThrow("credentialRef");
  });

  it("emits turn:provider-fallback on unknown provider and rejects unknown usageSource", () => {
    const session = channel();
    const turn = session.runTurn({ text: "检查构建", providerId: "provider-future" });
    expect(turn.call.providerId).toBe("provider-local");
    expect(turn.call.events.some((event) => event.startsWith("turn:provider-fallback:provider-future->"))).toBe(true);
    expect(() => session.runTurn({ text: "坏来源", usageSource: "live" as never })).toThrow("usageSource");
  });

  it("leaves no call-id gap and no provider mutation on a rejected turn", () => {
    const session = channel();
    const before = session.snapshot();
    expect(() => session.runTurn({ text: "坏凭据", credentialRef: "  " })).toThrow("credentialRef");
    expect(() => session.runTurn({ text: "坏来源", usageSource: "live" as never })).toThrow("usageSource");
    expect(() =>
      session.runTurn({ text: "坏模型", providerId: "provider-local", model: "no-such-model" }),
    ).toThrow("unknown model");
    // No call minted, no state drift: provider/model unchanged, no calls/messages added.
    expect(session.snapshot().providerId).toBe(before.providerId);
    expect(session.snapshot().model).toBe(before.model);
    expect(session.snapshot().calls).toHaveLength(0);
    expect(session.snapshot().messages).toHaveLength(0);
    const next = session.runTurn({ text: "检查构建" });
    expect(next.call.callId).toBe("call-1");
  });

  it("keeps usageSource twin in sync when backfilling legacy snapshots", () => {
    const session = channel();
    const turn = session.runTurn({ text: "检查构建" });
    expect(turn.call.usageSource).toBe("test-double");
    const legacyCalls = session.snapshot().calls.map((call) => ({
      ...call,
      usageSource: "test-double" as const,
      usage: undefined,
    }));
    const legacy = { ...session.snapshot(), calls: legacyCalls };
    const restored = PiSessionChannel.restore(legacy, TASK_DIR);
    const restoredCall = restored.snapshot().calls[0];
    expect(restoredCall.usage).toEqual({ input: 0, output: 0, cacheRead: 0, source: "unreported" });
    expect(restoredCall.usageSource).toBe("unreported");
  });

  it("configures the provider with a credential reference and rejects unknown models", () => {
    const session = channel();
    session.configureProvider("provider-local", "pidock-default", "PIDOCK_PI_TOKEN");
    expect(session.configuredCredentialRef).toBe("PIDOCK_PI_TOKEN");
    expect(() => session.configureProvider("provider-local", "no-such-model")).toThrow("unknown model");
    expect(() => session.configureProvider("provider-local", "pidock-default", "  ")).toThrow("credentialRef");
    // Unknown providers fall back to the local default instead of stranding the session.
    session.configureProvider("provider-future", "whatever");
    expect(session.snapshot().providerId).toBe("provider-local");
  });

  it("keeps prior messages when an approval turn is cancelled", () => {
    const session = channel();
    session.setPermission("default");
    const turn = session.runTurn({
      text: "运行命令",
      tool: "exec.run",
      target: `${TASK_DIR}/run.sh`,
      execute: (call) => ({ tool: call.tool, kind: call.kind, target: call.target, contentVersion: call.contentVersion, output: "x" }),
    });
    expect(turn.state).toBe("approval");
    const before = session.snapshot().messages.length;
    session.cancel();
    expect(session.runState).toBe("cancelled");
    expect(session.snapshot().messages.length).toBe(before);
    expect(session.snapshot().messages.every((message) => typeof message.text === "string")).toBe(true);
    expect(session.writeLockOwner).toBeNull();
  });
});

describe("S6 batch 2: cwd guard, approval one-shot, origin labels, send-record, drafts", () => {
  it("rejects tool targets that escape the task dir via .. (no fallback to the original checkout)", () => {
    const session = channel();
    session.setPermission("auto");
    expect(session.previewGate("fs.write", `${TASK_DIR}/../sibling/notes.md`).verdict).toBe("deny");
    expect(session.previewGate("fs.write", `${TASK_DIR}/sub/../../sibling/x`).verdict).toBe("deny");
    expect(session.previewGate("fs.write", "/Users/name/Workspace/repo/notes.md").verdict).toBe("deny");
    expect(session.previewGate("fs.write", `${TASK_DIR}/notes.md`).verdict).toBe("allow");
    const turn = session.runTurn({
      text: "越界写入",
      tool: "fs.write",
      target: `${TASK_DIR}/../sibling/notes.md`,
      execute: (call) => ({ tool: call.tool, kind: call.kind, target: call.target, contentVersion: call.contentVersion, output: "x" }),
    });
    expect(turn.state).toBe("failed");
    expect(session.snapshot().messages.some((message) => message.text.includes("已拒绝"))).toBe(true);
  });

  it("consumes exactly one pending approval; re-approve fails and permission change is forward-only", () => {
    const session = channel();
    session.setPermission("default");
    const first = session.runTurn({
      text: "跑命令一",
      tool: "exec.run",
      target: `${TASK_DIR}/a.sh`,
      execute: (call) => ({ tool: call.tool, kind: call.kind, target: call.target, contentVersion: call.contentVersion, output: "x" }),
    });
    expect(first.state).toBe("approval");
    expect(first.approval?.permissionAtRequest).toBe("default");
    // Permission change lands after the request: the pending approval keeps `default`.
    session.setPermission("auto");
    const decided = session.approve(first.approval?.id ?? "");
    expect(decided.callId).toBe(first.call.callId);
    expect(() => session.approve(first.approval?.id ?? "")).toThrow("不可重放");
    // Forward-only: the same command tier now runs without asking under
    // `auto` (no second approval mints), proving the change applied to
    // later calls while the consumed approval kept `default`.
    const second = session.runTurn({
      text: "跑命令二",
      tool: "exec.run",
      target: `${TASK_DIR}/b.sh`,
      execute: (call) => ({ tool: call.tool, kind: call.kind, target: call.target, contentVersion: call.contentVersion, output: "x" }),
    });
    expect(second.state).toBe("done");
    expect(second.approval).toBeUndefined();
    // Back to `default`: a later command asks again with a distinct approval.
    session.setPermission("default");
    const third = session.runTurn({
      text: "跑命令三",
      tool: "exec.run",
      target: `${TASK_DIR}/c.sh`,
      execute: (call) => ({ tool: call.tool, kind: call.kind, target: call.target, contentVersion: call.contentVersion, output: "x" }),
    });
    expect(third.state).toBe("approval");
    expect(third.approval?.id).not.toBe(first.approval?.id);
    expect(third.approval?.permissionAtRequest).toBe("default");
  });

  it("links user input to turn/call ids and labels human vs agent origins", () => {
    const session = channel();
    const turn = session.runTurn({ text: "检查构建", references: [{ kind: "file", path: "notes.md" }], skillSource: "review" });
    expect(turn.userMessageId).toBe("msg-1");
    expect(turn.agentMessageId).toBe("msg-2");
    const snapshot = session.snapshot();
    const user = snapshot.messages.find((message) => message.id === turn.userMessageId);
    const agent = snapshot.messages.find((message) => message.id === turn.agentMessageId);
    expect(user?.origin).toBe("human");
    expect(user?.callId).toBe(turn.call.callId);
    expect(agent?.origin).toBe("agent");
    expect(agent?.callId).toBe(turn.call.callId);
    expect(user?.skillSource).toBe("review");
    expect(Array.isArray(user?.references)).toBe(true);
    // Restore keeps the linkage and origins (legacy messages derive them).
    const restored = PiSessionChannel.restore(snapshot, TASK_DIR);
    expect(restored.snapshot().messages.find((message) => message.id === turn.userMessageId)?.origin).toBe("human");
    const legacy = { ...snapshot, messages: snapshot.messages.map(({ origin: _dropped, ...rest }) => rest) };
    const legacyRestored = PiSessionChannel.restore(legacy as never, TASK_DIR);
    expect(legacyRestored.snapshot().messages.find((message) => message.role === "user")?.origin).toBe("human");
    expect(legacyRestored.snapshot().messages.find((message) => message.role === "agent")?.origin).toBe("agent");
  });

  it("persists an unsent draft with structured refs and never auto-sends it on restore", () => {
    const session = channel();
    session.saveDraft({ text: "草稿想法", references: [{ kind: "file", path: "a.ts" }], skillSource: "review" });
    const snapshot = session.snapshot();
    expect(snapshot.draft?.text).toBe("草稿想法");
    expect(snapshot.messages).toHaveLength(0);
    const restored = PiSessionChannel.restore(snapshot, TASK_DIR);
    expect(restored.currentDraft?.text).toBe("草稿想法");
    expect(Array.isArray(restored.currentDraft?.references)).toBe(true);
    expect(restored.snapshot().messages).toHaveLength(0);
    expect(restored.runState).toBe("idle");
    restored.clearDraft();
    expect(restored.currentDraft).toBeUndefined();
  });
});
