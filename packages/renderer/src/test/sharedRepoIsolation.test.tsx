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
import { hostPlatformLabel } from "../../../shell/src/main/service-config.js";
import { LINK_MODEL_VERIFICATION_BOUNDARY, linkCapabilityRows } from "../../../shell/src/main/multi-repo-provision.js";

/**
 * The `task/probeLink` payload the Host really answers with, built from the
 * REAL platform record (`linkCapabilityRows`) so the rows this surface renders
 * are the shipped ones, not a fixture that could drift from them.
 */
function probePayload(shape: string, detail = `Host 观测：${shape}`) {
  return {
    shape,
    detail,
    lexical: "ok",
    linkTarget: null,
    linkTargetInTask: false,
    platforms: linkCapabilityRows(hostPlatformLabel()),
    modelBoundary: LINK_MODEL_VERIFICATION_BOUNDARY,
  };
}

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
      if (op === "task/probeLink") return { ok: true, payload: probePayload("directory", "来源是真实目录: /work/invoice-docs") };
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

  /**
   * [PiDock 03] (#6 box 12) the link's target shape is the Host's OWN reading:
   * 失效/嵌套/循环 are three DIFFERENT named states, never "a directory", and an
   * unread (or refused) probe is a NAME unknown instead of a healthy row. The
   * per-platform record and the 真实 pi boundary come from the same probe.
   */
  it("keeps 失效, 嵌套 and 循环 apart by name and never defaults an unread link to a directory", async () => {
    const threeTasks = [
      { taskId: "task-dead0001", name: "失效链接", sourcePath: "/work/gone-docs" },
      { taskId: "task-nest0002", name: "嵌套链接", sourcePath: "/work/nested-docs" },
      { taskId: "task-cycl0003", name: "循环链接", sourcePath: "/work/cycle-docs" },
    ];
    const shapes: Record<string, { shape: string; detail: string }> = {
      "/work/gone-docs": { shape: "dangling", detail: "链接目标不存在（跟随 1 跳后缺 /work/missing）" },
      "/work/nested-docs": { shape: "nested-link", detail: "来源是软链接，它的目标是另一条软链接（共跟随 2 跳后到达目录 /work/real）" },
      "/work/cycle-docs": { shape: "cyclic-link", detail: "链接链回到已跟随过的链接（已跟随 1 跳后回到）: /work/cycle-b" },
    };
    window.pidock = {
      taskOp: async (taskId: string, op: string, payload: Record<string, unknown>) => {
        if (op === "task/fileRoots") {
          const task = threeTasks.find((row) => row.taskId === taskId)!;
          return { ok: true, payload: { taskDir: `/tasks/${taskId}`, roots: [
            { id: LINK_ROOT, kind: "shared-dir", label: task.name, path: `/tasks/${taskId}/${LINK_ROOT}`, sourcePath: task.sourcePath },
          ] } };
        }
        if (op === "task/probeLink") {
          const sourcePath = String(payload["sourcePath"]);
          if (sourcePath === "/work/refused-docs") return { ok: false, error: "path-out-of-scope: 只探测本任务记录的普通目录来源" };
          const shape = shapes[sourcePath]!;
          return { ok: true, payload: probePayload(shape.shape, shape.detail) };
        }
        if (op === "task/fileDiff") return { ok: false, error: "plain-dir-no-diff: 普通目录链接不提供 Git 差异" };
        return { ok: true, payload: {} };
      },
    } as unknown as typeof window.pidock;
    render(<SharedRepoIsolation tasks={threeTasks} />);
    const rows = await screen.findAllByTestId("shared-dir-row");
    const shapeOf = async (taskId: string) => {
      const row = rows.find((entry) => entry.getAttribute("data-task") === taskId)!;
      return within(row).findByTestId(`row-link-shape-${taskId}`);
    };
    const dead = await shapeOf("task-dead0001");
    const nested = await shapeOf("task-nest0002");
    const cycle = await shapeOf("task-cycl0003");
    expect(dead).toHaveTextContent("失效：链接目标已不存在");
    expect(dead).toHaveAttribute("data-shape", "dangling");
    expect(nested).toHaveTextContent("嵌套：来源是软链接，指向的不是原目录本身");
    expect(nested).toHaveAttribute("data-shape", "nested-link");
    expect(cycle).toHaveTextContent("循环：链接链回到已跟随过的链接");
    expect(cycle).toHaveAttribute("data-shape", "cyclic-link");
    // Each detail is the Host's own observation, not the shape's name again.
    expect(dead).toHaveTextContent("/work/missing");
    expect(cycle).toHaveTextContent("/work/cycle-b");
    for (const row of [dead, nested, cycle]) {
      expect(row).not.toHaveTextContent("真实目录");
      expect(row).not.toHaveTextContent("未确定");
    }
    // The Host's platform record rides the same read: this machine's platform is
    // the exercised row and win32 is an explicitly unverified row, by name.
    const platforms = within(rows[0]!).getByTestId("row-link-platforms-task-dead0001");
    expect(platforms.querySelector(`li[data-platform="${hostPlatformLabel()}"]`)).toHaveAttribute("data-exercised", "true");
    const windows = platforms.querySelector('li[data-platform="win32-x64"]');
    expect(windows).toHaveAttribute("data-exercised", "false");
    expect(windows).toHaveTextContent("win32 链接方式未验证");
    expect(within(rows[0]!).getByTestId("row-link-model-boundary-task-dead0001")).toHaveTextContent("不是真实 pi/模型运行");
  });

  it("reads a refused or unparsable link probe as a named unknown, never as a directory", async () => {
    const refused = [{ taskId: "task-task0001", name: "被拒绝", sourcePath: "/work/refused-docs" }];
    window.pidock = {
      taskOp: async (taskId: string, op: string) => {
        if (op === "task/fileRoots") return { ok: true, payload: { taskDir: `/tasks/${taskId}`, roots: [
          { id: LINK_ROOT, kind: "shared-dir", label: "被拒绝", path: `/tasks/${taskId}/${LINK_ROOT}`, sourcePath: "/work/refused-docs" },
        ] } };
        if (op === "task/probeLink") return { ok: false, error: "path-out-of-scope: 只探测本任务记录的普通目录来源" };
        if (op === "task/fileDiff") return { ok: false, error: "plain-dir-no-diff: 普通目录链接不提供 Git 差异" };
        return { ok: true, payload: { shape: "directory" } };
      },
    } as unknown as typeof window.pidock;
    render(<SharedRepoIsolation tasks={refused} />);
    const row = await screen.findByTestId("shared-dir-row");
    const shape = within(row).getByTestId("row-link-shape-task-task0001");
    expect(shape).toHaveAttribute("data-shape", "unread");
    expect(shape).toHaveTextContent("未确定");
    expect(shape).toHaveTextContent("path-out-of-scope");
    expect(shape).not.toHaveTextContent("真实目录");
    // No probe record means no platform record and no boundary claim either.
    expect(within(row).getByTestId("row-link-platforms-task-task0001")).toHaveTextContent("未取得 Host 链接探测记录");
    expect(within(row).queryByTestId("row-link-model-boundary-task-task0001")).not.toBeInTheDocument();
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
