import { describe, expect, it } from "vitest";
import {
  buildFreshnessLabel,
  classifySharedResource,
  codeStateLabel,
  failureLabel,
  instanceAddress,
  projectServiceTopology,
  serviceRouteView,
  serviceRouting,
  serviceStartGroups,
  serviceUnits,
  unitsByRepoView,
} from "../data/serviceTopology";
import { createMemoryHost } from "../data/memoryHost";
import type { ServiceUnitView } from "../data/serviceTopology";
import type { Task } from "../data/types";

/**
 * [PiDock 05] (#10) renderer mirror of the shell's topology/run rules.
 *
 * The renderer cannot import `packages/shell` (that would hand the sandbox
 * Node access), so these are independent rules that must keep the same
 * vocabulary as `service-topology.ts` / `service-runs.ts`: unit identity,
 * start groups with bidirectional listener groups, run-record freshness
 * labels and shared-resource limits.
 */

function unit(overrides: Partial<ServiceUnitView> & { unitId: string; name: string }): ServiceUnitView {
  return {
    serviceId: overrides.serviceId ?? overrides.name,
    location: "local",
    runType: "long-lived",
    dependencies: [],
    ...overrides,
  };
}

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    projectId: "atlas",
    name: overrides.id,
    workspaceKey: `task-${overrides.id}`,
    workspaceRoot: "/Users/me/Workspace",
    type: "normal",
    environmentId: "testing",
    templateVersion: "v12",
    repos: [],
    directories: [],
    configOverrides: [],
    archived: false,
    permission: "default",
    services: [],
    sessions: [],
    activeSessionId: "main",
    unread: 0,
    files: [],
    browserPages: [],
    terminalSeed: [],
    ...overrides,
  };
}

describe("instance identity and repo grouping", () => {
  it("builds the task-scoped address and keeps several units per repo", () => {
    expect(instanceAddress("task-a1f92c3d", "invoice-service", 9001)).toBe("task-a1f92c3d/invoice-service@9001");
    expect(instanceAddress("task-a1f92c3d", "account-service")).toBe("task-a1f92c3d/account-service");
    const groups = unitsByRepoView([
      unit({ unitId: "front:web", name: "web", repoDir: "front" }),
      unit({ unitId: "front:bff", name: "bff", repoDir: "front" }),
      unit({ unitId: "task:helper", name: "helper" }),
    ]);
    expect(groups.map((group) => [group.repoDir, group.units.length])).toEqual([
      ["front", 2],
      ["", 1],
    ]);
  });
});

describe("start groups", () => {
  it("runs prepare steps first, merges a bidirectional pair, and checks remote deps", () => {
    const units: ServiceUnitView[] = [
      unit({ unitId: "a:web", name: "web", dependencies: [{ to: "a:bff", kind: "call" }] }),
      unit({
        unitId: "a:bff",
        name: "bff",
        dependencies: [
          { to: "a:migrate", kind: "prestart" },
          { to: "a:invoice", kind: "call" },
          { to: "a:account", kind: "call" },
        ],
      }),
      unit({ unitId: "a:invoice", name: "invoice", dependencies: [{ to: "a:shipment", kind: "call" }] }),
      unit({ unitId: "a:shipment", name: "shipment", dependencies: [{ to: "a:invoice", kind: "call" }] }),
      unit({ unitId: "a:migrate", name: "migrate", runType: "prepare" }),
      unit({ unitId: "a:account", name: "account", location: "remote" }),
    ];
    const groups = serviceStartGroups(units, "testing");
    expect(groups[0]).toMatchObject({ groupId: "prestart", members: ["a:migrate"] });
    const merged = groups.find((group) => group.members.length === 2);
    expect(merged).toMatchObject({ bidirectional: true, reason: "listener-group" });
    expect(merged?.members).toEqual(["a:invoice", "a:shipment"]);
    expect(merged?.verify).toContain("双向调用组联通检查（先监听再互验，不等待对方就绪）");
    const bff = groups.find((group) => group.members.includes("a:bff"));
    expect(bff?.verify).toContain("前置条件就绪检查 migrate");
    expect(bff?.verify).toContain("联通检查 invoice（a:invoice）");
    expect(bff?.verify).toContain("远程依赖可达性检查 account（共享环境 testing，不标记为任务内隔离）");
    // The callee group starts before its caller.
    expect(groups.findIndex((group) => group.members.includes("a:invoice"))).toBeLessThan(
      groups.findIndex((group) => group.members.includes("a:web")),
    );
  });
});

