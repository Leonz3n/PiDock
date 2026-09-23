/**
 * Host-side scheduled tasks for [PiDock 18] (#20).
 *
 * Wraps the pure rules of `main/schedule-rules.ts` with the three things the
 * Host owes and the rules must not know about:
 *
 * - **persistence**: `<taskDir>/schedules.json` (via `TaskStore`), written after
 *   every config change and every trigger, so a reopen lists the same schedules
 *   *and* the same run history (each run keeps the config version, provider,
 *   model, permission and rule it actually used);
 * - **identity**: `schedule-<n>` and `run-<n>` ids re-seeded from the restored
 *   record, so a restarted Host never re-mints an id an earlier process used
 *   (which would collapse two runs into one history row);
 * - **execution**: a trigger starts one *independent* session in the same task
 *   workspace (`scheduled-<n>`), never a reused conversation, and the run is the
 *   only thing that advances the plan.
 *
 * Every trigger — due evaluation and 立即运行 — goes through one synchronous claim
 * (`performRun`): the Host is single-threaded, so a due trigger and a manual run
 * that race each other still produce exactly one result. Nothing here runs on a
 * timer of its own: `evaluateDue` is called by the Host's read path, and the
 * occurrence key recorded with each run makes a repeated evaluation harmless.
 */

import {
  applyScheduleTemplate,
  describeRule,
  highestSequence,
  isIanaTimezone,
  manualRunKey,
  nextTriggerAt,
  occurrenceKey,
  occurrencesBetween,
  parseRuleText,
  planTrigger,
  scheduledApprovalDeadline,
  scheduledSessionId,
  scheduleConfigIssue,
  SCHEDULE_TEMPLATES,
  validateScheduleConfig,
  type ScheduledRunRecord,
  type ScheduledRunResult,
  type ScheduleDiskRecord,
  type ScheduleTemplateDefinition,
  type StoredSchedule,
  type TriggerDecision,
} from "../main/schedule-rules.js";

/** The persistence slice this manager needs (satisfied by `TaskStore`). */
export interface ScheduleStore {
  readSchedules(taskDir: string): ScheduleDiskRecord;
  writeSchedules(taskDir: string, record: ScheduleDiskRecord): void;
}

/** What starting one scheduled session reported about its single turn. */
export interface ScheduleStartResult {
  state: "done" | "approval" | "failed";
  approvalId?: string;
  failureReason?: string;
}

export interface SchedulePorts {
  /** Create the run's own session and send the prompt exactly once. */
  startRun(input: {
    runId: string;
    sessionId: string;
    schedule: StoredSchedule;
    /** Deadline for a confirmation this run waits on: min(24h, next plan). */
    approvalExpiresAt: string;
  }): ScheduleStartResult;
  /** A previous run of this schedule is still executing or waiting on a confirmation. */
  liveExecution(scheduleId: string): boolean;
  /** The task is archived: scheduling is paused and 立即运行 refuses too. */
  archived(): boolean;
  /** Provider catalog as the Host knows it; empty = not handed one yet. */
  catalog(): readonly { id: string; enabled?: boolean; models: readonly { id: string }[] }[];
  now(): string;
}

export interface SaveScheduleInput {
  scheduleId?: string;
  projectId?: string;
  name: string;
  ruleText: string;
  timezone: string;
  prompt: string;
  providerId: string;
  model: string;
  permission: StoredSchedule["permission"];
  enabled?: boolean;
  extraKeys?: readonly string[];
}

export type SaveScheduleResult =
  | { ok: true; schedule: StoredSchedule }
  | { ok: false; code: string; message: string };

export type SchedulePreview =
  | { ok: true; description: string; nextTriggerAt: string | null }
  | { ok: false; code: string; message: string };

export class TaskSchedules {
  private recordState: ScheduleDiskRecord;
  private scheduleSequence: number;
  private runSequence: number;

