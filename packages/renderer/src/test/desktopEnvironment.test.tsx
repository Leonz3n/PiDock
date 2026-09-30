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
    : { ok: true, payload: { scan: { hints: [{ source: "package.json", name: "dev", runType: "long-lived", envKeys: ["API_TOKEN"], invalidVars: [], toVerify: ["API_TOKEN：疑似凭据"] }], errors: [], truncated: false } } });
  window.pidock = { taskOp };
  render(<DesktopEnvironmentPage projects={[{ id: "p1", name: "真实项目" }]} projectId="p1" taskCount={1} tasks={[{ taskId: "task-1", name: "真实任务" }]} onSelectProject={() => {}} />);
  expect(await screen.findByRole("option", { name: "invoice" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "shared" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "扫描仓库" }));
  expect(await screen.findByText("API_TOKEN：疑似凭据")).toBeInTheDocument();
  expect(screen.getByText("常驻服务")).toBeInTheDocument();
  expect(taskOp).toHaveBeenCalledWith("task-1", "task/serviceImportHints", { rootId: "repo" });
  expect(screen.getByRole("button", { name: "添加服务" })).toBeDisabled();
});

it("discards a late scan from a different task and refuses malformed Host data", async () => {
  let finishFirst: ((value: { ok: boolean; payload: unknown }) => void) | undefined;
  const first = new Promise<{ ok: boolean; payload: unknown }>((resolve) => { finishFirst = resolve; });
  const taskOp = vi.fn(async (taskId: string, op: string) => {
    if (op === "task/fileRoots") return { ok: true, payload: { taskDir: "/task", roots: [{ id: taskId, kind: "worktree", label: taskId, path: `/task/${taskId}` }] } };
    if (taskId === "task-1") return first;
    return { ok: true, payload: { scan: { hints: [{ source: "package.json", name: "invalid", runType: "running", envKeys: [], invalidVars: [], toVerify: [] }], errors: [], truncated: false } } };
  });
  window.pidock = { taskOp };
  const projects = [{ id: "p1", name: "真实项目" }];
  const tasks = [{ taskId: "task-1", name: "任务一" }, { taskId: "task-2", name: "任务二" }];
  render(<DesktopEnvironmentPage projects={projects} projectId="p1" taskCount={2} tasks={tasks} onSelectProject={() => {}} />);
  expect(await screen.findByRole("option", { name: "task-1" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "扫描仓库" }));
  fireEvent.change(screen.getByLabelText("扫描任务"), { target: { value: "task-2" } });
  await waitFor(() => expect(screen.getByLabelText("扫描仓库来源")).toHaveValue("task-2"));
  finishFirst?.({ ok: true, payload: { scan: { hints: [{ source: "package.json", name: "stale-dev", runType: "long-lived", envKeys: [], invalidVars: [], toVerify: [] }], errors: [], truncated: false } } });
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
