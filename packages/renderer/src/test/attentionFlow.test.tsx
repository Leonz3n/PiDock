import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useHostStore } from "../stores/host";
import { useUiStore } from "../stores/ui";
import { renderApp } from "./helpers";

/**
 * [PiDock 17] (#19 box 5) 需要处理 page: the list is split into 待处理 and
 * 完成未读, clicking 定位会话 goes to the original task/session, and reading a
 * completed result clears its unread mark while a 待确认 item stays until it is
 * handled. Runs on the in-memory projection; the Host-side ledger and read
 * routing are covered by the shell tests.
 */
async function seedAttentionRead(adapterWork: () => Promise<void>) {
  renderApp("/attention");
  await adapterWork();
  await useHostStore.getState().refresh();
}

/** The attention list row whose detail is `text` (the session nav shows the same words). */
function panelOf(text: string): HTMLElement {
  for (const node of screen.getAllByText(text)) {
    const li = node.closest("li");
    if (li !== null && within(li).queryByRole("button", { name: "定位会话" }) !== null) return li;
  }
  throw new Error(`没有找到关注项：${text}`);
}

describe("attention page", () => {
  it("shows the two groups, clears the unread item on 定位会话 and keeps the pending one", async () => {
    const user = userEvent.setup();
    await seedAttentionRead(async () => {
      // A settled turn produces a real 完成未读 item in the memory projection.
      await useHostStore.getState().adapter.sendMessage("latency", "main", "检查延迟", []);
    });

    expect(await screen.findByRole("heading", { name: "待处理" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "完成未读" })).toBeInTheDocument();
    const unreadItem = (await useHostStore.getState().attention).find((item) => item.kind === "completed-unread");
    const approvalItem = (await useHostStore.getState().attention).find((item) => item.kind === "approval");
    expect(unreadItem).toBeDefined();
    expect(approvalItem).toBeDefined();

    // Reading the completed result clears the unread mark.
    await user.click(within(panelOf(unreadItem?.detail as string)).getByRole("button", { name: "定位会话" }));
    await waitFor(() => expect(useHostStore.getState().attention.some((item) => item.id === unreadItem?.id)).toBe(false));
    expect(useUiStore.getState().toasts.some((toast) => toast.text === "已读取完成结果，未读标记已清除")).toBe(true);

    // A 待确认 item is not cleared by reading: it must be handled.
    renderApp("/attention");
    await useHostStore.getState().refresh();
    await user.click(within(panelOf(approvalItem?.detail as string)).getByRole("button", { name: "定位会话" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useHostStore.getState().attention.some((item) => item.id === approvalItem?.id)).toBe(true);
    expect(useUiStore.getState().toasts.every((toast) => toast.text !== "已读取完成结果，未读标记已清除")).toBe(true);
  });

  it("filters the list by kind", async () => {
    const user = userEvent.setup();
    renderApp("/attention");
    await screen.findByRole("heading", { name: "待处理" });
    await user.click(within(screen.getByRole("tablist", { name: "按类型过滤" })).getByRole("tab", { name: "失败" }));
    await waitFor(() => expect(screen.queryByText(/^待确认：/)).toBeNull());
    expect(screen.getAllByText(/^执行失败：/).length).toBeGreaterThan(0);
  });
});
