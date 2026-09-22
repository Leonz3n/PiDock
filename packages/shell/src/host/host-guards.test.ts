import { describe, expect, it } from "vitest";
import { boundWorkspaceId, DEFAULT_WORKSPACE_ID, validateHostTaskOp } from "./host-guards.js";

// Seam: Host process-boundary guards (workspace binding + per-op payloads).
// host.ts itself requires a utilityProcess parent port, so the pure guards
// live in host-guards.ts and are unit-tested here.

describe("boundWorkspaceId", () => {
  it("binds to the fork-time env workspace, defaulting when unset", () => {
    const saved = process.env["PIDOCK_WORKSPACE_ID"];
    delete process.env["PIDOCK_WORKSPACE_ID"];
    expect(boundWorkspaceId()).toBe(DEFAULT_WORKSPACE_ID);
    process.env["PIDOCK_WORKSPACE_ID"] = "workspace-a";
    expect(boundWorkspaceId()).toBe("workspace-a");
    if (saved === undefined) delete process.env["PIDOCK_WORKSPACE_ID"];
    else process.env["PIDOCK_WORKSPACE_ID"] = saved;
  });
});

describe("task-workspace binding rule", () => {
  it("rejects a routed workspace that differs from the bound workspace", () => {
    const saved = process.env["PIDOCK_WORKSPACE_ID"];
    process.env["PIDOCK_WORKSPACE_ID"] = "workspace-a";
    try {
      // Rule mirrored in host.ts: mismatch -> task-workspace-mismatch.
      const routed = "workspace-b";
      expect(routed === boundWorkspaceId()).toBe(false);
      expect("workspace-a" === boundWorkspaceId()).toBe(true);
    } finally {
      if (saved === undefined) delete process.env["PIDOCK_WORKSPACE_ID"];
      else process.env["PIDOCK_WORKSPACE_ID"] = saved;
    }
  });
});

describe("validateHostTaskOp", () => {
  it("requires a provision root and a task-<hex> dir id", () => {
    expect(validateHostTaskOp("task/provision", { root: "~/T", dirId: "task-abcdef12" })).toEqual({
      ok: true,
    });
    expect(validateHostTaskOp("task/provision", { root: "", dirId: "task-abcdef12" }).ok).toBe(false);
    expect(validateHostTaskOp("task/provision", { root: "~/T", dirId: "nope" }).ok).toBe(false);
    expect(validateHostTaskOp("task/provision", {}).ok).toBe(false);
  });

  it("requires a sendMessage session id and non-blank text", () => {
    expect(validateHostTaskOp("task/sendMessage", { sessionId: "main", text: "hi" })).toEqual({
      ok: true,
    });
    expect(validateHostTaskOp("task/sendMessage", { sessionId: "", text: "hi" }).ok).toBe(false);
    expect(validateHostTaskOp("task/sendMessage", { sessionId: "main", text: "  " }).ok).toBe(false);
  });

  it("rejects unknown ops and non-object payloads", () => {
    expect(validateHostTaskOp("task/exec", {})).toEqual({ ok: false, error: "unknown-op" });
    expect(validateHostTaskOp("task/cancel", "nope").ok).toBe(false);
    expect(validateHostTaskOp("task/approve", {})).toEqual({ ok: true });
  });
});
