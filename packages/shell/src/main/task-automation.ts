import { createHash } from "node:crypto";
import type { WebContents } from "electron";
import { appendBounded, truncateText } from "./bounded-buffer.js";
import type { TaskTab } from "./task-browser.js";

export type Locator =
  | { kind: "testId"; value: string }
  | { kind: "role"; role: string; name?: string }
  | { kind: "label"; value: string }
  | { kind: "text"; value: string }
  | { kind: "css"; value: string };

export interface ElementDetails {
  tag: string;
  text: string;
  role: string;
  name: string;
  disabled: boolean;
  visible: boolean;
  inViewport: boolean;
  interactable: boolean;
  hit: boolean;
  editable: boolean;
  rect: { x: number; y: number; width: number; height: number };
  center: { x: number; y: number };
}

export interface ConsoleErrorEvidence {
  kind: "console" | "exception";
  text: string;
  url?: string;
  line?: number;
}

export interface FailedRequestEvidence {
  requestId: string;
  url: string;
  errorText: string;
  resourceType: string;
  canceled: boolean;
}

export interface AutomationEvidence {
  consoleErrors: ConsoleErrorEvidence[];
  failedRequests: FailedRequestEvidence[];
}

export interface ScreenshotEvidence {
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  buffer: Buffer;
}

interface TaskAutomationOptions {
  maxEvents?: number;
  maxTextLength?: number;
}

interface RuntimeEvaluateResponse {
  result?: { value?: unknown };
  exceptionDetails?: unknown;
}

const DEFAULT_MAX_EVENTS = 20;
const DEFAULT_MAX_TEXT_LENGTH = 240;

const LOCATOR_FUNCTION = String.raw`
function (locator) {
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
    var labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      var names = labelledBy.split(/\s+/).map(function (id) {
        var label = document.getElementById(id);
        return label ? label.textContent : "";
      });
      if (names.join(" ").trim()) return normalize(names.join(" "));
    }
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
    for (var current = element; current; current = current.parentElement) {
      if (current.inert) return false;
    }
    return true;
  }
  var elements = Array.prototype.slice.call(document.querySelectorAll("*"));
  var element = null;
  if (locator.kind === "testId") {
    element = elements.find(function (candidate) { return candidate.getAttribute("data-testid") === locator.value; }) || null;
  } else if (locator.kind === "css") {
    element = document.querySelector(locator.value);
  } else if (locator.kind === "role") {
    element = elements.find(function (candidate) {
      if (explicitRole(candidate) !== locator.role) return false;
      return !locator.name || accessibleName(candidate).includes(normalize(locator.name));
    }) || null;
  } else if (locator.kind === "label") {
    element = elements.find(function (candidate) {
      if (candidate.labels && Array.prototype.some.call(candidate.labels, function (label) {
        return normalize(label.textContent).includes(normalize(locator.value));
      })) return true;
      return normalize(candidate.getAttribute("aria-label") || "").includes(normalize(locator.value));
    }) || null;
  } else if (locator.kind === "text") {
    var textMatches = elements.filter(function (candidate) {
      var tag = candidate.tagName.toLowerCase();
      if (tag === "html" || tag === "body" || tag === "script" || tag === "style") return false;
      return normalize(candidate.textContent).includes(normalize(locator.value));
    }).sort(function (left, right) {
      return String(left.textContent || "").length - String(right.textContent || "").length;
    });
    element = textMatches[0] || null;
  }
  if (!element) return { found: false };
  var initialRect = element.getBoundingClientRect();
  if (initialRect.bottom < 0 || initialRect.right < 0 || initialRect.top > innerHeight || initialRect.left > innerWidth) {
    element.scrollIntoView({ block: "center", inline: "center" });
  }
  var rect = element.getBoundingClientRect();
  var center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  var hitElement = document.elementFromPoint(center.x, center.y);
  var inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  var tag = element.tagName.toLowerCase();
  return {
    found: true,
    tag: tag,
    text: String(element.textContent || "").trim(),
    role: explicitRole(element),
    name: accessibleName(element),
    disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
    visible: visible(element),
    inViewport: inViewport,
    interactable: interactable(element),
    hit: Boolean(hitElement && (hitElement === element || element.contains(hitElement))),
    editable: element.isContentEditable || tag === "input" || tag === "textarea" || tag === "select",
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    center: center
  };
}
`;

