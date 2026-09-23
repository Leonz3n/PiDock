import { createMemoryHost } from "../data/memoryHost";
import {
  projectProtocolBinding,
  protocolBindingFromHost,
  protocolConsumerStateLabel,
  protocolModeLabel,
  toolchainStatusLabel,
  type ProtocolBindingView,
} from "../data/protocolBinding";

/**
 * [PiDock 08] (#14) renderer mirror: the protocol repository / generation
 * steps / consumer binding separation and the prepare state start on release
 * dependencies and never fabricate a generated version; a Host payload is
 * parsed defensively; the labels the panel shows stay stable.
 */
describe("protocol binding projection", () => {
  it("starts the release task on release dependencies with nothing claimed as generated", async () => {
    const host = createMemoryHost();
    const task = await host.getTask("release");
    if (!task) throw new Error("fixture release task missing");
    const view = projectProtocolBinding(task);
    expect(view.mode).toBe("release");
    expect(view.simulated).toBe(true);
    expect(view.generatedVersion).toBeNull();
    expect(view.runsGeneration).toBe(false);
    expect(view.generationSteps).toEqual([]);
    expect(view.generationReason).toContain("保留各消费者原有发布依赖");
    expect(view.consumers.map((consumer) => consumer.name)).toEqual(["front-monorepo", "invoice-service", "shipment-service"]);
    expect(view.consumers.map((consumer) => consumer.language)).toEqual(["ts", "go", "go"]);
    expect(view.consumers.every((consumer) => consumer.binding.kind === "release")).toBe(true);
    expect(view.consumers.find((consumer) => consumer.name === "invoice-service")?.releaseDependency).toBe("github.com/shipber/apis v0.0.69");
    expect(view.consumers.find((consumer) => consumer.name === "shipment-service")?.releaseDependency).toBe("github.com/shipber/apis v0.0.103");
    expect(view.consumers.find((consumer) => consumer.name === "front-monorepo")?.releaseDependency).toBe("@shipber/proto 0.0.108");
    expect(view.prepare.map((entry) => entry.label)).toEqual(["代码就绪", "工具链就绪", "依赖已安装", "生成物已更新", "本地绑定有效", "运行环境可达"]);
    expect(view.prepare.every((entry) => entry.ok === false)).toBe(true);
    expect(view.toolchain.ok).toBe(false);
    expect(view.toolchain.desktopLaunchImpliesGeneration).toBe(false);
    expect(view.blockers).toEqual([]);
    expect(view.diagnostics).toEqual([]);
  });

  it("reports a missing protocol repository instead of pretending to bind", async () => {
    const host = createMemoryHost();
    const task = await host.getTask("checkout");
    if (!task) throw new Error("fixture checkout task missing");
    const view = projectProtocolBinding(task);
    expect(view.diagnostics.map((entry) => entry.code)).toEqual(["invalid-protocol-repo"]);
    // The task still lists its own repository as a consumer of the (absent)
    // protocol repo; nothing is generated or bound.
    expect(view.consumers.map((consumer) => consumer.name)).toEqual(["front-monorepo"]);
    expect(view.consumers.every((consumer) => consumer.binding.kind === "release")).toBe(true);
    expect(view.mode).toBe("release");
  });
});

