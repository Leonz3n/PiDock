import { describe, expect, it } from "vitest";
import { boundWorkspaceId, buildHostEnv, buildToolPlannerSpec, DEFAULT_WORKSPACE_ID, routeHostTask, routeTaskBinding, toolPlannerSpecForHostDispatch, toolPlannerSpecForOp, validateHostTaskOp } from "./host-guards.js";

// S6 final wiring: approval-listing reads ride `task/listApprovals` +
// `task/getApproval` (fail-closed payloads; host.ts needs a parent port).
describe("approval listing ops", () => {
  it("accepts listApprovals with empty/absent filter and getApproval with an id", () => {
    expect(validateHostTaskOp("task/listApprovals", {})).toEqual({ ok: true });
    expect(validateHostTaskOp("task/listApprovals", { sessionId: "main" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/listApprovals", { sessionId: " " }).ok).toBe(false);
    expect(validateHostTaskOp("task/listApprovals", "nope").ok).toBe(false);
    expect(validateHostTaskOp("task/getApproval", { approvalId: "approval-1" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/getApproval", { approvalId: " " }).ok).toBe(false);
    expect(validateHostTaskOp("task/getApproval", {}).ok).toBe(false);
  });
});

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

  it("accepts S6 turn options and rejects malformed usage", () => {
    expect(
      validateHostTaskOp("task/sendMessage", {
        sessionId: "main",
        text: "hi",
        providerId: "provider-local",
        model: "pidock-default",
        usageSource: "actual",
        usage: { input: 10, output: 5, cacheRead: 0 },
        credentialRef: "PIDOCK_PI_TOKEN",
      }),
    ).toEqual({ ok: true });
    expect(
      validateHostTaskOp("task/sendMessage", { sessionId: "main", text: "hi", usageSource: "live" }).ok,
    ).toBe(false);
    expect(
      validateHostTaskOp("task/sendMessage", { sessionId: "main", text: "hi", usage: { input: -1 } }).ok,
    ).toBe(false);
    expect(
      validateHostTaskOp("task/sendMessage", { sessionId: "main", text: "hi", credentialRef: " " }).ok,
    ).toBe(false);
  });

  it("rejects unknown ops and non-object payloads", () => {
    expect(validateHostTaskOp("task/exec", {})).toEqual({ ok: false, error: "unknown-op" });
    expect(validateHostTaskOp("task/cancel", "nope").ok).toBe(false);
    expect(validateHostTaskOp("task/approve", {})).toEqual({ ok: true });
  });

  it("validates draft/permission ops fail-closed (S6 batch 2 follow-up P1)", () => {
    expect(validateHostTaskOp("task/saveDraft", { sessionId: "main", text: "草稿" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/saveDraft", { sessionId: "main", text: "草稿", references: [{ kind: "file", path: "a.ts" }], skillSource: "review" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/saveDraft", { sessionId: "", text: "草稿" }).ok).toBe(false);
    expect(validateHostTaskOp("task/saveDraft", { sessionId: "main" }).ok).toBe(false);
    expect(validateHostTaskOp("task/saveDraft", { sessionId: "main", text: "x", references: "nope" }).ok).toBe(false);
    expect(validateHostTaskOp("task/clearDraft", { sessionId: "main" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/clearDraft", { sessionId: "" }).ok).toBe(false);
    expect(validateHostTaskOp("task/setPermission", { sessionId: "main", permission: "read" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/setPermission", { sessionId: "main", permission: "owner" }).ok).toBe(false);
    expect(validateHostTaskOp("task/setPermission", { sessionId: "main" }).ok).toBe(false);
  });
});

describe("S6 batch 2: send-record refs and draft-tolerant store", () => {
  it("accepts verbatim references/skillSource and rejects malformed shapes", () => {
    expect(
      validateHostTaskOp("task/sendMessage", {
        sessionId: "main",
        text: "hi",
        references: [{ kind: "file", path: "a.ts" }],
        skillSource: "review",
      }),
    ).toEqual({ ok: true });
    expect(
      validateHostTaskOp("task/sendMessage", { sessionId: "main", text: "hi", references: "nope" }).ok,
    ).toBe(false);
    expect(
      validateHostTaskOp("task/sendMessage", { sessionId: "main", text: "hi", skillSource: " " }).ok,
    ).toBe(false);
  });
});

describe("S6 BLOCK fix: buildToolPlannerSpec pure dispatch (host.ts mirror)", () => {
  it("echo maps the gated tool/target/version; deny forces /etc/passwd", () => {
    expect(
      buildToolPlannerSpec({ tool: "exec.run", target: "/tmp/t/run.sh", contentVersion: "v3", toolPlan: "echo" }),
    ).toEqual({ ok: true, mode: "echo", tool: "exec.run", target: "/tmp/t/run.sh", contentVersion: "v3" });
    expect(buildToolPlannerSpec({ tool: "exec.run", toolPlan: "deny" })).toEqual({
      ok: true,
      mode: "deny",
      tool: "exec.run",
      target: "/etc/passwd",
      contentVersion: "v1",
    });
    expect(buildToolPlannerSpec({})).toEqual({ ok: true, mode: "none" });
  });

  it("fail-closes toolPlan without tool, echo without target, and ungated tools", () => {
    expect(buildToolPlannerSpec({ toolPlan: "echo", target: "/tmp/t/run.sh" }).ok).toBe(false);
    expect(buildToolPlannerSpec({ tool: "exec.run", toolPlan: "echo" }).ok).toBe(false);
    expect(buildToolPlannerSpec({ tool: "rm.all", target: "/tmp/t", toolPlan: "echo" }).ok).toBe(false);
    expect(buildToolPlannerSpec({ tool: "exec.run", target: "/tmp/t", toolPlan: "run" }).ok).toBe(false);
    expect(toolPlannerSpecForOp("task/cancel", {} as never)).toBeNull();
    // `host.ts` dispatch goes through the shared entry (not `buildToolPlannerSpec` directly).
    expect(toolPlannerSpecForHostDispatch({})).toEqual({ ok: true, mode: "none" });
    expect(toolPlannerSpecForHostDispatch({ toolPlan: "echo" }).ok).toBe(false);
  });
});

describe("S6 batch 3: scripted tool plan rides sendMessage fail-closed", () => {
  it("accepts a gated tool plan and rejects malformed shapes", () => {
    expect(
      validateHostTaskOp("task/sendMessage", {
        sessionId: "main",
        text: "hi",
        tool: "exec.run",
        target: "/tmp/t/task-abcdef12/run.sh",
        contentVersion: "v3",
        toolPlan: "echo",
      }),
    ).toEqual({ ok: true });
    expect(
      validateHostTaskOp("task/sendMessage", { sessionId: "main", text: "hi", tool: " " }).ok,
    ).toBe(false);
    expect(
      validateHostTaskOp("task/sendMessage", { sessionId: "main", text: "hi", target: " " }).ok,
    ).toBe(false);
    expect(
      validateHostTaskOp("task/sendMessage", { sessionId: "main", text: "hi", contentVersion: " " }).ok,
    ).toBe(false);
    expect(
      validateHostTaskOp("task/sendMessage", { sessionId: "main", text: "hi", toolPlan: "run" }).ok,
    ).toBe(false);
    // Dual-layer parity: sender-side `validateHostTaskOp` enforces the same
    // `toolPlan -> tool/target` rule Host dispatch runs, so a combo the Host
    // would reject fails closed early instead of forwarding-then-rejecting.
    expect(
      validateHostTaskOp("task/sendMessage", { sessionId: "main", text: "hi", toolPlan: "echo" }).ok,
    ).toBe(false);
    expect(
      validateHostTaskOp("task/sendMessage", {
        sessionId: "main",
        text: "hi",
        tool: "exec.run",
        toolPlan: "echo",
      }).ok,
    ).toBe(false);
    expect(
      validateHostTaskOp("task/sendMessage", {
        sessionId: "main",
        text: "hi",
        tool: "exec.run",
        target: "/tmp/t/run.sh",
        toolPlan: "echo",
      }),
    ).toEqual({ ok: true });
  });
});
