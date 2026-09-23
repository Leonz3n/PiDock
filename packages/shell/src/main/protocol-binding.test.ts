import { describe, expect, it } from "vitest";
import {
  assessConsumerStaleness,
  assessLocalSwitch,
  buildPrepareState,
  checkGenerationToolchain,
  checkTsBinding,
  GENERATION_TOOLS,
  isPathInside,
  planGeneration,
  planGoWorkspace,
  planTsBinding,
  tsBindingMarker,
  validateGenerationStep,
  validateProtocolPlan,
  verifyResolvedPath,
  type GenerationStep,
  type ProtocolConsumer,
  type ProtocolRepoRef,
} from "./protocol-binding.js";

const TASK_DIR = "/data/pidock/tasks/task-a1f92c3d";
const PROTOCOL: ProtocolRepoRef = {
  repoDir: `${TASK_DIR}/apis`,
  goGenDir: `${TASK_DIR}/apis/gen/go`,
  tsGenDir: `${TASK_DIR}/apis/gen/ts`,
};

const GO_CONSUMER: ProtocolConsumer = {
  consumerId: "invoice",
  name: "invoice-service",
  repoDir: `${TASK_DIR}/invoice-service`,
  language: "go",
  serviceId: "invoice-service",
  releaseDependency: "github.com/shipber/apis v0.0.69",
};

const SHIPMENT_CONSUMER: ProtocolConsumer = {
  consumerId: "shipment",
  name: "shipment-service",
  repoDir: `${TASK_DIR}/shipment-service`,
  language: "go",
  serviceId: "shipment-service",
  releaseDependency: "github.com/shipber/apis v0.0.103",
};

const BFF_CONSUMER: ProtocolConsumer = {
  consumerId: "bff",
  name: "saas-bff",
  repoDir: `${TASK_DIR}/front-monorepo`,
  language: "ts",
  serviceId: "saas-bff",
  releaseDependency: "@shipber/proto 0.0.108",
  linkScript: "proto:link-local",
  linkTarget: "saas-bff",
};

const STEPS: GenerationStep[] = [
  { kind: "generate", program: "make", args: ["generate"], cwd: PROTOCOL.repoDir, note: "协议编译与 Go/TS 生成" },
  { kind: "postprocess", program: "pnpm", args: ["--filter", "@shipber/proto", "build"], cwd: PROTOCOL.repoDir, note: "仓库自己的后处理" },
];

describe("[PiDock 08] protocol repository / generation steps / consumer bindings stay separate", () => {
  it("accepts the pilot shape: apis is the protocol repo, the three services are consumers", () => {
    expect(validateProtocolPlan({ protocol: PROTOCOL, consumers: [GO_CONSUMER, SHIPMENT_CONSUMER, BFF_CONSUMER] })).toBeNull();
  });

  it("rejects the protocol repository as its own consumer", () => {
    const asConsumer = { ...GO_CONSUMER, consumerId: "apis", name: "apis", repoDir: PROTOCOL.repoDir };
    expect(validateProtocolPlan({ protocol: PROTOCOL, consumers: [asConsumer] })?.code).toBe("protocol-repo-is-not-consumer");
    const genConsumer = { ...GO_CONSUMER, consumerId: "gen", name: "gen", repoDir: `${PROTOCOL.tsGenDir}/pkg` };
    expect(validateProtocolPlan({ protocol: PROTOCOL, consumers: [genConsumer] })?.code).toBe("protocol-repo-is-not-consumer");
  });

  it("rejects a plan with no consumers and duplicated consumer identity", () => {
    expect(validateProtocolPlan({ protocol: PROTOCOL, consumers: [] })?.code).toBe("empty-consumers");
    expect(validateProtocolPlan({ protocol: PROTOCOL, consumers: [GO_CONSUMER, { ...GO_CONSUMER, repoDir: `${TASK_DIR}/other` }] })?.code).toBe("duplicate-consumer");
    expect(validateProtocolPlan({ protocol: PROTOCOL, consumers: [GO_CONSUMER, { ...SHIPMENT_CONSUMER, repoDir: GO_CONSUMER.repoDir }] })?.code).toBe("duplicate-consumer-repo");
  });

  it("requires a TS consumer to name its own link script and app", () => {
    expect(validateProtocolPlan({ protocol: PROTOCOL, consumers: [{ ...BFF_CONSUMER, linkScript: undefined }] })?.code).toBe("missing-link");
    expect(validateProtocolPlan({ protocol: PROTOCOL, consumers: [{ ...BFF_CONSUMER, linkTarget: undefined }] })?.code).toBe("missing-link");
  });

  it("requires every generation step to be an explicit program without shell chaining", () => {
    expect(validateGenerationStep({ kind: "generate", program: "make generate", args: [], cwd: PROTOCOL.repoDir, note: "" })?.code).toBe("invalid-step");
    expect(validateGenerationStep({ kind: "generate", program: "buf", args: ["generate", "&&", "make", "post"], cwd: PROTOCOL.repoDir, note: "" })?.code).toBe("invalid-step");
    expect(validateGenerationStep({ kind: "postprocess", program: "PROTO=v1", args: [], cwd: PROTOCOL.repoDir, note: "" })?.code).toBe("invalid-step");
    expect(validateGenerationStep(STEPS[0] as GenerationStep)).toBeNull();
  });
});

