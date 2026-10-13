import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopEnvironmentPage } from "../components/DesktopEnvironmentPage";
import { ServiceCatalog } from "../../../shell/src/main/service-catalog.js";
import { performServiceCatalogOperation } from "../../../shell/src/main/service-catalog-ipc.js";
import { serviceRestartConsequence } from "../../../shell/src/main/runtime.js";
import type { ShellTaskOpResult } from "../data/shellBridge";

const ENVIRONMENT_ID = "e-11111111-1111-1111-1111-111111111111";
/** Main validates the ids it owns, so the production-path test below uses real shapes. */
const PROJECT_ID = "b36323d3-ff33-4e34-a873-536a9775788a";
const environment = { projectId: "p1", environmentId: ENVIRONMENT_ID, name: "本地开发" };
const projects = [{ id: "p1", name: "真实项目" }];

const directories: string[] = [];
afterEach(() => {
  cleanup();
  delete window.pidock;
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One project environment answer, then whatever the test needs for the rest of the ops. */
function catalog(reply: (request: Record<string, unknown>) => ShellTaskOpResult | null = () => null) {
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => {
    if (request["op"] === "listEnvironments") return { ok: true, payload: [environment] };
    return reply(request) ?? { ok: true, payload: [] };
  });
  return serviceCatalogOp;
}

/** The human act under test: pick the environment the page must edit. */
async function selectEnvironment() {
  await screen.findByRole("option", { name: "本地开发" });
  fireEvent.change(screen.getByLabelText("环境"), { target: { value: ENVIRONMENT_ID } });
}

it("preserves the prototype environment layout while refusing invented configuration", () => {
  const onSelectProject = vi.fn();
  render(<DesktopEnvironmentPage projects={[{ id: "p1", name: "真实项目" }, { id: "p2", name: "第二项目" }]} projectId="p1" taskCount={2} tasks={[]} onSelectProject={onSelectProject} />);
  expect(screen.getByRole("heading", { name: "环境与服务" })).toBeInTheDocument();
  expect(screen.getByLabelText("项目")).toHaveValue("p1");
  expect(screen.getByText("关联任务 2")).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "KEY" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "VALUE" })).toBeInTheDocument();
  expect(screen.getByText(/这里不展示示例 KEY 或 VALUE/)).toBeInTheDocument();
  // The environment model is real now; the configuration half below is still not wired.
  expect(screen.getAllByText("服务配方目录未接线")).toHaveLength(2);
  expect(screen.queryByText(/环境模型未接线/)).toBeNull();
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

