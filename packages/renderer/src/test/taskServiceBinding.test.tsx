import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskServiceBinding } from "../components/TaskServiceBinding";
import type { ServiceTemplateView } from "../data/serviceCatalog";
import { serviceBindingsFromMain, serviceBindingAdoptionFromMain } from "../data/serviceCatalog";
import type { ShellTaskOpResult } from "../data/shellBridge";

const environmentId = "e-b36323d3-ff33-4e34-a873-536a9775788a";
const template: ServiceTemplateView = { projectId: "b36323d3-ff33-4e34-a873-536a9775788a", environmentId,
  serviceId: "s-b36323d3-ff33-4e34-a873-536a9775788a",
  version: 1, descriptor: { name: "API", program: "node", args: [], ports: [], runType: "long-lived" }, shared: [] };
const environmentName = "本地开发";
const bound = { taskId: "task-a", serviceId: template.serviceId, environmentId, environmentName,
  templateVersion: 1, rootId: "repo", subdir: "", privateKeys: ["API_TOKEN"] };
const tasks = [{ taskId: "task-a", name: "任务甲" }];
function roots() { return { ok: true, payload: { taskDir: "/task", roots: [{ id: "repo", kind: "worktree", label: "Repo", path: "/task/repo" }] } }; }
afterEach(() => { cleanup(); delete window.pidock; });

it("names a blank bound 绑定根 instead of ending the 已绑定 line at a separator", async () => {
  // `serviceBindingsFromMain` reads `rootId` by value (`typeof === "string"`),
  // so the answered binding may carry `""`; the line then read
  // `已绑定 · 环境 本地开发 · v1 · `.
  window.pidock = {
    taskOp: vi.fn(async () => roots()),
    serviceCatalogOp: vi.fn(async (request: Record<string, unknown>) => request["op"] === "taskBindings"
      ? { ok: true, payload: [{ ...bound, rootId: "" }] } : { ok: true, payload: { cancelled: true } }),
  };
  render(<TaskServiceBinding environmentName={environmentName} template={template} tasks={tasks} />);
  expect(await screen.findByText("已绑定 · 环境 本地开发 · v1 · Host 未上报绑定根")).toBeInTheDocument();
});

it("names an empty root label in the worktree choice instead of a blank option", async () => {
  // A label the Host sent as `""` survives `workspaceRootsFromHost` (`str()`
  // keeps it), so the worktree choice names the absence instead of offering a
  // nameless option a binding could be made against.
  window.pidock = {
    taskOp: vi.fn(async () => ({ ok: true, payload: { taskDir: "/task", roots: [{ id: "repo", kind: "worktree", label: "", path: "/task/repo" }] } })),
    serviceCatalogOp: vi.fn(async (request: Record<string, unknown>) => request["op"] === "taskBindings"
      ? { ok: true, payload: [] } : { ok: true, payload: { cancelled: true } }),
  };
  render(<TaskServiceBinding environmentName={environmentName} template={template} tasks={tasks} />);
  const choice = await screen.findByLabelText("绑定工作副本");
  expect(within(choice).getByRole("option", { name: "Host 未上报根名称" })).toBeInTheDocument();
});

it("submits no page program path and only binds after explicit review", async () => {
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => request["op"] === "taskBindings"
    ? { ok: true, payload: [] } : { ok: true, payload: { cancelled: false, binding: bound } });
  window.pidock = { taskOp: vi.fn(async () => roots()), serviceCatalogOp };
  render(<TaskServiceBinding environmentName={environmentName} template={template} tasks={tasks} />);
  expect(await screen.findByRole("option", { name: "Repo" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "添加私有引用" }));
  fireEvent.change(screen.getByLabelText("私有 KEY 1"), { target: { value: "API_TOKEN" } });
  fireEvent.change(screen.getByLabelText("本机环境引用 1"), { target: { value: "LOCAL_REF" } });
  fireEvent.click(screen.getByRole("button", { name: "核对任务绑定" }));
  expect(serviceCatalogOp).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "选择程序并保存绑定" }));
  expect(await screen.findByText("已绑定 · 环境 本地开发 · v1 · repo")).toBeInTheDocument();
  expect(serviceCatalogOp).toHaveBeenCalledWith({ op: "bind", projectId: template.projectId, environmentId, taskId: "task-a",
    serviceId: template.serviceId, templateVersion: 1, rootId: "repo", subdir: "", privateRefs: [{ key: "API_TOKEN", envRef: "LOCAL_REF" }] });
  expect(screen.getByText("私有变量：API_TOKEN")).toBeInTheDocument();
  expect(screen.queryByDisplayValue("LOCAL_REF")).toBeNull();
  expect(screen.getByText(/启停入口在任务运行面板/)).toBeInTheDocument();
});