describe("task-view projection", () => {
  it("routes task-scoped read points to the instance and unbound ones to the shared environment", () => {
    const view = projectServiceTopology(
      task({
        id: "release",
        services: [
          {
            id: "release-service-3",
            unitId: "invoice-service:invoice-service",
            name: "invoice-service",
            repo: "invoice-service",
            port: 9001,
            mode: "local",
            running: true,
            configSource: "共享模板 · testing",
            templateVersion: "v12",
            resolved: [
              { key: "API_BASE_URL", value: "https://invoice-service.testing.atlas.example.com", secret: false, source: "仓库默认配置 · .env" },
              { key: "INVOICE_SERVICE_ENDPOINT", value: "http://127.0.0.1:9001", secret: false, source: "任务覆盖" },
              { key: "PORT", value: "9001", secret: false, source: "运行时端口绑定 · 本地" },
            ],
          },
          {
            id: "release-service-6",
            unitId: "task:account-service",
            name: "account-service",
            mode: "remote",
            running: false,
            configSource: "远程依赖 · 未在本任务启动",
            templateVersion: "v12",
            resolved: [
              { key: "API_BASE_URL", value: "https://account-service.testing.atlas.example.com", secret: false, source: "仓库默认配置 · .env" },
              { key: "PORT", value: "3001", secret: false, source: "运行时端口绑定 · 远程" },
            ],
          },
        ],
        externalResources: [{ resourceId: "res-queue", name: "invoice-events", kind: "queue" }],
      }),
      "testing",
    );
    expect(view.routing).toEqual([
      {
        unitId: "invoice-service:invoice-service",
        key: "API_BASE_URL",
        value: "https://invoice-service.testing.atlas.example.com",
        readPoints: ["仓库默认配置 · .env"],
        // Never overridden by the task: the read point keeps the shared value.
        target: { kind: "remote", environment: "testing" },
      },
      {
        unitId: "invoice-service:invoice-service",
        key: "INVOICE_SERVICE_ENDPOINT",
        value: "http://127.0.0.1:9001",
        readPoints: ["任务覆盖"],
        target: { kind: "local-instance", serviceId: "release-service-3", address: "release/release-service-3@9001", port: 9001 },
      },
      {
        unitId: "invoice-service:invoice-service",
        key: "PORT",
        value: "9001",
        readPoints: ["运行时端口绑定 · 本地"],
        target: { kind: "local-instance", serviceId: "release-service-3", address: "release/release-service-3@9001", port: 9001 },
      },
      {
        unitId: "task:account-service",
        key: "API_BASE_URL",
        value: "https://account-service.testing.atlas.example.com",
        readPoints: ["仓库默认配置 · .env"],
        target: { kind: "remote", environment: "testing" },
      },
      // A remote service never routes to a local instance, even for a
      // runtime binding.
      {
        unitId: "task:account-service",
        key: "PORT",
        value: "3001",
        readPoints: ["运行时端口绑定 · 远程"],
        target: { kind: "remote", environment: "testing" },
      },
    ]);
    expect(view.knownLimits).toEqual([
      "固定异步队列「invoice-events」是共享外部资源：消费端与回调端仍指向同一实例，不标记为任务隔离成功",
    ]);
    expect(view.resources[0]).toMatchObject({ shared: true, isolation: "not-isolated" });
  });

  it("shows the failure and the run record of each service", () => {
    const view = projectServiceTopology(
      task({
        id: "checkout",
        services: [
          {
            id: "checkout-service-3",
            name: "invoice-service",
            port: 9002,
            mode: "local",
            running: false,
            configSource: "共享模板 · testing",
            templateVersion: "v12",
            resolved: [],
            failure: { code: "port-taken", message: "端口 9002 已被占用", hint: "会重新分配端口" },
            runRecord: {
              runId: "run-1",
              templateVersion: "v12",
              codeState: "uncommitted",
              codeCommit: "9acb5b6f",
              buildFreshness: "uncommitted-code",
              ports: [9002],
              processIdentity: { owner: "human", pid: 4100, startedAt: "2026-09-22T09:30:00+08:00" },
              logRef: "/tasks/checkout/services/invoice-service/run-1.log",
              startedAt: "2026-09-22T09:30:00+08:00",
              verifications: [],
              simulated: true,
            },
          },
        ],
      }),
      "testing",
    );
    expect(view.diagnostics).toEqual([{ code: "port-taken", message: "端口 9002 已被占用", hint: "会重新分配端口" }]);
    expect(view.records[0]?.run?.buildFreshness).toBe("uncommitted-code");
    expect(view.records[0]?.run?.simulated).toBe(true);
  });
});

