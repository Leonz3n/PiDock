import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { sumUsageRecords } from "../data/usageState";
import { useHostStore } from "../stores/host";
import { renderApp } from "./helpers";

/**
 * [UI 对齐 09] #33: the six remaining management pages against prototype A's
 * structure. jsdom has no layout, so the geometry is measured in
 * `docs/evidence/ui-alignment-s7b/capture-pages.mjs`; what is asserted here is
 * the part a screenshot cannot prove — that every number on the page is derived
 * from the store instead of the prototype's sample values, that the page counts
 * match the store, and that the filters really narrow the view.
 */
describe("management pages alignment ([UI 对齐 09] #33)", () => {
  it("shows the provider page head, the symbol block and the per-model chips", async () => {
    renderApp("/providers");
    const page = await screen.findByTestId("providers-page");

    expect(within(page).getByText("MODELS")).toBeInTheDocument();
    expect(within(page).getByRole("heading", { name: "模型与 Provider" })).toBeInTheDocument();
    expect(within(page).getByRole("button", { name: "添加 Provider" })).toBeInTheDocument();

    const providers = useHostStore.getState().workspace?.providers ?? [];
    expect(within(page).getAllByText(/^[✳◎↗]$/)).toHaveLength(providers.length);
    for (const provider of providers) {
      const card = page.querySelector(`[data-testid="provider-card-${provider.id}"]`) as HTMLElement;
      expect(card).not.toBeNull();
      // The chip is `模型 · 窗口 · 图片`, and the credential line is the
      // prototype's wording with this app's truth (a reference, not a secret).
      expect(within(card).getByTestId(`provider-models-${provider.id}`).textContent).toContain(`${provider.models[0]!.contextWindow}k`);
      expect(within(card).getByTestId(`provider-credentials-${provider.id}`).textContent).toContain(`${provider.models.length} 个模型`);
      expect(within(card).getByTestId(`provider-endpoint-${provider.id}`).textContent).toBe(provider.baseUrl);
    }
  });

  it("derives every usage number from the store instead of the prototype's sample", async () => {
    renderApp("/usage");
    const page = await screen.findByTestId("usage-page");
    await waitFor(() => expect(screen.getByTestId("usage-table")).toHaveAttribute("data-total-rows", "240"));

    const totals = sumUsageRecords(useHostStore.getState().usage);
    const total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
    const labels = [...page.querySelectorAll(".stat")].map((stat) => stat.textContent?.trim() ?? "");
    // 累计 Token (compact) / 最近一次调用 / 已记录调用 / 未完整报告.
    expect(labels[0]).toBe(total >= 1_000_000 ? `${(total / 1_000_000).toFixed(2)}M` : `${Math.round(total / 1000)}k`);
    expect(labels[2]).toBe(totals.calls.toLocaleString());
    expect(labels[3]).toBe(`${totals.missing + totals.partial} 次`);
    // The six summary columns are the prototype's, and the badge is its wording.
    expect([...page.querySelectorAll(".table th")].map((th) => th.textContent)).toEqual([
      "Provider",
      "输入",
      "输出",
      "缓存读取",
      "总计",
      "完整性",
    ]);
    expect(within(page).getByText("示例 · 不代表账单")).toBeInTheDocument();
  });

  it("keeps the usage empty state truthful when the range has no call", async () => {
    const user = userEvent.setup();
    renderApp("/usage");
    const page = await screen.findByTestId("usage-page");
    await waitFor(() => expect(screen.getByTestId("usage-table")).toHaveAttribute("data-total-rows", "240"));

    // 今天 (the wall-clock day) has no recorded call in the fixture, so the page
    // says so instead of drawing seven zero bars as a value.
    await user.selectOptions(within(page).getByLabelText("统计日期"), "今天");
    await waitFor(() => expect(within(page).getByTestId("usage-table")).toHaveAttribute("data-total-rows", "0"));
    expect(within(page).getByText(/当前筛选没有可查看用量的调用/)).toBeInTheDocument();
    expect(page.querySelector(".bar-chart")).toBeNull();

    await user.selectOptions(within(page).getByLabelText("统计日期"), "近 7 天");
    expect(page.querySelectorAll(".bar-column")).toHaveLength(7);
  });

  it("counts capabilities from the store and filters the rows by tab", async () => {
    const user = userEvent.setup();
    renderApp("/capabilities");
    const page = await screen.findByTestId("capabilities-page");

    const capabilities = useHostStore.getState().workspace?.capabilities ?? [];
    const counts = [...page.querySelectorAll(".capability-summary > div")].map((cell) => cell.textContent?.replace(/\s+/g, "") ?? "");
    expect(counts).toEqual([
      `${capabilities.filter((item) => item.kind === "skill").length}Skills`,
      `${capabilities.filter((item) => item.kind === "mcp").length}MCPServers`,
      `${capabilities.filter((item) => item.kind === "extension").length}Extensions`,
      `${capabilities.filter((item) => item.kind === "package").length}Packages`,
    ]);
    expect(within(page).getByRole("tab", { name: "全部" })).toHaveTextContent(`${capabilities.length} 已启用`);

    const rowsBefore = page.querySelectorAll(".capability-row").length;
    await user.click(within(page).getByRole("tab", { name: "MCP Servers" }));
    expect(page.querySelectorAll(".capability-row").length).toBeLessThan(rowsBefore);
    // The prototype's MCP boundary text is carried verbatim.
    expect(within(page).getByText(/Pi 原生不包含 MCP/)).toBeInTheDocument();
  });

  it("keeps the remote modes, the permission defaults and the device actions", async () => {
    renderApp("/remote");
    const page = await screen.findByTestId("remote-page");

    const modes = within(page).getAllByRole("tab");
    expect(modes.map((mode) => mode.textContent)).toEqual([
      expect.stringContaining("Tailscale 私有访问"),
      expect.stringContaining("自建 PiDock Gateway"),
      expect.stringContaining("Funnel 公网入口"),
    ]);
    expect(modes[0]).toHaveAttribute("aria-selected", "true");
    expect(within(page).getByText("推荐")).toBeInTheDocument();
    expect(within(page).getByText("实验入口")).toBeInTheDocument();
    // Five permission rows, read-only defaults: the grant is per device.
    expect(page.querySelectorAll(".permission-list label")).toHaveLength(5);
    expect([...page.querySelectorAll(".permission-list input")].every((input) => (input as HTMLInputElement).disabled)).toBe(true);

    const devices = useHostStore.getState().workspace?.devices ?? [];
    expect(page.querySelectorAll(".device-row")).toHaveLength(devices.length);
    for (const device of devices) {
      expect(within(page).getByText(device.name)).toBeInTheDocument();
    }
    expect(within(page).getAllByRole("button", { name: "撤销设备" })).toHaveLength(devices.length);
  });

  it("summarises schedules from the store and lets the filter narrow the list", async () => {
    const user = userEvent.setup();
    renderApp("/schedules");
    const page = await screen.findByTestId("schedules-page");

    const workspace = useHostStore.getState().workspace;
    const schedules = workspace?.schedules ?? [];
    const summary = [...page.querySelectorAll(".schedule-summary > div")].map((cell) => cell.textContent?.replace(/\s+/g, "") ?? "");
    expect(summary[0]).toBe(`已启用${schedules.filter((schedule) => schedule.enabled).length}`);
    expect(summary[2]).toBe(`下次触发${schedules.find((schedule) => schedule.enabled)?.nextRun ?? "暂无"}`);
    expect(page.querySelectorAll(".schedule-row")).toHaveLength(schedules.length);
    // The time column carries the rule and the timezone the Host stores.
    const first = schedules[0]!;
    // The rule also appears in the run-history rows of other schedules, so the
    // time column is scoped to the row itself.
    const firstRow = within(page.querySelector(`[data-testid="schedule-row-${first.id}"]`) as HTMLElement);
    expect(firstRow.getByText(first.rule)).toBeInTheDocument();
    expect(firstRow.getByText(first.timezone)).toBeInTheDocument();
    expect(firstRow.getByText(first.prompt, { exact: false })).toBeInTheDocument();

    const paused = schedules.filter((schedule) => !schedule.enabled).length;
    await user.click(within(page).getByRole("tab", { name: "已暂停" }));
    expect(page.querySelectorAll(".schedule-row")).toHaveLength(paused);
    await user.click(within(page).getByRole("tab", { name: "全部" }));
    expect(page.querySelectorAll(".schedule-row")).toHaveLength(schedules.length);
    // The run history keeps the VirtualList and the prototype's five columns.
    expect(screen.getByTestId("run-history")).toHaveAttribute("data-virtualized", "true");
    const head = screen.getByTestId("run-history-head");
    expect(head.children).toHaveLength(5);
    // `table` is Tailwind's `display:table` utility, not a marker: carried next
    // to `grid` it wins and stacks the five cells into one column (measured 66px
    // each, [UI 对齐 09] #33 review P1-1). jsdom has no layout, so the class
    // list is what is asserted here; the geometry lives in the evidence script.
    expect(head.className).toContain("grid");
    expect(head.className.split(/\s+/)).not.toContain("table");
    // The header insets each cell the way the prototype's `.table th` does, and
    // the virtualised body row insets each cell the same way, so the columns
    // line up instead of the two rows deriving their tracks from different
    // widths.
    expect([...head.children].every((cell) => cell.className.includes("px-[13px]"))).toBe(true);
  });

  it("keeps the archive card head, its two actions and the lifecycle readout", async () => {
    renderApp("/archive");
    const page = await screen.findByTestId("archive-page");
    expect(within(page).getByRole("heading", { name: "已归档" })).toBeInTheDocument();

    const archived = (useHostStore.getState().workspace?.tasks ?? []).filter((task) => task.archived);
    expect(archived.length).toBeGreaterThan(0);
    for (const task of archived) {
      const card = within(page).getByText(task.name).closest(".card") as HTMLElement;
      expect(card).not.toBeNull();
      expect(within(card).getByText(/会话与浏览器状态已保留/)).toBeInTheDocument();
      expect(within(card).getByRole("button", { name: "恢复任务" })).toBeInTheDocument();
      expect(within(card).getByRole("button", { name: "预览清理清单" })).toBeInTheDocument();
    }
    // The Host-owned lifecycle readout is still on the page.
    expect(await within(page).findByText(/归档／恢复不清零或重复累计 Token/)).toBeInTheDocument();
  });
});
