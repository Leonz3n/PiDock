import { expect, it, vi } from "vitest";
import { TaskWorkspaceHost, memoryTaskStore } from "./task-host.js";
const DIR = "/test/legacy-seal";
function fixture() { const store = memoryTaskStore(); return { store, host: new TaskWorkspaceHost("task-a", DIR, store, () => "2026-01-01T00:00:00.000Z") }; }
it("seals retained and borrowed legacy turn/compaction ports before callbacks or call minting", () => {
  const { host } = fixture(), channel = host.openSession("main", { permission: "auto" });
  const turn = channel.runTurn.bind(channel), execute = vi.fn(), before = channel.snapshot(); host.sealExecution();
  expect(() => turn({ text: "late", execute })).toThrow("task-host-closing");
  expect(() => channel.compactContext()).toThrow("task-host-closing"); expect(execute).not.toHaveBeenCalled(); expect(channel.snapshot()).toEqual(before);
});
it("does not mint, approve or spend legacy authority after seal, while rejection remains available", () => {
  const { host } = fixture(), channel = host.openSession("main", { permission: "default" });
  const first = channel.gate("exec.run", `${DIR}/first`, "v1"), second = channel.gate("exec.run", `${DIR}/second`, "v1");
  if (first.verdict !== "ask" || second.verdict !== "ask") throw Error("fixture-approval-required");
  channel.approve(first.approvalId); const before = channel.snapshot(); host.sealExecution();
  expect(channel.previewGate("exec.run", `${DIR}/third`)).toEqual({ verdict: "deny", reason: "task-host-closing" });
  expect(channel.gate("exec.run", `${DIR}/third`, "v1")).toEqual({ verdict: "deny", reason: "task-host-closing" });
  expect(() => channel.approve(second.approvalId)).toThrow("task-host-closing"); expect(channel.consumeApproval(first.approvalId)).toBe(false);
  expect(channel.snapshot()).toEqual(before); channel.reject(second.approvalId); expect(channel.pendingApproval()).toBeUndefined();
});
it("keeps newly opened and restored channels sealed in the closing Host but permits a fresh Host", () => {
  const { host, store } = fixture(), channel = host.openSession("persisted"); store.writeSession(DIR, channel.snapshot());
  const closing = new TaskWorkspaceHost("task-a", DIR, store); closing.sealExecution();
  for (const id of ["persisted", "new"]) expect(() => closing.openSession(id).runTurn({ text: "late" })).toThrow("task-host-closing");
  const fresh = new TaskWorkspaceHost("task-a", DIR, store); expect(fresh.openSession("persisted").runTurn({ text: "fresh" }).state).toBe("done");
});
it("settles an already-admitted legacy callback and logs its result after a reentrant seal", () => {
  const { host } = fixture(), channel = host.openSession("main", { permission: "auto" }); const execute = vi.fn(() => { host.sealExecution(); return null; });
  expect(channel.runTurn({ text: "admitted", execute }).state).toBe("done"); expect(execute).toHaveBeenCalledTimes(1);
  expect(channel.snapshot().calls.at(-1)?.endState).toBe("completed"); expect(() => channel.runTurn({ text: "later", execute })).toThrow("task-host-closing");
});
