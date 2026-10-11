import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceOwnerRebind } from "../components/ServiceOwnerRebind";

/**
 * [PiDock 04] (#7 slice) the desktop half of the way back from a fenced task:
 * the panel may only report what main observed, may only replace the owner
 * binding on the confirmed click, and must never claim a process restart.
 */
const projectId = "project-1";
const taskId = "task-1";
const serviceId = "s-b36323d3-ff33-4e34-a873-536a9775788a";

const view = (over: Record<string, unknown> = {}) => ({ taskId, projectId, state: "fenced", confirmed: false, rebound: false,
  changes: [{ serviceId, name: "API", was: 1, now: 2 }], stopsProcesses: false, restartsProcesses: false, ...over });

const bridge = (...results: { ok: boolean; payload?: unknown; error?: string }[]) => {
  const serviceCatalogOp = vi.fn(async () => results.shift() ?? { ok: false, error: "unexpected call" });
  window.pidock = { serviceCatalogOp } as unknown as typeof window.pidock;
  return serviceCatalogOp;
};

afterEach(() => {
  cleanup();
  delete (window as { pidock?: unknown }).pidock;
});

describe("[PiDock 04] (#7) explicit service-owner re-bind panel", () => {
  it("reports the observed state and the named change first, then replaces only on the confirmed click", async () => {
    const serviceCatalogOp = bridge({ ok: true, payload: view() }, { ok: true, payload: view({ state: "current", confirmed: true, rebound: true }) });
    render(<ServiceOwnerRebind projectId={projectId} taskId={taskId} surfacedBy="service-execution-uncertain: service-owner-inventory-unconfirmed" />);
    // The refusal that surfaced this control is shown verbatim, with no claim.
    expect(screen.getByRole("status")).toHaveTextContent("service-owner-inventory-unconfirmed");
    fireEvent.click(screen.getByRole("button", { name: "核对重新绑定" }));
    expect(await screen.findByText(/待重新绑定/)).toBeInTheDocument();
    expect(screen.getByText(/本次重新绑定影响 API：绑定 v1 → v2/)).toBeInTheDocument();
    expect(screen.getByText(/重新绑定不停止、不重启任何进程/)).toBeInTheDocument();
    expect(serviceCatalogOp).toHaveBeenCalledTimes(1);
    expect(serviceCatalogOp).toHaveBeenCalledWith({ op: "rebindServiceOwner", projectId, taskId, confirm: false });
    // Nothing was replaced yet: the confirm button is the only writer.
    expect(screen.queryByText(/已重新绑定该任务的服务所有者/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "确认重新绑定" }));
    expect(await screen.findByText(/已重新绑定该任务的服务所有者/)).toBeInTheDocument();
    expect(screen.getByText(/本次没有启动、停止或重启任何进程/)).toBeInTheDocument();
    expect(serviceCatalogOp).toHaveBeenLastCalledWith({ op: "rebindServiceOwner", projectId, taskId, confirm: true });
  });

  it("writes nothing on cancel and nothing on a review that is already current", async () => {
    const serviceCatalogOp = bridge({ ok: true, payload: view({ state: "current" }) });
    render(<ServiceOwnerRebind projectId={projectId} taskId={taskId} />);
    fireEvent.click(screen.getByRole("button", { name: "核对重新绑定" }));
    expect(await screen.findByText(/当前无需重新绑定/)).toBeInTheDocument();
    // A task whose owner binding is already current gets no replace button at all.
    expect(screen.queryByRole("button", { name: "确认重新绑定" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(serviceCatalogOp).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/当前无需重新绑定/)).toBeNull();
  });

  it("shows a named refusal verbatim and stays on the review instead of pretending control is back", async () => {
    const serviceCatalogOp = bridge({ ok: true, payload: view() }, { ok: false, error: `service-owner-rebind-blocked: ${serviceId}` });
    render(<ServiceOwnerRebind projectId={projectId} taskId={taskId} />);
    fireEvent.click(screen.getByRole("button", { name: "核对重新绑定" }));
    await screen.findByText(/待重新绑定/);
    fireEvent.click(screen.getByRole("button", { name: "确认重新绑定" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(`service-owner-rebind-blocked: ${serviceId}`);
    expect(screen.queryByText(/已重新绑定该任务的服务所有者/)).toBeNull();
    // The previous state stays diagnosable and the replacement can be retried.
    expect(screen.getByRole("button", { name: "确认重新绑定" })).toBeInTheDocument();
    expect(serviceCatalogOp).toHaveBeenCalledTimes(2);
  });

  it("does not read a confirmed request that replaced nothing as a recovered channel", async () => {
    bridge({ ok: true, payload: view() }, { ok: true, payload: view({ state: "fenced", confirmed: true, rebound: false }) });
    render(<ServiceOwnerRebind projectId={projectId} taskId={taskId} />);
    fireEvent.click(screen.getByRole("button", { name: "核对重新绑定" }));
    await screen.findByText(/待重新绑定/);
    fireEvent.click(screen.getByRole("button", { name: "确认重新绑定" }));
    expect(await screen.findByText(/主进程未做替换/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认重新绑定" })).toBeNull();
  });

  it("refuses a receipt that claims a process restart or a foreign identity", async () => {
    for (const payload of [{ ...view(), restartsProcesses: true }, { ...view(), taskId: "task-2" }, { ...view(), confirmed: true, rebound: true, restartsProcesses: true },
      { ...view(), changes: [{ serviceId, name: "API", was: 2, now: 2 }] }]) {
      cleanup();
      bridge({ ok: true, payload });
      render(<ServiceOwnerRebind projectId={projectId} taskId={taskId} />);
      fireEvent.click(screen.getByRole("button", { name: "核对重新绑定" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("重新绑定回执无法核对，请刷新核对");
    }
  });
});
