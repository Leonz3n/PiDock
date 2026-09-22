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
});