it("prefills the bound working directory from the template default and says which one a launch uses", async () => {
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => request["op"] === "taskBindings"
    ? { ok: true, payload: [] } : { ok: true, payload: { cancelled: false, binding: { ...bound, subdir: String(request["subdir"]), privateKeys: [] } } });
  window.pidock = { taskOp: vi.fn(async () => roots()), serviceCatalogOp };
  render(<TaskServiceBinding template={{ ...template, descriptor: { ...template.descriptor, workdir: "apps/api" } }} tasks={tasks} />);
  await screen.findByRole("option", { name: "Repo" });
  expect(screen.getByLabelText("绑定工作子目录")).toHaveValue("apps/api");
  expect(screen.getByText(/已带入模板默认工作目录：apps\/api/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("绑定工作子目录"), { target: { value: "apps/other" } });
  expect(screen.getByText(/本机绑定的工作子目录即启动时的工作目录/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "核对任务绑定" }));
  fireEvent.click(screen.getByRole("button", { name: "选择程序并保存绑定" }));
  expect(await screen.findByText("已绑定 · 环境 本地开发 · v1 · repo/apps/other")).toBeInTheDocument();
  expect(serviceCatalogOp).toHaveBeenCalledWith(expect.objectContaining({ op: "bind", subdir: "apps/other" }));
});

it("preserves the form after picker cancellation and never invents a binding", async () => {
  window.pidock = { taskOp: vi.fn(async () => roots()), serviceCatalogOp: vi.fn(async (request) => request["op"] === "taskBindings"
    ? { ok: true, payload: [] } : { ok: true, payload: { cancelled: true } }) };
  render(<TaskServiceBinding environmentName={environmentName} template={template} tasks={tasks} />);
  await screen.findByRole("option", { name: "Repo" });
  fireEvent.click(screen.getByRole("button", { name: "核对任务绑定" }));
  fireEvent.click(screen.getByRole("button", { name: "选择程序并保存绑定" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "核对任务绑定" })).toBeEnabled());
  expect(screen.queryByText(/已绑定/)).toBeNull();
});

it("discards a late bind receipt after the task becomes unavailable", async () => {
  let finish: ((result: ShellTaskOpResult) => void) | undefined;
  const pending = new Promise<ShellTaskOpResult>((resolve) => { finish = resolve; });
  window.pidock = { taskOp: vi.fn(async () => roots()), serviceCatalogOp: vi.fn(async (request) => request["op"] === "taskBindings"
    ? { ok: true, payload: [] } : pending) };
  const { rerender } = render(<TaskServiceBinding environmentName={environmentName} template={template} tasks={tasks} />);
  await screen.findByRole("option", { name: "Repo" });
  fireEvent.click(screen.getByRole("button", { name: "核对任务绑定" }));
  fireEvent.click(screen.getByRole("button", { name: "选择程序并保存绑定" }));
  rerender(<TaskServiceBinding environmentName={environmentName} template={template} tasks={[]} />);
  finish?.({ ok: true, payload: { cancelled: false, binding: bound } });
  await waitFor(() => expect(screen.getByText("当前项目无可绑定任务")).toBeInTheDocument());
  expect(screen.queryByText(/已绑定/)).toBeNull();
});

const restart = { changed: true, processRestarted: false as const, fencedTaskIds: [] as string[] };
const adoptReview = { taskId: "task-a", serviceId: template.serviceId, environmentId, from: 1, to: 2, adopted: false,
  restartNeeded: [{ taskId: "task-a", serviceId: template.serviceId, name: "API", from: 1, to: 2 }], restart };
