import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useHostStore } from "../stores/host";
import { actStore, renderApp } from "./helpers";

// Flow: [UI 对齐 03] (#27) the task header follows prototype A
// (`prototypes/pidock-ui/app.js` `header()`): a `TASK WORKSPACE #<key>` eyebrow,
// the title, one `actionset` (tool launcher icons, Subagent trigger, 添加目录, the
// local-service run toggle and the `···` 任务操作 menu) and a single `.meta` line.
// The former second row of text buttons is gone, so every secondary action must
// stay reachable through the menu — the mapping is asserted below.
//
// jsdom has no layout: the measured vertical budget per viewport lives in
// `docs/evidence/ui-alignment-s2/` (headless Chromium) — see `vertical-budget.json`.

function actionset() {
  return screen.getByTestId("task-actionset");
}

describe("task header actionset", () => {
  it("keeps one actionset row with the tool launcher, Subagent trigger, 添加目录, the run toggle and 任务操作", async () => {
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    const set = actionset();
    for (const tool of ["运行", "协议", "浏览器", "文件", "终端", "日志"]) {
      expect(within(set).getByRole("button", { name: tool })).toBeInTheDocument();
    }
    expect(within(set).getByRole("button", { name: "查看 Subagent，共 2 个" })).toBeInTheDocument();
    expect(within(set).getByRole("button", { name: "添加目录" })).toBeInTheDocument();
    // The seed runs 4 of 5 local services, so the toggle offers 启动本地服务.
    expect(within(set).getByRole("button", { name: "启动本地服务" })).toBeInTheDocument();
    expect(within(set).getByRole("button", { name: "任务操作" })).toBeInTheDocument();

    // The old text-button row is gone: the header's second row is the meta line,
    // so no tool entry renders twice outside the actionset.
    expect(screen.getAllByRole("button", { name: "运行" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "归档当前任务" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "审阅与交付" })).not.toBeInTheDocument();
  });

  it("marks an open tool and the Subagent rail as pressed, and drives every local service", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    expect(screen.getByRole("button", { name: "文件" })).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: "文件" }));
    expect(screen.getByRole("button", { name: "文件" })).toHaveAttribute("aria-pressed", "true");

    // The run toggle drives every local service of this task (the prototype's
    // `toggle-run`): the stopped seed service starts, and the label follows the
    // service state instead of a second source of truth.
    const local = (task: { services: { mode: string; running: boolean }[] }) =>
      task.services.filter((service) => service.mode === "local");
    await user.click(screen.getByRole("button", { name: "启动本地服务" }));
    const started = await useHostStore.getState().task("release");
    expect(local(started!).filter((service) => !service.running)).toHaveLength(0);
    await user.click(await screen.findByRole("button", { name: "停止服务" }));
    const stopped = await useHostStore.getState().task("release");
    expect(local(stopped!).filter((service) => service.running)).toHaveLength(0);
    expect(await screen.findByRole("button", { name: "启动本地服务" })).toBeInTheDocument();
  });

  it("keeps the prototype's single meta line", async () => {
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    const header = screen.getByTestId("task-header-release");
    expect(within(header).getByText("task/task-a1f92c3d")).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: /测试环境 · v12/ })).toBeInTheDocument();
    expect(within(header).getByText("4 / 5 本地服务")).toBeInTheDocument();
    expect(within(header).getByText("4 个独立 worktree")).toBeInTheDocument();
    expect(within(header).getByText("1 个普通目录")).toBeInTheDocument();
    expect(within(header).getByText("TASK WORKSPACE")).toBeInTheDocument();
    // Prototype `TASK WORKSPACE #001`: the product has no ordinal, so the task
    // key stands in (without the `task-` prefix) and the full key stays in the
    // eyebrow's `title`.
    expect(within(header).getByText("#a1f92c3d")).toBeInTheDocument();
    const eyebrow = within(header).getByText("TASK WORKSPACE").closest("[title]");
    expect(eyebrow).toHaveAttribute("title", expect.stringContaining("task-a1f92c3d"));
    // The prototype keeps both a space and an 8px gap (`app.js` `header()`); the
    // space is what the accessible text (and a screen reader) relies on.
    expect(eyebrow?.textContent).toBe("TASK WORKSPACE #a1f92c3d");
  });

  it("keeps the run toggle visible but disabled when the task has no local service", async () => {
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    // Flip every local service to the remote test environment through the
    // existing seam; the prototype's `toggle-run` still renders.
    const before = await useHostStore.getState().task("release");
    const localIds = (before?.services ?? []).filter((service) => service.mode === "local").map((service) => service.id);
    expect(localIds.length).toBeGreaterThan(0);
    for (const id of localIds) {
      await actStore(async () => {
        await useHostStore.getState().setServiceMode("release", id, "remote");
      });
    }
    const toggle = await screen.findByRole("button", { name: "启动本地服务" });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("title", "当前任务没有本地服务");
    // A disabled button that still looks primary reads as broken; `Button` now
    // carries the disabled affordance itself (#27 review note).
    expect(toggle.className).toContain("disabled:opacity-50");
    expect(toggle.className).toContain("disabled:cursor-not-allowed");
  });
});

