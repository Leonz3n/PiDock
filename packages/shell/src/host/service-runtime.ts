/**
 * Service runtime domain for [PiDock 04] (#7), S2 slice.
 *
 * Transport-free Host-side records for one service belonging to the task
 * this Host serves: descriptor + resolved env snapshot (with source labels
 * and template version), lifecycle state (never conflates dependency
 * reachability with process liveness), a bounded log buffer, explicit
 * program+args launch plans, and per-platform verification records.
 *
 * Execution policy (never `child_process` here — the real spawner is a
 * later slice; this module owns the plan + state machine + guards):
 * - Agent service control goes through the #5 permission gate
 *   (`previewGate("exec.run", …)` on the task's session channel): readonly
 *   denies, default asks (reject/cancel ⇒ zero start/stop), auto allows
 *   task-scoped control. Human-explicit operations bypass no gate — they
 *   are just labelled `human` in the event trail.
 * - No Unix-only inline env assignment: launch plans carry program + argv
 *   separately from the child env built by `buildChildEnv` (S1).
 * - Health is process liveness only: `markDependencyReachable` records a
 *   note, never flips `running`.
 */

import {
  buildChildEnv,
  resolveServiceEnv,
  validateServiceDescriptor,
  type ResolvedServiceRow,
  type ServiceConfigEntry,
  type ServiceDescriptor,
  type ServiceRunType,
} from "../main/service-config.js";
import { appendBounded, truncateText } from "../main/bounded-buffer.js";
import { SERVICE_CONTROL_SCOPE } from "../main/pi-session.js";

export type ServiceLifecycle = "stopped" | "running";

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
  /** Per-platform launch verifications (program+args, explicit). */
  launchVerifications: { platform: string; nodeVersion: string; ok: boolean; note: string }[];
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
  if (approval.tool !== "exec.run") return { ok: false, reason: "确认请求与服务启停不匹配" };
  const expected = `${input.taskDir}/services/${input.serviceId}`;
  if (approval.target !== expected) return { ok: false, reason: "确认请求与服务启停不匹配" };
  return { ok: true };
}

export class TaskServiceRuntime {
  private readonly services = new Map<string, ServiceRecord>();

  constructor(
    readonly taskDir: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    if (taskDir.trim().length === 0) throw new Error("taskDir must be non-empty");
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
      launchVerifications: [...record.launchVerifications.map((entry) => ({ ...entry }))],
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
  }): ServiceRecord {
    if (input.serviceId.trim().length === 0) throw new Error("invalid-payload: serviceId must be a non-empty string");
    const invalid = validateServiceDescriptor(input.descriptor);
    if (invalid) throw new Error(`${invalid.code}: ${invalid.message}`);
    const resolved = resolveServiceEnv(input.layers);
    if (!resolved.ok) throw new Error(`${resolved.error.code}: ${resolved.error.message}`);
    const existing = this.services.get(input.serviceId);
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
      events: [...(existing?.events ?? []), `config:registered:${input.templateVersion}`],
      launchVerifications: existing ? [...existing.launchVerifications] : [],
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
    return {
      serviceId,
      program: record.descriptor.program,
      args: [...record.descriptor.args],
      cwd: trimmedCwd,
      env: buildChildEnv(record.resolved),
      healthCheck: record.descriptor.healthCheck,
      runType: record.descriptor.runType,
    };
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

  /** Human-explicit start: records the actor label, flips liveness, logs. */
  markStarted(serviceId: string, actor: ServiceControlActor, detail?: string): void {
    const record = this.services.get(serviceId);
    if (!record) throw new Error(`unknown-service: ${serviceId} is not registered on this task`);
    record.lifecycle = "running";
    record.startedAt = this.now();
    record.stoppedAt = undefined;
    record.exitReason = undefined;
    record.startedBy = { ...actor };
    record.events.push(`start:${actor.kind}:${actor.kind === "human" ? actor.label : `${actor.sessionId}:${actor.permissionAtRequest}`}`);
    this.pushLog(record, detail ?? `listening (process alive; dependencies not probed)`);
  }

  /** Human-explicit or approved-agent stop: flips liveness only. */
  markStopped(serviceId: string, actor: ServiceControlActor, reason: string): void {
    const record = this.services.get(serviceId);
    if (!record) throw new Error(`unknown-service: ${serviceId} is not registered on this task`);
    record.lifecycle = "stopped";
    record.stoppedAt = this.now();
    record.exitReason = reason;
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

  recordLaunchVerification(
    serviceId: string,
    input: { platform: string; nodeVersion: string; ok: boolean; note?: string },
  ): void {
    const record = this.services.get(serviceId);
    if (!record) throw new Error(`unknown-service: ${serviceId} is not registered on this task`);
    record.launchVerifications.push({
      platform: input.platform,
      nodeVersion: input.nodeVersion,
      ok: input.ok,
      note: input.note ?? "",
    });
    record.events.push(`launch-verified:${input.platform}:${input.ok ? "ok" : "fail"}`);
  }

  private pushLog(record: ServiceRecord, line: string): void {
    appendBounded(record.log, { at: this.now(), line: truncateText(line, MAX_LINE_LENGTH) }, MAX_LOG_LINES);
  }
}
