import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopEnvironmentPage } from "../components/DesktopEnvironmentPage";

afterEach(() => { cleanup(); delete window.pidock; });

it("preserves the prototype environment layout while refusing invented configuration", () => {
  const onSelectProject = vi.fn();
  render(<DesktopEnvironmentPage projects={[{ id: "p1", name: "真实项目" }, { id: "p2", name: "第二项目" }]} projectId="p1" taskCount={2} tasks={[]} onSelectProject={onSelectProject} />);
  expect(screen.getByRole("heading", { name: "环境与服务" })).toBeInTheDocument();
  expect(screen.getByLabelText("项目")).toHaveValue("p1");
  expect(screen.getByText("关联任务 2")).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "KEY" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "VALUE" })).toBeInTheDocument();
  expect(screen.getByText(/这里不展示示例 KEY 或 VALUE/)).toBeInTheDocument();
  expect(screen.getByText("服务配方目录未接线")).toBeInTheDocument();
  for (const name of ["管理环境", "新增环境", "任务覆盖", "共享模板", "本机私有配置", "保存更改", "添加服务"]) expect(screen.getByRole("button", { name })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("项目"), { target: { value: "p2" } });
  expect(onSelectProject).toHaveBeenCalledWith("p2");
});

it("shows only Host-scanned drafts for the selected task and worktree", async () => {
  const taskOp = vi.fn(async (_taskId: string, op: string) => op === "task/fileRoots"
    ? { ok: true, payload: { taskDir: "/task", roots: [{ id: "repo", kind: "worktree", label: "invoice", path: "/task/repo" }, { id: "link", kind: "shared-dir", label: "shared", path: "/tmp/shared" }] } }
    : { ok: true, payload: { scan: { hints: [{ source: "package.json", name: "dev", runType: "long-lived", runTypeBasis: "名称含常驻关键字 dev/start/serve/watch", runTypeUncertain: false, variables: [{ key: "API_TOKEN", source: "package.json", maskedValue: "••••••••" }], program: "node", args: ["server.js"], invalidVars: [], toVerify: ["API_TOKEN：疑似凭据"] }], errors: [], truncated: false } } });
  window.pidock = { taskOp };
  render(<DesktopEnvironmentPage projects={[{ id: "p1", name: "真实项目" }]} projectId="p1" taskCount={1} tasks={[{ taskId: "task-1", name: "真实任务" }]} onSelectProject={() => {}} />);
  expect(await screen.findByRole("option", { name: "invoice" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "shared" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "扫描仓库" }));
  expect(await screen.findByText("API_TOKEN：疑似凭据")).toBeInTheDocument();
  expect(screen.getByText("常驻服务")).toBeInTheDocument();
  expect(screen.getByText("命令候选：node server.js")).toBeInTheDocument();
  expect(taskOp).toHaveBeenCalledWith("task-1", "task/serviceImportHints", { rootId: "repo" });
  expect(screen.getByRole("button", { name: "添加服务" })).toBeDisabled();
});

