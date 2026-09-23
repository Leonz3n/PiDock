/**
 * Task-local protocol generation and consumer binding for [PiDock 08] (#14).
 *
 * Pure, dependency-free module (same seam style as `service-config.ts` and
 * `service-topology.ts`): main, the utilityProcess Host and unit tests run
 * the same rules. It models the three things #14 requires to stay separate
 * (box 1) and the two binding mechanisms the pilot repository inspection
 * found (`docs/pilot-repository-inspection.md` §apis):
 *
 * - the protocol repository (the apis worktree of this task) — it produces
 *   code, it is never itself a consumer;
 * - generation steps (the repository's own generate + postprocess steps),
 *   which only run in local-debug mode; an unchanged protocol keeps every
 *   consumer on its release dependency (box 2);
 * - consumer bindings: Go consumers get a task-scoped `go.work` naming
 *   exactly one consumer module plus this task's generated module, so other
 *   services' dependency choices are never merged and release manifests are
 *   never rewritten (box 3); TS consumers reuse the repository's own managed
 *   link script, whose link + markers live inside the current task and can be
 *   re-checked and restored after an install (box 4).
 *
 * The remaining boxes are decision rules over caller-supplied observations
 * (never guesses): the resolution path is verified before a compile (box 5),
 * a protocol change marks consumers regenerate/compile/restart and a running
 * instance is never counted as having loaded the new artifact (box 6), a
 * switch back to release dependencies restores the original resolution while
 * another task's dependencies stay untouched (box 7), and the toolchain check
 * returns platform-specific results, with the known Windows ARM64 generation
 * gap explicit and the desktop app launching successfully proving nothing
 * about generation support (box 8).
 *
 * Nothing here spawns a process or touches the filesystem: callers own the
 * real generation run and report what they observed.
 */

export type ProtocolConsumerLanguage = "go" | "ts";

/** Release dependencies vs. this task's generated artifacts (box 2 / box 7). */
export type ProtocolBindingMode = "release" | "local";

export interface ProtocolRepoRef {
  /** Task worktree of the protocol repository (e.g. `<taskDir>/apis`). */
  repoDir: string;
  /** Generated Go module directory of this task (e.g. `<taskDir>/apis/gen/go`). */
  goGenDir: string;
  /** Generated TS package directory of this task (e.g. `<taskDir>/apis/gen/ts`). */
  tsGenDir: string;
}

export interface GenerationStep {
  kind: "generate" | "postprocess";
  /** Explicit program, never a shell string (same rule as service launch). */
  program: string;
  args: string[];
  /** Working directory; must stay inside the protocol repository. */
  cwd: string;
  note: string;
}

export interface ProtocolConsumer {
  consumerId: string;
  name: string;
  /** Task worktree of the consumer repository. */
  repoDir: string;
  language: ProtocolConsumerLanguage;
  /** Run unit the consumer's build feeds (display only). */
  serviceId?: string;
  /** Dependency the consumer declares today (e.g. `github.com/x/apis v0.0.69`). */
  releaseDependency: string;
  /** Repository-provided local-link entry point (TS only, e.g. `proto:link-local`). */
  linkScript?: string;
  /** Explicit app/module the link script selects — never "all apps at once". */
  linkTarget?: string;
}

export type ProtocolErrorCode =
  | "invalid-protocol-repo"
  | "empty-consumers"
  | "invalid-consumer"
  | "duplicate-consumer"
  | "duplicate-consumer-repo"
  | "protocol-repo-is-not-consumer"
  | "missing-link"
  | "invalid-step"
  | "missing-generation-step"
  | "missing-postprocess"
  | "step-outside-protocol-repo"
  | "missing-artifact"
  | "not-generated"
  | "artifact-version-mismatch"
  | "cross-version-unverified"
  | "resolved-elsewhere"
  | "version-mismatch";

export interface ProtocolError {
  code: ProtocolErrorCode;
  message: string;
}

export function protocolError(code: ProtocolErrorCode, message: string): ProtocolError {
  return { code, message };
}

/** Normalize a path for containment comparison (slashes, no trailing separator). */
function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