describe("[PiDock 08] unchanged protocol keeps release dependencies; local debug runs generation + postprocess", () => {
  it("runs nothing and keeps each consumer's release dependency when the protocol is unchanged", () => {
    const planned = planGeneration({ mode: "release", protocol: PROTOCOL, steps: STEPS, consumers: [GO_CONSUMER, BFF_CONSUMER] });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.runsGeneration).toBe(false);
    expect(planned.plan.steps).toEqual([]);
    expect(planned.plan.keepsReleaseDependencies).toBe(true);
    expect(planned.plan.releaseResolution).toEqual([
      { consumerId: "invoice", language: "go", dependency: "github.com/shipber/apis v0.0.69" },
      { consumerId: "bff", language: "ts", dependency: "@shipber/proto 0.0.108" },
    ]);
  });

  it("requires the repository's postprocess step in local mode, not just the generator", () => {
    const generateOnly = planGeneration({ mode: "local", protocol: PROTOCOL, steps: [STEPS[0] as GenerationStep], consumers: [GO_CONSUMER] });
    expect(generateOnly.ok).toBe(false);
    if (generateOnly.ok) return;
    expect(generateOnly.error.code).toBe("missing-postprocess");
    const planned = planGeneration({ mode: "local", protocol: PROTOCOL, steps: STEPS, consumers: [GO_CONSUMER] });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.runsGeneration).toBe(true);
    expect(planned.plan.steps.map((step) => step.kind)).toEqual(["generate", "postprocess"]);
    expect(planned.plan.keepsReleaseDependencies).toBe(false);
  });

  it("refuses a generation step outside this task's protocol repository", () => {
    const outside: GenerationStep = { kind: "generate", program: "buf", args: ["generate"], cwd: `${TASK_DIR}/invoice-service`, note: "" };
    const planned = planGeneration({ mode: "local", protocol: PROTOCOL, steps: [...STEPS, outside], consumers: [GO_CONSUMER] });
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.error.code).toBe("step-outside-protocol-repo");
  });
});

