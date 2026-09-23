import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "./helpers";

describe("project management", () => {
  it("creates a project, edits it, and blocks deleting a project that still has tasks", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas");
    expect(await screen.findByRole("heading", { name: "Atlas Web" })).toBeInTheDocument();

    // The page exposes 项目管理 (was missing) and 管理环境.
    await user.click(screen.getByRole("button", { name: "项目管理" }));
    const list = await screen.findByRole("dialog", { name: "项目管理" });
    await user.click(within(list).getByRole("button", { name: "新建项目" }));

    const editor = await screen.findByRole("dialog", { name: "新建项目" });
    await user.type(within(editor).getByLabelText("项目名称"), "订单系统");
    await user.type(within(editor).getByLabelText("项目说明"), "订单相关");
    await user.click(within(editor).getByLabelText("仓库 apis"));
    await user.click(within(editor).getByRole("button", { name: "创建项目" }));

    expect(await screen.findByRole("heading", { name: "订单系统" })).toBeInTheDocument();
    expect(screen.getByText("订单相关")).toBeInTheDocument();

    // Deleting the seeded project is blocked because it still has tasks.
    await user.click(screen.getByRole("button", { name: "项目管理" }));
    const listAgain = await screen.findByRole("dialog", { name: "项目管理" });
    const atlasRow = within(listAgain).getByText("Atlas Web").closest("div")!.parentElement!;
    await user.click(within(atlasRow).getByRole("button", { name: "删除" }));
    const deleteDialog = await screen.findByRole("dialog", { name: "删除项目" });
    expect(within(deleteDialog).getByText(/个关联任务/)).toBeInTheDocument();
    expect(within(deleteDialog).queryByRole("button", { name: "删除项目" })).not.toBeInTheDocument();
  });

  it("disables a repository already used by a task in the project editor", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas");
    await screen.findByRole("heading", { name: "Atlas Web" });

    await user.click(screen.getByRole("button", { name: "编辑项目" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑项目" });
    const used = within(dialog).getByLabelText("仓库 front-monorepo");
    expect(used).toBeChecked();
    expect(used).toBeDisabled();
    expect(within(dialog).getAllByText("任务使用中").length).toBeGreaterThan(0);
    // A registered repository no task uses can still be toggled.
    expect(within(dialog).getByLabelText("仓库 orbit-api")).not.toBeDisabled();
  });
});

describe("environment management", () => {
  it("adds an environment from the environment management dialog", async () => {
    const user = userEvent.setup();
    renderApp("/env");
    await screen.findByRole("heading", { name: "环境与服务" });

    await user.click(screen.getByRole("button", { name: "环境管理" }));
    const list = await screen.findByRole("dialog", { name: "环境管理" });
    await user.click(within(list).getByRole("button", { name: "新增环境" }));

    const editor = await screen.findByRole("dialog", { name: "新增环境" });
    await user.type(within(editor).getByLabelText("环境名称"), "集成测试");
    await user.type(within(editor).getByLabelText("环境说明"), "远程依赖");
    await user.click(within(editor).getByRole("button", { name: "创建环境" }));

    expect(await screen.findByText("环境已保存；任务的模板版本与运行状态保留")).toBeInTheDocument();
    expect(await screen.findByText("集成测试")).toBeInTheDocument();
  });

  it("blocks deleting an environment a task references", async () => {
    const user = userEvent.setup();
    renderApp("/env");
    await screen.findByRole("heading", { name: "环境与服务" });

    await user.click(screen.getByRole("button", { name: "环境管理" }));
    const list = await screen.findByRole("dialog", { name: "环境管理" });
    const testingRow = within(list).getByText("测试环境").closest("div")!.parentElement!;
    await user.click(within(testingRow).getByRole("button", { name: "删除" }));

    const dialog = await screen.findByRole("dialog", { name: "删除环境" });
    expect(within(dialog).getByText(/个任务正在引用此环境/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "删除环境" })).not.toBeInTheDocument();
  });
});

