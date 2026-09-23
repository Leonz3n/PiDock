import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp } from "./helpers";

/**
 * [PiDock 12] #12 usage page flow: the detail table stays bounded/virtualized
 * while the reading around it distinguishes reported from unreported usage,
 * groups by the chosen dimension, shows the definitions and offers an explicit
 * cleanup scope (archiving alone never removes usage).
 */
describe("[PiDock 12] usage page", () => {
  it("shows the window, the completeness split and the definitions", async () => {
    renderApp("/usage");
    expect(await screen.findByRole("heading", { name: "Token 用量" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("usage-table")).toHaveAttribute("data-total-rows", "240"));
    expect(screen.getByText(/统计范围为本应用记录/)).toBeInTheDocument();
    expect(screen.getByText("其中 reasoning")).toBeInTheDocument();
    expect(screen.getByText("已报告 / 部分 / 未报告")).toBeInTheDocument();
    expect(screen.getByText("统计范围")).toBeInTheDocument();
    expect(screen.getByText(/日期型边界按 UTC\+08:00/)).toBeInTheDocument();
    // The default window label states the declared timezone.
    expect(screen.getByText(/UTC\+08:00，含边界/)).toBeInTheDocument();
  });

  it("narrows the detail rows by call type and regroups on demand", async () => {
    const user = userEvent.setup();
    renderApp("/usage");
    await waitFor(() => expect(screen.getByTestId("usage-table")).toHaveAttribute("data-total-rows", "240"));
    // 240 fixture rows cycle through six call types, so compaction is one sixth.
    await user.click(screen.getByRole("tab", { name: "压缩" }));
    await waitFor(() => expect(screen.getByTestId("usage-table")).toHaveAttribute("data-total-rows", "40"));
    await user.click(screen.getByRole("tab", { name: "全部类型" }));
    await user.click(screen.getByRole("tab", { name: "调用类型" }));
    await waitFor(() => expect(screen.getByTestId("usage-table")).toHaveAttribute("data-total-rows", "240"));
    expect(await screen.findByRole("heading", { name: "分组 · 调用类型" })).toBeInTheDocument();
    const groupPanel = screen.getByRole("heading", { name: "分组 · 调用类型" }).closest("section") ?? document.body;
    expect(groupPanel.textContent).toContain("压缩");
    expect(groupPanel.textContent).toContain("回合");
  });

  it("clears only the scope the user names and reports what stayed", async () => {
    const user = userEvent.setup();
    renderApp("/usage");
    await waitFor(() => expect(screen.getByTestId("usage-table")).toHaveAttribute("data-total-rows", "240"));
    await user.click(screen.getByRole("button", { name: "清理全部用量" }));
    await waitFor(() => expect(screen.getByTestId("usage-table")).toHaveAttribute("data-total-rows", "0"));
    expect(screen.getByText(/清理全部用量明细：移除 240 条，剩余 0 条/)).toBeInTheDocument();
  });

  it("clears a single session's usage without touching the others", async () => {
    const user = userEvent.setup();
    renderApp("/usage");
    await waitFor(() => expect(screen.getByTestId("usage-table")).toHaveAttribute("data-total-rows", "240"));
    await user.clear(screen.getByLabelText("清理会话 ID"));
    await user.type(screen.getByLabelText("清理会话 ID"), "deploy");
    await user.click(screen.getByRole("button", { name: "清理该会话用量" }));
    await waitFor(() => expect(screen.getByTestId("usage-table")).toHaveAttribute("data-total-rows", "180"));
    expect(screen.getByText(/仅清理会话 deploy 的用量明细/)).toBeInTheDocument();
  });
});
