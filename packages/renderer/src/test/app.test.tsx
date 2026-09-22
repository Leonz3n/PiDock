import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { taskFileSeeds } from "../data/memoryHost";
import { renderApp } from "./helpers";

describe("PiDock renderer flows", () => {
  it("opens a task conversation from a route and keeps the main workspace visible", async () => {
    renderApp("/projects/atlas/tasks/release?session=main");
    expect(await screen.findByRole("heading", { name: "发布前检查" })).toBeInTheDocument();
    expect(screen.getByLabelText("消息输入")).toBeInTheDocument();
    expect(screen.getAllByText("Atlas Web").length).toBeGreaterThan(0);
  });

  it("reviews a concrete approval payload and expires it without executing", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=deploy");
    expect(await screen.findByText("等待确认")).toBeInTheDocument();
    expect(screen.getByText("bun run deploy:staging")).toBeInTheDocument();
    expect(screen.queryByText("正在执行 deploy:staging")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "标记过期" }));
    expect(await screen.findByText("确认已过期，未执行。")).toBeInTheDocument();
    expect(screen.queryByText("正在执行 deploy:staging")).not.toBeInTheDocument();
  });

  it("retains a draft and references when a run fails", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=failed");
    const input = await screen.findByLabelText("消息输入");
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

    const panel = screen.getByRole("heading", { name: "按服务查看生效配置", level: 2 }).closest("section");
    expect(panel).not.toBeNull();
    const table = within(panel as HTMLElement).getByRole("table");

    // The 来源 column distinguishes all four configuration layers.
    expect(within(table).getByText(/^共享模板 · .* · v\d+/)).toBeInTheDocument();
    expect(within(table).getByText("仓库默认配置 · .env")).toBeInTheDocument();
    expect(within(table).getByText("任务覆盖")).toBeInTheDocument();
    expect(within(table).getByText(/^本机私有配置 · ~\/.pi\/dock/)).toBeInTheDocument();

    // Sensitive values stay masked, and the resolved value follows the service.
    expect(within(table).getByText("••••••••")).toBeInTheDocument();
    expect(within(table).queryByText("iv_live_9f2c8ba7d41e")).not.toBeInTheDocument();
    expect(within(table).getByText(/^https:\/\/saas-web\./)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("选择服务"), "release-service-3");
    expect(await within(table).findByText(/^https:\/\/invoice-service\./)).toBeInTheDocument();
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
