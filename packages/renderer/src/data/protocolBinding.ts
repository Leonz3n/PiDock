/**
 * Renderer view of the [PiDock 08] (#14) task-local protocol binding.
 *
 * The sandboxed renderer cannot import the shell's `protocol-binding.ts`
 * (importing shell modules would hand the page Node access), so the display
 * rules live here as an independent mirror, the same way `serviceTopology.ts`
 * mirrors #10. `shellHost` prefers the Host's own state when the shell answers
 * (`task/protocolState`) and falls back to this projection in memory mode, so
 * both paths show the same vocabulary.
 *
 * Covered here: the protocol repository / generation steps / consumer binding
 * separation plus the prepare state and the actual generated version (box 1),
 * the per-consumer binding the task uses (Go workspace / TS managed link,
 * boxes 3/4), the resolution and staleness marks (boxes 5/6) and the
 * platform-specific toolchain state with the Windows ARM64 gap explicit
 * (box 8). The renderer only displays these decisions; the Host owns them.
 */

import type { Task } from "./types";

export type ProtocolConsumerLanguageView = "go" | "ts";
export type ProtocolBindingModeView = "release" | "local";
export type ProtocolConsumerStateView = "ready" | "needs-regenerate" | "needs-binding" | "needs-compile" | "needs-restart";
export type ProtocolToolchainStatusView = "ready" | "missing" | "unverified" | "unsupported-platform";

export interface ProtocolGenerationStepView {
  kind: "generate" | "postprocess";
  program: string;
  args: string[];
  cwd: string;
  note: string;
}

export interface ProtocolConsumerView {
  consumerId: string;
  name: string;
  language: ProtocolConsumerLanguageView;
  repoDir: string;
  serviceId?: string;
  releaseDependency: string;
  binding:
    | { kind: "release"; dependency: string }
    | { kind: "go-workspace"; path: string; useDirectories: string[]; excludedConsumers: string[]; releaseManifestsUntouched: string[] }
    | { kind: "ts-link"; linkPath: string; artifact: string; marker: string; restore: { program: string; args: string[] } };
  state: ProtocolConsumerStateView;
  stateDetail: string;
  resolution?: { ok: boolean; message: string };
}

export interface ProtocolBindingView {
  taskId: string;
  mode: ProtocolBindingModeView;
  /** `true` when the panel shows the in-memory projection, not the Host state. */
  simulated: boolean;
  protocol: { repoDir: string; goGenDir: string; tsGenDir: string };
  runsGeneration: boolean;
  generationSteps: ProtocolGenerationStepView[];
  generationReason: string;
  generatedVersion: string | null;
  generatedAt?: string;
  consumers: ProtocolConsumerView[];
  prepare: { state: string; label: string; ok: boolean; detail: string }[];
  toolchain: {
    platform: string;
    ok: boolean;
    note: string;
    desktopLaunchImpliesGeneration: false;
    entries: { toolId: string; label: string; status: ProtocolToolchainStatusView; detail: string; version?: string }[];
  };
  /** Stop-and-explain reasons; empty when the switch may proceed. */
  blockers: { consumerId: string; code: string; message: string }[];
  diagnostics: { code: string; message: string }[];
}

const PREPARE_STATES = [
  ["code-ready", "代码就绪"],
  ["toolchain-ready", "工具链就绪"],
  ["deps-installed", "依赖已安装"],
  ["generated", "生成物已更新"],
  ["binding-valid", "本地绑定有效"],
  ["runtime-reachable", "运行环境可达"],
] as const;

/**
 * Pilot-inspection release dependencies, used by the in-memory projection.
 * `docs/pilot-repository-inspection.md`: the versions are per language and
 * cannot be compared across languages.
 */
const FIXTURE_RELEASE_DEPENDENCIES: Record<string, string> = {
  "invoice-service": "github.com/shipber/apis v0.0.69",
  "shipment-service": "github.com/shipber/apis v0.0.103",
  "front-monorepo": "@shipber/proto 0.0.108",
};

/** Repositories whose consumers are Go; front-monorepo consumes the TS package. */
const GO_CONSUMER_REPOS = ["invoice-service", "shipment-service"] as const;

export function protocolModeLabel(mode: ProtocolBindingModeView): string {
  return mode === "local" ? "本地联调（本任务产物）" : "发布依赖";
}

export function protocolConsumerStateLabel(state: ProtocolConsumerStateView): string {
  return {
    ready: "就绪",
    "needs-regenerate": "需重新生成",
    "needs-binding": "需绑定",
    "needs-compile": "需重新编译",
    "needs-restart": "需重启",
  }[state];
}

