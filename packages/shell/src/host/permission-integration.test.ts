import { describe, expect, it } from "vitest";
import { TaskWorkspaceHost, memoryTaskStore } from "./task-host.js";
import { runAgentServiceControl } from "./service-control.js";
import { runAgentBrowserAction, type BrowserGatewayPort } from "./browser-control.js";
import { TaskServiceRuntime } from "./service-runtime.js";
import { writeClaimError } from "./write-coordination.js";

// Seam: [PiDock 09] (#11) integrated permission acceptance across the four
// tool classes the ticket names (file / service / browser / derived execution).
// The unit suites already cover each class on its own; this file drives all of
// them through the SAME task write right and asserts the cross-class rules the
// next ticket (07) builds on:
//
//   1. a read-only session is refused by every class, including the ones that
//      never ask (auto) and any arbitrary execution tool,
//   2. the default tier asks before a command or a browser action but runs a
//      file write directly,
//   3. auto skips asking yet still obey another session's write right,
//   4. a rejection never executes, and
//   5. a derived execution is refused for a read-only session and keeps the
//      right for its session afterwards.

const TASK_ID = "task-a1f92c3d";
const DIR = "/Users/name/Tasks/task-a1f92c3d";
const SERVICE_ID = "saas-web";
const PAGE = { taskId: TASK_ID, pageId: "page-1", webContentsId: 11 };

function setup(tiers: { file: "read" | "default" | "auto"; service: "read" | "default" | "auto"; browser: "read" | "default" | "auto" }) {
  const store = memoryTaskStore();
  const taskHost = new TaskWorkspaceHost(TASK_ID, DIR, store, () => "2026-09-22T10:00:00+08:00");
  taskHost.provision({ name: "集成权限", dirId: "task-a1f92c3d", remoteBranch: "main", fetchedCommit: "a5a4a0d1234", repos: [] });
  taskHost.openSession("main", { permission: tiers.file });
  taskHost.openSession("other", { permission: "default" });

  const services = new TaskServiceRuntime(DIR);
  services.register({
    serviceId: SERVICE_ID,
    descriptor: { name: SERVICE_ID, program: "pnpm", args: ["--filter", SERVICE_ID, "dev"], ports: [5173], runType: "long-lived" },
    layers: { repoDefaults: [], shared: [], privateEntries: [], task: [] },
    templateVersion: "v12",
  });
  const browserCalls: unknown[] = [];
  const gateway: BrowserGatewayPort = {
    taskId: TASK_ID,
    perform: async (request) => {
      browserCalls.push(request);
      return { ok: true, payload: { state: { url: "http://localhost:5173/checkout" } } };
    },
  };
  const writeTurn = (sessionId: string, tier: "read" | "default" | "auto", target: string) => {
    taskHost.setPermission(sessionId, tier);
    return () =>
      taskHost.sendMessage(sessionId, "改文件", {
        tool: "fs.write",
        target,
        execute: (call) => ({ tool: call.tool, kind: call.kind, target: call.target, contentVersion: call.contentVersion, output: "written" }),
      });
  };
  const chromeTurn = (sessionId: string, tier: "read" | "default" | "auto") => {
    taskHost.setPermission(sessionId, tier);
    return () =>
      taskHost.sendMessage(sessionId, "运行命令", {
        tool: "exec.run",
        target: `${DIR}/run.sh`,
        execute: (call) => ({ tool: call.tool, kind: call.kind, target: call.target, contentVersion: call.contentVersion, output: "ran" }),
      });
  };
  const serviceControl = (sessionId: string, tier: "read" | "default" | "auto", approvalId?: unknown) => {
    const channel = taskHost.openSession(sessionId, { permission: tier });
    return runAgentServiceControl({
      services,
      channel: channel as unknown as Parameters<typeof runAgentServiceControl>[0]["channel"],
      sessionId,
      serviceId: SERVICE_ID,
      action: "start",
      ...(approvalId !== undefined ? { approvalId } : {}),
      write: taskHost,
      persist: () => store.writeSession(DIR, channel.snapshot()),
    });
  };
  const browserAction = (sessionId: string, tier: "read" | "default" | "auto", approvalId?: unknown) => {
    const channel = taskHost.openSession(sessionId, { permission: tier });
    return runAgentBrowserAction({
      gateway,
      channel: channel as unknown as Parameters<typeof runAgentBrowserAction>[0]["channel"],
      sessionId,
      taskId: TASK_ID,
      action: "page/navigate",
      page: PAGE,
      params: { url: "http://localhost:5173/checkout" },
      ...(approvalId !== undefined ? { approvalId } : {}),
      taskDir: DIR,
      write: taskHost,
      persist: () => store.writeSession(DIR, channel.snapshot()),
    });
  };
  return {
    taskHost,
    services,
    gateway,
    browserCalls,
    writeTurn,
    chromeTurn,
    serviceControl,
    browserAction,
    store,
  };
}

