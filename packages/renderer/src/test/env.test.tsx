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

  it("marks each resolved config row with the layer it came from", async () => {
    renderApp("/env");
    await screen.findByRole("heading", { name: "环境与服务" });
    const panel = screen.getByRole("heading", { name: "按服务查看生效配置", level: 2 }).closest("section");
    const table = within(panel as HTMLElement).getByRole("table");
    expect(within(table).getByText("仓库默认配置 · .env")).toBeInTheDocument();
    expect(within(table).getByText(/^共享模板 · .* · v12/)).toBeInTheDocument();
    expect(within(table).getByText("任务覆盖")).toBeInTheDocument();
    expect(within(table).getByText(/^本机私有配置 · ~\/.pi\/dock/)).toBeInTheDocument();
  });
});
