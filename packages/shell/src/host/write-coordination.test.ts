import { describe, expect, it } from "vitest";
import {
  emptyWriteLock,
  claimDerivedExecution,
  claimWrite,
  endDerivedExecution,
  forgetSession,
  orphanResourcesFor,
  orphanResourcesForView,
  releaseWrite,
  TaskWriteCoordinator,
  writeClaimError,
  writeLockOwner,
  writeLockView,
  type AgentOwnedResource,
  type WriteLockSnapshot,
} from "./write-coordination.js";

// Seam: [PiDock 09] (#11) task write coordination. The rules decide who may
// write, who queues, who never gets the right, and when the right outlives a
// turn; the Host dispatch, the service/browser sequences and the renderer
// mirror all read this one implementation.

const SERVICE: AgentOwnedResource = { resourceId: "saas-web", kind: "service", ownerSessionId: "impl", label: "saas-web" };

function claim(snapshot: WriteLockSnapshot, sessionId: string, label = `${sessionId} 的写操作`) {
  return claimWrite(snapshot, { sessionId, permission: "default", intent: { kind: "turn", label } });
}

describe("task write coordination", () => {
  it("gives the right to one session, queues a second, and clears the queue on release", () => {
    const first = claim(emptyWriteLock(), "impl");
    expect(first.result.ok).toBe(true);
    expect(writeLockOwner(first.snapshot)).toBe("impl");

    const queued = claim(first.snapshot, "review");
    expect(queued.result).toMatchObject({ ok: false, verdict: "locked", owner: "impl", queuePosition: 1 });
    expect(writeLockOwner(queued.snapshot)).toBe("impl");
    // The refusal names the holder so the UI can offer the abort entry.
    expect(writeClaimError(queued.result as never)).toContain("task-locked: 同一任务写操作权由会话 impl 持有");

    // The same session may claim again (nested tool) without deadlocking.
    const nested = claim(queued.snapshot, "impl", "嵌套工具");
    expect(nested.result.ok).toBe(true);

    // Releasing the nested claim keeps the right (another claim is in flight).
    const kept = releaseWrite(nested.snapshot, (nested.result as { claimId: string }).claimId);
    expect(kept.releasedOwner).toBeNull();
    expect(kept.retained).toEqual({ sessionId: "impl", reason: "in-flight-claim" });
    expect(writeLockOwner(kept.snapshot)).toBe("impl");

    const released = releaseWrite(kept.snapshot, (first.result as { claimId: string }).claimId);
    expect(released.releasedOwner).toBe("impl");
    expect(writeLockOwner(released.snapshot)).toBeNull();
    // The queued session's slot is cleared with the owner's right.
    expect(released.snapshot.waiting).toEqual([]);
  });

  it("never gives a read-only session the write right", () => {
    const refused = claimWrite(emptyWriteLock(), {
      sessionId: "audit",
      permission: "read",
      intent: { kind: "browser-action", label: "页面变更" },
    });
    expect(refused.result).toMatchObject({ ok: false, verdict: "readonly" });
    expect(refused.snapshot.claims).toEqual([]);
    expect(writeLockOwner(refused.snapshot)).toBeNull();
  });

  it("keeps the right while a derived execution outlives the turn", () => {
    const turn = claim(emptyWriteLock(), "impl");
    const claimId = (turn.result as { claimId: string }).claimId;
    expect(claimDerivedExecution(turn.snapshot, { resourceId: "child-1", sessionId: "impl", label: "构建子进程" }).ok).toBe(true);
    const derived = claimDerivedExecution(turn.snapshot, { resourceId: "child-1", sessionId: "impl", label: "构建子进程" }).snapshot;

    // The turn settled (its claim ends) but the child still runs.
    const settled = releaseWrite(derived, claimId);
    expect(settled.retained).toEqual({ sessionId: "impl", reason: "derived-execution" });
    expect(writeLockOwner(settled.snapshot)).toBe("impl");
    // A second session still cannot write while the child process runs.
    expect(claim(settled.snapshot, "review").result.ok).toBe(false);

    const ended = endDerivedExecution(settled.snapshot, "child-1");
    expect(ended.releasedOwner).toBe("impl");
    expect(writeLockOwner(ended.snapshot)).toBeNull();
    expect(claim(ended.snapshot, "review").result.ok).toBe(true);
  });

  it("refuses a new session while another session's leftover resource is unverified", () => {
    const resources = [SERVICE];
    const blocked = claimWrite(emptyWriteLock(), {
      sessionId: "review",
      permission: "auto",
      intent: { kind: "turn", label: "检查服务" },
      orphans: orphanResourcesFor({ resources, requester: "review", snapshot: emptyWriteLock() }),
    });
    expect(blocked.result).toMatchObject({ ok: false, verdict: "locked", owner: "impl" });
    expect((blocked.result as { orphans?: AgentOwnedResource[] }).orphans).toHaveLength(1);
    expect(writeClaimError(blocked.result as never)).toContain("遗留执行资源仍在运行（saas-web）");

    // The owner session itself continues its own work (not an orphan), and a
    // human-started resource has no session to coordinate with.
    expect(claimWrite(emptyWriteLock(), { sessionId: "impl", permission: "auto", intent: { kind: "turn", label: "继续" }, orphans: orphanResourcesFor({ resources, requester: "impl", snapshot: emptyWriteLock() }) }).result.ok).toBe(true);
    const humanOwned: AgentOwnedResource = { resourceId: "web", kind: "service", ownerSessionId: null };
    expect(orphanResourcesFor({ resources: [humanOwned], requester: "review", snapshot: emptyWriteLock() })).toEqual([]);
    // A resource whose owner still holds a live claim is covered by that claim.
    const held = claim(emptyWriteLock(), "impl");
    expect(orphanResourcesFor({ resources, requester: "review", snapshot: held.snapshot })).toEqual([]);
    expect(orphanResourcesForView(resources, held.snapshot)).toEqual([]);
    expect(orphanResourcesForView(resources, emptyWriteLock())).toHaveLength(1);
  });

  it("drops claims, derived entries and the queue slot on cancel/stop", () => {
    const first = claim(emptyWriteLock(), "impl");
    const queued = claim(first.snapshot, "review");
    const cancelled = forgetSession(queued.snapshot, "impl");
    expect(cancelled.releasedOwner).toBe("impl");
    expect(cancelled.snapshot.claims).toEqual([]);
    expect(cancelled.snapshot.waiting).toEqual([]);
  });

  it("shows holder, queue positions and read-only sessions in a stable view", () => {
    const first = claim(emptyWriteLock(), "impl", "回合工具 exec.run");
    const queued = claim(first.snapshot, "review");
    const view = writeLockView({
      snapshot: queued.snapshot,
      sessions: [
        { sessionId: "review", permission: "default", runState: "idle" },
        { sessionId: "impl", permission: "default", runState: "running" },
        { sessionId: "audit", permission: "read", runState: "idle" },
      ],
      orphans: [SERVICE],
    });
    expect(view.owner).toBe("impl");
    expect(view.waiting).toEqual(["review"]);
    expect(view.readonly).toEqual(["audit"]);
    expect(view.orphans).toEqual([SERVICE]);
    expect(view.sessions.map((session) => session.sessionId)).toEqual(["audit", "impl", "review"]);
    expect(view.sessions.find((session) => session.sessionId === "impl")).toMatchObject({ role: "owner", label: "回合工具 exec.run" });
    expect(view.sessions.find((session) => session.sessionId === "review")).toMatchObject({ role: "waiting", queuePosition: 1 });
    expect(view.sessions.find((session) => session.sessionId === "audit")).toMatchObject({ role: "readonly" });
  });

  it("bounds the queue and rejects a duplicate queue entry for one session", () => {
    let snapshot = claim(emptyWriteLock(), "impl").snapshot;
    for (let index = 0; index < 12; index += 1) snapshot = claim(snapshot, `s${index}`).snapshot;
    expect(snapshot.waiting.length).toBeLessThanOrEqual(8);
    const again = claim(snapshot, "s0");
    expect(again.snapshot.waiting.filter((entry) => entry.sessionId === "s0")).toHaveLength(1);
  });

  it("keeps the coordinator's probe-driven state in sync with the returned results", () => {
    const resources: AgentOwnedResource[] = [SERVICE];
    const coordinator = new TaskWriteCoordinator(() => resources);
    expect(coordinator.claimWrite("review", "auto", { kind: "turn", label: "写入" })).toMatchObject({ ok: false, verdict: "locked" });
    // The owning session may proceed; once the leftover is stopped a new
    // session gets the right (the probe is re-read on every claim).
    expect(coordinator.claimWrite("impl", "auto", { kind: "service-control", label: "停止 saas-web" }).ok).toBe(true);
    expect(coordinator.owner).toBe("impl");
    coordinator.forgetSession("impl");
    resources.length = 0;
    expect(coordinator.claimWrite("review", "auto", { kind: "turn", label: "写入" }).ok).toBe(true);
    expect(coordinator.view({ sessions: [{ sessionId: "review", permission: "auto", runState: "running" }] }).owner).toBe("review");
  });

  // Box 6: the coordination is task-scoped. Two tasks (two coordinators) keep
  // writing in parallel — no project- or app-level single-session lock.
  it("lets two tasks write in parallel", () => {
    const taskA = new TaskWriteCoordinator();
    const taskB = new TaskWriteCoordinator();
    expect(taskA.claimWrite("impl", "auto", { kind: "turn", label: "A 写入" }).ok).toBe(true);
    expect(taskB.claimWrite("impl", "auto", { kind: "turn", label: "B 写入" }).ok).toBe(true);
    expect(taskA.owner).toBe("impl");
    expect(taskB.owner).toBe("impl");
  });
});
