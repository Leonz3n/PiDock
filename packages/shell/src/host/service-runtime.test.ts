import { describe, expect, it } from "vitest";
import { TaskServiceRuntime } from "./service-runtime.js";

// Seam: #7 S2 Host-side service runtime (no Electron, no child_process).

const layers = {
  repoDefaults: [{ key: "API_BASE_URL", value: "https://default.example.com", secret: false }],
  shared: [{ key: "LOG_LEVEL", value: "debug", secret: false }],
  privateEntries: [{ key: "INVOICE_ACCESS_TOKEN", value: "tok", secret: true }],
  task: [{ key: "LOCAL_PORT", value: "5173", secret: false }],
};

function registered(version = "v12") {
  const runtime = new TaskServiceRuntime("/Users/name/Tasks/task-a1f92c3d");
  runtime.register({
    serviceId: "saas-web",
    descriptor: { name: "saas-web", program: "pnpm", args: ["--filter", "saas-web", "dev"], ports: [5173], runType: "long-lived" },
    layers,
    templateVersion: version,
  });
  return runtime;
}

describe("register + planStart", () => {
  it("resolves the snapshot and plans an explicit program+args launch", () => {
    const runtime = registered();
    const plan = runtime.planStart("saas-web", "/Users/name/Tasks/task-a1f92c3d/front");
    expect(plan.program).toBe("pnpm");
    expect(plan.args).toEqual(["--filter", "saas-web", "dev"]);
    expect(plan.env).toMatchObject({ LOG_LEVEL: "debug", LOCAL_PORT: "5173" });
    // No inline env assignment rides the argv.
    expect(plan.args.join(" ")).not.toContain("=");
    const again = runtime.planStart("saas-web", "/Users/name/Tasks/task-a1f92c3d/front");
    expect(plan.env).not.toBe(again.env);
    expect(plan.env).toEqual(again.env);
  });
  it("fails closed on bad descriptors and secret-carrying shared layers", () => {
    const runtime = new TaskServiceRuntime("/t/task-a1f92c3d");
    expect(() =>
      runtime.register({
        serviceId: "bad",
        descriptor: { name: "bad", program: "PORT=1 pnpm", args: ["dev"], ports: [], runType: "long-lived" },
        layers,
        templateVersion: "v1",
      }),
    ).toThrow("invalid-service");
    expect(() =>
      runtime.register({
        serviceId: "leak",
        descriptor: { name: "leak", program: "node", args: ["server.mjs"], ports: [], runType: "long-lived" },
        layers: { ...layers, shared: [{ key: "API_TOKEN", value: "x", secret: false }] },
        templateVersion: "v1",
      }),
    ).toThrow("secret-in-shared");
  });
});

describe("agent control tiers", () => {
  it("denies read, asks on default, allows auto and verified-approval default", () => {
    const runtime = registered();
    const dir = "/Users/name/Tasks/task-a1f92c3d";
    const live = { status: "approved", executed: false, tool: "exec.run", target: `${dir}/services/saas-web`, permissionAtRequest: "default" };
    expect(runtime.decideAgentControl({ serviceId: "saas-web", action: "start", tier: "read" }).ok).toBe(false);
    const ask = runtime.decideAgentControl({ serviceId: "saas-web", action: "start", tier: "default" });
    expect(ask.ok).toBe(false);
    expect(ask.reason).toContain("确认");
    // Rejected-then-claimed-true stays denied: the runtime never trusts a
    // caller boolean, only a live verified approval record.
    expect(runtime.decideAgentControl({ serviceId: "saas-web", action: "start", tier: "default", approvalGranted: true }).ok).toBe(false);
    expect(runtime.decideAgentControl({ serviceId: "saas-web", action: "start", tier: "default", approval: { ...live, status: "rejected" } }).ok).toBe(false);
    expect(runtime.decideAgentControl({ serviceId: "saas-web", action: "start", tier: "default", approval: { ...live, executed: true } }).ok).toBe(false);
    // Foreign-service approval cannot spill over.
    expect(runtime.decideAgentControl({ serviceId: "saas-web", action: "start", tier: "default", approval: { ...live, target: `${dir}/services/other` } }).ok).toBe(false);
    expect(runtime.decideAgentControl({ serviceId: "saas-web", action: "start", tier: "default", approval: live }).ok).toBe(true);
    expect(runtime.decideAgentControl({ serviceId: "saas-web", action: "stop", tier: "auto" }).ok).toBe(true);
  });
  it("rejects unknown services fail-closed", () => {
    const runtime = registered();
    expect(runtime.decideAgentControl({ serviceId: "nope", action: "start", tier: "auto" }).ok).toBe(false);
  });
});

describe("lifecycle vs dependency reachability", () => {
  it("human start/stop flips liveness with labels; dependency notes never do", () => {
    const runtime = registered();
    runtime.markDependencyReachable("saas-web", "invoice:9001 reachable");
    expect(runtime.get("saas-web")?.lifecycle).toBe("stopped");
    runtime.markStarted("saas-web", { kind: "human", label: "用户点击启动" });
    expect(runtime.get("saas-web")?.lifecycle).toBe("running");
    expect(runtime.get("saas-web")?.events.join("\n")).toContain("start:human");
    runtime.markStopped("saas-web", { kind: "agent", sessionId: "main", permissionAtRequest: "auto" }, "user-request");
    expect(runtime.get("saas-web")?.lifecycle).toBe("stopped");
    expect(runtime.get("saas-web")?.exitReason).toBe("user-request");
  });
  it("marks exits with reasons and bounds the log", () => {
    const runtime = registered();
    runtime.markStarted("saas-web", { kind: "human", label: "ui" });
    runtime.markExited("saas-web", "SIGTERM");
    expect(runtime.get("saas-web")?.exitReason).toBe("SIGTERM");
    const tail = runtime.serviceLog("saas-web", 5);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.length).toBeLessThanOrEqual(5);
  });
});

describe("restart-needed + launch verification", () => {
  it("lists services behind the adopted template version", () => {
    const runtime = registered("v12");
    expect(runtime.restartNeeded("v13")).toEqual([{ serviceId: "saas-web", from: "v12", to: "v13" }]);
    expect(runtime.restartNeeded("v12")).toEqual([]);
  });
  it("records per-platform launch verification", () => {
    const runtime = registered();
    runtime.recordLaunchVerification("saas-web", { platform: "darwin-arm64", nodeVersion: "24.21.0", ok: true });
    expect(runtime.get("saas-web")?.launchVerifications).toEqual([
      { platform: "darwin-arm64", nodeVersion: "24.21.0", ok: true, note: "" },
    ]);
  });
});
