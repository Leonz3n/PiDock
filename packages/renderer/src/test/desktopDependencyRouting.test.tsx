/**
 * [PiDock 05] (#10 box 1) the SHIPPED dock's 本地/远程位置 + 实际依赖去向 readout.
 *
 * This renders the production 运行 tool dock (`DesktopToolDock`, the packaged
 * app's panel) with only the preload bridge stubbed, and drives the REAL route
 * `shell/serviceCatalogOp {op:"taskDependencyRouting"}`. Why it exists: the same
 * facts were only ever rendered by the demo mirror in `ToolPanels.tsx`, which the
 * packaged app never mounts - a readout reachable only from the demo is not
 * delivered. The three rows asserted here are the ones that carried
 * `data-unwired` badges with「Host 无…读取 op」reasons before this slice.
 *
 * The stub answers with the shape main really produces (the same fields
 * `service-dependency-routing.ts` returns), so the assertions below pin the wire
 * shape and the wording, not a fixture that could drift from it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopToolDock } from "../components/DesktopToolDock";
import type { PidockBridge } from "../data/shellBridge";

const TASK_ID = "task-1a2b3c4d";
const PROJECT_ID = "project-1";
const ENVIRONMENT_ID = "e-11111111-1111-1111-1111-111111111111";
const CALLER = "s-11111111-1111-1111-1111-111111111111";
const CALLEE = "s-22222222-2222-2222-2222-222222222222";

/** The trusted read main answers with for a task bound to two services of ONE repo. */
function routingPayload(options: { declared: boolean; environment?: string }) {
  return {
    taskId: TASK_ID,
    units: [
      { unitId: `repo-a:${CALLER}`, serviceId: CALLER, name: "Caller API", repoDir: "repo-a", subdir: "caller",
        templateVersion: 1, environment: "开发环境", location: "local", declaredPorts: [9101] },
      { unitId: `repo-a:${CALLEE}`, serviceId: CALLEE, name: "Callee API", repoDir: "repo-a", subdir: "callee",
        templateVersion: 1, environment: "开发环境", location: "local", declaredPorts: [9102] },
    ],
    // ONE repository contributes TWO run units.
    repoGroups: [{ repoDir: "repo-a", unitIds: [`repo-a:${CALLER}`, `repo-a:${CALLEE}`] }],
    destinations: options.declared
      ? [
          { unitId: `repo-a:${CALLER}`, serviceId: CALLER, key: "CALLER_API_URL",
            target: { kind: "remote", environment: options.environment ?? "开发环境" },
            readPoints: [{ source: "共享模板", value: "https://shared.example/caller", masked: false }],
            reason: "没有服务依赖声明把「CALLER_API_URL」绑定到本任务的本地实例「Caller API」，消费者会继续使用共享环境地址" },
          { unitId: `repo-a:${CALLEE}`, serviceId: CALLEE, key: "CALLEE_API_URL",
            target: { kind: "local-instance", instanceId: `${TASK_ID}/${CALLEE}`, address: `${TASK_ID}/${CALLEE}@9102`, port: 9102 },
            value: "http://127.0.0.1:9102", readPoints: [{ source: "共享模板", masked: false }] },
        ]
      : [
          { unitId: `repo-a:${CALLER}`, serviceId: CALLER, key: "CALLER_API_URL",
            target: { kind: "remote", environment: options.environment ?? "开发环境" },
            readPoints: [{ source: "共享模板", value: "https://shared.example/caller", masked: false }],
            reason: "没有服务依赖声明把「CALLER_API_URL」绑定到本任务的本地实例「Caller API」，消费者会继续使用共享环境地址" },
          { unitId: `repo-a:${CALLEE}`, serviceId: CALLEE, key: "CALLEE_API_URL",
            target: { kind: "remote", environment: options.environment ?? "开发环境" },
            readPoints: [{ source: "共享模板", value: "https://shared.example/callee", masked: false }],
            reason: "没有服务依赖声明把「CALLEE_API_URL」绑定到本任务的本地实例「Callee API」，消费者会继续使用共享环境地址" },
        ],
    linkage: options.declared
      ? { state: "declared", edges: [{ from: `repo-a:${CALLER}`, to: `repo-a:${CALLEE}`, fromName: "Caller API", toName: "Callee API", kind: "call" }] }
      : { state: "no-declaration", edges: [] },
    diagnostics: options.declared
      ? []
      : [{
          code: "missing-binding",
          message: "共享模板读取「CALLEE_API_URL」，但本任务没有把该变量绑定到本地实例「Callee API」",
          hint: "请在运行面板把该变量绑定到当前任务的本地服务，否则消费者会继续使用共享环境地址",
        }],
  };
}

