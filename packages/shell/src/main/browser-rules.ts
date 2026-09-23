/**
 * Pure task-browser rules for [PiDock 06] (#8).
 *
 * These are the rules the Agent browser surface and the human markup path
 * share, kept free of Electron/Node so both the main-process gateway and
 * the utilityProcess Host can import them, and unit tests can drive them
 * without a visible window:
 *
 * - page handles bind to one task and one live page; a foreign-task or
 *   stale handle is rejected instead of resolving to another page
 * - navigation targets come from the task's own run configuration
 *   (local ports / configured addresses); other schemes and hosts are
 *   refused so an external page never becomes a task page
 * - console/network evidence and page text are bounded and scrubbed
 *   before they can reach the renderer, the session or a log
 * - user markers carry task/page/URL/selection/annotation plus the page
 *   epoch, and stay unusable while the page has moved on (the Agent must
 *   re-locate instead of reusing an old coordinate)
 *
 * The approval binding lives here too: each gated browser tool maps to
 * exactly one action and one task-scoped target, so a confirmation can
 * never be replayed on a different action or page (see
 * `host/browser-control.ts` for the spend order).
 */

import { truncateText } from "./bounded-buffer.js";
import type { Locator } from "./task-automation.js";

/** Every action the task browser surface exposes to Agent and user. */
export type BrowserAction =
  | "page/state"
  | "page/open"
  | "page/navigate"
  | "page/reload"
  | "page/close"
  | "page/restore"
  | "input/click"
  | "input/fill"
  | "input/key"
  | "wait"
  | "screenshot"
  | "evidence"
  | "marker/create"
  | "marker/relocate"
  | "takeover/pause"
  | "takeover/resume";

export const BROWSER_ACTIONS: readonly BrowserAction[] = [
  "page/state",
  "page/open",
  "page/navigate",
  "page/reload",
  "page/close",
  "page/restore",
  "input/click",
  "input/fill",
  "input/key",
  "wait",
  "screenshot",
  "evidence",
  "marker/create",
  "marker/relocate",
  "takeover/pause",
  "takeover/resume",
];

export function isBrowserAction(value: unknown): value is BrowserAction {
  return typeof value === "string" && (BROWSER_ACTIONS as readonly string[]).includes(value);
}

/**
 * Gated browser tools, one per action family. The tool name is what the
 * permission gate records on the approval, so a confirmation for
 * `browser.navigate` can never authorize `input/click`.
 */
export const BROWSER_TOOL_ACTIONS: Readonly<Record<string, BrowserAction>> = {
  "browser.state": "page/state",
  "browser.open": "page/open",
  "browser.navigate": "page/navigate",
  "browser.reload": "page/reload",
  "browser.close": "page/close",
  "browser.restore": "page/restore",
  "browser.click": "input/click",
  "browser.fill": "input/fill",
  "browser.key": "input/key",
  "browser.wait": "wait",
  "browser.screenshot": "screenshot",
  "browser.evidence": "evidence",
  "browser.relocate": "marker/relocate",
  /**
   * Legacy composite name ([PiDock 02] turn plans already use it). It
   * stays the click/fill/key tool for callers that do not name the
   * specific one; new callers use the names above.
   */
  "browser.act": "input/click",
};

export function browserToolForAction(action: BrowserAction): string {
  const entry = Object.entries(BROWSER_TOOL_ACTIONS).find(([, value]) => value === action);
  if (!entry) throw new Error(`no gated browser tool for action ${action}`);
  return entry[0];
}

export function browserActionForTool(tool: string): BrowserAction | null {
  return BROWSER_TOOL_ACTIONS[tool] ?? null;
}

/**
 * Page handle crossing the RPC boundary. `taskId` is never caller-chosen:
 * a handle produced inside main (`{pageId, webContentsId}`) is attributed
 * to the task that owns the surface, while a handle that does name a task
 * is rejected when it names another one.
 */
