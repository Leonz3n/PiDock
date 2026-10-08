/**
 * [PiDock 14] (#17) Host-driven control-class execution records.
 *
 * The three control sequences (`runAgentServiceControl`, `runAgentBrowserAction`,
 * `runAgentTerminalControl`) already own the permission gate. This suite drives
 * them against a *real* `TaskWorkspaceHost` ledger port, so what it proves is the
 * wiring the ticket asks for: the gate's outcome is what `executionState` reads —
 * a minted confirmation waits, a refusal that executed nothing fails, and only a
 * performed control completes the record. No stub ledger is involved.
 */
import { describe, expect, it } from "vitest";
import { planTerminal, TaskTerminalRegistry, type TerminalPlan } from "../main/terminal-config.js";
import { workspaceRoots } from "../main/workspace-files.js";
import { runAgentBrowserAction, type BrowserGatewayPort } from "./browser-control.js";
import { runAgentServiceControl, type ServiceExecutionDriver } from "./service-control.js";
import { runAgentTerminalControl } from "./terminal-control.js";
import { TaskServiceRuntime } from "./service-runtime.js";
import { TaskWorkspaceHost, memoryTaskStore } from "./task-host.js";

const TASK_ID = "task-a1f92c3d";
const DIR = "/Users/name/Tasks/task-a1f92c3d";
const SERVICE_ID = "saas-web";
const PAGE = { taskId: TASK_ID, pageId: "page-1", webContentsId: 11 };
const ROOTS = workspaceRoots({ taskId: TASK_ID, taskDir: DIR, repos: ["invoice-service"], branch: "main" });

type Tier = "read" | "default" | "auto";

/**
 * The gate and the execution ledger are this suite's subject, not the spawner;
 * `runAgentServiceControl` performs its lifecycle change only after the driver
 * reports a real pid, so the stub stands in for the Host's process port.
 */
const STUB_DRIVER: ServiceExecutionDriver = {
  start: async () => ({ pid: 4821 }),
  stop: async () => {},
};

function plannedTerminal(instanceId = "term-1"): TerminalPlan {
  const result = planTerminal({
    roots: ROOTS,
    taskId: TASK_ID,
    taskDir: DIR,
    rootId: "invoice-service",
    program: "bash",
    args: ["-l"],
    layers: { repoDefaults: [], shared: [], privateEntries: [], task: [] },
    owner: { taskId: TASK_ID, sessionId: "main", label: "会话 main" },
    instanceId,
  });
  if (!result.ok) throw new Error(result.error);
  return result.plan;
}