it("names a blank scan field instead of an empty draft heading, basis or note", async () => {
  // `serviceImportScanFromHost` reads `name`, `runTypeBasis`, `invalidVars[]`,
  // `toVerify[]` and an error `reason` with `shortText` (a length cap only), so
  // all of them can be `""`; each names its own absence instead of rendering a
  // nameless draft, an empty right-hand column or a blank paragraph.
  const taskOp = vi.fn(async (_taskId: string, op: string) => op === "task/fileRoots"
    ? { ok: true, payload: { taskDir: "/task", roots: [{ id: "repo", kind: "worktree", label: "invoice", path: "/task/repo" }] } }
    : { ok: true, payload: { scan: { hints: [
      { source: "package.json", name: "", runType: "long-lived", runTypeBasis: "", runTypeUncertain: false, variables: [], program: "node", args: ["server.js"], invalidVars: [""], toVerify: [""] },
    ], errors: [{ source: "compose.yaml", reason: "" }], truncated: false } } });
  window.pidock = { taskOp };
  render(<DesktopEnvironmentPage projects={[{ id: "p1", name: "真实项目" }]} projectId="p1" taskCount={1} tasks={[{ taskId: "task-1", name: "真实任务" }]} onSelectProject={() => {}} />);
  await screen.findByRole("option", { name: "invoice" });
  fireEvent.click(screen.getByRole("button", { name: "扫描仓库" }));
  expect(await screen.findByText("Host 未上报候选名称")).toBeInTheDocument();
  expect(screen.getByText("Host 未上报判定依据")).toBeInTheDocument();
  expect(screen.getByText("无效变量：Host 未上报变量名")).toBeInTheDocument();
  expect(screen.getByText("Host 未上报待核对项")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("compose.yaml：Host 未给出原因");
});

it("names an empty root label in the repository choice instead of a blank option", async () => {
  // A label the Host sent as `""` survives `workspaceRootsFromHost` (`str()`
  // keeps it), so the repo choice is where it must be named, not offered blank.
  const taskOp = vi.fn(async (_taskId: string, op: string) => op === "task/fileRoots"
    ? { ok: true, payload: { taskDir: "/task", roots: [{ id: "repo", kind: "worktree", label: "", path: "/task/repo" }] } }
    : { ok: true, payload: { scan: { hints: [], errors: [], truncated: false } } });
  window.pidock = { taskOp };
  render(<DesktopEnvironmentPage projects={projects} projectId="p1" taskCount={1} tasks={[{ taskId: "task-1", name: "真实任务" }]} onSelectProject={() => {}} />);
  const choice = await screen.findByLabelText("扫描仓库来源");
  expect(within(choice).getByRole("option", { name: "Host 未上报根名称" })).toBeInTheDocument();
});

it("fills the new-template form only after the explicit draft action and never for a config-only hint", async () => {
  const serviceCatalogOp = catalog();
  const taskOp = vi.fn(async (_taskId: string, op: string) => op === "task/fileRoots"
    ? { ok: true, payload: { taskDir: "/task", roots: [{ id: "repo", kind: "worktree", label: "invoice", path: "/task/repo" }] } }
    : { ok: true, payload: { scan: { hints: [
      { source: "package.json", name: "dev", runType: "long-lived", runTypeBasis: "名称含常驻关键字 dev/start/serve/watch", runTypeUncertain: false, variables: [{ key: "API_TOKEN", source: "package.json", maskedValue: "••••••••" }], program: "node", args: ["server.js"], workdir: "apps/api", invalidVars: ["1BAD"], toVerify: ["API_TOKEN：疑似凭据"] },
      { source: ".env", name: ".env", runType: null, runTypeBasis: "配置文件本身不是运行单元", runTypeUncertain: false, variables: [{ key: "PORT", source: ".env", maskedValue: "••••••••" }], program: "", args: [], invalidVars: [], toVerify: ["语法及业务读取点需人工核对"] },
    ], errors: [], truncated: false } } });
  window.pidock = { taskOp, serviceCatalogOp };
  render(<DesktopEnvironmentPage projects={[{ id: "p1", name: "真实项目" }]} projectId="p1" taskCount={1} tasks={[{ taskId: "task-1", name: "真实任务" }]} onSelectProject={() => {}} />);
  await selectEnvironment();
  await screen.findByRole("option", { name: "invoice" });
  fireEvent.click(screen.getByRole("button", { name: "扫描仓库" }));
  await screen.findByText("命令候选：node server.js");
  // Nothing is filled, saved or bound until the human asks for it.
  expect(screen.queryByLabelText("服务名称")).toBeNull();
  expect(serviceCatalogOp).toHaveBeenCalledTimes(2);
  expect(serviceCatalogOp).toHaveBeenCalledWith({ op: "list", projectId: "p1", environmentId: ENVIRONMENT_ID });
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
  // Fill never wrote anything: only the environment list read and the list read happened.
  expect(serviceCatalogOp).toHaveBeenCalledTimes(2);
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
  const serviceCatalogOp = catalog();
  window.pidock = { serviceCatalogOp, taskOp: vi.fn(async (_taskId: string, op: string) => op === "task/fileRoots"
    ? { ok: true, payload: { taskDir: "/task", roots: [{ id: "repo", kind: "worktree", label: "invoice", path: "/task/repo" }] } }
    : { ok: true, payload: { scan: { hints: [
      { source: "package.json", name: "dev", runType: "long-lived", runTypeBasis: "名称含常驻关键字 dev/start/serve/watch", runTypeUncertain: false, variables: [], program: "node", args: ["server.js"], invalidVars: [], toVerify: [] },
    ], errors: [], truncated: false } } }) };
  render(<DesktopEnvironmentPage projects={[{ id: "p1", name: "真实项目" }]} projectId="p1" taskCount={1} tasks={[{ taskId: "task-1", name: "真实任务" }]} onSelectProject={() => {}} />);
  await selectEnvironment();
  await screen.findByRole("option", { name: "invoice" });
  fireEvent.click(screen.getByRole("button", { name: "扫描仓库" }));
  await screen.findByText("命令候选：node server.js");
  fireEvent.click(screen.getByRole("button", { name: "填入新建模板" }));
  expect(await screen.findByLabelText("服务名称")).toHaveValue("dev");
  fireEvent.click(screen.getByRole("button", { name: "关闭编辑" }));
  expect(screen.queryByLabelText("服务名称")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "填入新建模板" }));
  expect(await screen.findByLabelText("服务名称")).toHaveValue("dev");
  expect(serviceCatalogOp).toHaveBeenCalledTimes(2);
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
  expect(screen.getByRole("option", { name: "尚未选择环境" })).toBeInTheDocument();
  expect(screen.queryByText(/环境清单未接线/)).toBeNull();
  expect(screen.queryByText(/暂无环境/)).toBeNull();
  expect(screen.queryByText(/正在读取环境清单/)).toBeNull();
});

