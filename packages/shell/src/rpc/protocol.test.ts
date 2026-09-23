import { describe, expect, it } from "vitest";
import {
  isBrowserRequest,
  isBrowserResponse,
  isHostTaskOp,
  isHostTaskParams,
  isRpcRequest,
  isRpcResponse,
} from "./protocol.js";

// Seam: main<->utilityProcess typed RPC message boundary.
// Only these shapes may cross the MessagePort; everything else is rejected.

describe("isRpcRequest", () => {
  it("accepts a well-formed host/ping request", () => {
    expect(
      isRpcRequest({ kind: "request", id: "1", method: "host/ping", params: {} }),
    ).toBe(true);
  });

  it("rejects an unknown method (fail-closed whitelist)", () => {
    expect(
      isRpcRequest({ kind: "request", id: "1", method: "host/exec", params: {} }),
    ).toBe(false);
  });

  it("rejects a non-object envelope", () => {
    expect(isRpcRequest("host/ping")).toBe(false);
    expect(isRpcRequest(null)).toBe(false);
  });

  it("rejects an oversized payload", () => {
    expect(
      isRpcRequest({
        kind: "request",
        id: "1",
        method: "host/ping",
        params: { blob: "x".repeat(1024 * 1024 + 1) },
      }),
    ).toBe(false);
  });
});

describe("host/task routing", () => {
  it("accepts a task-routed request with workspace, task and op", () => {
    expect(
      isRpcRequest({
        kind: "request",
        id: "9",
        method: "host/task",
        params: { workspaceId: "workspace-a", taskId: "task-a", op: "task/sendMessage" },
      }),
    ).toBe(true);
  });

  it("rejects a task route missing the task binding", () => {
    expect(
      isRpcRequest({
        kind: "request",
        id: "9",
        method: "host/task",
        params: { workspaceId: "workspace-a", op: "task/sendMessage" },
      }),
    ).toBe(false);
  });

  it("rejects an unknown task op fail-closed", () => {
    expect(
      isRpcRequest({
        kind: "request",
        id: "9",
        method: "host/task",
        params: { workspaceId: "workspace-a", taskId: "task-a", op: "task/exec" },
      }),
    ).toBe(false);
    expect(isHostTaskParams({ workspaceId: "w", taskId: "t", op: "task/exec" })).toBe(false);
    expect(isHostTaskParams({ workspaceId: "w", taskId: "t", op: "task/cancel" })).toBe(true);
  });

  // BLOCK P0-2: the sender attestation rides the main-built envelope. A
  // present-but-malformed attestation is rejected, never ignored; an
  // absent one stays valid (unattested route) and the Host then refuses
  // session-less human control.
  it("accepts only the main-stamped shell-ui origin shape", () => {
    expect(isHostTaskParams({ workspaceId: "w", taskId: "t", op: "task/cancel", origin: { kind: "shell-ui", senderWebContentsId: 3 } })).toBe(true);
    expect(isHostTaskParams({ workspaceId: "w", taskId: "t", op: "task/cancel" })).toBe(true);
    expect(isHostTaskParams({ workspaceId: "w", taskId: "t", op: "task/cancel", origin: { kind: "agent-tool", senderWebContentsId: 3 } })).toBe(false);
    expect(isHostTaskParams({ workspaceId: "w", taskId: "t", op: "task/cancel", origin: { kind: "shell-ui", senderWebContentsId: 0 } })).toBe(false);
    expect(isHostTaskParams({ workspaceId: "w", taskId: "t", op: "task/cancel", origin: "shell-ui" })).toBe(false);
  });
});

describe("isRpcResponse", () => {
  it("accepts a well-formed ok response", () => {
    expect(
      isRpcResponse({ kind: "response", id: "1", ok: true, payload: { pong: true } }),
    ).toBe(true);
  });

  it("accepts a well-formed error response", () => {
    expect(
      isRpcResponse({ kind: "response", id: "1", ok: false, error: "nope" }),
    ).toBe(true);
  });

  it("rejects a response carrying an unexpected shape", () => {
    expect(isRpcResponse({ kind: "response", id: "1" })).toBe(false);
    expect(isRpcResponse({ kind: "event", id: "1", ok: true })).toBe(false);
  });
});

