import { describe, expect, it } from "vitest";
import {
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
