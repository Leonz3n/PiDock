import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectServiceTemplates } from "../components/ProjectServiceTemplates";
import { serviceTemplatesFromMain } from "../data/serviceCatalog";
import type { ShellTaskOpResult } from "../data/shellBridge";

const projectId = "b36323d3-ff33-4e34-a873-536a9775788a";
const otherProject = "524639ce-90ac-4dc5-8a52-c3628386ca36";
const saved = {
  projectId, serviceId: "s-b36323d3-ff33-4e34-a873-536a9775788a", version: 1,
  descriptor: { name: "API", program: "node", args: ["server.js"], ports: [3000], runType: "long-lived" },
  sharedKeys: ["PORT"],
};
afterEach(() => { cleanup(); delete window.pidock; });

it("projects a saved template without carrying private fields or values into list rows", () => {
  expect(serviceTemplatesFromMain([saved], projectId)).toEqual([saved]);
  expect(serviceTemplatesFromMain([{ ...saved, programPath: "/local/private", privateRefs: [{ key: "API_TOKEN", envRef: "PRIVATE_ENV" }] }], projectId)).toBeNull();
  expect(serviceTemplatesFromMain([{ ...saved, projectId: otherProject }], projectId)).toBeNull();
  expect(serviceTemplatesFromMain([{ ...saved, descriptor: { ...saved.descriptor, runType: "unknown" } }], projectId)).toBeNull();
});

it("requires an explicit second confirmation before creating a human project template", async () => {
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => request["op"] === "list"
    ? { ok: true, payload: [] } : { ok: true, payload: saved });
  window.pidock = { serviceCatalogOp };
  render(<ProjectServiceTemplates projectId={projectId} />);
  expect(await screen.findByText("该项目尚未保存服务模板。")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "添加服务" }));
  fireEvent.change(screen.getByLabelText("服务名称"), { target: { value: "API" } });
  fireEvent.change(screen.getByLabelText("程序名"), { target: { value: "node" } });
  fireEvent.change(screen.getByLabelText("参数 1"), { target: { value: "server.js" } });
  fireEvent.change(screen.getByLabelText("端口"), { target: { value: "3000" } });
  fireEvent.click(screen.getByRole("button", { name: "添加共享变量" }));
  fireEvent.change(screen.getByLabelText("共享变量 KEY 1"), { target: { value: "PORT" } });
  fireEvent.change(screen.getByLabelText("共享变量 VALUE 1"), { target: { value: "3000" } });
  expect(serviceCatalogOp).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "核对保存" }));
  expect(screen.getByText(/待保存：API/)).toBeInTheDocument();
  expect(serviceCatalogOp).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
  await waitFor(() => expect(screen.getByText("API")).toBeInTheDocument());
  expect(serviceCatalogOp).toHaveBeenCalledWith({ op: "create", projectId,
    descriptor: saved.descriptor, shared: [{ key: "PORT", value: "3000", secret: false }] });
  expect(screen.getByRole("button", { name: "任务绑定" })).toBeInTheDocument();
  expect(screen.getByText("运行未接线")).toBeInTheDocument();
  expect(screen.queryByText("3000")).toBeNull();
});

it("keeps the form after an ambiguous save and requires a fresh authoritative list", async () => {
  let calls = 0;
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => {
    if (request["op"] === "list") return { ok: true, payload: calls++ === 0 ? [] : [saved] };
    return { ok: false, error: "transport disconnected" };
  });
  window.pidock = { serviceCatalogOp };
  render(<ProjectServiceTemplates projectId={projectId} />);
  expect(await screen.findByText("该项目尚未保存服务模板。")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "添加服务" }));
  fireEvent.change(screen.getByLabelText("服务名称"), { target: { value: "API" } });
  fireEvent.change(screen.getByLabelText("程序名"), { target: { value: "node" } });
  fireEvent.change(screen.getByLabelText("参数 1"), { target: { value: "server.js" } });
  fireEvent.change(screen.getByLabelText("端口"), { target: { value: "3000" } });
  fireEvent.click(screen.getByRole("button", { name: "添加共享变量" }));
  fireEvent.change(screen.getByLabelText("共享变量 KEY 1"), { target: { value: "PORT" } });
  fireEvent.change(screen.getByLabelText("共享变量 VALUE 1"), { target: { value: "3000" } });
  fireEvent.click(screen.getByRole("button", { name: "核对保存" }));
  fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("保存结果无法确认");
  expect(screen.getByLabelText("服务名称")).toHaveValue("API");
  expect(screen.getByRole("button", { name: "核对保存" })).toBeDisabled();
  expect(serviceCatalogOp).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "刷新服务配方" }));
  await waitFor(() => expect(serviceCatalogOp).toHaveBeenCalledTimes(3));
  expect(screen.getByRole("button", { name: "核对保存" })).toBeDisabled();
  expect(screen.getByLabelText("服务名称")).toHaveValue("API");
  expect(screen.getByRole("alert")).toHaveTextContent("清单中已有相同模板");
});

it("rejects malformed lists and discards stale project responses", async () => {
  let resolveFirst: ((value: ShellTaskOpResult) => void) | undefined;
  const first = new Promise<ShellTaskOpResult>((resolve) => { resolveFirst = resolve; });
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => request["projectId"] === projectId
    ? first : { ok: true, payload: [{ ...saved, projectId: otherProject, descriptor: { ...saved.descriptor, name: "Second" } }] });
  window.pidock = { serviceCatalogOp };
  const { rerender } = render(<ProjectServiceTemplates projectId={projectId} />);
  rerender(<ProjectServiceTemplates projectId={otherProject} />);
  expect(await screen.findByText("Second")).toBeInTheDocument();
  resolveFirst?.({ ok: true, payload: [{ ...saved, descriptor: { ...saved.descriptor, name: "Stale" } }] });
  await waitFor(() => expect(screen.queryByText("Stale")).toBeNull());
});

it("treats a malformed catalog response as unavailable, never an empty list", async () => {
  window.pidock = { serviceCatalogOp: vi.fn(async () => ({ ok: true, payload: { revisions: [] } })) };
  render(<ProjectServiceTemplates projectId={projectId} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("响应无法核对");
  expect(screen.getByRole("button", { name: "添加服务" })).toBeDisabled();
  expect(screen.queryByText("该项目尚未保存服务模板。")).toBeNull();
});
