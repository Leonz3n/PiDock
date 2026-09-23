import { describe, expect, it } from "vitest";
import { boundWorkspaceId, resolveBrowserLogSession, buildHostEnv, buildToolPlannerSpec, classifyControlCaller, DEFAULT_WORKSPACE_ID, routeHostTask, routeTaskBinding, toolPlannerSpecForHostDispatch, toolPlannerSpecForOp, validateHostTaskOp } from "./host-guards.js";

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

// [PiDock 09] (#11) write-coordination read: no caller-chosen input, so the
// guard only rejects a present-but-malformed payload.
describe("session states op", () => {
  it("accepts an absent payload and an empty object, rejects anything else", () => {
    expect(validateHostTaskOp("task/sessionStates", undefined)).toEqual({ ok: true });
    expect(validateHostTaskOp("task/sessionStates", {})).toEqual({ ok: true });
    expect(validateHostTaskOp("task/sessionStates", "nope").ok).toBe(false);
    expect(validateHostTaskOp("task/sessionStates", []).ok).toBe(false);
  });
});

// [PiDock 04] (#7) service ops ride the same `host/task` envelope with
// envelope-shape guards (semantic validation runs Host-side in
// service-runtime.ts via host.ts dispatch).
describe("service ops", () => {
  it("accepts well-formed service envelopes and rejects missing ids", () => {
    expect(
      validateHostTaskOp("task/registerService", {
        serviceId: "saas-web",
        descriptor: { name: "saas-web" },
        layers: {},
        templateVersion: "v12",
      }),
    ).toEqual({ ok: true });
    expect(validateHostTaskOp("task/registerService", { serviceId: " " }).ok).toBe(false);
    expect(validateHostTaskOp("task/planServiceStart", { serviceId: "saas-web" }).ok).toBe(true);
    expect(validateHostTaskOp("task/planServiceStart", {}).ok).toBe(false);
    expect(validateHostTaskOp("task/controlService", { serviceId: "saas-web", action: "start" }).ok).toBe(true);
    expect(validateHostTaskOp("task/controlService", { serviceId: "saas-web", action: "launch" }).ok).toBe(false);
    expect(validateHostTaskOp("task/serviceStatus", { serviceId: "saas-web" }).ok).toBe(true);
    expect(validateHostTaskOp("task/serviceLog", { serviceId: "saas-web" }).ok).toBe(true);
    expect(validateHostTaskOp("task/serviceStatus", {}).ok).toBe(false);
  });
});

