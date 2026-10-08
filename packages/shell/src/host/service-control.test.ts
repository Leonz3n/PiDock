import { beforeEach, describe, expect, it } from "vitest";
import { PiSessionChannel, resetPiSequencesForTests } from "../main/pi-session.js";
import { memoryTaskStore } from "./task-host.js";
import { runAgentServiceControl, type ServiceExecutionDriver } from "./service-control.js";
import { TaskServiceRuntime } from "./service-runtime.js";
import { TaskWriteCoordinator } from "./write-coordination.js";

// Seam: #7 Host agent service-control dispatch (the sequence `host.ts`
// runs), driven here without a utilityProcess. Reviewer P2: the
// verify → spend → persist → act order had no coverage outside the pure
// verifier, so a stale-snapshot or missing-spend edit could regress it.

const DIR = "/Users/name/Tasks/task-a1f92c3d";
const SERVICE_ID = "saas-web";
beforeEach(() => { resetPiSequencesForTests(); });

function setup(permission: "read" | "default" | "auto" = "default") {
  const services = new TaskServiceRuntime(DIR);
  services.register({
    serviceId: SERVICE_ID,
    descriptor: { name: SERVICE_ID, program: "pnpm", args: ["--filter", SERVICE_ID, "dev"], ports: [5173], runType: "long-lived" },
    layers: {
      repoDefaults: [{ key: "API_BASE_URL", value: "https://default.example.com", secret: false }],
      shared: [],
      privateEntries: [],
      task: [{ key: "LOCAL_PORT", value: "5173", secret: false }],
    },
    templateVersion: "v12",
    launchSource: "catalog",
  });
  const store = memoryTaskStore();
  const channel = new PiSessionChannel({
    taskId: "task-a1f92c3d",
    sessionId: "main",
    taskDir: DIR,
    providerId: "provider-local",
    model: "pidock-default",
    permission,
  });
  const persisted = () => store.sessions.get(`${DIR}::main`);
  // [PiDock 09] (#11): the sequence claims the task write right; the tests
  // drive the real coordinator (with the service runtime as its leftover
  // probe, exactly like `host.ts` wires it) so the lock order is exercised.
  const write = new TaskWriteCoordinator(() =>
    services.runningAgentOwned().map((service) => ({
      resourceId: service.serviceId,
      kind: "service" as const,
      ownerSessionId: service.ownerSessionId,
      label: service.serviceId,
    })),
  );
  // The real driver is the Host's `TaskServiceProcesses`; here it records
  // the calls the sequence makes so every gate leg can assert that a refusal
  // reached no process action at all.
  const started: string[] = [], stopped: string[] = [];
  const driver: ServiceExecutionDriver = {
    start: async (serviceId) => { started.push(serviceId); return { pid: 4242 }; },
    stop: async (serviceId) => { stopped.push(serviceId); },
  };
  const control = (input: { action?: "start" | "stop"; serviceId?: string; approvalId?: unknown; driver?: ServiceExecutionDriver } = {}) =>
    runAgentServiceControl({
      services,
      channel,
      sessionId: "main",
      serviceId: input.serviceId ?? SERVICE_ID,
      action: input.action ?? "start",
      ...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
      driver: input.driver ?? driver,
      write,
      persist: () => store.writeSession(DIR, channel.snapshot()),
    });
  return { services, store, channel, control, persisted, write, driver, started, stopped };
}

