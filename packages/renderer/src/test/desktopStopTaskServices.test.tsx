/** Task-level stop controls must reuse the real task-bound service stop path. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopToolDock } from "../components/DesktopToolDock";

const FIRST_ID = "s-11111111-1111-1111-1111-111111111111";
const SECOND_ID = "s-22222222-2222-2222-2222-222222222222";
const ENVIRONMENT_ID = "e-11111111-1111-1111-1111-111111111111";

function stopBridge(options: { failSecond?: boolean; stoppedSecond?: boolean } = {}) {
  const taskOp = vi.fn(async (_taskId: string, op: string, payload?: Record<string, unknown>) => {
    if (op === "task/serviceRunRecords") return { ok: true, payload: { records: [], registered: [] } };
    if (op === "task/serviceStatus") return { ok: true, payload: { service: {
      serviceId: payload?.["serviceId"], lifecycle: options.stoppedSecond && payload?.["serviceId"] === SECOND_ID ? "stopped" : "running", templateVersion: "2", launchSource: "catalog", resolved: [],
      health: "not-probed",
    } } };
    return { ok: false, error: `unexpected ${op}` };
  });
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => {
    if (request["op"] === "taskBindings") return { ok: true, payload: [
      { taskId: "task-1", serviceId: FIRST_ID, environmentId: ENVIRONMENT_ID, environmentName: "本地开发", templateVersion: 2, rootId: "repo", subdir: "", privateKeys: [] },
      { taskId: "task-1", serviceId: SECOND_ID, environmentId: ENVIRONMENT_ID, environmentName: "本地开发", templateVersion: 2, rootId: "repo", subdir: "", privateKeys: [] },
    ] };
    if (request["op"] === "list") return { ok: true, payload: [
      { projectId: "project-1", environmentId: ENVIRONMENT_ID, serviceId: FIRST_ID, version: 2, shared: [],
        descriptor: { name: "订单 API", program: "node", args: ["api.js"], ports: [4100], runType: "long-lived" } },
      { projectId: "project-1", environmentId: ENVIRONMENT_ID, serviceId: SECOND_ID, version: 2, shared: [],
        descriptor: { name: "订单 Web", program: "node", args: ["web.js"], ports: [4101], runType: "long-lived" } },
    ] };
    if (request["op"] === "taskDependencyRouting") return { ok: true, payload: {
      taskId: "task-1", units: [], repoGroups: [], destinations: [], linkage: { state: "no-declaration", edges: [] }, diagnostics: [],
    } };
    if (request["op"] === "runTaskService") {
      if (options.stoppedSecond && request["serviceId"] === SECOND_ID) return { ok: false, error: "not-running: 订单 Web 的进程树不存在" };
      if (options.failSecond && request["serviceId"] === SECOND_ID) return { ok: false, error: "termination-unconfirmed: 订单 Web 的进程组仍有存活成员" };
      return { ok: true, payload: { serviceId: request["serviceId"], action: "stop" } };
    }
    return { ok: false, error: `unexpected serviceCatalogOp ${String(request["op"])}` };
  });
  const projectOp = vi.fn(async () => ({ ok: true, payload: { roots: [], tasks: [{ taskId: "task-1", projectId: "project-1", state: "assigned" }] } }));
  window.pidock = { taskOp, serviceCatalogOp, projectOp };
  return { taskOp, serviceCatalogOp, projectOp };
}

async function renderRuntime() {
  render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
  await screen.findByText("本任务服务 · 2");
}

afterEach(() => {
  cleanup();
  delete window.pidock;
  vi.restoreAllMocks();
});

describe("任务级停止本任务全部服务", () => {
  it("provides a task-level stop entry in the runtime panel", async () => {
    stopBridge();
    await renderRuntime();
    expect(screen.getByRole("button", { name: "停止本任务全部服务" })).toBeInTheDocument();
  });

  it("calls the real task-bound stop operation once per registered service identity", async () => {
    const fixture = stopBridge();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderRuntime();
    fireEvent.click(screen.getByRole("button", { name: "停止本任务全部服务" }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining(`影响范围：本任务的 订单 API（${FIRST_ID}）、订单 Web（${SECOND_ID}）`));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("不影响：另一任务的服务、外部服务"));
    await waitFor(() => expect(fixture.serviceCatalogOp.mock.calls.filter(([request]) => request["op"] === "runTaskService")).toHaveLength(2));
    expect(fixture.serviceCatalogOp.mock.calls.filter(([request]) => request["op"] === "runTaskService").map(([request]) => request)).toEqual([
      { op: "runTaskService", projectId: "project-1", taskId: "task-1", serviceId: FIRST_ID, action: "stop" },
      { op: "runTaskService", projectId: "project-1", taskId: "task-1", serviceId: SECOND_ID, action: "stop" },
    ]);
  });

  it("shows the failed service receipt instead of reporting all services stopped", async () => {
    const fixture = stopBridge({ failSecond: true });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderRuntime();
    fireEvent.click(screen.getByRole("button", { name: "停止本任务全部服务" }));
    const receipt = await screen.findByTestId("dock-stop-all-receipt");
    expect(receipt).toHaveTextContent("订单 API");
    expect(receipt).toHaveTextContent("已停止");
    expect(receipt).toHaveTextContent("订单 Web");
    expect(receipt).toHaveTextContent("termination-unconfirmed: 订单 Web 的进程组仍有存活成员");
    expect(receipt).not.toHaveTextContent("已全部停止");
    expect(fixture.serviceCatalogOp.mock.calls.filter(([request]) => request["op"] === "runTaskService")).toHaveLength(2);
    await screen.findByText("本任务服务 · 2");
    expect(screen.getByTestId("dock-stop-all-receipt")).toHaveTextContent("termination-unconfirmed");
  });

  it("does not report a service that was not running as a stop failure", async () => {
    stopBridge({ stoppedSecond: true });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderRuntime();
    fireEvent.click(screen.getByRole("button", { name: "停止本任务全部服务" }));
    const receipt = await screen.findByTestId("dock-stop-all-receipt");
    // The Host still received the stop attempt (a stale lifecycle must not skip
    // a live process tree), but a refused "there was nothing to stop" is not a
    // failure and must not be counted as one.
    expect(receipt).toHaveTextContent("订单 API");
    expect(receipt).toHaveTextContent("订单 Web");
    expect(receipt).toHaveTextContent("原本未在运行");
    expect(receipt).not.toHaveTextContent("部分停止未完成");
    expect(receipt).not.toHaveTextContent("停止失败：not-running");
  });

  it("does not issue any stop request when the user cancels confirmation", async () => {
    const fixture = stopBridge();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderRuntime();
    fireEvent.click(screen.getByRole("button", { name: "停止本任务全部服务" }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("不影响：另一任务的服务、外部服务"));
    expect(fixture.serviceCatalogOp.mock.calls.filter(([request]) => request["op"] === "runTaskService")).toHaveLength(0);
  });
});