// [PiDock 04] (#7 box 2) an unclassifiable candidate is shown as unclassified;
// the page never presents it as a resident service and the fill keeps the
// conservative category with the reason attached.
it("shows an unclassified candidate as 待确认 and fills the conservative category, never 常驻服务", async () => {
  const serviceCatalogOp = catalog();
  const taskOp = vi.fn(async (_taskId: string, op: string) => op === "task/fileRoots"
    ? { ok: true, payload: { taskDir: "/task", roots: [{ id: "repo", kind: "worktree", label: "api", path: "/task/repo" }] } }
    : { ok: true, payload: { scan: { hints: [{ source: "compose.yaml", name: "database", runType: "one-shot",
      runTypeBasis: "配置未给出启动命令，无法判定运行类型", runTypeUncertain: true,
      variables: [{ key: "POSTGRES_PASSWORD", source: "compose.yaml", maskedValue: "••••••••" }],
      program: "", args: [], invalidVars: [], toVerify: ["「database」：配置未给出启动命令，无法判定运行类型；请人工选择常驻服务、一次性命令或准备步骤"] }],
      errors: [], truncated: false } } });
  window.pidock = { taskOp, serviceCatalogOp };
  render(<DesktopEnvironmentPage projects={[{ id: "p1", name: "真实项目" }]} projectId="p1" taskCount={1} tasks={[{ taskId: "task-1", name: "真实任务" }]} onSelectProject={() => {}} />);
  await selectEnvironment();
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
  expect(serviceCatalogOp).toHaveBeenCalledWith({ op: "list", projectId: "p1", environmentId: ENVIRONMENT_ID });
});