describe("task 任务操作 menu", () => {
  it("holds the mapped secondary actions and opens the delivery review from the menu", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    await user.click(screen.getByRole("button", { name: "任务操作" }));
    const menu = await screen.findByRole("menu", { name: "任务操作" });

    // Old entry → new position mapping for a mixed task.
    for (const label of ["重命名任务", "新建会话", "查看全部会话", "Subagent 列表（2）", "管理仓库与目录", "审阅与交付", "归档当前任务"]) {
      expect(within(menu).getByRole("menuitem", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "任务操作" })).toHaveAttribute("aria-expanded", "true");

    await user.click(within(menu).getByRole("menuitem", { name: "审阅与交付" }));
    expect(await screen.findByRole("dialog", { name: "审阅与交付" })).toBeInTheDocument();
    expect(screen.queryByRole("menu", { name: "任务操作" })).not.toBeInTheDocument();
  });

  it("leaves the menu on Escape with focus back on the trigger and cycles items with the arrow keys", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    const trigger = screen.getByRole("button", { name: "任务操作" });
    // The trigger is a menu button, not a toggle: it must not carry
    // `aria-pressed` next to `aria-haspopup` (#27 review note).
    expect(trigger).not.toHaveAttribute("aria-pressed");
    await user.click(trigger);
    const menu = await screen.findByRole("menu", { name: "任务操作" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items[0]).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(items[1]).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(items[items.length - 1]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(items[0]).toHaveFocus();
    await user.keyboard("{End}");
    expect(items[items.length - 1]).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "任务操作" })).not.toBeInTheDocument();
    await expect(trigger).toHaveFocus();
  });

  it("opens from the keyboard on the focused trigger and ignores a second Escape", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    const trigger = screen.getByRole("button", { name: "任务操作" });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("menu", { name: "任务操作" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "任务操作" })).not.toBeInTheDocument();

    trigger.focus();
    await user.keyboard("{ }");
    expect(await screen.findByRole("menu", { name: "任务操作" })).toBeInTheDocument();
  });

  it("closes when a pointer press lands outside the menu", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    await user.click(screen.getByRole("button", { name: "任务操作" }));
    expect(await screen.findByRole("menu", { name: "任务操作" })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "任务操作" })).not.toBeInTheDocument();
  });

  it("archives the task through the menu entry", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    await user.click(screen.getByRole("button", { name: "任务操作" }));
    const menu = await screen.findByRole("menu", { name: "任务操作" });
    await user.click(within(menu).getByRole("menuitem", { name: "归档当前任务" }));
    const dialog = await screen.findByRole("dialog", { name: "归档任务" });
    await actStore(async () => {
      await useHostStore.getState().archiveTask("release");
    });
    expect((await useHostStore.getState().task("release"))?.archived).toBe(true);
    expect(within(dialog).getByRole("button", { name: /归档|取消/ })).toBeInTheDocument();
  });
});

describe("task workspace vertical structure", () => {
  it("keeps the conversation as the only growing block and the composer measurable", async () => {
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    const messages = screen.getByRole("log", { name: "会话消息" });
    expect(messages.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-h-0", "flex-1"]));
    expect(screen.getByTestId("task-composer")).toBeInTheDocument();
    // The workspace stacks without the removed button row: no gap-3 band remains.
    const workspace = screen.getByTestId("task-workspace");
    expect(workspace.className.split(/\s+/)).toContain("gap-1.5");
  });

  it("keeps the prototype's stacked height for the subagent-only rail and 500px with a panel", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    const list = await screen.findByLabelText("当前会话启动的 Subagent");
    await user.click(within(list).getByText("查询链路分析"));
    await screen.findByTestId("subagent-sidebar");
    // Prototype `@media(max-width:720px){.subagent-sidebar{height:620px}}`.
    expect(screen.getByTestId("task-rail").className.split(/\s+/)).toContain("below-stack:min-h-[620px]");

    await user.click(screen.getByRole("button", { name: "文件" }));
    const classes = screen.getByTestId("task-rail").className.split(/\s+/);
    expect(classes).toContain("below-stack:min-h-[500px]");
    expect(classes).not.toContain("below-stack:min-h-[620px]");
  });
});
