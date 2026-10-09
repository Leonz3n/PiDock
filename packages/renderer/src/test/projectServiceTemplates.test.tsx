import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectServiceTemplates } from "../components/ProjectServiceTemplates";
import { serviceTemplatesFromMain } from "../data/serviceCatalog";
import type { ServiceImportHintView } from "../data/serviceImportHints";
import type { ShellTaskOpResult } from "../data/shellBridge";

const projectId = "b36323d3-ff33-4e34-a873-536a9775788a";
const otherProject = "524639ce-90ac-4dc5-8a52-c3628386ca36";
const serviceId = "s-b36323d3-ff33-4e34-a873-536a9775788a";
const saved = {
  projectId, serviceId, version: 1,
  descriptor: { name: "API", program: "node", args: ["server.js"], ports: [3000], runType: "long-lived" },
  shared: [{ key: "PORT", value: "3000" }],
};
const review = {
  projectId, serviceId, version: 2, versionLabel: "v2", saved: false, descriptorChanged: true,
  diff: { added: ["API_URL"], changed: [{ key: "PORT", before: "3000", after: "4000" }], removed: [] },
  restartNeeded: [{ taskId: "task-1", serviceId, name: "API", from: 1, to: 2 }],
};
afterEach(() => { cleanup(); delete window.pidock; });

function stub(handler: (request: Record<string, unknown>) => ShellTaskOpResult) {
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => handler(request));
  window.pidock = { serviceCatalogOp };
  return serviceCatalogOp;
}

it("projects a saved template with only its shared fields and none of the private ones", () => {
  expect(serviceTemplatesFromMain([saved], projectId)).toEqual([saved]);
  expect(serviceTemplatesFromMain([{ ...saved, programPath: "/local/private", privateRefs: [{ key: "API_TOKEN", envRef: "PRIVATE_ENV" }] }], projectId)).toBeNull();
  expect(serviceTemplatesFromMain([{ ...saved, projectId: otherProject }], projectId)).toBeNull();
  expect(serviceTemplatesFromMain([{ ...saved, descriptor: { ...saved.descriptor, runType: "unknown" } }], projectId)).toBeNull();
  // The new shared fields stay key-exact: an unexpected key or a machine path is refused, never partially rendered.
  expect(serviceTemplatesFromMain([{ ...saved, descriptor: { ...saved.descriptor, cwd: "/Users/name/task" } }], projectId)).toBeNull();
  expect(serviceTemplatesFromMain([{ ...saved, descriptor: { ...saved.descriptor, workdir: "/Users/name/task" } }], projectId)).toBeNull();
  expect(serviceTemplatesFromMain([{ ...saved, descriptor: { ...saved.descriptor, workdir: "../outside" } }], projectId)).toBeNull();
  expect(serviceTemplatesFromMain([{ ...saved, shared: [{ key: "PORT", value: "3000", secret: true }] }], projectId)).toBeNull();
  expect(serviceTemplatesFromMain([{ ...saved, shared: [{ key: "1BAD", value: "3000" }] }], projectId)).toBeNull();
  expect(serviceTemplatesFromMain([{ ...saved, descriptor: { ...saved.descriptor, workdir: "apps/api", healthCheck: { kind: "http" } } }], projectId))
    .toEqual([{ ...saved, descriptor: { ...saved.descriptor, workdir: "apps/api", healthCheck: { kind: "http" } } }]);
});

it("requires an explicit second confirmation before creating a human project template", async () => {
  const serviceCatalogOp = stub((request) => request["op"] === "list" ? { ok: true, payload: [] } : { ok: true, payload: saved });
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
  expect(screen.getByText("共享模板目录已接线")).toBeInTheDocument();
  expect(screen.getByText(/启停入口在任务运行面板/)).toBeInTheDocument();
  expect(screen.queryByText("运行未接线")).toBeNull();
  expect(screen.queryByText("3000")).toBeNull();
});

