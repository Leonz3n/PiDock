/**
 * Main-process task-browser gateway for [PiDock 06] (#8).
 *
 * Main owns the visible page (`TaskBrowser` + `TaskAutomation` +
 * `AgentPageController`), so it is also where a browser request is
 * validated before anything touches the page:
 *
 * - the surface must belong to the task the request names (a gateway
 *   wired to another task is rejected)
 * - a page handle must name a live page of this task (foreign-task and
 *   stale handles fail closed)
 * - navigation targets must be on the task's own run configuration
 * - agent automation is refused while the user holds the page (takeover)
 * - console/network evidence is bounded and scrubbed and on-demand
 *   screenshots are size-capped before they cross the RPC boundary
 * - user markers are attributed to this task's page and report whether
 *   the page moved on (the Agent must re-locate, not reuse a coordinate)
 *
 * The surface is injected (`BrowserSurface`) so these rules are unit
 * tested without Electron; `task-browser-surface.ts` is the real adapter
 * over the verified [PiDock 21] page classes.
 */

import {
  boundBrowserEvidence,
  classifyPageRef,
  isBrowserAction,
  markerNeedsRelocation,
  navigationTargetAllowed,
  validateBrowserMarker,
  type BrowserAction,
  type ConsoleErrorEvidence,
  type FailedRequestEvidence,
  type NavigationAllowlist,
} from "./browser-rules.js";
import type { BrowserPerformResult } from "../rpc/protocol.js";

export interface BrowserLivePage {
  pageId: string;
  webContentsId: number;
  url: string;
}

export interface BrowserSurfaceState {
  epoch: number;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  title: string;
  url: string;
}

/** One already-scoped action handed to the real page classes. */
export interface BrowserSurfaceRequest {
  action: BrowserAction;
  page: { pageId: string; webContentsId: number } | undefined;
  params: Record<string, unknown>;
  actor: { kind: "agent"; sessionId: string } | { kind: "human"; label: string };
}

export interface BrowserScreenshot {
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  /** PNG payload for on-demand screenshots; `undefined` when over the cap. */
  data?: string;
}

/**
 * The task's visible browser, as main's capability layer sees it. Every
 * method operates on the same WebContents the user sees; there is no
 * hidden window fallback.
 */
export interface BrowserSurface {
  readonly taskId: string;
  pages(): BrowserLivePage[];
  state(page: { pageId: string; webContentsId: number }): Promise<BrowserSurfaceState>;
  takeoverState(): { paused: boolean; reason?: string };
  /** Raw (unscrubbed) evidence; the gateway bounds and scrubs it. */
  rawEvidence(): { consoleErrors: ConsoleErrorEvidence[]; failedRequests: FailedRequestEvidence[] };
  screenshot(page: { pageId: string; webContentsId: number }): Promise<BrowserScreenshot>;
  perform(request: BrowserSurfaceRequest): Promise<BrowserPerformResult>;
}

/** Max on-demand screenshot payload (base64 chars) kept inside one RPC envelope. */
export const MAX_SCREENSHOT_BASE64 = 768 * 1024;

/** Actions that address an existing page (the rest create a page or act on the task). */
const PAGE_REQUIRED_ACTIONS: readonly BrowserAction[] = [
  "page/state",
  "page/navigate",
  "page/reload",
  "page/close",
  "input/click",
  "input/fill",
  "input/key",
  "wait",
  "screenshot",
  "evidence",
  "marker/create",
  "marker/relocate",
];

/** Agent-reachable actions. User-only actions never run through this path. */
const AGENT_ACTIONS: readonly BrowserAction[] = [
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
  "marker/relocate",
];

export function isAgentReachableAction(action: BrowserAction): boolean {
  return AGENT_ACTIONS.includes(action);
}

export interface BrowserGatewayDeps {
  taskId: string;
  surface: BrowserSurface;
  allowlist: NavigationAllowlist;
  /** Task-private secret values scrubbed from any text leaving the surface. */
  secrets?: readonly string[];
}

type BoundPage = { pageId: string; webContentsId: number };

/**
 * The gateway the Host drives. `perform` is the only entry point: it
 * validates first and delegates second, so a rejected request never
 * reaches the page.
 */
