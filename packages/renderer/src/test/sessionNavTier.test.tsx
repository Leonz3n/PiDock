import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp } from "./helpers";

/**
 * [UI 对齐 05] (#29) session navigation strip.
 *
 * Prototype A (`prototypes/pidock-ui/navigation.js` + `style.css`) renders the
 * row as 全部会话 N + at most four tabs + a `+` icon button; the tabs stay plain
 * buttons (the strip is not an ARIA tablist). The strip was the one place the
 * workspace could still clip ([UI 对齐 03] #27 残项: 41px at 1280px and 149px at
 * 1024px). The prototype's later `style.css` revision answers exactly that: the
 * row keeps one line, a label is never ellipsized (`.session-tab{white-space:
 * nowrap}`), and the row scrolls when it needs more room
 * (`.sessions{overflow-x:auto}`). The implementation copies that, so the tabs
 * no longer shrink into an ellipsis and the tiers only reduce the visible count.
 * jsdom has no layout, so this file checks the class contract; the measured
 * geometry (and its assertions) live in
 * `docs/evidence/ui-alignment-s3/capture-execution.mjs` → `execution-card.json`.
 */
const SEEDED_TABS = ["session-tab-main", "session-tab-deploy", "session-tab-failed", "session-tab-archived-1"];

function tabsOf(strip: HTMLElement) {
  return SEEDED_TABS.map((id) => within(strip).getByTestId(id));
}

describe("session navigation strip", () => {
  it("keeps one scrollable row whose tabs never shrink into an ellipsis", async () => {
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    const strip = await screen.findByTestId("session-tab-strip");
    // The row scrolls instead of hiding its overflow: a crowded strip must stay
    // reachable (prototype `.sessions{overflow-x:auto}`).
    expect(strip.className).toContain("overflow-x-auto");
    expect(strip.className).not.toContain("overflow-hidden");
    expect(strip.className).toContain("flex-nowrap");

    // The seeded task has four active sessions; the cap keeps it at four.
    const [active, first, second, third] = tabsOf(strip);
    // Every tab is `shrink-0`: only the tiers remove tabs, never a cut label.
    expect(active!.className).toContain("shrink-0");
    expect(first!.className).toContain("shrink-0");
    expect(first!.className).not.toContain("shrink ");
    expect(first!.querySelector("span")).toHaveClass("whitespace-nowrap");
    expect(first!.querySelector("span")).not.toHaveClass("truncate");
    // 4 tabs at desktop → 2 below 1180px → 1 below 960px.
    expect(first!.className).toContain("below-mid:hidden");
    expect(second!.className).toContain("below-wide:hidden");
    expect(third!.className).toContain("below-wide:hidden");
    expect(active!.className).not.toContain("hidden");
  });

  it("counts the tiers by non-active tabs so switching sessions never shifts them", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=deploy");
    await screen.findByRole("heading", { name: "发布前检查" });

    const strip = await screen.findByTestId("session-tab-strip");
    const tabs = tabsOf(strip);
    // active=deploy: main keeps the 2-tab tier, failed/archived leave at 1180px.
    expect(tabs[0]!.className).toContain("below-mid:hidden");
    expect(tabs[2]!.className).toContain("below-wide:hidden");
    expect(tabs[3]!.className).toContain("below-wide:hidden");
    // The tab names the right-click action the prototype documents.
    expect(tabs[0]).toHaveAttribute("title", "实现与验证 · 右键操作");
    expect(tabs[0]!.querySelector("span")).toHaveClass("whitespace-nowrap");

    // Switching sessions keeps four tabs and moves the tiers with the active one.
    await user.click(tabs[0]!);
    const after = tabsOf(await screen.findByTestId("session-tab-strip"));
    expect(after).toHaveLength(4);
    expect(after[0]!.className).toContain("shrink-0");
    expect(after[1]!.className).toContain("below-mid:hidden");
  });

  it("opens a new session from the + icon button", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/latency?session=main");
    await screen.findByRole("heading", { name: "排查延迟峰值" });
    const strip = await screen.findByTestId("session-tab-strip");
    expect(within(strip).getAllByTestId(/^session-tab-(?!strip)/)).toHaveLength(1);

    // Prototype `sessionNavigation()`: a `+` icon button named 新建会话, not a
    // text button that competes with the tabs for width.
    const add = screen.getByRole("button", { name: "新建会话" });
    expect(add).toHaveAttribute("title", "新建会话");
    await user.click(add);
    const after = await screen.findByTestId("session-tab-strip");
    expect(within(after).getAllByTestId(/^session-tab-(?!strip)/)).toHaveLength(2);
  });

  it("names the active tab and keeps the last-used session replacing the overflow", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    // 历史排查 (archived, read-only) is the fourth tab: the strip shows its
    // badges, and the 全部会话 entry still reports the full count.
    const strip = await screen.findByTestId("session-tab-strip");
    const archivedTab = within(strip).getByText("历史排查").closest("button") as HTMLElement;
    expect(within(archivedTab).getByText("已归档")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /全部会话 \d+/ })).toBeInTheDocument();

    // Opening the archived session (read-only) never adds a fifth tab.
    await user.click(archivedTab);
    expect(within(await screen.findByTestId("session-tab-strip")).getAllByTestId(/^session-tab-(?!strip)/)).toHaveLength(4);
  });
});
