/**
 * Host-borne schedule driver for [PiDock 18] (#20).
 *
 * 首版调度器由 PiDock Host 承载，仅在主机开机且 Host 运行时触发. The Host
 * processes are forked by main, so the process that knows which Hosts exist is
 * main: this driver periodically asks each *forked* task Host to evaluate its own
 * due triggers (`task/scheduleEvaluate`). It never spawns a Host for a task that
 * has none (that would fork a process just to look at a clock), never overlaps
 * its own ticks, and never lets one failing task stop the others. Missed
 * occurrences stay the Host's business: evaluation after a stop records them as
 * offline misses instead of catching up.
 *
 * The class is transport-free and clock-injected, so the loop is unit-testable
 * with fake timers and no Electron process.
 */

export interface ScheduleDriverPorts {
  /** Task ids whose Host is currently running (no fork-on-demand). */
  hostTaskIds(): readonly string[];
  /** Route one due-trigger evaluation to that task's Host. */
  evaluate(taskId: string): Promise<void>;
  /** Report a failure without stopping the loop. */
  onError?(error: unknown, taskId: string): void;
}

export interface ScheduleTickResult {
  /** Hosts that were asked to evaluate this tick. */
  evaluated: string[];
  /** Tasks skipped because the previous tick is still running. */
  skipped: string[];
  failures: { taskId: string; error: string }[];
}

export interface ScheduleDriverOptions {
  /** Tick period; 30s is fine-grained enough for minute-granularity rules. */
  intervalMs?: number;
}

/** One tick period: a daily rule needs no finer resolution than this. */
export const DEFAULT_SCHEDULE_TICK_MS = 30_000;

export class ScheduleDriver {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private readonly intervalMs: number;

  constructor(
    private readonly ports: ScheduleDriverPorts,
    options: ScheduleDriverOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_SCHEDULE_TICK_MS;
    if (!Number.isInteger(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error("invalid-payload: intervalMs must be a positive integer");
    }
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** Evaluate every running Host's due triggers once. */
  async tick(): Promise<ScheduleTickResult> {
    const taskIds = [...this.ports.hostTaskIds()];
    if (this.ticking) return { evaluated: [], skipped: taskIds, failures: [] };
    this.ticking = true;
    const evaluated: string[] = [];
    const failures: { taskId: string; error: string }[] = [];
    try {
      for (const taskId of taskIds) {
        try {
          await this.ports.evaluate(taskId);
          evaluated.push(taskId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ taskId, error: message });
          this.ports.onError?.(error, taskId);
        }
      }
    } finally {
      this.ticking = false;
    }
    return { evaluated, skipped: [], failures };
  }

  /** Start the periodic evaluation; a second call is a no-op. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  /** Stop the timer (app quit / Host disposal); a pending tick still finishes. */
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
