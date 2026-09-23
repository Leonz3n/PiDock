import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runningServiceCount } from "../data/shellNav";
import { useHostStore } from "../stores/host";
import { renderApp } from "./helpers";

// Flow: [UI 对齐 01] (#25) the shell must match prototype A: three sidebar
// groups, the workspace card and user chip, the aligned wording, the
// `工作区 / <工作区名> / <页面或任务>` breadcrumb and the bottom summary bar
// (read-only — the prototype's A/B/C switcher is not part of the product).

type BridgedWindow = { pidock?: { taskOp: ReturnType<typeof vi.fn> } };

function stubShell(taskOp: ReturnType<typeof vi.fn>) {
  (window as unknown as BridgedWindow).pidock = { taskOp };
}

afterEach(() => {
  delete (window as unknown as BridgedWindow).pidock;
});

function group(name: "workspace" | "tasks" | "system") {
  return screen.getByTestId("shell-sidebar").querySelector(`[data-nav-group="${name}"]`) as HTMLElement;
}

function navItemLabels(container: HTMLElement) {
  return within(container)
    .getAllByRole("button")
    .filter((button) => button.dataset["taskNav"] === undefined)
    .map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "");
}

function taskCardIds(container: HTMLElement) {
  return Array.from(container.querySelectorAll("[data-task-nav]")).map((card) => card.getAttribute("data-task-nav"));
}

describe("shell sidebar groups", () => {
  it("renders the three prototype groups in order with `+` only on 进行中的任务", async () => {
    renderApp("/attention");
    await screen.findByRole("button", { name: "项目总览" });

    expect(navItemLabels(group("workspace"))).toEqual(["项目总览", "环境与服务", "Token 用量"]);
    expect(navItemLabels(group("system"))).toEqual([
      `需要处理${useHostStore.getState().attention.length}`,
      "定时任务",
      "能力管理",
      "远程访问",
      "本机设置",
      "模型与 Provider",
    ]);
    // Only the running tasks of the selected workspace: the archived task
    // `legacy-auth` stays out, like prototype A does.
    expect(taskCardIds(group("tasks"))).toEqual(["release", "checkout", "design-docs"]);
    expect(navItemLabels(group("tasks"))).toEqual(["在当前工作区新建任务", "已归档"]);
    expect(within(group("workspace")).queryByRole("button", { name: "在当前工作区新建任务" })).toBeNull();
    expect(within(group("system")).queryByRole("button", { name: "在当前工作区新建任务" })).toBeNull();
    expect(within(group("tasks")).getByRole("button", { name: "在当前工作区新建任务" })).toBeInTheDocument();
  });

  it("keeps the task card keyboard-focusable and opens the rename from the contextmenu event", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    const card = group("tasks").querySelector('[data-task-nav="release"]') as HTMLButtonElement;
    // Prototype A keeps the task list free of a per-card menu button: the
    // actions come from the context menu. The card is a real button, so it is
    // reachable with Tab, and Chromium turns the keyboard context-menu keys
    // (ContextMenu key, Shift+F10 on platforms that map it) into a `contextmenu`
    // event on the focused element — the same event a right-click sends. jsdom
    // cannot synthesize that key press, so this test focuses the card and
    // dispatches the event itself; the real key press is covered in the browser
    // run recorded in docs/evidence/ui-alignment-s1/shell-verification.json.
    card.focus();
    expect(card).toHaveFocus();
    expect(card.querySelectorAll("button")).toHaveLength(0);
    fireEvent.contextMenu(card);

    const input = await screen.findByLabelText("任务名称");
    await user.clear(input);
    await user.type(input, "发布前检查（键盘重命名）");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(card).toHaveTextContent("发布前检查（键盘重命名）"));
    expect(useHostStore.getState().workspace?.tasks.find((task) => task.id === "release")?.name).toBe("发布前检查（键盘重命名）");
  });

  it("disables 项目总览 when the workspace has no project to open", async () => {
    renderApp("/attention");
    const workspace = useHostStore.getState().workspace!;
    await screen.findByRole("button", { name: "项目总览" });
    await act(async () => {
      useHostStore.setState({ workspace: { ...workspace, projects: [], tasks: [] } });
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "项目总览" })).toBeDisabled();
    });
    expect(screen.getByRole("button", { name: "切换工作区：未选择项目" })).toBeInTheDocument();
  });

  it("renders the workspace card and the local workspace chip from the store", async () => {
    renderApp("/attention");
    const card = await screen.findByRole("button", { name: "切换工作区：Atlas Web" });
    expect(within(card).getByText("微服务开发工作台")).toBeInTheDocument();

    const chip = screen.getByTestId("shell-sidebar").querySelector('[data-user-chip="local-workspace"]') as HTMLElement;
    expect(within(chip).getByText("本机工作区")).toBeInTheDocument();
    expect(within(chip).getByText(useHostStore.getState().localSettings!.workspaceRoot)).toBeInTheDocument();  });

  it("switches the workspace from the card so the lists and page data follow", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    await user.click(screen.getByRole("button", { name: "切换工作区：Atlas Web" }));
    const dialog = await screen.findByRole("dialog", { name: "项目管理" });
    const orbitRow = within(dialog).getByText("Orbit API").closest("div")!.parentElement!;
    await user.click(within(orbitRow).getByRole("button", { name: "切换" }));

    expect(await screen.findByRole("heading", { name: "Orbit API" })).toBeInTheDocument();
    const tasks = group("tasks");
    expect(within(tasks).getByText("排查延迟峰值")).toBeInTheDocument();
    expect(within(tasks).queryByText("发布前检查")).toBeNull();
    expect(await screen.findByRole("button", { name: "切换工作区：Orbit API" })).toBeInTheDocument();
  });
});

