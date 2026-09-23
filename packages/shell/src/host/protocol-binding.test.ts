import { describe, expect, it } from "vitest";
import { TaskProtocolBinding } from "./protocol-binding.js";
import type { ProtocolConsumer, ProtocolRepoRef } from "../main/protocol-binding.js";

const TASK_DIR = "/data/pidock/tasks/task-a1f92c3d";
const OTHER_TASK_DIR = "/data/pidock/tasks/task-b77e10aa";
const PROTOCOL: ProtocolRepoRef = {
  repoDir: `${TASK_DIR}/apis`,
  goGenDir: `${TASK_DIR}/apis/gen/go`,
  tsGenDir: `${TASK_DIR}/apis/gen/ts`,
};

const INVOICE: ProtocolConsumer = {
  consumerId: "invoice",
  name: "invoice-service",
  repoDir: `${TASK_DIR}/invoice-service`,
  language: "go",
  serviceId: "invoice-service",
  releaseDependency: "github.com/shipber/apis v0.0.69",
};

const SHIPMENT: ProtocolConsumer = {
  consumerId: "shipment",
  name: "shipment-service",
  repoDir: `${TASK_DIR}/shipment-service`,
  language: "go",
  serviceId: "shipment-service",
  releaseDependency: "github.com/shipber/apis v0.0.103",
};

const BFF: ProtocolConsumer = {
  consumerId: "bff",
  name: "saas-bff",
  repoDir: `${TASK_DIR}/front-monorepo`,
  language: "ts",
  serviceId: "saas-bff",
  releaseDependency: "@shipber/proto 0.0.108",
  linkScript: "proto:link-local",
  linkTarget: "saas-bff",
};

const STEPS = [
  { kind: "generate" as const, program: "make", args: ["generate"], cwd: PROTOCOL.repoDir, note: "生成" },
  { kind: "postprocess" as const, program: "pnpm", args: ["--filter", "@shipber/proto", "build"], cwd: PROTOCOL.repoDir, note: "后处理" },
];

function host(taskDir = TASK_DIR): TaskProtocolBinding {
  return new TaskProtocolBinding("task-a1f92c3d", taskDir, () => "2026-09-22T12:00:00.000Z");
}

function planLocal(binding: TaskProtocolBinding, consumers: ProtocolConsumer[], acknowledged: string[]) {
  return binding.setPlan({ protocol: PROTOCOL, mode: "local", steps: STEPS, consumers, acknowledged });
}

describe("[PiDock 08] Host protocol state starts on release dependencies", () => {
  it("keeps every consumer on its release dependency until local debug is chosen", () => {
    const state = host().setPlan({ protocol: PROTOCOL, mode: "release", consumers: [INVOICE, BFF] });
    expect(state.mode).toBe("release");
    expect(state.generation.runsGeneration).toBe(false);
    expect(state.consumers.map((consumer) => consumer.binding.kind)).toEqual(["release", "release"]);
    expect(state.consumers.every((consumer) => consumer.staleness.state === "ready")).toBe(true);
    expect(state.consumers[0]?.staleness.detail).toContain("v0.0.69");
    // Release mode never claims an artifact version.
    expect(state.generatedVersion).toBeNull();
    expect(state.diagnostics).toEqual([]);
  });

  it("refuses a consumer whose repository is outside this task", () => {
    const foreign: ProtocolConsumer = { ...INVOICE, repoDir: "/data/elsewhere/invoice-service" };
    expect(() => host().setPlan({ protocol: PROTOCOL, mode: "release", consumers: [foreign] })).toThrow(/invalid-consumer/);
  });

  it("refuses a protocol repository or generation directory outside this task", () => {
    const outsideRepo: ProtocolRepoRef = {
      repoDir: "/data/elsewhere/apis",
      goGenDir: "/data/elsewhere/apis/gen/go",
      tsGenDir: "/data/elsewhere/apis/gen/ts",
    };
    expect(() => host().setPlan({ protocol: outsideRepo, mode: "release", consumers: [INVOICE] })).toThrow(/invalid-protocol-repo/);
    expect(() =>
      host().setPlan({ protocol: { ...PROTOCOL, tsGenDir: "/data/elsewhere/apis/gen/ts" }, mode: "local", steps: STEPS, consumers: [INVOICE] }),
    ).toThrow(/invalid-protocol-repo/);
  });

  it("refuses the protocol repository as a consumer", () => {
    const self: ProtocolConsumer = { ...INVOICE, consumerId: "apis", name: "apis", repoDir: PROTOCOL.repoDir };
    expect(() => host().setPlan({ protocol: PROTOCOL, mode: "release", consumers: [self] })).toThrow(/protocol-repo-is-not-consumer/);
  });
});