  constructor(
    private readonly taskId: string,
    private readonly taskDir: string,
    private readonly store: ScheduleStore,
    private readonly ports: SchedulePorts,
  ) {
    this.recordState = store.readSchedules(taskDir);
    this.scheduleSequence = highestSequence(
      this.recordState.schedules.map((schedule) => schedule.scheduleId),
      "schedule",
    );
    this.runSequence = highestSequence(
      this.recordState.runs.map((run) => run.runId),
      "run",
    );
  }

  /** Copy of the persisted record (read-only callers never mutate the live one). */
  get record(): ScheduleDiskRecord {
    return {
      version: this.recordState.version,
      schedules: this.recordState.schedules.map(cloneSchedule),
      runs: this.recordState.runs.map((run) => ({ ...run })),
    };
  }

  list(): StoredSchedule[] {
    return this.recordState.schedules.map(cloneSchedule);
  }

  find(scheduleId: string): StoredSchedule | undefined {
    const schedule = this.recordState.schedules.find((item) => item.scheduleId === scheduleId);
    return schedule === undefined ? undefined : cloneSchedule(schedule);
  }

  /** Trigger history, newest first; `scheduleId` narrows, absent = all. */
  runs(scheduleId?: string): ScheduledRunRecord[] {
    return this.recordState.runs
      .filter((run) => scheduleId === undefined || run.scheduleId === scheduleId)
      .map((run) => ({ ...run }))
      .sort((a, b) => (a.startedAt === b.startedAt ? (a.runId < b.runId ? 1 : -1) : a.startedAt < b.startedAt ? 1 : -1));
  }

  templates(): ScheduleTemplateDefinition[] {
    return SCHEDULE_TEMPLATES.map((template) => ({ ...template }));
  }