describe("[PiDock 08] Go consumers bind through a task-scoped workspace", () => {
  it("uses exactly the one consumer module plus this task's generated module", () => {
    const planned = planGoWorkspace({
      taskId: "task-a1f92c3d",
      protocol: PROTOCOL,
      consumer: GO_CONSUMER,
      allConsumers: [GO_CONSUMER, SHIPMENT_CONSUMER, BFF_CONSUMER],
      workspaceDir: `${TASK_DIR}/protocol`,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.useDirectories).toEqual([`${TASK_DIR}/invoice-service`, `${TASK_DIR}/apis/gen/go`]);
    expect(planned.plan.content).toContain(`use (\n\t${TASK_DIR}/invoice-service\n\t${TASK_DIR}/apis/gen/go\n)`);
    // The other Go service is deliberately left out: no merged dependency choices.
    expect(planned.plan.excludedConsumers).toEqual(["shipment"]);
    // A task-scoped workspace never rewrites the consumer's release manifests.
    expect(planned.plan.releaseManifestsUntouched).toEqual([`${TASK_DIR}/invoice-service/go.mod`, `${TASK_DIR}/invoice-service/go.sum`]);
    expect(planned.plan.path).toBe(`${TASK_DIR}/protocol/go-work/invoice/go.work`);
    expect(planned.plan.env.GOWORK).toBe(planned.plan.path);
    expect(isPathInside(TASK_DIR, planned.plan.path)).toBe(true);
  });

  it("refuses to build a Go workspace for a non-Go consumer", () => {
    const planned = planGoWorkspace({
      taskId: "task-a1f92c3d",
      protocol: PROTOCOL,
      consumer: BFF_CONSUMER,
      allConsumers: [BFF_CONSUMER],
      workspaceDir: `${TASK_DIR}/protocol`,
    });
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.error.code).toBe("invalid-consumer");
  });
});

describe("[PiDock 08] TS consumers reuse the managed link inside the current task", () => {
  it("plans the repository's own link command for exactly one app and can restore it", () => {
    const planned = planTsBinding({ taskId: "task-a1f92c3d", protocol: PROTOCOL, consumer: BFF_CONSUMER });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.link).toEqual({ program: "pnpm", args: ["run", "proto:link-local", "--app", "saas-bff"] });
    expect(planned.plan.restore).toEqual(planned.plan.link);
    expect(planned.plan.linkPath).toBe(`${TASK_DIR}/front-monorepo/node_modules/@shipber/proto`);
    expect(planned.plan.artifact).toBe(`${TASK_DIR}/apis/gen/ts`);
    expect(planned.plan.marker).toBe(tsBindingMarker({ taskId: "task-a1f92c3d", consumerId: "bff", tsGenDir: PROTOCOL.tsGenDir }));
  });

  it("fails closed with a restore hint when the marker is gone or resolves elsewhere", () => {
    const planned = planTsBinding({ taskId: "task-a1f92c3d", protocol: PROTOCOL, consumer: BFF_CONSUMER });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const missing = checkTsBinding({ plan: planned.plan, marker: null, resolvedPath: null });
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe("marker-missing");
    expect(missing.message).toContain("proto:link-local");
    const foreign = checkTsBinding({ plan: planned.plan, marker: "pidock-local-protocol:task-b77e10aa:bff:/data/other/ts", resolvedPath: `${PROTOCOL.tsGenDir}/index.js` });
    expect(foreign.code).toBe("resolved-elsewhere");
    const relocated = checkTsBinding({ plan: planned.plan, marker: planned.plan.marker, resolvedPath: "/data/published/@shipber/proto/index.js" });
    expect(relocated.ok).toBe(false);
    expect(relocated.code).toBe("resolved-elsewhere");
    const restored = checkTsBinding({ plan: planned.plan, marker: planned.plan.marker, resolvedPath: `${PROTOCOL.tsGenDir}/index.js` });
    expect(restored.ok).toBe(true);
    expect(restored.code).toBe("restored");
  });
});

