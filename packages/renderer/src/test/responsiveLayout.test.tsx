import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useHostStore } from "../stores/host";
import { renderApp } from "./helpers";

// Flow: [UI 对齐 02] (#26) the shell and the task workspace must degrade the way
// prototype A does (`prototypes/pidock-ui/style.css`): the sidebar narrows to
// 192px below 1180px and to the 64px icon rail below 960px, the task rail follows
// 43%/min 350px → min 310px/40% → min 290px → full width and the task body turns
// into a vertical stack below 720px.
//
// jsdom evaluates no media queries, so these cases assert the tier classes are
// wired to the right elements; the actual geometry per viewport is measured in
// `docs/evidence/ui-alignment-layout/` (headless Chromium) — see its
// `verification-log.md`.

const TIERS = ["below-wide:", "below-mid:", "below-narrow:", "below-stack:"];

function sidebar() {
  return screen.getByTestId("shell-sidebar");
}

function hasTier(className: string, token: string) {
  return className.split(/\s+/).includes(token);
}

describe("shell sidebar tiers", () => {
  it("keeps 226px as the baseline and narrows to 192px/64px icon rail", async () => {
    renderApp("/attention");
    await screen.findByRole("button", { name: "项目总览" });

    const classes = sidebar().className;
    expect(hasTier(classes, "w-[226px]")).toBe(true);
    expect(hasTier(classes, "below-wide:w-[192px]")).toBe(true);
    expect(hasTier(classes, "below-mid:w-16")).toBe(true);
    expect(hasTier(classes, "below-mid:px-2")).toBe(true);
    // Every tier used here must be one of the prototype's four breakpoints.
    expect(TIERS.filter((tier) => classes.includes(tier)).length).toBeGreaterThan(0);
  });

  it("hides the workspace card, group heading, task list, counts and chip text in the rail", async () => {
    renderApp("/attention");
    const card = await screen.findByRole("button", { name: "切换工作区：Atlas Web" });
    // Prototype `@media(max-width:960px)`: `.brand-name, .project-choice, .count,
    // .navlabel, .tasklist, .user-name, .sidebar .newtask { display: none }`.
    expect(hasTier(card.className, "below-mid:hidden")).toBe(true);
    expect(hasTier(within(sidebar()).getByText("PiDock").className, "below-mid:hidden")).toBe(true);

    const tasks = sidebar().querySelector('[data-nav-group="tasks"]') as HTMLElement;
    expect(hasTier(within(tasks).getByRole("button", { name: "在当前工作区新建任务" }).parentElement!.className, "below-mid:hidden")).toBe(
      true,
    );
    expect(hasTier(tasks.querySelector('[data-task-nav="release"]')!.parentElement!.className, "below-mid:hidden")).toBe(true);

    const chip = sidebar().querySelector('[data-user-chip="local-workspace"]') as HTMLElement;
    expect(hasTier(within(chip).getByText("本机工作区").className, "below-mid:hidden")).toBe(true);
  });

  it("keeps an accessible name per rail button (`sr-only` label, centered icon)", async () => {
    renderApp("/attention");
    const overview = await screen.findByRole("button", { name: "项目总览" });
    // The prototype hides the label with `display:none`; `sr-only` keeps the
    // accessible name while the rail shows only the icon.
    const label = within(overview).getByText("项目总览");
    expect(hasTier(label.className, "below-mid:sr-only")).toBe(true);
    expect(hasTier(overview.className, "below-mid:justify-center")).toBe(true);

    const attention = screen.getByRole("button", { name: /^需要处理/ });
    const count = useHostStore.getState().attention.length;
    expect(hasTier(within(attention).getByText(String(count)).className, "below-mid:hidden")).toBe(true);
    // The name itself must survive: role + name still resolves in the rail.
    expect(screen.getByRole("button", { name: "环境与服务" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "已归档" })).toBeInTheDocument();
  });
});

describe("task workspace tiers", () => {
  it("stacks the task body below 720px and floors the conversation at 550px", async () => {
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    const body = screen.getByTestId("task-body");
    expect(hasTier(body.className, "below-stack:block")).toBe(true);
    expect(hasTier(body.className, "below-stack:flex-none")).toBe(true);
    expect(hasTier(body.className, "below-stack:space-y-3")).toBe(true);
    expect(hasTier(screen.getByTestId("task-workspace").className, "below-stack:min-h-[550px]")).toBe(true);
    // The conversation column must be allowed to shrink (`min-width:auto` would
    // keep the rail from ever fitting next to it).
    expect(hasTier(screen.getByTestId("task-workspace").className, "min-w-0")).toBe(true);
    // A new task shows the conversation only: no tool rail until one is opened.
    expect(screen.queryByTestId("task-rail")).toBeNull();
  });

  it("opens the tool rail at the prototype's 43%/min 350px and narrows it per tier", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    await user.click(screen.getByRole("button", { name: "文件" }));
    const rail = screen.getByTestId("task-rail");
    const classes = rail.className;
    expect(hasTier(classes, "w-[43%]")).toBe(true);
    expect(hasTier(classes, "min-w-[350px]")).toBe(true);
    expect(hasTier(classes, "below-wide:min-w-[310px]")).toBe(true);
    expect(hasTier(classes, "below-wide:w-[40%]")).toBe(true);
    expect(hasTier(classes, "below-mid:min-w-[290px]")).toBe(true);
    // Below 720px the rail is the second stacked block, at full width.
    expect(hasTier(classes, "below-stack:w-full")).toBe(true);
    expect(hasTier(classes, "below-stack:min-w-0")).toBe(true);
    expect(hasTier(classes, "below-stack:max-w-none")).toBe(true);
    expect(hasTier(classes, "below-stack:min-h-[500px]")).toBe(true);
  });

  it("keeps the subagent panel in the same rail so the conversation cannot be crushed", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    const list = await screen.findByLabelText("当前会话启动的 Subagent");
    await user.click(within(list).getByText("查询链路分析"));
    const panel = await screen.findByTestId("subagent-sidebar");
    // One rail, not two free-standing columns: 43% + 40% would leave nothing.
    expect(document.querySelectorAll('[data-testid="task-rail"]')).toHaveLength(1);
    expect(screen.getByTestId("task-rail").contains(panel)).toBe(true);

    const onlySubagent = screen.getByTestId("task-rail").className;
    expect(hasTier(onlySubagent, "w-[40%]")).toBe(true);
    expect(hasTier(onlySubagent, "min-w-[340px]")).toBe(true);
    expect(hasTier(onlySubagent, "max-w-[520px]")).toBe(true);
    expect(hasTier(onlySubagent, "below-narrow:min-w-[300px]")).toBe(true);
    expect(hasTier(onlySubagent, "below-narrow:w-[45%]")).toBe(true);

    // With a tool panel also open the rail keeps the tool geometry and stacks
    // the subagent panel in the same column.
    await user.click(screen.getByRole("button", { name: "文件" }));
    const rail = screen.getByTestId("task-rail");
    expect(hasTier(rail.className, "w-[43%]")).toBe(true);
    expect(hasTier(rail.className, "w-[40%]")).toBe(false);
    expect(rail.contains(screen.getByTestId("subagent-sidebar"))).toBe(true);
  });
});
