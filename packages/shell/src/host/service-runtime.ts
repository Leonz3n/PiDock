/**
 * Service runtime domain for [PiDock 04] (#7), S2 slice.
 *
 * Transport-free Host-side records for one service belonging to the task
 * this Host serves: descriptor + resolved env snapshot (with source labels
 * and template version), lifecycle state (never conflates dependency
 * reachability with process liveness), a bounded log buffer, explicit
 * program+args launch plans, and per-platform verification records.
 *
 * Execution policy:
 * - The real spawner is `service-processes.ts` (`TaskServiceProcesses`),
 *   owned by the Host and reachable only through the gated
 *   `task/controlService` path. This module still owns the plan + state
 *   machine + guards; it never calls `child_process` itself.
 * - Only a service registered from main's trusted service catalog
 *   (`launchSource: "catalog"`) carries an executable launch;
 *   `task/registerService` over ordinary task RPC registers display/plan
 *   data that stays fail-closed on control.
 * - `markStarted`/`markStopped` are called by the driver *after* a real
 *   child was spawned or a real stop was confirmed, so `lifecycle`
 *   tracks the process and never a request.
 * - Agent service control goes through the #5 permission gate
 *   (`previewGate("exec.run", …)` on the task's session channel): readonly
 *   denies, default asks (reject/cancel ⇒ zero start/stop), auto allows
 *   task-scoped control. Human-explicit operations bypass no gate — they
 *   are just labelled `human` in the event trail.
 * - No Unix-only inline env assignment: launch plans carry program + argv
 *   separately from the child env built by `buildChildEnv` (S1).
 * - Health is process liveness only: `markDependencyReachable` records a
 *   note, never flips `running`, and no launch performs a reachability
 *   probe that could be mistaken for a health check.
 */

import {
  buildChildEnv,
  recordPlatformLaunch,
  resolveServiceEnv,
  validateServiceDescriptor,
  type ResolvedServiceRow,
  type ServiceConfigEntry,
  type ServiceDescriptor,
  type ServiceRunType,
} from "../main/service-config.js";

/**
 * Where a registered service's launch material came from. Only
 * `catalog` (main's trusted task-bound service catalog) may execute in
 * this slice: a descriptor registered over ordinary task RPC is kept as
 * display/plan data and its control stays fail-closed, so the renderer
 * cannot turn a page-supplied descriptor into an arbitrary local program.
 * The rule is enforced by `authorizeServiceRegistration`'s main-stamped
 * `service-catalog` origin (`host-guards.ts`), never by a caller claim.
 */
export type ServiceLaunchSource = "catalog" | "ui";
import { appendBounded, truncateText } from "../main/bounded-buffer.js";
import { SERVICE_CONTROL_SCOPE } from "../main/pi-session.js";
import { LAUNCH_VERIFICATION_SCHEMA_VERSION } from "./task-store.js";
import type { LaunchVerificationLog } from "./service-launch-verification.js";

export type ServiceLifecycle = "stopped" | "running";

/**
 * The one tool name a Host-minted service-control confirmation is bound to.
 * Service control is not a shell command the user runs; the approval names the
 * gated `exec.run` binding at the service folder so the Host's control
 * sequence, the Agent's service tools and the turn flow all compare against
 * one spelling instead of three.
 */
export const SERVICE_CONTROL_TOOL = "exec.run";