it("keeps the shared workdir and healthCheck of a created template and refuses a machine path with the rule's own message", async () => {
  const serviceCatalogOp = stub((request) => request["op"] === "list" ? { ok: true, payload: [] }
    : { ok: true, payload: { ...saved, shared: [], descriptor: { ...saved.descriptor, workdir: "apps/api", healthCheck: { kind: "http", target: "http://127.0.0.1:3000/health" } } } });
  render(<ProjectServiceTemplates projectId={projectId} />);
  await screen.findByText("该项目尚未保存服务模板。");
  fireEvent.click(screen.getByRole("button", { name: "添加服务" }));
  fireEvent.change(screen.getByLabelText("服务名称"), { target: { value: "API" } });
  fireEvent.change(screen.getByLabelText("程序名"), { target: { value: "node" } });
  fireEvent.change(screen.getByLabelText("参数 1"), { target: { value: "server.js" } });
  fireEvent.change(screen.getByLabelText("端口"), { target: { value: "3000" } });
  fireEvent.change(screen.getByLabelText("工作目录"), { target: { value: "/Users/name/tasks/task-1/apps/api" } });
  fireEvent.click(screen.getByRole("button", { name: "核对保存" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("工作目录必须是仓库内相对目录，不能是本机绝对路径");
  expect(serviceCatalogOp).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText("工作目录"), { target: { value: "apps/api" } });
  fireEvent.change(screen.getByLabelText("健康检查"), { target: { value: "http" } });
  fireEvent.change(screen.getByLabelText("健康检查目标"), { target: { value: "http://127.0.0.1:3000/health" } });
  fireEvent.click(screen.getByRole("button", { name: "核对保存" }));
  fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
  await waitFor(() => expect(screen.getByText(/工作目录 apps\/api/)).toBeInTheDocument());
  expect(serviceCatalogOp).toHaveBeenLastCalledWith({ op: "create", projectId,
    descriptor: { ...saved.descriptor, workdir: "apps/api", healthCheck: { kind: "http", target: "http://127.0.0.1:3000/health" } },
    shared: [] });
  expect(screen.getByText(/健康检查 http/)).toBeInTheDocument();
});

it("surfaces the descriptor rule's exact message for an invalid port and program", async () => {
  const serviceCatalogOp = stub(() => ({ ok: true, payload: [] }));
  render(<ProjectServiceTemplates projectId={projectId} />);
  await screen.findByText("该项目尚未保存服务模板。");
  fireEvent.click(screen.getByRole("button", { name: "添加服务" }));
  fireEvent.change(screen.getByLabelText("服务名称"), { target: { value: "API" } });
  fireEvent.change(screen.getByLabelText("程序名"), { target: { value: "node" } });
  fireEvent.change(screen.getByLabelText("端口"), { target: { value: "70000" } });
  fireEvent.click(screen.getByRole("button", { name: "核对保存" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("端口必须在 1–65535 之间：70000");
  fireEvent.change(screen.getByLabelText("端口"), { target: { value: "abc" } });
  fireEvent.click(screen.getByRole("button", { name: "核对保存" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("端口必须是数字：abc");
  fireEvent.change(screen.getByLabelText("端口"), { target: { value: "3000" } });
  fireEvent.change(screen.getByLabelText("程序名"), { target: { value: "PORT=3000" } });
  fireEvent.click(screen.getByRole("button", { name: "核对保存" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("启动程序不能携带内联环境赋值（PORT=3000）；请把变量写入环境层，程序与参数分开填写");
  fireEvent.change(screen.getByLabelText("程序名"), { target: { value: "node" } });
  fireEvent.click(screen.getByRole("button", { name: "添加共享变量" }));
  fireEvent.change(screen.getByLabelText("共享变量 KEY 1"), { target: { value: "API_TOKEN" } });
  fireEvent.click(screen.getByRole("button", { name: "核对保存" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("共享模板不能包含凭据「API_TOKEN」；请移入本机私有配置");
  expect(serviceCatalogOp).toHaveBeenCalledTimes(1);
});

it("names a non-portable program, a machine-path argument and a credential target before any request", async () => {
  const serviceCatalogOp = stub(() => ({ ok: true, payload: [] }));
  render(<ProjectServiceTemplates projectId={projectId} />);
  await screen.findByText("该项目尚未保存服务模板。");
  fireEvent.click(screen.getByRole("button", { name: "添加服务" }));
  fireEvent.change(screen.getByLabelText("服务名称"), { target: { value: "API" } });
  fireEvent.change(screen.getByLabelText("程序名"), { target: { value: "/usr/bin/node" } });
  fireEvent.click(screen.getByRole("button", { name: "核对保存" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("共享模板的启动程序必须是可移植的程序名");
  fireEvent.change(screen.getByLabelText("程序名"), { target: { value: "node" } });
  fireEvent.change(screen.getByLabelText("参数 1"), { target: { value: "-I/Users/name/private/include" } });
  fireEvent.click(screen.getByRole("button", { name: "核对保存" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("共享模板参数不能携带本机路径");
  fireEvent.change(screen.getByLabelText("参数 1"), { target: { value: "server.js" } });
  fireEvent.change(screen.getByLabelText("健康检查"), { target: { value: "http" } });
  fireEvent.change(screen.getByLabelText("健康检查目标"), { target: { value: "http://127.0.0.1:3000/health?apikey=SECRET" } });
  fireEvent.click(screen.getByRole("button", { name: "核对保存" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("健康检查目标不能携带凭据或令牌");
  fireEvent.change(screen.getByLabelText("健康检查目标"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "添加共享变量" }));
  fireEvent.change(screen.getByLabelText("共享变量 KEY 1"), { target: { value: "API_URL" } });
  fireEvent.change(screen.getByLabelText("共享变量 VALUE 1"), { target: { value: "https://user:pass@example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "核对保存" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("共享模板的值不能携带凭据");
  expect(serviceCatalogOp).toHaveBeenCalledTimes(1);
});

it("reviews an existing shared template row by row, then writes one new version with the restart-needed list", async () => {
  const calls: Record<string, unknown>[] = [];
  stub((request) => {
    calls.push(request);
    if (request["op"] === "list") return { ok: true, payload: calls.length === 1 ? [saved]
      : [{ ...saved, version: 2, descriptor: { ...saved.descriptor, workdir: "apps/api" }, shared: [{ key: "PORT", value: "4000" }, { key: "API_URL", value: "http://localhost" }] }] };
    return { ok: true, payload: { ...review, saved: request["confirm"] === true } };
  });
  render(<ProjectServiceTemplates projectId={projectId} tasks={[{ taskId: "task-1", name: "任务甲" }]} />);
  expect(await screen.findByText("共享变量：PORT")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  expect(screen.getByLabelText("服务名称")).toHaveValue("API");
  expect(screen.getByLabelText("共享变量 VALUE 1")).toHaveValue("3000");
  fireEvent.change(screen.getByLabelText("共享变量 VALUE 1"), { target: { value: "4000" } });
  fireEvent.click(screen.getByRole("button", { name: "添加共享变量" }));
  fireEvent.change(screen.getByLabelText("共享变量 KEY 2"), { target: { value: "API_URL" } });
  fireEvent.change(screen.getByLabelText("共享变量 VALUE 2"), { target: { value: "http://localhost" } });
  fireEvent.change(screen.getByLabelText("工作目录"), { target: { value: "apps/api" } });
  fireEvent.click(screen.getByRole("button", { name: "核对新版本" }));
  expect(await screen.findByText(/将生成 v2（当前 v1） · 待确认/)).toBeInTheDocument();
  expect(screen.getByText("修改：PORT：3000 → 4000")).toBeInTheDocument();
  expect(screen.getByText("新增：API_URL")).toBeInTheDocument();
  expect(screen.getByText(/启动字段差异：有/)).toBeInTheDocument();
  expect(screen.getByText(/已有任务绑定保留原模板版本；本页不会重启服务或让绑定改用新版本/)).toBeInTheDocument();
  expect(screen.getByText(/受影响：任务 任务甲 的 API（v1 → v2）仍固定 v1/)).toBeInTheDocument();
  expect(screen.getByText(/已有任务绑定保留原模板版本/)).toBeInTheDocument();
  expect(calls[1]).toEqual({ op: "update", projectId, serviceId, expectedVersion: 1, confirm: false,
    descriptor: { ...saved.descriptor, workdir: "apps/api" },
    shared: [{ key: "PORT", value: "4000", secret: false }, { key: "API_URL", value: "http://localhost", secret: false }] });
  // Nothing was written by the review, and the page never claims a service restarted or adopted the new version.
  expect(screen.getByText(/不会重启服务或让绑定改用新版本/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "确认新版本" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "已保存 v2" })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(await screen.findByText(/v2 · 常驻服务/)).toBeInTheDocument();
  expect(screen.getByText(/工作目录 apps\/api/)).toBeInTheDocument();
  expect(calls.at(-2)).toEqual({ op: "update", projectId, serviceId, expectedVersion: 1, confirm: true,
    descriptor: { ...saved.descriptor, workdir: "apps/api" },
    shared: [{ key: "PORT", value: "4000", secret: false }, { key: "API_URL", value: "http://localhost", secret: false }] });
  expect(calls.at(-1)).toEqual({ op: "list", projectId });
  // The binding panel was never opened, so this page shows no bound row of its own.
  expect(screen.queryByText("已绑定")).toBeNull();
});

it("refuses a confirmed write whose listed revision is not the one the page reviewed", async () => {
  let calls = 0;
  const serviceCatalogOp = stub((request) => {
    calls += 1;
    if (request["op"] === "list") return { ok: true, payload: calls === 1 ? [saved]
      : [{ ...saved, version: 2, descriptor: { ...saved.descriptor, workdir: "apps/other" }, shared: [{ key: "PORT", value: "4000" }] }] };
    return { ok: true, payload: { ...review, saved: request["confirm"] === true } };
  });
  render(<ProjectServiceTemplates projectId={projectId} />);
  await screen.findByText("共享变量：PORT");
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  fireEvent.change(screen.getByLabelText("共享变量 VALUE 1"), { target: { value: "4000" } });
  fireEvent.change(screen.getByLabelText("工作目录"), { target: { value: "apps/api" } });
  fireEvent.click(screen.getByRole("button", { name: "核对新版本" }));
  await screen.findByText(/将生成 v2/);
  fireEvent.click(screen.getByRole("button", { name: "确认新版本" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("清单未能确认新版本");
  expect(serviceCatalogOp).toHaveBeenCalledTimes(4);
});

it("refuses an edit whose review claims a write, a drifted diff or a wrong version", async () => {
  const drift = stub((request) => request["op"] === "list" ? { ok: true, payload: [saved] }
    : { ok: true, payload: { ...review, saved: true } });
  render(<ProjectServiceTemplates projectId={projectId} />);
  await screen.findByText("共享变量：PORT");
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  fireEvent.click(screen.getByRole("button", { name: "核对新版本" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("差异回执无法核对");
  expect(screen.getByRole("button", { name: "核对新版本" })).toBeDisabled();
  cleanup();
  drift.mockClear();
  const wrongVersion = stub((request) => request["op"] === "list" ? { ok: true, payload: [saved] }
    : { ok: true, payload: { ...review, version: 9, versionLabel: "v9" } });
  render(<ProjectServiceTemplates projectId={projectId} />);
  await screen.findByText("共享变量：PORT");
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  fireEvent.click(screen.getByRole("button", { name: "核对新版本" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("差异回执无法核对");
  expect(wrongVersion.mock.calls.map(([request]) => (request as Record<string, unknown>)["op"])).not.toContain("create");
  expect(wrongVersion).toHaveBeenLastCalledWith(expect.objectContaining({ op: "update", confirm: false }));
  expect(wrongVersion.mock.calls.some(([request]) => (request as Record<string, unknown>)["confirm"] === true)).toBe(false);
  cleanup();
  const driftedWrite = stub((request) => request["op"] === "list" ? { ok: true, payload: [saved] }
    : { ok: true, payload: request["confirm"] === true
      ? { ...review, saved: true, diff: { added: [], changed: [], removed: [] } } : review });
  render(<ProjectServiceTemplates projectId={projectId} />);
  await screen.findByText("共享变量：PORT");
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  fireEvent.click(screen.getByRole("button", { name: "核对新版本" }));
  await screen.findByText(/将生成 v2/);
  fireEvent.click(screen.getByRole("button", { name: "确认新版本" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("保存结果无法确认");
  // list + review + confirmed write: the write happened, its receipt just did not match the review.
  expect(driftedWrite).toHaveBeenCalledTimes(3);
});

it("keeps the form after an ambiguous save and requires a fresh authoritative list", async () => {
  let calls = 0;
  const serviceCatalogOp = stub(() => {
    calls += 1;
    if (calls === 1) return { ok: true, payload: [] };
    if (calls === 2) return { ok: false, error: "transport disconnected" };
    return { ok: true, payload: [saved] };
  });
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

it("re-applies the same scanned draft after the user closes the filled form", async () => {
  const serviceCatalogOp = stub(() => ({ ok: true, payload: [] }));
  const { rerender } = render(<ProjectServiceTemplates projectId={projectId} fillFrom={null} onFillApplied={() => {}} />);
  await screen.findByText("该项目尚未保存服务模板。");
  rerender(<ProjectServiceTemplates projectId={projectId} fillFrom={scannedHint} onFillApplied={() => {}} />);
  expect(await screen.findByLabelText("服务名称")).toHaveValue("dev");
  fireEvent.click(screen.getByRole("button", { name: "关闭编辑" }));
  expect(screen.queryByLabelText("服务名称")).toBeNull();
  rerender(<ProjectServiceTemplates projectId={projectId} fillFrom={null} onFillApplied={() => {}} />);
  rerender(<ProjectServiceTemplates projectId={projectId} fillFrom={scannedHint} onFillApplied={() => {}} />);
  expect(await screen.findByLabelText("服务名称")).toHaveValue("dev");
  expect(serviceCatalogOp).toHaveBeenCalledTimes(1);
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
  stub(() => ({ ok: true, payload: { revisions: [] } }));
  render(<ProjectServiceTemplates projectId={projectId} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("响应无法核对");
  expect(screen.getByRole("button", { name: "添加服务" })).toBeDisabled();
  expect(screen.queryByText("该项目尚未保存服务模板。")).toBeNull();
});

const scannedHint: ServiceImportHintView = {
  source: "package.json", name: "dev", runType: "long-lived", envKeys: ["API_TOKEN"],
  program: "node", args: ["server.js"], workdir: "apps/api",
  invalidVars: ["1BAD"], toVerify: ["API_TOKEN：疑似凭据，请移入本机私有配置"],
};

it("fills the new-template form from one explicit scanned draft and saves nothing", async () => {
  const serviceCatalogOp = stub(() => ({ ok: true, payload: [] }));
  const applied = vi.fn();
  render(<ProjectServiceTemplates projectId={projectId} fillFrom={scannedHint} onFillApplied={applied} />);
  expect(await screen.findByLabelText("服务名称")).toHaveValue("dev");
  expect(screen.getByLabelText("程序名")).toHaveValue("node");
  expect(screen.getByLabelText("参数 1")).toHaveValue("server.js");
  expect(screen.getByLabelText("工作目录")).toHaveValue("apps/api");
  expect(screen.getByLabelText("运行类型")).toHaveValue("long-lived");
  // Empty/false candidates stay visible for review instead of being invented.
  expect(screen.getByLabelText("端口")).toHaveValue("");
  expect(screen.getByLabelText("健康检查")).toHaveValue("");
  expect(screen.getByText(/已从草案填入（package.json · dev）/)).toBeInTheDocument();
  expect(screen.getByText(/变量键：API_TOKEN（值未知，未写入共享模板）/)).toBeInTheDocument();
  expect(screen.getByText(/无效变量：1BAD/)).toBeInTheDocument();
  expect(screen.getByText(/API_TOKEN：疑似凭据/)).toBeInTheDocument();
  expect(applied).toHaveBeenCalledTimes(1);
  expect(serviceCatalogOp).toHaveBeenCalledTimes(1);
  expect(serviceCatalogOp).toHaveBeenCalledWith({ op: "list", projectId });
  fireEvent.click(screen.getByRole("button", { name: "核对保存" }));
  expect(screen.getByText(/待保存：dev/)).toBeInTheDocument();
  expect(serviceCatalogOp).toHaveBeenCalledTimes(1);
});

it("never applies a configuration-only draft as a run unit and never fills without a project", async () => {
  const serviceCatalogOp = stub(() => ({ ok: true, payload: [] }));
  const applied = vi.fn();
  const { unmount } = render(<ProjectServiceTemplates projectId={projectId}
    fillFrom={{ ...scannedHint, source: ".env", name: ".env", runType: null, program: "", args: [], workdir: undefined }} onFillApplied={applied} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("该草案仅为配置来源（如 .env），不能作为运行单元填入服务模板");
  expect(screen.queryByLabelText("服务名称")).toBeNull();
  unmount();
  const second = stub(() => ({ ok: true, payload: [] }));
  render(<ProjectServiceTemplates projectId={null} fillFrom={scannedHint} onFillApplied={applied} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("尚无项目上下文，无法填入新建模板");
  expect(screen.queryByLabelText("服务名称")).toBeNull();
  // A refused fill never reports success to the page above it.
  expect(applied).not.toHaveBeenCalled();
  expect(second).not.toHaveBeenCalled();
  expect(serviceCatalogOp).toHaveBeenCalledTimes(1);
});
