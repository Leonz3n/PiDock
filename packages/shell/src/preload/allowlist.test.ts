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

  it("rejects arbitrary IPC channels", () => {
    expect(isAllowedInvokeChannel("arbitrary-channel")).toBe(false);
  });

  it("rejects Node/CDP-flavored channels", () => {
    expect(isAllowedInvokeChannel("cdp/send")).toBe(false);
    expect(isAllowedInvokeChannel("node/require")).toBe(false);
    expect(isAllowedInvokeChannel("ipc/send")).toBe(false);
  });
});