export interface ServiceRecord {
  serviceId: string;
  descriptor: ServiceDescriptor;
  /** Effective env snapshot at last start (masked values ride the UI layer). */
  resolved: ResolvedServiceRow[];
  /** Shared-template version the snapshot was resolved against. */
  templateVersion: string;
  lifecycle: ServiceLifecycle;
  /** Process-liveness only: dependency reachability never sets this. */
  startedAt?: string;
  stoppedAt?: string;
  exitReason?: string;
  /** Last dependency-reachability note (display only, never liveness). */
  dependencyNote?: string;
  log: { at: string; line: string }[];
  events: string[];
  /**
   * Actor of the last start ([PiDock 09] #11): the write coordination reads
   * the owning session of a still-running service, so a leftover process from
   * another session can be detected instead of silently written alongside.
   */
  startedBy?: ServiceControlActor;
  /**
   * The last lifecycle action of this service and who performed it
   * ([PiDock 04] #7 box 5): an Agent-initiated start/stop (`agent:<sessionId>`)
   * and the explicit human action (`human:<label>`) must be told apart wherever
   * the record is read, including the UI-facing projection.
   */
  lastControl?: { action: "start" | "stop"; actor: ServiceControlActor };
  /**
   * Per-platform launch verifications ([PiDock 04] #7 box 7). Each entry is at
   * most one per platform and carries only what the Host really observed:
   * `startedAt` means a real child of this service was confirmed alive on that
   * platform, `stopped`/`stoppedAt` mean that launch was really stopped. An
   * entry without either observation is NOT a verification and never reads as
   * one.
   */
  launchVerifications: ServiceLaunchVerification[];
  /**
   * Main's own read-only observation of the worktree this launch will run in
   * ([PiDock 05] #10 box 6), carried by the trusted-catalog registration. Absent
   * means nobody read the worktree: the run record then says `unknown` by name.
   */
  code?: { commit?: string; dirty: boolean };
  /**
   * Named reason main could NOT read the worktree. Stored (never turned into a
   * code state) so the start path can put it in this service's bounded log.
   */
  codeObservationFailure?: string;
  /** Trusted-catalog registration only; `ui` registrations never execute. */
  launchSource: ServiceLaunchSource;
}

/**
 * One platform's entry in a service's launch-verification record: the shared
 * `PlatformLaunchRecord` fields, with the launch facts OPTIONAL because the
 * pre-existing input shape (`platform`/`nodeVersion`/`ok`/`note`) records a
 * note that observed nothing. Only an entry carrying `startedAt` is a
 * verification; the argv stays in this Host (`publicServiceStatus` never
 * projects it, like the descriptor's own argv).
 */
export interface ServiceLaunchVerification {
  /** `<process.platform>-<process.arch>` observed by the Host that launched (never a caller claim). */
  platform: string;
  /** `process.versions.node` of the Host that launched the child. */
  nodeVersion: string;
  ok: boolean;
  note: string;
  /** Explicit program token that was really spawned, when this entry records a launch. */
  program?: string;
  args?: string[];
  /** ISO time the real child was confirmed alive; present only for an observed launch. */
  startedAt?: string;
  /** True once a real stop of that launch was confirmed. */
  stopped?: boolean;
  stoppedAt?: string;
  /**
   * The installation that observed this launch (`hostInstallationId()`), when
   * bound. A verification is about one installation, so a record copied inside
   * a task workspace between two machines of the same platform does not verify
   * the other one; a record with no binding never reads as verified.
   */
  installationId?: string;
  /** The service template version this launch was observed against. */
  templateVersion?: string;
}

export interface ServiceStartPlan {
  serviceId: string;
  program: string;
  args: string[];
  cwd: string;
  /** Fresh per-child env object (never `process.env`). */
  env: Record<string, string>;
  healthCheck?: ServiceDescriptor["healthCheck"];
  runType: ServiceRunType;
}

export type ServiceControlActor =
  | { kind: "human"; label: string }
  | { kind: "agent"; sessionId: string; permissionAtRequest: string };

const MAX_LOG_LINES = 200;
const MAX_LINE_LENGTH = 2000;

export interface ServiceControlDecision {
  ok: boolean;
  /** Present when the agent path needs approval (`default` tier). */
  approvalId?: string;
  reason: string;
}