export function createBrowserGateway(deps: BrowserGatewayDeps): {
  readonly taskId: string;
  perform(request: BrowserSurfaceRequest): Promise<BrowserPerformResult>;
} {
  const secrets = deps.secrets ?? [];

  async function perform(request: BrowserSurfaceRequest): Promise<BrowserPerformResult> {
    if (deps.surface.taskId !== deps.taskId) {
      return { ok: false, error: "page-foreign-task: 浏览器能力绑定到其他任务，已拒绝" };
    }
    if (request.actor.kind === "agent" && !isAgentReachableAction(request.action)) {
      return { ok: false, error: `permission-denied: ${request.action} 只能由用户显式操作` };
    }
    if (request.actor.kind === "agent") {
      const takeover = deps.surface.takeoverState();
      if (takeover.paused) {
        return {
          ok: false,
          error: `takeover-paused: 用户正在接管页面${takeover.reason !== undefined ? `（${takeover.reason}）` : ""}，Agent 操作已暂停`,
        };
      }
    }

    let page: BoundPage | undefined;
    if (PAGE_REQUIRED_ACTIONS.includes(request.action) || request.page !== undefined) {
      const checked = classifyPageRef({ page: request.page, taskId: deps.taskId, livePages: deps.surface.pages() });
      if (!checked.ok) return { ok: false, error: checked.reason };
      const live = deps.surface.pages().find((candidate) => candidate.pageId === checked.pageId);
      if (!live) return { ok: false, error: `page-stale: 页面 ${checked.pageId} 已关闭，请重新获取页面状态` };
      page = { pageId: live.pageId, webContentsId: live.webContentsId };
    }

    if (request.action === "page/open" || request.action === "page/navigate") {
      const url = typeof request.params["url"] === "string" ? (request.params["url"] as string) : "";
      const allowed = navigationTargetAllowed(url, deps.allowlist);
      if (!allowed.ok) return { ok: false, error: allowed.reason };
    }

    if (request.action === "evidence") {
      return { ok: true, payload: { evidence: boundBrowserEvidence(deps.surface.rawEvidence(), secrets) } };
    }

    if (request.action === "page/state") {
      if (!page) return { ok: false, error: "page-required: 该操作需要任务内的页面句柄" };
      const state = await deps.surface.state(page);
      return {
        ok: true,
        payload: {
          state,
          pageId: page.pageId,
          identity: { taskId: deps.taskId, pageId: page.pageId, webContentsId: page.webContentsId },
        },
      };
    }

    if (request.action === "screenshot" || request.action === "marker/create" || request.action === "marker/relocate") {
      if (!page) return { ok: false, error: "page-required: 该操作需要任务内的页面句柄" };
    }

    if (request.action === "screenshot" && page) {
      const shot = await deps.surface.screenshot(page);
      if (shot.data !== undefined && shot.data.length > MAX_SCREENSHOT_BASE64) {
        return {
          ok: false,
          error: `screenshot-too-large: 截图 ${Math.round(shot.data.length / 1024)}KB 超过上限，请缩小视口或截图区域`,
        };
      }
      const screenshot = {
        bytes: shot.bytes,
        width: shot.width,
        height: shot.height,
        sha256: shot.sha256,
        ...(shot.data !== undefined ? { data: shot.data } : {}),
      };
      return { ok: true, payload: { screenshot, pageId: page.pageId } };
    }

    if (request.action === "marker/create" && page) {
      const validated = validateBrowserMarker({ payload: request.params["marker"], taskId: deps.taskId, livePages: deps.surface.pages() });
      if (!validated.ok) return { ok: false, error: validated.reason };
      const current = await deps.surface.state(page);
      const outcome = await deps.surface.perform({
        ...request,
        action: "marker/create",
        page,
        params: { ...request.params, marker: validated.marker },
      });
      if (!outcome.ok) return outcome;
      const marker = {
        kind: "browser-marker" as const,
        ...validated.marker,
        currentEpoch: current.epoch,
        needsRelocation: markerNeedsRelocation(validated.marker, current.epoch),
      };
      return { ok: true, payload: { ...outcome.payload, marker, pageId: page.pageId } };
    }

    const outcome = await deps.surface.perform({ ...request, page });
    if (!outcome.ok) return outcome;
    return { ok: true, payload: outcome.payload };
  }

  return { taskId: deps.taskId, perform };
}

/**
 * Per-task gateway registry used by main's RPC handler: one gateway per
 * task, built from that task's surface (its own partition and pages), its
 * own navigation allowlist and its own secret values. An unknown task
 * fails closed before any surface is created.
 */
export function createBrowserGatewayRegistry(input: {
  workspaceId: string;
  surfaceFor: (taskId: string) => BrowserSurface | { error: string };
  allowlistFor: (taskId: string) => NavigationAllowlist;
  secretsFor?: (taskId: string) => readonly string[];
}) {
  const gateways = new Map<string, ReturnType<typeof createBrowserGateway>>();

  function gatewayFor(taskId: string): { gateway: ReturnType<typeof createBrowserGateway> } | { error: string } {
    if (typeof taskId !== "string" || taskId.trim().length === 0) {
      return { error: "invalid-payload: 浏览器请求需要任务" };
    }
    const cached = gateways.get(taskId);
    if (cached) return { gateway: cached };
    const surface = input.surfaceFor(taskId);
    if ("error" in surface) return surface;
    const gateway = createBrowserGateway({
      taskId,
      surface,
      allowlist: input.allowlistFor(taskId),
      secrets: input.secretsFor?.(taskId) ?? [],
    });
    gateways.set(taskId, gateway);
    return { gateway };
  }

  return {
    gatewayFor,
    /**
     * Handles one Host -> main browser request. The Host names its own
     * task; a request for another workspace is refused here rather than
     * resolved against this main process's pages.
     */
    async handleRequest(request: {
      workspaceId: string;
      taskId: string;
      action: unknown;
      page?: unknown;
      params?: Record<string, unknown>;
      actor: { kind: "agent"; sessionId: string } | { kind: "human"; label: string };
    }): Promise<BrowserPerformResult> {
      if (request.workspaceId !== input.workspaceId) {
        return { ok: false, error: "task-workspace-mismatch" };
      }
      if (!isBrowserAction(request.action)) {
        return { ok: false, error: `unknown-action: ${String(request.action)}` };
      }
      const resolved = gatewayFor(request.taskId);
      if ("error" in resolved) return { ok: false, error: resolved.error };
      return resolved.gateway.perform({
        action: request.action,
        page: request.page as BoundPage | undefined,
        params: request.params ?? {},
        actor: request.actor,
      });
    },
  };
}
