import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { DesktopProviderPanel } from "../components/DesktopProviderPanel";

const SECRET = "sk-live-0123456789-abcdefghijklmnop";
const profile = {
  id: "p-11111111-2222-3333-4444-555555555555",
  name: "Local gateway",
  baseUrl: "https://models.example.test/v1",
  modelId: "gpt-5-mini",
  contextWindow: 128000,
  maxTokens: 8192,
  authRef: "PIDOCK_PROVIDER_EXAMPLE",
  generation: 1,
  credentialAvailable: true,
};

function bridge(handler: (request: Record<string, unknown>) => Promise<unknown>) {
  const calls: Record<string, unknown>[] = [];
  const providerOp = vi.fn(async (request: Record<string, unknown>) => {
    calls.push(request);
    try { return { ok: true, payload: await handler(request) }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : "failed" }; }
  });
  (window as unknown as { pidock?: unknown }).pidock = { providerOp };
  return { calls, providerOp };
}

it("shows the live state and never renders a secret or a secret input", async () => {
  const { calls } = bridge(async () => ({ state: "not-configured", profileId: null, generation: null, profiles: [] }));
  const { container } = render(<DesktopProviderPanel taskId="task-1" />);
  await waitFor(() => expect(screen.getByTestId("provider-state")).toHaveTextContent("未配置"));
  expect(calls[0]).toEqual({ taskId: "task-1", op: "list" });
  await userEvent.click(screen.getByRole("button", { name: "配置" }));
  // There is no credential field: only a reference name.
  expect(container.querySelectorAll("input[type=password]")).toHaveLength(0);
  expect(screen.getByLabelText(/凭据引用名/)).toHaveValue("PIDOCK_PROVIDER_");
  expect(container.textContent).not.toContain(SECRET);
});

it("saves metadata, then selects the saved profile in that order", async () => {
  const order: string[] = [];
  const { calls } = bridge(async (request) => {
    order.push(String(request.op));
    if (request.op === "save") return { profile, status: { state: "not-configured", profileId: null, generation: null, profiles: [profile] } };
    if (request.op === "select") return { state: "configured", profileId: profile.id, generation: 1, profiles: [profile] };
    return { state: "not-configured", profileId: null, generation: null, profiles: [profile] };
  });
  render(<DesktopProviderPanel taskId="task-1" />);
  await waitFor(() => expect(screen.getByTestId("provider-state")).toHaveTextContent("未配置"));
  await userEvent.click(screen.getByRole("button", { name: "配置" }));
  await userEvent.type(screen.getByLabelText(/名称/), "Local gateway");
  await userEvent.type(screen.getByLabelText(/接口地址/), "https://models.example.test/v1");
  await userEvent.type(screen.getByLabelText(/^模型/), "gpt-5-mini");
  await userEvent.clear(screen.getByLabelText(/凭据引用名/));
  await userEvent.type(screen.getByLabelText(/凭据引用名/), "PIDOCK_PROVIDER_EXAMPLE");
  await userEvent.click(screen.getByRole("button", { name: "保存并选用" }));
  await waitFor(() => expect(screen.getByTestId("provider-state")).toHaveTextContent("已配置"));
  expect(order).toEqual(["list", "save", "select"]);
  expect(calls[1]).toMatchObject({ op: "save", profile: { name: "Local gateway", baseUrl: "https://models.example.test/v1", modelId: "gpt-5-mini", contextWindow: 128000, maxTokens: 8192, authRef: "PIDOCK_PROVIDER_EXAMPLE" } });
  expect(calls[2]).toEqual({ taskId: "task-1", op: "select", profileId: profile.id });
  // Nothing the renderer sent can carry a credential value.
  expect(JSON.stringify(calls)).not.toContain(SECRET);
});

it("reports a missing credential and a refused install instead of claiming success", async () => {
  bridge(async (request) => request.op === "list"
    ? { state: "credential-missing", profileId: profile.id, generation: 1, profiles: [{ ...profile, credentialAvailable: false }] }
    : { state: "install-failed", profileId: null, generation: null, profiles: [{ ...profile, credentialAvailable: false }] });
  render(<DesktopProviderPanel taskId="task-1" />);
  await waitFor(() => expect(screen.getByTestId("provider-state")).toHaveTextContent("凭据缺失"));
  expect(screen.getByText(/凭据缺失/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "配置" }));
  await userEvent.click(screen.getByRole("button", { name: "选用" }));
  await waitFor(() => expect(screen.getByTestId("provider-state")).toHaveTextContent("安装失败"));
  // A failed install never leaves a stale credential/selection claim behind.
  expect(screen.queryByRole("button", { name: "解除" })).toBeNull();
});

it("refuses a malformed status payload rather than showing an unverified state", async () => {
  bridge(async () => ({ state: "configured", profileId: "PIDOCK_PROVIDER_EXAMPLE", generation: 1, profiles: [{ ...profile, id: "not-a-profile-id", credential: SECRET }] }));
  render(<DesktopProviderPanel taskId="task-1" />);
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("异常"));
  expect(screen.queryByTestId("provider-state")?.textContent).not.toContain("已配置");
  expect(document.body.textContent).not.toContain(SECRET);
});

it("surfaces a failure to clear instead of reporting the previous state", async () => {
  bridge(async (request) => request.op === "clear"
    ? Promise.reject(new Error("Provider 配置操作失败，请检查本机凭据环境后重试"))
    : { state: "configured", profileId: profile.id, generation: 1, profiles: [profile] });
  render(<DesktopProviderPanel taskId="task-1" />);
  await waitFor(() => expect(screen.getByTestId("provider-state")).toHaveTextContent("已配置"));
  await userEvent.click(screen.getByRole("button", { name: "解除" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("凭据环境"));
});

it("keeps the panel usable when the bridge is unavailable", async () => {
  (window as unknown as { pidock?: unknown }).pidock = {};
  render(<DesktopProviderPanel taskId="task-1" />);
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Provider 接口不可用"));
});