describe("capability add", () => {
  it("adds a capability source as disabled / pending review", async () => {
    const user = userEvent.setup();
    renderApp("/capabilities");
    await screen.findByRole("heading", { name: "能力管理" });

    await user.click(screen.getByRole("button", { name: "添加技能来源" }));
    const dialog = await screen.findByRole("dialog", { name: "添加技能来源" });
    await user.type(within(dialog).getByLabelText("能力名称"), "release-notes");
    await user.type(within(dialog).getByLabelText("能力来源"), "~/.agents/skills");
    await user.selectOptions(within(dialog).getByLabelText("能力作用域"), "所有项目");
    await user.click(within(dialog).getByRole("button", { name: "添加为停用" }));

    expect(await screen.findByText("已添加为停用，不会加载或连接")).toBeInTheDocument();
    expect(await screen.findByText("release-notes")).toBeInTheDocument();
    expect(screen.getByText("待审阅")).toBeInTheDocument();
  });
});

describe("provider editing", () => {
  it("edits and removes a provider profile", async () => {
    const user = userEvent.setup();
    renderApp("/providers");
    await screen.findByRole("heading", { name: "Provider 与上下文" });

    await user.click(screen.getAllByRole("button", { name: "编辑" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "编辑 Provider" });
    const name = within(dialog).getByLabelText("显示名称");
    await user.clear(name);
    await user.type(name, "Anthropic 官方 2");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));

    expect(await screen.findByText("已保存 Provider 配置；凭据只保存引用，不写入共享模板与日志")).toBeInTheDocument();
    expect(await screen.findByText("Anthropic 官方 2")).toBeInTheDocument();
  });
});

describe("session permission picker", () => {
  it("switches the tier and preserves the composer draft", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    const input = screen.getByLabelText("消息输入");
    await user.type(input, "保留这段草稿");

    await user.click(screen.getByRole("button", { name: "选择权限：默认权限" }));
    const dialog = await screen.findByRole("dialog", { name: "会话权限" });
    await user.click(within(dialog).getByTestId("permission-read"));

    expect(await screen.findByRole("button", { name: "选择权限：只读" })).toBeInTheDocument();
    // The draft typed before the switch is preserved, and read-only gates input.
    expect(screen.getByLabelText("消息输入")).toHaveValue("保留这段草稿");
    expect(screen.getByLabelText("消息输入")).toBeDisabled();
  });
});

describe("model and thinking pickers", () => {
  it("switches the model and then the reasoning level for a session", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    await user.click(screen.getByRole("button", { name: /^选择模型：Claude Sonnet$/ }));
    const dialog = await screen.findByRole("dialog", { name: "选择 Provider 与模型" });
    await user.click(within(dialog).getByRole("button", { name: "模型 本地 Qwen" }));

    expect(await screen.findByRole("button", { name: "选择模型：本地 Qwen" })).toBeInTheDocument();

    // The local model declares custom reasoning levels, so a picker appears.
    await user.click(screen.getByRole("button", { name: "选择推理档位" }));
    const thinking = await screen.findByRole("dialog", { name: "推理档位" });
    await user.click(within(thinking).getByRole("button", { name: /高/ }));
    expect(await screen.findByText(/推理档位已选择/)).toBeInTheDocument();
  });
});

describe("scheduled task editing", () => {
  it("edits the cadence through the schedule dialog", async () => {
    const user = userEvent.setup();
    renderApp("/schedules");
    await screen.findByRole("heading", { name: "定时任务" });

    await user.click(screen.getAllByRole("button", { name: "编辑" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "编辑定时任务" });
    const rule = within(dialog).getByLabelText("执行周期");
    await user.clear(rule);
    await user.type(rule, "每周五 16:00");
    await user.click(within(dialog).getByRole("button", { name: "保存更改" }));

    expect(await screen.findByText("已保存模拟定时任务")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/每周五 16:00/)).toBeInTheDocument());
  });
});

describe("service recipe form", () => {
  it("captures run type, health check and dependency binding", async () => {
    const user = userEvent.setup();
    renderApp("/env");
    await screen.findByRole("heading", { name: "环境与服务" });

    await user.click(screen.getByRole("button", { name: "添加服务" }));
    const dialog = await screen.findByRole("dialog", { name: "添加服务" });
    await user.type(within(dialog).getByLabelText("服务名称"), "worker");
    await user.selectOptions(within(dialog).getByLabelText("运行类型"), "准备步骤");
    await user.selectOptions(within(dialog).getByLabelText("健康检查"), "TCP");
    await user.type(within(dialog).getByLabelText("依赖地址绑定"), "INVOICE → invoice-service");
    await user.click(within(dialog).getByRole("button", { name: "保存配方" }));

    expect(await screen.findByText("服务配方已添加（内存模拟）")).toBeInTheDocument();
    expect(await screen.findByText("worker")).toBeInTheDocument();
  });
});