const BINDINGS = [
  { taskId: TASK_ID, serviceId: CALLER, environmentId: ENVIRONMENT_ID, environmentName: "开发环境", templateVersion: 1, rootId: "repo-a", subdir: "caller", privateKeys: [] },
  { taskId: TASK_ID, serviceId: CALLEE, environmentId: ENVIRONMENT_ID, environmentName: "开发环境", templateVersion: 1, rootId: "repo-a", subdir: "callee", privateKeys: [] },
];

const TEMPLATES = [
  { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID, serviceId: CALLER, version: 1, shared: [{ key: "PORT", value: "9101" }],
    descriptor: { name: "Caller API", program: "node", args: ["server.js"], ports: [9101], runType: "long-lived" } },
  { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID, serviceId: CALLEE, version: 1, shared: [{ key: "PORT", value: "9102" }],
    descriptor: { name: "Callee API", program: "node", args: ["server.js"], ports: [9102], runType: "long-lived" } },
];

function dock(options: { routing?: () => unknown; bindings?: unknown } = {}) {
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => {
    if (request["op"] === "taskDependencyRouting") {
      return options.routing ? options.routing() : { ok: true, payload: routingPayload({ declared: true }) };
    }
    if (request["op"] === "taskBindings") return { ok: true, payload: options.bindings ?? BINDINGS };
    if (request["op"] === "list") return { ok: true, payload: TEMPLATES.filter((row) => row.environmentId === request["environmentId"]) };
    return { ok: false, error: `unexpected serviceCatalogOp ${String(request["op"])}` };
  });
  const taskOp = vi.fn(async (_taskId: string, op: string, payload: Record<string, unknown>) => {
    if (op === "task/serviceStatus") return { ok: true, payload: { service: { serviceId: payload["serviceId"], lifecycle: "stopped", templateVersion: "1", health: "undeclared", launchSource: "catalog", resolved: [] } } };
    if (op === "task/serviceRunRecords") return { ok: true, payload: { records: [], registered: [] } };
    return { ok: false, error: `unexpected ${op}` };
  });
  const projectOp = vi.fn(async () => ({ ok: true, payload: { roots: [], tasks: [{ taskId: TASK_ID, projectId: PROJECT_ID, state: "assigned" }] } }));
  window.pidock = { taskOp, serviceCatalogOp, projectOp } as unknown as PidockBridge;
  return { taskOp, serviceCatalogOp, projectOp };
}

afterEach(() => { cleanup(); delete window.pidock; vi.restoreAllMocks(); });

