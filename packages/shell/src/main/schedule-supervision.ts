/**
 * Scheduler supervision for [Pencil T18] #153.
 *
 * Two facts main owns and the Host cannot know:
 *
 * - **quitting / asleep** — no due trigger may start while the app is on its way
 *   out or the machine is suspended, and waking never backfills. `SchedulerGate`
 *   is the one place that phase lives, so the driver, the wake fan-out and the
 *   quit path read the same answer.
 * - **unconfirmed quit** — a shutdown that could not prove every Host stopped is
 *   recorded on disk and surfaced after restart. The renderer never sees a
 *   fabricated "clean" state.
 *
 * Both are transport-free and clock-injected, so they are unit-testable without
 * Electron.
 */

export type SchedulerPhase = "active" | "asleep" | "quitting";

export interface SchedulerStateView {
  phase: SchedulerPhase;
  /** `null` = triggers are allowed right now. */
  blockedReason: string | null;
  /** Instant the machine went to sleep, when `phase === "asleep"`. */
  sleepingSince?: string;
  /** Last time an unconfirmed quit or a wake was observed, for the UI. */
  lastQuitUnconfirmed?: QuitUnconfirmedReport;
}

/** One shutdown that did not prove every Host stopped. */
export interface QuitUnconfirmedReport {
  at: string;
  /** Task ids the quit report did not stop cleanly (may be empty: report missing). */
  hosts: string[];
  /** The last-window escalation attempts, when it came from that path. */
  attempts?: number;
}

export class SchedulerGate {
  private phase: SchedulerPhase = "active";
  private sleepingSince: string | undefined;
  private quitUnconfirmed: QuitUnconfirmedReport | undefined;

  constructor(private readonly report: Pick<QuitReportStore, "record"> | null = null) {}

  get current(): SchedulerPhase {
    return this.phase;
  }

  /** `null` while triggers may run; a named reason otherwise. */
  blockedReason(): string | null {
    if (this.phase === "quitting") return "应用正在退出：不再执行定时触发";
    if (this.phase === "asleep") return "系统休眠中：不执行定时触发，唤醒后按未来时间重新计划";
    return null;
  }

  /** An explicit quit started: nothing may trigger from here on. */
  beginQuit(): void {
    this.phase = "quitting";
  }

  /**
   * The quit did not finish (Hosts still running). The app keeps living, so the
   * scheduler does too; the refusal stays recorded so it is visible after the
   * next start rather than silently forgotten.
   */
  abortQuit(report: QuitUnconfirmedReport): void {
    this.quitUnconfirmed = report;
    this.phase = "active";
    this.report?.record(report);
  }

  /** A quit that proved every Host stopped: the earlier refusal is cleared. */
  completeQuit(): void {
    this.quitUnconfirmed = undefined;
  }

  /** Machine suspend: remember the instant so wake can plan forward from it. */
  sleep(at: string): { since: string } {
    if (this.phase === "quitting") return { since: at };
    this.phase = "asleep";
    this.sleepingSince = at;
    return { since: at };
  }

  /**
   * Machine resume. Returns the sleep window when the phase really changed, so
   * the caller re-plans schedules forward; a resume while quitting changes
   * nothing (the quit still owns the app).
   */
  wake(at: string): { since: string; at: string } | null {
    if (this.phase === "quitting") return null;
    if (this.phase !== "asleep") return null;
    const since = this.sleepingSince ?? at;
    this.phase = "active";
    this.sleepingSince = undefined;
    return { since, at };
  }

  /** Current phase plus the last unconfirmed quit, for the UI. */
  view(): SchedulerStateView {
    return {
      phase: this.phase,
      blockedReason: this.blockedReason(),
      ...(this.sleepingSince !== undefined ? { sleepingSince: this.sleepingSince } : {}),
      ...(this.quitUnconfirmed !== undefined ? { lastQuitUnconfirmed: this.quitUnconfirmed } : {}),
    };
  }
}

/**
 * Persisted record of a quit that could not confirm every Host stopped. Written
 * by main into its own userData (never a task folder), read after restart so the
 * failure is visible instead of evaporating with the process.
 */
export class QuitReportStore {
  constructor(
    private readonly dir: string,
    private readonly io: {
      readFile?: (path: string) => string;
      writeFile?: (path: string, contents: string) => void;
    } = {},
  ) {}

  private get path(): string {
    return `${this.dir}/quit-unconfirmed.json`;
  }

  record(report: QuitUnconfirmedReport): void {
    const write = this.io.writeFile ?? defaultWriteFile;
    write(this.path, JSON.stringify({ version: 1, ...report }));
  }

  /** The last unconfirmed quit, or `null` after a quit that stopped cleanly. */
  pending(): QuitUnconfirmedReport | null {
    const read = this.io.readFile ?? defaultReadFile;
    let raw: string;
    try {
      raw = read(this.path);
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed["at"] !== "string") return null;
      const hosts = Array.isArray(parsed["hosts"]) ? parsed["hosts"].filter((item): item is string => typeof item === "string") : [];
      const attempts = typeof parsed["attempts"] === "number" ? parsed["attempts"] : undefined;
      return { at: parsed["at"], hosts, ...(attempts === undefined ? {} : { attempts }) };
    } catch {
      return null;
    }
  }

  clear(): void {
    const write = this.io.writeFile ?? defaultWriteFile;
    write(this.path, JSON.stringify({ version: 1, clearedAt: new Date().toISOString() }));
  }
}

function defaultReadFile(path: string): string {
  const { readFileSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  return readFileSync(path, "utf8");
}

function defaultWriteFile(path: string, contents: string): void {
  const { mkdirSync, writeFileSync, renameSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const { dirname } = process.getBuiltinModule("node:path") as typeof import("node:path");
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, contents, "utf8");
  renameSync(temp, path);
}