/**
 * Server-side verification of a service-control approval against the
 * session channel's live record. A claimed `approvalGranted` is never
 * trusted: the approval must exist, be `approved`, unspent, bound to this
 * service's tool/target, and requested under the `default` tier.
 * Rejected/expired/spent or foreign-service approvals all fail.
 *
 * `executed` deliberately does not gate this: the real `task/approve`
 * path (`PiSessionChannel.approve`) sets `approved + executed:true`
 * before any Host-driven execution runs, so requiring `!executed` would
 * deny every production approval. Single use is enforced instead by
 * `PiSessionChannel.consumeApproval` (the Host spends the request on the
 * first successful control and persists it), so one approval covers one
 * `start` *or* one `stop` of this service (the target is the service
 * folder; the action is not part of the binding).
 *
 * Scope binding: only an approval minted with `SERVICE_CONTROL_SCOPE`
 * qualifies. A turn approval for the same tool + target has no scope and
 * is denied, so one user confirmation can never cover both the turn's
 * command and a Host start/stop.
 *
 * No TTL in this slice:
 * an unconsumed approval stays valid until spent or dropped by restore
 * (restore spends approved requests).
 */
export function verifyServiceControlApproval(input: {
  approval: { status: string; tool: string; target: string; permissionAtRequest: string; consumedAt?: string; scope?: string } | undefined;
  serviceId: string;
  taskDir: string;
}): { ok: true } | { ok: false; reason: string } {
  const approval = input.approval;
  if (!approval) return { ok: false, reason: "服务启停需先确认（批准后重试，拒绝/取消不执行）" };
  if (approval.status !== "approved" || approval.consumedAt !== undefined) {
    return { ok: false, reason: "确认请求已处理或未批准，不可重放" };
  }
  if (approval.permissionAtRequest !== "default") {
    return { ok: false, reason: "服务启停需先确认（批准后重试，拒绝/取消不执行）" };
  }
  if (approval.scope !== SERVICE_CONTROL_SCOPE) return { ok: false, reason: "确认请求与服务启停不匹配（用途未绑定）" };
  if (approval.tool !== SERVICE_CONTROL_TOOL) return { ok: false, reason: "确认请求与服务启停不匹配" };
  const expected = `${input.taskDir}/services/${input.serviceId}`;
  if (approval.target !== expected) return { ok: false, reason: "确认请求与服务启停不匹配" };
  return { ok: true };
}

export class TaskServiceRuntime {
  private readonly services = new Map<string, ServiceRecord>();
  /**
   * Platform verifications carried by this task's durable document, held per
   * service so a service registered after this runtime started still shows the
   * launch a previous Host really verified (a record that survived a restart).
   */
  private readonly persistedVerifications = new Map<string, ServiceLaunchVerification[]>();

  constructor(
    readonly taskDir: string,
    private readonly now: () => string = () => new Date().toISOString(),
    /**
     * Durable per-platform launch verifications of this task
     * (`./service-launch-verification.ts`). Absent keeps them in memory only,
     * which is exactly the pre-existing behaviour; a refused read leaves the
     * platform unverified rather than inventing a pass.
     */
    private readonly verifications: LaunchVerificationLog | undefined = undefined,
  ) {
    if (taskDir.trim().length === 0) throw new Error("taskDir must be non-empty");
    for (const entry of this.verifications?.read() ?? []) {
      const rows = this.persistedVerifications.get(entry.serviceId) ?? [];
      rows.push({
        platform: entry.platform,
        nodeVersion: entry.nodeVersion,
        ok: true,
        note: "",
        program: entry.program,
        args: [...entry.args],
        startedAt: entry.startedAt,
        ...(entry.stopped ? { stopped: true, stoppedAt: entry.stoppedAt } : {}),
        ...(entry.installationId !== undefined ? { installationId: entry.installationId } : {}),
        ...(entry.templateVersion !== undefined ? { templateVersion: entry.templateVersion } : {}),
      });
      this.persistedVerifications.set(entry.serviceId, rows);
    }
  }

