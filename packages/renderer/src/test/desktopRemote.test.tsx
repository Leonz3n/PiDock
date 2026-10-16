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

it("names every blank Host string it renders instead of a blank heading or row", async () => {
  // `remoteStateFromHost` reads `label`, `hint` and a device's `name` by value
  // (`typeof === "string"`), so all three can be `""`; without a named absence
  // the page loses the entry's own heading and the device's own row identity.
  window.pidock = { taskOp: vi.fn(async () => ({ ok: true, payload: {
    ...payload(),
    entry: { ...payload().entry, label: "", hint: "" },
    devices: [{ ...payload().devices[0], name: "" }],
  } })) as never };
  render(<DesktopRemotePage tasks={tasks.slice(0, 1)} lifecyclePending={false} lifecycleErrors={[]} />);
  expect(await screen.findByText("Host 未上报入口名称")).toBeInTheDocument();
  expect(screen.getByText("Host 未上报该入口的说明")).toBeInTheDocument();
  expect(screen.getByText("Host 未上报设备名称")).toBeInTheDocument();
  // The refused direction is unchanged: a real value still renders as itself.
  expect(remoteStateFromHost(payload())?.label).toBe("自建 Gateway");
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

it("confirms an entry mode with its named reachability consequence, then displays and refreshes Host state", async () => {
  let current = payload("gateway");
  let reads = 0;
  const taskOp = vi.fn(async (_taskId: string, op: string, input: Record<string, unknown> = {}) => {
    if (op === "task/remoteState") { reads++; return { ok: true, payload: current }; }
    if (op === "task/remoteEntryMode") {
      current = payload(input["mode"] as "gateway" | "tailscale");
      current.entry.label = "Host 返回的 Tailscale 状态";
      return { ok: true, payload: current };
    }
    throw new Error(`unexpected op ${op}`);
  });
  window.pidock = { taskOp: taskOp as never };
  const confirmation = vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<DesktopRemotePage tasks={tasks.slice(0, 1)} lifecyclePending={false} lifecycleErrors={[]} />);

  await screen.findByText("真实手机");
  fireEvent.click(screen.getByRole("button", { name: "切换到 Tailscale 私有访问" }));
  expect(confirmation).toHaveBeenCalledTimes(1);
  expect(confirmation.mock.calls[0]?.[0]).toContain("Tailscale 私有访问");
  expect(confirmation.mock.calls[0]?.[0]).toContain("切换后旧连接断开");
  await waitFor(() => expect(taskOp).toHaveBeenCalledWith("task-a", "task/remoteEntryMode", { label: "远程访问页", mode: "tailscale" }));
  expect(await screen.findByRole("heading", { name: "Host 返回的 Tailscale 状态" })).toBeInTheDocument();
  await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2));
});

it("does not call the entry-mode op when its confirmation is cancelled", async () => {
  const taskOp = vi.fn(async (_taskId: string, _op: string, _input?: Record<string, unknown>) => ({ ok: true, payload: payload() }));
  window.pidock = { taskOp: taskOp as never };
  vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<DesktopRemotePage tasks={tasks.slice(0, 1)} lifecyclePending={false} lifecycleErrors={[]} />);
  await screen.findByText("真实手机");

  fireEvent.click(screen.getByRole("button", { name: "切换到 Funnel" }));
  expect(taskOp.mock.calls.some((call) => call[1] === "task/remoteEntryMode")).toBe(false);
});

it("refreshes the device list after a successful Host revocation", async () => {
  let devices = [payload().devices[0]];
  let reads = 0;
  const taskOp = vi.fn(async (_taskId: string, op: string) => {
    if (op === "task/remoteState") { reads++; return { ok: true, payload: { ...payload(), devices } }; }
    if (op === "task/remoteDeviceRevoke") { devices = [{ ...devices[0]!, status: "revoked", permissions: [], online: false }]; return { ok: true, payload: { device: { deviceId: "device-1" } } }; }
    throw new Error(`unexpected op ${op}`);
  });
  window.pidock = { taskOp: taskOp as never };
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<DesktopRemotePage tasks={tasks.slice(0, 1)} lifecyclePending={false} lifecycleErrors={[]} />);

  await screen.findByText("真实手机");
  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  await waitFor(() => expect(taskOp).toHaveBeenCalledWith("task-a", "task/remoteDeviceRevoke", { label: "远程访问页", deviceId: "device-1" }));
  expect(await screen.findByText("已撤销")).toBeInTheDocument();
  await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2));
  expect(screen.getByText("真实手机")).toBeInTheDocument();
});

it("names the device and its consequence in the revoke confirmation", async () => {
  const taskOp = vi.fn(async (_taskId: string, op: string) => op === "task/remoteState"
    ? { ok: true, payload: payload() }
    : { ok: true, payload: { device: { deviceId: "device-1" } } });
  window.pidock = { taskOp: taskOp as never };
  const confirmation = vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<DesktopRemotePage tasks={tasks.slice(0, 1)} lifecyclePending={false} lifecycleErrors={[]} />);
  await screen.findByText("真实手机");

  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  expect(confirmation.mock.calls[0]?.[0]).toContain("真实手机");
  expect(confirmation.mock.calls[0]?.[0]).toContain("device-1");
  expect(confirmation.mock.calls[0]?.[0]).toContain("现有连接与后续请求均失效");
  await waitFor(() => expect(taskOp).toHaveBeenCalledWith("task-a", "task/remoteDeviceRevoke", { label: "远程访问页", deviceId: "device-1" }));
});

it("does not call the device-revoke op when its confirmation is cancelled", async () => {
  const taskOp = vi.fn(async (_taskId: string, _op: string, _input?: Record<string, unknown>) => ({ ok: true, payload: payload() }));
  window.pidock = { taskOp: taskOp as never };
  vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<DesktopRemotePage tasks={tasks.slice(0, 1)} lifecyclePending={false} lifecycleErrors={[]} />);
  await screen.findByText("真实手机");

  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  expect(taskOp.mock.calls.some((call) => call[1] === "task/remoteDeviceRevoke")).toBe(false);
});

it("renders Host revocation refusal verbatim without claiming success", async () => {
  const refusal = "permission-denied: 设备管理只允许桌面显式操作";
  const taskOp = vi.fn(async (_taskId: string, op: string) => op === "task/remoteState"
    ? { ok: true, payload: payload() }
    : { ok: false, error: refusal });
  window.pidock = { taskOp: taskOp as never };
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<DesktopRemotePage tasks={tasks.slice(0, 1)} lifecyclePending={false} lifecycleErrors={[]} />);
  await screen.findByText("真实手机");

  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(refusal);
  expect(screen.queryByText(/撤销成功/)).toBeNull();
  expect(taskOp.mock.calls.some((call) => call[1] === "task/remoteState")).toBe(true);
});

it("keeps pairing, authorization, credential rotation and audit explicitly marked as unwired", async () => {
  window.pidock = { taskOp: vi.fn(async () => ({ ok: true, payload: payload() })) as never };
  render(<DesktopRemotePage tasks={tasks.slice(0, 1)} lifecyclePending={false} lifecycleErrors={[]} />);

  await screen.findByText("真实手机");
  expect(screen.getByRole("button", { name: "扫码添加" })).toBeDisabled();
  expect(screen.getByText(/配对尚未接线/)).toBeInTheDocument();
  expect(screen.getByTestId("desktop-remote-page")).toHaveTextContent("授权、凭据轮换与审计尚未接线");
});