const newerTemplate: ServiceTemplateView = { ...template, version: 2, descriptor: { ...template.descriptor, workdir: "apps/api" } };

it("offers the adoption of a newer revision only when one exists, and never adopts on load", async () => {
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => request["op"] === "taskBindings"
    ? { ok: true, payload: [bound] } : { ok: true, payload: adoptReview });
  window.pidock = { taskOp: vi.fn(async () => roots()), serviceCatalogOp };
  const { unmount } = render(<TaskServiceBinding environmentName={environmentName} template={template} tasks={tasks} />);
  expect(await screen.findByText("已绑定 · 环境 本地开发 · v1 · repo")).toBeInTheDocument();
  expect(serviceCatalogOp).toHaveBeenCalledTimes(1);
  expect(serviceCatalogOp).toHaveBeenCalledWith({ op: "taskBindings", projectId: template.projectId, taskId: "task-a" });
  // The pinned revision is the displayed revision: no control, and no adoption request.
  expect(screen.queryByRole("button", { name: /采用/ })).toBeNull();
  unmount();
  serviceCatalogOp.mockClear();
  render(<TaskServiceBinding environmentName={environmentName} template={newerTemplate} tasks={tasks} />);
  expect(await screen.findByText("已绑定 · 环境 本地开发 · v1 · repo")).toBeInTheDocument();
  expect(serviceCatalogOp).toHaveBeenCalledTimes(1);
  expect(serviceCatalogOp).not.toHaveBeenCalledWith(expect.objectContaining({ op: "adoptBinding" }));
  expect(screen.getByRole("button", { name: /核对采用 v2/ })).toBeInTheDocument();
});

it("adopts v2 only after a confirmation that shows from → to and the restart-needed list", async () => {
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => request["op"] === "taskBindings"
    ? { ok: true, payload: [bound] }
    : { ok: true, payload: { ...adoptReview, adopted: request["confirm"] === true } });
  window.pidock = { taskOp: vi.fn(async () => roots()), serviceCatalogOp };
  render(<TaskServiceBinding environmentName={environmentName} template={newerTemplate} tasks={tasks} />);
  await screen.findByText("已绑定 · 环境 本地开发 · v1 · repo");
  fireEvent.click(screen.getByRole("button", { name: /核对采用 v2/ }));
  expect(await screen.findByText(/待采用：API · v1 → v2/)).toBeInTheDocument();
  expect(screen.getByText(/本次采用的任务 任务甲 的 API（v1 → v2）/)).toBeInTheDocument();
  expect(screen.getByText(/未启动、停止或重启任何进程/)).toBeInTheDocument();
  // The pin change revokes this task's owner snapshot, so the page must not send the human to a
  // run-panel stop/start step that the same change makes unavailable.
  expect(screen.getByText(/撤销该任务的运行面板启停通道/)).toBeInTheDocument();
  expect(screen.getByText(/service-owner-inventory-unconfirmed/)).toBeInTheDocument();
  expect(screen.getByText(/确认后可用本面板的「重新绑定服务所有者」恢复启停/)).toBeInTheDocument();
  expect(screen.queryByText(/本版未提供重建入口/)).toBeNull();
  expect(screen.queryByText(/在运行面板先停止再启动/)).toBeNull();
  expect(serviceCatalogOp).toHaveBeenCalledWith({ op: "adoptBinding", projectId: template.projectId, taskId: "task-a",
    serviceId: template.serviceId, templateVersion: 2, confirm: false });
  // Nothing is written yet: the binding still shows its pinned revision.
  expect(screen.getByText("已绑定 · 环境 本地开发 · v1 · repo")).toBeInTheDocument();
  expect(serviceCatalogOp.mock.calls.filter(([request]) => (request as Record<string, unknown>)["confirm"] === true)).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "确认采用 v2" }));
  expect(await screen.findByText(/已采用 v2（原 v1）/)).toBeInTheDocument();
  expect(screen.getByText(/未重启任何进程/)).toBeInTheDocument();
  expect(screen.getByText(/可在下方重新绑定该任务的服务所有者来恢复/)).toBeInTheDocument();
  expect(screen.getByText("已绑定 · 环境 本地开发 · v2 · repo")).toBeInTheDocument();
  expect(serviceCatalogOp.mock.calls.filter(([request]) => (request as Record<string, unknown>)["confirm"] === true)).toHaveLength(1);
  expect(serviceCatalogOp).toHaveBeenLastCalledWith({ op: "adoptBinding", projectId: template.projectId, taskId: "task-a",
    serviceId: template.serviceId, templateVersion: 2, confirm: true });
  // The adopted revision is the pinned one, so the control is gone.
  expect(screen.queryByRole("button", { name: /采用/ })).toBeNull();
});