/** True when `child` lands inside `parent` (strict prefix on a path boundary). */
export function isPathInside(parent: string, child: string): boolean {
  const outer = normalizePath(parent);
  const inner = normalizePath(child);
  if (outer.length === 0 || inner.length === 0) return false;
  return inner === outer || inner.startsWith(`${outer}/`);
}

/**
 * Generation steps follow the service-launch rule: an explicit program plus
 * argv, no inline env assignment, no shell chaining (the desktop app never
 * goes through a shell). Postprocess steps are the repository's own scripts,
 * so the same guard applies to them.
 */
export function validateGenerationStep(step: GenerationStep): ProtocolError | null {
  if (step.kind !== "generate" && step.kind !== "postprocess") {
    return protocolError("invalid-step", `未知的生成步骤类型：${String(step.kind)}`);
  }
  const program = step.program.trim();
  if (program.length === 0) {
    return protocolError("invalid-step", "生成步骤必须填写明确的程序");
  }
  if (/\s/.test(program) || program.includes("=")) {
    return protocolError("invalid-step", `生成步骤的程序必须是单个可执行文件，且不能携带内联环境赋值：${program}`);
  }
  if (/(&&|\|\||[;|`]|\$\()/.test([program, ...step.args].join(" "))) {
    return protocolError("invalid-step", "生成步骤不能使用 shell 连接符；请拆分为明确的程序与参数");
  }
  if (normalizePath(step.cwd).length === 0) {
    return protocolError("invalid-step", "生成步骤必须指定工作目录");
  }
  return null;
}

/**
 * Validate the protocol plan shape before anything else runs: the protocol
 * repository is not a consumer (box 1), consumer ids are unique, and one
 * repository appears at most once per task — two consumers in the same
 * repository would fight over the same `go.work` / `node_modules` link and
 * silently merge dependency choices (box 3 / box 4).
 */
export function validateProtocolPlan(input: {
  protocol: ProtocolRepoRef;
  consumers: readonly ProtocolConsumer[];
}): ProtocolError | null {
  const protocol = input.protocol;
  for (const [label, value] of [
    ["协议仓库目录", protocol.repoDir],
    ["Go 生成目录", protocol.goGenDir],
    ["TS 生成目录", protocol.tsGenDir],
  ] as const) {
    if (normalizePath(value).length === 0) {
      return protocolError("invalid-protocol-repo", `${label}不能为空`);
    }
  }
  if (input.consumers.length === 0) {
    return protocolError("empty-consumers", "请至少选择一个消费者；协议仓库本身不是消费者");
  }
  const ids = new Set<string>();
  const repos = new Set<string>();
  for (const consumer of input.consumers) {
    const id = consumer.consumerId.trim();
    const repoDir = normalizePath(consumer.repoDir);
    if (id.length === 0 || repoDir.length === 0 || consumer.name.trim().length === 0) {
      return protocolError("invalid-consumer", "消费者必须填写标识、名称与仓库目录");
    }
    if (consumer.language !== "go" && consumer.language !== "ts") {
      return protocolError("invalid-consumer", `未知的消费者语言：${String(consumer.language)}`);
    }
    if (
      repoDir === normalizePath(protocol.repoDir) ||
      isPathInside(protocol.repoDir, repoDir) ||
      isPathInside(protocol.goGenDir, repoDir) ||
      isPathInside(protocol.tsGenDir, repoDir)
    ) {
      return protocolError("protocol-repo-is-not-consumer", `「${consumer.name}」是协议仓库（或生成目录）自身，不能作为消费者`);
    }
    if (ids.has(id)) {
      return protocolError("duplicate-consumer", `消费者标识「${id}」重复`);
    }
    if (repos.has(repoDir)) {
      return protocolError("duplicate-consumer-repo", `仓库「${repoDir}」在一个任务里只能绑定一次，避免合并多个消费者的依赖选择`);
    }
    ids.add(id);
    repos.add(repoDir);
    if (consumer.language === "ts" && (consumer.linkScript ?? "").trim().length === 0) {
      return protocolError("missing-link", `TS 消费者「${consumer.name}」缺少仓库提供的本地链接步骤（linkScript）`);
    }
    if (consumer.language === "ts" && (consumer.linkTarget ?? "").trim().length === 0) {
      return protocolError("missing-link", `TS 消费者「${consumer.name}」必须明确链接到哪一个应用（linkTarget），不能一次链接全部`);
    }
  }
  return null;
}

export interface GenerationPlan {
  mode: ProtocolBindingMode;
  runsGeneration: boolean;
  steps: GenerationStep[];
  /** Box 2: with an unchanged protocol every consumer keeps its release dependency. */
  keepsReleaseDependencies: boolean;
  /** Box 7: the release resolution each consumer returns to. */
  releaseResolution: { consumerId: string; language: ProtocolConsumerLanguage; dependency: string }[];
  reason: string;
}

/**
 * Plan the generation steps for one mode. `release` never runs anything and
 * keeps the declared release dependencies. `local` requires a full generation
 * plus the repository's postprocess step (the pilot inspection is explicit
 * that `buf generate` alone is not the repository's contract) and every step
 * must run inside this task's protocol repository, so a stray step can never
 * execute in another task's tree.
 */
export function planGeneration(input: {
  mode: ProtocolBindingMode;
  protocol: ProtocolRepoRef;
  steps: readonly GenerationStep[];
  consumers: readonly ProtocolConsumer[];
}): { ok: true; plan: GenerationPlan } | { ok: false; error: ProtocolError } {
  const releaseResolution = input.consumers.map((consumer) => ({
    consumerId: consumer.consumerId,
    language: consumer.language,
    dependency: consumer.releaseDependency,
  }));
  if (input.mode === "release") {
    return {
      ok: true,
      plan: {
        mode: "release",
        runsGeneration: false,
        steps: [],
        keepsReleaseDependencies: true,
        releaseResolution,
        reason: "协议未改动：保留各消费者原有发布依赖",
      },
    };
  }
  for (const step of input.steps) {
    const invalid = validateGenerationStep(step);
    if (invalid) return { ok: false, error: invalid };
    if (!isPathInside(input.protocol.repoDir, step.cwd)) {
      return {
        ok: false,
        error: protocolError("step-outside-protocol-repo", `生成步骤「${step.program}」的工作目录必须在本任务的协议仓库内：${step.cwd}`),
      };
    }
  }
  if (!input.steps.some((step) => step.kind === "generate")) {
    return { ok: false, error: protocolError("missing-generation-step", "本地联调需要至少一个生成步骤") };
  }
  if (!input.steps.some((step) => step.kind === "postprocess")) {
    return {
      ok: false,
      error: protocolError("missing-postprocess", "本地联调必须包含仓库自己的后处理步骤，不能只执行生成工具"),
    };
  }
  return {
    ok: true,
    plan: {
      mode: "local",
      runsGeneration: true,
      steps: input.steps.map((step) => ({ ...step, args: [...step.args] })),
      keepsReleaseDependencies: false,
      releaseResolution,
      reason: "本地联调：在本任务生成目录执行完整生成与后处理",
    },
  };
}

export interface GoWorkspacePlan {
  consumerId: string;
  /** Task-scoped workspace file; one per consumer, never shared. */
  path: string;
  content: string;
  /** Directories the workspace actually `use`s (exactly two). */
  useDirectories: string[];
  /** Consumers deliberately left out so dependency versions are not merged. */
  excludedConsumers: string[];
  /** Consumer release manifests a task-scoped workspace must never rewrite. */
  releaseManifestsUntouched: string[];
  env: { GOWORK: string };
}

/**
 * Box 3: a Go consumer gets its own task-scoped `go.work` that `use`s exactly
 * one consumer module plus this task's generated Go module. Building through
 * `GOWORK` avoids the one-workspace-for-everything shape that would merge
 * other services' dependency selections, and the plan names the consumer's
 * `go.mod`/`go.sum` as untouched so no release configuration is written back.
 */
export function planGoWorkspace(input: {
  taskId: string;
  protocol: ProtocolRepoRef;
  consumer: ProtocolConsumer;
  allConsumers: readonly ProtocolConsumer[];
  /** Task-scoped directory for generated workspace files (inside the task). */
  workspaceDir: string;
}): { ok: true; plan: GoWorkspacePlan } | { ok: false; error: ProtocolError } {
  if (input.consumer.language !== "go") {
    return { ok: false, error: protocolError("invalid-consumer", `「${input.consumer.name}」不是 Go 消费者`) };
  }
  const consumerRepo = normalizePath(input.consumer.repoDir);
  const goGenDir = normalizePath(input.protocol.goGenDir);
  if (consumerRepo.length === 0 || goGenDir.length === 0) {
    return { ok: false, error: protocolError("invalid-protocol-repo", "Go 工作区需要消费者仓库目录与本任务的 Go 生成目录") };
  }
  const excluded = input.allConsumers
    .filter((candidate) => candidate.consumerId !== input.consumer.consumerId && candidate.language === "go")
    .map((candidate) => candidate.consumerId);
  const path = `${normalizePath(input.workspaceDir)}/go-work/${input.consumer.consumerId}/go.work`;
  const content = `// PiDock ${input.taskId} · ${input.consumer.consumerId}\n// 仅包含本任务：消费者模块 + 本任务生成的协议模块。\ngo 1.26.0\n\nuse (\n\t${consumerRepo}\n\t${goGenDir}\n)\n`;
  return {
    ok: true,
    plan: {
      consumerId: input.consumer.consumerId,
      path,
      content,
      useDirectories: [consumerRepo, goGenDir],
      excludedConsumers: excluded,
      releaseManifestsUntouched: [`${consumerRepo}/go.mod`, `${consumerRepo}/go.sum`],
      env: { GOWORK: path },
    },
  };
}

export interface TsBindingPlan {
  consumerId: string;
  /** Managed link the repository's own script maintains. */
  linkPath: string;
  /** Task-scoped artifact the link must resolve to. */
  artifact: string;
  /** Marker written next to the link so a reinstall can be re-checked. */
  marker: string;
  /** Command that creates/restores the binding (repository's own script). */
  link: { program: string; args: string[] };
  /** Same command re-run after a dependency install (box 4). */
  restore: { program: string; args: string[] };
}

export function tsBindingMarker(input: { taskId: string; consumerId: string; tsGenDir: string }): string {
  return `pidock-local-protocol:${input.taskId}:${input.consumerId}:${normalizePath(input.tsGenDir)}`;
}

/**
 * Box 4: TS consumers reuse the repository's existing managed link. The link
 * lives in the current task's consumer checkout (never a global store), the
 * marker carries this task + consumer + generated dir so a stale marker from
 * another task cannot be mistaken for this binding, and the same command is
 * the documented restore path after a reinstall.
 */
export function planTsBinding(input: {
  taskId: string;
  protocol: ProtocolRepoRef;
  consumer: ProtocolConsumer;
}): { ok: true; plan: TsBindingPlan } | { ok: false; error: ProtocolError } {
  if (input.consumer.language !== "ts") {
    return { ok: false, error: protocolError("invalid-consumer", `「${input.consumer.name}」不是 TS 消费者`) };
  }
  const script = (input.consumer.linkScript ?? "").trim();
  const target = (input.consumer.linkTarget ?? "").trim();
  if (script.length === 0 || target.length === 0) {
    return { ok: false, error: protocolError("missing-link", `TS 消费者「${input.consumer.name}」缺少仓库提供的本地链接步骤或目标应用`) };
  }
  const repoDir = normalizePath(input.consumer.repoDir);
  const artifact = normalizePath(input.protocol.tsGenDir);
  if (artifact.length === 0) {
    return { ok: false, error: protocolError("missing-artifact", "缺少本任务的 TS 生成目录") };
  }
  const command = { program: "pnpm", args: ["run", script, "--app", target] };
  return {
    ok: true,
    plan: {
      consumerId: input.consumer.consumerId,
      linkPath: `${repoDir}/node_modules/@shipber/proto`,
      artifact,
      marker: tsBindingMarker({ taskId: input.taskId, consumerId: input.consumer.consumerId, tsGenDir: artifact }),
      link: { ...command, args: [...command.args] },
      restore: { ...command, args: [...command.args] },
    },
  };
}

export type TsBindingCheckCode = "marker-missing" | "resolved-elsewhere" | "restored";

export interface TsBindingCheck {
  ok: boolean;
  code?: TsBindingCheckCode;
  message: string;
}

/**
 * Re-check a TS binding after an install (box 4). The caller supplies what it
 * really saw: whether the marker is present and where the link resolves to.
 * A missing marker or a resolution outside this task's generated directory
 * fails closed with a restore hint instead of pretending the binding survived.
 */
export function checkTsBinding(input: {
  plan: TsBindingPlan;
  marker: string | null;
  resolvedPath: string | null;
}): TsBindingCheck {
  if (input.marker === null || input.marker.trim().length === 0) {
    return {
      ok: false,
      code: "marker-missing",
      message: `链接标记缺失：请重新执行 ${input.plan.restore.program} ${input.plan.restore.args.join(" ")} 恢复绑定`,
    };
  }
  if (input.marker.trim() !== input.plan.marker) {
    return {
      ok: false,
      code: "resolved-elsewhere",
      message: `链接标记属于其他任务或消费者（${input.marker.trim()}），请重建本任务的绑定`,
    };
  }
  const resolved = normalizePath(input.resolvedPath ?? "");
  if (resolved.length === 0 || !isPathInside(input.plan.artifact, resolved)) {
    return {
      ok: false,
      code: "resolved-elsewhere",
      message: `链接实际解析到 ${resolved.length > 0 ? resolved : "未知路径"}，不是本任务的生成产物 ${input.plan.artifact}`,
    };
  }
  return { ok: true, code: "restored", message: `链接指向本任务生成产物：${resolved}` };
}

export interface LocalSwitchBlocker {
  consumerId: string;
  code: "artifact-version-mismatch" | "cross-version-unverified";
  message: string;
}

export interface LocalSwitchAssessment {
  ok: boolean;
  blockers: LocalSwitchBlocker[];
  notes: string[];
}

/**
 * Box 5: switching to the local artifact stops and explains instead of
 * compiling against something unknown. Two cases block:
 *
 * - a consumer previously verified against a *different* generated version
 *   than the one now on disk (the artifact changed under it);
 * - consumers on *different* release versions switch to the same local
 *   artifact together — cross-language / cross-version compatibility cannot
 *   be assumed (pilot inspection), so each such consumer must be acknowledged
 *   explicitly by the caller.
 */
export function assessLocalSwitch(input: {
  consumers: readonly ProtocolConsumer[];
  artifactVersion: string | null;
  verified: readonly { consumerId: string; artifactVersion: string }[];
  acknowledged?: readonly string[];
}): LocalSwitchAssessment {
  const blockers: LocalSwitchBlocker[] = [];
  const notes: string[] = [];
  const artifact = (input.artifactVersion ?? "").trim();
  if (artifact.length === 0) {
    // Nothing generated yet: there is no artifact to be incompatible with, so
    // the flow continues to generation; `verifyResolvedPath`/staleness carry
    // the not-generated refusal instead of blocking the plan itself.
    notes.push("本任务还没有生成的协议产物版本，请先生成再绑定");
    return { ok: true, blockers, notes };
  }
  for (const consumer of input.consumers) {
    const verified = input.verified.find((entry) => entry.consumerId === consumer.consumerId);
    if (verified && verified.artifactVersion !== artifact) {
      blockers.push({
        consumerId: consumer.consumerId,
        code: "artifact-version-mismatch",
        message: `「${consumer.name}」上次验证的是 ${verified.artifactVersion}，当前本地产物是 ${artifact}；请重新生成并确认后再编译`,
      });
    }
  }
  const releases = new Set(input.consumers.map((consumer) => consumer.releaseDependency.trim()));
  if (input.consumers.length > 1 && releases.size > 1) {
    const acknowledged = new Set(input.acknowledged ?? []);
    for (const consumer of input.consumers) {
      if (acknowledged.has(consumer.consumerId)) continue;
      blockers.push({
        consumerId: consumer.consumerId,
        code: "cross-version-unverified",
        message: `「${consumer.name}」当前是 ${consumer.releaseDependency}，与本任务其他消费者版本不同；不能假定同一本地产物全部兼容，请逐个确认解析路径`,
      });
    }
    notes.push("跨语言/跨版本不能直接比较版本号，逐个消费者确认是必需步骤");
  }
  return { ok: blockers.length === 0, blockers, notes };
}

export interface ResolvedPathCheck {
  ok: boolean;
  code?: ProtocolErrorCode;
  message: string;
}

/**
 * Box 5: verify the resolution path before a compile. In release mode the
 * consumer must *not* resolve into this task's artifact (otherwise the switch
 * back silently kept the local build); in local mode it must resolve inside
 * the task artifact and, when the caller reported a version, that version must
 * match the generated one.
 */
export function verifyResolvedPath(input: {
  mode: ProtocolBindingMode;
  consumer: ProtocolConsumer;
  artifact: { dir: string; version: string | null };
  resolved: { path: string; version?: string | null };
}): ResolvedPathCheck {
  const resolvedPath = normalizePath(input.resolved.path);
  const artifactDir = normalizePath(input.artifact.dir);
  if (resolvedPath.length === 0) {
    return { ok: false, code: "missing-artifact", message: `「${input.consumer.name}」没有可核对的解析路径` };
  }
  if (input.mode === "release") {
    if (artifactDir.length > 0 && isPathInside(artifactDir, resolvedPath)) {
      return {
        ok: false,
        code: "resolved-elsewhere",
        message: `「${input.consumer.name}」仍解析到本任务产物 ${resolvedPath}，尚未回到发布依赖 ${input.consumer.releaseDependency}`,
      };
    }
    return { ok: true, message: `「${input.consumer.name}」解析到发布依赖：${resolvedPath}` };
  }
  if (!isPathInside(artifactDir, resolvedPath)) {
    return {
      ok: false,
      code: "resolved-elsewhere",
      message: `「${input.consumer.name}」解析到 ${resolvedPath}，不在本任务生成目录 ${artifactDir} 内`,
    };
  }
  const expected = (input.artifact.version ?? "").trim();
  const actual = (input.resolved.version ?? "").trim();
  if (expected.length > 0 && actual.length > 0 && expected !== actual) {
    return {
      ok: false,
      code: "version-mismatch",
      message: `「${input.consumer.name}」解析到的产物版本是 ${actual}，本任务已生成的是 ${expected}`,
    };
  }
  return { ok: true, message: `「${input.consumer.name}」解析到本任务产物：${resolvedPath}` };
}

export type ConsumerStalenessState = "ready" | "needs-regenerate" | "needs-binding" | "needs-compile" | "needs-restart";

export interface ConsumerStaleness {
  consumerId: string;
  state: ConsumerStalenessState;
  detail: string;
  /** The generated version this consumer actually loaded, when any. */
  loadedVersion?: string;
}

/**
 * Box 6: after the protocol changes again, every consumer that is bound to the
 * artifact is marked regenerate/compile/restart, and a running instance is
 * reported as *not* having loaded the new artifact (spec: 旧构建或陈旧协议不
 * 算本次修改通过). `loadedVersion` is carried so the UI can show what the
 * instance really has.
 */
export function assessConsumerStaleness(input: {
  consumers: readonly ProtocolConsumer[];
  generatedVersion: string | null;
  bindings: readonly { consumerId: string; artifactVersion: string }[];
  runs: readonly { consumerId: string; runId: string; loadedVersion: string | null; running: boolean }[];
}): ConsumerStaleness[] {
  const generated = (input.generatedVersion ?? "").trim();
  return input.consumers.map((consumer) => {
    if (generated.length === 0) {
      return { consumerId: consumer.consumerId, state: "needs-regenerate" as const, detail: "尚未生成本任务的协议产物" };
    }
    const binding = input.bindings.find((entry) => entry.consumerId === consumer.consumerId);
    if (!binding) {
      return { consumerId: consumer.consumerId, state: "needs-binding" as const, detail: "尚未绑定本任务产物，仍在发布依赖上" };
    }
    if (binding.artifactVersion !== generated) {
      return {
        consumerId: consumer.consumerId,
        state: "needs-compile" as const,
        detail: `绑定的是 ${binding.artifactVersion}，当前产物是 ${generated}；需要重新生成并编译`,
      };
    }
    const run = input.runs.find((entry) => entry.consumerId === consumer.consumerId && entry.running);
    if (run && (run.loadedVersion ?? "").trim() !== generated) {
      return {
        consumerId: consumer.consumerId,
        state: "needs-restart" as const,
        detail: `运行实例 ${run.runId} 加载的是 ${(run.loadedVersion ?? "").trim() || "未知版本"}，不算已加载新协议；请重启后再验证`,
        ...(run.loadedVersion !== null ? { loadedVersion: run.loadedVersion } : {}),
      };
    }
    return { consumerId: consumer.consumerId, state: "ready" as const, detail: `已使用本任务产物 ${generated}` };
  });
}

export type ToolchainStatus = "ready" | "missing" | "unverified" | "unsupported-platform";

export interface GenerationTool {
  id: string;
  label: string;
  /** What the tool is needed for (shown next to the platform result). */
  purpose: string;
}

/** Tools the protocol repository's own generate+postprocess steps need. */
export const GENERATION_TOOLS: readonly GenerationTool[] = [
  { id: "buf", label: "buf", purpose: "协议编译" },
  { id: "protoc-gen-go", label: "protoc-gen-go", purpose: "Go 消息生成" },
  { id: "protoc-gen-go-grpc", label: "protoc-gen-go-grpc", purpose: "Go gRPC 生成" },
  { id: "protoc-gen-es", label: "protoc-gen-es", purpose: "TS 生成（仓库本地插件）" },
  { id: "pnpm", label: "pnpm", purpose: "后处理脚本" },
];

export interface ToolchainEntry {
  toolId: string;
  label: string;
  status: ToolchainStatus;
  detail: string;
  version?: string;
}

export interface ToolchainReport {
  platform: string;
  entries: ToolchainEntry[];
  /** Box 8: a launchable desktop app says nothing about generation support. */
  desktopLaunchImpliesGeneration: false;
  ok: boolean;
  note: string;
}

/**
 * Box 8: platform-specific generation-tool results. Windows ARM64 is a known
 * gap (the repository's plugin installer is explicit about it) and is reported
 * as `unsupported-platform` rather than "unverified", while any other platform
 * reports exactly what the caller probed: absent probes stay `unverified`, not
 * `ready`. Desktop launching is never evidence — the report carries
 * `desktopLaunchImpliesGeneration: false` unconditionally.
 */
export function checkGenerationToolchain(input: {
  platform: string;
  probe?: Readonly<Record<string, { ok: boolean; version?: string; note?: string }>>;
  tools?: readonly GenerationTool[];
}): ToolchainReport {
  const tools = input.tools ?? GENERATION_TOOLS;
  const platform = input.platform.trim();
  const windowsArm64 = platform === "win32-arm64";
  const entries: ToolchainEntry[] = tools.map((tool) => {
    const probed = input.probe?.[tool.id];
    if (windowsArm64) {
      return {
        toolId: tool.id,
        label: tool.label,
        status: "unsupported-platform" as const,
        detail: `${tool.label} 的安装脚本当前明确不支持 Windows ARM64（${tool.purpose}）`,
      };
    }
    if (!probed) {
      return {
        toolId: tool.id,
        label: tool.label,
        status: "unverified" as const,
        detail: `未检查 ${tool.label}（${tool.purpose}）；请先在 ${platform || "当前平台"} 上探测`,
      };
    }
    if (!probed.ok) {
      return {
        toolId: tool.id,
        label: tool.label,
        status: "missing" as const,
        detail: probed.note ?? `缺少 ${tool.label}（${tool.purpose}）`,
      };
    }
    return {
      toolId: tool.id,
      label: tool.label,
      status: "ready" as const,
      detail: `${tool.label} 可用（${tool.purpose}）`,
      ...(probed.version !== undefined ? { version: probed.version } : {}),
    };
  });
  const ok = entries.every((entry) => entry.status === "ready");
  return {
    platform,
    entries,
    desktopLaunchImpliesGeneration: false,
    ok,
    note: windowsArm64
      ? "Windows ARM64 不是首版发布架构；桌面可启动不能推断生成支持，该缺口不阻塞 x64 发布"
      : ok
        ? "生成工具就绪"
        : "生成工具未就绪：缺失项需先安装，未检查项需在本平台探测",
  };
}

export type PrepareStateKey =
  | "code-ready"
  | "toolchain-ready"
  | "deps-installed"
  | "generated"
  | "binding-valid"
  | "runtime-reachable";

export interface PrepareStateEntry {
  state: PrepareStateKey;
  label: string;
  ok: boolean;
  detail: string;
}

const PREPARE_LABELS: Record<PrepareStateKey, string> = {
  "code-ready": "代码就绪",
  "toolchain-ready": "工具链就绪",
  "deps-installed": "依赖已安装",
  generated: "生成物已更新",
  "binding-valid": "本地绑定有效",
  "runtime-reachable": "运行环境可达",
};

/**
 * Box 1: the prepare state the UI shows next to the *actual* generated version
 * — the six states the pilot inspection asked for, kept separate so "generated"
 * never implies "bound" or "reachable". Runtime reachability comes from the
 * #10 topology (caller-supplied), never inferred here.
 */
export function buildPrepareState(input: {
  protocol: ProtocolRepoRef;
  consumers: readonly ProtocolConsumer[];
  generatedVersion: string | null;
  toolchain: ToolchainReport;
  depsInstalled: readonly { consumerId: string; installed: boolean }[];
  bindings: readonly { consumerId: string; artifactVersion: string; resolved: boolean }[];
  runtimeReachable?: { ok: boolean; detail: string };
}): PrepareStateEntry[] {
  const codeOk = normalizePath(input.protocol.repoDir).length > 0 && normalizePath(input.protocol.goGenDir).length > 0 && normalizePath(input.protocol.tsGenDir).length > 0;
  const depsMissing = input.consumers.filter((consumer) => input.depsInstalled.find((entry) => entry.consumerId === consumer.consumerId)?.installed !== true);
  const bindingProblems = input.consumers.filter((consumer) => {
    const binding = input.bindings.find((entry) => entry.consumerId === consumer.consumerId);
    return !binding || !binding.resolved;
  });
  const generated = (input.generatedVersion ?? "").trim();
  return [
    {
      state: "code-ready",
      label: PREPARE_LABELS["code-ready"],
      ok: codeOk,
      detail: codeOk ? `协议仓库 ${normalizePath(input.protocol.repoDir)} 与生成目录已配置` : "协议仓库或生成目录未配置",
    },
    {
      state: "toolchain-ready",
      label: PREPARE_LABELS["toolchain-ready"],
      ok: input.toolchain.ok,
      detail: `${input.toolchain.platform || "未知平台"}：${input.toolchain.note}`,
    },
    {
      state: "deps-installed",
      label: PREPARE_LABELS["deps-installed"],
      ok: depsMissing.length === 0,
      detail: depsMissing.length === 0 ? "所选消费者依赖已安装" : `尚未确认安装：${depsMissing.map((consumer) => consumer.name).join("、")}`,
    },
    {
      state: "generated",
      label: PREPARE_LABELS.generated,
      ok: generated.length > 0,
      detail: generated.length > 0 ? `实际生成版本：${generated}` : "尚未生成；消费者仍在发布依赖上",
    },
    {
      state: "binding-valid",
      label: PREPARE_LABELS["binding-valid"],
      ok: bindingProblems.length === 0,
      detail:
        bindingProblems.length === 0
          ? "所选消费者已绑定本任务产物"
          : `绑定缺失或未验证：${bindingProblems.map((consumer) => consumer.name).join("、")}`,
    },
    {
      state: "runtime-reachable",
      label: PREPARE_LABELS["runtime-reachable"],
      ok: input.runtimeReachable?.ok === true,
      detail: input.runtimeReachable?.detail ?? "运行环境可达性未检查（不等同于生成成功）",
    },
  ];
}
