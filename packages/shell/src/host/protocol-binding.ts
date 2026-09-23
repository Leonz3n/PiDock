/**
 * Host-side task-local protocol state for [PiDock 08] (#14).
 *
 * One per task workspace (sibling to `TaskServiceTopology` and
 * `TaskServiceRuntime`, same fork binding: the task folder the Host serves).
 * It owns the *task-scoped* state the pure rules in
 * `main/protocol-binding.ts` compute over:
 *
 * - the protocol repository reference, the binding mode and the generation
 *   plan (release dependencies vs. this task's generated artifact);
 * - the per-consumer binding plans (Go task-scoped `go.work`, TS managed
 *   link) plus the real observations the caller reported: the generated
 *   version, the toolchain probe, dependency installs and what each
 *   consumer's resolution actually points at;
 * - the prepare state and the staleness marks (regenerate / bind / compile /
 *   restart) the UI shows;
 * - the switch assessment that stops a cross-version switch onto one local
 *   artifact until each consumer is acknowledged.
 *
 * Fail-closed: an invalid plan throws (the Host envelope turns it into
 * `{ok:false}`), every planned path must stay inside this task folder, and a
 * consumer is only marked bound when its reported resolution really verifies
 * — a failing resolution or an unacknowledged cross-version switch leaves the
 * consumer unbound with a diagnostic instead of a green check. Nothing here
 * spawns a process, writes files or fabricates results: callers report what
 * they really ran and saw.
 */

import {
  assessConsumerStaleness,
  assessLocalSwitch,
  buildPrepareState,
  checkGenerationToolchain,
  isPathInside,
  planGeneration,
  planGoWorkspace,
  planTsBinding,
  validateProtocolPlan,
  verifyResolvedPath,
  type ConsumerStaleness,
  type GenerationPlan,
  type GenerationStep,
  type GoWorkspacePlan,
  type LocalSwitchAssessment,
  type PrepareStateEntry,
  type ProtocolBindingMode,
  type ProtocolConsumer,
  type ProtocolError,
  type ProtocolRepoRef,
  type ResolvedPathCheck,
  type ToolchainReport,
  type TsBindingPlan,
} from "../main/protocol-binding.js";

export interface ProtocolPlanInput {
  protocol: ProtocolRepoRef;
  mode: ProtocolBindingMode;
  steps?: GenerationStep[];
  consumers: ProtocolConsumer[];
  /** Consumers the caller explicitly confirms for a cross-version switch. */
  acknowledged?: string[];
}

export interface ProtocolObservationInput {
  /** The version this task's artifact carries after a real generation run. */
  generatedVersion: string;
  ok: boolean;
  note?: string;
  /** Result of really probing the generation tools on this platform. */
  toolchain?: { platform: string; probe?: Record<string, { ok: boolean; version?: string; note?: string }> };
  depsInstalled?: { consumerId: string; installed: boolean }[];
  /** What each consumer's resolution really points at (compile-time check). */
  resolutions?: { consumerId: string; path: string; version?: string | null }[];
  runtimeReachable?: { ok: boolean; detail: string };
}

export interface ProtocolRunRef {
  consumerId: string;
  runId: string;
  /** Protocol artifact version the instance actually loaded (null = unknown). */
  loadedVersion: string | null;
  running: boolean;
}

export interface ProtocolConsumerView {
  consumerId: string;
  name: string;
  language: ProtocolConsumer["language"];
  repoDir: string;
  serviceId?: string;
  releaseDependency: string;
  mode: ProtocolBindingMode;
  binding:
    | { kind: "release"; dependency: string }
    | { kind: "go-workspace"; path: string; useDirectories: string[]; excludedConsumers: string[]; releaseManifestsUntouched: string[]; env: { GOWORK: string } }
    | { kind: "ts-link"; linkPath: string; artifact: string; marker: string; link: { program: string; args: string[] }; restore: { program: string; args: string[] } };
  resolution?: ResolvedPathCheck;
  staleness: ConsumerStaleness;
}

export interface ProtocolStateView {
  taskId: string;
  taskDir: string;
  protocol: ProtocolRepoRef;
  mode: ProtocolBindingMode;
  generation: GenerationPlan;
  generatedVersion: string | null;
  generatedAt?: string;
  generationHistory: { version: string; at: string; ok: boolean; note: string }[];
  consumers: ProtocolConsumerView[];
  switchAssessment: LocalSwitchAssessment;
  toolchain: ToolchainReport;
  prepare: PrepareStateEntry[];
  diagnostics: ProtocolError[];
  observations: { at: string; note: string; ok: boolean }[];
}

export function protocolDiagnostic(code: ProtocolError["code"], message: string): ProtocolError {
  return { code, message };
}