it("calls a sibling still-pinned binding a candidate, and keeps the confirm buttons out of the live region", async () => {
  const sibling = { taskId: "task-b", serviceId: template.serviceId, name: "API", from: 1, to: 2 };
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => request["op"] === "taskBindings"
    ? { ok: true, payload: [bound] }
    : { ok: true, payload: { ...adoptReview, restartNeeded: [adoptReview.restartNeeded[0], sibling] } });
  window.pidock = { taskOp: vi.fn(async () => roots()), serviceCatalogOp };
  render(<TaskServiceBinding environmentName={environmentName} template={newerTemplate} tasks={[...tasks, { taskId: "task-b", name: "任务乙" }]} />);
  await screen.findByText("已绑定 · 环境 本地开发 · v1 · repo");
  fireEvent.click(screen.getByRole("button", { name: /核对采用 v2/ }));
  expect(await screen.findByText(/待采用：API · v1 → v2/)).toBeInTheDocument();
  // Only this binding is written by the adoption; the sibling is still pinned and needs its own adoption.
  expect(screen.getByText(/本次采用的任务 任务甲 的 API（v1 → v2）/)).toBeInTheDocument();
  expect(screen.getByText(/任务 任务乙 的 API 仍固定 v1，需显式采用 v2/)).toBeInTheDocument();
  expect(screen.queryByText(/任务 任务乙 的 API（v1 → v2）/)).toBeNull();
  // The live region carries the text only: the confirm/cancel controls stay outside it.
  const live = screen.getByText(/未启动、停止或重启任何进程/).closest("[role='status']");
  expect(live).not.toBeNull();
  expect(live?.querySelector("button")).toBeNull();
  expect(screen.getByRole("button", { name: "确认采用 v2" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
});

it("names a blank service name and a blank sibling task id in the restart-impact line", async () => {
  // `serviceBindingAdoptionFromMain` reads `restartNeeded[].name` and `[].taskId`
  // by value (`typeof === "string"`), so the Host may answer `""` for either;
  // each names its own absence instead of printing `的 （v1 → v2）`.
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => request["op"] === "taskBindings"
    ? { ok: true, payload: [bound] }
    : { ok: true, payload: { ...adoptReview, restartNeeded: [
      { taskId: "task-a", serviceId: template.serviceId, name: "", from: 1, to: 2 },
      { taskId: "", serviceId: template.serviceId, name: "API", from: 1, to: 2 },
    ] } });
  window.pidock = { taskOp: vi.fn(async () => roots()), serviceCatalogOp };
  render(<TaskServiceBinding environmentName={environmentName} template={newerTemplate} tasks={tasks} />);
  await screen.findByText("已绑定 · 环境 本地开发 · v1 · repo");
  fireEvent.click(screen.getByRole("button", { name: /核对采用 v2/ }));
  expect(await screen.findByText(/本次采用的任务 任务甲 的 Host 未上报服务名称（v1 → v2）/)).toBeInTheDocument();
  expect(screen.getByText(/任务 Host 未上报任务名称 的 API 仍固定 v1，需显式采用 v2/)).toBeInTheDocument();
  expect(screen.queryByText(/任务 {2}的 API 仍固定/)).toBeNull();
});

it("surfaces the real refusal and leaves the shown version unchanged", async () => {
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => request["op"] === "taskBindings"
    ? { ok: true, payload: [bound] }
    : { ok: false, error: "Error invoking remote method 'shell/serviceCatalogOp': Error: template version unavailable" });
  window.pidock = { taskOp: vi.fn(async () => roots()), serviceCatalogOp };
  render(<TaskServiceBinding environmentName={environmentName} template={newerTemplate} tasks={tasks} />);
  await screen.findByText("已绑定 · 环境 本地开发 · v1 · repo");
  fireEvent.click(screen.getByRole("button", { name: /核对采用 v2/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("template version unavailable");
  expect(screen.queryByText(/待采用/)).toBeNull();
  expect(screen.getByText("已绑定 · 环境 本地开发 · v1 · repo")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /核对采用 v2/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /核对采用 v2/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("template version unavailable");
  // A refused review never becomes a confirmed write: there is no control to confirm and none was sent.
  expect(screen.queryByRole("button", { name: "确认采用 v2" })).toBeNull();
  expect(serviceCatalogOp.mock.calls.filter(([request]) => (request as Record<string, unknown>)["confirm"] === true)).toHaveLength(0);
  expect(screen.getByText("已绑定 · 环境 本地开发 · v1 · repo")).toBeInTheDocument();
});

it("reads only main's own adoption shape and discards a receipt that does not match the review", async () => {
  const expected = { taskId: "task-a", serviceId: template.serviceId, environmentId, from: 1, to: 2 };
  expect(serviceBindingAdoptionFromMain(adoptReview, expected)).toEqual(adoptReview);
  for (const refused of [
    { ...adoptReview, programPath: "/private/program" },
    { ...adoptReview, rootId: "repo" },
    { ...adoptReview, taskId: "task-b" },
    { ...adoptReview, serviceId: "s-524639ce-90ac-4dc5-8a52-c3628386ca36" },
    { ...adoptReview, from: 2 },
    { ...adoptReview, to: 3 },
    { ...adoptReview, from: 2, to: 2 },
    { ...adoptReview, adopted: "yes" },
    { ...adoptReview, restartNeeded: [{ ...adoptReview.restartNeeded[0], to: 9 }] },
    { ...adoptReview, restartNeeded: [{ ...adoptReview.restartNeeded[0], from: 0 }] },
    { ...adoptReview, restartNeeded: [{ ...adoptReview.restartNeeded[0], serviceId: "s-524639ce-90ac-4dc5-8a52-c3628386ca36" }] },
    { ...adoptReview, restartNeeded: [adoptReview.restartNeeded[0], adoptReview.restartNeeded[0]] },
    { ...adoptReview, restartNeeded: { taskId: "task-a" } },
  ]) expect(serviceBindingAdoptionFromMain(refused, expected)).toBeNull();
  expect(serviceBindingAdoptionFromMain(undefined, expected)).toBeNull();
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => request["op"] === "taskBindings"
    ? { ok: true, payload: [bound] }
    : { ok: true, payload: request["confirm"] === true ? { ...adoptReview, adopted: true, restartNeeded: [] } : adoptReview });
  window.pidock = { taskOp: vi.fn(async () => roots()), serviceCatalogOp };
  render(<TaskServiceBinding environmentName={environmentName} template={newerTemplate} tasks={tasks} />);
  await screen.findByText("已绑定 · 环境 本地开发 · v1 · repo");
  fireEvent.click(screen.getByRole("button", { name: /核对采用 v2/ }));
  await screen.findByText(/待采用：API · v1 → v2/);
  fireEvent.click(screen.getByRole("button", { name: "确认采用 v2" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("采用结果无法确认");
  expect(screen.getByText("已绑定 · 环境 本地开发 · v1 · repo")).toBeInTheDocument();
});

it("refuses malformed or leaked binding responses instead of treating them as empty", async () => {
  expect(serviceBindingsFromMain([{ ...bound, programPath: "/private/path" }], "task-a")).toBeNull();
  expect(serviceBindingsFromMain([bound], "other-task")).toBeNull();
  window.pidock = { taskOp: vi.fn(async () => roots()), serviceCatalogOp: vi.fn(async () => ({ ok: true, payload: { bindings: [] } })) };
  render(<TaskServiceBinding environmentName={environmentName} template={template} tasks={tasks} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("无法核对");
  expect(screen.queryByRole("button", { name: "核对任务绑定" })).toBeNull();
});
