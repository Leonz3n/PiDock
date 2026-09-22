import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultWorkspaceRoot } from "../data/memoryHost";
import { renderApp } from "./helpers";

describe("rename modals", () => {
  it("does not save a stale rename draft from one modal into the other", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    // Leak a draft into the task rename modal, then abandon it.
    await user.click(screen.getByRole("button", { name: "任务操作：发布前检查" }));
    const taskInput = await screen.findByLabelText("任务名称");
    await user.clear(taskInput);
    await user.type(taskInput, "泄漏的值");
    await user.click(screen.getByRole("button", { name: "关闭" }));

    // Open the session rename modal and save *without editing it*. The original
    // defect lived in the save path (`draftValue || modal.value`), so the
    // assertion below is on the saved result, not just the displayed input.
    await user.click(screen.getByRole("button", { name: /全部会话/ }));
    await screen.findByRole("dialog", { name: "全部会话" });
    await user.click(screen.getAllByRole("button", { name: "重命名" })[0]);
    const sessionInput = await screen.findByLabelText("会话名称");
    expect(sessionInput).toHaveValue("实现与验证");
    await user.click(screen.getByRole("button", { name: "保存" }));

    // Saved name must be the session's own, never the leaked task draft.
    expect(await screen.findByRole("button", { name: /实现与验证/ })).toBeInTheDocument();
    expect(screen.queryByText("泄漏的值")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "任务操作：发布前检查" })).toBeInTheDocument();
  });

  it("still renames the session it was opened for", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    await user.click(screen.getByRole("button", { name: /全部会话/ }));
    await screen.findByRole("dialog", { name: "全部会话" });
    await user.click(screen.getAllByRole("button", { name: "重命名" })[0]);
    const sessionInput = await screen.findByLabelText("会话名称");
    await user.clear(sessionInput);
    await user.type(sessionInput, "重命名后的会话");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByRole("button", { name: /重命名后的会话/ })).toBeInTheDocument();
  });
});

describe("new-task workspace preview", () => {
  it("previews the pi workspace and symlink paths live in the new-task form", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas");
    await screen.findByRole("heading", { name: "Atlas Web" });
    await user.click(screen.getByRole("button", { name: "新建任务" }));
    const dialog = await screen.findByRole("dialog", { name: "新建任务" });

    const preview = within(dialog).getByTestId("workspace-preview");
    expect(within(dialog).getByTestId("workspace-preview-path")).toHaveTextContent(defaultWorkspaceRoot);
    expect(within(dialog).getByTestId("workspace-preview-path").textContent).toMatch(/task-[0-9a-f]{8}/);

    // Selecting a directory adds its in-task symlink path and original target.
    await user.click(within(dialog).getByLabelText("任务目录 Atlas 设计资料"));
    expect(within(dialog).getByTestId("preview-link-atlas-docs")).toHaveTextContent("dir-atlasdoc");
    expect(preview).toHaveTextContent("/Users/leonz3n/Workspace/atlas-docs");

    // Selecting a repo adds its worktree path under the same task folder.
    await user.click(within(dialog).getByLabelText("仓库 front-monorepo"));
    expect(preview).toHaveTextContent("/front-monorepo");
  });

  it("keeps the previewed workspace key when the task is created", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas");
    await screen.findByRole("heading", { name: "Atlas Web" });
    await user.click(screen.getByRole("button", { name: "新建任务" }));
    const dialog = await screen.findByRole("dialog", { name: "新建任务" });
    const previewPath = within(dialog).getByTestId("workspace-preview-path").textContent ?? "";
    const key = previewPath.split("/").pop() ?? "";
    expect(key).toMatch(/^task-[0-9a-f]{8}$/);

    await user.type(within(dialog).getByLabelText("任务名称"), "预览键校验");
    await user.click(within(dialog).getByLabelText("仓库 front-monorepo"));
    await user.click(within(dialog).getByRole("button", { name: "创建任务" }));

    expect(await screen.findByRole("heading", { name: "预览键校验" })).toBeInTheDocument();
    expect(screen.getByText(key)).toBeInTheDocument();
  });
});
