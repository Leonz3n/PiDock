/**
 * Tests for the [PiDock 10] (#15) Host agent terminal-control sequence: the
 * gate order `host.ts` runs, driven without a utilityProcess.
 */
import { describe, expect, it } from "vitest";
import { PiSessionChannel } from "../main/pi-session.js";
import { TaskTerminalRegistry, planTerminal, type TerminalPlan } from "../main/terminal-config.js";
import { workspaceRoots } from "../main/workspace-files.js";
import { memoryTaskStore } from "./task-host.js";
import { runAgentTerminalControl, terminalApprovalTarget, verifyTerminalControlApproval } from "./terminal-control.js";
import { TaskWriteCoordinator } from "./write-coordination.js";

const DIR = "/Users/name/Tasks/task-a1f92c3d";
const ROOTS = workspaceRoots({ taskId: "task-a1f92c3d", taskDir: DIR, repos: ["invoice-service"], branch: "main" });

function planned(instanceId = "term-1"): TerminalPlan {
  const result = planTerminal({
    roots: ROOTS,
    taskId: "task-a1f92c3d",
    taskDir: DIR,
    rootId: "invoice-service",
    program: "bash",
    args: ["-l"],
    layers: { repoDefaults: [], shared: [], privateEntries: [], task: [] },
    owner: { taskId: "task-a1f92c3d", sessionId: "main", label: "会话 main" },
    instanceId,
  });
  if (!result.ok) throw new Error(result.error);
  return result.plan;
}

function setup(permission: "read" | "default" | "auto" = "default", action: "start" | "stop" = "start") {
  const store = memoryTaskStore();
  const registry = new TaskTerminalRegistry("task-a1f92c3d");
  const channel = new PiSessionChannel({
    taskId: "task-a1f92c3d",
    sessionId: "main",
    taskDir: DIR,
    providerId: "provider-local",
    model: "pidock-default",
    permission,
  });
  const write = new TaskWriteCoordinator();
  const persisted = () => store.sessions.get(`${DIR}::main`);
  const control = (input: { action?: "start" | "stop"; instanceId?: string; approvalId?: unknown } = {}) =>
    runAgentTerminalControl({
      registry,
      channel,
      taskDir: DIR,
      sessionId: "main",
      instanceId: input.instanceId ?? "term-1",
      action: input.action ?? action,
      ...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
      write,
      persist: () => store.writeSession(DIR, channel.snapshot()),
      act: () => {
        const existing = registry.get("term-1");
        if (existing && existing.lifecycle === "running") return registry.markExited("term-1", { exitReason: "stop" });
        registry.register(planned((input.instanceId as string) ?? "term-1"));
        return registry.markProcess("term-1", { processId: 9876 });
      },
    });
  return { registry, channel, write, control, persisted };
}

/** Pending approval id of the last mint (ids come from a process-global counter). */
function pendingId(channel: PiSessionChannel): string {
  const approvals = channel.snapshot().approvals;
  const last = approvals[approvals.length - 1];
  if (!last) throw new Error("no pending approval");
  return last.id;
}

