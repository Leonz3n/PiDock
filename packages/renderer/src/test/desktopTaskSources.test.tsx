import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesktopTaskSources } from "../components/DesktopTaskSources";
import type { PidockBridge } from "../data/shellBridge";

// Seam: [PiDock 03] (#6) the desktop 'add repositories' entry. It drives the
// production append channel (`shell/appendTaskRepos`) and shows main's named
// refusals; the page holds no path, no git and no conflict scan. The recovery
// section it renders is the ONE existing prepare surface, so append and resume
// tell one story.

const taskId = "task-abcdef12";
const projectId = "bcedc870-22bd-474e-ac55-78d30a9d763d";
const first = { id: "dad5fcb4-c91f-4ab0-bc33-fbb82053f871", name: "Web", path: "/local/web" };
const second = { id: "3f8e1c02-77aa-4d1e-8b60-2a9c9d0f1b23", name: "API", path: "/local/api" };
const roots = [{ label: "默认任务根", state: "ready" }];

/** Exactly what the append channel accepts: ids and refs, never a path. */
interface AppendRequest {
  taskId: string;
  repositories: { sourceId: string; remote: string; remoteBranch: string }[];
}

/** The desktop shell exposes exactly one bridge: `window.pidock`. */
function withBridge(value: PidockBridge): PidockBridge {
  window.pidock = value;
  return value;
}

function bridge(overrides: Partial<PidockBridge> = {}): PidockBridge {
  return {
    listTasks: vi.fn(async () => ({
      ok: true,
      payload: { tasks: [{ taskId, name: "Task", branch: `task/${taskId}`, repoCount: 1, updatedAt: "now" }], roots },
    })),
    projectOp: vi.fn(async (request) => ({
      ok: true,
      payload:
        request.op === "list"
          ? { initialized: true, projects: [{ id: projectId, name: "Real", description: "", repositories: [first, second], directories: [] }] }
          : { roots, tasks: [{ taskId, projectId, state: "assigned" }] },
    })),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  delete window.pidock;
});

