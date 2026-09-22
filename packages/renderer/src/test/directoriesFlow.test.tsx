import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryHost, defaultWorkspaceRoot, taskFileSeeds } from "../data/memoryHost";
import { renderApp } from "./helpers";

describe("ordinary directories in the memory adapter", () => {
  it("validates and locks project directories referenced by a task", async () => {
    const host = createMemoryHost();
    const kept = await host.setProjectDirectories("atlas", [
      { id: "atlas-docs", name: "Atlas 设计资料", path: "/Users/leonz3n/Workspace/atlas-docs" },
    ]);
    expect(kept).toHaveLength(1);

    // A referenced directory must keep its name and path, and cannot be removed.
    await expect(
      host.setProjectDirectories("atlas", [{ id: "atlas-docs", name: "改名", path: "/Users/leonz3n/Workspace/atlas-docs" }]),
    ).rejects.toThrow("不能修改名称或路径");
    await expect(host.setProjectDirectories("atlas", [])).rejects.toThrow("不能修改名称或路径");

    await expect(
      host.setProjectDirectories("atlas", [
        { id: "atlas-docs", name: "Atlas 设计资料", path: "/Users/leonz3n/Workspace/atlas-docs" },
        { id: "dup", name: "重复", path: "/Users/leonz3n/Workspace/atlas-docs/" },
      ]),
    ).rejects.toThrow("请勿重复添加同一路径");

    await expect(
      host.setProjectDirectories("atlas", [{ id: "x", name: "相对路径", path: "docs" }]),
    ).rejects.toThrow("普通目录的名称和完整路径");

    // A new, valid directory can be registered alongside the locked one.
    const withExtra = await host.setProjectDirectories("atlas", [
      { id: "atlas-docs", name: "Atlas 设计资料", path: "/Users/leonz3n/Workspace/atlas-docs" },
      { id: "design-extra", name: "设计补充", path: "/Users/leonz3n/Workspace/design-extra" },
    ]);
    expect(withExtra.map((item) => item.name)).toEqual(["Atlas 设计资料", "设计补充"]);
  });

  it("creates an ordinary-directory-only task with a symlink snapshot and no services", async () => {
    const host = createMemoryHost();
    const task = await host.createTask({
      projectId: "atlas",
      name: "资料整理",
      repoIds: [],
      directoryIds: ["atlas-docs"],
      environmentId: "testing",
    });
    expect(task.repos).toHaveLength(0);
    expect(task.directories).toEqual([
      { id: "atlas-docs", name: "Atlas 设计资料", path: "/Users/leonz3n/Workspace/atlas-docs", linkName: "dir-atlasdoc" },
    ]);
    expect(task.services).toHaveLength(0);
    expect(task.workspaceRoot).toBe(defaultWorkspaceRoot);
    expect(task.templateVersion).toBe("v12");
    expect(task.workspaceKey).toMatch(/^task-[0-9a-f]{8}$/);

    await host.setTaskDirectories(task.id, []);
    expect((await host.getTask(task.id))?.directories).toHaveLength(0);
    await host.setTaskDirectories(task.id, ["atlas-docs"]);
    expect((await host.getTask(task.id))?.directories[0]?.linkName).toBe("dir-atlasdoc");
  });

  it("only removes the in-task symlink in a cleanup preview and keeps the original directory", async () => {
    const host = createMemoryHost();
    await host.archiveTask("release");
    const preview = await host.previewCleanup("release");
    const symlink = preview.find((item) => item.action === "移除任务内软链接");
    expect(symlink?.resource).toContain("Atlas 设计资料");
    expect(symlink?.detail).toContain("/Users/leonz3n/Workspace/atlas-docs");
    expect(symlink?.detail).toContain("保留");
    expect(preview).toHaveLength(8);
  });
});