// [PiDock 05] (#10) multi-service topology ops: envelope shape only here;
// unit/repo rules, port allocation, binding conflicts and start-group
// derivation run Host-side in `TaskServiceTopology.setPlan`.
describe("service group ops", () => {
  const units = [{ unitId: "front:saas-web", serviceId: "saas-web", name: "saas-web", location: "local" }];
  it("accepts a well-formed plan request and rejects malformed units/ports", () => {
    expect(validateHostTaskOp("task/planServiceGroup", { units })).toEqual({ ok: true });
    expect(
      validateHostTaskOp("task/planServiceGroup", {
        units,
        selectedRepoDirs: ["front"],
        dependencies: [{ from: "a", to: "b", kind: "prestart" }],
        runTypes: { a: "prepare" },
        requests: [{ unitId: "a", port: 5173 }],
        reservations: [{ port: 9001, owner: "task", taskId: "t", unitId: "u", serviceId: "s", note: "n" }],
        rules: [{ key: "X_URL", unitId: "a", kind: "url", template: "http://127.0.0.1:${port}" }],
        layers: { repoDefaults: [], shared: [], privateEntries: [], task: [{ key: "X", value: "1", secret: false }] },
        environment: "testing",
        externalResources: [{ resourceId: "res-1", name: "queue", kind: "dtm-callback" }],
      }),
    ).toEqual({ ok: true });
    expect(validateHostTaskOp("task/planServiceGroup", {}).ok).toBe(false);
    expect(validateHostTaskOp("task/planServiceGroup", "nope").ok).toBe(false);
    expect(validateHostTaskOp("task/planServiceGroup", { units: [{}] }).ok).toBe(false);
    expect(
      validateHostTaskOp("task/planServiceGroup", { units: [{ ...units[0], location: "cloud" }] }).ok,
    ).toBe(false);
    expect(validateHostTaskOp("task/planServiceGroup", { units, requests: [{ unitId: "a", port: "5173" }] }).ok).toBe(false);
    expect(validateHostTaskOp("task/planServiceGroup", { units, dependencies: [{ from: "a", to: "b" }] }).ok).toBe(false);
    expect(validateHostTaskOp("task/planServiceGroup", { units, rules: [{ key: "X", unitId: "a", kind: "udp" }] }).ok).toBe(false);
    expect(validateHostTaskOp("task/planServiceGroup", { units, reservations: [{ port: 1, owner: "someone" }] }).ok).toBe(false);
    expect(validateHostTaskOp("task/planServiceGroup", { units, layers: { repoDefaults: [{ key: "A" }] } }).ok).toBe(false);
    expect(validateHostTaskOp("task/planServiceGroup", { units, runTypes: { a: "whenever" } }).ok).toBe(false);
    expect(validateHostTaskOp("task/planServiceGroup", { units, externalResources: [{ resourceId: "r", name: "n", kind: "ftp" }] }).ok).toBe(false);
  });
  it("accepts the read ops and rejects a blank stop-scope instance", () => {
    expect(validateHostTaskOp("task/serviceRunRecords", {})).toEqual({ ok: true });
    expect(validateHostTaskOp("task/serviceRunRecords", undefined)).toEqual({ ok: true });
    expect(validateHostTaskOp("task/serviceRunRecords", "nope").ok).toBe(false);
    expect(validateHostTaskOp("task/serviceStopScope", {})).toEqual({ ok: true });
    expect(validateHostTaskOp("task/serviceStopScope", { instanceId: "task-a/invoice" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/serviceStopScope", { instanceId: " " }).ok).toBe(false);
  });
});

// [PiDock 08] (#14) protocol ops: envelope shape only here; the protocol repo
// / consumer rules and the task-scoped plan paths run Host-side in
// `TaskProtocolBinding`, and generation results are caller observations.
describe("protocol ops", () => {
  const consumers = [
    {
      consumerId: "invoice",
      name: "invoice-service",
      repoDir: "/data/tasks/task-a/invoice-service",
      language: "go",
      releaseDependency: "github.com/shipber/apis v0.0.69",
    },
  ];
  it("accepts a well-formed plan and rejects malformed protocol/consumer/step shapes", () => {
    expect(
      validateHostTaskOp("task/planProtocol", {
        protocol: { repoDir: "/data/tasks/task-a/apis", goGenDir: "/data/tasks/task-a/apis/gen/go", tsGenDir: "/data/tasks/task-a/apis/gen/ts" },
        mode: "local",
        steps: [{ kind: "generate", program: "make", args: ["generate"], cwd: "/data/tasks/task-a/apis", note: "生成" }],
        consumers,
        acknowledged: ["invoice"],
      }),
    ).toEqual({ ok: true });
    expect(validateHostTaskOp("task/planProtocol", {}).ok).toBe(false);
    expect(validateHostTaskOp("task/planProtocol", "nope").ok).toBe(false);
    expect(validateHostTaskOp("task/planProtocol", { protocol: consumers[0], mode: "local", consumers }).ok).toBe(false);
    // An empty consumer list passes the envelope check and is refused Host-side
    // (`empty-consumers` in `TaskProtocolBinding.setPlan`).
    expect(
      validateHostTaskOp("task/planProtocol", { protocol: { repoDir: "/a", goGenDir: "/a/go", tsGenDir: "/a/ts" }, mode: "local", consumers: [] }),
    ).toEqual({ ok: true });
    expect(
      validateHostTaskOp("task/planProtocol", {
        protocol: { repoDir: "/a", goGenDir: "/a/go", tsGenDir: "/a/ts" },
        mode: "local",
        consumers: [{ ...consumers[0], language: "rust" }],
      }).ok,
    ).toBe(false);
    expect(
      validateHostTaskOp("task/planProtocol", {
        protocol: { repoDir: "/a", goGenDir: "/a/go", tsGenDir: "/a/ts" },
        mode: "local",
        steps: [{ kind: "deploy", program: "make", args: [], cwd: "/a" }],
        consumers,
      }).ok,
    ).toBe(false);
    expect(
      validateHostTaskOp("task/planProtocol", {
        protocol: { repoDir: "/a", goGenDir: "/a/go", tsGenDir: "/a/ts" },
        mode: "local",
        steps: [{ kind: "generate", program: "make", args: [1], cwd: "/a" }],
        consumers,
      }).ok,
    ).toBe(false);
    expect(
      validateHostTaskOp("task/planProtocol", {
        protocol: { repoDir: "/a", goGenDir: "/a/go", tsGenDir: "/a/ts" },
        mode: "local",
        consumers,
        acknowledged: [1],
      }).ok,
    ).toBe(false);
    expect(validateHostTaskOp("task/planProtocol", { protocol: { repoDir: "/a", goGenDir: "/a/go", tsGenDir: "/a/ts" }, mode: "debug", consumers }).ok).toBe(false);
  });

  it("accepts the protocol state read and validates recorded observations", () => {
    expect(validateHostTaskOp("task/protocolState", {})).toEqual({ ok: true });
    expect(validateHostTaskOp("task/protocolState", undefined)).toEqual({ ok: true });
    expect(validateHostTaskOp("task/protocolState", "nope").ok).toBe(false);
    expect(
      validateHostTaskOp("task/recordProtocolRun", {
        generatedVersion: "gen-4",
        ok: true,
        note: "make generate + postprocess",
        toolchain: { platform: "darwin-arm64", probe: { buf: { ok: true, version: "1.2.3" } } },
        depsInstalled: [{ consumerId: "invoice", installed: true }],
        resolutions: [{ consumerId: "invoice", path: "/data/tasks/task-a/apis/gen/go/pkg", version: "gen-4" }],
        runtimeReachable: { ok: false, detail: "远程依赖未检查" },
      }),
    ).toEqual({ ok: true });
    expect(validateHostTaskOp("task/recordProtocolRun", { generatedVersion: "gen-4" }).ok).toBe(false);
    expect(validateHostTaskOp("task/recordProtocolRun", { generatedVersion: "gen-4", ok: "yes" }).ok).toBe(false);
    expect(validateHostTaskOp("task/recordProtocolRun", { generatedVersion: "gen-4", ok: true, note: 1 }).ok).toBe(false);
    expect(validateHostTaskOp("task/recordProtocolRun", { generatedVersion: "gen-4", ok: true, toolchain: { platform: 1 } }).ok).toBe(false);
    expect(
      validateHostTaskOp("task/recordProtocolRun", { generatedVersion: "gen-4", ok: true, toolchain: { platform: "darwin-arm64", probe: { buf: { ok: "yes" } } } }).ok,
    ).toBe(false);
    expect(validateHostTaskOp("task/recordProtocolRun", { generatedVersion: "gen-4", ok: true, depsInstalled: [{ consumerId: "invoice" }] }).ok).toBe(false);
    expect(validateHostTaskOp("task/recordProtocolRun", { generatedVersion: "gen-4", ok: true, resolutions: [{ consumerId: "invoice" }] }).ok).toBe(false);
    expect(validateHostTaskOp("task/recordProtocolRun", { generatedVersion: "gen-4", ok: true, runtimeReachable: { ok: true } }).ok).toBe(false);
  });
});

// [PiDock 06] (#8) task browser: envelope shape only here; page
// ownership, the navigation allowlist, takeover state and the agent gate
// run on the authoritative side (`browser-gateway.ts` / `browser-control.ts`).
describe("browser op envelopes", () => {
  it("accepts well-formed browser envelopes", () => {
    expect(validateHostTaskOp("task/browserAction", { action: "page/state", page: { pageId: "page-1" } })).toEqual({ ok: true });
    expect(
      validateHostTaskOp("task/browserAction", {
        action: "page/navigate",
        page: { taskId: "task-a1f92c3d", pageId: "page-1", webContentsId: 11 },
        params: { url: "http://localhost:5173/checkout" },
        sessionId: "main",
        approvalId: "approval-1",
      }),
    ).toEqual({ ok: true });
    expect(validateHostTaskOp("task/browserAction", { action: "marker/create", page: { pageId: "page-1" }, targetSessionId: "main" })).toEqual({ ok: true });
  });

  it("rejects unknown actions and malformed envelopes", () => {
    expect(validateHostTaskOp("task/browserAction", { action: "page/teleport" }).ok).toBe(false);
    expect(validateHostTaskOp("task/browserAction", {}).ok).toBe(false);
    expect(validateHostTaskOp("task/browserAction", "nope").ok).toBe(false);
    expect(validateHostTaskOp("task/browserAction", { action: "page/state", page: "page-1" }).ok).toBe(false);
    expect(validateHostTaskOp("task/browserAction", { action: "page/state", page: { pageId: "" } }).ok).toBe(false);
    expect(validateHostTaskOp("task/browserAction", { action: "page/state", page: { pageId: "page-1" }, sessionId: " " }).ok).toBe(false);
    expect(validateHostTaskOp("task/browserAction", { action: "page/state", page: { pageId: "page-1" }, targetSessionId: "" }).ok).toBe(false);
    expect(validateHostTaskOp("task/browserAction", { action: "page/state", page: { pageId: "page-1" }, params: [] }).ok).toBe(false);
  });
});

// BLOCK P0-2: a session-less control call is human UI only with main's
// sender-bound attestation; without it the caller must name its session,
// so an agent cannot drop `sessionId` to reach the ungated human path.
describe("service-control caller classification", () => {
  const attested = { kind: "shell-ui", senderWebContentsId: 42 };
  it("routes a payload sessionId to agent control regardless of actor claims", () => {
    expect(classifyControlCaller({ sessionId: "main", origin: attested })).toEqual({
      ok: true,
      kind: "agent",
      sessionId: "main",
    });
    const agent = classifyControlCaller({ sessionId: "main", label: "用户显式操作" });
    expect(agent.ok && agent.kind).toBe("agent");
    expect(classifyControlCaller({ sessionId: "" }).ok).toBe(false);
    expect(classifyControlCaller({ sessionId: 7 }).ok).toBe(false);
  });
  it("rejects a session-less call without the main-stamped shell-ui origin", () => {
    const spoof = classifyControlCaller({ label: "用户显式操作" });
    expect(spoof.ok).toBe(false);
    expect(classifyControlCaller({ origin: { kind: "shell-ui", senderWebContentsId: "42" } }).ok).toBe(false);
    expect(classifyControlCaller({ origin: { kind: "agent-tool", senderWebContentsId: 42 } }).ok).toBe(false);
    expect(classifyControlCaller({ origin: 42 }).ok).toBe(false);
  });
  it("classifies an attested session-less call as human UI control with a label", () => {
    expect(classifyControlCaller({ origin: attested })).toEqual({
      ok: true,
      kind: "human",
      label: "用户显式操作",
    });
    expect(classifyControlCaller({ origin: attested, label: "RuntimePanel 启动" })).toEqual({
      ok: true,
      kind: "human",
      label: "RuntimePanel 启动",
    });
    expect(classifyControlCaller({ origin: attested, label: "  " })).toEqual({
      ok: true,
      kind: "human",
      label: "用户显式操作",
    });
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
    expect(validateHostTaskOp("task/saveDraft", { sessionId: "main", text: "草稿", references: [{ id: "ref-1", kind: "file", label: "front-monorepo/src/api.ts", detail: "任务代码引用", sourceId: "front-monorepo", sourceKind: "worktree", relativePath: "src/api.ts", version: "abc123" }], skillSource: "review" })).toEqual({ ok: true });
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

describe("S6 batch 2 + [PiDock 13] (#16): send-record refs and draft-tolerant store", () => {
  it("accepts a well-formed reference/skillSource and rejects malformed shapes", () => {
    expect(
      validateHostTaskOp("task/sendMessage", {
        sessionId: "main",
        text: "hi",
        references: [
          {
            id: "ref-1",
            kind: "file",
            label: "front-monorepo/src/api.ts",
            detail: "front-monorepo · 任务代码引用",
            taskId: "task-a",
            sourceId: "front-monorepo",
            sourceKind: "worktree",
            relativePath: "src/api.ts",
            version: "abc123",
          },
        ],
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

  it("fails closed on forged reference provenance before it can reach the session", () => {
    const base = {
      id: "ref-1",
      kind: "file",
      label: "front-monorepo/src/api.ts",
      detail: "任务代码引用",
      sourceId: "front-monorepo",
      sourceKind: "worktree",
      relativePath: "src/api.ts",
      version: "abc123",
    };
    const send = (references: unknown[]) => validateHostTaskOp("task/sendMessage", { sessionId: "main", text: "hi", references });
    expect(send([{ kind: "file", path: "a.ts" }]).ok).toBe(false);
    expect(send([{ ...base, relativePath: "../outside.ts" }]).ok).toBe(false);
    expect(send([{ ...base, kind: "command" }]).ok).toBe(false);
    expect(send([{ ...base, sourceKind: "plain-dir", version: "abc123" }]).ok).toBe(false);
    expect(send([{ ...base, sourceKind: "plain-dir", version: null }]).ok).toBe(true);
    // A restored draft carries the same rules.
    const draft = (references: unknown[]) => validateHostTaskOp("task/saveDraft", { sessionId: "main", text: "hi", references });
    expect(draft([{ ...base, relativePath: "/etc/passwd" }]).ok).toBe(false);
    expect(draft([base]).ok).toBe(true);
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

describe("#6 append + probe guards (S2)", () => {
  it("shape-checks provision repoSelections/fetchedCommits/plainDirs", () => {
    expect(
      validateHostTaskOp("task/provision", {
        name: "多仓",
        dirId: "task-abcdef12",
        remoteBranch: "main",
        fetchedCommit: "a5a4a0d1234",
        repoSelections: [
          { repoDir: "frontend", remote: "origin", remoteBranch: "main", mainCheckoutDir: "/src/frontend" },
        ],
        fetchedCommits: { frontend: "a5a4a0d1234" },
        plainDirs: [{ directoryId: "notes-1", sourcePath: "/data/notes" }],
      }),
    ).toEqual({ ok: true });
    expect(
      validateHostTaskOp("task/provision", {
        name: "多仓",
        dirId: "task-abcdef12",
        remoteBranch: "main",
        fetchedCommit: "a5a4a0d1234",
        repoSelections: [{ repoDir: "frontend" }],
      }).ok,
    ).toBe(false);
    expect(
      validateHostTaskOp("task/provision", {
        name: "多仓",
        dirId: "task-abcdef12",
        remoteBranch: "main",
        fetchedCommit: "a5a4a0d1234",
        plainDirs: [{ directoryId: "notes-1" }],
      }).ok,
    ).toBe(false);
  });

  it("gates appendRepos and probeLink payloads", () => {
    expect(
      validateHostTaskOp("task/appendRepos", {
        repoSelections: [],
        fetchedCommits: {},
        takenPaths: [],
        branchesInUse: [],
      }),
    ).toEqual({ ok: true });
    expect(validateHostTaskOp("task/appendRepos", { repoSelections: [] }).ok).toBe(false);
    // Caller-scanned conflict inputs are required (never silently `[]`):
    // omitting them fails closed so the conflict gate cannot be skipped.
    expect(
      validateHostTaskOp("task/appendRepos", { repoSelections: [], fetchedCommits: {} }).ok,
    ).toBe(false);
    expect(validateHostTaskOp("task/probeLink", { sourcePath: "/data/notes" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/probeLink", {}).ok).toBe(false);
  });
});

// [PiDock 06] (#8): where a user's browser marker is logged.
describe("browser log session", () => {
  it("names the requested session only when it exists", () => {
    expect(resolveBrowserLogSession("main", ["main", "review"])).toEqual({ ok: true, sessionId: "main" });
    expect(resolveBrowserLogSession("review", ["main", "review"])).toEqual({ ok: true, sessionId: "review" });
    const missing = resolveBrowserLogSession("typo", ["main"]);
    expect(missing.ok).toBe(false);
    expect(missing.ok === false && missing.error).toContain("unknown-session");
  });

  it("falls back to the task's first session, then `main`", () => {
    expect(resolveBrowserLogSession("", ["only"])).toEqual({ ok: true, sessionId: "only" });
    expect(resolveBrowserLogSession("", [])).toEqual({ ok: true, sessionId: "main" });
  });
});

// [PiDock 11] (#9): provider/model/context op shapes. Semantics (profile rules,
// switch gate) run Host-side; the sender side fails closed on a malformed shape
// so a bad payload never reaches the Host dispatch.
describe("provider session ops", () => {
  const catalog = [{ id: "provider-anthropic", name: "Anthropic 官方", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", enabled: true, models: [{ id: "claude-sonnet-4-5", contextWindow: 200 }] }];

  it("accepts a provider catalog only as an array of objects", () => {
    expect(validateHostTaskOp("task/setProviderCatalog", { catalog })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/setProviderCatalog", { catalog: ["provider-anthropic"] }).ok).toBe(false);
    expect(validateHostTaskOp("task/setProviderCatalog", {}).ok).toBe(false);
  });

  it("requires a session for the context reads and the switch", () => {
    expect(validateHostTaskOp("task/sessionContext", { sessionId: "main" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/sessionContext", { sessionId: "main", catalog })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/sessionContext", {}).ok).toBe(false);
    expect(validateHostTaskOp("task/sessionContext", { sessionId: "main", catalog: [1] }).ok).toBe(false);
    expect(validateHostTaskOp("task/compactSession", { sessionId: "main" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/compactSession", { sessionId: "  " }).ok).toBe(false);
  });

  it("requires session/provider/model on a switch and rejects an unknown reason", () => {
    expect(validateHostTaskOp("task/setSessionModel", { sessionId: "main", providerId: "p", model: "m" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/setSessionModel", { sessionId: "main", providerId: "p", model: "m", reason: "agent-switch" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/setSessionModel", { sessionId: "main", providerId: "p", model: "m", reason: "auto" }).ok).toBe(false);
    expect(validateHostTaskOp("task/setSessionModel", { sessionId: "main", model: "m" }).ok).toBe(false);
    expect(validateHostTaskOp("task/setSessionModel", { sessionId: "main", providerId: "p", model: "" }).ok).toBe(false);
  });

  it("accepts an empty reasoning level as the clear request, but not a non-string", () => {
    expect(validateHostTaskOp("task/setSessionThinking", { sessionId: "main", level: "" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/setSessionThinking", { sessionId: "main", level: "high" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/setSessionThinking", { sessionId: "main" }).ok).toBe(false);
    expect(validateHostTaskOp("task/setSessionThinking", { sessionId: "main", level: 3 }).ok).toBe(false);
  });
});

// [PiDock 12] #12 usage reads/cleanup: the guard checks the filter/scope
// envelope; the ledger rules themselves are validated in usage-ledger.test.ts
// and applied Host-side.
describe("usage ops", () => {
  it("accepts an absent/empty usage filter and rejects unusable values", () => {
    expect(validateHostTaskOp("task/usageRecords", undefined)).toEqual({ ok: true });
    expect(validateHostTaskOp("task/usageRecords", {})).toEqual({ ok: true });
    for (const payload of [
      { sessionId: "main", providerId: "provider-openai", model: "gpt-5", from: "2026-09-01", to: "2026-09-30", kind: "compaction", groupBy: "day" },
    ]) {
      expect(validateHostTaskOp("task/usageRecords", payload)).toEqual({ ok: true });
    }
    expect(validateHostTaskOp("task/usageRecords", "nope").ok).toBe(false);
    expect(validateHostTaskOp("task/usageRecords", { sessionId: " " }).ok).toBe(false);
    expect(validateHostTaskOp("task/usageRecords", { from: 7 }).ok).toBe(false);
    expect(validateHostTaskOp("task/usageRecords", { kind: "live" }).ok).toBe(false);
    expect(validateHostTaskOp("task/usageRecords", { groupBy: "billing" }).ok).toBe(false);
  });

  it("accepts each cleanup scope shape and rejects an unknown or half-shaped one", () => {
    expect(validateHostTaskOp("task/clearUsage", { scope: { kind: "all" } })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/clearUsage", { scope: { kind: "session", sessionId: "review" } })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/clearUsage", { scope: { kind: "before", before: "2026-09-01" } })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/clearUsage", { scope: { kind: "session" } }).ok).toBe(false);
    expect(validateHostTaskOp("task/clearUsage", { scope: { kind: "before", before: " " } }).ok).toBe(false);
    expect(validateHostTaskOp("task/clearUsage", { scope: { kind: "everything" } }).ok).toBe(false);
    expect(validateHostTaskOp("task/clearUsage", { scope: "all" }).ok).toBe(false);
    expect(validateHostTaskOp("task/clearUsage", {}).ok).toBe(false);
  });
});

// [PiDock 10] #15 file/terminal ops: the guard checks the envelope shape; the
// root rules, path containment, bounds and masking are Host-side
// (`host/workspace-files.ts`, `main/workspace-files.ts`) and the terminal gate
// order is `host/terminal-control.ts`.
describe("file and terminal ops", () => {
  it("requires a root id for every file read and a relative path for a preview", () => {
    for (const op of ["task/fileTree", "task/fileDiff", "task/deliveryInfo"] as const) {
      expect(validateHostTaskOp(op, { rootId: "front-monorepo" })).toEqual({ ok: true });
      expect(validateHostTaskOp(op, { rootId: "front-monorepo", relative: "src/a.ts" })).toEqual({ ok: true });
      expect(validateHostTaskOp(op, {}).ok).toBe(false);
      expect(validateHostTaskOp(op, { rootId: " " }).ok).toBe(false);
      expect(validateHostTaskOp(op, { rootId: "r", relative: 7 }).ok).toBe(false);
    }
    expect(validateHostTaskOp("task/filePreview", { rootId: "r", relative: "a.ts" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/filePreview", { rootId: "r" }).ok).toBe(false);
    expect(validateHostTaskOp("task/filePreview", { rootId: "r", relative: "" }).ok).toBe(false);
    expect(validateHostTaskOp("task/fileRoots", undefined)).toEqual({ ok: true });
    expect(validateHostTaskOp("task/fileRoots", "nope").ok).toBe(false);
  });

  it("requires an instance id, a program, a root and env layers for a terminal plan", () => {
    const layers = { repoDefaults: [], shared: [], privateEntries: [], task: [] };
    expect(validateHostTaskOp("task/planTerminal", { instanceId: "term-1", rootId: "r", program: "bash", layers })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/planTerminal", { instanceId: "term-1", rootId: "r", program: "bash", layers, args: ["-l"], cols: 100, rows: 30 })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/planTerminal", { instanceId: "", rootId: "r", program: "bash", layers }).ok).toBe(false);
    expect(validateHostTaskOp("task/planTerminal", { instanceId: "term-1", rootId: "r", layers }).ok).toBe(false);
    expect(validateHostTaskOp("task/planTerminal", { instanceId: "term-1", rootId: "r", program: "bash" }).ok).toBe(false);
    expect(validateHostTaskOp("task/planTerminal", { instanceId: "term-1", rootId: " ", program: "bash", layers }).ok).toBe(false);
    expect(validateHostTaskOp("task/planTerminal", { instanceId: "term-1", rootId: "r", program: "bash", layers, args: [1] }).ok).toBe(false);
    expect(validateHostTaskOp("task/planTerminal", { instanceId: "term-1", rootId: "r", program: "bash", layers, cols: 1.5 }).ok).toBe(false);
  });

  it("requires an action/instance for terminal control and a start payload when starting", () => {
    const layers = { repoDefaults: [], shared: [], privateEntries: [], task: [] };
    expect(validateHostTaskOp("task/terminalControl", { instanceId: "term-1", action: "stop" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/terminalControl", { instanceId: "term-1", action: "start", rootId: "r", program: "bash", layers })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/terminalControl", { instanceId: "term-1", action: "stop", sessionId: "main" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/terminalControl", { instanceId: "term-1", action: "kill" }).ok).toBe(false);
    expect(validateHostTaskOp("task/terminalControl", { action: "stop" }).ok).toBe(false);
    expect(validateHostTaskOp("task/terminalControl", { instanceId: "term-1", action: "start" }).ok).toBe(false);
    expect(validateHostTaskOp("task/terminalControl", { instanceId: "term-1", action: "start", rootId: "r", program: "bash" }).ok).toBe(false);
    expect(validateHostTaskOp("task/terminalControl", { instanceId: "term-1", action: "stop", sessionId: " " }).ok).toBe(false);
  });

  it("requires an instance id for terminal history and bounds the limit", () => {
    expect(validateHostTaskOp("task/terminalHistory", { instanceId: "term-1" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/terminalHistory", { instanceId: "term-1", limit: 20 })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/terminalHistory", {}).ok).toBe(false);
    expect(validateHostTaskOp("task/terminalHistory", { instanceId: "term-1", limit: 0 }).ok).toBe(false);
    expect(validateHostTaskOp("task/terminalHistory", { instanceId: "term-1", limit: "20" }).ok).toBe(false);
    expect(validateHostTaskOp("task/terminalState", undefined)).toEqual({ ok: true });
  });

  it("[PiDock 14] (#17) accepts the lifecycle reads and the archive/restore shape", () => {
    expect(validateHostTaskOp("task/lifecycleState", undefined)).toEqual({ ok: true });
    expect(validateHostTaskOp("task/lifecycleState", {})).toEqual({ ok: true });
    expect(validateHostTaskOp("task/lifecycleState", [])).toEqual({ ok: false, error: "invalid-payload: task/lifecycleState payload must be an object" });
    expect(validateHostTaskOp("task/archive", undefined)).toEqual({ ok: true });
    expect(validateHostTaskOp("task/restore", { label: "用户显式操作" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/archive", { label: 7 }).ok).toBe(false);
  });

  it("[PiDock 14] (#17) accepts the explicit-quit shape", () => {
    expect(validateHostTaskOp("task/quit", undefined)).toEqual({ ok: true });
    expect(validateHostTaskOp("task/quit", { label: "应用明确退出" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/quit", { label: 7 }).ok).toBe(false);
    expect(validateHostTaskOp("task/quit", []).ok).toBe(false);
  });

  it("[PiDock 14] (#17) requires an export selection for cleanup and a non-empty keep root", () => {
    const selection = { exportSessions: true, exportDrafts: false, exportUsage: true };
    expect(validateHostTaskOp("task/cleanupPreview", { selection })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/runCleanup", { selection, keepRoot: "/Users/dev/kept", label: "用户显式操作" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/cleanupPreview", {}).ok).toBe(false);
    expect(validateHostTaskOp("task/cleanupPreview", { selection: { exportSessions: true } }).ok).toBe(false);
    expect(validateHostTaskOp("task/cleanupPreview", { selection: { exportSessions: true, exportDrafts: false, exportUsage: "yes" } }).ok).toBe(false);
    expect(validateHostTaskOp("task/runCleanup", { selection, keepRoot: "  " }).ok).toBe(false);
    expect(validateHostTaskOp("task/runCleanup", { selection, label: 7 }).ok).toBe(false);
  });
  it("[PiDock 17] (#19) requires a session id for the execution state read", () => {
    expect(validateHostTaskOp("task/executionState", { sessionId: "main" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/executionState", undefined).ok).toBe(false);
    expect(validateHostTaskOp("task/executionState", {}).ok).toBe(false);
    expect(validateHostTaskOp("task/executionState", { sessionId: " " }).ok).toBe(false);
    // The Host reads its own service observations, so a caller-supplied
    // `services` field is not part of the contract (nothing validates it).
    expect(validateHostTaskOp("task/executionState", { sessionId: "main", services: {} })).toEqual({ ok: true });
  });

  it("[PiDock 17] (#19) accepts the attention reads and requires the ids to clear", () => {
    expect(validateHostTaskOp("task/attention", {})).toEqual({ ok: true });
    expect(validateHostTaskOp("task/attention", undefined).ok).toBe(false);
    expect(validateHostTaskOp("task/markAttentionRead", { itemIds: ["attention-completed-unread-release-exec-1"] })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/markAttentionRead", { itemIds: [] }).ok).toBe(false);
    expect(validateHostTaskOp("task/markAttentionRead", {}).ok).toBe(false);
    expect(validateHostTaskOp("task/markAttentionRead", { itemIds: [7] }).ok).toBe(false);
  });

  it("[PiDock 18] (#20) shape-checks the schedule config and its reads", () => {
    const config = {
      name: "每日巡检",
      ruleText: "每日 09:15",
      timezone: "Asia/Shanghai",
      prompt: "检查风险",
      providerId: "provider-anthropic",
      model: "claude-sonnet",
      permission: "default",
    };
    expect(validateHostTaskOp("task/scheduleList", {})).toEqual({ ok: true });
    expect(validateHostTaskOp("task/scheduleList", undefined)).toEqual({ ok: true });
    expect(validateHostTaskOp("task/scheduleList", []).ok).toBe(false);
    expect(validateHostTaskOp("task/scheduleTemplates", {})).toEqual({ ok: true });
    expect(validateHostTaskOp("task/scheduleEvaluate", {})).toEqual({ ok: true });
    expect(validateHostTaskOp("task/schedulePreview", { ruleText: "每日 09:15", timezone: "Asia/Shanghai" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/schedulePreview", { ruleText: "每日 09:15" }).ok).toBe(false);
    expect(validateHostTaskOp("task/schedulePreview", { ruleText: "每日 09:15", timezone: 7 }).ok).toBe(false);
    expect(validateHostTaskOp("task/scheduleSave", config)).toEqual({ ok: true });
    expect(validateHostTaskOp("task/scheduleSave", { ...config, scheduleId: "schedule-1", enabled: true })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/scheduleSave", { ...config, ruleText: "" }).ok).toBe(false);
    expect(validateHostTaskOp("task/scheduleSave", { ...config, enabled: "yes" }).ok).toBe(false);
    expect(validateHostTaskOp("task/scheduleSave", {}).ok).toBe(false);
    expect(validateHostTaskOp("task/scheduleApplyTemplate", { scheduleId: "schedule-1", templateId: "tl-standup" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/scheduleApplyTemplate", { scheduleId: "schedule-1" }).ok).toBe(false);
    expect(validateHostTaskOp("task/scheduleSetEnabled", { scheduleId: "schedule-1", enabled: false })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/scheduleSetEnabled", { scheduleId: "schedule-1" }).ok).toBe(false);
    expect(validateHostTaskOp("task/scheduleRemove", { scheduleId: "schedule-1" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/scheduleRemove", {}).ok).toBe(false);
    expect(validateHostTaskOp("task/scheduleRunNow", { scheduleId: "schedule-1", label: "用户显式操作" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/scheduleRunNow", { scheduleId: "" }).ok).toBe(false);
    expect(validateHostTaskOp("task/scheduleRuns", {})).toEqual({ ok: true });
    expect(validateHostTaskOp("task/scheduleRuns", { scheduleId: "schedule-1" })).toEqual({ ok: true });
    expect(validateHostTaskOp("task/scheduleRuns", { scheduleId: 7 }).ok).toBe(false);
  });
});