function locatorExpression(locator: Locator): string {
  return `(${LOCATOR_FUNCTION})(${JSON.stringify(locator)})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function elementDetails(
  value: unknown,
  maxTextLength: number,
): ElementDetails | null {
  if (!isRecord(value) || value["found"] !== true) return null;
  const rect = isRecord(value["rect"]) ? value["rect"] : {};
  const center = isRecord(value["center"]) ? value["center"] : {};
  return {
    tag: asString(value["tag"]) ?? "",
    text: truncateText(asString(value["text"]) ?? "", maxTextLength),
    role: asString(value["role"]) ?? "",
    name: truncateText(asString(value["name"]) ?? "", maxTextLength),
    disabled: value["disabled"] === true,
    visible: value["visible"] === true,
    inViewport: value["inViewport"] === true,
    interactable: value["interactable"] === true,
    hit: value["hit"] === true,
    editable: value["editable"] === true,
    rect: {
      x: asNumber(rect["x"]) ?? 0,
      y: asNumber(rect["y"]) ?? 0,
      width: asNumber(rect["width"]) ?? 0,
      height: asNumber(rect["height"]) ?? 0,
    },
    center: {
      x: asNumber(center["x"]) ?? 0,
      y: asNumber(center["y"]) ?? 0,
    },
  };
}

/**
 * CDP automation bound to the actual visible WebContentsView. Screenshots,
 * input, console and network evidence all use the same WebContents instance
 * that the user sees; no hidden BrowserWindow fallback exists here.
 */
export class TaskAutomation {
  readonly webContentsId: number;

  private readonly webContents: WebContents;
  private readonly debuggerApi: WebContents["debugger"];
  private readonly maxEvents: number;
  private readonly maxTextLength: number;
  private readonly consoleErrors: ConsoleErrorEvidence[] = [];
  private readonly failedRequests: FailedRequestEvidence[] = [];
  private readonly requestUrls = new Map<string, string>();
  private detachOnDispose: boolean;
  private listenersBound = false;
  private readonly detachReasons: string[] = [];
  private disposed = false;

  private constructor(
    tab: TaskTab,
    options: TaskAutomationOptions,
    detachOnDispose: boolean,
  ) {
    this.webContents = tab.view.webContents;
    this.debuggerApi = this.webContents.debugger;
    this.webContentsId = this.webContents.id;
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
    this.detachOnDispose = detachOnDispose;
  }

  static async attach(
    tab: TaskTab,
    options: TaskAutomationOptions = {},
  ): Promise<TaskAutomation> {
    const debuggerApi = tab.view.webContents.debugger;
    const detachOnDispose = !debuggerApi.isAttached();
    if (detachOnDispose) debuggerApi.attach("1.3");
    const automation = new TaskAutomation(tab, options, detachOnDispose);
    try {
      await automation.enableDomains();
      return automation;
    } catch (error) {
      automation.dispose();
      throw error;
    }
  }

  async run(expression: string): Promise<unknown> {
    return this.evaluate(expression);
  }

  isDebuggerAttached(): boolean {
    return this.debuggerApi.isAttached();
  }

  /**
   * Reason strings recorded when the CDP session detached, e.g. when the
   * target WebContents closes or another client takes over the debugger.
   * Bounded like every other evidence stream.
   */
  get detachEvents(): readonly string[] {
    return [...this.detachReasons];
  }

  /**
   * Re-binds the control handle after an external detach (DevTools, target
   * swap). Re-enables the domains on the same WebContents so the Agent can
   * keep using the handle it already holds.
   */
  async reattach(): Promise<void> {
    if (this.disposed) throw new Error("TaskAutomation is disposed");
    if (this.webContents.isDestroyed()) {
      throw new Error(`WebContents ${this.webContentsId} is destroyed`);
    }
    if (!this.debuggerApi.isAttached()) {
      this.debuggerApi.attach("1.3");
      this.detachOnDispose = true;
    }
    await this.enableDomains();
  }

  async locate(locator: Locator): Promise<ElementDetails | null> {
    this.assertActive();
    return elementDetails(
      await this.evaluate(locatorExpression(locator)),
      this.maxTextLength,
    );
  }

  async waitForActionable(
    locator: Locator,
    timeoutMs = 6000,
  ): Promise<ElementDetails> {
    const deadline = Date.now() + timeoutMs;
    let previousKey = "";
    while (Date.now() < deadline) {
      const details = await this.locate(locator);
      if (
        details?.visible &&
        details.interactable &&
        details.inViewport &&
        details.hit &&
        !details.disabled
      ) {
        const key = JSON.stringify(details.rect);
        if (key === previousKey) return details;
        previousKey = key;
      } else {
        previousKey = "";
      }
      await sleep(50);
    }
    throw new Error(`actionability timeout for ${JSON.stringify(locator)}`);
  }

  async click(locator: Locator): Promise<ElementDetails> {
    const details = await this.waitForActionable(locator);
    await this.debuggerApi.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: details.center.x,
      y: details.center.y,
    });
    await this.debuggerApi.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: details.center.x,
      y: details.center.y,
      button: "left",
      clickCount: 1,
    });
    await this.debuggerApi.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: details.center.x,
      y: details.center.y,
      button: "left",
      clickCount: 1,
    });
    return details;
  }

  async fill(locator: Locator, value: string): Promise<ElementDetails> {
    const details = await this.click(locator);
    if (!details.editable) {
      throw new Error(`fill target is not editable: ${JSON.stringify(locator)}`);
    }
    const modifier = process.platform === "darwin" ? 4 : 2;
    await this.debuggerApi.sendCommand("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: modifier,
    });
    await this.debuggerApi.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: modifier,
    });
    await this.debuggerApi.sendCommand("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    });
    await this.debuggerApi.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    });
    await this.debuggerApi.sendCommand("Input.insertText", { text: value });
    return details;
  }

  async waitForExpression(
    expression: string,
    label: string,
    timeoutMs = 6000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.evaluate(`Boolean(${expression})`)) === true) return;
      await sleep(50);
    }
    throw new Error(`${label} timed out`);
  }

  async screenshot(): Promise<ScreenshotEvidence> {
    const response = (await this.debuggerApi.sendCommand(
      "Page.captureScreenshot",
      { format: "png", fromSurface: true, captureBeyondViewport: false },
    )) as Record<string, unknown>;
    const data = asString(response["data"]);
    if (!data) throw new Error("Page.captureScreenshot returned no data");
    const buffer = Buffer.from(data, "base64");
    if (buffer.length < 24 || buffer.subarray(1, 4).toString("ascii") !== "PNG") {
      throw new Error("Page.captureScreenshot did not return a PNG");
    }
    return {
      bytes: buffer.length,
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
      sha256: createHash("sha256").update(buffer).digest("hex"),
      buffer,
    };
  }

  evidence(): AutomationEvidence {
    return {
      consoleErrors: [...this.consoleErrors],
      failedRequests: [...this.failedRequests],
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.debuggerApi.removeListener("message", this.onDebuggerMessage);
    this.debuggerApi.removeListener("detach", this.onDebuggerDetach);
    this.listenersBound = false;
    if (this.detachOnDispose && this.debuggerApi.isAttached()) {
      this.debuggerApi.detach();
    }
  }

  private async enableDomains(): Promise<void> {
    if (!this.listenersBound) {
      this.debuggerApi.on("message", this.onDebuggerMessage);
      this.debuggerApi.on("detach", this.onDebuggerDetach);
      this.listenersBound = true;
    }
    await this.debuggerApi.sendCommand("Runtime.enable");
    await this.debuggerApi.sendCommand("Page.enable");
    await this.debuggerApi.sendCommand("Network.enable");
    await this.debuggerApi.sendCommand("Log.enable");
  }

  private readonly onDebuggerDetach = (
    _event: unknown,
    reason: string,
  ): void => {
    appendBounded(
      this.detachReasons,
      truncateText(String(reason), this.maxTextLength),
      this.maxEvents,
    );
  };

  private readonly onDebuggerMessage = (
    _event: unknown,
    method: string,
    params: unknown,
  ): void => {
    if (method === "Runtime.consoleAPICalled") {
      this.recordConsole(params);
      return;
    }
    if (method === "Runtime.exceptionThrown") {
      this.recordException(params);
      return;
    }
    if (method === "Network.requestWillBeSent") {
      this.recordRequest(params);
      return;
    }
    if (method === "Network.loadingFinished") {
      this.finishRequest(params);
      return;
    }
    if (method === "Network.responseReceived") {
      this.recordHttpError(params);
      return;
    }
    if (method === "Network.loadingFailed") {
      this.recordFailedRequest(params);
      return;
    }
    if (method === "Log.entryAdded") {
      this.recordLogEntry(params);
    }
  };

  private recordConsole(params: unknown): void {
    if (!isRecord(params) || params["type"] !== "error") return;
    const args = Array.isArray(params["args"]) ? params["args"] : [];
    const text = args
      .map((arg) => {
        if (!isRecord(arg)) return String(arg);
        return asString(arg["value"]) ?? asString(arg["description"]) ?? "";
      })
      .filter(Boolean)
      .join(" ");
    appendBounded(
      this.consoleErrors,
      {
        kind: "console",
        text: truncateText(text || "console.error", this.maxTextLength),
      },
      this.maxEvents,
    );
  }

  private recordException(params: unknown): void {
    if (!isRecord(params)) return;
    const details = isRecord(params["exceptionDetails"])
      ? params["exceptionDetails"]
      : {};
    const exception = isRecord(details["exception"]) ? details["exception"] : {};
    const text =
      asString(details["text"]) ??
      asString(exception["description"]) ??
      "uncaught exception";
    appendBounded(
      this.consoleErrors,
      {
        kind: "exception",
        text: truncateText(text, this.maxTextLength),
        url: truncateText(asString(details["url"]) ?? "", this.maxTextLength),
        line: asNumber(details["lineNumber"]),
      },
      this.maxEvents,
    );
  }

  private recordRequest(params: unknown): void {
    if (!isRecord(params)) return;
    const requestId = asString(params["requestId"]);
    const request = isRecord(params["request"]) ? params["request"] : {};
    const url = asString(request["url"]);
    if (!requestId || !url) return;
    this.requestUrls.set(requestId, url);
  }

  private finishRequest(params: unknown): void {
    if (!isRecord(params)) return;
    const requestId = asString(params["requestId"]);
    if (requestId) this.requestUrls.delete(requestId);
  }

  private recordFailedRequest(params: unknown): void {
    if (!isRecord(params)) return;
    const rawRequestId = asString(params["requestId"]) ?? "unknown";
    appendBounded(
      this.failedRequests,
      {
        requestId: truncateText(rawRequestId, this.maxTextLength),
        url: truncateText(
          this.requestUrls.get(rawRequestId) ?? "unknown",
          this.maxTextLength,
        ),
        errorText: truncateText(
          asString(params["errorText"]) ?? "unknown",
          this.maxTextLength,
        ),
        resourceType: asString(params["type"]) ?? "unknown",
        canceled: params["canceled"] === true,
      },
      this.maxEvents,
    );
    this.requestUrls.delete(rawRequestId);
  }

  private recordHttpError(params: unknown): void {
    if (!isRecord(params)) return;
    const response = isRecord(params["response"]) ? params["response"] : {};
    const status = asNumber(response["status"]) ?? 0;
    if (status < 400) return;
    const requestId = asString(params["requestId"]);
    const url =
      asString(response["url"]) ??
      (requestId ? this.requestUrls.get(requestId) : undefined);
    appendBounded(
      this.failedRequests,
      {
        requestId: truncateText(requestId ?? "unknown", this.maxTextLength),
        url: truncateText(url ?? "unknown", this.maxTextLength),
        errorText: `HTTP ${status}`,
        resourceType: asString(params["type"]) ?? "unknown",
        canceled: false,
      },
      this.maxEvents,
    );
  }

  private recordLogEntry(params: unknown): void {
    if (!isRecord(params)) return;
    const entry = isRecord(params["entry"]) ? params["entry"] : {};
    if (entry["level"] !== "error") return;
    appendBounded(
      this.consoleErrors,
      {
        kind: "console",
        text: truncateText(
          asString(entry["text"]) ?? "browser log error",
          this.maxTextLength,
        ),
        url: truncateText(
          asString(entry["url"]) ?? "",
          this.maxTextLength,
        ),
        line: asNumber(entry["lineNumber"]),
      },
      this.maxEvents,
    );
  }

  private async evaluate(expression: string): Promise<unknown> {
    this.assertActive();
    const response = (await this.debuggerApi.sendCommand(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      },
    )) as RuntimeEvaluateResponse;
    if (response.exceptionDetails) {
      throw new Error(
        `Runtime.evaluate failed: ${truncateText(
          JSON.stringify(response.exceptionDetails),
          this.maxTextLength,
        )}`,
      );
    }
    return response.result?.value;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("TaskAutomation is disposed");
    if (this.webContents.isDestroyed()) {
      throw new Error(`WebContents ${this.webContentsId} is destroyed`);
    }
  }
}