// [PiDock 06] (#8) adds the task-browser op and the Host -> main browser
// request/response envelopes on the same port; both are fail-closed.
describe("browser envelopes", () => {
  it("accepts the browser task op", () => {
    expect(isHostTaskOp("task/browserAction")).toBe(true);
    expect(isHostTaskOp("task/browserTeleport")).toBe(false);
  });

  it("accepts a well-formed browser request and rejects partial ones", () => {
    const request = {
      kind: "browser-request",
      id: "browser-1",
      params: {
        workspaceId: "ws-a",
        taskId: "task-a1f92c3d",
        action: "page/state",
        page: { pageId: "page-1" },
        actor: { kind: "agent", sessionId: "main" },
      },
    };
    expect(isBrowserRequest(request)).toBe(true);
    expect(isBrowserRequest({ ...request, params: { ...request.params, actor: { kind: "agent" } } })).toBe(false);
    expect(isBrowserRequest({ ...request, params: { ...request.params, action: "" } })).toBe(false);
    expect(isBrowserRequest({ ...request, params: { ...request.params, workspaceId: "" } })).toBe(false);
    expect(isBrowserRequest({ ...request, id: "" })).toBe(false);
    expect(isBrowserRequest({ kind: "request", id: "1", method: "host/ping", params: {} })).toBe(false);
  });

  it("accepts both browser response directions only", () => {
    expect(isBrowserResponse({ kind: "browser-response", id: "browser-1", ok: true, payload: {} })).toBe(true);
    expect(isBrowserResponse({ kind: "browser-response", id: "browser-1", ok: false, error: "takeover-paused" })).toBe(true);
    expect(isBrowserResponse({ kind: "browser-response", id: "browser-1" })).toBe(false);
    expect(isBrowserResponse({ kind: "response", id: "browser-1", ok: true, payload: {} })).toBe(false);
  });
});

// [PiDock 19] (#21) adds the remote-access ops to the same task-op whitelist.
describe("remote access ops", () => {
  it("accepts the declared remote ops and nothing else", () => {
    for (const op of [
      "task/remoteState",
      "task/remoteEntryMode",
      "task/remotePairMint",
      "task/remotePairCancel",
      "task/remotePairExchange",
      "task/remoteDeviceConfirm",
      "task/remoteDeviceReject",
      "task/remoteDeviceRevoke",
      "task/remoteDeviceRotate",
      "task/remoteAuthorize",
      "task/remoteReconnectPlan",
      "task/remoteGatewayEvent",
      "task/remoteAudit",
    ] as const) {
      expect(isHostTaskOp(op)).toBe(true);
    }
    expect(isHostTaskOp("task/remotePair")).toBe(false);
    expect(isHostTaskOp("task/remoteRawTcp")).toBe(false);
    expect(isHostTaskOp("task/remotePiRpc")).toBe(false);
  });
});

// [PiDock 17] (#19) adds the execution-state and attention reads to the same
// task-op whitelist; the guard stays fail-closed (unknown names never pass).
describe("execution ledger ops", () => {
  it("accepts the execution state / attention / mark-read ops", () => {
    expect(isHostTaskOp("task/executionState")).toBe(true);
    expect(isHostTaskOp("task/attention")).toBe(true);
    expect(isHostTaskOp("task/markAttentionRead")).toBe(true);
    expect(isHostTaskOp("task/executions")).toBe(false);
    expect(isHostTaskOp("task/attentionRead")).toBe(false);
  });

  it("routes an execution-state call with its session id", () => {
    expect(
      isHostTaskParams({
        workspaceId: "ws-a",
        taskId: "task-a1f92c3d",
        op: "task/executionState",
        payload: { sessionId: "main" },
      }),
    ).toBe(true);
    expect(
      isHostTaskParams({ workspaceId: "ws-a", taskId: "task-a1f92c3d", op: "task/executionState", payload: {} }),
    ).toBe(true);
  });
});