// [PiDock 04] (#7 box 1) the environment dimension itself, through the shipped
// page and the REAL main-process operation + real on-disk store: no fixture
// stands in for the store, so a green result here means the page really drove
// create → list → select → per-environment template read.
it("creates a named environment through the shipped page and edits only that environment's templates", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pidock-env-page-"));
  directories.push(directory);
  const store = new ServiceCatalog(directory, { projectExists: (id) => id === PROJECT_ID, task: () => null });
  const seen: Record<string, unknown>[] = [];
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => {
    seen.push(request);
    try {
      return { ok: true, payload: performServiceCatalogOperation(store, request) } as ShellTaskOpResult;
    } catch (error) {
      const failure = error as { code?: string; message: string };
      return { ok: false, error: `${failure.code ?? "error"}: ${failure.message}` };
    }
  });
  window.pidock = { serviceCatalogOp };
  render(<DesktopEnvironmentPage projects={[{ id: PROJECT_ID, name: "真实项目" }]} projectId={PROJECT_ID} taskCount={1} tasks={[{ taskId: "task-1", name: "真实任务" }]} onSelectProject={() => {}} />);
  // A project nobody named an environment in says exactly that.
  expect(await screen.findByText("该项目尚无环境，请先新增并命名")).toBeInTheDocument();
  expect(screen.getByLabelText("环境")).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "新增环境" }));
  fireEvent.change(screen.getByLabelText("环境名称"), { target: { value: "本地开发" } });
  fireEvent.click(screen.getByRole("button", { name: "保存环境" }));
  // The created environment becomes the selection, and the page reads ITS templates.
  expect(await screen.findByText(/已选环境：本地开发/)).toBeInTheDocument();
  expect(await screen.findByText("该环境尚未保存服务模板。")).toBeInTheDocument();
  const created = seen.find((request) => request["op"] === "createEnvironment");
  expect(created).toEqual({ op: "createEnvironment", projectId: PROJECT_ID, name: "本地开发" });
  const listed = seen.filter((request) => request["op"] === "list");
  const environmentId = String((listed[0] as Record<string, unknown>)["environmentId"]);
  expect(environmentId).toMatch(/^e-[0-9a-f-]{36}$/i);
  // Only main's own document holds it: the page read the same environment it created.
  const document = JSON.parse(readFileSync(join(directory, "service-environments.json"), "utf8")) as { environments: { projectId: string; environmentId: string; name: string }[] };
  expect(document.environments).toEqual([{ projectId: PROJECT_ID, environmentId, name: "本地开发" }]);
  // A second, identically named environment is refused BY NAME and adds no row.
  fireEvent.click(screen.getByRole("button", { name: "新增环境" }));
  fireEvent.change(screen.getByLabelText("环境名称"), { target: { value: "本地开发" } });
  fireEvent.click(screen.getByRole("button", { name: "保存环境" }));
  expect(await screen.findByTestId("desktop-environment-error")).toHaveTextContent("invalid-payload: environment name already used");
  expect(screen.getByLabelText("环境")).toHaveValue(environmentId);
  // No second row reached the disk, and the page still edits the environment it created.
  await waitFor(() => expect(JSON.parse(readFileSync(join(directory, "service-environments.json"), "utf8")).environments).toHaveLength(1));
  expect(screen.getByText(/已选环境：本地开发/)).toBeInTheDocument();
});

it("keeps an unselected or empty environment explicit and never reads a template list for one", async () => {
  const serviceCatalogOp = catalog();
  window.pidock = { serviceCatalogOp };
  render(<DesktopEnvironmentPage projects={projects} projectId="p1" taskCount={0} tasks={[]} onSelectProject={() => {}} />);
  expect(await screen.findByText(/尚未选择环境：下方共享模板按环境保存/)).toBeInTheDocument();
  expect(screen.getByLabelText("环境")).toHaveValue("");
  // No environment was selected, so no template list was read for one.
  expect(serviceCatalogOp).toHaveBeenCalledTimes(1);
  expect(serviceCatalogOp).toHaveBeenCalledWith({ op: "listEnvironments", projectId: "p1" });
  expect(screen.getByText(/尚未选择环境：共享模板按环境保存/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "添加服务" })).toBeDisabled();
});

