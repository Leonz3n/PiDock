import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { taskFileSeeds } from "../data/memoryHost";
import { renderApp } from "./helpers";

describe("PiDock renderer flows", () => {
  it("opens a task conversation from a route and keeps the main workspace visible", async () => {
    renderApp("/projects/atlas/tasks/release?session=main");
    expect(await screen.findByRole("heading", { name: "发布前检查" })).toBeInTheDocument();
    expect(screen.getByLabelText("给 Agent 的消息")).toBeInTheDocument();
    expect(screen.getAllByText("Atlas Web").length).toBeGreaterThan(0);
  });

  it("reviews a concrete approval payload and expires it without executing", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=deploy");
    // [UI 对齐 05] (#29) 审批只有执行状态卡一处：原型的 `executionPanel()` 自己带
    // `approval-preview`，所以状态行与载荷审阅在同一个 region 内一起断言。
    const card = await screen.findByRole("region", { name: "会话执行状态" });
    expect(within(card).getByTestId("execution-card-state")).toHaveTextContent("等待确认");
    const preview = await within(card).findByTestId("execution-approval-preview");
    expect(preview).toHaveTextContent(/bun run deploy:staging/);
    expect(preview).toHaveTextContent("载荷版本：");
    expect(screen.queryByText(/正在执行 deploy:staging/)).not.toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "标记过期" }));
    // 过期不执行：该请求不再是待确认，卡片转去审阅本会话的另一条请求；结果行只描述与
    // 当前状态对应的记录（P2-A），所以这里断言的是 Host 状态而不是一条借用来的文案。
    await waitFor(() =>
      expect(screen.getByTestId("execution-approval-preview")).toHaveTextContent("待批准：执行数据库迁移"),
    );
    expect(screen.queryByText(/正在执行 deploy:staging/)).not.toBeInTheDocument();
  });

  it("retains a draft and references when a run fails", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=failed");
    const input = await screen.findByLabelText("给 Agent 的消息");
    await user.type(input, "修复构建并重试");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    expect(await screen.findByText(/执行失败/, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(input).toHaveValue("修复构建并重试");
    expect(screen.getByLabelText("移除引用 build.log:48")).toBeInTheDocument();
    expect(screen.getAllByText("引用 · build.log:48").length).toBeGreaterThan(0);
  });

  it("renders token records as a dense virtualized table", async () => {
    renderApp("/usage");
    expect(await screen.findByRole("heading", { name: "Token 用量" })).toBeInTheDocument();
    await waitFor(() => {
      const table = screen.getByTestId("usage-table");
      expect(table).toHaveAttribute("data-total-rows", "240");
      expect(table).toHaveAttribute("data-virtualized", "true");
    });
    const table = screen.getByTestId("usage-table");
    expect(table.querySelectorAll("[style*='translateY']").length).toBeLessThan(240);
  });

  it("virtualizes the long all-sessions list with real row counts", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    await user.click(screen.getByRole("button", { name: /全部会话/ }));

    const list = await screen.findByTestId("session-list");
    await waitFor(() => {
      expect(Number(list.getAttribute("data-total-rows"))).toBeGreaterThan(40);
      expect(list).toHaveAttribute("data-virtualized", "true");
    });
    const total = Number(list.getAttribute("data-total-rows"));
    expect(list.querySelectorAll("[style*='translateY']").length).toBeLessThan(total);
  });

  it("virtualizes the scheduled execution log and never labels failures as skipped", async () => {
    renderApp("/schedules");
    expect(await screen.findByRole("heading", { name: "定时任务" })).toBeInTheDocument();

    const log = await screen.findByTestId("run-history");
    await waitFor(() => {
      expect(Number(log.getAttribute("data-total-rows"))).toBeGreaterThan(30);
      expect(log).toHaveAttribute("data-virtualized", "true");
    });
    const total = Number(log.getAttribute("data-total-rows"));
    expect(log.querySelectorAll("[style*='translateY']").length).toBeLessThan(total);
    expect(within(log).getAllByText("失败").length).toBeGreaterThan(0);
    expect(within(log).getAllByText("跳过").length).toBeGreaterThan(0);
  });

  it("searches and archives sessions inside the all-sessions list", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    await user.click(screen.getByRole("button", { name: /全部会话/ }));
    const list = await screen.findByTestId("session-list");

    expect(await screen.findByRole("tab", { name: "未归档 43" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "已归档 13" })).toBeInTheDocument();

    // Search narrows the dense list to matching sessions only (the task page
    // session tabs behind the modal also show these names, so scope to the list).
    await user.type(screen.getByLabelText("搜索会话"), "部署");
    await waitFor(() => expect(Number(list.getAttribute("data-total-rows"))).toBe(1));
    expect(await within(list).findByText("部署审查")).toBeInTheDocument();
    expect(within(list).queryByText("实现与验证")).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText("搜索会话"));

    // Archiving moves a session out of the active group and into 已归档.
    await user.click(screen.getAllByRole("button", { name: "归档" })[0]);
    expect(await screen.findByRole("tab", { name: "已归档 14" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "未归档 42" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "已归档 14" }));
    await waitFor(() => expect(Number(list.getAttribute("data-total-rows"))).toBe(14));
    expect(await within(list).findByText("历史排查")).toBeInTheDocument();
  });

  it("shows the effective config source per service on the environment page", async () => {
    const user = userEvent.setup();
    renderApp("/env");
    expect(await screen.findByRole("heading", { name: "环境与服务" })).toBeInTheDocument();

    // [UI 对齐 08] #32: the prototype exposes this as the 查看生效配置 dialog.
    await user.click(screen.getByRole("button", { name: "查看生效配置" }));
    const dialog = await screen.findByRole("dialog", { name: "查看生效配置" });
    const table = within(dialog).getByRole("table");

    // The 来源 column distinguishes all four configuration layers.
    expect(within(table).getByText(/^共享模板 · .* · v\d+/)).toBeInTheDocument();
    expect(within(table).getByText("仓库默认配置 · .env")).toBeInTheDocument();
    expect(within(table).getByText("任务覆盖")).toBeInTheDocument();
    expect(within(table).getByText(/^本机私有配置 · ~\/.pi\/dock/)).toBeInTheDocument();

    // Sensitive values stay masked, and the resolved value follows the service.
    expect(within(table).getByText("••••••••")).toBeInTheDocument();
    expect(within(table).queryByText("iv_live_9f2c8ba7d41e")).not.toBeInTheDocument();
    expect(within(table).getByText(/^https:\/\/saas-web\./)).toBeInTheDocument();

    await user.selectOptions(within(dialog).getByTestId("effective-service"), "release-service-3");
    expect(await within(dialog).findByText(/^https:\/\/invoice-service\./)).toBeInTheDocument();
    // Read-only: the only control is the service picker, and there is no save.
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /保存/ })).not.toBeInTheDocument();
    expect(within(dialog).getByText(/未保存草稿不参与/)).toBeInTheDocument();
    expect(within(dialog).getByText(/需显式重启受影响服务/)).toBeInTheDocument();
  });

  it("renders tool panels from adapter data instead of hardcoded fixtures", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    await user.click(screen.getByRole("button", { name: "文件" }));
    expect((await screen.findAllByText(taskFileSeeds[0].path)).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "终端" }));
    await user.type(screen.getByLabelText("终端输入"), "pnpm test");
    await user.click(screen.getByRole("button", { name: "执行" }));
    expect(await screen.findByText("$ pnpm test")).toBeInTheDocument();
  });
});
