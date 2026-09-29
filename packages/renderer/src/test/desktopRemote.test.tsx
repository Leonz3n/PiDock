import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopRemotePage } from "../components/DesktopRemotePage";
import { remoteStateFromHost } from "../data/desktopRemote";

const payload = (mode: "gateway" | "tailscale" = "gateway") => ({
  entry: { mode, label: mode === "gateway" ? "自建 Gateway" : "Tailscale 私有访问", hint: "任务入口", baseUrl: "https://private.example", warning: "请核验网络边界" },
  gateway: { entryMode: mode, status: "offline", endpoint: "wss://gateway.example", hostId: "host-a" },
  devices: [{ deviceId: "device-1", name: "真实手机", status: "pending-confirmation", permissions: ["overview"], online: false, credential: { credentialId: "secret-metadata" } }],
});
const tasks = [{ taskId: "task-a", name: "任务 A" }, { taskId: "task-b", name: "任务 B" }];
afterEach(() => { cleanup(); delete window.pidock; });

it("whitelists only readable fields and refuses malformed or inconsistent Host state", () => {
  const state = remoteStateFromHost(payload());
  expect(state?.devices[0]).toEqual({ id: "device-1", name: "真实手机", status: "pending-confirmation", permissions: ["overview"], online: false });
  expect(JSON.stringify(state)).not.toContain("secret-metadata");
  expect(remoteStateFromHost({ ...payload(), devices: [{ ...payload().devices[0], online: "false" }] })).toBeNull();
  expect(remoteStateFromHost({ ...payload(), gateway: { ...payload().gateway, entryMode: "funnel" } })).toBeNull();
});

it("reads the selected task only; switching tasks does not display stale access state", async () => {
  let answerB: ((value: unknown) => void) | undefined;
  const taskOp = vi.fn((taskId: string, op: string) => {
    expect(op).toBe("task/remoteState");
    if (taskId === "task-b") return new Promise((resolve) => { answerB = resolve; });
    return Promise.resolve({ ok: true, payload: payload() });
  });
  window.pidock = { taskOp: taskOp as never };
  render(<DesktopRemotePage tasks={tasks} lifecyclePending={false} lifecycleErrors={[]} />);
  expect(await screen.findByText("真实手机")).toBeInTheDocument();
  expect(screen.getByText("待本机确认")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "扫码添加" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("任务"), { target: { value: "task-b" } });
  expect(screen.queryByText("真实手机")).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("正在读取任务远程状态");
  answerB?.({ ok: true, payload: { ...payload("tailscale"), devices: [] } });
  expect(await screen.findByText("该任务尚无已登记设备。")).toBeInTheDocument();
  expect(screen.getByText(/Gateway 状态不代表 Tailscale/)).toBeInTheDocument();
  expect(taskOp).toHaveBeenCalledWith("task-b", "task/remoteState", {});
});

it("does not turn refused reads into offline or no-device claims", async () => {
  window.pidock = { taskOp: vi.fn(async () => ({ ok: false, error: "remote-unavailable" })) as never };
  render(<DesktopRemotePage tasks={tasks.slice(0, 1)} lifecyclePending={false} lifecycleErrors={["未知归档任务"]} />);
  await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
  expect(screen.getByText("remote-unavailable")).toBeInTheDocument();
  expect(screen.queryByText("该任务尚无已登记设备。")).toBeNull();
});

it("waits for lifecycle verification before reading a task", () => {
  const taskOp = vi.fn();
  window.pidock = { taskOp: taskOp as never };
  render(<DesktopRemotePage tasks={tasks} lifecyclePending lifecycleErrors={[]} />);
  expect(screen.getByRole("status")).toHaveTextContent("正在核验任务");
  expect(taskOp).not.toHaveBeenCalled();
});