describe("agent terminal-control dispatch", () => {
  it("mints one scope-bound approval for a default-tier start, then starts on approval and refuses the replay", () => {
    const { registry, channel, control, persisted } = setup("default");
    const first = control();
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error).toMatch(/^approval-required: approval-\d+$/);
    const approvalId = pendingId(channel);
    expect(first.error).toBe(`approval-required: ${approvalId}`);
    expect(registry.list()).toHaveLength(0);
    const minted = persisted()?.approvals.find((item) => item.id === approvalId);
    expect(minted).toMatchObject({
      tool: "exec.run",
      target: terminalApprovalTarget(DIR, "term-1"),
      permissionAtRequest: "default",
      scope: "terminal-control",
      status: "pending",
    });
    // A pending request authorizes nothing.
    expect(control({ approvalId }).ok).toBe(false);
    channel.approve(approvalId);
    const acted = control({ approvalId });
    expect(acted.ok).toBe(true);
    if (!acted.ok) return;
    expect(acted.payload).toMatchObject({ instanceId: "term-1", action: "start", actor: "agent", tier: "default" });
    expect(acted.payload.instance).toMatchObject({ processId: 9876, lifecycle: "running" });
    // The spend is written back: replaying the same id is denied and no
    // instance is registered again.
    expect(persisted()?.approvals.find((item) => item.id === approvalId)?.consumedAt).toBeDefined();
    expect(control({ approvalId }).ok).toBe(false);
  });

  it("never spends a turn approval for the same tool + target", () => {
    const { registry, channel, control } = setup("default");
    const turn = channel.gate("exec.run", terminalApprovalTarget(DIR, "term-1"), "v1");
    if (turn.verdict !== "ask") throw new Error("expected an approval request");
    expect(channel.snapshot().approvals[0].scope).toBeUndefined();
    channel.approve(turn.approvalId);
    const denied = control({ approvalId: turn.approvalId });
    expect(denied.ok).toBe(false);
    expect(denied).toMatchObject({ error: expect.stringContaining("用途未绑定") });
    expect(registry.list()).toHaveLength(0);
    expect(channel.snapshot().approvals[0].consumedAt).toBeUndefined();
  });

  it("refuses a verified approval bound to another terminal instance", () => {
    const { registry, control, channel } = setup("default");
    control();
    const approvalId = pendingId(channel);
    channel.approve(approvalId);
    const foreign = control({ instanceId: "term-2", approvalId });
    expect(foreign.ok).toBe(false);
    expect(foreign).toMatchObject({ error: expect.stringContaining("终端未绑定") });
    expect(registry.list()).toHaveLength(0);
  });

  it("denies a read-only session without minting anything", () => {
    const { channel, control, registry } = setup("read");
    const denied = control();
    expect(denied.ok).toBe(false);
    expect(denied).toMatchObject({ error: expect.stringContaining("read 权限不提供终端") });
    expect(channel.snapshot().approvals).toHaveLength(0);
    expect(registry.list()).toHaveLength(0);
  });

  it("allows the auto tier without an approval and releases the write right afterwards", () => {
    const { control, write, channel } = setup("auto");
    const result = control();
    expect(result.ok).toBe(true);
    expect(channel.snapshot().approvals).toHaveLength(0);
    expect(write.owner).toBeNull();
  });

  it("refuses agent terminal control while another session holds the write right", () => {
    const { control, write, registry } = setup("auto");
    const held = write.claimWrite("other", "auto", { kind: "turn", label: "回合工具 fs.write" });
    expect(held.ok).toBe(true);
    const denied = control();
    expect(denied).toMatchObject({ ok: false, error: expect.stringContaining("task-locked") });
    expect(registry.list()).toHaveLength(0);
    if (!held.ok) return;
    write.releaseWrite(held.claimId);
    expect(control().ok).toBe(true);
  });

  it("does not mint a default-tier confirmation while another session holds the write right", () => {
    const { control, write, channel, registry } = setup("default");
    write.claimWrite("other", "auto", { kind: "turn", label: "回合工具 fs.write" });
    const denied = control();
    expect(denied).toMatchObject({ ok: false, error: expect.stringContaining("task-locked") });
    expect(channel.snapshot().approvals).toHaveLength(0);
    expect(registry.list()).toHaveLength(0);
  });

  it("verifies the approval shape fail-closed on tier/scope/status", () => {
    const base = {
      status: "approved",
      tool: "exec.run",
      target: terminalApprovalTarget(DIR, "term-1"),
      permissionAtRequest: "default",
      scope: "terminal-control" as const,
    };
    expect(verifyTerminalControlApproval({ approval: base, taskDir: DIR, instanceId: "term-1" })).toEqual({ ok: true });
    expect(verifyTerminalControlApproval({ approval: undefined, taskDir: DIR, instanceId: "term-1" }).ok).toBe(false);
    expect(verifyTerminalControlApproval({ approval: { ...base, status: "pending" }, taskDir: DIR, instanceId: "term-1" }).ok).toBe(false);
    expect(verifyTerminalControlApproval({ approval: { ...base, consumedAt: "2026-09-22T00:00:00.000Z" }, taskDir: DIR, instanceId: "term-1" }).ok).toBe(false);
    expect(verifyTerminalControlApproval({ approval: { ...base, permissionAtRequest: "auto" }, taskDir: DIR, instanceId: "term-1" }).ok).toBe(false);
    expect(verifyTerminalControlApproval({ approval: { ...base, scope: "service-control" }, taskDir: DIR, instanceId: "term-1" }).ok).toBe(false);
    expect(verifyTerminalControlApproval({ approval: { ...base, tool: "fs.write" }, taskDir: DIR, instanceId: "term-1" }).ok).toBe(false);
    expect(verifyTerminalControlApproval({ approval: base, taskDir: DIR, instanceId: "term-2" }).ok).toBe(false);
  });
});
