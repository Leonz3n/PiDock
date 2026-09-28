import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ views: [] as Array<{ webContents: { id: number; loadURL: ReturnType<typeof vi.fn> }; getVisible(): boolean; getBounds(): object }> }));

vi.mock("electron", () => ({
  session: { fromPartition: (partition: string) => ({ partition }) },
  WebContentsView: class {
    webContents = Object.assign(new EventEmitter(), {
      id: state.views.length + 1,
      loadURL: vi.fn(async (url: string) => { if (url.endsWith("/fail")) throw new Error("navigation failed"); }),
      setWindowOpenHandler: vi.fn(),
      isDestroyed: () => false,
      close: vi.fn(),
    });
    private visible = true;
    private bounds = { x: 0, y: 0, width: 1, height: 1 };
    constructor() { state.views.push(this); }
    setVisible(visible: boolean) { this.visible = visible; }
    getVisible() { return this.visible; }
    setBounds(bounds: typeof this.bounds) { this.bounds = bounds; }
    getBounds() { return this.bounds; }
  },
}));

import { TaskBrowser } from "./task-browser.js";
import { DesktopLayout, type LayoutView } from "./desktop-layout.js";
import { TrustDomainRegistry } from "./trust-domain.js";
import type { BrowserWindow } from "electron";

function setup() {
  state.views.length = 0;
  const children: unknown[] = [];
  const window = Object.assign(new EventEmitter(), {
    contentView: {
      addChildView: (view: unknown) => { children.push(view); },
      removeChildView: (view: unknown) => { children.splice(children.indexOf(view), 1); },
    },
  }) as unknown as BrowserWindow;
  const registry = new TrustDomainRegistry();
  const changes: Array<string | undefined> = [];
  const browser = new TaskBrowser({
    window, workspaceId: "ws-a", taskId: "task-a", registry,
    bounds: { x: 380, y: 0, width: 1060, height: 900 },
    onActiveTabChange: (owner) => changes.push(owner.activeTab?.pageId),
  });
  browser.setVisible(false);
  return { browser, changes, children, registry };
}

describe("TaskBrowser committed page visibility", () => {
  it("only notifies after a successful load, and does not obscure an existing page on failed navigation", async () => {
    const { browser, changes, registry } = setup();
    const first = await browser.openTab("http://localhost/one");
    expect(changes).toEqual([first.pageId]);
    expect(first.view.getVisible()).toBe(false);
    browser.setVisible(true);
    const second = await browser.openTab("http://localhost/two");
    expect(changes).toHaveLength(2);
    expect(first.view.getVisible()).toBe(false);
    await expect(browser.openTab("http://localhost/fail")).rejects.toThrow("navigation failed");
    expect(browser.activeTab?.pageId).toBe(second.pageId);
    expect(browser.activeTab?.view.getVisible()).toBe(true);
    expect(changes).toHaveLength(2);
    expect(registry.get(3)).toBeUndefined();
  });

  it("coordinates real page open, failed open, last close, restore and resize without changing task identity", async () => {
    state.views.length = 0;
    let size = { width: 1440, height: 900 };
    const shell = { bounds: { x: 0, y: 0, width: 1, height: 1 }, setBounds(next: typeof shell.bounds) { this.bounds = next; }, setVisible() {} };
    const fixture = { visible: true, setVisible(next: boolean) { this.visible = next; }, setBounds() {} };
    const layout = new DesktopLayout(() => size, shell as LayoutView, fixture as LayoutView);
    const children: unknown[] = [];
    const window = Object.assign(new EventEmitter(), {
      contentView: {
        addChildView: (view: unknown) => { children.push(view); },
        removeChildView: (view: unknown) => { children.splice(children.indexOf(view), 1); },
      },
    }) as unknown as BrowserWindow;
    const registry = new TrustDomainRegistry();
    const browser = new TaskBrowser({
      window, workspaceId: "ws-a", taskId: "task-a", registry,
      bounds: { x: 380, y: 0, width: 1060, height: 900 },
      onActiveTabChange: (changed) => layout.browserChanged(changed),
    });
    layout.addBrowser(browser);
    expect(shell.bounds.width).toBe(1440);
    const tab = await browser.openTab("http://localhost/page");
    expect(shell.bounds.width).toBe(380);
    expect(tab.view.getVisible()).toBe(true);
    expect(registry.requireTaskBinding(tab.webContentsId, { taskId: "task-a", pageId: tab.pageId }).domain).toBe("task");
    expect(browser.partition).toMatch(/^persist:/);
    await expect(browser.openTab("http://localhost/fail")).rejects.toThrow("navigation failed");
    expect(browser.activeTab?.pageId).toBe(tab.pageId);
    expect(tab.view.getVisible()).toBe(true);
    size = { width: 720, height: 560 };
    layout.resize();
    expect(tab.view.getBounds()).toEqual({ x: 280, y: 0, width: 440, height: 560 });
    browser.closeTab(tab.pageId);
    expect(shell.bounds.width).toBe(720);
    expect(fixture.visible).toBe(false);
    expect(registry.get(tab.webContentsId)).toBeUndefined();
    const restored = await browser.openTab("http://localhost/page");
    expect(restored.view.getVisible()).toBe(true);
    expect(shell.bounds.width).toBe(280);
    const later = await browser.openTab("http://localhost/next");
    browser.activateTab(restored.pageId);
    expect(restored.view.getVisible()).toBe(true);
    expect(later.view.getVisible()).toBe(false);
    expect(registry.requireTaskBinding(restored.webContentsId, { taskId: "task-a", pageId: restored.pageId }).domain).toBe("task");
  });

  it("promotes another tab on close and returns to no active page after the last close", async () => {
    const { browser, changes } = setup();
    const a = await browser.openTab("http://localhost/a");
    const b = await browser.openTab("http://localhost/b");
    expect(browser.closeTab(b.pageId)).toBe(true);
    expect(browser.activeTab?.pageId).toBe(a.pageId);
    expect(browser.closeTab(a.pageId)).toBe(true);
    expect(changes).toEqual([a.pageId, b.pageId, a.pageId, undefined]);
    expect(browser.activeTab).toBeUndefined();
  });
});