export interface PageRef {
  taskId?: string;
  pageId: string;
  webContentsId?: number;
}

export function isPageRef(value: unknown): value is PageRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const taskId = record["taskId"];
  if (taskId !== undefined && (typeof taskId !== "string" || taskId.length === 0)) return false;
  if (typeof record["pageId"] !== "string" || record["pageId"].length === 0) return false;
  const webContentsId = record["webContentsId"];
  return webContentsId === undefined || (typeof webContentsId === "number" && Number.isInteger(webContentsId));
}

export type PageRefCheck =
  | { ok: true; pageId: string }
  | { ok: false; reason: string };

/**
 * Ownership/ liveness check for a page handle. Fail-closed: an absent or
 * malformed handle, a handle naming another task, an unknown page and a
 * handle whose `webContentsId` no longer matches the live page are all
 * rejected, so no action ever runs against a page it was not bound to.
 * A handle without a `taskId` is attributed to the task that owns the
 * surface (main-internal handles), never to a caller claim.
 */
export function classifyPageRef(input: {
  page: unknown;
  taskId: string;
  livePages: readonly { pageId: string; webContentsId?: number }[];
}): PageRefCheck {
  if (input.page === undefined || input.page === null) return { ok: false, reason: "page-required: 浏览器操作需要页面句柄" };
  if (!isPageRef(input.page)) return { ok: false, reason: "invalid-payload: page 必须是 {taskId, pageId}" };
  const ref = input.page;
  if (ref.taskId !== undefined && ref.taskId !== input.taskId) {
    return { ok: false, reason: "page-foreign-task: 页面句柄属于其他任务，已拒绝" };
  }
  const live = input.livePages.find((page) => page.pageId === ref.pageId);
  if (!live) {
    return { ok: false, reason: `page-stale: 页面 ${ref.pageId} 不存在或已关闭，请重新获取页面状态` };
  }
  if (ref.webContentsId !== undefined && live.webContentsId !== undefined && ref.webContentsId !== live.webContentsId) {
    return { ok: false, reason: `page-stale: 页面 ${ref.pageId} 的句柄已失效，请重新获取页面状态` };
  }
  return { ok: true, pageId: ref.pageId };
}

/**
 * Task-scoped approval target for one browser action. Keeping it inside
 * the task folder means the shared permission gate's containment rule
 * applies unchanged; the page (or `new` for `page/open`) is the binding.
 */
export function browserApprovalTarget(taskDir: string, pageId?: string): string {
  const key = typeof pageId === "string" && pageId.trim().length > 0 ? pageId.trim() : "new";
  return `${taskDir.replace(/\/+$/, "")}/browser/${key}`;
}

/** Navigation targets allowed for one task, derived from its run config. */
export interface NavigationAllowlist {
  readonly origins: readonly string[];
}

/**
 * Build the allowlist from the task's own run configuration: local service
 * ports (task overrides and registered service ports) and configured
 * addresses. The list is what `navigationTargetAllowed` compares against,
 * so the page's actual network target stays the task's own instance even
 * when a pilot frontend has a stale absolute address in storage.
 */
export function deriveNavigationAllowlist(input: {
  ports?: readonly (number | string)[];
  addresses?: readonly string[];
}): NavigationAllowlist {
  const origins = new Set<string>();
  for (const raw of input.ports ?? []) {
    const port = typeof raw === "number" ? raw : Number.parseInt(String(raw).trim(), 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    origins.add(`http://127.0.0.1:${port}`);
    origins.add(`http://localhost:${port}`);
  }
  for (const raw of input.addresses ?? []) {
    const origin = normalizeOrigin(String(raw));
    if (origin !== null) origins.add(origin);
  }
  return { origins: [...origins].sort() };
}

function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.origin === "null") return null;
  return url.origin;
}

export type NavigationCheck =
  | { ok: true; origin: string }
  | { ok: false; reason: string };

