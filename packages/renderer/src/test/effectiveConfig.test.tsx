import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "./helpers";

/**
 * 查看生效配置 ([UI 对齐 08] #32), the prototype's `closure.js`
 * `effectiveConfigDialog()` / `renderEffectiveConfig()`: one task's service
 * resolved through every configuration layer, read-only.
 */
describe("effective config dialog", () => {
  it("opens from the environment page with the prototype's header and service picker", async () => {
    const user = userEvent.setup();
    renderApp("/env");
    await screen.findByRole("heading", { name: "环境与服务" });

    await user.click(screen.getByRole("button", { name: "查看生效配置" }));
    const dialog = await screen.findByRole("dialog", { name: "查看生效配置" });
    // Prototype: `任务名 · 环境 · 任务模板 <version>`, a plain `<p>` in the modal
    // body so it inherits the 13px body font (measured on the live prototype; it
    // was 12px before the S7a close-out round).
    const header = within(dialog).getByText(/发布前检查 · 测试环境 · 任务模板 v\d+/);
    expect(header.className).toContain("text-[13px]");
    expect(within(dialog).getByTestId("effective-service")).toBeInTheDocument();
    // The table is KEY / 最终值 / 来源, with a row per layer.
    const table = within(dialog).getByRole("table");
    // `.table tr:last-child td{border:0}` — the rule sits on the table because a
    // `last:` variant on the cell would target the row's last cell instead.
    expect(table.className).toContain("[&_tr:last-child_td]:border-b-0");
    expect(within(table).getByText("KEY")).toBeInTheDocument();
    expect(within(table).getByText("最终值")).toBeInTheDocument();
    expect(within(table).getByText("来源")).toBeInTheDocument();
    expect(within(table).getByText("仓库默认配置 · .env")).toBeInTheDocument();
    expect(within(table).getByText(/^共享模板 · 测试环境 · v\d+/)).toBeInTheDocument();
    expect(within(table).getByText(/^本机私有配置 · ~\/.pi\/dock/)).toBeInTheDocument();
    expect(within(table).getByText("任务覆盖")).toBeInTheDocument();
    expect(within(table).getByText(/^运行时端口绑定 · /)).toBeInTheDocument();
  });

  it("stays read-only and states what the resolved view does not cover", async () => {
    const user = userEvent.setup();
    renderApp("/env");
    await screen.findByRole("heading", { name: "环境与服务" });
    await user.click(screen.getByRole("button", { name: "查看生效配置" }));
    const dialog = await screen.findByRole("dialog", { name: "查看生效配置" });

    // The service picker is the only control: no editable KEY/VALUE row, no save.
    const controls = within(dialog).getAllByRole("combobox");
    expect(controls).toHaveLength(1);
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /保存|删除第/ })).not.toBeInTheDocument();
    // Sensitive rows stay masked.
    expect(within(dialog).getByText("••••••••")).toBeInTheDocument();
    expect(within(dialog).queryByText("__local_testing_token__")).not.toBeInTheDocument();
    // The prototype's three notes, minus the 示例 wording (our rows are real).
    expect(within(dialog).getByText(/未保存草稿不参与/)).toBeInTheDocument();
    expect(within(dialog).getByText(/需运行时核对/)).toBeInTheDocument();
    expect(within(dialog).getByText(/需显式重启受影响服务/)).toBeInTheDocument();
  });

  it("lets the 任务覆盖 layer win over the shared template for the same KEY", async () => {
    const user = userEvent.setup();
    renderApp("/env");
    await screen.findByRole("heading", { name: "环境与服务" });

    // Add a task override for LOG_LEVEL, which the shared template also sets.
    await user.click(screen.getByRole("tab", { name: "任务覆盖" }));
    await user.click(screen.getByRole("button", { name: "新增一行" }));
    const rows = screen.getAllByLabelText(/第 \d+ 行 KEY/);
    await user.type(rows[rows.length - 1], "LOG_LEVEL");
    const values = screen.getAllByLabelText(/第 \d+ 行 VALUE/);
    await user.type(values[values.length - 1], "trace");
    await user.click(screen.getByRole("button", { name: /保存更改/ }));
    await screen.findByText(/已保存任务覆盖/);

    await user.click(screen.getByRole("button", { name: "查看生效配置" }));
    const dialog = await screen.findByRole("dialog", { name: "查看生效配置" });
    const table = within(dialog).getByRole("table");
    const row = within(table).getByText("LOG_LEVEL").closest("tr")!;
    // The upper layer supplies both the effective value and the reported source.
    expect(row).toHaveTextContent("trace");
    expect(row).toHaveTextContent("任务覆盖");
  });

  it("follows the selected service", async () => {
    const user = userEvent.setup();
    renderApp("/env");
    await screen.findByRole("heading", { name: "环境与服务" });
    await user.click(screen.getByRole("button", { name: "查看生效配置" }));
    const dialog = await screen.findByRole("dialog", { name: "查看生效配置" });
    const table = within(dialog).getByRole("table");
    expect(within(table).getByText(/^https:\/\/saas-web\./)).toBeInTheDocument();

    await user.selectOptions(within(dialog).getByTestId("effective-service"), "release-service-3");
    expect(await within(dialog).findByText(/^https:\/\/invoice-service\./)).toBeInTheDocument();
  });

  it("opens for one service from the task workspace's runtime panel", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查", level: 1 });
    await user.click(screen.getByRole("button", { name: "运行" }));

    const panel = (await screen.findByRole("heading", { name: /^生效配置 · /, level: 2 })).closest("section")!;
    const serviceName = /^生效配置 · (.*)$/.exec(
      within(panel).getByRole("heading", { level: 2 }).textContent ?? "",
    )?.[1];
    await user.click(within(panel).getByRole("button", { name: "查看生效配置" }));
    const dialog = await screen.findByRole("dialog", { name: "查看生效配置" });
    // The dialog arrives pointed at the service the panel was showing.
    expect(within(dialog).getByTestId("effective-service")).toHaveDisplayValue(serviceName ?? "");
  });
});