it("names an unreadable environment list instead of rendering it as zero environments", async () => {
  const serviceCatalogOp = vi.fn(async () => ({ ok: false, error: "Error invoking remote method 'shell/serviceCatalogOp': Error: service environment store unreadable" }));
  window.pidock = { serviceCatalogOp };
  render(<DesktopEnvironmentPage projects={projects} projectId="p1" taskCount={0} tasks={[]} onSelectProject={() => {}} />);
  expect(await screen.findByTestId("desktop-environment-error")).toHaveTextContent("环境清单读取失败");
  expect(screen.getByText("环境清单不可读取")).toBeInTheDocument();
  expect(screen.queryByText("该项目尚无环境，请先新增并命名")).toBeNull();
  // Only the placeholder is selectable: an unreadable list is never a list of environments.
  expect(screen.getByLabelText("环境")).toBeDisabled();
  expect(screen.getByRole("option", { name: "尚未选择环境" })).toBeInTheDocument();
});

it("never reports a create's own row as the whole environment list when the list stays unreadable", async () => {
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => {
    if (request["op"] === "listEnvironments") return { ok: false, error: "环境清单读取失败" };
    if (request["op"] === "createEnvironment") return { ok: true, payload: { projectId: "p1", environmentId: ENVIRONMENT_ID, name: "本地开发" } };
    return { ok: true, payload: [] };
  });
  window.pidock = { serviceCatalogOp };
  render(<DesktopEnvironmentPage projects={projects} projectId="p1" taskCount={0} tasks={[]} onSelectProject={() => {}} />);
  expect(await screen.findByTestId("desktop-environment-error")).toHaveTextContent("环境清单读取失败");
  fireEvent.click(screen.getByRole("button", { name: "新增环境" }));
  fireEvent.change(screen.getByLabelText("环境名称"), { target: { value: "本地开发" } });
  fireEvent.click(screen.getByRole("button", { name: "保存环境" }));
  // The create really succeeded, but the list is still refused: the page says
  // so instead of rendering one row as the observed environment list.
  await waitFor(() => expect(screen.getByText("环境清单不可读取")).toBeInTheDocument());
  expect(screen.queryByText(/环境清单已接线/)).toBeNull();
  expect(screen.queryByText(/已选环境/)).toBeNull();
});

it("re-reads the selected environment on every switch and drops the previous environment's rows", async () => {
  const other = { projectId: "p1", environmentId: "e-22222222-2222-2222-2222-222222222222", name: "预发" };
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => {
    if (request["op"] === "listEnvironments") return { ok: true, payload: [environment, other] };
    if (request["op"] === "list") return { ok: true, payload: [{ projectId: "p1", environmentId: request["environmentId"], serviceId: "s-11111111-1111-1111-1111-111111111111",
      version: 1, shared: [], descriptor: { name: request["environmentId"] === other.environmentId ? "预发服务" : "本地服务", program: "node", args: [], ports: [], runType: "long-lived" } }] };
    return { ok: false, error: `unexpected ${String(request["op"])}` };
  });
  window.pidock = { serviceCatalogOp };
  render(<DesktopEnvironmentPage projects={projects} projectId="p1" taskCount={0} tasks={[]} onSelectProject={() => {}} />);
  await selectEnvironment();
  expect(await screen.findByText("本地服务")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("环境"), { target: { value: other.environmentId } });
  expect(await screen.findByText("预发服务")).toBeInTheDocument();
  expect(screen.queryByText("本地服务")).toBeNull();
  expect(serviceCatalogOp).toHaveBeenLastCalledWith({ op: "list", projectId: "p1", environmentId: other.environmentId });
});

/**
 * [PiDock 04] #7 box 1 (final half) + ADR 0002, driven through the SHIPPED
 * environment page and the REAL catalog store (the same
 * `performServiceCatalogOperation` the IPC handler calls):
 *
 * - the human declares, per environment, which service this one CALLS and which
 *   is its START PRECONDITION;
 * - the declaration is persisted on the revision of THAT environment, the
 *   document stays `version === 2` and the revision the page last read keeps its
 *   own content (an edit mints a new version; nothing re-points a pinned task);
 * - a duplicate declaration is refused BY MAIN, by name, at the page.
 */
