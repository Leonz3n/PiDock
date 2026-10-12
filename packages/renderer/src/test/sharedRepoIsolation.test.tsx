/**
 * [PiDock 03] (#6 盒子 6) 两个任务共享一个仓库的读法，以及普通目录链接的诚实例外.
 *
 * These tests read the SHIPPED production route: the section is mounted by
 * `DesktopProjectOverview` (the page the desktop shell shows for a project),
 * and every fact on a row travels the real bridge —
 * `task/fileRoots` → `workspaceRootsFromHost` and `task/fileDiff` →
 * `workspaceDiffFromHost`. What they pin down:
 * - two tasks of ONE project repository are shown together with their own path,
 *   own observed branch and own change, and they visibly differ;
 * - the row never presents the pinned baseline as the working branch, and an
 *   unread branch or change names its unknown instead of reading as `main` or
 *   as 干净;
 * - a plain-directory link says 共享原目录，文件未隔离 and shows the Host's named
 *   refusal where a Git view would be — never an independent copy.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopProjectOverview } from "../components/DesktopProjectOverview";
import { SharedRepoIsolation } from "../components/SharedRepoIsolation";

/** The one project repository both tasks use; `repoDir` is derived from its id. */
const REPO_ROOT = "repo-51cd20bb";
const LINK_ROOT = "dir-3f2a11bb";

const tasks = [
  { taskId: "task-aaaa1111", name: "结账改造" },
  { taskId: "task-bbbb2222", name: "发票重开" },
];

/** The real payload shape `task/fileRoots` returns, per task. */
function rootsPayload(taskId: string) {
  const worktree = `/tasks/${taskId}/${REPO_ROOT}`;
  return {
    taskDir: `/tasks/${taskId}`,
    roots: [
      {
        id: REPO_ROOT,
        kind: "worktree",
        label: REPO_ROOT,
        path: worktree,
        repoDir: REPO_ROOT,
        baselineBranch: "main",
        expectedBranch: `task/${taskId}`,
        workingBranch: { state: "observed", value: `task/${taskId}` },
        dirty: { state: "observed", value: taskId === tasks[0]!.taskId },
        baseCommit: "0123456789abcdef0123456789abcdef01234567",
      },
      {
        id: LINK_ROOT,
        kind: "shared-dir",
        label: "invoice-docs",
        path: `/tasks/${taskId}/${LINK_ROOT}`,
        sourcePath: "/work/invoice-docs",
      },
    ],
  };
}

/** One whole-worktree diff per task: A really changed, B really did not. */
function diffPayload(taskId: string, rootId: string, op: string) {
  if (op !== "task/fileDiff") return { ok: true, payload: {} };
  if (rootId === LINK_ROOT) {
    return { ok: false, error: "plain-dir-no-diff: invoice-docs 是普通目录链接，修改影响原文件，不提供 Git 差异；请到原目录用 Git 工具查看" };
  }
  const diff = taskId === tasks[0]!.taskId ? "diff --git a/checkout.ts b/checkout.ts\n-old\n+new\n" : "";
  return { ok: true, payload: { path: "", diff, truncated: false, attribution: { taskId, rootId, rootKind: "worktree", rootLabel: rootId, piWorkDir: `/tasks/${taskId}` } } };
}

function bridge(): void {
  window.pidock = {
    taskOp: async (taskId: string, op: string, payload: Record<string, unknown>) => {
      if (op === "task/fileRoots") return { ok: true, payload: rootsPayload(taskId) };
      return diffPayload(taskId, String(payload["rootId"]), op);
    },
  } as unknown as typeof window.pidock;
}

afterEach(() => {
  cleanup();
  delete (window as { pidock?: unknown }).pidock;
});

