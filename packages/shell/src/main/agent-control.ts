import type { ElementDetails, Locator } from "./task-automation.js";
import { elementDetails, TaskAutomation } from "./task-automation.js";
import type { TaskTab } from "./task-browser.js";
import {
  addMarker,
  beginNavigation,
  beginTakeover,
  canAutomate,
  createAgentSessionState,
  endTakeover,
  pageEpoch,
  resolveMarker,
  staleMarkers,
  type AgentSessionState,
  type PageMarker,
} from "./agent-session.js";

export interface PageIdentity {
  workspaceId: string;
  taskId: string;
  pageId: string;
  webContentsId: number;
  url: string;
}

export interface LayoutEntry {
  readonly name: string;
  readonly locator: Locator;
}

export interface LayoutElement {
  readonly name: string;
  readonly found: boolean;
  readonly details: ElementDetails | null;
}

export interface ViewportSnapshot {
  readonly width: number;
  readonly height: number;
  readonly scrollX: number;
  readonly scrollY: number;
}

export interface LayoutSnapshot {
  readonly identity: PageIdentity;
  readonly epoch: number;
  readonly viewport: ViewportSnapshot;
  readonly elements: readonly LayoutElement[];
}

export interface SelectionResult {
  readonly identity: PageIdentity;
  readonly mode: "point" | "box";
  readonly elements: readonly ElementDetails[];
}

export interface RevalidationResult {
  readonly resolved: readonly {
    id: string;
    label: string;
    element: ElementDetails;
  }[];
  readonly stale: readonly { id: string; label: string }[];
}

export interface ResumeSnapshot {
  readonly identity: PageIdentity;
  readonly epoch: number;
  readonly layout: LayoutSnapshot;
  readonly staleMarkerIds: readonly string[];
}

const INSPECT_FUNCTION = String.raw`
function (request) {
  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }
  function explicitRole(element) {
    var explicit = element.getAttribute("role");
    if (explicit) return explicit;
    var tag = element.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      var type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "button" || type === "submit" || type === "reset") return "button";
      return "textbox";
    }
    return "";
  }
  function accessibleName(element) {
    var aria = element.getAttribute("aria-label");
    if (aria) return normalize(aria);
    if (element.labels && element.labels.length) {
      var labels = Array.prototype.map.call(element.labels, function (label) {
        return label.textContent || "";
      });
      if (labels.join(" ").trim()) return normalize(labels.join(" "));
    }
    var placeholder = element.getAttribute("placeholder");
    if (placeholder) return normalize(placeholder);
    return normalize(element.textContent || element.getAttribute("title") || "");
  }
  function visible(element) {
    var rect = element.getBoundingClientRect();
    var style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }
  function interactable(element) {
    if (!element.isConnected) return false;
    var style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") return false;
    if (Number(style.opacity) === 0) return false;
    if (element.getAttribute("aria-disabled") === "true") return false;
    return true;
  }
  function describe(element) {
    var rect = element.getBoundingClientRect();
    var center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    var hitElement = document.elementFromPoint(center.x, center.y);
    var tag = element.tagName.toLowerCase();
    return {
      found: true,
      tag: tag,
      text: String(element.textContent || "").trim(),
      role: explicitRole(element),
      name: accessibleName(element),
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      visible: visible(element),
      inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
      interactable: interactable(element),
      hit: Boolean(hitElement && (hitElement === element || element.contains(hitElement))),
      editable: element.isContentEditable || tag === "input" || tag === "textarea" || tag === "select",
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      center: center
    };
  }
  var elements = [];
  if (request.mode === "point") {
    var pointElement = document.elementFromPoint(request.x, request.y);
    if (pointElement) elements.push(describe(pointElement));
  } else if (request.mode === "box") {
    var box = request.rect;
    var right = box.x + box.width;
    var bottom = box.y + box.height;
    var nodes = Array.prototype.slice.call(document.querySelectorAll("*"));
    var matched = nodes.filter(function (node) {
      var rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      return rect.left < right && rect.right > box.x && rect.top < bottom && rect.bottom > box.y;
    }).sort(function (left, rightNode) {
      var leftRect = left.getBoundingClientRect();
      var rightRect = rightNode.getBoundingClientRect();
      return leftRect.width * leftRect.height - rightRect.width * rightRect.height;
    });
    elements = matched.slice(0, request.limit).map(describe);
  }
  return { elements: elements };
}
`;

const VIEWPORT_EXPRESSION =
  "({ width: innerWidth, height: innerHeight, scrollX: window.scrollX, scrollY: window.scrollY })";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Orchestrates one visible task page on behalf of the Agent: navigation,
 * layout reads, point/box selection, semantic markers with post-refresh
 * invalidation, and human-takeover gating. It never creates a second page;
 * every call goes through the same visible {@link TaskTab} and its
 * {@link TaskAutomation} debugger session.
 */
export class AgentPageController {
  private readonly tab: TaskTab;
  private readonly automation: TaskAutomation;
  private readonly workspaceId: string;
  private state: AgentSessionState;
  private disposed = false;

  constructor(tab: TaskTab, automation: TaskAutomation, workspaceId: string) {
    this.tab = tab;
    this.automation = automation;
    this.workspaceId = workspaceId;
    this.state = createAgentSessionState();
  }

  get session(): AgentSessionState {
    return this.state;
  }