it("fills the new-template form only after the explicit draft action and never for a config-only hint", async () => {
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => request["op"] === "list" ? { ok: true, payload: [] } : { ok: true, payload: [] });
  const taskOp = vi.fn(async (_taskId: string, op: string) => op === "task/fileRoots"
    ? { ok: true, payload: { taskDir: "/task", roots: [{ id: "repo", kind: "worktree", label: "invoice", path: "/task/repo" }] } }
    : { ok: true, payload: { scan: { hints: [
      { source: "package.json", name: "dev", runType: "long-lived", runTypeBasis: "名称含常驻关键字 dev/start/serve/watch", runTypeUncertain: false, variables: [{ key: "API_TOKEN", source: "package.json", maskedValue: "••••••••" }], program: "node", args: ["server.js"], workdir: "apps/api", invalidVars: ["1BAD"], toVerify: ["API_TOKEN：疑似凭据"] },
      { source: ".env", name: ".env", runType: null, runTypeBasis: "配置文件本身不是运行单元", runTypeUncertain: false, variables: [{ key: "PORT", source: ".env", maskedValue: "••••••••" }], program: "", args: [], invalidVars: [], toVerify: ["语法及业务读取点需人工核对"] },
    ], errors: [], truncated: false } } });
  window.pidock = { taskOp, serviceCatalogOp };
  render(<DesktopEnvironmentPage projects={[{ id: "p1", name: "真实项目" }]} projectId="p1" taskCount={1} tasks={[{ taskId: "task-1", name: "真实任务" }]} onSelectProject={() => {}} />);
  await screen.findByRole("option", { name: "invoice" });
  fireEvent.click(screen.getByRole("button", { name: "扫描仓库" }));
  await screen.findByText("命令候选：node server.js");
  // Nothing is filled, saved or bound until the human asks for it.
  expect(screen.queryByLabelText("服务名称")).toBeNull();
  expect(serviceCatalogOp).toHaveBeenCalledTimes(1);
  expect(serviceCatalogOp).toHaveBeenCalledWith({ op: "list", projectId: "p1" });
  expect(screen.getByRole("button", { name: "仅配置来源" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "填入新建模板" }));
  expect(await screen.findByLabelText("服务名称")).toHaveValue("dev");
  expect(screen.getByLabelText("程序名")).toHaveValue("node");
  expect(screen.getByLabelText("工作目录")).toHaveValue("apps/api");
  expect(screen.getByLabelText("端口")).toHaveValue("");
  expect(screen.getByText(/已从草案填入（package.json · dev）/)).toBeInTheDocument();
  // The invalid key stays visible both in the scanned row and in the filled form.
  expect(screen.getAllByText(/无效变量：1BAD/)).toHaveLength(2);
  expect(screen.getByText(/已把草案「package.json · dev」填入上方新建模板表单；尚未保存。/)).toBeInTheDocument();
  // Fill never wrote anything: only the list read happened.
  expect(serviceCatalogOp).toHaveBeenCalledTimes(1);
});

it("never claims the draft was filled when the template bridge is missing", async () => {
  window.pidock = { taskOp: vi.fn(async (_taskId: string, op: string) => op === "task/fileRoots"
    ? { ok: true, payload: { taskDir: "/task", roots: [{ id: "repo", kind: "worktree", label: "invoice", path: "/task/repo" }] } }
    : { ok: true, payload: { scan: { hints: [
      { source: "package.json", name: "dev", runType: "long-lived", runTypeBasis: "名称含常驻关键字 dev/start/serve/watch", runTypeUncertain: false, variables: [], program: "node", args: ["server.js"], invalidVars: [], toVerify: [] },
    ], errors: [], truncated: false } } }) };
  render(<DesktopEnvironmentPage projects={[{ id: "p1", name: "真实项目" }]} projectId="p1" taskCount={1} tasks={[{ taskId: "task-1", name: "真实任务" }]} onSelectProject={() => {}} />);
  await screen.findByRole("option", { name: "invoice" });
  fireEvent.click(screen.getByRole("button", { name: "扫描仓库" }));
  await screen.findByText("命令候选：node server.js");
  fireEvent.click(screen.getByRole("button", { name: "填入新建模板" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("服务配方目录未接线，无法填入新建模板");
  expect(screen.queryByText(/已把草案/)).toBeNull();
  expect(screen.queryByLabelText("服务名称")).toBeNull();
});

it("re-applies the same scanned draft after the filled form is closed", async () => {
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => request["op"] === "list" ? { ok: true, payload: [] } : { ok: true, payload: [] });
  window.pidock = { serviceCatalogOp, taskOp: vi.fn(async (_taskId: string, op: string) => op === "task/fileRoots"
    ? { ok: true, payload: { taskDir: "/task", roots: [{ id: "repo", kind: "worktree", label: "invoice", path: "/task/repo" }] } }
    : { ok: true, payload: { scan: { hints: [
      { source: "package.json", name: "dev", runType: "long-lived", runTypeBasis: "名称含常驻关键字 dev/start/serve/watch", runTypeUncertain: false, variables: [], program: "node", args: ["server.js"], invalidVars: [], toVerify: [] },
    ], errors: [], truncated: false } } }) };
  render(<DesktopEnvironmentPage projects={[{ id: "p1", name: "真实项目" }]} projectId="p1" taskCount={1} tasks={[{ taskId: "task-1", name: "真实任务" }]} onSelectProject={() => {}} />);
  await screen.findByRole("option", { name: "invoice" });
  fireEvent.click(screen.getByRole("button", { name: "扫描仓库" }));
  await screen.findByText("命令候选：node server.js");
  fireEvent.click(screen.getByRole("button", { name: "填入新建模板" }));
  expect(await screen.findByLabelText("服务名称")).toHaveValue("dev");
  fireEvent.click(screen.getByRole("button", { name: "关闭编辑" }));
  expect(screen.queryByLabelText("服务名称")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "填入新建模板" }));
  expect(await screen.findByLabelText("服务名称")).toHaveValue("dev");
  expect(serviceCatalogOp).toHaveBeenCalledTimes(1);
});