describe("[PiDock 08] local debug binds consumers to this task's artifact", () => {
  it("binds a Go consumer through its own workspace and a TS consumer through the managed link", () => {
    const binding = host();
    const planned = planLocal(binding, [INVOICE, SHIPMENT, BFF], []);
    expect(planned.generation.runsGeneration).toBe(true);
    expect(planned.generation.steps.map((step) => step.kind)).toEqual(["generate", "postprocess"]);
    const invoice = planned.consumers.find((consumer) => consumer.consumerId === "invoice");
    expect(invoice?.binding.kind).toBe("go-workspace");
    if (invoice?.binding.kind !== "go-workspace") return;
    expect(invoice.binding.useDirectories).toEqual([`${TASK_DIR}/invoice-service`, `${TASK_DIR}/apis/gen/go`]);
    expect(invoice.binding.excludedConsumers).toEqual(["shipment"]);
    expect(invoice.binding.env.GOWORK).toBe(invoice.binding.path);
    expect(invoice.binding.path.startsWith(TASK_DIR)).toBe(true);
    const bff = planned.consumers.find((consumer) => consumer.consumerId === "bff");
    expect(bff?.binding.kind).toBe("ts-link");
    if (bff?.binding.kind !== "ts-link") return;
    expect(bff.binding.linkPath).toBe(`${TASK_DIR}/front-monorepo/node_modules/@shipber/proto`);
    expect(bff.binding.link).toEqual({ program: "pnpm", args: ["run", "proto:link-local", "--app", "saas-bff"] });
    // Nothing generated yet: consumers are still unbound, not silently green.
    expect(planned.generatedVersion).toBeNull();
    expect(planned.diagnostics.map((entry) => entry.code)).toContain("not-generated");
    expect(planned.consumers.every((consumer) => consumer.staleness.state === "needs-regenerate")).toBe(true);
  });

  it("requires an acknowledged cross-version switch before marking consumers bound", () => {
    const binding = host();
    planLocal(binding, [INVOICE, SHIPMENT, BFF], []);
    const refused = binding.recordResult({
      generatedVersion: "gen-4",
      ok: true,
      note: "make generate + postprocess 完成",
      resolutions: [
        { consumerId: "invoice", path: `${PROTOCOL.goGenDir}/pkg`, version: "gen-4" },
        { consumerId: "shipment", path: `${PROTOCOL.goGenDir}/pkg`, version: "gen-4" },
        { consumerId: "bff", path: `${PROTOCOL.tsGenDir}/index.js`, version: "gen-4" },
      ],
    });
    expect(refused.consumers.map((consumer) => consumer.staleness.state)).toEqual(["needs-binding", "needs-binding", "needs-binding"]);
    expect(refused.diagnostics.map((entry) => entry.code)).toEqual([
      "cross-version-unverified",
      "cross-version-unverified",
      "cross-version-unverified",
    ]);
    expect(refused.switchAssessment.ok).toBe(false);

    const acknowledged = host();
    planLocal(acknowledged, [INVOICE, SHIPMENT, BFF], ["invoice", "shipment", "bff"]);
    const state = acknowledged.recordResult({
      generatedVersion: "gen-4",
      ok: true,
      resolutions: [
        { consumerId: "invoice", path: `${PROTOCOL.goGenDir}/pkg`, version: "gen-4" },
        { consumerId: "shipment", path: `${PROTOCOL.goGenDir}/pkg`, version: "gen-4" },
        { consumerId: "bff", path: `${PROTOCOL.tsGenDir}/index.js`, version: "gen-4" },
      ],
    });
    expect(state.generatedVersion).toBe("gen-4");
    expect(state.generatedAt).toBe("2026-09-22T12:00:00.000Z");
    expect(state.switchAssessment.ok).toBe(true);
    expect(state.diagnostics).toEqual([]);
    expect(state.consumers.every((consumer) => consumer.staleness.state === "ready")).toBe(true);
    const prepare = new Map(state.prepare.map((entry) => [entry.state, entry]));
    expect(prepare.get("generated")?.ok).toBe(true);
    expect(prepare.get("generated")?.detail).toContain("gen-4");
    expect(prepare.get("binding-valid")?.ok).toBe(true);
    // Dependency install and runtime reachability stay caller-reported.
    expect(prepare.get("deps-installed")?.ok).toBe(false);
    expect(prepare.get("runtime-reachable")?.ok).toBe(false);
    expect(state.generationHistory).toEqual([{ version: "gen-4", at: "2026-09-22T12:00:00.000Z", ok: true, note: "" }]);
  });

  it("leaves a consumer unbound with a diagnostic when its resolution points elsewhere", () => {
    const binding = host();
    planLocal(binding, [INVOICE], ["invoice"]);
    const state = binding.recordResult({
      generatedVersion: "gen-4",
      ok: true,
      resolutions: [{ consumerId: "invoice", path: "/data/go/pkg/mod/github.com/shipber/apis@v0.0.69" }],
    });
    expect(state.consumers[0]?.resolution?.ok).toBe(false);
    expect(state.consumers[0]?.resolution?.code).toBe("resolved-elsewhere");
    expect(state.consumers[0]?.staleness.state).toBe("needs-binding");
    expect(state.diagnostics.map((entry) => entry.code)).toEqual(["resolved-elsewhere"]);
  });

  it("stops a consumer that was not re-verified after a new artifact appeared", () => {
    const binding = host();
    planLocal(binding, [INVOICE], ["invoice"]);
    binding.recordResult({
      generatedVersion: "gen-3",
      ok: true,
      resolutions: [{ consumerId: "invoice", path: `${PROTOCOL.goGenDir}/pkg`, version: "gen-3" }],
    });
    const state = binding.recordResult({ generatedVersion: "gen-4", ok: true, note: "重新生成，未复核解析" });
    expect(state.generatedVersion).toBe("gen-4");
    expect(state.consumers[0]?.staleness.state).toBe("needs-compile");
    expect(state.diagnostics.map((entry) => entry.code)).toContain("artifact-version-mismatch");
  });

  it("refuses a successful generation without a version and refuses results before a plan", () => {
    const binding = host();
    planLocal(binding, [INVOICE], ["invoice"]);
    expect(() => binding.recordResult({ generatedVersion: "  ", ok: true })).toThrow(/not-generated/);
    expect(() => host().recordResult({ generatedVersion: "gen-1", ok: true })).toThrow(/invalid-payload/);
  });

  it("keeps a failed run out of the displayed generated version", () => {
    const binding = host();
    planLocal(binding, [INVOICE], ["invoice"]);
    binding.recordResult({
      generatedVersion: "gen-3",
      ok: true,
      resolutions: [{ consumerId: "invoice", path: `${PROTOCOL.goGenDir}/pkg`, version: "gen-3" }],
    });
    const failed = binding.recordResult({ generatedVersion: "gen-4", ok: false, note: "后处理失败" });
    expect(failed.generatedVersion).toBe("gen-3");
    expect(failed.generationHistory.map((entry) => ({ version: entry.version, ok: entry.ok }))).toEqual([
      { version: "gen-3", ok: true },
      { version: "gen-4", ok: false },
    ]);
  });

  it("refuses a resolution reported for a consumer that is not in the plan", () => {
    const binding = host();
    planLocal(binding, [INVOICE], ["invoice"]);
    expect(() =>
      binding.recordResult({ generatedVersion: "gen-4", ok: true, resolutions: [{ consumerId: "unknown", path: `${PROTOCOL.goGenDir}/pkg` }] }),
    ).toThrow(/invalid-consumer/);
  });
});

