/**
 * Task browser surface for the renderer ([PiDock 06] #8).
 *
 * The renderer shows one visible task page and never touches Chromium,
 * CDP or a page handle directly: it asks for a browser action through the
 * shell, gets a bounded result envelope and renders the outcome. Without
 * the shell (Vite dev, tests) the request is answered as a local
 * simulation, clearly marked as one — there is no page instance there.
 *
 * The view model keeps the pieces the ticket calls user-visible: which
 * page the Agent and user share, whether the user holds it (takeover
 * pauses agent automation), the on-demand console/network evidence, and
 * the markers a user raised with their annotation. Markers carry the page
 * epoch they were raised against, so a page that has moved on reports that
 * the Agent must re-locate instead of reusing the old coordinate.
 */

import type { BrowserPage, Permission } from "./types";
import { browserActionThroughShell } from "./shellBridge";
import { isShellConnected } from "./shellBridge";

export interface PageHandle {
  pageId: string;
  webContentsId?: number;
}

export type BrowserNotice =
  | { kind: "idle" }
  | { kind: "info"; text: string }
  | { kind: "refused"; text: string }
  /** Side-effecting action waiting for a user confirmation. */
  | { kind: "approval"; text: string; approvalId?: string };

export interface BrowserMarkerView {
  id: string;
  pageId: string;
  url: string;
  annotation: string;
  needsRelocation: boolean;
}

export interface BrowserEvidenceView {
  consoleErrors: string[];
  failedRequests: { url: string; errorText: string }[];
}

export interface BrowserSurfaceView {
  pages: BrowserPage[];
  activePageId?: string;
  takeover: { paused: boolean; reason?: string };
  evidence: BrowserEvidenceView;
  markers: BrowserMarkerView[];
  notice: BrowserNotice;
}

/** Marker payload for `task/browserAction` `marker/create`. */
export function markerPayloadFromSelection(input: {
  taskId: string;
  page: PageHandle;
  url: string;
  mode: "point" | "box";
  annotation: string;
  /** Page epoch the selection was made against; relocation follows a change. */
  epoch: number;
  locator?: { kind: string; value?: string; role?: string; name?: string };
  rect?: { x: number; y: number; width: number; height: number };
  screenshotSha256?: string;
}): Record<string, unknown> {
  const annotation = input.annotation.trim();
  return {
    page: { taskId: input.taskId, pageId: input.page.pageId, ...(input.page.webContentsId !== undefined ? { webContentsId: input.page.webContentsId } : {}) },
    url: input.url,
    mode: input.mode,
    annotation: annotation.length > 0 ? annotation : "需要检查这里",
    epoch: input.epoch,
    ...(input.locator !== undefined ? { locator: input.locator } : {}),
    ...(input.rect !== undefined ? { rect: input.rect } : {}),
    ...(input.screenshotSha256 !== undefined ? { screenshotSha256: input.screenshotSha256 } : {}),
  };
}

/**
 * Readable outcome for one action: a refusal keeps the panel usable and
 * names the reason the authoritative side gave (denied target, takeover,
 * a confirmation the user has not answered yet).
 */
export function browserActionNotice(action: string, result: { ok: boolean; error?: string }): BrowserNotice {
  if (result.ok) return { kind: "info", text: `${action} 已在任务页面执行` };
  const error = typeof result.error === "string" ? result.error : "";
  if (error.startsWith("approval-required:")) {
    return { kind: "approval", text: "浏览器操作需要确认，确认后重试", approvalId: error.slice("approval-required:".length).trim() };
  }
  if (error.startsWith("takeover-paused")) {
    return { kind: "refused", text: "用户正在接管页面：Agent 操作已暂停" };
  }
  return { kind: "refused", text: error.length > 0 ? error : "浏览器操作被拒绝" };
}

export interface BrowserActionRequest {
  taskId: string;
  action: string;
  page?: PageHandle;
  params?: Record<string, unknown>;
  sessionId?: string;
  approvalId?: string;
  targetSessionId?: string;
  label?: string;
}

/**
 * Ask for one browser action. Inside the shell it rides
 * `task/browserAction`; outside it is simulated locally so the panel
 * stays explorable in dev/tests, and the caller can tell the two apart
 * because `simulated` is set on the envelope.
 */