  ids(): string[] {
    return [...this.services.keys()].sort();
  }

  get(serviceId: string): ServiceRecord | undefined {
    const record = this.services.get(serviceId);
    if (!record) return undefined;
    // Deep copy: descriptor/rows are entry objects, so a shallow array
    // copy would still let callers mutate Host state through them.
    return {
      ...record,
      descriptor: { ...record.descriptor, args: [...record.descriptor.args], ports: [...record.descriptor.ports], healthCheck: record.descriptor.healthCheck ? { ...record.descriptor.healthCheck } : undefined },
      log: [...record.log.map((entry) => ({ ...entry }))],
      events: [...record.events],
      resolved: [...record.resolved.map((entry) => ({ ...entry }))],
      ...(record.startedBy !== undefined ? { startedBy: { ...record.startedBy } } : {}),
      ...(record.lastControl !== undefined ? { lastControl: { action: record.lastControl.action, actor: { ...record.lastControl.actor } } } : {}),
      ...(record.code !== undefined ? { code: { ...record.code } } : {}),
      launchVerifications: record.launchVerifications.map((entry) => ({ ...entry, ...(entry.args !== undefined ? { args: [...entry.args] } : {}) })),
    };
  }

  /**
   * Services a still-running Agent session started ([PiDock 09] #11).
   * `ownerSessionId` is the session that started it; the write coordination
   * treats a running service whose owner holds no live claim as a leftover
   * the next session must verify/stop before writing. Human-started services
   * (no session) are never leftovers for an Agent session.
   */
  runningAgentOwned(): { serviceId: string; ownerSessionId: string | null }[] {
    return [...this.services.entries()]
      .filter(([, record]) => record.lifecycle === "running" && record.startedBy?.kind === "agent")
      .map(([serviceId, record]) => ({
        serviceId,
        ownerSessionId: record.startedBy?.kind === "agent" ? record.startedBy.sessionId : null,
      }))
      .sort((a, b) => (a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0));
  }

