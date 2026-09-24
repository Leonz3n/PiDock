import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp } from "./helpers";
import { useHostStore } from "../stores/host";
import { useUiStore } from "../stores/ui";

/**
 * [UI 对齐 04] (#28) the task tool rail.
 *
 * Prototype A renders `.workbench`: a `.work-tabs` strip with one tab per open
 * tool (each with its own close button), the 收起工具区 control, and a single
 * `.work-content` that shows only the active panel. The rail therefore never
 * stacks panels, and closing a tab only removes the tab — services, browser
 * state and terminals belong to the Host and must survive it (the Epic's hard
 * constraint).
 */
async function openTask() {
  const user = userEvent.setup();
  renderApp("/projects/atlas/tasks/release?session=main");
  await screen.findByRole("heading", { name: "发布前检查" });
  return user;
}

describe("task tool rail", () => {
  it("renders one tab per open tool and only the active panel's content", async () => {
    const user = await openTask();

    await user.click(screen.getByRole("button", { name: "文件" }));
    expect(await screen.findByTestId("file-roots")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "终端" }));
    const tabs = await screen.findByTestId("tool-tabs");
    expect(within(tabs).getAllByRole("tab")).toHaveLength(2);

    // Only the terminal panel is rendered, even though two tools are open.
    expect(await screen.findByTestId("terminal-spawn-residual")).toBeInTheDocument();
    expect(screen.queryByTestId("file-roots")).not.toBeInTheDocument();

    // The tab strip names the selection for assistive tech.
    expect(screen.getByTestId("tool-tab-terminal")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("tool-tab-files")).toHaveAttribute("aria-selected", "false");

    // Switching tabs swaps the content without closing anything.
    await user.click(screen.getByTestId("tool-tab-files"));
    expect(await screen.findByTestId("file-roots")).toBeInTheDocument();
    expect(screen.getByTestId("tool-tab-files")).toHaveAttribute("aria-selected", "true");
    expect(within(await screen.findByTestId("tool-tabs")).getAllByRole("tab")).toHaveLength(2);
  });

  it("keeps the header tool buttons in sync with the tabs in both directions", async () => {
    const user = await openTask();
    const headerButton = () => screen.getByRole("button", { name: "文件" });
    expect(headerButton()).toHaveAttribute("aria-pressed", "false");

    // Header opens the tab…
    await user.click(headerButton());
    expect(headerButton()).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("tool-tab-files")).toBeInTheDocument();

    // …and closing the tab from the strip clears the header state again.
    await user.click(screen.getByTestId("tool-tab-close-files"));
    expect(headerButton()).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("task-rail")).toBeNull();

    // A second panel opened from the header stays switchable via its tab.
    await user.click(headerButton());
    await user.click(screen.getByRole("button", { name: "运行" }));
    await user.click(screen.getByTestId("tool-tab-files"));
    expect(headerButton()).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "运行" })).toHaveAttribute("aria-pressed", "true");
  });

  it("closes one tab without touching services, browser state or terminals", async () => {
    const user = await openTask();

    // Host-owned state the rail must not disturb: a running service, a started
    // terminal and the browser page the user took over.
    await user.click(screen.getByRole("button", { name: "启动本地服务" }));
    await user.click(screen.getByRole("button", { name: "终端" }));
    await user.click(await screen.findByRole("button", { name: "按计划启动终端" }));
    await screen.findByTestId("terminal-instance");
    await user.click(screen.getByRole("button", { name: "浏览器" }));
    await user.click(screen.getByRole("button", { name: "接管浏览器" }));
    await user.click(screen.getByRole("button", { name: "运行" }));

    const servicesBefore = (await useHostStore.getState().task("release"))!.services.map((service) => `${service.id}:${service.running}`).sort();
    const pagesBefore = JSON.stringify((await useHostStore.getState().task("release"))!.browserPages);
    const terminalsBefore = JSON.stringify(await useHostStore.getState().terminalState("release"));
    const takeoverBefore = useUiStore.getState().browserTakeover["release"];
    expect(takeoverBefore).toBe(true);
    expect(within(await screen.findByTestId("tool-tabs")).getAllByRole("tab")).toHaveLength(3);

    await user.click(screen.getByTestId("tool-tab-close-terminal"));

    // Only the rail changed: the terminal tab is gone, the other two stay.
    expect(screen.queryByTestId("tool-tab-terminal")).not.toBeInTheDocument();
    expect(screen.getByTestId("tool-tab-browser")).toBeInTheDocument();
    expect(screen.getByTestId("tool-tab-runtime")).toBeInTheDocument();
    const servicesAfter = (await useHostStore.getState().task("release"))!.services.map((service) => `${service.id}:${service.running}`).sort();
    expect(servicesAfter).toEqual(servicesBefore);
    expect(servicesAfter.some((entry) => entry.endsWith(":true"))).toBe(true);
    expect(JSON.stringify((await useHostStore.getState().task("release"))!.browserPages)).toBe(pagesBefore);
    expect(JSON.stringify(await useHostStore.getState().terminalState("release"))).toBe(terminalsBefore);
    expect(useUiStore.getState().browserTakeover["release"]).toBe(takeoverBefore);
  });

  it("closes every tab from the rail control and re-opens on demand", async () => {
    const user = await openTask();
    await user.click(screen.getByRole("button", { name: "文件" }));
    await user.click(screen.getByRole("button", { name: "日志" }));
    await user.click(await screen.findByTestId("collapse-tools"));

    expect(screen.queryByTestId("task-rail")).toBeNull();
    expect(screen.getByRole("button", { name: "文件" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "日志" })).toHaveAttribute("aria-pressed", "false");

    // The rail comes back with only what the user opens again.
    await user.click(screen.getByRole("button", { name: "日志" }));
    expect(within(await screen.findByTestId("tool-tabs")).getAllByRole("tab")).toHaveLength(1);
  });

  it("drives the tabs from the keyboard", async () => {
    const user = await openTask();
    await user.click(screen.getByRole("button", { name: "文件" }));
    await user.click(screen.getByRole("button", { name: "运行" }));
    await user.click(screen.getByRole("button", { name: "日志" }));

    const active = screen.getByTestId("tool-tab-logs");
    expect(active).toHaveAttribute("tabindex", "0");
    expect(screen.getByTestId("tool-tab-files")).toHaveAttribute("tabindex", "-1");

    // Roving tab index: arrow keys move the selection and the focus.
    active.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByTestId("tool-tab-files")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("tool-tab-files")).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByTestId("tool-tab-logs")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByTestId("tool-tab-runtime")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}");
    expect(screen.getByTestId("tool-tab-files")).toHaveAttribute("aria-selected", "true");

    // Enter and Space activate the focused tab.
    screen.getByTestId("tool-tab-runtime").focus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("tool-tab-runtime")).toHaveAttribute("aria-selected", "true");
    screen.getByTestId("tool-tab-logs").focus();
    await user.keyboard(" ");
    expect(screen.getByTestId("tool-tab-logs")).toHaveAttribute("aria-selected", "true");
  });

  it("groups service rows by local/remote and keeps the endpoint readable", async () => {
    const user = await openTask();
    await user.click(screen.getByRole("button", { name: "运行" }));

    const local = await screen.findByTestId("service-list-local");
    const remote = screen.getByTestId("service-list-remote");
    // Prototype grouping titles; the local list holds the runnable units only.
    expect(screen.getByText("本地运行")).toBeInTheDocument();
    expect(screen.getByText("远程依赖")).toBeInTheDocument();
    expect(within(local).getByTestId("service-row-release-service-1")).toBeInTheDocument();
    // The prepare step is local (it runs in the task) but has no endpoint port.
    expect(within(local).getByTestId("service-row-release-service-5")).toBeInTheDocument();
    expect(within(local).queryByTestId("service-row-release-service-6")).not.toBeInTheDocument();
    expect(within(remote).getByTestId("service-row-release-service-6")).toBeInTheDocument();

    // The endpoint owns its own line (prototype `.endpoint`), and the truncated
    // identity stays reachable through `title` (#27 review P2-A).
    const row = within(local).getByTestId("service-row-release-service-1").closest("li") as HTMLElement;
    expect(row).toHaveTextContent("127.0.0.1:5173 · 运行中");
    expect(row).toHaveAttribute("title", expect.stringContaining("release/release-service-1@5173"));
    const remoteRow = within(remote).getByTestId("service-row-release-service-6").closest("li") as HTMLElement;
    expect(remoteRow).toHaveTextContent("测试环境 · 共享");
    const prepareRow = within(local).getByTestId("service-row-release-service-5").closest("li") as HTMLElement;
    expect(prepareRow).toHaveTextContent("准备步骤 · 本机命令");

    // The prototype's route box answers "where do requests go".
    const route = await screen.findByTestId("service-route-box");
    expect(route).toHaveTextContent("请求去向");
    expect(route).toHaveTextContent("saas-web");
    expect(route).toHaveTextContent("invoice-service");
    expect(route).toHaveTextContent("远程");
    expect(screen.getByTestId("service-runtime-note")).toHaveTextContent("按任务独立");

    // Mode toggle and run button stay scoped to their own service.
    const toggle = within(local).getByRole("button", { name: "切换 saas-web 依赖去向" });
    expect(toggle.parentElement?.className).toContain("shrink-0");
    expect(toggle.parentElement?.className).toContain("whitespace-nowrap");
    expect(within(local).getByRole("button", { name: "停止 saas-web" })).toBeInTheDocument();
  });
});