export class TaskProtocolBinding {
  private protocol: ProtocolRepoRef | null = null;
  private mode: ProtocolBindingMode = "release";
  private steps: GenerationStep[] = [];
  private consumers: ProtocolConsumer[] = [];
  private acknowledged: string[] = [];
  private generatedVersion: string | null = null;
  private generatedAt: string | undefined;
  private readonly history: { version: string; at: string; ok: boolean; note: string }[] = [];
  private readonly observations: { at: string; note: string; ok: boolean }[] = [];
  private toolchainProbe: ProtocolObservationInput["toolchain"] | undefined;
  private depsInstalled: { consumerId: string; installed: boolean }[] = [];
  private resolutions: { consumerId: string; path: string; version?: string | null }[] = [];
  private runtimeReachable: { ok: boolean; detail: string } | undefined;
  /** Consumers whose reported resolution really verified (binding-valid). */
  private bound: { consumerId: string; artifactVersion: string }[] = [];

  constructor(
    readonly taskId: string,
    readonly taskDir: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    if (taskId.trim().length === 0) throw new Error("invalid-payload: taskId must be non-empty");
    if (taskDir.trim().length === 0) throw new Error("invalid-payload: taskDir must be non-empty");
  }

  /**
   * Replace the protocol plan. The plan is validated (protocol repo is not a
   * consumer, unique consumer ids/repos, TS consumers name their link) and
   * every task-scoped path the plan yields must land inside this task folder,
   * so nothing here can silently act on another task's tree (box 7).
   * Bindings are cleared: the previous resolutions described the previous
   * consumer set.
   */
  setPlan(input: ProtocolPlanInput, runs: readonly ProtocolRunRef[] = []): ProtocolStateView {
    const invalid = validateProtocolPlan({ protocol: input.protocol, consumers: input.consumers });
    if (invalid) throw new Error(`${invalid.code}: ${invalid.message}`);
    const planned = planGeneration({ mode: input.mode, protocol: input.protocol, steps: input.steps ?? [], consumers: input.consumers });
    if (!planned.ok) throw new Error(`${planned.error.code}: ${planned.error.message}`);
    // The protocol repository and its generation directories are task-scoped
    // like the consumers: a plan pointing them at another task's tree would
    // make the "every planned path stays inside this task folder" guarantee
    // false before any step runs.
    for (const [label, value] of [
      ["协议仓库目录", input.protocol.repoDir],
      ["Go 生成目录", input.protocol.goGenDir],
      ["TS 生成目录", input.protocol.tsGenDir],
    ] as const) {
      if (!isPathInside(this.taskDir, value)) {
        throw new Error(`invalid-protocol-repo: ${label}不在本任务内：${value}`);
      }
    }
    for (const consumer of input.consumers) {
      if (!isPathInside(this.taskDir, consumer.repoDir)) {
        throw new Error(`invalid-consumer: 消费者「${consumer.name}」的仓库目录不在本任务内：${consumer.repoDir}`);
      }
    }
    const workspaces = this.planWorkspaces(input.protocol, input.consumers);
    const links = this.planLinks(input.protocol, input.consumers);
    this.protocol = input.protocol;
    this.mode = input.mode;
    this.steps = input.steps ?? [];
    this.consumers = input.consumers.map((consumer) => ({ ...consumer }));
    this.acknowledged = [...(input.acknowledged ?? [])];
    this.depsInstalled = [];
    this.resolutions = [];
    this.runtimeReachable = undefined;
    this.bound = [];
    // Re-check the task-scoped plan paths (workspaces and links) as well.
    for (const plan of [...workspaces, ...links.map((link) => ({ path: link.linkPath }))]) {
      if (!isPathInside(this.taskDir, plan.path)) {
        throw new Error(`step-outside-protocol-repo: 计划中的路径不在本任务内：${plan.path}`);
      }
    }
    return this.state(runs);
  }

  private planWorkspaces(protocol: ProtocolRepoRef, consumers: readonly ProtocolConsumer[]): GoWorkspacePlan[] {
    const plans: GoWorkspacePlan[] = [];
    for (const consumer of consumers) {
      if (consumer.language !== "go") continue;
      const planned = planGoWorkspace({
        taskId: this.taskId,
        protocol,
        consumer,
        allConsumers: consumers,
        workspaceDir: `${this.taskDir.replace(/\/+$/, "")}/protocol`,
      });
      if (planned.ok) plans.push(planned.plan);
    }
    return plans;
  }

  private planLinks(protocol: ProtocolRepoRef, consumers: readonly ProtocolConsumer[]): TsBindingPlan[] {
    const plans: TsBindingPlan[] = [];
    for (const consumer of consumers) {
      if (consumer.language !== "ts") continue;
      const planned = planTsBinding({ taskId: this.taskId, protocol, consumer });
      if (planned.ok) plans.push(planned.plan);
    }
    return plans;
  }

