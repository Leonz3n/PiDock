import { describe, expect, it } from "vitest";
import { PiSessionChannel } from "../main/pi-session.js";
import { memoryTaskStore } from "./task-host.js";
import { runAgentServiceControl } from "./service-control.js";
import { TaskServiceRuntime } from "./service-runtime.js";

// Seam: #7 Host agent service-control dispatch (the sequence `host.ts`
// runs), driven here without a utilityProcess. Reviewer P2: the
// verify → spend → persist → act order had no coverage outside the pure
// verifier, so a stale-snapshot or missing-spend edit could regress it.

const DIR = "/Users/name/Tasks/task-a1f92c3d";
const SERVICE_ID = "saas-web";

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
  const control = (input: { action?: "start" | "stop"; serviceId?: string; approvalId?: unknown } = {}) =>
    runAgentServiceControl({
      services,
      channel,
      sessionId: "main",
      serviceId: input.serviceId ?? SERVICE_ID,
      action: input.action ?? "start",
      ...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
      persist: () => store.writeSession(DIR, channel.snapshot()),
    });
  return { services, store, channel, control, persisted };
}

describe("agent service-control dispatch", () => {
  it("mints one scope-bound approval for a default-tier start, then acts on approval and refuses the replay", () => {
    const { services, channel, control, persisted } = setup("default");
    const first = control();
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
    expect(control({ approvalId: "approval-1" }).ok).toBe(false);
    channel.approve("approval-1");
    const acted = control({ approvalId: "approval-1" });
    expect(acted).toEqual({ ok: true, payload: { serviceId: SERVICE_ID, action: "start", actor: "agent", tier: "default" } });
    expect(services.get(SERVICE_ID)?.lifecycle).toBe("running");
    expect(services.get(SERVICE_ID)?.events.join("\n")).toContain("start:agent:main:default");
    // The spend is written back: replaying the same id (even for stop) is
    // denied and the lifecycle is untouched.
    expect(persisted()?.approvals.find((item) => item.id === "approval-1")?.consumedAt).toBeDefined();
    const replay = control({ action: "stop", approvalId: "approval-1" });
    expect(replay.ok).toBe(false);
    expect(services.get(SERVICE_ID)?.lifecycle).toBe("running");
  });

  it("never spends a turn approval minted for the same tool + target", () => {
    const { services, channel, control } = setup("default");
    const turn = channel.gate("exec.run", `${DIR}/services/${SERVICE_ID}`, "v12");
    if (turn.verdict !== "ask") throw new Error("expected an approval request");
    expect(channel.snapshot().approvals[0].scope).toBeUndefined();
    channel.approve(turn.approvalId);
    const denied = control({ approvalId: turn.approvalId });
    expect(denied.ok).toBe(false);
    expect(denied).toMatchObject({ error: expect.stringContaining("用途未绑定") });
    expect(services.get(SERVICE_ID)?.lifecycle).toBe("stopped");
    // No silent spend and no second mint: the turn's own request is intact.
    expect(channel.snapshot().approvals).toHaveLength(1);
    expect(channel.snapshot().approvals[0].consumedAt).toBeUndefined();
  });

  it("denies read-only sessions and never mints", () => {
    const { services, channel, control } = setup("read");
    const denied = control();
    expect(denied.ok).toBe(false);
    expect(denied).toMatchObject({ error: expect.stringContaining("只读") });
    expect(channel.snapshot().approvals).toHaveLength(0);
    expect(services.get(SERVICE_ID)?.lifecycle).toBe("stopped");
  });

  it("allows auto tier without an approval", () => {
    const { services, channel, control } = setup("auto");
    expect(control()).toEqual({ ok: true, payload: { serviceId: SERVICE_ID, action: "start", actor: "agent", tier: "auto" } });
    expect(services.get(SERVICE_ID)?.lifecycle).toBe("running");
    expect(channel.snapshot().approvals).toHaveLength(0);
  });

  it("does not mint for a service the task has not registered", () => {
    const { channel, control, services } = setup("default");
    const denied = control({ serviceId: "not-registered" });
    expect(denied.ok).toBe(false);
    expect(denied).toMatchObject({ error: expect.stringContaining("unknown-service") });
    // Asking a user to confirm a start that can never run is the bug this
    // guard prevents: nothing pending, nothing registered.
    expect(channel.snapshot().approvals).toHaveLength(0);
    expect(services.ids()).toEqual([SERVICE_ID]);
  });
});