it("declares 服务依赖声明 per environment through the shipped page and keeps every earlier revision untouched", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pidock-env-declaration-"));
  directories.push(directory);
  const store = new ServiceCatalog(directory, { projectExists: (id) => id === PROJECT_ID, task: () => null });
  const seen: Record<string, unknown>[] = [];
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => {
    seen.push(request);
    try {
      const payload = performServiceCatalogOperation(store, request) as unknown as Record<string, unknown>;
      // The SHIPPED `shell/serviceCatalogOp` handler answers a review with the
      // honest restart consequence (`runtime.ts serviceRestartConsequence`), so
      // this bridge adds exactly that field instead of inventing one.
      return { ok: true, payload: request["op"] === "update" ? { ...payload, restart: serviceRestartConsequence("update", payload) } : payload } as ShellTaskOpResult;
    } catch (error) {
      const failure = error as { code?: string; message: string };
      return { ok: false, error: `${failure.code ?? "error"}: ${failure.message}` };
    }
  });
  window.pidock = { serviceCatalogOp };
  render(<DesktopEnvironmentPage projects={[{ id: PROJECT_ID, name: "真实项目" }]} projectId={PROJECT_ID} taskCount={0} tasks={[]} onSelectProject={() => {}} />);
  await screen.findByText("该项目尚无环境，请先新增并命名");
  fireEvent.click(screen.getByRole("button", { name: "新增环境" }));
  fireEvent.change(screen.getByLabelText("环境名称"), { target: { value: "本地开发" } });
  fireEvent.click(screen.getByRole("button", { name: "保存环境" }));
  await screen.findByText("该环境尚未保存服务模板。");

  /** One explicit create through the shipped form, filling only what the target rows assert. */
  const addService = async (name: string, port: string) => {
    fireEvent.click(screen.getByRole("button", { name: "添加服务" }));
    fireEvent.change(screen.getByLabelText("服务名称"), { target: { value: name } });
    fireEvent.change(screen.getByLabelText("程序名"), { target: { value: "node" } });
    fireEvent.change(screen.getByLabelText("参数 1"), { target: { value: "server.js" } });
    fireEvent.change(screen.getByLabelText("端口"), { target: { value: port } });
  };
  // The TARGET service first: a declaration may only name a service of this
  // environment that already exists.
  await addService("Callee API", "4100");
  expect(screen.getByText(/本环境还没有其他已保存的服务可作为依赖目标/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "添加依赖" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "核对保存" }));
  fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
  await screen.findByText(/Callee API/);

  // The CALLER: its declaration is made in the same explicit save.
  await addService("Caller API", "4101");
  fireEvent.click(screen.getByRole("button", { name: "添加依赖" }));
  const targets = screen.getByLabelText("依赖目标 1") as HTMLSelectElement;
  const calleeServiceId = targets.value;
  expect(calleeServiceId).toMatch(/^s-[0-9a-f-]{36}$/i);
  expect(screen.getByLabelText("依赖类型 1")).toHaveValue("call");
  fireEvent.click(screen.getByRole("button", { name: "核对保存" }));
  fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
  await screen.findByText("服务依赖声明：调用依赖→Callee API");

  // What the page really sent, and what reached the disk: a sibling key of the
  // revision inside THIS environment's scope, document version unchanged.
  const create = seen.find((request) => request["op"] === "create" && (request["dependencies"] as unknown[] | undefined)?.length === 1);
  expect(create?.["dependencies"]).toEqual([{ to: calleeServiceId, kind: "call" }]);
  const document = JSON.parse(readFileSync(join(directory, "service-templates.json"), "utf8")) as { version: number; revisions: Record<string, unknown>[] };
  expect(document.version).toBe(2);
  const callerRevision = document.revisions.find((row) => row["dependencies"] !== undefined) as Record<string, unknown>;
  expect(Object.keys(callerRevision).sort()).toEqual(["dependencies", "descriptor", "environmentId", "projectId", "serviceId", "shared", "version"]);
  expect(callerRevision["dependencies"]).toEqual([{ to: calleeServiceId, kind: "call" }]);
  // The other service's revision carries no `dependencies` key at all: no
  // declaration is not the same thing as an empty graph.
  expect(Object.keys(document.revisions.find((row) => row !== callerRevision) as Record<string, unknown>)).not.toContain("dependencies");
  const callerServiceId = callerRevision["serviceId"] as string;

  // A second, identical declaration is REFUSED BY NAME by main (the store), and
  // the page shows that refusal instead of saving a graph nobody owns.
  // The list holds the two services in the order the page received them
  // (Callee first), so the second 编辑 belongs to the caller.
  fireEvent.click(screen.getAllByRole("button", { name: "编辑" })[1] as HTMLElement);
  expect(screen.getByLabelText("服务名称")).toHaveValue("Caller API");
  fireEvent.click(screen.getByRole("button", { name: "添加依赖" }));
  expect(screen.getByLabelText("依赖类型 2")).toHaveValue("prestart");
  fireEvent.change(screen.getByLabelText("依赖类型 2"), { target: { value: "call" } });
  fireEvent.click(screen.getByRole("button", { name: "核对新版本" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("duplicate dependency declaration");
  expect(JSON.parse(readFileSync(join(directory, "service-templates.json"), "utf8")).revisions).toHaveLength(2);

  // A refused review parks the form (the page will not save an edit it could not
  // review), so the human re-opens the row - and gets the stored declaration
  // back - before completing it with the two kinds kept distinct.
  fireEvent.click(screen.getByRole("button", { name: "关闭编辑" }));
  fireEvent.click(screen.getAllByRole("button", { name: "编辑" })[1] as HTMLElement);
  expect(screen.getByLabelText("依赖目标 1")).toHaveValue(calleeServiceId);
  expect(screen.getByLabelText("依赖类型 1")).toHaveValue("call");
  fireEvent.click(screen.getByRole("button", { name: "添加依赖" }));
  expect(screen.getByLabelText("依赖类型 2")).toHaveValue("prestart");
  fireEvent.click(screen.getByRole("button", { name: "核对新版本" }));
  await screen.findByText(/将生成 v2（当前 v1） · 待确认/);
  fireEvent.click(screen.getByRole("button", { name: "确认新版本" }));
  // The confirmed save is listed back with BOTH declarations, so the page can
  // show the revision it wrote; the form stays open until the human closes it.
  await screen.findByRole("button", { name: "已保存 v2" });
  expect(screen.getByText(/服务依赖声明差异：有/)).toBeInTheDocument();
  // The page still says what a shared-template save does NOT do to a task: a
  // declaration reaches a task only when that task adopts this revision.
  expect(screen.getByText(/已有任务绑定保留原模板版本/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await screen.findByText("服务依赖声明：调用依赖→Callee API、启动前置→Callee API");
  const saved = JSON.parse(readFileSync(join(directory, "service-templates.json"), "utf8")) as { version: number; revisions: Record<string, unknown>[] };
  expect(saved.version).toBe(2);
  expect(saved.revisions).toHaveLength(3);
  // The revision the page read is byte-identical: an edit appends, it never
  // re-points what a pinned task binding already names.
  expect(saved.revisions.find((row) => row["serviceId"] === callerServiceId && row["version"] === 1)?.["dependencies"])
    .toEqual([{ to: calleeServiceId, kind: "call" }]);
  expect(saved.revisions.find((row) => row["serviceId"] === callerServiceId && row["version"] === 2)?.["dependencies"])
    .toEqual([{ to: calleeServiceId, kind: "call" }, { to: calleeServiceId, kind: "prestart" }]);
}, 30_000);
