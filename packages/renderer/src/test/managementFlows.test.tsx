import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useHostStore } from "../stores/host";
import { renderApp, actStore } from "./helpers";

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
    // The page header and the sidebar workspace card both name the project.
    expect(screen.getAllByText("订单相关").length).toBeGreaterThan(0);

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
    // The seeded declared package also carries 待审阅, so the new row is one of them.
    expect(screen.getAllByText("待审阅").length).toBeGreaterThanOrEqual(1);
  });
});

describe("capability sources, versions and MCP ([PiDock 16] #18)", () => {
  it("shows the source kind, an invalid reason, and repairs the row after a re-check", async () => {
    const user = userEvent.setup();
    renderApp("/capabilities");
    await screen.findByRole("heading", { name: "能力管理" });

    const missing = screen.getByText("invoice-codes").closest("section")!;
    expect(within(missing).getByText("额外来源")).toBeInTheDocument();
    expect(within(missing).getByText(/资源缺失/)).toBeInTheDocument();
    expect(within(missing).getByText(/未找到该资源/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重新检查来源" }));
    expect(await screen.findByText(/已重新检查来源/)).toBeInTheDocument();
    // Only the rows the re-check repaired are counted: the missing resource
    // and the failed MCP connection, not every row in the list.
    expect(screen.getByText(/2 项能力已刷新/)).toBeInTheDocument();
    await waitFor(() => expect(within(missing).queryByText(/资源缺失/)).not.toBeInTheDocument());
    expect(within(missing).getByText("已在本机验证")).toBeInTheDocument();
  });

  it("disables an updatable capability instead of enabling it again", async () => {
    const user = userEvent.setup();
    renderApp("/capabilities");
    await screen.findByRole("heading", { name: "能力管理" });
    // Installing/disabling waits for the safe boundary the seeded approval holds.
    await actStore(() => useHostStore.getState().stopRun("release", "deploy"));
    await actStore(() => useHostStore.getState().refresh());

    const updatable = screen.getByText("@pi/tools-git").closest("section")!;
    expect(within(updatable).getByText("有可用更新")).toBeInTheDocument();
    // The row reads 停用 because an updatable capability is still running.
    await user.click(within(updatable).getByRole("button", { name: "停用" }));
    await waitFor(() => expect(within(updatable).getByText("已停用")).toBeInTheDocument());
    expect(within(updatable).getByRole("button", { name: "启用" })).toBeInTheDocument();
  });

  it("refuses an MCP add when no bridge Extension is enabled", async () => {
    const user = userEvent.setup();
    renderApp("/capabilities");
    await screen.findByRole("heading", { name: "能力管理" });
    await actStore(() => useHostStore.getState().stopRun("release", "deploy"));
    await actStore(() => useHostStore.getState().setCapabilityEnabled("cap-2", false));
    await actStore(() => useHostStore.getState().refresh());

    await user.click(screen.getByRole("tab", { name: "MCP Servers" }));
    await user.click(screen.getByRole("button", { name: "添加 MCP Server" }));
    const dialog = await screen.findByRole("dialog", { name: "添加 MCP Server" });
    await user.type(within(dialog).getByLabelText("能力名称"), "linear");
    await user.type(within(dialog).getByLabelText("能力来源"), "npx @linear/mcp");
    await user.click(within(dialog).getByRole("button", { name: "添加为停用" }));

    expect(await screen.findByText(/必须选择一个已启用的 bridge Extension/)).toBeInTheDocument();
    // Nothing is added and the dialog stays open so a bridge can be chosen.
    expect(screen.getByRole("dialog", { name: "添加 MCP Server" })).toBeInTheDocument();
  });

  it("offers install/update only on package rows, with the real version state", async () => {
    const user = userEvent.setup();
    renderApp("/capabilities");
    await screen.findByRole("heading", { name: "能力管理" });
    // Installing writes a new version, so it waits for the same safe boundary
    // the other capability changes do; free the seeded approval first.
    await actStore(() => useHostStore.getState().stopRun("release", "deploy"));
    await actStore(() => useHostStore.getState().refresh());

    const skill = screen.getAllByText("code-review")[0]!.closest("section")!;
    expect(within(skill).queryByRole("button", { name: /安装|更新到/ })).toBeNull();

    const notInstalled = screen.getByText("@pi/pack-protoc").closest("section")!;
    expect(within(notInstalled).getByText(/已安装 未安装/)).toBeInTheDocument();
    await user.click(within(notInstalled).getByRole("button", { name: "安装 2.4.1" }));
    expect(await screen.findByText(/已记录安装 2.4.1/)).toBeInTheDocument();
    await waitFor(() => expect(within(notInstalled).getByText(/已安装 2.4.1/)).toBeInTheDocument());

    const update = screen.getByText("@pi/tools-git").closest("section")!;
    expect(within(update).getByText("有可用更新")).toBeInTheDocument();
    await user.click(within(update).getByRole("button", { name: "更新到 1.9.0" }));
    expect(await screen.findByText(/已记录安装 1.9.0/)).toBeInTheDocument();
    await waitFor(() => expect(within(update).queryByText("有可用更新")).not.toBeInTheDocument());
    expect(within(update).getByText(/已安装 1.9.0/)).toBeInTheDocument();

    // The Packages tab button names the dialog it opens.
    await user.click(screen.getByRole("tab", { name: "Packages" }));
    expect(screen.getByRole("button", { name: "安装扩展包" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "安装扩展包" }));
    expect(await screen.findByRole("dialog", { name: "安装扩展包" })).toBeInTheDocument();
  });

  it("reports an MCP connection failure and retries through its bridge", async () => {
    const user = userEvent.setup();
    renderApp("/capabilities");
    await screen.findByRole("heading", { name: "能力管理" });

    const mcp = screen.getByText("figma-context").closest("section")!;
    expect(within(mcp).getByText(/连接失败 · 尝试 2 次/)).toBeInTheDocument();
    expect(within(mcp).getByText(/连接失败：首次连接超时/)).toBeInTheDocument();
    expect(within(mcp).getByText(/实际为 default/)).toBeInTheDocument();

    await user.click(within(mcp).getByRole("button", { name: "重试连接" }));
    expect(await screen.findByText(/已重新连接（内存投影）/)).toBeInTheDocument();
    await waitFor(() => expect(within(mcp).getByText(/已连接 · 尝试 3 次/)).toBeInTheDocument());
    expect(within(mcp).queryByText(/连接失败/)).not.toBeInTheDocument();
  });

  it("keeps a same-named capability from another source instead of replacing it", async () => {
    const user = userEvent.setup();
    renderApp("/capabilities");
    await screen.findByRole("heading", { name: "能力管理" });

    await user.click(screen.getByRole("button", { name: "添加技能来源" }));
    const dialog = await screen.findByRole("dialog", { name: "添加技能来源" });
    await user.type(within(dialog).getByLabelText("能力名称"), "code-review");
    await user.type(within(dialog).getByLabelText("能力来源"), "额外来源 ~/.team/skills");
    await user.selectOptions(within(dialog).getByLabelText("来源类型"), "extra");
    await user.click(within(dialog).getByRole("button", { name: "添加为停用" }));

    expect(await screen.findByText("已添加为停用，不会加载或连接")).toBeInTheDocument();
    // Both rows survive, each marked so the source disambiguates them.
    await waitFor(() => expect(screen.getAllByText("重名 · 按来源区分").length).toBe(2));
  });

  it("refuses a literal secret as an MCP credential and accepts a reference", async () => {
    const user = userEvent.setup();
    renderApp("/capabilities");
    await screen.findByRole("heading", { name: "能力管理" });

    await user.click(screen.getByRole("tab", { name: "MCP Servers" }));
    await user.click(screen.getByRole("button", { name: "添加 MCP Server" }));
    const dialog = await screen.findByRole("dialog", { name: "添加 MCP Server" });
    await user.type(within(dialog).getByLabelText("能力名称"), "linear");
    await user.type(within(dialog).getByLabelText("能力来源"), "npx @linear/mcp");
    await user.type(within(dialog).getByLabelText("凭据引用"), "https://user:pass@example.com");
    await user.click(within(dialog).getByRole("button", { name: "添加为停用" }));
    expect(await screen.findByText(/请在本机私有配置中保存密钥/)).toBeInTheDocument();

    await user.clear(within(dialog).getByLabelText("凭据引用"));
    await user.type(within(dialog).getByLabelText("凭据引用"), "linear-token");
    await user.click(within(dialog).getByRole("button", { name: "添加为停用" }));
    expect(await screen.findByText("已添加为停用，不会加载或连接")).toBeInTheDocument();
    expect(await screen.findByText("linear")).toBeInTheDocument();
  });

  it("applies a capability change only at the safe session boundary", async () => {
    const user = userEvent.setup();
    renderApp("/capabilities");
    await screen.findByRole("heading", { name: "能力管理" });

    // release/deploy is seeded waiting for an approval, so the boundary is busy.
    const card = screen.getAllByText("code-review")[0]!.closest("section")!;
    expect(within(card).getByText("已启用")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "停用" }));
    expect(await screen.findByText(/变更已提交/)).toBeInTheDocument();
    expect(within(card).getByText(/将在当前回合结束后生效/)).toBeInTheDocument();
    expect(within(card).getByText("已启用")).toBeInTheDocument();

    await actStore(() => useHostStore.getState().stopRun("release", "deploy"));
    await actStore(() => useHostStore.getState().refresh());
    await waitFor(() => expect(within(card).getByText("已停用")).toBeInTheDocument());
  });
});

describe("provider editing", () => {
  it("edits and removes a provider profile", async () => {
    const user = userEvent.setup();
    renderApp("/providers");
    await screen.findByRole("heading", { name: "模型与 Provider" });

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

    expect(await screen.findByText("已保存定时任务；下次触发由 Host 按规则与时区计算")).toBeInTheDocument();
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
