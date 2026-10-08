import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { DesktopProvidersPage } from "../components/DesktopProvidersPage";

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

const page = (taskId: string | null = "task-1") =>
  render(<DesktopProvidersPage taskId={taskId} taskName={taskId === null ? null : "对账单详情"} onOpenTask={vi.fn()} availableTasks={[{ taskId: "task-1", name: "对账单详情" }]} />);

it("shows the live state and never renders a secret or a secret input", async () => {
  const { calls } = bridge(async () => ({ state: "not-configured", profileId: null, generation: null, profiles: [] }));
  const { container } = page();
  await waitFor(() => expect(screen.getByTestId("providers-state")).toHaveTextContent("未配置"));
  expect(calls[0]).toEqual({ taskId: "task-1", op: "list" });
  await userEvent.click(screen.getByRole("button", { name: "添加 Provider" }));
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
  page();
  await waitFor(() => expect(screen.getByTestId("providers-state")).toHaveTextContent("未配置"));
  await userEvent.click(screen.getByRole("button", { name: "添加 Provider" }));
  await userEvent.type(screen.getByLabelText(/名称/), "Local gateway");
  await userEvent.type(screen.getByLabelText(/接口地址/), "https://models.example.test/v1");
  await userEvent.type(screen.getByLabelText(/^模型/), "gpt-5-mini");
  await userEvent.clear(screen.getByLabelText(/凭据引用名/));
  await userEvent.type(screen.getByLabelText(/凭据引用名/), "PIDOCK_PROVIDER_EXAMPLE");
  await userEvent.click(screen.getByRole("button", { name: "保存并选用" }));
  await waitFor(() => expect(screen.getByTestId("providers-state")).toHaveTextContent("已配置"));
  expect(order).toEqual(["list", "save", "select"]);
  expect(calls[1]).toMatchObject({ op: "save", profile: { name: "Local gateway", baseUrl: "https://models.example.test/v1", modelId: "gpt-5-mini", contextWindow: 128000, maxTokens: 8192, authRef: "PIDOCK_PROVIDER_EXAMPLE" } });
  expect(calls[2]).toEqual({ taskId: "task-1", op: "select", profileId: profile.id });
  // Nothing the renderer sent can carry a credential value.
  expect(JSON.stringify(calls)).not.toContain(SECRET);
});

it("renders the saved profile as a card with the real reference state", async () => {
  bridge(async () => ({ state: "configured", profileId: profile.id, generation: 1, profiles: [profile] }));
  page();
  const card = await screen.findByText("Local gateway");
  expect(card).toBeInTheDocument();
  expect(screen.getByText("当前任务已选用")).toBeInTheDocument();
  expect(screen.getByText("openai-chat-completions")).toBeInTheDocument();
  expect(screen.getByText("gpt-5-mini")).toBeInTheDocument();
  expect(screen.getByText(/PIDOCK_PROVIDER_EXAMPLE/)).toBeInTheDocument();
  // The page never claims a global switch: selection belongs to this task.
  expect(screen.getByText("切换只影响当前会话")).toBeInTheDocument();
});

it("reports a missing credential and a refused install instead of claiming success", async () => {
  bridge(async (request) => request.op === "list"
    ? { state: "credential-missing", profileId: profile.id, generation: 1, profiles: [{ ...profile, credentialAvailable: false }] }
    : { state: "install-failed", profileId: null, generation: null, profiles: [{ ...profile, credentialAvailable: false }] });
  page();
  await waitFor(() => expect(screen.getByTestId("providers-state")).toHaveTextContent("凭据缺失"));
  expect(screen.getByText(/该环境变量没有取值/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "选择模型" }));
  await waitFor(() => expect(screen.getByTestId("providers-state")).toHaveTextContent("安装失败"));
  // A failed install never leaves a stale selection claim behind.
  expect(screen.queryByRole("button", { name: "解除当前任务的选用" })).toBeNull();
});

it("keeps the binding-stale warning in the Host's own words", async () => {
  bridge(async () => ({ state: "binding-stale", profileId: profile.id, generation: 2, profiles: [profile] }));
  page();
  await waitFor(() => expect(screen.getByTestId("providers-state")).toHaveTextContent("会话绑定失效"));
  expect(screen.getByTestId("providers-state")).toHaveTextContent("重新选用同一份配置也无法恢复");
});

it("discloses that value rotation behind the same reference name is not detected", async () => {
  bridge(async () => ({ state: "configured", profileId: profile.id, generation: 1, profiles: [profile] }));
  page();
  await waitFor(() => expect(screen.getByTestId("providers-state")).toHaveTextContent("已配置"));
  // #46: the digest pins the reference *name*, so a rotated value behind the
  // same name is undetectable and does not change endpoint or generation. The
  // limitation must be stated in the UI, not only in delivery records.
  expect(screen.getByText(/取值轮换[^。]*不[^。]*检测/)).toBeInTheDocument();
  expect(screen.getByText(/不改变[^。]*(端点|配置代际)/)).toBeInTheDocument();
});

it("refuses a malformed status payload rather than showing an unverified state", async () => {
  bridge(async () => ({ state: "configured", profileId: "PIDOCK_PROVIDER_EXAMPLE", generation: 1, profiles: [{ ...profile, id: "not-a-profile-id", credential: SECRET }] }));
  page();
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("异常"));
  expect(document.body.textContent).not.toContain("已配置");
  expect(document.body.textContent).not.toContain(SECRET);
});

it("surfaces a failure to clear instead of reporting the previous state", async () => {
  bridge(async (request) => request.op === "clear"
    ? Promise.reject(new Error("Provider 配置操作失败，请检查本机凭据环境后重试"))
    : { state: "configured", profileId: profile.id, generation: 1, profiles: [profile] });
  page();
  await waitFor(() => expect(screen.getByTestId("providers-state")).toHaveTextContent("已配置"));
  await userEvent.click(screen.getByRole("button", { name: "解除当前任务的选用" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("凭据环境"));
});

it("keeps the page usable when the bridge is unavailable", async () => {
  (window as unknown as { pidock?: unknown }).pidock = {};
  page();
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Provider 接口不可用"));
});

it("without a task it asks for one instead of inventing an enabled state", async () => {
  const { providerOp } = bridge(async () => ({ state: "configured", profileId: profile.id, generation: 1, profiles: [profile] }));
  const onOpenTask = vi.fn();
  render(<DesktopProvidersPage taskId={null} taskName={null} onOpenTask={onOpenTask} availableTasks={[{ taskId: "task-1", name: "对账单详情" }]} />);
  expect(screen.getByTestId("providers-task-required")).toHaveTextContent("请先打开一个任务");
  expect(providerOp).not.toHaveBeenCalled();
  expect(screen.queryByTestId("providers-state")).toBeNull();
  expect(screen.queryByText("当前任务已选用")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "对账单详情" }));
  expect(onOpenTask).toHaveBeenCalledWith("task-1");
});
