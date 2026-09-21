import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
});