  /**
   * Register (or re-register) a service from its descriptor + env layers +
   * template version. Validates the descriptor (explicit program+args, no
   * inline env) and resolves the env (fail-closed on missing refs /
   * secrets-in-shared). Re-registration keeps the lifecycle/log of a
   * running service and only refreshes the *pending* snapshot; the caller
   * decides restarts via `restartNeeded` (config-save ≠ process-restart).
   */
  register(input: {
    serviceId: string;
    descriptor: ServiceDescriptor;
    layers: {
      repoDefaults: ServiceConfigEntry[];
      shared: ServiceConfigEntry[];
      privateEntries: ServiceConfigEntry[];
      task: ServiceConfigEntry[];
      runtime?: ServiceConfigEntry[];
    };
    templateVersion: string;
    /** Defaults to `ui`: registration alone never enables execution. */
    launchSource?: ServiceLaunchSource;
    /** Main's own observation of the worktree this launch runs in (#10 box 6). */
    code?: { commit?: string; dirty: boolean };
    /** Named reason main could not read the worktree; never a code state. */
    codeObservationFailure?: string;
  }): ServiceRecord {
    if (input.serviceId.trim().length === 0) throw new Error("invalid-payload: serviceId must be a non-empty string");
    const invalid = validateServiceDescriptor(input.descriptor);
    if (invalid) throw new Error(`${invalid.code}: ${invalid.message}`);
    const resolved = resolveServiceEnv(input.layers);
    if (!resolved.ok) throw new Error(`${resolved.error.code}: ${resolved.error.message}`);
    const existing = this.services.get(input.serviceId);
    // A service already launched from main's trusted catalog must not have its
    // executable descriptor replaced by an ordinary task-RPC registration: an
    // attested shell view could otherwise rewrite (or silently disable) a
    // trusted launch. Refused explicitly instead of downgrading it.
    if (existing?.launchSource === "catalog" && input.launchSource !== "catalog") {
      throw new Error("service-registration-conflict: 该服务已由可信服务目录登记，界面配方不能覆盖其可执行描述符");
    }
    const record: ServiceRecord = {
      serviceId: input.serviceId,
      descriptor: {
        ...input.descriptor,
        program: input.descriptor.program.trim(),
        args: [...input.descriptor.args],
        ports: [...input.descriptor.ports],
      },
      resolved: resolved.rows,
      templateVersion: input.templateVersion,
      lifecycle: existing?.lifecycle ?? "stopped",
      startedAt: existing?.startedAt,
      stoppedAt: existing?.stoppedAt,
      exitReason: existing?.exitReason,
      dependencyNote: existing?.dependencyNote,
      log: existing ? [...existing.log] : [],
      // The control trail survives a re-registration: main re-registers the
      // trusted launch right before every control, so dropping it here would
      // erase who last started or stopped the service exactly when the next
      // action is about to be attributed.
      ...(existing?.lastControl !== undefined
        ? { lastControl: { action: existing.lastControl.action, actor: { ...existing.lastControl.actor } } }
        : {}),
      events: [...(existing?.events ?? []), `config:registered:${input.templateVersion}:${input.launchSource ?? "ui"}`],
      launchVerifications: existing
        ? existing.launchVerifications.map((entry) => ({ ...entry, ...(entry.args !== undefined ? { args: [...entry.args] } : {}) }))
        : (this.persistedVerifications.get(input.serviceId) ?? []).map((entry) => ({ ...entry, ...(entry.args !== undefined ? { args: [...entry.args] } : {}) })),
      // The worktree read belongs to THIS registration: main re-registers right
      // before every control, so a dropped observation would leave the next run
      // reading a code state nobody observed. A registration without one clears
      // it (absent stays `unknown`).
      ...(input.code !== undefined ? { code: { commit: input.code.commit, dirty: input.code.dirty } } : {}),
      ...(input.codeObservationFailure !== undefined ? { codeObservationFailure: input.codeObservationFailure } : {}),
      launchSource: input.launchSource ?? "ui",
    };
    this.services.set(input.serviceId, record);
    return this.get(input.serviceId) as ServiceRecord;
  }

  /**
   * Launch plan for a registered service: explicit program + argv + cwd +
   * a fresh per-child env. The plan never embeds env assignments in the
   * argv and never reads `process.env`.
   */
  planStart(serviceId: string, cwd: string): ServiceStartPlan {
    const record = this.services.get(serviceId);
    if (!record) throw new Error(`unknown-service: ${serviceId} is not registered on this task`);
    const trimmedCwd = cwd.trim();
    if (trimmedCwd.length === 0) throw new Error("invalid-payload: cwd must be a non-empty absolute path");
    return this.planFor(record, trimmedCwd);
  }

  /**
   * Launch plan for a registered service, computed from the *registered*
   * descriptor: the program, argv and working directory come from the
   * verified registration, never from the request that asks to start it
   * (the caller only names the serviceId). `TaskServiceProcesses` still
   * re-checks that the directory resolves inside this task root before
   * spawning.
   */
  planRegisteredStart(serviceId: string): ServiceStartPlan {
    const record = this.services.get(serviceId);
    if (!record) throw new Error(`unknown-service: ${serviceId} is not registered on this task`);
    if (record.launchSource !== "catalog") {
      throw new Error("service-execution-unavailable: 仅可信服务目录登记的服务可执行，界面登记的配方尚未接入执行");
    }
    const cwd = record.descriptor.cwd?.trim() ?? "";
    if (cwd.length === 0) throw new Error("invalid-launch: 已注册服务缺少绝对工作目录");
    return this.planFor(record, cwd);
  }

