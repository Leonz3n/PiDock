import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskServiceBinding } from "../components/TaskServiceBinding";
import type { ServiceTemplateView } from "../data/serviceCatalog";
import { serviceBindingsFromMain } from "../data/serviceCatalog";
import type { ShellTaskOpResult } from "../data/shellBridge";

const template: ServiceTemplateView = { projectId: "b36323d3-ff33-4e34-a873-536a9775788a", serviceId: "s-b36323d3-ff33-4e34-a873-536a9775788a",
  version: 1, descriptor: { name: "API", program: "node", args: [], ports: [], runType: "long-lived" }, sharedKeys: [] };
const bound = { taskId: "task-a", serviceId: template.serviceId, templateVersion: 1, rootId: "repo", subdir: "", privateKeys: ["API_TOKEN"] };
const tasks = [{ taskId: "task-a", name: "任务甲" }];
function roots() { return { ok: true, payload: { taskDir: "/task", roots: [{ id: "repo", kind: "worktree", label: "Repo", path: "/task/repo" }] } }; }
afterEach(() => { cleanup(); delete window.pidock; });

it("submits no page program path and only binds after explicit review", async () => {
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => request["op"] === "taskBindings"
    ? { ok: true, payload: [] } : { ok: true, payload: { cancelled: false, binding: bound } });
  window.pidock = { taskOp: vi.fn(async () => roots()), serviceCatalogOp };
  render(<TaskServiceBinding template={template} tasks={tasks} />);
  expect(await screen.findByRole("option", { name: "Repo" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "添加私有引用" }));
  fireEvent.change(screen.getByLabelText("私有 KEY 1"), { target: { value: "API_TOKEN" } });
  fireEvent.change(screen.getByLabelText("本机环境引用 1"), { target: { value: "LOCAL_REF" } });
  fireEvent.click(screen.getByRole("button", { name: "核对任务绑定" }));
  expect(serviceCatalogOp).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "选择程序并保存绑定" }));
  expect(await screen.findByText("已绑定 · v1 · repo")).toBeInTheDocument();
  expect(serviceCatalogOp).toHaveBeenCalledWith({ op: "bind", projectId: template.projectId, taskId: "task-a",
    serviceId: template.serviceId, templateVersion: 1, rootId: "repo", subdir: "", privateRefs: [{ key: "API_TOKEN", envRef: "LOCAL_REF" }] });
  expect(screen.getByText("私有变量：API_TOKEN")).toBeInTheDocument();
  expect(screen.queryByDisplayValue("LOCAL_REF")).toBeNull();
  expect(screen.getByText("运行未接线")).toBeInTheDocument();
});

it("preserves the form after picker cancellation and never invents a binding", async () => {
  window.pidock = { taskOp: vi.fn(async () => roots()), serviceCatalogOp: vi.fn(async (request) => request["op"] === "taskBindings"
    ? { ok: true, payload: [] } : { ok: true, payload: { cancelled: true } }) };
  render(<TaskServiceBinding template={template} tasks={tasks} />);
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
  const { rerender } = render(<TaskServiceBinding template={template} tasks={tasks} />);
  await screen.findByRole("option", { name: "Repo" });
  fireEvent.click(screen.getByRole("button", { name: "核对任务绑定" }));
  fireEvent.click(screen.getByRole("button", { name: "选择程序并保存绑定" }));
  rerender(<TaskServiceBinding template={template} tasks={[]} />);
  finish?.({ ok: true, payload: { cancelled: false, binding: bound } });
  await waitFor(() => expect(screen.getByText("当前项目无可绑定任务")).toBeInTheDocument());
  expect(screen.queryByText(/已绑定/)).toBeNull();
});

it("refuses malformed or leaked binding responses instead of treating them as empty", async () => {
  expect(serviceBindingsFromMain([{ ...bound, programPath: "/private/path" }], "task-a")).toBeNull();
  expect(serviceBindingsFromMain([bound], "other-task")).toBeNull();
  window.pidock = { taskOp: vi.fn(async () => roots()), serviceCatalogOp: vi.fn(async () => ({ ok: true, payload: { bindings: [] } })) };
  render(<TaskServiceBinding template={template} tasks={tasks} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("无法核对");
  expect(screen.queryByRole("button", { name: "核对任务绑定" })).toBeNull();
});