it("shows .env as configuration-only key hints and never a runnable service", async () => {
  window.pidock = { taskOp: vi.fn(async (_taskId, op) => op === "task/fileRoots"
    ? { ok: true, payload: { taskDir: "/task", roots: [{ id: "repo", kind: "worktree", label: "api", path: "/task/repo" }] } }
    : { ok: true, payload: { scan: { hints: [{ source: ".env", name: ".env", runType: null,
      runTypeBasis: "配置文件本身不是运行单元", runTypeUncertain: false, variables: [{ key: "API_TOKEN", source: ".env", maskedValue: "••••••••" }, { key: "PORT", source: ".env", maskedValue: "••••••••" }], program: "", args: [], invalidVars: [], toVerify: ["语法及业务读取点需人工核对"] }], errors: [], truncated: false } } }) };
  render(<DesktopEnvironmentPage projects={[{ id: "p1", name: "真实项目" }]} projectId="p1" taskCount={1} tasks={[{ taskId: "task-1", name: "真实任务" }]} onSelectProject={() => {}} />);
  expect(await screen.findByRole("option", { name: "api" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "扫描仓库" }));
  expect(await screen.findByText("变量：API_TOKEN（来源 .env · 值 ••••••••）、PORT（来源 .env · 值 ••••••••）")).toBeInTheDocument();
  expect(screen.getByText("配置来源")).toBeInTheDocument();
  expect(screen.getByText("配置文件本身不是运行单元")).toBeInTheDocument();
  expect(screen.queryByText("常驻服务")).toBeNull();
  expect(screen.queryByText("一次性命令")).toBeNull();
  expect(screen.queryByText("准备步骤")).toBeNull();
  expect(screen.getByRole("button", { name: "添加服务" })).toBeDisabled();
});