/**
 * Navigation guard: only http/https targets on an origin from the task's
 * own run configuration pass. `file:`, `data:`, `javascript:`, `about:`
 * and any external host are refused, so browsing can never escape the
 * task's own addresses (and the task page keeps its sandboxed web
 * preferences; it never receives desktop capability).
 */
export function navigationTargetAllowed(url: string, allowlist: NavigationAllowlist): NavigationCheck {
  const trimmed = url.trim();
  if (trimmed.length === 0) return { ok: false, reason: "invalid-payload: url 不能为空" };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: `navigation-denied: 无法解析的地址 ${truncateText(trimmed, 120)}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `navigation-denied: 不允许的协议 ${parsed.protocol}` };
  }
  if (parsed.origin === "null") return { ok: false, reason: "navigation-denied: 地址缺少有效来源" };
  if (!allowlist.origins.includes(parsed.origin)) {
    return {
      ok: false,
      reason: `navigation-denied: ${parsed.origin} 不在任务运行配置的地址内（实际网络目标须与任务配置一致）`,
    };
  }
  return { ok: true, origin: parsed.origin };
}

/** Evidence bounds: bounded arrays and bounded text, shared by all callers. */
export const BROWSER_EVIDENCE_LIMITS = {
  maxConsole: 20,
  maxNetwork: 20,
  maxTextLength: 240,
} as const;

/** Mask `user:password@` credentials inside a URL. */
function scrubUrlCredentials(url: string): string {
  return url.replace(/\/\/([^/@\s]+)@/g, "//••••:••••@");
}

/**
 * Mask credential-shaped text without bounding it: known secret values are
 * replaced, credential-ish header and assignment patterns are masked. Shared
 * by the bounded browser evidence path and by file previews/diffs, so the two
 * cannot drift into different masking rules ([PiDock 10] #15).
 */
export function scrubSecretText(text: string, secrets: readonly string[] = []): string {
  let out = scrubUrlCredentials(text);
  for (const secret of secrets) {
    const value = secret.trim();
    if (value.length < 4) continue;
    out = out.split(value).join("••••••••");
  }
  out = out.replace(/(authorization|proxyauthorization)\s*[:=]\s*(?:bearer\s+)?[^\s,;)'"]+/gi, "$1: ••••••••");
  out = out.replace(/(cookie|set-cookie)\s*[:=]\s*[^\n]*/gi, "$1: ••••••••");
  out = out.replace(
    /((?:password|passwd|pwd|token|access_token|refresh_token|api[_-]?key|secret)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&)'"]+)/gi,
    "$1••••••••",
  );
  out = out.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 ••••••••");
  return out;
}

/**
 * Scrub page/log text before it leaves the browser surface: known secret
 * values (task/private config) are replaced, credential-ish header and
 * assignment patterns are masked, and the result is bounded.
 */
export function scrubBrowserText(text: string, secrets: readonly string[] = []): string {
  return truncateText(scrubSecretText(text, secrets), BROWSER_EVIDENCE_LIMITS.maxTextLength);
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

export interface BoundedBrowserEvidence {
  consoleErrors: ConsoleErrorEvidence[];
  failedRequests: FailedRequestEvidence[];
}

/**
 * Bound and scrub console/exception and failed-request evidence: newest
 * entries survive, every text field is masked, and the array sizes are
 * capped so one noisy page cannot flood the session.
 */
export function boundBrowserEvidence(
  input: {
    consoleErrors?: readonly ConsoleErrorEvidence[];
    failedRequests?: readonly FailedRequestEvidence[];
  },
  secrets: readonly string[] = [],
  limits: { maxConsole: number; maxNetwork: number } = BROWSER_EVIDENCE_LIMITS,
): BoundedBrowserEvidence {
  const consoleErrors = (input.consoleErrors ?? [])
    .slice(-limits.maxConsole)
    .map((entry) => ({
      kind: entry.kind,
      text: scrubBrowserText(entry.text, secrets),
      ...(entry.url !== undefined ? { url: scrubBrowserText(entry.url, secrets) } : {}),
      ...(entry.line !== undefined ? { line: entry.line } : {}),
    }));
  const failedRequests = (input.failedRequests ?? []).slice(-limits.maxNetwork).map((entry) => ({
    requestId: entry.requestId,
    url: scrubBrowserText(entry.url, secrets),
    errorText: scrubBrowserText(entry.errorText, secrets),
    resourceType: entry.resourceType,
    canceled: entry.canceled,
  }));
  return { consoleErrors, failedRequests };
}

/** User markup raised on the visible page. Bound to task, page and epoch. */
export interface BrowserMarker {
  taskId: string;
  pageId: string;
  url: string;
  mode: "point" | "box";
  annotation: string;
  epoch: number;
  locator?: Locator;
  rect?: { x: number; y: number; width: number; height: number };
  screenshotSha256?: string;
}

export type BrowserMarkerCheck =
  | { ok: true; marker: BrowserMarker }
  | { ok: false; reason: string };

const MARKER_MAX_ANNOTATION = 1000;

/**
 * Validate the human markup payload. The marker must name this task's
 * live page and a resolvable http/https URL, carry a user annotation, and
 * report the page epoch it was raised against; anything else is refused
 * so a marker can never be attributed to another task or page.
 */
export function validateBrowserMarker(input: {
  payload: unknown;
  taskId: string;
  livePages: readonly { pageId: string; webContentsId?: number }[];
}): BrowserMarkerCheck {
  const record = typeof input.payload === "object" && input.payload !== null && !Array.isArray(input.payload) ? (input.payload as Record<string, unknown>) : null;
  if (!record) return { ok: false, reason: "invalid-payload: 标记需要 {page, url, annotation}" };
  const page = classifyPageRef({ page: record["page"], taskId: input.taskId, livePages: input.livePages });
  if (!page.ok) return { ok: false, reason: page.reason };
  const url = typeof record["url"] === "string" ? record["url"].trim() : "";
  if (url.length === 0) return { ok: false, reason: "invalid-payload: 标记缺少页面地址" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid-payload: 标记地址无法解析" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "invalid-payload: 标记地址必须是 http/https" };
  }
  const mode = record["mode"];
  if (mode !== "point" && mode !== "box") {
    return { ok: false, reason: "invalid-payload: 标记 mode 必须是 point/box" };
  }
  const annotation = typeof record["annotation"] === "string" ? record["annotation"].trim() : "";
  if (annotation.length === 0) {
    return { ok: false, reason: "invalid-payload: 标记需要用户说明" };
  }
  const epoch = record["epoch"];
  if (typeof epoch !== "number" || !Number.isInteger(epoch) || epoch < 0) {
    return { ok: false, reason: "invalid-payload: 标记需要页面 epoch" };
  }
  const marker: BrowserMarker = {
    taskId: input.taskId,
    pageId: page.pageId,
    url,
    mode,
    annotation: truncateText(annotation, MARKER_MAX_ANNOTATION),
    epoch,
  };
  if (record["locator"] !== undefined) marker.locator = record["locator"] as Locator;
  if (record["rect"] !== undefined) marker.rect = record["rect"] as BrowserMarker["rect"];
  if (typeof record["screenshotSha256"] === "string" && record["screenshotSha256"].length > 0) {
    marker.screenshotSha256 = record["screenshotSha256"] as string;
  }
  return { ok: true, marker };
}

/**
 * A marker raised before the last navigation may not be used as-is: the
 * Agent must re-locate it against the current document epoch instead of
 * reusing the old coordinate.
 */
export function markerNeedsRelocation(marker: { epoch: number }, currentEpoch: number): boolean {
  return marker.epoch !== currentEpoch;
}