  /**
   * Record what a real generation/binding run observed. `ok` requires a
   * non-empty generated version (an unversioned artifact cannot be verified).
   * A consumer is marked bound only when its reported resolution verifies
   * (box 5) *and* the cross-version switch assessment has no blocker (box 5 /
   * pilot: versions cannot be compared across languages), otherwise the
   * consumer stays unbound with a diagnostic explaining the stop.
   */
  recordResult(input: ProtocolObservationInput, runs: readonly ProtocolRunRef[] = []): ProtocolStateView {
    if (this.protocol === null) {
      throw new Error("invalid-payload: 还没有协议计划，请先设置协议仓库与消费者");
    }
    const version = input.generatedVersion.trim();
    if (input.ok && version.length === 0) {
      throw new Error("not-generated: 生成成功必须带回实际生成版本");
    }
    const at = this.now();
    // Only a run that really succeeded may advance the displayed version; a
    // failed attempt is kept in the history but never shown as "已生成".
    if (input.ok && version.length > 0) {
      this.generatedVersion = version;
      this.generatedAt = at;
    }
    this.history.push({ version, at, ok: input.ok, note: input.note ?? "" });
    this.observations.push({ at, note: input.note ?? "", ok: input.ok });
    if (input.toolchain) this.toolchainProbe = input.toolchain;
    if (input.depsInstalled) this.depsInstalled = input.depsInstalled.map((entry) => ({ ...entry }));
    if (input.runtimeReachable) this.runtimeReachable = { ...input.runtimeReachable };
    this.resolutions = (input.resolutions ?? []).map((entry) => ({ ...entry }));
    const knownConsumers = new Set(this.consumers.map((consumer) => consumer.consumerId));
    for (const resolution of this.resolutions) {
      if (!knownConsumers.has(resolution.consumerId)) {
        throw new Error(`invalid-consumer: 未知消费者 ${resolution.consumerId} 的解析结果`);
      }
    }
    // Recompute the verified bindings from the reported resolutions. A
    // consumer being re-verified now replaces its previous binding, so a
    // freshly generated artifact does not block the consumer that just
    // resolved against it (box 5); one that was *not* re-verified keeps its
    // previous binding (it really still resolves to the older artifact) and is
    // reported as a mismatch instead of a green check.
    const reverified = new Set(this.resolutions.map((entry) => entry.consumerId));
    const previous = new Map(this.bound.map((entry) => [entry.consumerId, entry]));
    const switchAssessment = assessLocalSwitch({
      consumers: this.consumers,
      artifactVersion: this.generatedVersion,
      verified: this.bound.filter((entry) => !reverified.has(entry.consumerId)),
      acknowledged: this.acknowledged,
    });
    const blocked = new Set(switchAssessment.blockers.map((blocker) => blocker.consumerId));
    this.bound = [];
    for (const consumer of this.consumers) {
      const kept = previous.get(consumer.consumerId);
      const resolution = this.resolutions.find((entry) => entry.consumerId === consumer.consumerId);
      if (resolution === undefined || blocked.has(consumer.consumerId)) {
        if (kept) this.bound.push(kept);
        continue;
      }
      if (!input.ok || this.mode !== "local") continue;
      const checked = verifyResolvedPath({
        mode: this.mode,
        consumer,
        artifact: { dir: this.artifactDir(consumer), version: this.generatedVersion },
        resolved: resolution,
      });
      if (checked.ok) this.bound.push({ consumerId: consumer.consumerId, artifactVersion: this.generatedVersion ?? version });
    }
    return this.state(runs);
  }

  private artifactDir(consumer: ProtocolConsumer): string {
    return consumer.language === "go" ? (this.protocol?.goGenDir ?? "") : (this.protocol?.tsGenDir ?? "");
  }

  /** Diagnostics the current state cannot express as a per-consumer check. */
  private diagnostics(): ProtocolError[] {
    const list: ProtocolError[] = [];
    if (this.protocol === null) {
      list.push(protocolDiagnostic("invalid-protocol-repo", "尚未设置协议仓库与消费者"));
      return list;
    }
    if (this.mode === "local" && this.generatedVersion === null) {
      list.push(protocolDiagnostic("not-generated", "本地联调还没有生成产物版本，消费者仍在发布依赖上"));
    }
    for (const blocker of this.switchAssessment().blockers) {
      list.push(protocolDiagnostic(blocker.code, blocker.message));
    }
    for (const consumer of this.consumers) {
      const resolution = this.resolutions.find((entry) => entry.consumerId === consumer.consumerId);
      if (!resolution) continue;
      const checked = verifyResolvedPath({
        mode: this.mode,
        consumer,
        artifact: { dir: this.artifactDir(consumer), version: this.generatedVersion },
        resolved: resolution,
      });
      if (!checked.ok && checked.code) list.push(protocolDiagnostic(checked.code, checked.message));
    }
    return list;
  }

