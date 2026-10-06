import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TaskWorkspaceHost, memoryTaskStore } from "./task-host.js";
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pidock-direct-seal-")); homes.push(home); const dir = join(home, "task-a"); mkdirSync(dir);
  const store = memoryTaskStore(), host = new TaskWorkspaceHost("task-a", dir, store, () => "2026-01-01T00:00:00.000Z");
  host.openSession("main", { permission: "auto" }); return { host, dir, store };
}
it("refuses direct turn execution after seal without callback, session or ledger changes", () => {
  const f = fixture(), execute = vi.fn(); const before = f.host.openSession("main").snapshot();
  f.host.sealExecution(); f.host.sealExecution();
  expect(() => f.host.sendMessage("main", "late", { tool: "fs.write", target: `${f.dir}/source.txt`, execute })).toThrow("task-host-closing");
  expect(execute).not.toHaveBeenCalled(); expect(f.host.openSession("main").snapshot()).toEqual(before);
  expect(() => f.host.sendMessage("new", "late")).toThrow("task-host-closing"); expect(f.host.sessionIds()).toEqual(["main"]);
});
it("refuses new direct write and derived claims without changing existing ownership", () => {
  const f = fixture(), claim = f.host.claimWrite("main", "auto", { kind: "turn", label: "existing" }); expect(claim.ok).toBe(true);
  f.host.sealExecution();
  expect(() => f.host.claimWrite("other", "auto", { kind: "browser-action", label: "late" })).toThrow("task-host-closing");
  expect(() => f.host.claimDerivedExecution({ sessionId: "main", resourceId: "late-child", label: "late" })).toThrow("task-host-closing");
  expect(f.host.writeState().derived).toEqual([]); expect(f.host.writeLockOwner).toBe("main");
  if (claim.ok) f.host.releaseWrite(claim.claimId); expect(f.host.writeLockOwner).toBeNull();
});
it("refuses approval and scheduler admission after seal before changing records", () => {
  const f = fixture(); f.host.setPermission("main", "default");
  const turn = f.host.sendMessage("main", "planned", { tool: "exec.run", target: `${f.dir}/run.sh`, execute: (call) => ({ tool: call.tool, kind: call.kind, target: call.target, contentVersion: call.contentVersion, output: "fixture" }) });
  expect(turn.state).toBe("approval"); const approval = f.host.getApproval(turn.approvalId!);
  f.host.sealExecution();
  expect(() => f.host.approve("main", turn.approvalId!)).toThrow("task-host-closing");
  expect(f.host.getApproval(turn.approvalId!)).toEqual(approval);
  expect(() => f.host.runScheduleNow("missing")).toThrow("task-host-closing");
  expect(() => f.host.evaluateSchedules()).toThrow("task-host-closing");
  f.host.reject("main", turn.approvalId!); expect(f.host.writeLockOwner).toBeNull();
});
it("retains known derived registrations and ownership when disposal cannot confirm them", async () => {
  const f = fixture(); expect(f.host.claimDerivedExecution({ sessionId: "main", resourceId: "child-a", label: "known child" })).toBe(true);
  f.host.sealExecution();
  expect(() => f.host.assertExecutionSettled()).toThrow("task-derived-executions-unconfirmed");
  const closing = f.host.dispose(); await expect(closing).rejects.toThrow("task-derived-executions-unconfirmed");
  expect(f.host.dispose()).toBe(closing); expect(f.host.writeLockOwner).toBe("main"); expect(f.host.writeState().derived).toHaveLength(1);
  expect(() => f.host.cancel("main")).toThrow("task-derived-executions-unconfirmed"); expect(f.host.writeState().derived).toHaveLength(1);
  expect(() => f.host.sendMessage("main", "late")).toThrow("task-host-closing");
  f.host.endDerivedExecution("child-a"); expect(() => f.host.assertExecutionSettled()).not.toThrow();
  await expect(f.host.dispose()).rejects.toThrow("task-derived-executions-unconfirmed");
});
it("retains an unsettled direct write claim across SDK-successful disposal and refuses cancel erasure", async () => {
  const f = fixture(), claim = f.host.claimWrite("main", "auto", { kind: "browser-action", label: "held direct work" }); expect(claim.ok).toBe(true);
  const closing = f.host.dispose(); await expect(closing).rejects.toThrow("task-write-claims-unconfirmed");
  expect(() => f.host.assertExecutionSettled()).toThrow("task-write-claims-unconfirmed");
  expect(() => f.host.cancel("main")).toThrow("task-write-claims-unconfirmed"); expect(f.host.writeLockOwner).toBe("main");
  if (claim.ok) f.host.releaseWrite(claim.claimId);
  expect(() => f.host.assertExecutionSettled()).not.toThrow(); expect(f.host.dispose()).toBe(closing);
  await expect(f.host.dispose()).rejects.toThrow("task-write-claims-unconfirmed");
});
it("requires sealing for the derived snapshot and permits cleanup after prior trusted settlement", async () => {
  const f = fixture(); expect(() => f.host.assertExecutionSettled()).toThrow("task-host-not-sealed");
  f.host.claimDerivedExecution({ sessionId: "main", resourceId: "child-a", label: "registered" }); f.host.endDerivedExecution("child-a");
  const closing = f.host.dispose(); await closing; expect(f.host.dispose()).toBe(closing);
  expect(() => f.host.assertExecutionSettled()).not.toThrow(); expect(f.host.writeLockOwner).toBeNull();
  expect(() => f.host.sendMessage("main", "late")).toThrow("task-host-closing");
});