describe("agent service-control dispatch", () => {
  it("refuses a sealed auto channel before claims or modeled service mutation", async () => {
    const f = setup("auto"), before = f.write.snapshot(); f.channel.sealExecution();
    await expect(f.control()).resolves.toEqual({ ok: false, error: "task-host-closing" }); expect(f.write.snapshot()).toEqual(before);
    expect(f.services.get(SERVICE_ID)?.lifecycle).toBe("stopped"); expect(f.persisted()).toBeUndefined();
    expect(f.started).toEqual([]); expect(f.stopped).toEqual([]);
  });
  it("does not act after approval persistence synchronously seals its channel", async () => {
    const f = setup(); await f.control(); const id = f.channel.pendingApproval()!.id; f.channel.approve(id);
    await expect(runAgentServiceControl({ services: f.services, channel: f.channel, sessionId: "main", serviceId: SERVICE_ID, action: "start", approvalId: id, driver: f.driver, write: f.write, persist: () => f.channel.sealExecution() })).resolves.toEqual({ ok: false, error: "task-host-closing" });
    expect(f.services.get(SERVICE_ID)?.lifecycle).toBe("stopped"); expect(f.write.owner).toBeNull();
    expect(f.started).toEqual([]);
  });
  it("mints one scope-bound approval for a default-tier start, then acts on approval and refuses the replay", async () => {
    const { services, channel, control, persisted, started } = setup("default");
    const first = await control();
    expect(first).toEqual({ ok: false, error: "approval-required: approval-1" });
    expect(services.get(SERVICE_ID)?.lifecycle).toBe("stopped");
    // The minted request is persisted with the binding the verifier needs.
    const minted = persisted()?.approvals.find((item) => item.id === "approval-1");
    expect(minted).toMatchObject({
      tool: "exec.run",
      target: `${DIR}/services/${SERVICE_ID}`,
      permissionAtRequest: "default",
      scope: "service-control",
      status: "pending",
    });
    // A pending request authorizes nothing.
    expect((await control({ approvalId: "approval-1" })).ok).toBe(false);
    expect(started).toEqual([]);
    channel.approve("approval-1");
    const acted = await control({ approvalId: "approval-1" });
    expect(acted).toEqual({ ok: true, payload: { serviceId: SERVICE_ID, action: "start", actor: "agent", tier: "default" } });
    expect(services.get(SERVICE_ID)?.lifecycle).toBe("running");
    expect(services.get(SERVICE_ID)?.events.join("\n")).toContain("start:agent:main:default");
    // The spend is written back: replaying the same id (even for stop) is
    // denied and the lifecycle is untouched.
    expect(persisted()?.approvals.find((item) => item.id === "approval-1")?.consumedAt).toBeDefined();
    const replay = await control({ action: "stop", approvalId: "approval-1" });
    expect(replay.ok).toBe(false);
    expect(services.get(SERVICE_ID)?.lifecycle).toBe("running");
  });

  it("never spends a turn approval minted for the same tool + target", async () => {
    const { services, channel, control, started } = setup("default");
    const turn = channel.gate("exec.run", `${DIR}/services/${SERVICE_ID}`, "v12");
    if (turn.verdict !== "ask") throw new Error("expected an approval request");
    expect(channel.snapshot().approvals[0].scope).toBeUndefined();
    channel.approve(turn.approvalId);
    const denied = await control({ approvalId: turn.approvalId });
    expect(denied.ok).toBe(false);
    expect(denied).toMatchObject({ error: expect.stringContaining("用途未绑定") });
    expect(services.get(SERVICE_ID)?.lifecycle).toBe("stopped");
    expect(started).toEqual([]);
    // No silent spend and no second mint: the turn's own request is intact.
    expect(channel.snapshot().approvals).toHaveLength(1);
    expect(channel.snapshot().approvals[0].consumedAt).toBeUndefined();
  });

  it("denies read-only sessions and never mints or starts a process", async () => {
    const { services, channel, control, started, stopped } = setup("read");
    const denied = await control();
    expect(denied.ok).toBe(false);
    expect(denied).toMatchObject({ error: expect.stringContaining("只读") });
    expect(channel.snapshot().approvals).toHaveLength(0);
    expect(services.get(SERVICE_ID)?.lifecycle).toBe("stopped");
    expect(started).toEqual([]); expect(stopped).toEqual([]);
  });

  it("allows auto tier without an approval", async () => {
    const { services, channel, control, started } = setup("auto");
    await expect(control()).resolves.toEqual({ ok: true, payload: { serviceId: SERVICE_ID, action: "start", actor: "agent", tier: "auto" } });
    expect(services.get(SERVICE_ID)?.lifecycle).toBe("running");
    expect(channel.snapshot().approvals).toHaveLength(0);
    expect(started).toEqual([SERVICE_ID]);
  });

  it("keeps the lifecycle unchanged and starts nothing when the real driver fails", async () => {
    const f = setup("auto");
    const failing: ServiceExecutionDriver = { start: async () => { throw new Error("spawn-failed: ENOENT"); }, stop: async () => {} };
    await expect(f.control({ driver: failing })).resolves.toEqual({ ok: false, error: "spawn-failed: ENOENT" });
    expect(f.services.get(SERVICE_ID)?.lifecycle).toBe("stopped");
    expect(f.services.runningAgentOwned()).toEqual([]);
    // A failed stop never reports a stopped service either.
    const stopping = setup("auto");
    await stopping.control();
    const stopFails: ServiceExecutionDriver = { start: async () => ({ pid: 1 }), stop: async () => { throw new Error("termination-unconfirmed: saas-web still owns open process output"); } };
    await expect(stopping.control({ action: "stop", driver: stopFails })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("termination-unconfirmed") });
    expect(stopping.services.get(SERVICE_ID)?.lifecycle).toBe("running");
  });

  it("fails closed without an execution driver and never flips a lifecycle", async () => {
    const f = setup("auto");
    // No driver: the sequence must refuse before any state change, because
    // registration alone never means a process exists.
    const noDriver = { ...f, driver: undefined };
    const result = await runAgentServiceControl({
      services: noDriver.services,
      channel: noDriver.channel,
      sessionId: "main",
      serviceId: SERVICE_ID,
      action: "start",
      write: noDriver.write,
      persist: () => noDriver.store.writeSession(DIR, noDriver.channel.snapshot()),
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("service-execution-unavailable") });
    expect(f.services.get(SERVICE_ID)?.lifecycle).toBe("stopped");
  });

  it("does not mint for a service the task has not registered", async () => {
    const { channel, control, services, started } = setup("default");
    const denied = await control({ serviceId: "not-registered" });
    expect(denied.ok).toBe(false);
    expect(started).toEqual([]);
    expect(denied).toMatchObject({ error: expect.stringContaining("unknown-service") });
    // Asking a user to confirm a start that can never run is the bug this
    // guard prevents: nothing pending, nothing registered.
    expect(channel.snapshot().approvals).toHaveLength(0);
    expect(services.ids()).toEqual([SERVICE_ID]);
  });

  // [PiDock 09] (#11) box 3: even the auto tier follows the task write right,
  // and a queued session must not spend the user's attention on a confirmation
  // it cannot use.
  it("refuses an auto-tier control while another session holds the write right", async () => {
    const { services, control, write, started } = setup("auto");
    const held = write.claimWrite("other", "auto", { kind: "turn", label: "回合工具 exec.run" });
    expect(held.ok).toBe(true);
    const denied = await control();
    expect(denied).toMatchObject({ ok: false, error: expect.stringContaining("task-locked: 同一任务写操作权由会话 other 持有") });
    expect(services.get(SERVICE_ID)?.lifecycle).toBe("stopped");
    expect(write.owner).toBe("other");
    expect(started).toEqual([]);
    // The right is released by the other session, then the same call runs.
    write.releaseWrite((held as { claimId: string }).claimId);
    expect((await control()).ok).toBe(true);
    expect(services.get(SERVICE_ID)?.lifecycle).toBe("running");
  });

  it("does not mint a default-tier confirmation while another session holds the write right", async () => {
    const { channel, control, services, write, started } = setup("default");
    write.claimWrite("other", "auto", { kind: "turn", label: "回合工具 fs.write" });
    const denied = await control();
    expect(started).toEqual([]);
    expect(denied).toMatchObject({ ok: false, error: expect.stringContaining("task-locked") });
    expect(channel.snapshot().approvals).toHaveLength(0);
    expect(services.get(SERVICE_ID)?.lifecycle).toBe("stopped");
  });

  it("releases the write right after a one-shot start so the session does not keep it", async () => {
    const { control, write, services } = setup("auto");
    expect((await control()).ok).toBe(true);
    expect(write.owner).toBeNull();
    // The started service is now a running agent-owned resource: a *new*
    // session is refused until it is verified/stopped (box 5), while the
    // owning session may continue its own work.
    const blocked = write.claimWrite("second", "auto", { kind: "turn", label: "回合工具 fs.write" });
    expect(blocked).toMatchObject({ ok: false, verdict: "locked", owner: "main" });
    expect(blocked.ok === false && blocked.reason).toContain("遗留执行资源");
    expect(write.claimWrite("main", "auto", { kind: "turn", label: "回合工具 fs.write" }).ok).toBe(true);
    expect(services.runningAgentOwned()).toEqual([{ serviceId: SERVICE_ID, ownerSessionId: "main" }]);
  });
});