describe("display labels", () => {
  it("labels failures, code state, build freshness and shared resources", () => {
    expect(failureLabel("port-taken")).toEqual({ label: "端口被占用", hint: "重新分配端口后会更新受影响的消费者" });
    expect(failureLabel("dependency-unreachable").label).toBe("依赖不可达");
    expect(failureLabel("mystery").label).toBe("运行问题");
    expect(codeStateLabel("uncommitted")).toBe("有未提交修改");
    expect(buildFreshnessLabel("fresh")).toBe("构建与当前提交一致");
    expect(buildFreshnessLabel("stale-build")).toBe("构建来自旧提交");
    expect(buildFreshnessLabel("uncommitted-code")).toContain("未提交修改");
    expect(buildFreshnessLabel("unknown")).toBe("无法判断构建状态");
    expect(classifySharedResource({ resourceId: "r", name: "n", kind: "dtm-callback" }).isolation).toBe("not-isolated");
    expect(classifySharedResource({ resourceId: "r", name: "n", kind: "database", isolatedByTask: true }).shared).toBe(false);
  });
});

describe("in-memory fixture topology", () => {
  it("expands the request route box from the declared call graph and names the remote units", async () => {
    // [UI 对齐 04] (#28) the runtime panel's route box: the declared call graph
    // from the entry unit, a mutual pair joined with `⇄` (never `→`), and the
    // remote units that keep the shared environment.
    const host = createMemoryHost();
    const workspace = await host.getWorkspace();
    const release = workspace.tasks.find((task) => task.id === "release") as Task;
    const route = serviceRouteView(projectServiceTopology(release, "testing"), "testing");
    expect(route.environment).toBe("testing");
    expect(route.local).toEqual([
      { name: "saas-web", connector: "start" },
      { name: "saas-bff", connector: "call" },
      { name: "invoice-service", connector: "call" },
      { name: "shipment-service", connector: "pair" },
    ]);
    expect(route.remote).toEqual(["account-service", "Redis / PostgreSQL"]);
  });

  it("gives two tasks running the same service name different local ports", async () => {
    const host = createMemoryHost();
    const workspace = await host.getWorkspace();
    const portOf = (taskId: string, name: string) =>
      workspace.tasks.find((task) => task.id === taskId)?.services.find((service) => service.name === name)?.port;
    expect(portOf("release", "saas-web")).toBe(5173);
    expect(portOf("release", "invoice-service")).toBe(9001);
    // The second task's same-name services move to other local ports.
    expect(portOf("checkout", "saas-web")).toBe(5174);
    expect(portOf("checkout", "invoice-service")).toBeGreaterThan(9001);
    expect(portOf("release", "saas-web")).not.toBe(portOf("checkout", "saas-web"));
    expect(portOf("release", "invoice-service")).not.toBe(portOf("checkout", "invoice-service"));
  });

  it("projects the seeded plan with groups, routing and shared external resources", async () => {    const host = createMemoryHost();
    const workspace = await host.getWorkspace();
    const release = workspace.tasks.find((task) => task.id === "release");
    expect(release).toBeDefined();
    const view = projectServiceTopology(release as Task, "testing");
    expect(view.units.find((entry) => entry.name === "saas-bff")?.dependencies).toEqual([
      { to: "invoice-service:db-migrate", kind: "prestart" },
      { to: "invoice-service:invoice-service", kind: "call" },
      { to: "task:account-service", kind: "call" },
    ]);
    const merged = view.groups.find((group) => group.bidirectional);
    expect(merged?.members).toEqual(["invoice-service:invoice-service", "shipment-service:shipment-service"]);
    expect(view.groups[0]?.members).toEqual(["invoice-service:db-migrate"]);
    expect(view.groups.flatMap((group) => group.verify)).toContain("远程依赖可达性检查 account-service（共享环境 testing，不标记为任务内隔离）");
    expect(view.knownLimits).toHaveLength(2);
    expect(serviceUnits(release as Task).find((entry) => entry.name === "account-service")?.location).toBe("remote");
    expect(serviceRouting(release as Task, "testing").length).toBeGreaterThan(0);
  });
});