export function toolchainStatusLabel(status: ProtocolToolchainStatusView): string {
  return { ready: "就绪", missing: "缺失", unverified: "未检查", "unsupported-platform": "平台不支持" }[status];
}

/**
 * In-memory projection of the protocol plan for one task: the protocol repo is
 * `apis`, its consumers are the task's own repositories. Nothing is claimed as
 * generated or bound — the projection starts on release dependencies, and the
 * toolchain is unverified because this mode never probes it.
 */
export function projectProtocolBinding(task: Task): ProtocolBindingView {
  const protocolRepo = "apis";
  const protocolDir = `${task.workspaceRoot}/task-${task.id}/apis`;
  const repos = task.repos.length > 0 ? task.repos : [protocolRepo];
  const consumers: ProtocolConsumerView[] = repos
    .filter((repo) => repo !== protocolRepo)
    .map((repo) => {
      const language: ProtocolConsumerLanguageView = (GO_CONSUMER_REPOS as readonly string[]).includes(repo) ? "go" : "ts";
      const dependency = FIXTURE_RELEASE_DEPENDENCIES[repo] ?? "（未记录发布依赖）";
      const consumerId = repo.replace(/-service$/, "").replace(/-monorepo$/, "");
      return {
        consumerId,
        name: repo,
        language,
        repoDir: `${task.workspaceRoot}/task-${task.id}/${repo}`,
        ...(language === "go" ? { serviceId: repo } : { serviceId: repo === "front-monorepo" ? "saas-bff" : repo }),
        releaseDependency: dependency,
        binding: { kind: "release", dependency },
        state: "ready",
        stateDetail: `使用发布依赖 ${dependency}`,
      };
    });
  const hasProtocolRepo = repos.includes(protocolRepo);
  return {
    taskId: task.id,
    mode: "release",
    simulated: true,
    protocol: { repoDir: protocolDir, goGenDir: `${protocolDir}/gen/go`, tsGenDir: `${protocolDir}/gen/ts` },
    runsGeneration: false,
    generationSteps: [],
    generationReason: hasProtocolRepo ? "协议未改动：保留各消费者原有发布依赖" : "本任务未选择协议仓库（apis）",
    generatedVersion: null,
    consumers,
    prepare: PREPARE_STATES.map(([state, label]) => ({
      state,
      label,
      ok: false,
      detail: "内存模式只显示投影：生成与绑定结果由 Host 报告",
    })),
    toolchain: {
      platform: "",
      ok: false,
      note: "内存模式未探测生成工具",
      desktopLaunchImpliesGeneration: false,
      entries: [],
    },
    blockers: [],
    diagnostics: hasProtocolRepo
      ? []
      : [{ code: "invalid-protocol-repo", message: "本任务未选择协议仓库（apis），无法生成或绑定本地协议" }],
  };
}