  get identity(): PageIdentity {
    return {
      workspaceId: this.workspaceId,
      taskId: this.tab.taskId,
      pageId: this.tab.pageId,
      webContentsId: this.tab.webContentsId,
      url: this.tab.view.webContents.getURL(),
    };
  }

  get paused(): boolean {
    return !canAutomate(this.state);
  }

  async navigate(url: string): Promise<PageIdentity> {
    this.requireAutomation("navigate");
    this.beginNavigation();
    await this.tab.view.webContents.loadURL(url);
    return this.identity;
  }

  async reload(): Promise<void> {
    this.requireAutomation("reload");
    this.beginNavigation();
    const webContents = this.tab.view.webContents;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        webContents.off("did-finish-load", onFinish);
        reject(new Error("reload timed out"));
      }, 8000);
      const onFinish = (): void => {
        clearTimeout(timer);
        resolve();
      };
      webContents.once("did-finish-load", onFinish);
      webContents.reload();
    });
  }

  async goBack(): Promise<boolean> {
    this.requireAutomation("goBack");
    const history = this.tab.view.webContents.navigationHistory;
    if (!history.canGoBack()) return false;
    this.beginNavigation();
    history.goBack();
    await this.settle();
    return true;
  }

  async goForward(): Promise<boolean> {
    this.requireAutomation("goForward");
    const history = this.tab.view.webContents.navigationHistory;
    if (!history.canGoForward()) return false;
    this.beginNavigation();
    history.goForward();
    await this.settle();
    return true;
  }

  async readLayout(entries: readonly LayoutEntry[]): Promise<LayoutSnapshot> {
    this.requireAutomation("readLayout");
    const viewport = await this.readViewport();
    const elements: LayoutElement[] = [];
    for (const entry of entries) {
      const details = await this.automation.locate(entry.locator);
      elements.push({ name: entry.name, found: details !== null, details });
    }
    return {
      identity: this.identity,
      epoch: pageEpoch(this.state, this.tab.pageId),
      viewport,
      elements,
    };
  }

  async pointSelect(x: number, y: number): Promise<SelectionResult> {
    this.requireAutomation("pointSelect");
    const elements = await this.inspect({ mode: "point", x, y });
    return { identity: this.identity, mode: "point", elements };
  }

  async boxSelect(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<SelectionResult> {
    this.requireAutomation("boxSelect");
    const elements = await this.inspect({ mode: "box", rect, limit: 8 });
    return { identity: this.identity, mode: "box", elements };
  }

  async mark(label: string, locator: Locator): Promise<PageMarker> {
    this.requireAutomation("mark");
    const element = await this.automation.locate(locator);
    const result = addMarker(this.state, {
      pageId: this.tab.pageId,
      label,
      locator,
      element,
    });
    this.state = result.state;
    return result.marker;
  }

  async revalidateMarkers(): Promise<RevalidationResult> {
    this.requireAutomation("revalidateMarkers");
    const resolved: { id: string; label: string; element: ElementDetails }[] = [];
    const stale: { id: string; label: string }[] = [];
    for (const marker of staleMarkers(this.state, this.tab.pageId)) {
      const element = await this.automation.locate(marker.locator);
      this.state = resolveMarker(this.state, marker.id, element);
      if (element) resolved.push({ id: marker.id, label: marker.label, element });
      else stale.push({ id: marker.id, label: marker.label });
    }
    return { resolved, stale };
  }

  pause(reason: string): void {
    this.state = beginTakeover(this.state, reason);
  }

  async resume(entries: readonly LayoutEntry[]): Promise<ResumeSnapshot> {
    this.state = endTakeover(this.state);
    return {
      identity: this.identity,
      epoch: pageEpoch(this.state, this.tab.pageId),
      layout: await this.readLayout(entries),
      staleMarkerIds: staleMarkers(this.state, this.tab.pageId).map(
        (marker) => marker.id,
      ),
    };
  }

  dispose(): void {
    this.disposed = true;
  }

  private beginNavigation(): void {
    this.state = beginNavigation(this.state, this.tab.pageId).state;
  }

  private async readViewport(): Promise<ViewportSnapshot> {
    const value = await this.automation.run(VIEWPORT_EXPRESSION);
    const record = isRecord(value) ? value : {};
    return {
      width: asNumber(record["width"], 0),
      height: asNumber(record["height"], 0),
      scrollX: asNumber(record["scrollX"], 0),
      scrollY: asNumber(record["scrollY"], 0),
    };
  }

  private async inspect(request: unknown): Promise<ElementDetails[]> {
    const value = await this.automation.run(
      `(${INSPECT_FUNCTION})(${JSON.stringify(request)})`,
    );
    if (!isRecord(value) || !Array.isArray(value["elements"])) return [];
    return value["elements"]
      .map((item) => elementDetails(item, 240))
      .filter((item): item is ElementDetails => item !== null);
  }

  private async settle(): Promise<void> {
    const webContents = this.tab.view.webContents;
    await sleep(250);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && webContents.isLoading()) {
      await sleep(50);
    }
  }

  private requireAutomation(action: string): void {
    if (this.disposed) throw new Error("AgentPageController is disposed");
    if (!canAutomate(this.state)) {
      throw new Error(`automation paused for human takeover during ${action}`);
    }
  }
}
