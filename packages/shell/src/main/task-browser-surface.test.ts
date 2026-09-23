import { describe, expect, it } from "vitest";
import { TaskBrowserSurface } from "./task-browser-surface.js";
import type { TaskBrowser, TaskTab } from "./task-browser.js";
import type { BrowserPerformResult } from "../rpc/protocol.js";

// Seam: [PiDock 06] (#8) `TaskBrowserSurface`, the real `BrowserSurface`
// adapter. Electron is faked at the WebContents/debugger boundary, so the
// adapter's own wiring (attach-on-first-use, paused-human reads/marking) is
// covered without a GUI; the page classes it drives are verified in #4.

const TASK_ID = "task-a1f92c3d";

interface FakeWebContents {
  readonly id: number;
  readonly debugger: FakeDebugger;
  getURL(): string;
  getTitle(): string;
  loadURL(url: string): Promise<void>;
  isDestroyed(): boolean;
}

interface FakeDebugger {
  readonly attached: { value: boolean };
  readonly messages: ((event: unknown, method: string, params: unknown) => void)[];
  isAttached(): boolean;
  attach(): void;
  detach(): void;
  on(event: string, listener: (...args: never[]) => void): void;
  removeListener(): void;
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

function fakeWebContents(url: string, id: number): FakeWebContents {
  let current = url;
  const debuggerApi: FakeDebugger = {
    attached: { value: false },
    messages: [],
    isAttached() {
      return this.attached.value;
    },
    attach() {
      this.attached.value = true;
    },
    detach() {
      this.attached.value = false;
    },
    on(event: string, listener: (...args: never[]) => void) {
      if (event === "message") this.messages.push(listener as never);
    },
    removeListener() {},
    async sendCommand(method: string, params?: Record<string, unknown>) {
      if (method !== "Runtime.evaluate") return {};
      const expression = String(params?.["expression"] ?? "");
      if (expression.includes("innerWidth")) {
        return { result: { value: { width: 1280, height: 800, scrollX: 0, scrollY: 40 } } };
      }
      return {
        result: {
          value: {
            found: true,
            tag: "button",
            text: "提交",
            role: "button",
            name: "提交",
            disabled: false,
            visible: true,
            inViewport: true,
            interactable: true,
            hit: true,
            editable: false,
            rect: { x: 10, y: 20, width: 80, height: 30 },
            center: { x: 50, y: 35 },
          },
        },
      };
    },
  };
  return {
    id,
    debugger: debuggerApi,
    getURL: () => current,
    getTitle: () => "对账单",
    loadURL: async (next: string) => {
      current = next;
    },
    isDestroyed: () => false,
  };
}

function fakeBrowser(taskId = TASK_ID) {
  const tabs: TaskTab[] = [];
  let nextPage = 1;
  const browser = {
    taskId,
    workspaceId: "ws-a",
    get tabs(): readonly TaskTab[] {
      return tabs;
    },
    get activeTab(): TaskTab | undefined {
      return tabs.at(-1);
    },
    openTab(url: string): TaskTab {
      const webContents = fakeWebContents(url, 100 + nextPage);
      const tab = {
        taskId,
        pageId: `page-${nextPage}`,
        viewId: `view-${nextPage}`,
        webContentsId: webContents.id,
        view: { webContents },
      } as unknown as TaskTab;
      nextPage += 1;
      tabs.push(tab);
      return tab;
    },
    closeTab(pageId: string): boolean {
      const index = tabs.findIndex((tab) => tab.pageId === pageId);
      if (index < 0) return false;
      tabs.splice(index, 1);
      return true;
    },
  };
  return { browser: browser as unknown as TaskBrowser, tabs, raw: browser };
}

function debuggerOf(tab: TaskTab): FakeDebugger {
  const view = tab.view as unknown as { webContents: FakeWebContents };
  return view.webContents.debugger;
}

function payloadOf(result: BrowserPerformResult): Record<string, unknown> {
  if (!result.ok) throw new Error(`expected an ok result, got ${result.error}`);
  return result.payload;
}

const human = { kind: "human", label: "用户显式操作" } as const;
const agent = { kind: "agent", sessionId: "main" } as const;

describe("task browser surface attachment", () => {
  it("attaches on first use so open → state/navigate/evidence work", async () => {
    const { browser } = fakeBrowser();
    const surface = new TaskBrowserSurface(TASK_ID, browser);

    const opened = await surface.perform({ action: "page/open", page: undefined, params: { url: "http://localhost:5173/checkout" }, actor: agent });
    expect(opened.ok).toBe(true);
    const pageId = String(payloadOf(opened)["pageId"]);
    const tab = browser.tabs.find((candidate) => candidate.pageId === pageId);
    expect(tab).toBeDefined();
    const page = { pageId, webContentsId: tab!.webContentsId };

    // A freshly opened page has no debugger session yet; reading it used to
    // throw `page-stale` before the first input action.
    const state = await surface.state(page);
    expect(state).toMatchObject({ epoch: 0, title: "对账单", url: "http://localhost:5173/checkout", viewport: { width: 1280, height: 800, scrollY: 40 } });
    expect(debuggerOf(tab!).isAttached()).toBe(true);

    const navigated = await surface.perform({ action: "page/navigate", page, params: { url: "http://localhost:5173/detail" }, actor: agent });
    expect(navigated.ok).toBe(true);
    expect((payloadOf(navigated)["identity"] as { url: string }).url).toBe("http://localhost:5173/detail");

    // Evidence is a real reading of the attached session, not an empty
    // fallback that would look like "no console errors".
    const before = await surface.rawEvidence(pageId);
    expect(before.consoleErrors).toEqual([]);
    for (const listener of debuggerOf(tab!).messages) {
      listener({}, "Runtime.consoleAPICalled", { type: "error", args: [{ value: "TypeError: x is undefined" }] });
    }
    const after = await surface.rawEvidence(pageId);
    expect(after.consoleErrors.map((entry) => entry.text)).toEqual(["TypeError: x is undefined"]);
  });

  it("still fails closed for a page that is not open", async () => {
    const { browser } = fakeBrowser();
    const surface = new TaskBrowserSurface(TASK_ID, browser);
    await expect(surface.rawEvidence("page-gone")).rejects.toThrow(/page-stale/);
    await expect(surface.state({ pageId: "page-gone", webContentsId: 1 })).rejects.toThrow(/page-stale/);
  });
});

describe("task browser surface takeover", () => {
  async function pausedSurface() {
    const { browser } = fakeBrowser();
    const surface = new TaskBrowserSurface(TASK_ID, browser);
    const opened = await surface.perform({ action: "page/open", page: undefined, params: { url: "http://localhost:5173/checkout" }, actor: agent });
    const pageId = String(payloadOf(opened)["pageId"]);
    const tab = browser.tabs.find((candidate) => candidate.pageId === pageId)!;
    const page = { pageId, webContentsId: tab.webContentsId };
    await surface.state(page);
    const paused = await surface.perform({ action: "takeover/pause", page, params: { reason: "人工登录" }, actor: human });
    expect(paused.ok).toBe(true);
    return { surface, page };
  }

  it("keeps the user's own reads and markers working while they hold the page", async () => {
    const { surface, page } = await pausedSurface();

    const state = await surface.state(page);
    expect(state.url).toBe("http://localhost:5173/checkout");

    const marked = await surface.perform({
      action: "marker/create",
      page,
      params: { label: "总额不一致", locator: { kind: "text", value: "提交" } },
      actor: human,
    });
    expect(marked.ok).toBe(true);
    expect(payloadOf(marked)["pageMarker"]).toMatchObject({ label: "总额不一致" });

    // The user may also keep navigating the page they took over.
    const navigated = await surface.perform({ action: "page/navigate", page, params: { url: "http://localhost:5173/detail" }, actor: human });
    expect(navigated.ok).toBe(true);
  });

  it("still refuses the Agent's own actions on a paused page", async () => {
    const { surface, page } = await pausedSurface();
    const denied = await surface.perform({ action: "page/navigate", page, params: { url: "http://localhost:5173/detail" }, actor: agent });
    expect(denied).toMatchObject({ ok: false, error: expect.stringContaining("automation paused") });
    const marked = await surface.perform({
      action: "marker/create",
      page,
      params: { label: "Agent 标记", locator: { kind: "text", value: "提交" } },
      actor: agent,
    });
    expect(marked).toMatchObject({ ok: false, error: expect.stringContaining("automation paused") });
  });
});