describe("[PiDock 08] a stale running instance is never counted as loaded", () => {
  it("marks the consumer restart-needed with the version the instance really loaded", () => {
    const binding = host();
    planLocal(binding, [INVOICE], ["invoice"]);
    binding.recordResult({
      generatedVersion: "gen-3",
      ok: true,
      resolutions: [{ consumerId: "invoice", path: `${PROTOCOL.goGenDir}/pkg`, version: "gen-3" }],
    });
    // The protocol changed again and the same instance is still running.
    binding.recordResult({ generatedVersion: "gen-4", ok: true, resolutions: [{ consumerId: "invoice", path: `${PROTOCOL.goGenDir}/pkg`, version: "gen-4" }] });
    const withRun = binding.state([{ consumerId: "invoice", runId: "run-2", loadedVersion: "gen-3", running: true }]);
    expect(withRun.consumers[0]?.staleness.state).toBe("needs-restart");
    expect(withRun.consumers[0]?.staleness.loadedVersion).toBe("gen-3");
    expect(withRun.consumers[0]?.staleness.detail).toContain("run-2");
    const withoutRun = binding.state([{ consumerId: "invoice", runId: "run-2", loadedVersion: "gen-3", running: false }]);
    expect(withoutRun.consumers[0]?.staleness.state).toBe("ready");
  });
});