describe("Desktop append surface", () => {
  it("appends through the production channel with project repository ids only, and reports the pinned commit and worktree", async () => {
    const appendTaskRepos = vi.fn(async (request: AppendRequest) => {
      const [selection] = request.repositories;
      return {
        ok: true,
        payload: {
          taskId: request.taskId,
          appended: [
            {
              repoDir: `repo-${selection!.sourceId.slice(0, 8)}`,
              name: "API",
              remote: selection!.remote,
              remoteBranch: selection!.remoteBranch,
              commit: "a".repeat(40),
              worktree: `/local/tasks/${taskId}/repo-${selection!.sourceId.slice(0, 8)}`,
            },
          ],
          skipped: [],
        },
      };
    });
    const onAppended = vi.fn();
    render(<DesktopTaskSources taskId={taskId} bridge={withBridge(bridge({ appendTaskRepos }))} onClose={vi.fn()} onAppended={onAppended} />);
    const api = await screen.findByRole("checkbox", { name: "API" });
    fireEvent.click(api);
    fireEvent.change(screen.getByLabelText("远程名称 API"), { target: { value: "origin" } });
    fireEvent.change(screen.getByLabelText("远程分支 API"), { target: { value: "main" } });
    fireEvent.click(screen.getByRole("button", { name: /获取最新基线并追加/ }));
    await waitFor(() =>
      expect(appendTaskRepos).toHaveBeenCalledWith({
        taskId,
        repositories: [{ sourceId: second.id, remote: "origin", remoteBranch: "main" }],
      }),
    );
    const outcome = await screen.findByTestId("append-outcome");
    expect(outcome).toHaveTextContent("本次已追加 1 个仓库");
    expect(outcome).toHaveTextContent("a".repeat(40));
    expect(outcome).toHaveTextContent(`/local/tasks/${taskId}/repo-${second.id.slice(0, 8)}`);
    expect(onAppended).toHaveBeenCalledTimes(1);
    // No renderer-side path, scan or folder name entered the request.
    const [request] = appendTaskRepos.mock.calls[0]!;
    expect(JSON.stringify(request)).not.toContain("/local/api");
    expect(JSON.stringify(request)).not.toContain("takenPaths");
  });

  it("keeps the selection and shows main's real refusal, then retries the same intent", async () => {
    const appendTaskRepos = vi.fn(async (_request: AppendRequest) => ({
      ok: false,
      error: "fetch-failed: 仓库 repo-3f8e1c02（API）获取 origin/main 失败（远程分支不存在或已删除），已保留表单，请重试获取后再追加",
    }));
    const onAppended = vi.fn();
    render(<DesktopTaskSources taskId={taskId} bridge={withBridge(bridge({ appendTaskRepos }))} onClose={vi.fn()} onAppended={onAppended} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "API" }));
    fireEvent.change(screen.getByLabelText("远程名称 API"), { target: { value: "origin" } });
    fireEvent.change(screen.getByLabelText("远程分支 API"), { target: { value: "main" } });
    fireEvent.click(screen.getByRole("button", { name: /获取最新基线并追加/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("fetch-failed");
    expect(alert).toHaveTextContent("远程分支不存在或已删除");
    expect(screen.queryByTestId("append-outcome")).not.toBeInTheDocument();
    // The form kept its intent: the same button retries the same request.
    expect(screen.getByRole("checkbox", { name: "API" })).toBeChecked();
    expect(screen.getByLabelText("远程分支 API")).toHaveValue("main");
    fireEvent.click(screen.getByRole("button", { name: /获取最新基线并追加/ }));
    await waitFor(() => expect(appendTaskRepos).toHaveBeenCalledTimes(2));
    expect(appendTaskRepos.mock.calls.map(([request]) => request)).toEqual([
      { taskId, repositories: [{ sourceId: second.id, remote: "origin", remoteBranch: "main" }] },
      { taskId, repositories: [{ sourceId: second.id, remote: "origin", remoteBranch: "main" }] },
    ]);
    expect(onAppended).not.toHaveBeenCalled();
  });

  it("shows the Host's conflict reason by name and reports an already-present repo as skipped", async () => {
    const conflict = vi.fn(async (_request: AppendRequest) => ({ ok: false, error: `branch-in-use: 分支已在其他 worktree 使用: task/${taskId}，请更换任务分支` }));
    const view = render(<DesktopTaskSources taskId={taskId} bridge={withBridge(bridge({ appendTaskRepos: conflict }))} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "API" }));
    fireEvent.change(screen.getByLabelText("远程名称 API"), { target: { value: "origin" } });
    fireEvent.change(screen.getByLabelText("远程分支 API"), { target: { value: "main" } });
    fireEvent.click(screen.getByRole("button", { name: /获取最新基线并追加/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("branch-in-use");
    view.unmount();
    const skipped = vi.fn(async (_request: AppendRequest) => ({ ok: true, payload: { taskId, appended: [], skipped: [{ repoDir: `repo-${first.id.slice(0, 8)}`, name: "Web" }] } }));
    render(<DesktopTaskSources taskId={taskId} bridge={withBridge(bridge({ appendTaskRepos: skipped }))} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Web" }));
    fireEvent.change(screen.getByLabelText("远程名称 Web"), { target: { value: "origin" } });
    fireEvent.change(screen.getByLabelText("远程分支 Web"), { target: { value: "main" } });
    fireEvent.click(screen.getByRole("button", { name: /获取最新基线并追加/ }));
    const outcome = await screen.findByTestId("append-outcome");
    expect(outcome).toHaveTextContent("已在任务中，未重复创建：Web");
    expect(outcome).toHaveTextContent("本次没有新增仓库");
  });

  it("refuses a task without a confirmed project association instead of guessing a project", async () => {
    const request = vi.fn(async (input: { op: string }) => ({
      ok: true,
      payload:
        input.op === "list"
          ? { initialized: true, projects: [{ id: projectId, name: "Real", description: "", repositories: [first], directories: [] }] }
          : { roots, tasks: [{ taskId, projectId: null, state: "unassigned" }] },
    }));
    render(<DesktopTaskSources taskId={taskId} bridge={withBridge(bridge({ projectOp: request as unknown as PidockBridge["projectOp"] }))} onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("任务与项目没有可确认的关联（unassigned）");
    expect(screen.queryByRole("checkbox", { name: "Web" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /获取最新基线并追加/ })).toBeDisabled();
  });

  it("keeps the form when the response cannot be verified, and points a partial append at the existing recovery surface", async () => {
    const malformed = vi.fn(async (_request: AppendRequest) => ({ ok: true, payload: { taskId, appended: [{ repoDir: "repo-x" }], skipped: [] } }));
    const prepareStatus = vi.fn(async (_taskId: string) => ({
      ok: true,
      payload: {
        outcomes: [{ repoDir: "repo-x", status: "pending" }],
        created: [],
        pending: ["repo-x"],
        failed: [],
        retry: ["repo-x"],
        hold: [],
        resumed: false,
      },
    }));
    const taskOp = vi.fn(async (id: string, op: string, payload?: Record<string, unknown>) => {
      void op;
      void payload;
      return prepareStatus(id);
    });
    render(
      <DesktopTaskSources
        taskId={taskId}
        bridge={withBridge(bridge({ appendTaskRepos: malformed, taskOp: taskOp as unknown as PidockBridge["taskOp"] }))}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("checkbox", { name: "Web" }));
    fireEvent.change(screen.getByLabelText("远程名称 Web"), { target: { value: "origin" } });
    fireEvent.change(screen.getByLabelText("远程分支 Web"), { target: { value: "main" } });
    fireEvent.click(screen.getByRole("button", { name: /获取最新基线并追加/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("追加结果无法核验");
    // The one recovery surface: a real prepare read with the Host's rows and a
    // resume action main supplies the scan for.
    fireEvent.click(screen.getByRole("button", { name: "检查准备状态" }));
    await waitFor(() => expect(taskOp).toHaveBeenCalledWith(taskId, "task/prepareStatus", {}));
    expect(await screen.findByTestId("prepare-status-rows")).toHaveTextContent("待准备");
    expect(screen.getByRole("button", { name: "继续准备未完成的仓库" })).toBeEnabled();
  });
});