describe("protocol binding Host payload", () => {
  const payload = {
    state: {
      taskId: "task-a1f92c3d",
      mode: "local",
      protocol: { repoDir: "/data/tasks/task-a1f92c3d/apis", goGenDir: "/data/tasks/task-a1f92c3d/apis/gen/go", tsGenDir: "/data/tasks/task-a1f92c3d/apis/gen/ts" },
      generatedVersion: "gen-4",
      generatedAt: "2026-09-22T12:00:00.000Z",
      generation: {
        runsGeneration: true,
        reason: "本地联调：在本任务生成目录执行完整生成与后处理",
        steps: [
          { kind: "generate", program: "make", args: ["generate"], cwd: "/data/tasks/task-a1f92c3d/apis", note: "生成" },
          { kind: "postprocess", program: "pnpm", args: ["--filter", "@shipber/proto", "build"], cwd: "/data/tasks/task-a1f92c3d/apis", note: "后处理" },
        ],
      },
      consumers: [
        {
          consumerId: "invoice",
          name: "invoice-service",
          language: "go",
          repoDir: "/data/tasks/task-a1f92c3d/invoice-service",
          releaseDependency: "github.com/shipber/apis v0.0.69",
          binding: {
            kind: "go-workspace",
            path: "/data/tasks/task-a1f92c3d/protocol/go-work/invoice/go.work",
            useDirectories: ["/data/tasks/task-a1f92c3d/invoice-service", "/data/tasks/task-a1f92c3d/apis/gen/go"],
            excludedConsumers: ["shipment"],
            releaseManifestsUntouched: ["/data/tasks/task-a1f92c3d/invoice-service/go.mod"],
          },
          resolution: { ok: true, message: "「invoice-service」解析到本任务产物" },
          staleness: { state: "needs-restart", detail: "运行实例 run-2 加载的是 gen-3" },
        },
        {
          consumerId: "bff",
          name: "saas-bff",
          language: "ts",
          repoDir: "/data/tasks/task-a1f92c3d/front-monorepo",
          releaseDependency: "@shipber/proto 0.0.108",
          binding: {
            kind: "ts-link",
            linkPath: "/data/tasks/task-a1f92c3d/front-monorepo/node_modules/@shipber/proto",
            artifact: "/data/tasks/task-a1f92c3d/apis/gen/ts",
            marker: "pidock-local-protocol:task-a1f92c3d:bff:/data/tasks/task-a1f92c3d/apis/gen/ts",
            restore: { program: "pnpm", args: ["run", "proto:link-local", "--app", "saas-bff"] },
          },
          staleness: { state: "needs-binding", detail: "尚未绑定本任务产物，仍在发布依赖上" },
        },
      ],
      prepare: [{ state: "generated", label: "生成物已更新", ok: true, detail: "实际生成版本：gen-4" }],
      toolchain: {
        platform: "win32-arm64",
        ok: false,
        note: "Windows ARM64 不是首版发布架构",
        desktopLaunchImpliesGeneration: false,
        entries: [{ toolId: "buf", label: "buf", status: "unsupported-platform", detail: "安装脚本不支持 Windows ARM64" }],
      },
      diagnostics: [{ code: "not-generated", message: "本地联调还没有生成产物版本" }],
      switchAssessment: {
        ok: false,
        blockers: [{ consumerId: "shipment", code: "cross-version-unverified", message: "不能假定同一本地产物全部兼容" }],
      },
    },
  };

  it("parses the Host state including bindings, staleness, blockers and the toolchain gap", () => {
    const view = protocolBindingFromHost("task-a1f92c3d", payload);
    expect(view).toBeDefined();
    if (!view) return;
    expect(view.simulated).toBe(false);
    expect(view.mode).toBe("local");
    expect(view.generatedVersion).toBe("gen-4");
    expect(view.generatedAt).toBe("2026-09-22T12:00:00.000Z");
    expect(view.generationSteps.map((step) => step.kind)).toEqual(["generate", "postprocess"]);
    const invoice = view.consumers.find((consumer) => consumer.consumerId === "invoice");
    expect(invoice?.binding.kind).toBe("go-workspace");
    if (invoice?.binding.kind === "go-workspace") {
      expect(invoice.binding.excludedConsumers).toEqual(["shipment"]);
      expect(invoice.binding.useDirectories).toHaveLength(2);
    }
    expect(invoice?.state).toBe("needs-restart");
    expect(invoice?.resolution?.ok).toBe(true);
    const bff = view.consumers.find((consumer) => consumer.consumerId === "bff");
    expect(bff?.binding.kind).toBe("ts-link");
    if (bff?.binding.kind === "ts-link") {
      expect(bff.binding.restore.args.join(" ")).toBe("run proto:link-local --app saas-bff");
    }
    expect(bff?.state).toBe("needs-binding");
    expect(view.blockers.map((blocker) => blocker.consumerId)).toEqual(["shipment"]);
    expect(view.diagnostics.map((entry) => entry.code)).toEqual(["not-generated"]);
    expect(view.toolchain.entries[0]?.status).toBe("unsupported-platform");
    expect(view.toolchain.desktopLaunchImpliesGeneration).toBe(false);
    expect(view.prepare[0]?.detail).toContain("gen-4");
  });

  it("returns undefined for a payload it cannot read instead of inventing a view", () => {
    expect(protocolBindingFromHost("task-a", undefined)).toBeUndefined();
    expect(protocolBindingFromHost("task-a", "nope")).toBeUndefined();
    expect(protocolBindingFromHost("task-a", { state: [] })).toBeUndefined();
    // A state without consumers still parses, but nothing is claimed.
    const sparse = protocolBindingFromHost("task-a", { state: { mode: "local" } });
    expect(sparse?.consumers).toEqual([]);
    expect(sparse?.generatedVersion).toBeNull();
    expect(sparse?.toolchain.ok).toBe(false);
  });
});

describe("protocol binding labels", () => {
  it("labels the mode, consumer state and toolchain status", () => {
    expect(protocolModeLabel("local")).toBe("本地联调（本任务产物）");
    expect(protocolModeLabel("release")).toBe("发布依赖");
    expect(protocolConsumerStateLabel("needs-restart")).toBe("需重启");
    expect(protocolConsumerStateLabel("ready")).toBe("就绪");
    expect(toolchainStatusLabel("unsupported-platform")).toBe("平台不支持");
    expect(toolchainStatusLabel("unverified")).toBe("未检查");
  });
});

/** The panel must never show a version the view does not carry. */
describe("protocol binding view contract", () => {
  it("keeps the simulated flag and the generation reason for the panel to show", async () => {
    const host = createMemoryHost();
    const task = await host.getTask("release");
    if (!task) throw new Error("fixture release task missing");
    const view: ProtocolBindingView = projectProtocolBinding(task);
    expect(view.simulated).toBe(true);
    expect(view.generationReason.length).toBeGreaterThan(0);
  });
});
