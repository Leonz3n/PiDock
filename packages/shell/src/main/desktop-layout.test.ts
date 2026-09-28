import { describe, expect, it } from "vitest";
import { DesktopLayout, type LayoutBrowser, type LayoutView } from "./desktop-layout.js";

function view() {
  let bounds = { x: 0, y: 0, width: 1, height: 1 };
  let visible = true;
  return {
    setBounds(next: typeof bounds) { bounds = next; },
    getBounds: () => bounds,
    setVisible(next: boolean) { visible = next; },
    getVisible: () => visible,
  };
}

function browser() {
  const page = view();
  let active = false;
  let visible = false;
  return {
    page,
    get activeTab() { return active ? { view: page } : undefined; },
    setActive(next: boolean) { active = next; },
    setBounds(bounds: { x: number; y: number; width: number; height: number }) { page.setBounds(bounds); },
    setVisible(next: boolean) { visible = next; page.setVisible(next && active); },
    get visible() { return visible; },
  };
}

describe("Desktop main-owned layout", () => {
  it("starts with a full-width shell and hidden fixture; resizes the idle shell", () => {
    let size = { width: 1440, height: 900 };
    const shell = view();
    const fixture = view();
    const layout = new DesktopLayout(() => size, shell as LayoutView, fixture as LayoutView);
    expect(shell.getBounds()).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
    expect(fixture.getVisible()).toBe(false);
    size = { width: 720, height: 560 };
    layout.resize();
    expect(shell.getBounds()).toEqual({ x: 0, y: 0, width: 720, height: 560 });
  });

  it("selects committed real pages, hides other tasks, restores prior task on close and resizes the visible page", () => {
    let size = { width: 1440, height: 900 };
    const shell = view();
    const fixture = view();
    const layout = new DesktopLayout(() => size, shell as LayoutView, fixture as LayoutView);
    const first = browser();
    const second = browser();
    layout.addBrowser(first as LayoutBrowser);
    layout.addBrowser(second as LayoutBrowser);
    expect(first.visible).toBe(false);
    first.setActive(true);
    layout.browserChanged(first as LayoutBrowser);
    expect(shell.getBounds().width).toBe(380);
    expect(first.page.getVisible()).toBe(true);
    second.setActive(true);
    layout.browserChanged(second as LayoutBrowser);
    expect(first.page.getVisible()).toBe(false);
    expect(second.page.getVisible()).toBe(true);
    size = { width: 720, height: 560 };
    layout.resize();
    expect(second.page.getBounds()).toEqual({ x: 280, y: 0, width: 440, height: 560 });
    second.setActive(false);
    layout.browserChanged(second as LayoutBrowser);
    expect(first.page.getVisible()).toBe(true);
    expect(first.page.getBounds()).toEqual({ x: 280, y: 0, width: 440, height: 560 });
    first.setActive(false);
    layout.browserChanged(first as LayoutBrowser);
    expect(shell.getBounds()).toEqual({ x: 0, y: 0, width: 720, height: 560 });
    expect(fixture.getVisible()).toBe(false);
  });
});