it("discards a late scan from a different task and refuses malformed Host data", async () => {
  let finishFirst: ((value: { ok: boolean; payload: unknown }) => void) | undefined;
  const first = new Promise<{ ok: boolean; payload: unknown }>((resolve) => { finishFirst = resolve; });
  const taskOp = vi.fn(async (taskId: string, op: string) => {
    if (op === "task/fileRoots") return { ok: true, payload: { taskDir: "/task", roots: [{ id: taskId, kind: "worktree", label: taskId, path: `/task/${taskId}` }] } };
    if (taskId === "task-1") return first;
    return { ok: true, payload: { scan: { hints: [{ source: "package.json", name: "invalid", runType: "running", runTypeBasis: "未匹配常驻或准备关键字，按一次性命令处理", runTypeUncertain: false, variables: [], program: "", args: [], invalidVars: [], toVerify: [] }], errors: [], truncated: false } } };
  });
  window.pidock = { taskOp };
  const projects = [{ id: "p1", name: "真实项目" }];
  const tasks = [{ taskId: "task-1", name: "任务一" }, { taskId: "task-2", name: "任务二" }];
  render(<DesktopEnvironmentPage projects={projects} projectId="p1" taskCount={2} tasks={tasks} onSelectProject={() => {}} />);
  expect(await screen.findByRole("option", { name: "task-1" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "扫描仓库" }));
  fireEvent.change(screen.getByLabelText("扫描任务"), { target: { value: "task-2" } });
  await waitFor(() => expect(screen.getByLabelText("扫描仓库来源")).toHaveValue("task-2"));
  finishFirst?.({ ok: true, payload: { scan: { hints: [{ source: "package.json", name: "stale-dev", runType: "long-lived", runTypeBasis: "名称含常驻关键字 dev/start/serve/watch", runTypeUncertain: false, variables: [], program: "", args: [], invalidVars: [], toVerify: [] }], errors: [], truncated: false } } });
  await waitFor(() => expect(screen.queryByText("stale-dev")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "扫描仓库" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Host 导入草案响应无法核对");
  expect(screen.queryByText("invalid")).toBeNull();
});

it("keeps failed repository parsing distinct from a confirmed empty scan", async () => {
  window.pidock = { taskOp: vi.fn(async (_taskId, op) => op === "task/fileRoots"
    ? { ok: true, payload: { taskDir: "/task", roots: [{ id: "repo", kind: "worktree", label: "repo", path: "/task/repo" }] } }
    : { ok: true, payload: { scan: { hints: [], errors: [{ source: "compose.yaml", reason: "Compose YAML 格式无效" }], truncated: false } } }) };
  render(<DesktopEnvironmentPage projects={[{ id: "p1", name: "真实项目" }]} projectId="p1" taskCount={1} tasks={[{ taskId: "task-1", name: "真实任务" }]} onSelectProject={() => {}} />);
  expect(await screen.findByRole("option", { name: "repo" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "扫描仓库" }));
  expect(await screen.findByText("部分配置读取失败，无法确认是否存在草案")).toBeInTheDocument();
  expect(screen.queryByText("未发现可核对的启动草案")).toBeNull();
});

it("does not claim an empty environment when there is no Project", () => {
  render(<DesktopEnvironmentPage projects={[]} projectId={null} taskCount={0} tasks={[]} onSelectProject={() => {}} />);
  expect(screen.getByLabelText("项目")).toBeDisabled();
  expect(screen.getByText("尚无项目上下文")).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "环境清单未接线" })).toBeInTheDocument();
  expect(screen.queryByText("暂无环境")).toBeNull();
});

// [PiDock 04] (#7 box 2) an unclassifiable candidate is shown as unclassified;
// the page never presents it as a resident service and the fill keeps the
// conservative category with the reason attached.
it("shows an unclassified candidate as 待确认 and fills the conservative category, never 常驻服务", async () => {
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => request["op"] === "list" ? { ok: true, payload: [] } : { ok: true, payload: [] });
  const taskOp = vi.fn(async (_taskId: string, op: string) => op === "task/fileRoots"
    ? { ok: true, payload: { taskDir: "/task", roots: [{ id: "repo", kind: "worktree", label: "api", path: "/task/repo" }] } }
    : { ok: true, payload: { scan: { hints: [{ source: "compose.yaml", name: "database", runType: "one-shot",
      runTypeBasis: "配置未给出启动命令，无法判定运行类型", runTypeUncertain: true,
      variables: [{ key: "POSTGRES_PASSWORD", source: "compose.yaml", maskedValue: "••••••••" }],
      program: "", args: [], invalidVars: [], toVerify: ["「database」：配置未给出启动命令，无法判定运行类型；请人工选择常驻服务、一次性命令或准备步骤"] }],
      errors: [], truncated: false } } });
  window.pidock = { taskOp, serviceCatalogOp };
  render(<DesktopEnvironmentPage projects={[{ id: "p1", name: "真实项目" }]} projectId="p1" taskCount={1} tasks={[{ taskId: "task-1", name: "真实任务" }]} onSelectProject={() => {}} />);
  await screen.findByRole("option", { name: "api" });
  fireEvent.click(screen.getByRole("button", { name: "扫描仓库" }));
  expect(await screen.findByText("一次性命令（待确认）")).toBeInTheDocument();
  expect(screen.queryByText("常驻服务")).toBeNull();
  expect(screen.getByText("配置未给出启动命令，无法判定运行类型")).toBeInTheDocument();
  // A credential's value is never rendered, only its source and the mask.
  expect(screen.getByText(/变量：POSTGRES_PASSWORD（来源 compose\.yaml · 值 ••••••••）/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "填入新建模板" }));
  expect(await screen.findByLabelText("运行类型")).toHaveValue("one-shot");
  expect(screen.getByText(/该草案未给出可判定的启动命令，已按最保守的一次性命令填入；请人工选择运行类型/)).toBeInTheDocument();
});