  private planFor(record: ServiceRecord, cwd: string): ServiceStartPlan {
    return {
      serviceId: record.serviceId,
      program: record.descriptor.program,
      args: [...record.descriptor.args],
      cwd,
      env: buildChildEnv(record.resolved),
      healthCheck: record.descriptor.healthCheck,
      runType: record.descriptor.runType,
    };
  }

  /**
   * Redactor for this task's real service output: every resolved secret
   * value is replaced before a line reaches the bounded log. Non-secret
   * rows are kept verbatim (they are display data already shown as
   * effective values). Every *non-empty* secret value is masked, however
   * short: this log is only the child's own bounded output, and unlike
   * `scrubSecretText`'s document rule (which floors known values at 4
   * characters to avoid mangling a whole page) a short private value here
   * can only affect the lines that contain it.
   */
  redactLine(line: string): string {
    let output = line;
    for (const record of this.services.values()) {
      for (const row of record.resolved) {
        if (row.secret && row.value.length > 0) output = output.split(row.value).join("••••••••");
      }
    }
    return output;
  }

  /**
   * Append one real output line of a running service (already redacted by
   * `redactLine`; truncated and bounded by the same buffer as every other
   * entry). Used by the Host's process driver only.
   */
  recordOutput(serviceId: string, line: string): void {
    const record = this.services.get(serviceId);
    if (!record) return;
    this.pushLog(record, line);
  }

  /**
   * Agent control decision through the caller's permission tier (the Host
   * passes the tier it read from the session channel's `previewGate` path,
   * so this function never re-implements the gate — it maps tiers to
   * outcomes): `read` ⇒ deny; `default` ⇒ needs a live, verified approval
   * (verified server-side via `verifyServiceControlApproval`, never a
   * caller-claimed `approvalGranted` booleans, and only for approvals
   * minted with `SERVICE_CONTROL_SCOPE`); `auto` ⇒ allow.
   * Human-UI control is only reachable through the attested human path
   * classified by `classifyControlCaller`; its event label is the
   * audit trail (no gate bypass: the human path is the UI path, auditable
   * by label, not by skipping).
   */
  decideAgentControl(input: {
    serviceId: string;
    action: "start" | "stop";
    tier: "read" | "default" | "auto";
    approval?: { status: string; tool: string; target: string; permissionAtRequest: string; consumedAt?: string; scope?: string } | undefined;
    /** @deprecated caller-claimed booleans are not trusted; pass `approval` instead. */
    approvalGranted?: boolean;
  }): ServiceControlDecision {
    if (!this.services.has(input.serviceId)) {
      return { ok: false, reason: `unknown-service: ${input.serviceId} is not registered on this task` };
    }
    if (input.tier === "read") {
      return { ok: false, reason: "只读会话禁止服务启停，请先调整会话权限" };
    }
    if (input.tier === "default") {
      const verified = verifyServiceControlApproval({ approval: input.approval, serviceId: input.serviceId, taskDir: this.taskDir });
      if (!verified.ok) return { ok: false, reason: verified.reason };
    }
    return { ok: true, reason: `${input.action}:${input.serviceId}` };
  }

  /**
   * Records a start that really happened: the Host driver calls this only
   * after `TaskServiceProcesses.start` resolved with a real child pid.
   * Records the actor label, flips liveness, logs.
   */
  markStarted(serviceId: string, actor: ServiceControlActor, detail?: string): void {
    const record = this.services.get(serviceId);
    if (!record) throw new Error(`unknown-service: ${serviceId} is not registered on this task`);
    record.lifecycle = "running";
    record.startedAt = this.now();
    record.stoppedAt = undefined;
    record.exitReason = undefined;
    record.startedBy = { ...actor };
    record.lastControl = { action: "start", actor: { ...actor } };
    record.events.push(`start:${actor.kind}:${actor.kind === "human" ? actor.label : `${actor.sessionId}:${actor.permissionAtRequest}`}`);
    this.pushLog(record, detail ?? `listening (process alive; dependencies not probed)`);
  }

