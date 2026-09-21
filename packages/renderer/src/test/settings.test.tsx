import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultWorkspaceRoot } from "../data/memoryHost";
import { renderApp } from "./helpers";

describe("local settings page", () => {
  it("shows the config directory and edits the default workspace root", async () => {
    const user = userEvent.setup();
    renderApp("/settings");

    expect(await screen.findByRole("heading", { name: "本机设置" })).toBeInTheDocument();
    expect(screen.getByText("~/.pi/dock")).toBeInTheDocument();
    expect(screen.getByText("~/.pi/dock/config.json")).toBeInTheDocument();

    const root = screen.getByLabelText("默认任务根目录");
    expect(root).toHaveValue(defaultWorkspaceRoot);
    await user.clear(root);
    await user.type(root, "/tmp/pidock-tasks");
    await user.click(screen.getByRole("button", { name: "保存设置" }));

    expect(await screen.findByText("本机默认目录已保存到内存；已有任务不迁移")).toBeInTheDocument();
    expect(root).toHaveValue("/tmp/pidock-tasks");
  });

  it("reaches the settings page from the sidebar navigation", async () => {
    const user = userEvent.setup();
    renderApp("/attention");
    await screen.findByRole("heading", { name: "需要处理" });

    await user.click(screen.getByRole("button", { name: "本机设置" }));
    expect(await screen.findByRole("heading", { name: "本机设置" })).toBeInTheDocument();
  });
});
