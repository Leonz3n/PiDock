/**
 * Real `BrowserSurface` adapter for [PiDock 06] (#8).
 *
 * Wires the gateway's validated actions to the visible task page using the
 * classes verified in [PiDock 21] (#4): `TaskBrowser` (WebContentsView
 * tabs/popups on the task partition), `TaskAutomation` (CDP on the same
 * WebContents) and `AgentPageController` (layout, markers, takeover,
 * navigation epochs). The renderer never reaches any of this: it speaks
 * `task/browserAction` and gets bounded results back.
 *
 * One surface per task, one automation + controller per open page. Closing
 * a page disposes its debugger connection but keeps the partition, so
 * reopening the task restores its login state; `page/restore` reopens the
 * last closed address from the same partition.
 */

import type { Locator } from "./task-automation.js";
import { TaskAutomation } from "./task-automation.js";
import { AgentPageController, type LayoutEntry } from "./agent-control.js";
import type { TaskBrowser, TaskTab } from "./task-browser.js";
import type { BrowserPerformResult } from "../rpc/protocol.js";
import type {
  BrowserLivePage,
  BrowserScreenshot,
  BrowserSurface,
  BrowserSurfaceRequest,
  BrowserSurfaceState,
} from "./browser-gateway.js";

interface PageBinding {
  tab: TaskTab;
  automation: TaskAutomation;
  controller: AgentPageController;
}

export class TaskBrowserSurface implements BrowserSurface {
  private readonly bindings = new Map<string, PageBinding>();
  private readonly closedUrls: string[] = [];

  constructor(
    readonly taskId: string,
    private readonly browser: TaskBrowser,
  ) {
    if (browser.taskId !== taskId) {
      throw new Error(`surface task ${taskId} does not match its browser ${browser.taskId}`);
    }
  }

  pages(): BrowserLivePage[] {
    return this.browser.tabs.map((tab) => ({
      pageId: tab.pageId,
      webContentsId: tab.webContentsId,
      url: tab.view.webContents.getURL(),
    }));
  }

  takeoverState(pageId?: string): { paused: boolean; reason?: string } {
    const binding = pageId !== undefined ? this.bindings.get(pageId) : this.activeBinding();
    if (!binding) return { paused: false };
    const takeover = binding.controller.session.takeover;
    return takeover.reason !== undefined ? { paused: takeover.paused, reason: takeover.reason } : { paused: takeover.paused };
  }

  rawEvidence(): ReturnType<TaskAutomation["evidence"]> {
    const binding = this.activeBinding();
    if (!binding) return { consoleErrors: [], failedRequests: [] };
    return binding.automation.evidence();
  }

  async state(page: { pageId: string; webContentsId: number }): Promise<BrowserSurfaceState> {
    const binding = this.bindingFor(page.pageId);
    const layout = await binding.controller.readLayout([]);
    return {
      epoch: layout.epoch,
      viewport: layout.viewport,
      title: binding.tab.view.webContents.getTitle(),
      url: binding.tab.view.webContents.getURL(),
    };
  }

  async screenshot(page: { pageId: string; webContentsId: number }): Promise<BrowserScreenshot> {
    const binding = this.bindingFor(page.pageId);
    const shot = await binding.automation.screenshot();
    return {
      bytes: shot.bytes,
      width: shot.width,
      height: shot.height,
      sha256: shot.sha256,
      data: shot.buffer.toString("base64"),
    };
  }

