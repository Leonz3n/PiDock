import { describe, expect, it } from "vitest";
import { isRpcRequest, isRpcResponse } from "./protocol.js";

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
