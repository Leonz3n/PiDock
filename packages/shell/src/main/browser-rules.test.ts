import { describe, expect, it } from "vitest";
import {
  boundBrowserEvidence,
  browserActionForTool,
  browserApprovalTarget,
  browserToolForAction,
  classifyPageRef,
  deriveNavigationAllowlist,
  isBrowserAction,
  markerNeedsRelocation,
  navigationTargetAllowed,
  scrubBrowserText,
  validateBrowserMarker,
  BROWSER_EVIDENCE_LIMITS,
} from "./browser-rules.js";

// [PiDock 06] (#8) S1: the browser surface's pure rules. These are the
// shared seam for the main-process gateway and the utilityProcess Host, so
// the tests drive them directly (no window, no Electron, no network).

const TASK_ID = "task-0000abcd";
const TASK_DIR = `/tasks/${TASK_ID}`;

describe("page handles", () => {
  const livePages = [
    { pageId: "page-1", webContentsId: 11 },
    { pageId: "page-2", webContentsId: 12 },
  ];

  it("accepts a handle bound to a live page of this task", () => {
    expect(
      classifyPageRef({ page: { taskId: TASK_ID, pageId: "page-1", webContentsId: 11 }, taskId: TASK_ID, livePages }),
    ).toEqual({ ok: true, pageId: "page-1" });
  });

  it("rejects another task's handle instead of resolving it", () => {
    const result = classifyPageRef({
      page: { taskId: "task-9999ffff", pageId: "page-1", webContentsId: 11 },
      taskId: TASK_ID,
      livePages,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("page-foreign-task");
  });

  it("attributes a handle without a task id to the task that owns the surface", () => {
    // Main-internal handles carry no task id; they belong to the surface's
    // task, never to whatever a caller claims.
    expect(classifyPageRef({ page: { pageId: "page-1", webContentsId: 11 }, taskId: TASK_ID, livePages })).toEqual({ ok: true, pageId: "page-1" });
  });

  it("rejects unknown pages, stale webContents ids and malformed handles", () => {
    const unknown = classifyPageRef({ page: { taskId: TASK_ID, pageId: "page-closed" }, taskId: TASK_ID, livePages });
    expect(unknown.ok === false && unknown.reason).toContain("page-stale");
    const stale = classifyPageRef({
      page: { taskId: TASK_ID, pageId: "page-1", webContentsId: 99 },
      taskId: TASK_ID,
      livePages,
    });
    expect(stale.ok === false && stale.reason).toContain("page-stale");
    expect(classifyPageRef({ page: { taskId: TASK_ID }, taskId: TASK_ID, livePages }).ok).toBe(false);
    expect(classifyPageRef({ page: "page-1", taskId: TASK_ID, livePages }).ok).toBe(false);
    expect(classifyPageRef({ page: undefined, taskId: TASK_ID, livePages }).ok).toBe(false);
  });
});

describe("action / tool binding", () => {
  it("maps every agent action to exactly one gated tool", () => {
    expect(browserToolForAction("page/navigate")).toBe("browser.navigate");
    expect(browserToolForAction("input/click")).toBe("browser.click");
    expect(browserActionForTool("browser.act")).toBe("input/click");
    expect(browserActionForTool("browser.screenshot")).toBe("screenshot");
    expect(browserActionForTool("fs.write")).toBeNull();
  });

  it("keeps user-only actions off the agent tool surface", () => {
    for (const action of ["marker/create", "takeover/pause", "takeover/resume"] as const) {
      expect(isBrowserAction(action)).toBe(true);
      expect(() => browserToolForAction(action)).toThrow();
    }
  });

  it("binds an approval target to the task folder + page (new pages use `new`)", () => {
    expect(browserApprovalTarget(TASK_DIR, "page-1")).toBe(`${TASK_DIR}/browser/page-1`);
    expect(browserApprovalTarget(`${TASK_DIR}/`, undefined)).toBe(`${TASK_DIR}/browser/new`);
  });
});

describe("navigation allowlist from the task run configuration", () => {
  const allowlist = deriveNavigationAllowlist({
    ports: [5173, "8080", 0, "not-a-port"],
    addresses: ["https://saas.example.com/app", "file:///etc/passwd"],
  });

  it("derives loopback origins from task ports and configured addresses", () => {
    expect(allowlist.origins).toEqual([
      "http://127.0.0.1:5173",
      "http://127.0.0.1:8080",
      "http://localhost:5173",
      "http://localhost:8080",
      "https://saas.example.com",
    ]);
  });

  it("allows only http/https targets on the task's own origins", () => {
    expect(navigationTargetAllowed("http://localhost:5173/checkout", allowlist)).toEqual({
      ok: true,
      origin: "http://localhost:5173",
    });
    expect(navigationTargetAllowed("https://saas.example.com/detail/1", allowlist).ok).toBe(true);
    for (const url of [
      "http://localhost:5174/checkout",
      "https://example.org/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<h1>x</h1>",
      "about:blank",
      "",
      "not a url",
    ]) {
      expect(navigationTargetAllowed(url, allowlist).ok).toBe(false);
    }
  });
});

describe("evidence scrubbing and bounding", () => {
  it("masks known secrets, credentials and bearer tokens", () => {
    const scrubbed = scrubBrowserText(
      "GET http://user:pass@localhost:5173/api?token=abc123 Authorization: Bearer sk-live-1234567 password=hunter2 cookie=session%3D1",
      ["hunter2"],
    );
    expect(scrubbed).not.toContain("user:pass@");
    expect(scrubbed).not.toContain("hunter2");
    expect(scrubbed).not.toContain("sk-live-1234567");
    expect(scrubbed).toContain("••••••••");
  });

  it("keeps the newest bounded evidence and bounds every text field", () => {
    const bounded = boundBrowserEvidence(
      {
        consoleErrors: Array.from({ length: BROWSER_EVIDENCE_LIMITS.maxConsole + 5 }, (_, index) => ({
          kind: "console" as const,
          text: `error-${index}`,
        })),
        failedRequests: [
          {
            requestId: "r1",
            url: "http://localhost:5173/api?token=secret-value-123",
            errorText: `x`.repeat(1000),
            resourceType: "XHR",
            canceled: false,
          },
        ],
      },
      ["secret-value-123"],
    );
    expect(bounded.consoleErrors).toHaveLength(BROWSER_EVIDENCE_LIMITS.maxConsole);
    expect(bounded.consoleErrors.at(-1)?.text).toBe(`error-${BROWSER_EVIDENCE_LIMITS.maxConsole + 4}`);
    expect(bounded.failedRequests[0]?.url).not.toContain("secret-value-123");
    expect(bounded.failedRequests[0]?.errorText.length).toBeLessThanOrEqual(BROWSER_EVIDENCE_LIMITS.maxTextLength);
  });
});

describe("user markers", () => {
  const livePages = [{ pageId: "page-1", webContentsId: 11 }];
  const payload = {
    page: { taskId: TASK_ID, pageId: "page-1" },
    url: "http://localhost:5173/checkout",
    mode: "box",
    annotation: "总额与对账单不一致",
    epoch: 2,
    locator: { kind: "testId", value: "checkout-total" },
    rect: { x: 10, y: 20, width: 120, height: 24 },
    screenshotSha256: "a".repeat(64),
  };

  it("accepts a marker carrying task/page/url/selection/annotation", () => {
    const result = validateBrowserMarker({ payload, taskId: TASK_ID, livePages });
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.marker).toMatchObject({
      taskId: TASK_ID,
      pageId: "page-1",
      mode: "box",
      epoch: 2,
      locator: { kind: "testId", value: "checkout-total" },
    });
  });

  it("rejects foreign pages, closed pages, missing annotations and bad epochs", () => {
    const foreign = validateBrowserMarker({
      payload: { ...payload, page: { taskId: "task-9999ffff", pageId: "page-1" } },
      taskId: TASK_ID,
      livePages,
    });
    expect(foreign.ok === false && foreign.reason).toContain("page-foreign-task");
    expect(validateBrowserMarker({ payload: { ...payload, page: { taskId: TASK_ID, pageId: "gone" } }, taskId: TASK_ID, livePages }).ok).toBe(false);
    expect(validateBrowserMarker({ payload: { ...payload, annotation: "   " }, taskId: TASK_ID, livePages }).ok).toBe(false);
    expect(validateBrowserMarker({ payload: { ...payload, epoch: undefined }, taskId: TASK_ID, livePages }).ok).toBe(false);
    expect(validateBrowserMarker({ payload: { ...payload, mode: "circle" }, taskId: TASK_ID, livePages }).ok).toBe(false);
    expect(validateBrowserMarker({ payload: { ...payload, url: "javascript:alert(1)" }, taskId: TASK_ID, livePages }).ok).toBe(false);
  });

  it("requires relocation once the page epoch moved on", () => {
    expect(markerNeedsRelocation({ epoch: 2 }, 2)).toBe(false);
    expect(markerNeedsRelocation({ epoch: 2 }, 3)).toBe(true);
  });
});