  async perform(request: BrowserSurfaceRequest): Promise<BrowserPerformResult> {
    try {
      switch (request.action) {
        case "page/open": {
          const url = String(request.params["url"] ?? "");
          const tab = await this.browser.openTab(url);
          return { ok: true, payload: { pageId: tab.pageId, webContentsId: tab.webContentsId, url } };
        }
        case "page/navigate": {
          const binding = this.bindingFor(request.page?.pageId);
          const identity = await binding.controller.navigate(String(request.params["url"] ?? ""));
          return { ok: true, payload: { identity } };
        }
        case "page/reload": {
          const binding = this.bindingFor(request.page?.pageId);
          await binding.controller.reload();
          return { ok: true, payload: { reloaded: true } };
        }
        case "page/close": {
          const pageId = request.page?.pageId ?? "";
          const binding = this.bindings.get(pageId);
          if (binding) {
            const url = binding.tab.view.webContents.getURL();
            if (url.length > 0) this.closedUrls.push(url);
            binding.automation.dispose();
            binding.controller.dispose();
            this.bindings.delete(pageId);
          }
          return { ok: true, payload: { closed: this.browser.closeTab(pageId), pageId } };
        }
        case "page/restore": {
          const url = this.closedUrls.pop();
          if (url === undefined) return { ok: false, error: "page-restore: 没有可恢复的已关闭页面" };
          const tab = await this.browser.openTab(url);
          return { ok: true, payload: { pageId: tab.pageId, webContentsId: tab.webContentsId, url } };
        }
        case "input/click": {
          const binding = await this.ensureBinding(request.page?.pageId);
          const details = await binding.automation.click(request.params["locator"] as Locator);
          return { ok: true, payload: { element: details } };
        }
        case "input/fill": {
          const binding = await this.ensureBinding(request.page?.pageId);
          const details = await binding.automation.fill(request.params["locator"] as Locator, String(request.params["value"] ?? ""));
          return { ok: true, payload: { element: details } };
        }
        case "input/key": {
          const binding = await this.ensureBinding(request.page?.pageId);
          await binding.automation.pressKey(String(request.params["key"] ?? ""));
          return { ok: true, payload: { key: String(request.params["key"] ?? "") } };
        }
        case "wait": {
          const binding = await this.ensureBinding(request.page?.pageId);
          const timeoutMs = typeof request.params["timeoutMs"] === "number" ? (request.params["timeoutMs"] as number) : undefined;
          if (request.params["expression"] !== undefined) {
            await binding.automation.waitForExpression(String(request.params["expression"]), String(request.params["label"] ?? "wait"), timeoutMs);
          } else {
            await binding.automation.waitForActionable(request.params["locator"] as Locator, timeoutMs);
          }
          return { ok: true, payload: { settled: true } };
        }
        case "marker/relocate": {
          const binding = await this.ensureBinding(request.page?.pageId);
          const revalidated = await binding.controller.revalidateMarkers();
          return { ok: true, payload: { revalidated } };
        }
        case "marker/create": {
          const binding = await this.ensureBinding(request.page?.pageId);
          const label = String(request.params["label"] ?? "");
          const locator = request.params["locator"] as Locator | undefined;
          const marker = request.params["marker"] as { annotation?: unknown } | undefined;
          // Element/semantic locator info is attached only when the user's
          // pick actually produced one (spec: 「能取得元素定位与语义信息时
          // 一并携带」). Without it the marker is stale by construction and
          // the Agent must locate the described area itself.
          if (locator === undefined) {
            return { ok: true, payload: { pageMarker: null } };
          }
          const created = await binding.controller.mark(
            label.length > 0 ? label : typeof marker?.annotation === "string" ? marker.annotation : "标记",
            locator,
          );
          return { ok: true, payload: { pageMarker: { id: created.id, label: created.label, epoch: created.epoch } } };
        }
        case "takeover/pause": {
          const binding = await this.ensureBinding(request.page?.pageId);
          const reason = String(request.params["reason"] ?? "用户接管");
          binding.controller.pause(reason);
          return { ok: true, payload: { takeover: { paused: true, reason } } };
        }
        case "takeover/resume": {
          const binding = await this.ensureBinding(request.page?.pageId);
          const entries = Array.isArray(request.params["entries"]) ? (request.params["entries"] as LayoutEntry[]) : [];
          const snapshot = await binding.controller.resume(entries);
          return { ok: true, payload: { resumed: true, snapshot } };
        }
        default:
          return { ok: false, error: `unsupported-action: ${request.action}` };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private activeBinding(): PageBinding | undefined {
    const active = this.browser.activeTab;
    return active ? this.bindings.get(active.pageId) : undefined;
  }

  private bindingFor(pageId: string | undefined): PageBinding {
    const binding = pageId !== undefined ? this.bindings.get(pageId) : this.activeBinding();
    if (!binding) throw new Error(`page-stale: 页面 ${pageId ?? "(active)"} 尚未绑定自动化连接`);
    return binding;
  }

  /** Attach the CDP automation + controller for a page on first use. */
  private async ensureBinding(pageId: string | undefined): Promise<PageBinding> {
    if (pageId === undefined) return this.bindingFor(undefined);
    const existing = this.bindings.get(pageId);
    if (existing) return existing;
    const tab = this.browser.tabs.find((candidate) => candidate.pageId === pageId);
    if (!tab) throw new Error(`page-stale: 页面 ${pageId} 不存在或已关闭`);
    const automation = await TaskAutomation.attach(tab);
    const binding: PageBinding = {
      tab,
      automation,
      controller: new AgentPageController(tab, automation, this.browser.workspaceId),
    };
    this.bindings.set(pageId, binding);
    return binding;
  }
}