/** Map a Host `task/protocolState` payload onto the view (never trusts a missing field). */
export function protocolBindingFromHost(taskId: string, payload: unknown): ProtocolBindingView | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const state = (payload as Record<string, unknown>)["state"] ?? payload;
  if (typeof state !== "object" || state === null || Array.isArray(state)) return undefined;
  const record = state as Record<string, unknown>;
  const protocol = asRecord(record["protocol"]);
  const mode: ProtocolBindingModeView = record["mode"] === "local" ? "local" : "release";
  const generatedVersion = typeof record["generatedVersion"] === "string" ? (record["generatedVersion"] as string) : null;
  const consumersRecord = Array.isArray(record["consumers"]) ? record["consumers"] : [];
  const consumers: ProtocolConsumerView[] = consumersRecord.map((entry) => {
    const consumer = asRecord(entry);
    const binding = asRecord(consumer["binding"]);
    const staleness = asRecord(consumer["staleness"]);
    const resolution = asRecord(consumer["resolution"]);
    const kind = binding["kind"];
    const language: ProtocolConsumerLanguageView = consumer["language"] === "go" ? "go" : "ts";
    const base = {
      consumerId: String(consumer["consumerId"] ?? ""),
      name: String(consumer["name"] ?? ""),
      language,
      repoDir: String(consumer["repoDir"] ?? ""),
      ...(typeof consumer["serviceId"] === "string" ? { serviceId: consumer["serviceId"] as string } : {}),
      releaseDependency: String(consumer["releaseDependency"] ?? ""),
      state: (isConsumerState(staleness["state"]) ? staleness["state"] : "needs-regenerate") as ProtocolConsumerStateView,
      stateDetail: String(staleness["detail"] ?? ""),
      ...(Object.keys(resolution).length > 0
        ? { resolution: { ok: resolution["ok"] === true, message: String(resolution["message"] ?? "") } }
        : {}),
    };
    if (kind === "go-workspace") {
      return {
        ...base,
        binding: {
          kind: "go-workspace" as const,
          path: String(binding["path"] ?? ""),
          useDirectories: asStringArray(binding["useDirectories"]),
          excludedConsumers: asStringArray(binding["excludedConsumers"]),
          releaseManifestsUntouched: asStringArray(binding["releaseManifestsUntouched"]),
        },
      };
    }
    if (kind === "ts-link") {
      const restore = asRecord(binding["restore"]);
      return {
        ...base,
        binding: {
          kind: "ts-link" as const,
          linkPath: String(binding["linkPath"] ?? ""),
          artifact: String(binding["artifact"] ?? ""),
          marker: String(binding["marker"] ?? ""),
          restore: { program: String(restore["program"] ?? ""), args: asStringArray(restore["args"]) },
        },
      };
    }
    return { ...base, binding: { kind: "release" as const, dependency: String(binding["dependency"] ?? base.releaseDependency) } };
  });
  const generation = asRecord(record["generation"]);
  const toolchainRecord = asRecord(record["toolchain"]);
  const blockers = asRecord(record["switchAssessment"])["blockers"];
  return {
    taskId: typeof record["taskId"] === "string" ? (record["taskId"] as string) : taskId,
    mode,
    simulated: false,
    protocol: {
      repoDir: String(protocol["repoDir"] ?? ""),
      goGenDir: String(protocol["goGenDir"] ?? ""),
      tsGenDir: String(protocol["tsGenDir"] ?? ""),
    },
    runsGeneration: generation["runsGeneration"] === true,
    generationSteps: (Array.isArray(generation["steps"]) ? generation["steps"] : []).map((entry) => {
      const step = asRecord(entry);
      return {
        kind: step["kind"] === "postprocess" ? ("postprocess" as const) : ("generate" as const),
        program: String(step["program"] ?? ""),
        args: asStringArray(step["args"]),
        cwd: String(step["cwd"] ?? ""),
        note: String(step["note"] ?? ""),
      };
    }),
    generationReason: String(generation["reason"] ?? ""),
    generatedVersion,
    ...(typeof record["generatedAt"] === "string" ? { generatedAt: record["generatedAt"] as string } : {}),
    consumers,
    prepare: (Array.isArray(record["prepare"]) ? record["prepare"] : []).map((entry) => {
      const row = asRecord(entry);
      return {
        state: String(row["state"] ?? ""),
        label: String(row["label"] ?? ""),
        ok: row["ok"] === true,
        detail: String(row["detail"] ?? ""),
      };
    }),
    toolchain: {
      platform: String(toolchainRecord["platform"] ?? ""),
      ok: toolchainRecord["ok"] === true,
      note: String(toolchainRecord["note"] ?? ""),
      desktopLaunchImpliesGeneration: false,
      entries: (Array.isArray(toolchainRecord["entries"]) ? toolchainRecord["entries"] : []).map((entry) => {
        const tool = asRecord(entry);
        return {
          toolId: String(tool["toolId"] ?? ""),
          label: String(tool["label"] ?? ""),
          status: (isToolchainStatus(tool["status"]) ? tool["status"] : "unverified") as ProtocolToolchainStatusView,
          detail: String(tool["detail"] ?? ""),
          ...(typeof tool["version"] === "string" ? { version: tool["version"] as string } : {}),
        };
      }),
    },
    blockers: (Array.isArray(blockers) ? blockers : []).map((entry) => {
      const blocker = asRecord(entry);
      return { consumerId: String(blocker["consumerId"] ?? ""), code: String(blocker["code"] ?? ""), message: String(blocker["message"] ?? "") };
    }),
    diagnostics: (Array.isArray(record["diagnostics"]) ? record["diagnostics"] : []).map((entry) => {
      const diagnostic = asRecord(entry);
      return { code: String(diagnostic["code"] ?? ""), message: String(diagnostic["message"] ?? "") };
    }),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function isConsumerState(value: unknown): value is ProtocolConsumerStateView {
  return value === "ready" || value === "needs-regenerate" || value === "needs-binding" || value === "needs-compile" || value === "needs-restart";
}

function isToolchainStatus(value: unknown): value is ProtocolToolchainStatusView {
  return value === "ready" || value === "missing" || value === "unverified" || value === "unsupported-platform";
}
