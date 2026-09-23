import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp } from "./helpers";

/**
 * [PiDock 14] (#17) archive & cleanup page flow: the lifecycle readout, the
 * export selection in the cleanup preview, the warning that unselected records
 * are removed, and the receipt/recovery of a completed run. Runs on the
 * in-memory projection — the Host readout and the real removal are covered by
 * the shell-side tests; the no-real-process-kill gap is recorded in the issue.
 */
async function archivedPanel(name: string): Promise<HTMLElement> {
  for (const node of await screen.findAllByText(name)) {
    const li = node.closest("li");
    if (li !== null && within(li).queryByRole("button", { name: "预览清理清单" }) !== null) return li;
  }
  throw new Error(`归档页没有找到任务面板：${name}`);
}

describe("archive & cleanup page", () => {
  it("shows the lifecycle readout of an archived task and restores it", async () => {
    const user = userEvent.setup();
    renderApp("/archive");

    const scope = within(await archivedPanel("旧登录重构"));
    expect(scope.getByText("已归档", { selector: "span" })).toBeInTheDocument();
    expect(await scope.findByText(/未归档|已归档（/)).toBeInTheDocument();
    // Usage is never zeroed by archiving or restoring (box 10).
    expect(await scope.findByText(/归档／恢复不清零或重复累计 Token/)).toBeInTheDocument();
    // Restoring never resumes scheduling or starts services on its own.
    expect(screen.getByText(/恢复任务不自动启动服务或重新启用调度/)).toBeInTheDocument();
    expect(scope.getByText(/调度/)).toBeInTheDocument();

    await user.click(scope.getByRole("button", { name: "恢复任务" }));
    await waitFor(() => expect(within(scope.getByText("旧登录重构")).queryByText("恢复任务")).toBeNull());
  });

  it("previews the cleanup scope for a chosen export and warns about the unselected records", async () => {
    const user = userEvent.setup();
    renderApp("/archive");

    await user.click(within(await archivedPanel("旧登录重构")).getByRole("button", { name: "预览清理清单" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("清理清单预览")).toBeInTheDocument();
    // Nothing is previewed before the user asks for a list.
    expect(within(dialog).queryByText("代码")).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("checkbox", { name: "导出用量" }));
    await user.click(within(dialog).getByRole("button", { name: "生成清单" }));

    // The preview keeps the code as an independent copy and removes only
    // identity-confirmed managed records (box 6–9).
    const codeRow = (await within(dialog).findByText("代码")).closest("tr");
    expect(codeRow?.textContent).toContain("保留独立副本");
    expect(within(dialog).getByText(/未选择导出的会话／草稿记录将被移除/)).toBeInTheDocument();
    const usageRow = within(dialog).getByText("用量").closest("tr");
    expect(usageRow?.textContent).toContain("导出");
  });

  it("runs the cleanup and shows the receipt plus the per-item recovery entries", async () => {
    const user = userEvent.setup();
    renderApp("/archive");

    await user.click(within(await archivedPanel("旧登录重构")).getByRole("button", { name: "预览清理清单" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "生成清单" }));
    await within(dialog).findByText("代码");

    await user.click(within(dialog).getByRole("button", { name: "确认执行清理" }));

    expect(await within(dialog).findByText("清理回执")).toBeInTheDocument();
    expect(within(dialog).getByText(/保留位置：/)).toBeInTheDocument();
    // Browser state removal is not wired to the Host in this slice: the
    // registration stays and one recovery entry explains why.
    expect(await within(dialog).findByText(/browser：浏览器持久数据的移除由主进程持有/)).toBeInTheDocument();
    expect(within(dialog).getByText(/局部清理失败：保留任务登记与逐项恢复入口/)).toBeInTheDocument();
  });
});