describe("[PiDock 08] switching different release versions onto one local artifact stops and explains", () => {
  const verified = [{ consumerId: "invoice", artifactVersion: "gen-3" }];

  it("blocks when the artifact changed under a previously verified consumer", () => {
    const assessed = assessLocalSwitch({ consumers: [GO_CONSUMER], artifactVersion: "gen-4", verified });
    expect(assessed.ok).toBe(false);
    expect(assessed.blockers[0]).toMatchObject({ consumerId: "invoice", code: "artifact-version-mismatch" });
    expect(assessed.blockers[0]?.message).toContain("gen-3");
  });

  it("reports the missing artifact as a note instead of an incompatibility", () => {
    const assessed = assessLocalSwitch({ consumers: [GO_CONSUMER], artifactVersion: null, verified: [] });
    expect(assessed.ok).toBe(true);
    expect(assessed.blockers).toEqual([]);
    expect(assessed.notes).toEqual(["本任务还没有生成的协议产物版本，请先生成再绑定"]);
  });

  it("blocks consumers on different release versions until each one is acknowledged", () => {
    const assessed = assessLocalSwitch({
      consumers: [GO_CONSUMER, SHIPMENT_CONSUMER, BFF_CONSUMER],
      artifactVersion: "gen-3",
      verified: [],
    });
    expect(assessed.ok).toBe(false);
    expect(assessed.blockers.map((blocker) => blocker.consumerId)).toEqual(["invoice", "shipment", "bff"]);
    expect(assessed.blockers.every((blocker) => blocker.code === "cross-version-unverified")).toBe(true);
    expect(assessed.notes).toEqual(["跨语言/跨版本不能直接比较版本号，逐个消费者确认是必需步骤"]);
    const acknowledged = assessLocalSwitch({
      consumers: [GO_CONSUMER, SHIPMENT_CONSUMER, BFF_CONSUMER],
      artifactVersion: "gen-3",
      verified: [],
      acknowledged: ["invoice", "shipment", "bff"],
    });
    expect(acknowledged.ok).toBe(true);
  });

  it("does not block consumers that already share one release dependency", () => {
    const assessed = assessLocalSwitch({
      consumers: [GO_CONSUMER, { ...SHIPMENT_CONSUMER, releaseDependency: GO_CONSUMER.releaseDependency }],
      artifactVersion: "gen-3",
      verified: [],
    });
    expect(assessed.ok).toBe(true);
  });
});

describe("[PiDock 08] resolution path is confirmed before a compile", () => {
  it("rejects a release-mode consumer that still resolves into the task artifact", () => {
    const checked = verifyResolvedPath({
      mode: "release",
      consumer: GO_CONSUMER,
      artifact: { dir: PROTOCOL.goGenDir, version: "gen-3" },
      resolved: { path: `${PROTOCOL.goGenDir}/pkg/detail`, version: "gen-3" },
    });
    expect(checked.ok).toBe(false);
    expect(checked.code).toBe("resolved-elsewhere");
    expect(checked.message).toContain("v0.0.69");
  });

  it("accepts the release resolution outside the task artifact", () => {
    const checked = verifyResolvedPath({
      mode: "release",
      consumer: GO_CONSUMER,
      artifact: { dir: PROTOCOL.goGenDir, version: "gen-3" },
      resolved: { path: "/data/go/pkg/mod/github.com/shipber/apis@v0.0.69", version: "v0.0.69" },
    });
    expect(checked.ok).toBe(true);
  });

  it("rejects a local-mode consumer resolved outside the artifact or on another version", () => {
    const outside = verifyResolvedPath({
      mode: "local",
      consumer: GO_CONSUMER,
      artifact: { dir: PROTOCOL.goGenDir, version: "gen-3" },
      resolved: { path: "/data/go/pkg/mod/github.com/shipber/apis@v0.0.69" },
    });
    expect(outside.ok).toBe(false);
    expect(outside.code).toBe("resolved-elsewhere");
    const stale = verifyResolvedPath({
      mode: "local",
      consumer: GO_CONSUMER,
      artifact: { dir: PROTOCOL.goGenDir, version: "gen-4" },
      resolved: { path: `${PROTOCOL.goGenDir}/pkg/detail`, version: "gen-3" },
    });
    expect(stale.ok).toBe(false);
    expect(stale.code).toBe("version-mismatch");
    const ok = verifyResolvedPath({
      mode: "local",
      consumer: GO_CONSUMER,
      artifact: { dir: PROTOCOL.goGenDir, version: "gen-4" },
      resolved: { path: `${PROTOCOL.goGenDir}/pkg/detail`, version: "gen-4" },
    });
    expect(ok.ok).toBe(true);
  });
});