describe("[PiDock 03] (#6 盒子 6) two tasks sharing one project repository", () => {
  it("shows both tasks of one repository with their own path, own observed branch and own change", async () => {
    bridge();
    render(<SharedRepoIsolation tasks={tasks} />);
    const group = await screen.findByTestId("worktree-group");
    expect(within(group).getByText(REPO_ROOT)).toBeInTheDocument();
    const rows = await within(group).findAllByTestId("worktree-row");
    expect(rows.map((row) => row.getAttribute("data-task"))).toEqual([tasks[0]!.taskId, tasks[1]!.taskId]);

    // Own paths: two real, different worktree paths of the same repository.
    expect(within(rows[0]!).getByText(`/tasks/${tasks[0]!.taskId}/${REPO_ROOT}`)).toBeInTheDocument();
    expect(within(rows[1]!).getByText(`/tasks/${tasks[1]!.taskId}/${REPO_ROOT}`)).toBeInTheDocument();

    // Own OBSERVED branches, visibly different, beside the SAME declared baseline.
    expect(within(rows[0]!).getByTestId(`row-working-branch-${tasks[0]!.taskId}`)).toHaveTextContent(`task/${tasks[0]!.taskId}（实测）`);
    expect(within(rows[1]!).getByTestId(`row-working-branch-${tasks[1]!.taskId}`)).toHaveTextContent(`task/${tasks[1]!.taskId}（实测）`);
    expect(within(rows[0]!).getByTestId(`row-working-branch-${tasks[0]!.taskId}`)).not.toHaveTextContent("main");
    // The baseline is labelled as the pinned baseline, never as the working branch.
    expect(within(rows[0]!).getByTestId(`row-baseline-branch-${tasks[0]!.taskId}`)).toHaveTextContent("main（固定）");
    expect(within(rows[1]!).getByTestId(`row-baseline-branch-${tasks[1]!.taskId}`)).toHaveTextContent("main（固定）");
    expect(within(group).getByText(/各有独立工作副本（Git worktree）/)).toBeInTheDocument();

    // Own CHANGES, and they differ: one real diff, one observed empty diff.
    expect(await within(rows[0]!).findByText("有改动（实测：与基线 0123456 的差异 3 行；有未提交或未跟踪文件（实测））")).toBeInTheDocument();
    expect(within(rows[0]!).getByTestId(`row-diff-${tasks[0]!.taskId}`)).toHaveTextContent("+new");
    expect(within(rows[1]!).getByTestId(`row-change-${tasks[1]!.taskId}`)).toHaveTextContent("无改动（实测：与基线 0123456 的差异为空，且无未提交或未跟踪文件）");
    expect(within(rows[1]!).queryByTestId(`row-diff-${tasks[1]!.taskId}`)).not.toBeInTheDocument();
  });

  it("shows a shared plain-directory link as 共享原目录，文件未隔离 with a named refusal instead of a Git view", async () => {
    bridge();
    render(<SharedRepoIsolation tasks={tasks} />);
    const group = await screen.findByTestId("shared-dir-group");
    const rows = await within(group).findAllByTestId("shared-dir-row");
    expect(rows).toHaveLength(2);
    for (const [index, row] of rows.entries()) {
      const taskId = tasks[index]!.taskId;
      expect(within(row).getByTestId(`row-link-isolation-${taskId}`)).toHaveTextContent("共享原目录，文件未隔离");
      expect(within(row).getByTestId(`row-link-isolation-${taskId}`)).toHaveTextContent("不是独立副本");
      expect(within(row).getByText("/work/invoice-docs")).toBeInTheDocument();
      // No Git view, and the refusal is the Host's own named one.
      const git = await within(row).findByTestId(`row-link-git-${taskId}`);
      expect(git).toHaveTextContent("无 Git 视图（Host 具名拒绝）");
      expect(git).toHaveTextContent("plain-dir-no-diff:");
      expect(within(row).queryByTestId(`row-diff-${taskId}`)).not.toBeInTheDocument();
    }
    expect(within(group).getByTestId(`shared-dir-group-note-${LINK_ROOT}`)).toHaveTextContent("共享原目录，文件未隔离，写入会互相影响");
  });

  it("names an unread branch and an unread change instead of showing the baseline or 干净", async () => {
    window.pidock = {
      taskOp: async (taskId: string, op: string, payload: Record<string, unknown>) =>
        op === "task/fileRoots"
          ? {
              ok: true,
              payload: {
                taskDir: `/tasks/${taskId}`,
                roots: [
                  {
                    id: REPO_ROOT,
                    kind: "worktree",
                    label: REPO_ROOT,
                    path: `/tasks/${taskId}/${REPO_ROOT}`,
                    baselineBranch: "main",
                    expectedBranch: `task/${taskId}`,
                    workingBranch: { state: "unknown", reason: "工作副本不在任何分支上（分离头指针）" },
                    dirty: { state: "unknown", reason: "读取 Git 状态超时" },
                  },
                ],
              },
            }
          : { ok: false, error: (payload["rootId"] === REPO_ROOT ? "读取 Git 状态超时" : "unexpected") },
    } as unknown as typeof window.pidock;
    render(<SharedRepoIsolation tasks={[tasks[0]!]} />);
    const row = await screen.findByTestId("worktree-row");
    const branch = within(row).getByTestId(`row-working-branch-${tasks[0]!.taskId}`);
    expect(branch).toHaveTextContent("未实测：工作副本不在任何分支上（分离头指针）");
    expect(branch).not.toHaveTextContent("main");
    const change = within(row).getByTestId(`row-change-${tasks[0]!.taskId}`);
    expect(change).toHaveTextContent("未实测：与固定基线的差异（任务记录未给出基线提交）未读取（读取 Git 状态超时）");
    expect(change).toHaveTextContent("未提交或未跟踪状态未实测（读取 Git 状态超时）");
    expect(change).not.toHaveTextContent("无改动");
    expect(change).not.toHaveTextContent("干净");
  });

  it("is reached from the desktop Project page, not from a fixture path", async () => {
    bridge();
    render(
      <DesktopProjectOverview
        project={{
          id: "project-1",
          name: "Genuine",
          description: "",
          repositories: [{ id: "11111111-1111-1111-1111-111111111111", name: "source", path: "/work/source" }],
          directories: [{ id: "22222222-2222-2222-2222-222222222222", name: "invoice-docs", path: "/work/invoice-docs" }],
        }}
        tasks={tasks.map((task) => ({ ...task, branch: `task/${task.taskId}`, repoCount: 1, updatedAt: "2026-09-22", projectId: "project-1" }))}
        lifecyclePending={false}
        associations={tasks.map((task) => ({ taskId: task.taskId, projectId: "project-1", state: "assigned" as const }))}
        roots={[{ label: "tasks", state: "ready" }]}
        projectsInitialized
        onOpenTask={() => {}}
        onManage={() => {}}
        onCreateTask={() => {}}
        onManageDirectories={() => {}}
      />,
    );
    expect(await screen.findByTestId("desktop-project-overview")).toBeInTheDocument();
    const section = await screen.findByTestId("shared-repo-isolation");
    expect(within(section).getByText(`/tasks/${tasks[0]!.taskId}/${REPO_ROOT}`)).toBeInTheDocument();
    await waitFor(() => expect(within(section).getAllByTestId("worktree-row")).toHaveLength(2));
    expect(within(section).getByTestId(`row-working-branch-${tasks[1]!.taskId}`)).toHaveTextContent(`task/${tasks[1]!.taskId}（实测）`);
  });
});