  /**
   * Records a stop that really happened: the Host driver calls this only
   * after `TaskServiceProcesses.stop` confirmed the registered child's
   * output closed. A `termination-unconfirmed` stop never reaches here.
   * Flips liveness only.
   */
  markStopped(serviceId: string, actor: ServiceControlActor, reason: string): void {
    const record = this.services.get(serviceId);
    if (!record) throw new Error(`unknown-service: ${serviceId} is not registered on this task`);
    record.lifecycle = "stopped";
    record.stoppedAt = this.now();
    record.exitReason = reason;
    record.lastControl = { action: "stop", actor: { ...actor } };
    record.events.push(`stop:${actor.kind}:${actor.kind === "human" ? actor.label : `${actor.sessionId}:${actor.permissionAtRequest}`}:${reason}`);
    this.pushLog(record, `process stopped: ${reason}`);
  }

  /** Process exit (crash): liveness → stopped with the exit reason kept. */
  markExited(serviceId: string, reason: string): void {
    const record = this.services.get(serviceId);
    if (!record) throw new Error(`unknown-service: ${serviceId} is not registered on this task`);
    record.lifecycle = "stopped";
    record.stoppedAt = this.now();
    record.exitReason = reason;
    record.events.push(`exit:${reason}`);
    this.pushLog(record, `process exited: ${reason}`);
  }

  /**
   * Dependency reachability is a note, never liveness: recording that a
   * remote dependency is reachable must not flip `lifecycle` to running.
   */
  markDependencyReachable(serviceId: string, note: string): void {
    const record = this.services.get(serviceId);
    if (!record) throw new Error(`unknown-service: ${serviceId} is not registered on this task`);
    record.dependencyNote = note;
    record.events.push(`dependency:reachable:${note}`);
    this.pushLog(record, `dependency reachable: ${note} (process ${record.lifecycle})`);
  }

  /** Bounded log tail (newest last, at most 200 lines, each ≤2000 chars). */
  serviceLog(serviceId: string, limit = 50): { at: string; line: string }[] {
    const record = this.services.get(serviceId);
    if (!record) throw new Error(`unknown-service: ${serviceId} is not registered on this task`);
    return record.log.slice(-Math.max(1, limit));
  }

  /** Services whose recorded version differs from `adoptedVersion`. */
  restartNeeded(adoptedVersion: string): { serviceId: string; from: string; to: string }[] {
    const out: { serviceId: string; from: string; to: string }[] = [];
    for (const record of this.services.values()) {
      if (record.templateVersion !== adoptedVersion) {
        out.push({ serviceId: record.serviceId, from: record.templateVersion, to: adoptedVersion });
      }
    }
    return out.sort((a, b) => (a.serviceId < b.serviceId ? -1 : 1));
  }