describe("[PiDock 08] a protocol change marks consumers and never counts a stale run as loaded", () => {
  it("walks regenerate -> bind -> compile -> restart", () => {
    const ungenerated = assessConsumerStaleness({ consumers: [GO_CONSUMER], generatedVersion: null, bindings: [], runs: [] });
    expect(ungenerated[0]?.state).toBe("needs-regenerate");
    const unbound = assessConsumerStaleness({ consumers: [GO_CONSUMER], generatedVersion: "gen-4", bindings: [], runs: [] });
    expect(unbound[0]?.state).toBe("needs-binding");
    const staleBinding = assessConsumerStaleness({
      consumers: [GO_CONSUMER],
      generatedVersion: "gen-4",
      bindings: [{ consumerId: "invoice", artifactVersion: "gen-3" }],
      runs: [],
    });
    expect(staleBinding[0]?.state).toBe("needs-compile");
    expect(staleBinding[0]?.detail).toContain("gen-3");
  });

  it("reports a running instance on the old artifact as not having loaded the new protocol", () => {
    const staleRun = assessConsumerStaleness({
      consumers: [GO_CONSUMER],
      generatedVersion: "gen-4",
      bindings: [{ consumerId: "invoice", artifactVersion: "gen-4" }],
      runs: [{ consumerId: "invoice", runId: "run-1", loadedVersion: "gen-3", running: true }],
    });
    expect(staleRun[0]?.state).toBe("needs-restart");
    expect(staleRun[0]?.loadedVersion).toBe("gen-3");
    expect(staleRun[0]?.detail).toContain("run-1");
    const stopped = assessConsumerStaleness({
      consumers: [GO_CONSUMER],
      generatedVersion: "gen-4",
      bindings: [{ consumerId: "invoice", artifactVersion: "gen-4" }],
      runs: [{ consumerId: "invoice", runId: "run-1", loadedVersion: "gen-3", running: false }],
    });
    expect(stopped[0]?.state).toBe("ready");
  });
});

describe("[PiDock 08] generation tools report per-platform results, never inferred from the desktop app", () => {
  it("reports the Windows ARM64 gap explicitly instead of leaving it unverified", () => {
    const report = checkGenerationToolchain({ platform: "win32-arm64" });
    expect(report.ok).toBe(false);
    expect(report.desktopLaunchImpliesGeneration).toBe(false);
    expect(report.entries).toHaveLength(GENERATION_TOOLS.length);
    const byTool = new Map(report.entries.map((entry) => [entry.toolId, entry]));
    // The native protoc plugins have no Windows ARM64 install path.
    for (const toolId of ["buf", "protoc-gen-go", "protoc-gen-go-grpc", "protoc-gen-es"]) {
      expect(byTool.get(toolId)?.status).toBe("unsupported-platform");
      expect(byTool.get(toolId)?.detail).toContain("Windows ARM64");
    }
    // pnpm runs on Node, so it is only "unchecked" here, not unsupported.
    expect(byTool.get("pnpm")?.status).toBe("unverified");
    expect(report.note).toContain("桌面可启动不能推断生成支持");
  });

  it("keeps unprobed tools unverified and reports probed ones on the current platform", () => {
    const unprobed = checkGenerationToolchain({ platform: "darwin-arm64" });
    expect(unprobed.ok).toBe(false);
    expect(unprobed.entries.every((entry) => entry.status === "unverified")).toBe(true);
    const probed = checkGenerationToolchain({
      platform: "darwin-arm64",
      probe: Object.fromEntries(GENERATION_TOOLS.map((tool) => [tool.id, { ok: true, version: `${tool.id}-1.2.3` }])),
    });
    expect(probed.ok).toBe(true);
    expect(probed.entries.every((entry) => entry.status === "ready")).toBe(true);
    const withMissing = checkGenerationToolchain({
      platform: "win32-x64",
      probe: { buf: { ok: false, note: "未找到 buf" } },
    });
    expect(withMissing.ok).toBe(false);
    expect(withMissing.entries.find((entry) => entry.toolId === "buf")?.status).toBe("missing");
    expect(withMissing.entries.find((entry) => entry.toolId === "pnpm")?.status).toBe("unverified");
  });
});

