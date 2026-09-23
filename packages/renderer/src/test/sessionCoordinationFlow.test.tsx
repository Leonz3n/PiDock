import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "./helpers";
import { useHostStore } from "../stores/host";
import { useWriteLockStore } from "../stores/writeLock";

/**
 * [PiDock 09] (#11) multi-session collaboration flows in the task view: the
 * write-coordination bar names the holder (a pending confirmation keeps the
 * right), a second session is refused and queued, the abort entry releases the
 * right and frees the queue, and archiving a session never creates a
 * replacement one.
 */
describe("multi-session write coordination", () => {
  it("shows the holder, queues a second session and releases the right from the abort entry", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=deploy");
    await screen.findByRole("heading", { name: "发布前检查" });

    // The deploy session starts a side-effecting turn that stops at the
    // confirmation: it keeps the task write right (盒子 2).
    const started = await useHostStore.getState().sendMessage("release", "deploy", "部署到 staging", []);
    expect(started.state).toBe("approval");
    const bar = await screen.findByTestId("write-coordination");
    await waitFor(() => expect(bar).toHaveTextContent("部署审查 持有写操作权（等待确认）"));

    // A second session cannot run while the right is held: it is refused with
    // the holder named and shown as queued, not silently dropped.
    await expect(useHostStore.getState().sendMessage("release", "main", "先改一处文件", [])).rejects.toThrow(
      "同一任务写操作权由会话 deploy 持有",
    );
    await waitFor(() =>
      expect(useWriteLockStore.getState().views["release"]?.writeLock).toMatchObject({ owner: "deploy", waiting: ["main"] }),
    );

    // The queued session's tab carries its queue position.
    const mainTab = screen.getByTestId("session-tab-main");
    await waitFor(() => expect(mainTab).toHaveTextContent("排队第 1 位"));

    // Abort the holder: the right is released and the queue is cleared.
    await user.click(screen.getByRole("button", { name: "中止持有者" }));
    await waitFor(() =>
      expect(useWriteLockStore.getState().views["release"]?.writeLock).toMatchObject({ owner: null, waiting: [] }),
    );
    await waitFor(() => expect(screen.queryByTestId("write-coordination")).toBeNull());
    // With the right free the same session writes again (and completes).
    const result = await useHostStore.getState().sendMessage("release", "main", "现在可以改了", []);
    expect(result.state).toBe("completed");
  });

  it("offers the session context menu and archives without creating a replacement", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/latency?session=main");
    await screen.findByRole("heading", { name: "排查延迟峰值" });

    const before = useHostStore.getState().workspace?.tasks.find((item) => item.id === "latency")?.sessions.length ?? 0;
    const tab = screen.getByTestId("session-tab-main");
    await user.pointer({ keys: "[MouseRight]", target: tab });
    const menu = await screen.findByTestId("session-context-menu");
    // The right-click menu offers rename/archive and the shared-list entry.
    expect(within(menu).getByRole("menuitem", { name: "重命名" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "归档会话" })).toBeInTheDocument();

    await user.click(within(menu).getByRole("menuitem", { name: "归档会话" }));
    await waitFor(() =>
      expect(
        useHostStore.getState().workspace?.tasks.find((item) => item.id === "latency")?.sessions.find((session) => session.id === "main")?.archived,
      ).toBe(true),
    );
    // 收口规则：归档最后一个会话不自动新建空会话。
    expect(useHostStore.getState().workspace?.tasks.find((item) => item.id === "latency")?.sessions).toHaveLength(before);
  });

  it("keeps the all-sessions list searchable with roles, activity and unread", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    await user.click(screen.getByRole("button", { name: /全部会话/ }));
    const list = await screen.findByTestId("session-list");
    // Recent activity, tier and unread ride each row (收口: 状态与最近活动);
    // the coordination role badge itself is covered by the tab flow above.
    expect(list).toHaveTextContent("最近活动");
    expect(list).toHaveTextContent("2 条未读");
    expect(list).toHaveTextContent("只读");

    await user.type(screen.getByLabelText("搜索会话"), "部署");
    await waitFor(() => expect(within(list).getByText("部署审查")).toBeInTheDocument());
    expect(within(list).queryByText("实现与验证")).toBeNull();
  });
});