describe("[PiDock 05] #10 box 1 运行面板 显示 本地/远程位置 与 实际依赖去向", () => {
  it("renders main's derived 位置, 依赖去向 and 远程依赖 in the shipped dock, with no stale 未接线 row", async () => {
    const wired = dock();
    render(<DesktopToolDock taskId={TASK_ID} tool="runtime" onClose={() => {}} />);

    // The read really travelled the production route, naming ONLY project + task.
    await waitFor(() => expect(wired.serviceCatalogOp).toHaveBeenCalledWith({ op: "taskDependencyRouting", projectId: PROJECT_ID, taskId: TASK_ID }));
    const request = wired.serviceCatalogOp.mock.calls.find(([entry]) => entry["op"] === "taskDependencyRouting")?.[0] as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(["op", "projectId", "taskId"]);

    const panel = screen.getByTestId("desktop-tool-dock");

    // 位置: 本机实例 for BOTH bound services, derived from the trusted read. The
    // label states the BINDING (this task owns the unit), never a runtime fact:
    // the read does not observe a process, so it must not claim 本任务运行.
    await waitFor(() => expect(within(panel).getByTestId(`dock-service-location-${CALLER}`)).toHaveTextContent("位置：本机实例 · 本任务自有（未启动不代表运行中）"));
    expect(within(panel).getByTestId(`dock-service-location-${CALLEE}`)).toHaveTextContent("位置：本机实例 · 本任务自有（未启动不代表运行中）");
    expect(within(panel).getByTestId(`dock-service-location-${CALLER}`)).not.toHaveTextContent("本任务运行");

    // 请求去向: the declared target is THIS task's instance address + port; the
    // variable no declaration binds keeps the shared environment address.
    const routing = within(panel).getByTestId("dock-routing");
    const boundRow = routing.querySelector(`[data-destination-key="CALLEE_API_URL"]`) as HTMLElement;
    expect(boundRow).toHaveAttribute("data-destination-kind", "local-instance");
    expect(boundRow).toHaveTextContent("本任务实例地址");
    expect(boundRow).toHaveTextContent("http://127.0.0.1:9102");
    expect(boundRow).toHaveTextContent(`${TASK_ID}/${CALLEE}@9102`);
    expect(boundRow).toHaveTextContent("端口 9102");
    const sharedRow = routing.querySelector(`[data-destination-key="CALLER_API_URL"]`) as HTMLElement;
    expect(sharedRow).toHaveAttribute("data-destination-kind", "remote");
    expect(sharedRow).toHaveTextContent("共享环境");
    expect(sharedRow).toHaveTextContent("开发环境");
    expect(sharedRow).toHaveTextContent("读取点：共享模板");
    expect(sharedRow).not.toHaveTextContent(`${TASK_ID}/${CALLER}@`);

    // 远程依赖: the shared-environment subset, named, and never an invented address.
    const remote = within(panel).getByTestId("dock-remote-deps");
    expect(remote.querySelector('[data-remote-key="CALLER_API_URL"]')).toHaveTextContent("共享环境 开发环境");
    expect(remote.querySelector('[data-remote-key="CALLER_API_URL"]')).not.toHaveTextContent("127.0.0.1");

    // 依赖边: DECLARED, and explicitly NOT 已互验 (only a group start verifies).
    const linkage = within(panel).getByTestId("dock-linkage");
    expect(linkage).toHaveAttribute("data-linkage-state", "declared");
    expect(linkage).toHaveTextContent("Caller API → Callee API（调用）· 已声明 · 未互验");
    expect(linkage).not.toHaveTextContent("已互验");

    // NO stale 「Host 无…读取 op」 row survives next to a working readout.
    for (const id of ["service-mode", "remote-deps", "routing"]) {
      expect(panel.querySelector(`[data-unwired="${id}"]`)).toBeNull();
    }
    // …while a control that really has no op keeps its named reason.
    expect(panel.querySelector('[data-unwired="runtime-config"]')).toHaveTextContent("未接线");
  });

  it("keeps 无依赖边（未做互验） as a NAMED state and never lights up 已互验", async () => {
    dock({ routing: () => ({ ok: true, payload: routingPayload({ declared: false }) }) });
    render(<DesktopToolDock taskId={TASK_ID} tool="runtime" onClose={() => {}} />);
    const panel = screen.getByTestId("desktop-tool-dock");

    const linkage = await within(panel).findByTestId("dock-linkage");
    expect(linkage).toHaveAttribute("data-linkage-state", "no-declaration");
    expect(within(panel).getByTestId("dock-linkage-none")).toHaveTextContent("无依赖边（未做互验）");
    // 已互验 appears NOWHERE in the edge list or its rows (only in the note that
    // explains who may claim it: a real group start's verify step).
    expect(linkage).not.toHaveTextContent("已互验");
    // With no declaration nothing is bound: every destination is the shared
    // environment, and no local instance address is invented anywhere.
    const routing = within(panel).getByTestId("dock-routing");
    expect(routing.querySelectorAll('[data-destination-kind="remote"]')).toHaveLength(2);
    expect(routing.querySelector('[data-destination-kind="local-instance"]')).toBeNull();
    expect(panel).not.toHaveTextContent(`@9102`);
    // The plan's own diagnostic explains WHY, verbatim.
    expect(within(panel).getByTestId("dock-routing-diagnostics")).toHaveTextContent("missing-binding");
    // The 远程依赖 list carries both shared rows (they ARE remote), and the named
    // note still states that no shared-resource list is being claimed.
    expect(within(panel).getByTestId("dock-remote-deps").querySelectorAll("[data-remote-key]")).toHaveLength(2);
    expect(within(panel).getByTestId("dock-remote-deps-note")).toHaveTextContent("共享外部资源在哪声明尚未决定");
  });

  it("never renders an all-clear when the plan failed closed: an empty 去向 list names the unhandled diagnostics", async () => {
    // One bound long-lived service whose PINNED revision declares no port makes
    // `resolveTaskBindings` fail closed, so the read returns NO destination at all
    // (a partial view is never sent) while the OTHER unit's unbound address
    // variable really keeps the shared environment value. An empty list therefore
    // must NOT be rendered as "no shared-environment variable".
    dock({ routing: () => ({ ok: true, payload: {
      taskId: TASK_ID,
      units: [
        { unitId: `repo-a:${CALLER}`, serviceId: CALLER, name: "Caller API", repoDir: "repo-a", subdir: "caller",
          templateVersion: 1, environment: "开发环境", location: "local", declaredPorts: [9101] },
        { unitId: `repo-a:${CALLEE}`, serviceId: CALLEE, name: "Callee API", repoDir: "repo-a", subdir: "callee",
          templateVersion: 1, environment: "开发环境", location: "local", declaredPorts: [] },
      ],
      repoGroups: [{ repoDir: "repo-a", unitIds: [`repo-a:${CALLER}`, `repo-a:${CALLEE}`] }],
      destinations: [],
      linkage: { state: "declared", edges: [{ from: `repo-a:${CALLER}`, to: `repo-a:${CALLEE}`, fromName: "Caller API", toName: "Callee API", kind: "call" }] },
      diagnostics: [{ code: "missing-port", message: "变量「CALLEE_API_URL」指向的本地服务「Callee API」还没有端口", hint: "请先完成端口分配" }],
    } }) });
    render(<DesktopToolDock taskId={TASK_ID} tool="runtime" onClose={() => {}} />);
    const panel = screen.getByTestId("desktop-tool-dock");

    const remoteDeps = await within(panel).findByTestId("dock-remote-deps");
    // The all-clear clause is GONE, and the named state says WHY it is withheld.
    expect(remoteDeps).not.toHaveTextContent("地址变量都指向本任务实例");
    const empty = within(panel).getByTestId("dock-remote-deps-empty");
    expect(empty).toHaveAttribute("data-remote-deps-state", "unconcluded");
    expect(empty).toHaveTextContent("依赖去向仍有未处理的诊断");
    // The 请求去向 empty state makes the same honest claim, never "no address
    // variable" - the list is empty because the plan could not resolve it.
    const routingEmpty = within(panel).getByTestId("dock-dependency-empty");
    expect(routingEmpty).toHaveAttribute("data-dependency-empty-state", "unconcluded");
    expect(routingEmpty).not.toHaveTextContent("没有可展示的地址变量");
    expect(within(panel).getByTestId("dock-routing-diagnostics")).toHaveTextContent("missing-port");
  });

  it("names an empty 去向 list as no bound service instead of an all-clear", async () => {
    // A real empty task: main stores no binding, so its read returns the empty
    // view (`units: []`) rather than a list of units it could not derive.
    dock({ bindings: [], routing: () => ({ ok: true, payload: {
      taskId: TASK_ID, units: [], repoGroups: [], destinations: [],
      linkage: { state: "no-declaration", edges: [] }, diagnostics: [],
    } }) });
    render(<DesktopToolDock taskId={TASK_ID} tool="runtime" onClose={() => {}} />);
    const panel = screen.getByTestId("desktop-tool-dock");

    const empty = await within(panel).findByTestId("dock-remote-deps-empty");
    expect(empty).toHaveAttribute("data-remote-deps-state", "no-service");
    expect(empty).toHaveTextContent("本任务还没有绑定服务");
    expect(within(panel).getByTestId("dock-remote-deps")).not.toHaveTextContent("地址变量都指向本任务实例");
    expect(within(panel).getByTestId("dock-dependency-empty")).toHaveAttribute("data-dependency-empty-state", "no-service");
  });

  it("shows main's named refusal for this read instead of an empty or optimistic 去向 list", async () => {
    const refusal = "服务依赖声明无法满足，未生成整组计划：「Caller API」（s-1111）声明的依赖目标 s-9999 未在本任务的服务绑定中，请先绑定该服务或从共享模板移除该声明";
    dock({ routing: () => ({ ok: false, error: refusal }) });
    render(<DesktopToolDock taskId={TASK_ID} tool="runtime" onClose={() => {}} />);
    const panel = screen.getByTestId("desktop-tool-dock");

    // The refusal reaches the three readouts BY NAME, and the service rows keep
    // their own facts instead of being hidden behind it.
    expect(await within(panel).findByTestId("dock-routing-error")).toHaveTextContent(refusal);
    expect(within(panel).getByTestId("dock-remote-deps-error")).toHaveTextContent(refusal);
    expect(within(panel).getByTestId("dock-linkage-error")).toHaveTextContent(refusal);
    expect(within(panel).getByTestId(`dock-service-location-${CALLER}`)).toHaveTextContent("位置未读取");
    expect(within(panel).getByTestId("dock-service-rows")).toHaveTextContent("Caller API");
    expect(panel.querySelector('[data-linkage-state]')).toBeNull();
  });
});