function setup(tier: Tier = "default") {
  const store = memoryTaskStore();
  const host = new TaskWorkspaceHost(TASK_ID, DIR, store, () => "2026-09-22T10:00:00+08:00");
  host.provision({ name: "控制记录", dirId: TASK_ID, remoteBranch: "main", fetchedCommit: "a5a4a0d1234", repos: [] });
  const channel = host.openSession("main", { permission: tier });
  const persist = () => store.writeSession(DIR, channel.snapshot());
  const services = new TaskServiceRuntime(DIR);
  services.register({
    serviceId: SERVICE_ID,
    descriptor: { name: SERVICE_ID, program: "pnpm", args: ["--filter", SERVICE_ID, "dev"], ports: [5173], runType: "long-lived" },
    layers: { repoDefaults: [], shared: [], privateEntries: [], task: [] },
    templateVersion: "v12",
  });
  const performCalls: unknown[] = [];
  const gateway: BrowserGatewayPort = {
    taskId: TASK_ID,
    perform: async (request) => {
      performCalls.push(request);
      return { ok: true, payload: { state: { url: "http://localhost:5173/checkout" } } };
    },
  };
  const registry = new TaskTerminalRegistry(TASK_ID);
  const serviceControl = (input: { tier?: Tier; approvalId?: unknown } = {}) => {
    const session = host.openSession("main", { permission: input.tier ?? tier });
    return runAgentServiceControl({
      services,
      channel: session,
      sessionId: "main",
      serviceId: SERVICE_ID,
      action: "start",
      driver: STUB_DRIVER,
      ...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
      write: host,
      persist,
      executions: host.controlExecutions,
    });
  };
  const browserAction = (input: { tier?: Tier; approvalId?: unknown } = {}) => {
    const session = host.openSession("main", { permission: input.tier ?? tier });
    return runAgentBrowserAction({
      gateway,
      channel: session,
      sessionId: "main",
      taskId: TASK_ID,
      action: "page/navigate",
      page: PAGE,
      params: { url: "http://localhost:5173/checkout" },
      ...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
      taskDir: DIR,
      write: host,
      persist,
      executions: host.controlExecutions,
    });
  };
  const terminalControl = (input: { tier?: Tier; approvalId?: unknown; instanceId?: string } = {}) => {
    const session = host.openSession("main", { permission: input.tier ?? tier });
    const instanceId = input.instanceId ?? "term-1";
    return runAgentTerminalControl({
      registry,
      channel: session,
      taskDir: DIR,
      sessionId: "main",
      instanceId,
      action: "start",
      ...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
      write: host,
      persist,
      act: () => {
        registry.register(plannedTerminal(instanceId));
        return registry.markProcess(instanceId, { processId: 9876 });
      },
      executions: host.controlExecutions,
    });
  };
  const pendingId = () => {
    const approvals = channel.snapshot().approvals;
    const last = approvals[approvals.length - 1];
    if (!last) throw new Error("no pending approval");
    return last.id;
  };
  const rows = (kind?: string) =>
    host
      .executionState("main")
      .executions.filter((record) => kind === undefined || record.kind === kind);
  return { host, channel, persist, services, gateway, performCalls, registry, serviceControl, browserAction, terminalControl, pendingId, rows };
}

