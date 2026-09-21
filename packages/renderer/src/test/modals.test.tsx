import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "./helpers";

describe("rename modals", () => {
  it("does not leak a stale rename draft from one modal into the other", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    await user.click(screen.getByRole("button", { name: "任务操作：发布前检查" }));
    const taskInput = await screen.findByLabelText("任务名称");
    expect(taskInput).toHaveValue("发布前检查");
    await user.clear(taskInput);
    await user.type(taskInput, "泄漏的值");
    await user.click(screen.getByRole("button", { name: "关闭" }));

    await user.click(screen.getByRole("button", { name: /全部会话/ }));
    await screen.findByRole("dialog", { name: "全部会话" });
    await user.click(screen.getAllByRole("button", { name: "重命名" })[0]);

    const sessionInput = await screen.findByLabelText("会话名称");
    expect(sessionInput).toHaveValue("实现与验证");
    expect(sessionInput).not.toHaveValue("泄漏的值");
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