  /** Validate one rule text against its zone and preview the next trigger (盒子 1). */
  preview(input: { ruleText: string; timezone: string; after?: string }): SchedulePreview {
    if (!isIanaTimezone(input.timezone)) {
      return { ok: false, code: "timezone-invalid", message: `时区 ${input.timezone || "(空)"} 不是 IANA 时区` };
    }
    const parsed = parseRuleText(input.ruleText, input.timezone);
    if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message };
    return {
      ok: true,
      description: describeRule(parsed.rule),
      nextTriggerAt: nextTriggerAt(parsed.rule, { after: input.after ?? this.ports.now() }),
    };
  }

  /**
   * Create or update one schedule (盒子 1). Every field the run path relies on is
   * validated before the record changes, so nothing half-invalid is persisted; a
   * later invalidation (Provider removed) is reported by the run path instead.
   */
  save(input: SaveScheduleInput): SaveScheduleResult {
    const now = this.ports.now();
    const result = validateScheduleConfig({
      providerId: input.providerId,
      model: input.model,
      permission: input.permission,
      prompt: input.prompt,
      timezone: input.timezone,
      ruleText: input.ruleText,
      catalog: this.ports.catalog(),
      ...(input.extraKeys !== undefined ? { extraKeys: input.extraKeys } : {}),
    });
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    if (input.name.trim().length === 0) return { ok: false, code: "name-empty", message: "定时任务名称不能为空" };
    const existing = input.scheduleId === undefined ? undefined : this.recordState.schedules.find((item) => item.scheduleId === input.scheduleId);
    if (input.scheduleId !== undefined && existing === undefined) {
      return { ok: false, code: "unknown-schedule", message: `定时任务 ${input.scheduleId} 不存在` };
    }
    const schedule: StoredSchedule = {
      scheduleId: existing?.scheduleId ?? `schedule-${(this.scheduleSequence += 1)}`,
      taskId: this.taskId,
      name: input.name.trim(),
      ruleText: input.ruleText.trim(),
      timezone: input.timezone,
      prompt: input.prompt,
      providerId: input.providerId,
      model: input.model,
      permission: input.permission,
      // A template never enables itself; a new schedule starts paused unless asked.
      enabled: input.enabled ?? existing?.enabled ?? false,
      configVersion: (existing?.configVersion ?? 0) + 1,
      // Editing never replays the old rule's occurrences: the save instant is the
      // new evaluation watermark (盒子 4「编辑周期不延长旧确认」).
      lastEvaluatedAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : existing?.projectId !== undefined ? { projectId: existing.projectId } : {}),
    };
    this.recordState = {
      ...this.recordState,
      schedules:
        existing === undefined
          ? [...this.recordState.schedules, schedule]
          : this.recordState.schedules.map((item) => (item.scheduleId === schedule.scheduleId ? schedule : item)),
    };
    this.persist();
    return { ok: true, schedule: cloneSchedule(schedule) };
  }

  /**
   * Apply one built-in template (盒子 2): name/rule/prompt change, project,
   * Provider identity, model, permission and timezone stay. A template never
   * enables or runs the schedule.
   */
  applyTemplate(scheduleId: string, templateId: string): SaveScheduleResult {
    const schedule = this.recordState.schedules.find((item) => item.scheduleId === scheduleId);
    if (!schedule) return { ok: false, code: "unknown-schedule", message: `定时任务 ${scheduleId} 不存在` };
    const template = SCHEDULE_TEMPLATES.find((item) => item.id === templateId);
    if (!template) return { ok: false, code: "unknown-template", message: `模板 ${templateId} 不存在` };
    const applied = applyScheduleTemplate(template, {
      name: schedule.name,
      rule: schedule.ruleText,
      prompt: schedule.prompt,
      providerId: schedule.providerId,
      model: schedule.model,
      permission: schedule.permission,
      timezone: schedule.timezone,
    });
    if (!applied.ok) return { ok: false, code: applied.code, message: applied.message };
    return this.save({
      scheduleId,
      name: applied.schedule.name,
      ruleText: applied.schedule.rule,
      prompt: applied.schedule.prompt,
      timezone: schedule.timezone,
      providerId: schedule.providerId,
      model: schedule.model,
      permission: schedule.permission,
      enabled: schedule.enabled,
    });
  }

  /**
   * Pause / resume (盒子 4/6). 恢复不自动启用调度: this is the only place that sets
   * `enabled`, an archived task refuses enabling, and re-enabling starts a fresh
   * evaluation watermark instead of replaying what passed while paused.
   */
  setEnabled(scheduleId: string, enabled: boolean): SaveScheduleResult {
    const schedule = this.recordState.schedules.find((item) => item.scheduleId === scheduleId);
    if (!schedule) return { ok: false, code: "unknown-schedule", message: `定时任务 ${scheduleId} 不存在` };
    if (enabled && this.ports.archived()) {
      return { ok: false, code: "archived", message: "任务已归档，恢复任务后才能重新启用调度" };
    }
    const next: StoredSchedule = {
      ...schedule,
      enabled,
      updatedAt: this.ports.now(),
      ...(enabled ? { lastEvaluatedAt: this.ports.now() } : {}),
    };
    this.recordState = {
      ...this.recordState,
      schedules: this.recordState.schedules.map((item) => (item.scheduleId === scheduleId ? next : item)),
    };
    this.persist();
    return { ok: true, schedule: cloneSchedule(next) };
  }

  /** Delete one schedule; its run history and the sessions it created are kept. */
  remove(scheduleId: string): { removed: boolean } {
    const before = this.recordState.schedules.length;
    this.recordState = { ...this.recordState, schedules: this.recordState.schedules.filter((item) => item.scheduleId !== scheduleId) };
    const removed = this.recordState.schedules.length !== before;
    if (removed) this.persist();
    return { removed };
  }

  /**
   * 立即运行 (盒子 4): creates its own execution + session in the same task
   * workspace and never changes the next planned time. Refuses on an archived
   * task (归档任务不能通过「立即运行」绕过恢复) and records a skip when a previous
   * run is still going.
   */
  runNow(scheduleId: string): ScheduledRunRecord {
    const schedule = this.recordState.schedules.find((item) => item.scheduleId === scheduleId);
    if (!schedule) throw new Error(`unknown-schedule: 定时任务 ${scheduleId} 不存在`);
    if (this.ports.archived()) throw new Error("archived: 已归档任务不能通过「立即运行」绕过恢复");
    const now = this.ports.now();
    // 立即运行 works while paused (the user asked for this one run explicitly) but
    // still yields to a run that is already in flight.
    if (this.ports.liveExecution(scheduleId)) {
      return this.recordSkip(schedule, {
        trigger: "manual",
        occurrence: now,
        occurrenceKey: manualRunKey(scheduleId, now),
        result: "skipped",
        reason: "上一次执行仍未结束，本次立即运行跳过并记录原因",
      });
    }
    const issue = this.configIssueOf(schedule);
    if (issue !== undefined) return this.recordConfigFailure(schedule, "manual", now, issue);
    const parsed = parseRuleText(schedule.ruleText, schedule.timezone);
    if (!parsed.ok) return this.recordConfigFailure(schedule, "manual", now, parsed.message);
    return this.performRun(schedule, { trigger: "manual", occurrence: now, occurrenceKey: manualRunKey(scheduleId, now) });
  }

  /**
   * Evaluate every enabled schedule of this task (盒子 4/5/6). Called by the
   * Host's schedule read path — there is no timer: a due occurrence is acted on
   * the next time anybody looks, earlier occurrences in the same window are
   * recorded as offline misses (不补跑), and a still-running previous run skips
   * instead of queueing. Returns the runs this evaluation recorded.
   */
  evaluateDue(now: string = this.ports.now()): ScheduledRunRecord[] {
    const recorded: ScheduledRunRecord[] = [];
    for (const schedule of [...this.recordState.schedules]) {
      // Paused: nothing to do and no watermark movement (resuming re-seeds it).
      if (!schedule.enabled) continue;
      // Archived: scheduling stays paused, and the window keeps accumulating so a
      // restore reports the missed occurrences instead of replaying them.
      if (this.ports.archived()) continue;
      const parsed = parseRuleText(schedule.ruleText, schedule.timezone);
      if (!parsed.ok) {
        recorded.push(this.recordConfigFailure(schedule, "due", now, parsed.message));
        this.advance(schedule.scheduleId, now);
        continue;
      }
      const occurrences = occurrencesBetween(parsed.rule, { after: schedule.lastEvaluatedAt, now });
      if (occurrences.length === 0) {
        this.advance(schedule.scheduleId, now);
        continue;
      }
      const occurrence = occurrences[occurrences.length - 1] as string;
      const issue = this.configIssueOf(schedule);
      if (issue !== undefined) {
        recorded.push(this.recordConfigFailure(schedule, "due", occurrence, issue));
        this.advance(schedule.scheduleId, now);
        continue;
      }
      const decision: TriggerDecision = planTrigger({
        scheduleId: schedule.scheduleId,
        enabled: true,
        archived: false,
        rule: parsed.rule,
        lastEvaluatedAt: schedule.lastEvaluatedAt,
        now,
        liveExecution: this.ports.liveExecution(schedule.scheduleId),
        recordedKeys: this.recordState.runs.map((run) => run.occurrenceKey),
      });
      if (decision.decision === "run") {
        recorded.push(this.performRun(schedule, { trigger: "due", occurrence: decision.occurrence, occurrenceKey: decision.occurrenceKey }));
      } else if (decision.decision === "skip" && decision.reason !== "already-triggered") {
        recorded.push(
          this.recordSkip(schedule, {
            trigger: "due",
            occurrence: decision.occurrence,
            occurrenceKey: decision.occurrenceKey,
            result: "skipped",
            reason: decision.message,
          }),
        );
      }
      this.advance(schedule.scheduleId, now);
    }
    return recorded;
  }

  private configIssueOf(schedule: StoredSchedule): string | undefined {
    return scheduleConfigIssue(schedule, this.ports.catalog());
  }

  private performRun(
    schedule: StoredSchedule,
    input: { trigger: ScheduledRunRecord["trigger"]; occurrence: string; occurrenceKey: string },
  ): ScheduledRunRecord {
    const startedAt = this.ports.now();
    const runId = `run-${(this.runSequence += 1)}`;
    const sessionId = scheduledSessionId(runId);
    const rule = parseRuleText(schedule.ruleText, schedule.timezone);
    // A confirmation a scheduled run waits on expires at min(24h, next plan) (盒子 4).
    const nextPlan = rule.ok ? nextTriggerAt(rule.rule, { after: input.occurrence }) : null;
    let result: ScheduleStartResult;
    try {
      result = this.ports.startRun({
        runId,
        sessionId,
        schedule: cloneSchedule(schedule),
        approvalExpiresAt: scheduledApprovalDeadline({ requestedAt: startedAt, nextTriggerAt: nextPlan }),
      });
    } catch (error) {
      result = { state: "failed", failureReason: error instanceof Error ? error.message : String(error) };
    }
    const run: ScheduledRunRecord = {
      runId,
      scheduleId: schedule.scheduleId,
      taskId: this.taskId,
      configVersion: schedule.configVersion,
      trigger: input.trigger,
      occurrenceKey: input.occurrenceKey,
      scheduledAt: input.occurrence,
      startedAt,
      endedAt: this.ports.now(),
      result: toRunResult(result),
      providerId: schedule.providerId,
      model: schedule.model,
      permission: schedule.permission,
      ruleText: schedule.ruleText,
      // A failed run created no usable session; only a started one is recorded.
      ...(result.state === "failed" ? { reason: result.failureReason ?? "执行失败" } : { sessionId }),
    };
    this.appendRun(run);
    return { ...run };
  }

  private recordSkip(
    schedule: StoredSchedule,
    input: { trigger: ScheduledRunRecord["trigger"]; occurrence: string; occurrenceKey: string; result: ScheduledRunResult; reason: string },
  ): ScheduledRunRecord {
    const now = this.ports.now();
    const run: ScheduledRunRecord = {
      runId: `run-${(this.runSequence += 1)}`,
      scheduleId: schedule.scheduleId,
      taskId: this.taskId,
      configVersion: schedule.configVersion,
      trigger: input.trigger,
      occurrenceKey: input.occurrenceKey,
      scheduledAt: input.occurrence,
      startedAt: now,
      endedAt: now,
      result: input.result,
      reason: input.reason,
      providerId: schedule.providerId,
      model: schedule.model,
      permission: schedule.permission,
      ruleText: schedule.ruleText,
    };
    this.appendRun(run);
    return { ...run };
  }

  /**
   * A config that no longer resolves never runs and never falls back to another
   * target (盒子 6): the run is recorded as failed with the reason and the
   * schedule shows 需要修复 until a save fixes it.
   */
  private recordConfigFailure(
    schedule: StoredSchedule,
    trigger: ScheduledRunRecord["trigger"],
    at: string,
    issue: string,
  ): ScheduledRunRecord {
    const run = this.recordSkip(schedule, {
      trigger,
      occurrence: at,
      occurrenceKey: occurrenceKey(schedule.scheduleId, at),
      result: "failed",
      reason: `配置需要修复：${issue}`,
    });
    this.recordState = {
      ...this.recordState,
      schedules: this.recordState.schedules.map((item) => (item.scheduleId === schedule.scheduleId ? { ...item, repairIssue: issue } : item)),
    };
    this.persist();
    return run;
  }

  private advance(scheduleId: string, now: string): void {
    this.recordState = {
      ...this.recordState,
      schedules: this.recordState.schedules.map((item) => (item.scheduleId === scheduleId ? { ...item, lastEvaluatedAt: now } : item)),
    };
    this.persist();
  }

  private appendRun(run: ScheduledRunRecord): void {
    this.recordState = { ...this.recordState, runs: [...this.recordState.runs, run] };
    this.persist();
  }

  private persist(): void {
    this.store.writeSchedules(this.taskDir, this.recordState);
  }
}

function toRunResult(result: ScheduleStartResult): ScheduledRunResult {
  if (result.state === "failed") return "failed";
  // A run whose turn parks on a confirmation still created its own session: the
  // confirmation is tracked by the execution ledger from here on.
  return "completed";
}

function cloneSchedule(schedule: StoredSchedule): StoredSchedule {
  return { ...schedule };
}
