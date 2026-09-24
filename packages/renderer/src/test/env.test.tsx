import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "./helpers";

describe("environment scope editing", () => {
  it("adds and edits KEY/VALUE rows, requiring a valid non-duplicate KEY but allowing an empty VALUE", async () => {
    const user = userEvent.setup();
    renderApp("/env");
    expect(await screen.findByRole("heading", { name: "环境与服务" })).toBeInTheDocument();

    // Shared layer is the default scope and starts from the seeded template.
    expect(await screen.findByLabelText("第 1 行 KEY")).toHaveValue("LOG_LEVEL");

    // A blank KEY is rejected before any save.
    await user.click(screen.getByRole("button", { name: "新增一行" }));
    await user.click(screen.getByRole("button", { name: /保存更改/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("不能为空");

    // A duplicate KEY is rejected too.
    await user.type(screen.getByLabelText("第 2 行 KEY"), "LOG_LEVEL");
    await user.click(screen.getByRole("button", { name: /保存更改/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("重复");

    // Private scope: a valid KEY with an empty VALUE saves.
    await user.click(screen.getByRole("tab", { name: "本机私有配置" }));
    await user.click(screen.getByRole("button", { name: "新增一行" }));
    await user.clear(screen.getByLabelText("第 2 行 KEY"));
    await user.type(screen.getByLabelText("第 2 行 KEY"), "EXTRA_FLAG");
    await user.click(screen.getByRole("button", { name: /保存更改/ }));
    expect(await screen.findByText("已保存本机私有配置（内存模拟）")).toBeInTheDocument();
  });

  it("previews a shared-template diff, increments the version, and keeps the task's recorded version", async () => {
    const user = userEvent.setup();
    renderApp("/env");
    await screen.findByRole("heading", { name: "环境与服务" });

    const value = await screen.findByLabelText("第 1 行 VALUE");
    await user.clear(value);
    await user.type(value, "trace");
    await user.click(screen.getByRole("button", { name: /保存更改/ }));

    const dialog = await screen.findByRole("dialog", { name: "审阅共享模板变更" });
    expect(within(dialog).getByText(/v12 → v13/)).toBeInTheDocument();
    expect(within(dialog).getByText(/debug → trace/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "确认保存新版本" }));
    expect(await screen.findByText(/共享模板已保存为 v13/)).toBeInTheDocument();
    // Environment moved to v13, but the task still adopts its recorded v12.
    expect(await screen.findByText("共享模板 v13")).toBeInTheDocument();
    expect(screen.getByText(/「发布前检查」采用 v12/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "采用最新模板 v13" })).toBeInTheDocument();
  });

  it("shows a KEY rename as a removal plus an addition in the review dialog", async () => {
    const user = userEvent.setup();
    renderApp("/env");
    await screen.findByRole("heading", { name: "环境与服务" });

    const key = await screen.findByLabelText("第 1 行 KEY");
    await user.clear(key);
    await user.type(key, "LOG_LEVEL_V2");
    await user.click(screen.getByRole("button", { name: /保存更改/ }));

    const dialog = await screen.findByRole("dialog", { name: "审阅共享模板变更" });
    expect(within(dialog).getByText(/新增：debug/)).toBeInTheDocument();
    expect(within(dialog).getByText(/删除：debug/)).toBeInTheDocument();
  });

  it("keeps drafts isolated per scope and per task", async () => {
    const user = userEvent.setup();
    renderApp("/env");
    await screen.findByRole("heading", { name: "环境与服务" });

    const sharedValue = await screen.findByLabelText("第 1 行 VALUE");
    await user.clear(sharedValue);
    await user.type(sharedValue, "shared-draft");

    await user.click(screen.getByRole("tab", { name: "本机私有配置" }));
    expect(await screen.findByLabelText("第 1 行 KEY")).toHaveValue("INVOICE_ACCESS_TOKEN");

    await user.click(screen.getByRole("tab", { name: "共享模板" }));
    await waitFor(() => expect(screen.getByLabelText("第 1 行 VALUE")).toHaveValue("shared-draft"));
  });

  it("only offers the task-override tab and tasks for the selected environment", async () => {
    const user = userEvent.setup();
    renderApp("/env");
    await screen.findByRole("heading", { name: "环境与服务" });

    // 测试环境 is used by atlas tasks, so 任务覆盖 is offered and its selector
    // lists only tasks of that environment (the prototype's envId filter).
    await user.click(screen.getByRole("tab", { name: "任务覆盖" }));
    const selector = await screen.findByLabelText("选择覆盖的任务");
    const options = within(selector).getAllByRole("option").map((option) => option.textContent);
    expect(options).toContain("发布前检查");
    expect(options).not.toContain("旧登录重构");

    // An environment no task uses hides 任务覆盖 entirely (no mismatched save).
    await user.click(screen.getByRole("button", { name: /预发布环境/ }));
    expect(screen.queryByRole("tab", { name: "任务覆盖" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "共享模板" })).toBeInTheDocument();
  });

  it("lists service startup recipes and adds one in memory", async () => {
    const user = userEvent.setup();
    renderApp("/env");
    await screen.findByRole("heading", { name: "环境与服务" });

    expect(await screen.findByRole("heading", { name: "服务启动配方", level: 2 })).toBeInTheDocument();
    expect(screen.getAllByText("使用项目脚本启动").length).toBeGreaterThan(0);
    expect(screen.getAllByText("读取仓库默认 config.yaml").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "添加服务" }));
    const dialog = await screen.findByRole("dialog", { name: "添加服务" });
    await user.type(within(dialog).getByLabelText("服务名称"), "saas-worker");
    await user.clear(within(dialog).getByLabelText("启动方式"));
    await user.type(within(dialog).getByLabelText("启动方式"), "使用项目脚本启动");
    await user.click(within(dialog).getByRole("button", { name: "保存配方" }));

    expect(await screen.findByText("服务配方已添加（内存模拟）")).toBeInTheDocument();
    expect(screen.getByText("saas-worker")).toBeInTheDocument();
  });

  it("imports .vscode recipes into the selected environment in memory", async () => {
    const user = userEvent.setup();
    renderApp("/env");
    await screen.findByRole("heading", { name: "环境与服务" });

    await user.click(screen.getByRole("button", { name: /预发布环境/ }));
    expect(await screen.findByText("这个环境还没有服务启动配方。")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "从 .vscode 导入" }));
    expect(await screen.findByText(/已从 .vscode 导入 \d+ 条示例配方/)).toBeInTheDocument();
    expect(screen.queryByText("这个环境还没有服务启动配方。")).not.toBeInTheDocument();
    expect(screen.getByText("front-monorepo")).toBeInTheDocument();
  });

  it("refuses service start/stop from a read-only session at the tool layer", async () => {
    const { createMemoryHost } = await import("../data/memoryHost");
    const host = createMemoryHost();
    const workspace = await host.getWorkspace();
    const task = workspace.tasks.find((item) => item.id === "release") as { id: string; services: { id: string }[] };
    // Flip the active session to read-only, then attempt a start: the
    // RuntimePanel hides the buttons first, this is the enforced second line.
    const full = await host.getTask(task.id);
    const active = (full as unknown as { sessions: { id: string; permission: string }[]; activeSessionId: string }).sessions.find(
      (item) => item.id === (full as unknown as { activeSessionId: string }).activeSessionId,
    ) as { permission: string };
    active.permission = "read";
    await expect(host.setServiceRunning(task.id, task.services[0].id, true)).rejects.toThrow("只读会话禁止服务启停");
  });

  it("marks each resolved config row with the layer it came from", async () => {
    const user = userEvent.setup();
    renderApp("/env");
    await screen.findByRole("heading", { name: "环境与服务" });
    // [UI 对齐 08] #32: the prototype exposes this as the 查看生效配置 dialog.
    await user.click(screen.getByRole("button", { name: "查看生效配置" }));
    const dialog = await screen.findByRole("dialog", { name: "查看生效配置" });
    const table = within(dialog).getByRole("table");
    expect(within(table).getByText("仓库默认配置 · .env")).toBeInTheDocument();
    expect(within(table).getByText(/^共享模板 · .* · v12/)).toBeInTheDocument();
    expect(within(table).getByText("任务覆盖")).toBeInTheDocument();
    expect(within(table).getByText(/^本机私有配置 · ~\/.pi\/dock/)).toBeInTheDocument();
  });
});