describe("[PiDock 09] integrated permission acceptance across tool classes", () => {
  it("refuses file, command, service and browser work in a read-only session", async () => {
    const env = setup({ file: "read", service: "read", browser: "read" });
    // 1) File write: refused before any turn runs (no claim, no execution).
    expect(env.writeTurn("main", "read", `${DIR}/notes.md`)).toThrow("只读会话仅允许阅读分析");
    // 2) Command: the Host refuses the round the same way (the tool gate is the
    //    second line, so a direct channel call cannot slip through either).
    expect(env.chromeTurn("main", "read")).toThrow("只读会话仅允许阅读分析");
    const gate = env.taskHost.openSession("main").previewGate("exec.run", `${DIR}/run.sh`);
    expect(gate).toMatchObject({ verdict: "deny" });
    // 3) Service control and 4) browser action: denied by their own tier rule.
    expect(env.serviceControl("main", "read")).toMatchObject({ ok: false });
    expect(env.serviceControl("main", "read", "approval-guessed")).toMatchObject({ ok: false });
    await expect(env.browserAction("main", "read")).resolves.toMatchObject({ ok: false });
    expect(env.browserCalls).toHaveLength(0);
    // 5) Arbitrary execution (a derived child process) is refused as well.
    expect(() => env.taskHost.claimDerivedExecution({ resourceId: "child-1", sessionId: "main", label: "构建子进程" })).toThrow(
      "只读会话不持有写操作权",
    );
    expect(env.taskHost.writeLockOwner).toBeNull();
  });

  it("asks before a command and a browser action on the default tier but runs a file write directly", async () => {
    const env = setup({ file: "default", service: "default", browser: "default" });
    // File write: allowed without asking (the tier only asks for command/browser).
    expect(env.writeTurn("main", "default", `${DIR}/notes.md`)()).toMatchObject({ state: "done" });
    // Command: stops at a confirmation; nothing executed yet.
    const command = env.chromeTurn("main", "default")();
    expect(command.state).toBe("approval");
    // Service control: mints its own scope-bound confirmation, acts only after
    // the approval spends it.
    const serviceMint = env.serviceControl("main", "default");
    expect(serviceMint.ok).toBe(false);
    const serviceApprovalId = String((serviceMint as { error: string }).error).replace("approval-required: ", "");
    expect(env.services.get(SERVICE_ID)?.lifecycle).toBe("stopped");
    env.taskHost.openSession("main").approve(serviceApprovalId);
    expect(env.serviceControl("main", "default", serviceApprovalId)).toMatchObject({ ok: true });
    expect(env.services.get(SERVICE_ID)?.lifecycle).toBe("running");
    // Browser: also asks first, and the gateway was not touched.
    const browserMint = await env.browserAction("main", "default");
    expect(browserMint.ok).toBe(false);
    const browserApprovalId = String((browserMint as { error: string }).error).replace("approval-required: ", "");
    expect(env.browserCalls).toHaveLength(0);
    env.taskHost.openSession("main").approve(browserApprovalId);
    await expect(env.browserAction("main", "default", browserApprovalId)).resolves.toMatchObject({ ok: true });
    expect(env.browserCalls).toHaveLength(1);
    // Rejection never executes: the pending command approval is turned down.
    env.taskHost.reject("main", command.approvalId ?? "");
    const calls = env.taskHost.openSession("main").snapshot().calls;
    expect(calls.some((call) => call.status === "approved")).toBe(false);
  });

  it("never executes a rejected request and releases the write right with the rejection", () => {
    const env = setup({ file: "default", service: "default", browser: "default" });
    const command = env.chromeTurn("main", "default")();
    expect(command.state).toBe("approval");
    env.taskHost.reject("main", command.approvalId ?? "");
    // The right is free again after the rejection (盒子 2: rejection is a settle).
    expect(env.taskHost.writeLockOwner).toBeNull();
    // The rejected call never ran: the session's calls record no execution.
    const calls = env.taskHost.openSession("main").snapshot().calls;
    expect(calls.every((call) => call.status !== "approved" || call.tool !== "exec.run")).toBe(true);
    // Another session may now claim the right without waiting.
    expect(env.writeTurn("other", "default", `${DIR}/other.md`)()).toMatchObject({ state: "done" });
  });

  it("keeps the auto tier unasked but still behind the task write right", async () => {
    const env = setup({ file: "auto", service: "auto", browser: "auto" });
    // Another session holds the right (a live confirmation on an unrelated run).
    const holder = env.chromeTurn("other", "default")();
    expect(holder.state).toBe("approval");
    // auto file write: refused with the holder named, no mint, no execution.
    expect(env.writeTurn("main", "auto", `${DIR}/notes.md`)).toThrow("同一任务写操作权由会话 other 持有");
    // auto service control and browser action: refused before minting/acting.
    expect(env.serviceControl("main", "auto")).toMatchObject({ ok: false });
    await expect(env.browserAction("main", "auto")).resolves.toMatchObject({ ok: false });
    expect(env.browserCalls).toHaveLength(0);
    expect(env.services.runningAgentOwned()).toHaveLength(0);
    // Releasing the holder lets auto proceed without any confirmation.
    env.taskHost.reject("other", holder.approvalId ?? "");
    expect(env.writeTurn("main", "auto", `${DIR}/notes.md`)()).toMatchObject({ state: "done" });
    expect(env.serviceControl("main", "auto")).toMatchObject({ ok: true });
    await expect(env.browserAction("main", "auto")).resolves.toMatchObject({ ok: true });
    expect(env.browserCalls).toHaveLength(1);
  });

  it("keeps the write right for a derived execution and shares one refusal text across classes", async () => {
    const env = setup({ file: "default", service: "default", browser: "default" });
    expect(env.taskHost.claimDerivedExecution({ resourceId: "child-1", sessionId: "main", label: "构建子进程" })).toBe(true);
    // The derived execution keeps the right although no turn is live (盒子 4).
    expect(env.taskHost.writeLockOwner).toBe("main");
    const refusal = env.taskHost.claimWrite("other", "default", { kind: "turn", label: "回合工具 fs.write" });
    expect(refusal.ok).toBe(false);
    expect(writeClaimError(refusal as Extract<typeof refusal, { ok: false }>)).toContain("task-locked:");
    expect(() => env.writeTurn("other", "default", `${DIR}/other.md`)()).toThrow("task-locked:");
    expect(env.serviceControl("other", "default")).toMatchObject({ ok: false });
    await expect(env.browserAction("other", "default")).resolves.toMatchObject({ ok: false });
    // Ending the child process frees the right for the other session.
    env.taskHost.endDerivedExecution("child-1");
    expect(env.taskHost.writeLockOwner).toBeNull();
    expect(env.writeTurn("other", "default", `${DIR}/other.md`)()).toMatchObject({ state: "done" });
  });
});