describe("[PiDock 08] prepare state separates code, tools, deps, artifact, binding and reachability", () => {
  it("shows the actual generated version and each state independently", () => {
    const toolchain = checkGenerationToolchain({
      platform: "darwin-arm64",
      probe: Object.fromEntries(GENERATION_TOOLS.map((tool) => [tool.id, { ok: true }])),
    });
    const entries = buildPrepareState({
      protocol: PROTOCOL,
      consumers: [GO_CONSUMER, BFF_CONSUMER],
      generatedVersion: "gen-4",
      toolchain,
      depsInstalled: [
        { consumerId: "invoice", installed: true },
        { consumerId: "bff", installed: false },
      ],
      bindings: [{ consumerId: "invoice", artifactVersion: "gen-4", resolved: true }],
      runtimeReachable: { ok: true, detail: "本地实例与远程依赖均可达" },
    });
    const byState = new Map(entries.map((entry) => [entry.state, entry]));
    expect(entries.map((entry) => entry.state)).toEqual([
      "code-ready",
      "toolchain-ready",
      "deps-installed",
      "generated",
      "binding-valid",
      "runtime-reachable",
    ]);
    expect(byState.get("code-ready")?.ok).toBe(true);
    expect(byState.get("toolchain-ready")?.ok).toBe(true);
    expect(byState.get("deps-installed")?.ok).toBe(false);
    expect(byState.get("deps-installed")?.detail).toContain("saas-bff");
    expect(byState.get("generated")?.ok).toBe(true);
    expect(byState.get("generated")?.detail).toContain("gen-4");
    expect(byState.get("binding-valid")?.ok).toBe(false);
    expect(byState.get("binding-valid")?.detail).toContain("saas-bff");
    expect(byState.get("runtime-reachable")?.ok).toBe(true);
  });

  it("does not treat an unchecked runtime as reachable", () => {
    const toolchain = checkGenerationToolchain({ platform: "darwin-arm64" });
    const entries = buildPrepareState({
      protocol: PROTOCOL,
      consumers: [GO_CONSUMER],
      generatedVersion: null,
      toolchain,
      depsInstalled: [],
      bindings: [],
    });
    const byState = new Map(entries.map((entry) => [entry.state, entry]));
    expect(byState.get("runtime-reachable")?.ok).toBe(false);
    expect(byState.get("runtime-reachable")?.detail).toContain("未检查");
    expect(byState.get("generated")?.ok).toBe(false);
    expect(byState.get("generated")?.detail).toContain("发布依赖");
  });
});

describe("[PiDock 08] path containment helper", () => {
  it("matches on path boundaries only", () => {
    expect(isPathInside("/a/b", "/a/b")).toBe(true);
    expect(isPathInside("/a/b", "/a/b/c")).toBe(true);
    expect(isPathInside("/a/b", "/a/bc")).toBe(false);
    expect(isPathInside("/a/b", "/a")).toBe(false);
    expect(isPathInside("", "/a")).toBe(false);
    expect(isPathInside("/a/b/", "/a/b/c")).toBe(true);
  });
});