describe("[PiDock 14] (#17) control-class execution records", () => {
  it("records one completed browser-action execution when an auto-tier action really runs", async () => {
    const f = setup("auto");
    const result = await f.browserAction();
    expect(result.ok).toBe(true);
    expect(f.performCalls).toHaveLength(1);
    expect(f.rows("browser-action")).toMatchObject([
      { kind: "browser-action", sessionId: "main", state: "done", steps: [{ stepId: "control", state: "done" }] },
    ]);
    // A completed control is a done session-side execution, never a service state.
    expect(f.host.executionState("main")).toMatchObject({ session: "done", services: [] });
  });

  it("leaves a default-tier browser-action execution waiting on its minted confirmation", async () => {
    const f = setup("default");
    const first = await f.browserAction();
    expect(first.ok).toBe(false);
    const approvalId = f.pendingId();
    expect(f.rows("browser-action")).toMatchObject([
      { kind: "browser-action", state: "pending-approval", approval: { approvalId, scope: "browser-control", status: "pending" } },
    ]);
    // Nothing performed, so the confirmation is the only open work.
    expect(f.performCalls).toHaveLength(0);
  });

  it("keeps a control execution executing after the user approves it, and completes it only when the Agent retries", async () => {
    const f = setup("default");
    await f.terminalControl();
    const approvalId = f.pendingId();
    expect(f.rows("terminal-control")).toMatchObject([{ state: "pending-approval" }]);
    f.host.approve("main", approvalId);
    // Approving spends the confirmation; the terminal is still not started.
    expect(f.registry.list()).toHaveLength(0);
    expect(f.rows("terminal-control")).toMatchObject([{ state: "executing" }]);
    const acted = f.terminalControl({ approvalId });
    expect(acted.ok).toBe(true);
    expect(f.registry.list()).toMatchObject([{ instanceId: "term-1", lifecycle: "running" }]);
    expect(f.rows("terminal-control")).toMatchObject([
      { state: "done", steps: [{ stepId: "control", state: "done" }], attempts: [{ endState: "completed" }] },
    ]);
    // A late replay is refused and never rewrites the completed row.
    expect(f.terminalControl({ approvalId }).ok).toBe(false);
    expect(f.rows("terminal-control")).toHaveLength(1);
  });

  it("records the operation that really ran when a retry with the same approval id reuses a failed row", async () => {
    const f = setup("default");
    await f.serviceControl();
    const approvalId = f.pendingId();
    f.host.approve("main", approvalId);
    expect(f.rows("service-control")).toMatchObject([{ state: "executing" }]);
    // Another session holds the task write right, so the first retry is refused
    // before it can spend the confirmation: the bound row fails while the
    // confirmation stays approved and unconsumed.
    const held = f.host.claimWrite("other", "default", { kind: "turn", label: "另一会话" });
    if (!held.ok) throw new Error("write right not granted");
    const blocked = await f.serviceControl({ approvalId });
    expect(blocked.ok).toBe(false);
    expect(blocked.ok ? "" : blocked.error).toContain("task-locked");
    expect(f.rows("service-control")).toMatchObject([{ state: "failed" }]);
    // The right is free again: the same confirmation really starts the service,
    // so the performed operation must read done instead of keeping the failed row.
    f.host.releaseWrite(held.claimId);
    const acted = await f.serviceControl({ approvalId });
    expect(acted.ok).toBe(true);
    expect(f.rows("service-control")).toMatchObject([
      { state: "done", steps: [{ stepId: "control", state: "done" }], attempts: [{ endState: "completed" }] },
      { state: "failed" },
    ]);
  });

  it("records an auto-tier retry that runs with a stale terminal approval id instead of nothing", async () => {
    const f = setup("default");
    await f.serviceControl();
    const approvalId = f.pendingId();
    f.host.approve("main", approvalId);
    // The refused retry settles the bound row before the confirmation is spent.
    const held = f.host.claimWrite("other", "default", { kind: "turn", label: "另一会话" });
    if (!held.ok) throw new Error("write right not granted");
    expect((await f.serviceControl({ approvalId })).ok).toBe(false);
    expect(f.rows("service-control")).toMatchObject([{ state: "failed" }]);
    f.host.releaseWrite(held.claimId);
    // The user raised the session to auto: the still-live confirmation runs
    // without a new ask, yet the row it was bound to is already terminal.
    f.host.setPermission("main", "auto");
    expect((await f.serviceControl({ approvalId })).ok).toBe(true);
    expect(f.rows("service-control")).toMatchObject([
      { state: "done", attempts: [{ endState: "completed" }] },
      { state: "failed" },
    ]);
  });

  it("rejects a control confirmation through the ledger and opens a fresh row when the Agent asks again", async () => {
    const f = setup("default");
    await f.serviceControl();
    const rejectedId = f.pendingId();
    f.host.reject("main", rejectedId);
    expect(f.rows("service-control")).toMatchObject([{ state: "rejected", approval: { approvalId: rejectedId, status: "rejected" } }]);
    const asked = await f.serviceControl();
    expect(asked.ok).toBe(false);
    // The settled history row is kept; the new wait is its own row.
    expect(f.rows("service-control")).toMatchObject([
      { state: "pending-approval", approval: { status: "pending" } },
      { state: "rejected" },
    ]);
  });

  it("fails a control execution the tier refused, without minting a confirmation or performing anything", async () => {
    const f = setup("read");
    const denied = await f.browserAction({ tier: "read" });
    expect(denied.ok).toBe(false);
    expect(f.performCalls).toHaveLength(0);
    expect(f.channel.snapshot().approvals).toHaveLength(0);
    expect(f.rows("browser-action")).toMatchObject([
      { kind: "browser-action", state: "failed", failureReason: expect.stringContaining("只读会话禁止浏览器操作") },
    ]);
  });

  it("completes an auto-tier service-control execution without a confirmation", async () => {
    const f = setup("auto");
    const result = await f.serviceControl();
    expect(result.ok).toBe(true);
    expect(f.channel.snapshot().approvals).toHaveLength(0);
    expect(f.rows("service-control")).toMatchObject([{ kind: "service-control", state: "done" }]);
  });

  it("keeps the three control families apart from the turn and compaction records", async () => {
    const f = setup("auto");
    await f.serviceControl();
    f.terminalControl();
    const kinds = f.host.executionState("main").executions.map((record) => record.kind).sort();
    expect(kinds).toEqual(["service-control", "terminal-control"]);
    expect(f.host.executionState("other").executions).toEqual([]);
  });
});