describe("ordinary-directory task page", () => {
  it("shows the directory header and no Git entry points", async () => {
    renderApp("/projects/atlas/tasks/design-docs?session=main");
    expect(await screen.findByText("TASK · 普通目录")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "设计资料整理" })).toBeInTheDocument();
    expect(screen.getByText(/1 个普通目录 · 通过软链接加入/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "运行" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "浏览器" })).not.toBeInTheDocument();
    expect(screen.queryByText(/worktree/)).not.toBeInTheDocument();
    expect(screen.queryByText(/远程基线/)).not.toBeInTheDocument();
  });

  it("shows the in-task symlink path and original path in the file panel", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/design-docs?session=main");
    await screen.findByText("TASK · 普通目录");

    await user.click(screen.getByRole("button", { name: "文件" }));
    expect(await screen.findByTestId("directory-link-path")).toHaveTextContent("dir-atlasdoc");
    expect(screen.getByTestId("directory-link-path")).toHaveTextContent("task-c4e21b90");
    expect(screen.getByTestId("directory-original-path")).toHaveTextContent("/Users/leonz3n/Workspace/atlas-docs");
    expect(screen.getByText(/修改会影响原目录 · 文件未隔离/)).toBeInTheDocument();
    expect(screen.getByText(/不提供 Git 差异、分支或提交操作/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "终端" }));
    expect(await screen.findByTestId("directory-terminal-cwd")).toHaveTextContent("dir-atlasdoc");
  });

  it("lists already-added directories as checked and disabled when adding to a task", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/design-docs?session=main");
    await screen.findByText("TASK · 普通目录");

    await user.click(screen.getByRole("button", { name: "添加目录" }));
    const dialog = await screen.findByRole("dialog", { name: "添加仓库或目录" });
    const existing = within(dialog).getByLabelText("任务目录 Atlas 设计资料");
    expect(existing).toBeChecked();
    expect(existing).toBeDisabled();
    expect(within(dialog).getByText(/已加入/)).toBeInTheDocument();
    // The prototype's `addrepo` also lets a task gain a Git repository, not only
    // ordinary directories, so the dialog keeps the repo multi-select.
    expect(within(dialog).getByLabelText("任务仓库 front-monorepo")).toBeInTheDocument();
  });
});

describe("mixed Git + ordinary-directory task page", () => {
  it("keeps Git surfaces, shows the directory count/entry, and offers the directory chooser", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    // Header count and the directory-management entry are present for a mixed task.
    expect(screen.getByText("1 个普通目录")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加目录" })).toBeInTheDocument();
    // Git-specific panels stay for a mixed task.
    expect(screen.getByRole("button", { name: "运行" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "浏览器" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "文件" }));
    await user.click(await screen.findByRole("button", { name: "Atlas 设计资料" }));
    expect(await screen.findByTestId("directory-link-path")).toHaveTextContent("dir-atlasdoc");
    expect(screen.getByTestId("directory-original-path")).toHaveTextContent("/Users/leonz3n/Workspace/atlas-docs");
    expect(screen.getByText(/不提供 Git 差异、分支或提交操作/)).toBeInTheDocument();

    // The chooser takes the mixed task back to its Git worktree file view.
    await user.click(screen.getByRole("button", { name: "仓库工作副本" }));
    await waitFor(() => expect(screen.queryByTestId("directory-link-path")).not.toBeInTheDocument());
    expect((await screen.findAllByText(taskFileSeeds[0].path)).length).toBeGreaterThan(0);
  });

  it("offers the same directory chooser in the terminal panel", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    await user.click(screen.getByRole("button", { name: "终端" }));
    await user.click(await screen.findByRole("button", { name: "Atlas 设计资料" }));
    expect(await screen.findByTestId("directory-terminal-cwd")).toHaveTextContent("dir-atlasdoc");
    expect(screen.getByTestId("directory-terminal-cwd")).toHaveTextContent("task-a1f92c3d");
  });
});

describe("project ordinary-directory management", () => {
  it("registers a new directory and locks the one referenced by a task", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas");
    expect(await screen.findByRole("heading", { name: "Atlas Web" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "管理目录" }));
    const dialog = await screen.findByRole("dialog", { name: "管理普通目录" });
    expect(within(dialog).getByLabelText("目录路径 第 1 行")).toHaveAttribute("readonly");
    expect(within(dialog).getByRole("button", { name: "移除目录 第 1 行" })).toBeDisabled();

    await user.click(within(dialog).getByRole("button", { name: "添加目录" }));
    await user.type(within(dialog).getByLabelText("目录名称 第 2 行"), "设计补充");
    await user.type(within(dialog).getByLabelText("目录路径 第 2 行"), "/Users/leonz3n/Workspace/design-extra");
    await user.click(within(dialog).getByRole("button", { name: "保存目录" }));

    expect(await screen.findByText("项目普通目录已保存到内存")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("设计补充")).toBeInTheDocument());
  });
});
