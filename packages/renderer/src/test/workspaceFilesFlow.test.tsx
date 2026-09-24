import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "./helpers";
import { FilesPanel } from "../components/ToolPanels";
import { memoryWorkspaceBrowser, workspaceRootsFromHost, workspaceTreeFromHost, terminalPlanFromHost, terminalStateFromHost } from "../data/workspaceFiles";
import type { WorkspaceBrowserView } from "../data/workspaceFiles";

// [PiDock 10] (#15) file browsing + built-in terminal. The rule layer (path
// containment, bounds, masking, gate order) is covered Host-side; these flows
// cover what the user sees: the tool area starts closed, the file panel names
// the task/repo and marks a plain-directory link as shared, and the terminal
// panel shows the planned cwd/owner plus the honest "no real pty" state.

describe("payload parsers", () => {
  it("drops a payload that does not have the documented shape instead of showing an empty view", () => {
    expect(workspaceRootsFromHost({ taskDir: "/t", roots: [] })).toEqual({ roots: [], taskDir: "/t" });
    expect(workspaceRootsFromHost({ taskDir: "/t", roots: [{ id: "r" }] })).toBeUndefined();
    expect(workspaceRootsFromHost({ roots: [] })).toBeUndefined();
    expect(workspaceTreeFromHost({ tree: { attribution: {}, path: "", entries: [], truncated: false } })).toBeUndefined();
    expect(
      workspaceTreeFromHost({
        tree: {
          attribution: { taskId: "t", rootId: "r", rootKind: "worktree", rootLabel: "r", piWorkDir: "/t" },
          path: "",
          entries: [{ name: "a.ts", path: "a.ts", kind: "file", size: 3 }],
          truncated: false,
        },
      }),
    ).toEqual({
      attribution: { taskId: "t", rootId: "r", rootKind: "worktree", rootLabel: "r", piWorkDir: "/t" },
      path: "",
      entries: [{ name: "a.ts", path: "a.ts", kind: "file", size: 3 }],
      truncated: false,
    });
    expect(terminalPlanFromHost({ plan: { instanceId: "term-1" } })).toBeUndefined();
    expect(terminalStateFromHost({ spawnImplemented: false, instances: [{ instanceId: "x" }] })).toBeUndefined();
    expect(terminalStateFromHost({ spawnImplemented: false, instances: [] })).toEqual({ spawnImplemented: false, instances: [] });
  });

  it("keeps the plain-directory link identity in the memory projection", () => {
    const view = memoryWorkspaceBrowser(
      {
        id: "release",
        workspaceRoot: "/w",
        repos: ["front-monorepo"],
        directories: [{ id: "atlas-docs", name: "Atlas 设计资料", path: "/w/atlas-docs", linkName: "dir-51cd20bb" }],
        files: [],
      },
      () => "main",
      { rootId: "dir-51cd20bb" },
    );
    expect(view.roots.map((root) => [root.id, root.kind])).toEqual([
      ["front-monorepo", "worktree"],
      ["dir-51cd20bb", "shared-dir"],
    ]);
    expect(view.selected?.tree?.attribution).toMatchObject({
      rootKind: "shared-dir",
      sourcePath: "/w/atlas-docs",
      sharedNote: "普通目录链接：修改影响原文件，不提供 Git 差异与交付",
    });
    // A shared link has no Git diff or delivery entry point.
    expect(view.selected?.diff).toBeUndefined();
    expect(view.selected?.delivery).toBeUndefined();
  });

  it("hands a Host-shaped tree entry back as the root-relative path", async () => {
    const user = userEvent.setup();
    // The Host emits root-relative entry paths; the panel must pass exactly
    // that value on, or `task/filePreview` gets an empty relative path.
    const view: WorkspaceBrowserView = {
      taskId: "t",
      taskDir: "/t",
      roots: [{ id: "r", kind: "worktree", label: "r", path: "/t/r", repo: "r" }],
      selected: {
        rootId: "r",
        relative: "",
        tree: {
          attribution: { taskId: "t", rootId: "r", rootKind: "worktree", rootLabel: "r", repo: "r", piWorkDir: "/t" },
          path: "",
          entries: [{ name: "a.ts", path: "a.ts", kind: "file" }],
          truncated: false,
        },
      },
    };
    const onSelectFile = vi.fn();
    render(<FilesPanel files={[]} browser={view} onSelectFile={onSelectFile} />);
    await user.click(within(screen.getByTestId("file-tree")).getByRole("button", { name: "a.ts" }));
    expect(onSelectFile).toHaveBeenCalledWith("a.ts");
  });
});

describe("task tool area and file panel", () => {
  it("starts with no tool panel open and opens the file browser on demand", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    // Box 1: the tool area is closed by default and only shows opened tabs.
    expect(screen.queryByTestId("file-roots")).not.toBeInTheDocument();
    expect(screen.queryByTestId("terminal-plan")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "文件" }));
    const roots = await screen.findByTestId("file-roots");
    // Box 2: every root names its repo; box 9: plain directories are labelled.
    expect(within(roots).getByRole("button", { name: /front-monorepo/ })).toBeInTheDocument();
    expect(within(roots).getByRole("button", { name: /普通目录/ })).toBeInTheDocument();
    expect(await screen.findByTestId("delivery-target")).toHaveTextContent("不自动提交/推送/合并");

    // Closing the last panel releases the space again ([UI 对齐 04] #28: the
    // prototype's 收起工具区 closes every open tab at once).
    await user.click(screen.getByRole("button", { name: "收起工具区" }));
    await waitFor(() => expect(screen.queryByTestId("file-roots")).not.toBeInTheDocument());
    // The rail itself is gone once no tool is open, so the conversation owns the
    // width again.
    expect(screen.queryByTestId("task-rail")).toBeNull();
  });

  it("shows the shared-directory warning when the link root is selected", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    await user.click(screen.getByRole("button", { name: "文件" }));
    const roots = await screen.findByTestId("file-roots");
    await user.click(within(roots).getByRole("button", { name: /普通目录/ }));
    const note = await screen.findByTestId("shared-dir-note");
    expect(note).toHaveTextContent("修改影响原文件");
    expect(note).toHaveTextContent("/Users/leonz3n/Workspace/atlas-docs");
  });
});

describe("terminal panel", () => {
  it("plans the terminal for the task root, discloses the missing pty and can stop it", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    await user.click(screen.getByRole("button", { name: "终端" }));
    expect(await screen.findByTestId("terminal-spawn-residual")).toHaveTextContent("未实现范围");

    await user.click(screen.getByRole("button", { name: "按计划启动终端" }));
    const plan = await screen.findByTestId("terminal-plan");
    // Box 3: the cwd is the selected task folder and the owner is named.
    expect(plan).toHaveTextContent("~/PiDockTasks/tasks/release/front-monorepo");
    expect(plan).toHaveTextContent("Agent 会话 main");
    const instance = await screen.findByTestId("terminal-instance");
    expect(instance).toHaveTextContent("运行中");
    expect(instance).toHaveTextContent("未报告进程号");

    await user.click(within(instance).getByRole("button", { name: "停止终端" }));
    await waitFor(() => expect(screen.getByTestId("terminal-instance")).toHaveTextContent("已退出"));
  });
});