// Seam: [PiDock 07] (#13) box 1. The pilot flow is the first real business path
// (BFF start command plus a visible-menu navigation in the task browser, shaped
// from docs/pilot-repository-inspection.md). It must pass the very same
// default-tier gate the integrated acceptance covers: no confirmation means no
// run, a rejection means no run, and there is no acceptance-only bypass.
describe("[PiDock 07] pilot operations keep the default-tier gate", () => {
  const PILOT_COMMAND = `${DIR}/apps/saas-bff`;
  const PILOT_PAGE = "http://localhost:3100/sass/ucenter/tenantMgt/subscribe/flowLog";

  const pilotCommand = (
    env: ReturnType<typeof setup>,
    sessionId: string,
    permission: "read" | "default" | "auto" = "default",
  ) => {
    env.taskHost.setPermission(sessionId, permission);
    return env.taskHost.sendMessage(sessionId, "启动本地 BFF", {
      tool: "exec.run",
      target: PILOT_COMMAND,
      execute: (call) => ({
        tool: call.tool,
        kind: call.kind,
        target: call.target,
        contentVersion: call.contentVersion,
        output: "pnpm --filter @shipber/saas-bff start:dev",
      }),
    });
  };

  const pilotNavigate = async (
    env: ReturnType<typeof setup>,
    sessionId: string,
    permission: "read" | "default" | "auto" = "default",
    approvalId?: unknown,
  ) => {
    const channel = env.taskHost.openSession(sessionId, { permission });
    return runAgentBrowserAction({
      gateway: env.gateway,
      channel: channel as unknown as Parameters<typeof runAgentBrowserAction>[0]["channel"],
      sessionId,
      taskId: TASK_ID,
      action: "page/navigate",
      page: PAGE,
      params: { url: PILOT_PAGE },
      ...(approvalId !== undefined ? { approvalId } : {}),
      taskDir: DIR,
      write: env.taskHost,
      persist: () => env.store.writeSession(DIR, channel.snapshot()),
    });
  };

  it("asks before the pilot command and the pilot navigation, and a rejection runs neither", async () => {
    const env = setup({ file: "default", service: "default", browser: "default" });
    expect(env.taskHost.openSession("main").previewGate("exec.run", PILOT_COMMAND)).toMatchObject({
      verdict: "ask",
    });
    const command = pilotCommand(env, "main");
    expect(command.state).toBe("approval");
    env.taskHost.reject("main", command.approvalId ?? "");
    const calls = env.taskHost.openSession("main").snapshot().calls;
    expect(calls.some((call) => call.status === "approved")).toBe(false);
    expect(env.taskHost.writeLockOwner).toBeNull();

    const first = await pilotNavigate(env, "main");
    expect(first.ok).toBe(false);
    const rejected = String((first as { error: string }).error).replace("approval-required: ", "");
    expect(env.browserCalls).toHaveLength(0);
    env.taskHost.reject("main", rejected);
    expect(env.browserCalls).toHaveLength(0);

    const retry = await pilotNavigate(env, "main");
    const granted = String((retry as { error: string }).error).replace("approval-required: ", "");
    expect(granted).not.toBe(rejected);
    env.taskHost.openSession("main").approve(granted);
    await expect(pilotNavigate(env, "main", "default", granted)).resolves.toMatchObject({ ok: true });
    expect(env.browserCalls).toHaveLength(1);
    // One confirmation authorizes one navigation; the pilot flow cannot replay it.
    await expect(pilotNavigate(env, "main", "default", granted)).resolves.toMatchObject({
      ok: false,
    });
    expect(env.browserCalls).toHaveLength(1);
  });

  it("refuses both pilot operations outright in a read-only session", async () => {
    const env = setup({ file: "read", service: "read", browser: "read" });
    expect(() => pilotCommand(env, "main", "read")).toThrow("只读会话仅允许阅读分析");
    expect(env.taskHost.openSession("main").previewGate("exec.run", PILOT_COMMAND)).toMatchObject({
      verdict: "deny",
    });
    await expect(pilotNavigate(env, "main", "read")).resolves.toMatchObject({ ok: false });
    expect(env.browserCalls).toHaveLength(0);
    expect(env.taskHost.writeLockOwner).toBeNull();
  });
});