  /**
   * Record one platform's launch verification for this service ([PiDock 04] #7
   * box 7). The production caller is the Host's own service-control dispatch
   * (`service-control.ts`), and only after the process driver confirmed a real
   * child started or a real stop. The record is built by `recordPlatformLaunch`
   * from observations the Host itself made — the platform and node version are
   * this process's own `process` facts, never a caller claim — and what makes a
   * platform read as verified is an observation (`startedAt`), never `ok`:
   * the pre-existing input shape, which names no launch fact, records a note no
   * surface may show as a pass.
   *
   * One entry per platform: a later observation of the same platform merges
   * into it (a stop must not append a second row that hides the start).
   *
   * A durable write is attempted FIRST and the in-memory entry is kept only
   * when it succeeded: a verification the task workspace refused to persist
   * must not surface as verified. The launch itself already happened, so a
   * failed write never fails the control — it leaves the platform unverified
   * and names the reason in the service's own event trail.
   */
  recordLaunchVerification(
    serviceId: string,
    input: {
      platform: string;
      nodeVersion: string;
      ok: boolean;
      note?: string;
      /** The explicit program token of the launch this observation comes from. */
      program?: string;
      /** Its exact argv (kept in this Host; the public projection never sends it). */
      args?: string[];
      /** True when the observation is a confirmed stop of the launch recorded for this platform. */
      stopped?: boolean;
      /**
       * The installation that observed this launch (`hostInstallationId()` at
       * the production caller). Absent leaves the record unbound, which never
       * reads as verified; like `program`/`startedAt` it belongs to the START,
       * so a later stop keeps the installation of the launch it merged into.
       */
      installationId?: string;
    },
  ): void {
    const record = this.services.get(serviceId);
    if (!record) throw new Error(`unknown-service: ${serviceId} is not registered on this task`);
    const at = record.launchVerifications.findIndex((entry) => entry.platform === input.platform);
    const previous = at < 0 ? undefined : record.launchVerifications[at];
    const observedAt = this.now();
    // The launch facts of this platform's entry: a start observation replaces
    // them, any other observation keeps the recorded launch it refers to.
    const launched = input.program !== undefined;
    const program = launched ? input.program : previous?.program;
    const args = launched ? [...(input.args ?? [])] : [...(previous?.args ?? [])];
    const startedAt = launched ? observedAt : previous?.startedAt;
    const stopped = input.stopped === true || previous?.stopped === true;
    const stoppedAt = input.stopped === true ? observedAt : previous?.stoppedAt;
    // The installation and template version are facts of the LAUNCH, not of the
    // observation: a later stop keeps the ones it merged into, so a workspace
    // copied to another installation cannot re-stamp an old launch as its own.
    const installationId = launched ? input.installationId : previous?.installationId;
    const templateVersion = launched ? record.templateVersion : previous?.templateVersion;
    const entry: ServiceLaunchVerification = {
      platform: input.platform,
      nodeVersion: input.nodeVersion,
      ok: input.ok,
      note: input.note ?? "",
      ...(program !== undefined && startedAt !== undefined
        ? {
            ...recordPlatformLaunch({
              program,
              args,
              platform: input.platform,
              nodeVersion: input.nodeVersion,
              ok: input.ok,
              note: input.note,
              startedAt,
              stopped,
              ...(stoppedAt !== undefined ? { stoppedAt } : {}),
            }),
            ...(installationId !== undefined ? { installationId } : {}),
            ...(templateVersion !== undefined ? { templateVersion } : {}),
          }
        : {}),
    };
    // Only an entry that names a real launch is persisted: a stop with no
    // recorded start for this platform verifies no launch, so it stays a note.
    if (program !== undefined && startedAt !== undefined && this.verifications) {
      try {
        this.verifications.record({
          schemaVersion: LAUNCH_VERIFICATION_SCHEMA_VERSION,
          serviceId,
          platform: entry.platform,
          nodeVersion: entry.nodeVersion,
          program,
          args,
          startedAt,
          stopped,
          ...(installationId !== undefined ? { installationId } : {}),
          ...(templateVersion !== undefined ? { templateVersion } : {}),
          ...(stoppedAt !== undefined ? { stoppedAt } : {}),
        });
      } catch (error) {
        record.events.push(`launch-verification-unrecorded:${entry.platform}:${error instanceof Error ? error.message : String(error)}`);
        this.pushLog(record, `平台实测记录未能写入，未记为已验证：${entry.platform}`);
        return;
      }
    }
    if (at < 0) record.launchVerifications.push(entry);
    else record.launchVerifications[at] = entry;
    record.events.push(`launch-verified:${entry.platform}:${entry.startedAt !== undefined ? (entry.stopped === true ? "started+stopped" : "started") : "stop-only"}`);
  }

  private pushLog(record: ServiceRecord, line: string): void {
    appendBounded(record.log, { at: this.now(), line: truncateText(line, MAX_LINE_LENGTH) }, MAX_LOG_LINES);
  }
}