export async function requestBrowserAction(
  input: BrowserActionRequest,
): Promise<{ ok: boolean; error?: string; payload?: unknown; simulated?: true }> {
  if (!isShellConnected()) {
    return { ok: true, payload: { simulated: true, action: input.action }, simulated: true };
  }
  return browserActionThroughShell({
    taskId: input.taskId,
    action: input.action,
    ...(input.page !== undefined ? { page: { taskId: input.taskId, ...input.page } } : {}),
    ...(input.params !== undefined ? { params: input.params } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
    ...(input.targetSessionId !== undefined ? { targetSessionId: input.targetSessionId } : {}),
    ...(input.label !== undefined ? { label: input.label } : {}),
  });
}

/**
 * Read the concise page state (identity, epoch, viewport, title/url) the
 * Agent and the panel both use. A marker is raised against this epoch, so
 * the mark flow reads state first instead of guessing the coordinate.
 */
export async function readBrowserPageState(input: {
  taskId: string;
  page: PageHandle;
}): Promise<{ ok: boolean; epoch: number; url: string; title: string; error?: string }> {
  const result = await requestBrowserAction({ taskId: input.taskId, action: "page/state", page: input.page, label: "用户查看页面状态" });
  const payload = typeof result.payload === "object" && result.payload !== null ? (result.payload as Record<string, unknown>) : {};
  const state = typeof payload["state"] === "object" && payload["state"] !== null ? (payload["state"] as Record<string, unknown>) : {};
  const epoch = typeof state["epoch"] === "number" ? (state["epoch"] as number) : 0;
  const url = typeof state["url"] === "string" ? (state["url"] as string) : "";
  const title = typeof state["title"] === "string" ? (state["title"] as string) : "";
  return result.ok ? { ok: true, epoch, url, title } : { ok: false, epoch, url, title, ...(result.error !== undefined ? { error: result.error } : {}) };
}

/** Bounded console/network evidence for the current page. */
export async function readBrowserEvidence(input: {
  taskId: string;
  page: PageHandle;
}): Promise<{ ok: boolean; evidence: BrowserEvidenceView; error?: string }> {
  const result = await requestBrowserAction({ taskId: input.taskId, action: "evidence", page: input.page, label: "用户查看浏览器证据" });
  const payload = typeof result.payload === "object" && result.payload !== null ? (result.payload as Record<string, unknown>) : {};
  const raw = typeof payload["evidence"] === "object" && payload["evidence"] !== null ? (payload["evidence"] as Record<string, unknown>) : {};
  const consoleErrors = Array.isArray(raw["consoleErrors"])
    ? (raw["consoleErrors"] as unknown[]).map((entry) => (typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>)["text"] === "string" ? String((entry as Record<string, unknown>)["text"]) : ""))
    : [];
  const failedRequests = Array.isArray(raw["failedRequests"])
    ? (raw["failedRequests"] as unknown[]).map((entry) => {
        const record = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
        return {
          url: typeof record["url"] === "string" ? (record["url"] as string) : "",
          errorText: typeof record["errorText"] === "string" ? (record["errorText"] as string) : "",
        };
      })
    : [];
  return result.ok
    ? { ok: true, evidence: { consoleErrors, failedRequests } }
    : { ok: false, evidence: { consoleErrors: [], failedRequests: [] }, ...(result.error !== undefined ? { error: result.error } : {}) };
}

/** User takeover: pause agent automation, or hand control back and refresh. */
export async function setBrowserTakeover(input: {
  taskId: string;
  page: PageHandle;
  paused: boolean;
  reason?: string;
}): Promise<BrowserNotice> {
  const result = await requestBrowserAction({
    taskId: input.taskId,
    action: input.paused ? "takeover/pause" : "takeover/resume",
    page: input.page,
    params: input.paused ? { reason: input.reason ?? "用户接管" } : {},
    label: input.paused ? "用户接管浏览器" : "用户交还浏览器控制",
  });
  return browserActionNotice(input.paused ? "人工接管" : "交还控制", result);
}

/**
 * Raise a user marker on the visible page and send it into the current
 * session: task, page, URL, the user's annotation, the obtainable locator
 * and the page epoch travel together, so the Agent works from the same
 * page evidence the user marked.
 */
export async function markBrowserIssue(input: {
  taskId: string;
  page: PageHandle;
  url: string;
  annotation: string;
  mode?: "point" | "box";
  epoch: number;
  locator?: { kind: string; value?: string; role?: string; name?: string };
  rect?: { x: number; y: number; width: number; height: number };
  sessionId?: string;
}): Promise<{ notice: BrowserNotice; marker?: BrowserMarkerView }> {
  const params = {
    marker: markerPayloadFromSelection({
      taskId: input.taskId,
      page: input.page,
      url: input.url,
      mode: input.mode ?? "box",
      annotation: input.annotation,
      epoch: input.epoch,
      ...(input.locator !== undefined ? { locator: input.locator } : {}),
      ...(input.rect !== undefined ? { rect: input.rect } : {}),
    }),
  };
  const result = await requestBrowserAction({
    taskId: input.taskId,
    action: "marker/create",
    page: input.page,
    params,
    label: "用户标记页面问题",
    ...(input.sessionId !== undefined ? { targetSessionId: input.sessionId } : {}),
  });
  const notice = browserActionNotice("标记", result);
  if (!result.ok) return { notice };
  const payload = typeof result.payload === "object" && result.payload !== null ? (result.payload as Record<string, unknown>) : {};
  const marker = typeof payload["marker"] === "object" && payload["marker"] !== null ? (payload["marker"] as Record<string, unknown>) : {};
  return {
    notice,
    marker: {
      id: typeof marker["id"] === "string" ? (marker["id"] as string) : `mark-${input.epoch}`,
      pageId: input.page.pageId,
      url: input.url,
      annotation: input.annotation.trim().length > 0 ? input.annotation.trim() : "需要检查这里",
      needsRelocation: marker["needsRelocation"] === true,
    },
  };
}

/** Read-only sessions cannot drive the page; the panel refuses first. */
export function browserActionRefusal(permission: Permission): string | undefined {
  return permission === "read" ? "当前是只读会话，Agent 不会操作浏览器" : undefined;
}
