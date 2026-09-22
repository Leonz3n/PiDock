import { describe, expect, it } from "vitest";
import { boundWorkspaceId, buildHostEnv, DEFAULT_WORKSPACE_ID, routeHostTask, routeTaskBinding, validateHostTaskOp } from "./host-guards.js";

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
    // Exercises the exact rule host.ts enforces before dispatching
    // (host.ts itself needs a utilityProcess parent port).
    expect(
      routeHostTask(
        { workspaceId: "workspace-b", taskId: "task-a", op: "task/cancel" },
        "workspace-a",
      ),
    ).toBe("task-workspace-mismatch");
    expect(
      routeHostTask(
        { workspaceId: "workspace-a", taskId: "task-a", op: "task/cancel" },
        "workspace-a",
      ),
    ).toBe("routable");
    expect(routeHostTask({ workspaceId: "workspace-a", taskId: "", op: "task/cancel" }, "workspace-a")).toBe(
      "invalid-params",
    );
    expect(routeHostTask({ workspaceId: "workspace-a", taskId: "task-a", op: "task/exec" }, "workspace-a")).toBe(
      "invalid-params",
    );
  });
});

describe("task binding rule", () => {
  it("routes only the fork-bound task and fails closed when unbound", () => {
    expect(routeTaskBinding("task-a", "task-a", "/tmp/task-a")).toBe("routable");
    expect(routeTaskBinding("task-b", "task-a", "/tmp/task-a")).toBe("task-unknown");
    expect(routeTaskBinding("", "task-a", "/tmp/task-a")).toBe("task-unknown");
    expect(routeTaskBinding("task-a", undefined, "/tmp/task-a")).toBe("task-unbound");
    expect(routeTaskBinding("task-a", "task-a", undefined)).toBe("task-unbound");
    expect(routeTaskBinding("task-a", "", "/tmp/task-a")).toBe("task-unbound");
  });
});

describe("buildHostEnv", () => {
  it("binds workspace plus the fork-time task folder, failing closed on partial bindings", () => {
    const env = buildHostEnv({ PATH: "/bin", EMPTY: undefined, PIDOCK_WORKSPACE_ID: "old" }, "workspace-a", {
      taskId: "task-a",
      taskDir: "/tmp/task-a",
    });
    expect(env["PIDOCK_WORKSPACE_ID"]).toBe("workspace-a");
    expect(env["PIDOCK_TASK_ID"]).toBe("task-a");
    expect(env["PIDOCK_TASK_DIR"]).toBe("/tmp/task-a");
    expect(env["PATH"]).toBe("/bin");
    // Unbound (workspace-only) Host stays valid for ping/versions smoke paths.
    const unbound = buildHostEnv({}, "workspace-a");
    expect(unbound["PIDOCK_WORKSPACE_ID"]).toBe("workspace-a");
    expect(unbound["PIDOCK_TASK_ID"]).toBeUndefined();
    expect(() => buildHostEnv({}, "")).toThrow("workspaceId");
    expect(() => buildHostEnv({}, "workspace-a", { taskId: "", taskDir: "/tmp/task-a" })).toThrow("taskId");
    expect(() => buildHostEnv({}, "workspace-a", { taskId: "task-a", taskDir: "relative/dir" })).toThrow("taskDir");
  });
});

describe("validateHostTaskOp", () => {
  it("requires a provision dir id plus root (S1) or name/baseline (S2)", () => {
    expect(validateHostTaskOp("task/provision", { root: "~/T", dirId: "task-abcdef12" })).toEqual({
      ok: true,
    });
    expect(
      validateHostTaskOp("task/provision", {
        name: "\u53d1\u5e03\u524d\u68c0\u67e5",
        dirId: "task-abcdef12",
        remoteBranch: "main",
        fetchedCommit: "a5a4a0d1234",
      }),
    ).toEqual({ ok: true });
    expect(validateHostTaskOp("task/provision", { root: "", dirId: "task-abcdef12" }).ok).toBe(false);
    expect(validateHostTaskOp("task/provision", { root: "~/T", dirId: "nope" }).ok).toBe(false);
    expect(validateHostTaskOp("task/provision", {}).ok).toBe(false);
    expect(
      validateHostTaskOp("task/provision", { name: "x", dirId: "task-abcdef12", remoteBranch: "main" }).ok,
    ).toBe(false);
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