describe("shell wording, highlight and keyboard reach", () => {
  it("replaces the old view wording in the shell, the breadcrumb and the page", async () => {
    const user = userEvent.setup();
    renderApp("/providers");
    expect(await screen.findByRole("heading", { name: "模型与 Provider" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "模型与 Provider" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByText("Provider 与上下文")).toBeNull();

    await user.click(screen.getByRole("button", { name: "已归档" }));
    expect(await screen.findByRole("heading", { name: "已归档" })).toBeInTheDocument();
    expect(screen.queryByText("归档与清理")).toBeNull();
  });

  it("marks the current item and moves through the shell with Tab, Enter and Space", async () => {
    const user = userEvent.setup();
    renderApp("/usage");
    const usage = await screen.findByRole("button", { name: "Token 用量" });
    expect(usage).toHaveAttribute("aria-current", "page");
    expect(usage.className).toContain("font-semibold");
    expect(screen.getByRole("button", { name: "环境与服务" })).not.toHaveAttribute("aria-current");

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "切换工作区：Atlas Web" }));
    await user.tab();
    const overview = screen.getByRole("button", { name: "项目总览" });
    expect(document.activeElement).toBe(overview);
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { name: "Atlas Web" })).toBeInTheDocument();

    const card = screen.getByTestId("shell-sidebar").querySelector('[data-task-nav="release"]') as HTMLElement;
    card.focus();
    expect(document.activeElement).toBe(card);
    await user.keyboard(" ");
    expect(await screen.findByRole("heading", { name: "发布前检查" })).toBeInTheDocument();
    expect(screen.getByTestId("shell-sidebar").querySelector('[data-task-nav="release"]')).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("keeps the breadcrumb on 工作区 / 工作区名 / 页面或任务", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    const breadcrumb = screen.getByTestId("breadcrumb");
    expect(["工作区", "Atlas Web", "发布前检查"].every((part) => within(breadcrumb).queryByText(part) !== null)).toBe(true);

    await user.click(screen.getByRole("button", { name: "环境与服务" }));
    await screen.findByRole("heading", { name: "环境与服务" });
    expect(within(breadcrumb).getByText("工作区")).toBeInTheDocument();
    expect(within(breadcrumb).getByText("Atlas Web")).toBeInTheDocument();
    expect(within(breadcrumb).getByText("环境与服务")).toBeInTheDocument();
    expect(within(breadcrumb).queryByText("发布前检查")).toBeNull();
  });
});

describe("shell bottom summary bar", () => {
  it("summarises task, services and browser controller without the A/B/C switcher", async () => {
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    const task = useHostStore.getState().workspace!.tasks.find((item) => item.id === "release")!;
    const summary = screen.getByTestId("shell-summary");

    expect(within(summary).getByText("发布前检查")).toBeInTheDocument();
    expect(within(summary).getByText(`${runningServiceCount(task.services)} 服务`)).toBeInTheDocument();
    expect(within(summary).getByText("Agent 控制中")).toBeInTheDocument();
    expect(screen.queryByText("布局探索")).toBeNull();
    expect(screen.queryByRole("button", { name: /对话优先/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /运行优先/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /验证优先/ })).toBeNull();
  });

  it("reports the human takeover the browser panel applied", async () => {
    const user = userEvent.setup();
    const taskOp = vi.fn(async () => ({ ok: true, payload: {} }));
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    stubShell(taskOp);

    await user.click(screen.getByRole("button", { name: "浏览器" }));
    await screen.findByText(/Agent 与用户操作同一页面实例/);
    await user.click(screen.getByRole("button", { name: "人工接管" }));

    expect(await within(screen.getByTestId("shell-summary")).findByText("人工接管中")).toBeInTheDocument();
    expect(taskOp).toHaveBeenCalledWith(
      "release",
      "task/browserAction",
      expect.objectContaining({ action: "takeover/pause" }),
    );
  });
});