  private switchAssessment(): LocalSwitchAssessment {
    // Release mode runs no local switch at all, so there is nothing to block:
    // reporting blockers here would show a stop reason in a healthy plan.
    if (this.mode !== "local") return { ok: true, blockers: [], notes: [] };
    return assessLocalSwitch({
      consumers: this.consumers,
      artifactVersion: this.generatedVersion,
      verified: this.bound,
      acknowledged: this.acknowledged,
    });
  }

  state(runs: readonly ProtocolRunRef[] = []): ProtocolStateView {
    const protocol = this.protocol ?? { repoDir: "", goGenDir: "", tsGenDir: "" };
    const generation = planGeneration({
      mode: this.mode,
      protocol,
      steps: this.steps,
      consumers: this.consumers,
    });
    const generationPlan: GenerationPlan = generation.ok
      ? generation.plan
      : { mode: this.mode, runsGeneration: false, steps: [], keepsReleaseDependencies: this.mode === "release", releaseResolution: [], reason: generation.error.message };
    const workspaces = this.protocol ? this.planWorkspaces(this.protocol, this.consumers) : [];
    const links = this.protocol ? this.planLinks(this.protocol, this.consumers) : [];
    const switchAssessment = this.switchAssessment();
    const toolchain = checkGenerationToolchain({
      platform: this.toolchainProbe?.platform ?? "",
      ...(this.toolchainProbe?.probe !== undefined ? { probe: this.toolchainProbe.probe } : {}),
    });
    const staleness = assessConsumerStaleness({
      consumers: this.consumers,
      generatedVersion: this.generatedVersion,
      bindings: this.bound,
      runs,
    });    const consumers: ProtocolConsumerView[] = this.consumers.map((consumer) => {
      const workspace = workspaces.find((plan) => plan.consumerId === consumer.consumerId);
      const link = links.find((plan) => plan.consumerId === consumer.consumerId);
      const resolution = this.resolutions.find((entry) => entry.consumerId === consumer.consumerId);
      const check = resolution
        ? verifyResolvedPath({
            mode: this.mode,
            consumer,
            artifact: { dir: this.artifactDir(consumer), version: this.generatedVersion },
            resolved: resolution,
          })
        : undefined;
      return {
        consumerId: consumer.consumerId,
        name: consumer.name,
        language: consumer.language,
        repoDir: consumer.repoDir,
        ...(consumer.serviceId !== undefined ? { serviceId: consumer.serviceId } : {}),
        releaseDependency: consumer.releaseDependency,
        mode: this.mode,
        binding:
          this.mode === "release"
            ? { kind: "release", dependency: consumer.releaseDependency }
            : workspace
              ? {
                  kind: "go-workspace",
                  path: workspace.path,
                  useDirectories: [...workspace.useDirectories],
                  excludedConsumers: [...workspace.excludedConsumers],
                  releaseManifestsUntouched: [...workspace.releaseManifestsUntouched],
                  env: { ...workspace.env },
                }
              : link
                ? {
                    kind: "ts-link",
                    linkPath: link.linkPath,
                    artifact: link.artifact,
                    marker: link.marker,
                    link: { ...link.link, args: [...link.link.args] },
                    restore: { ...link.restore, args: [...link.restore.args] },
                  }
                : { kind: "release", dependency: consumer.releaseDependency },
        ...(check !== undefined ? { resolution: check } : {}),
        staleness:
          this.mode === "release"
            ? { consumerId: consumer.consumerId, state: "ready" as const, detail: `使用发布依赖 ${consumer.releaseDependency}` }
            : (staleness.find((entry) => entry.consumerId === consumer.consumerId) ?? {
                consumerId: consumer.consumerId,
                state: "needs-regenerate" as const,
                detail: "尚未生成",
              }),
      };
    });
    return {
      taskId: this.taskId,
      taskDir: this.taskDir,
      protocol,
      mode: this.mode,
      generation: generationPlan,
      generatedVersion: this.generatedVersion,
      ...(this.generatedAt !== undefined ? { generatedAt: this.generatedAt } : {}),
      generationHistory: this.history.map((entry) => ({ ...entry })),
      consumers,
      switchAssessment,
      toolchain,
      prepare: buildPrepareState({
        protocol,
        consumers: this.consumers,
        generatedVersion: this.generatedVersion,
        toolchain,
        depsInstalled: this.depsInstalled,
        bindings: this.bound.map((entry) => ({ consumerId: entry.consumerId, artifactVersion: entry.artifactVersion, resolved: true })),
        ...(this.runtimeReachable !== undefined ? { runtimeReachable: this.runtimeReachable } : {}),
      }),
      diagnostics: this.diagnostics(),
      observations: this.observations.map((entry) => ({ ...entry })),
    };
  }
}
