import { describe, expect, it } from "vitest";
import { isAllowedInvokeChannel, PRELOAD_BRIDGE_NAME } from "./allowlist.js";

// Seam: renderer->main preload bridge whitelist.
// The sandboxed renderer may only invoke these channels; anything else
// (Node, arbitrary IPC, CDP) must be rejected at the guard.

describe("preload invoke whitelist", () => {
  it("exposes the bridge under a fixed global name", () => {
    expect(PRELOAD_BRIDGE_NAME).toBe("pidock");
  });

  it("allows the version query channel", () => {
    expect(isAllowedInvokeChannel("shell/getVersions")).toBe(true);
  });

  it("allows the host ping channel", () => {
    expect(isAllowedInvokeChannel("shell/hostPing")).toBe(true);
  });

  it("allows the task-scoped op channel (workspace still sender-bound)", () => {
    expect(isAllowedInvokeChannel("shell/taskOp")).toBe(true);
  });

  it("allows only the project operation channel, not membership or raw filesystem access", () => {
    expect(isAllowedInvokeChannel("shell/projectOp")).toBe(true);
    expect(isAllowedInvokeChannel("shell/projectAssign")).toBe(false);
    expect(isAllowedInvokeChannel("shell/readFile")).toBe(false);
  });

  it("allows only main's directory picker and not a raw path IPC channel", () => {
    expect(isAllowedInvokeChannel("shell/importTaskRoot")).toBe(true);
    expect(isAllowedInvokeChannel("shell/readTaskDir")).toBe(false);
  });

  it("rejects arbitrary IPC channels", () => {
    expect(isAllowedInvokeChannel("arbitrary-channel")).toBe(false);
  });

  it("rejects Node/CDP-flavored channels", () => {
    expect(isAllowedInvokeChannel("cdp/send")).toBe(false);
    expect(isAllowedInvokeChannel("node/require")).toBe(false);
    expect(isAllowedInvokeChannel("ipc/send")).toBe(false);
  });
});