describe("[PiDock 08] switching back to release dependencies is task-scoped", () => {
  it("reports no local-switch blocker once the task is back on release dependencies", () => {
    const binding = host();
    planLocal(binding, [INVOICE, SHIPMENT], ["invoice", "shipment"]);
    binding.recordResult({
      generatedVersion: "gen-4",
      ok: true,
      resolutions: [
        { consumerId: "invoice", path: `${PROTOCOL.goGenDir}/pkg`, version: "gen-4" },
        { consumerId: "shipment", path: `${PROTOCOL.goGenDir}/pkg`, version: "gen-4" },
      ],
    });
    expect(binding.state().switchAssessment.ok).toBe(true);

    // Back on release dependencies with two different release versions: release
    // mode performs no local switch, so the cross-version blocker (which only
    // applies to compiling this task's artifact) must not appear.
    const backToRelease = binding.setPlan({ protocol: PROTOCOL, mode: "release", consumers: [INVOICE, SHIPMENT] });
    expect(backToRelease.mode).toBe("release");
    expect(backToRelease.switchAssessment).toEqual({ ok: true, blockers: [], notes: [] });
    expect(backToRelease.diagnostics).toEqual([]);
  });

  it("restores the release resolution and leaves another task's binding alone", () => {
    const binding = host();
    planLocal(binding, [INVOICE], ["invoice"]);
    binding.recordResult({
      generatedVersion: "gen-4",
      ok: true,
      resolutions: [{ consumerId: "invoice", path: `${PROTOCOL.goGenDir}/pkg`, version: "gen-4" }],
    });
    const other = new TaskProtocolBinding("task-b77e10aa", OTHER_TASK_DIR, () => "2026-09-22T12:00:00.000Z");
    const otherState = other.setPlan({
      protocol: { repoDir: `${OTHER_TASK_DIR}/apis`, goGenDir: `${OTHER_TASK_DIR}/apis/gen/go`, tsGenDir: `${OTHER_TASK_DIR}/apis/gen/ts` },
      mode: "local",
      steps: [{ ...(STEPS[0] as (typeof STEPS)[number]), cwd: `${OTHER_TASK_DIR}/apis` }, { ...(STEPS[1] as (typeof STEPS)[number]), cwd: `${OTHER_TASK_DIR}/apis` }],
      consumers: [{ ...INVOICE, repoDir: `${OTHER_TASK_DIR}/invoice-service` }],
      acknowledged: ["invoice"],
    });
    expect(otherState.consumers[0]?.binding.kind).toBe("go-workspace");
    if (otherState.consumers[0]?.binding.kind !== "go-workspace") return;
    expect(otherState.consumers[0].binding.path.startsWith(OTHER_TASK_DIR)).toBe(true);

    const backToRelease = binding.setPlan({ protocol: PROTOCOL, mode: "release", consumers: [INVOICE] });
    expect(backToRelease.mode).toBe("release");
    expect(backToRelease.consumers[0]?.binding).toEqual({ kind: "release", dependency: "github.com/shipber/apis v0.0.69" });
    expect(backToRelease.consumers[0]?.staleness.state).toBe("ready");
    // The other task still holds its own local plan.
    expect(other.state().consumers[0]?.binding.kind).toBe("go-workspace");
  });
});

describe("[PiDock 08] toolchain results stay platform-specific", () => {
  it("reports the Windows ARM64 gap and never infers support from the desktop app", () => {
    const binding = host();
    planLocal(binding, [INVOICE], ["invoice"]);
    const state = binding.recordResult({ generatedVersion: "gen-4", ok: true, toolchain: { platform: "win32-arm64" } });
    expect(state.toolchain.ok).toBe(false);
    expect(state.desktopLaunchImpliesGeneration).toBeUndefined();
    expect(state.toolchain.desktopLaunchImpliesGeneration).toBe(false);
    const byTool = new Map(state.toolchain.entries.map((entry) => [entry.toolId, entry]));
    expect(byTool.get("buf")?.status).toBe("unsupported-platform");
    expect(byTool.get("protoc-gen-go")?.status).toBe("unsupported-platform");
    // The gap is per tool: pnpm is Node-based and stays merely unverified.
    expect(byTool.get("pnpm")?.status).toBe("unverified");
    const prepare = new Map(state.prepare.map((entry) => [entry.state, entry]));
    expect(prepare.get("toolchain-ready")?.ok).toBe(false);
    expect(prepare.get("toolchain-ready")?.detail).toContain("Windows ARM64");
  });
});
