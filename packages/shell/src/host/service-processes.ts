import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { ServiceStartPlan } from "./service-runtime.js";

interface OwnedProcess { child: ChildProcessByStdio<null, Readable, Readable>; done: Promise<void> }

/**
 * Host-owned process foundation. Stop confirms stdio closure, not arbitrary
 * descendant termination; do not wire into production until the process tree
 * has a separately verified ownership mechanism on each supported platform.
 */
export class TaskServiceProcesses {
  private readonly running = new Map<string, OwnedProcess>();
  private closing = false;
  private readonly taskRoot: string;

  constructor(taskDir: string, private readonly onLine: (serviceId: string, line: string) => void,
    private readonly onExit: (serviceId: string, reason: string) => void,
    private readonly redact: (line: string) => string,
    private readonly stopGraceMs = 3000,
    private readonly stopConfirmMs = 1000) {
    this.taskRoot = realpathSync(taskDir);
  }

  ids(): string[] { return [...this.running.keys()].sort(); }

  async start(plan: ServiceStartPlan): Promise<number> {
    if (this.closing) throw new Error("host-closing: service starts are disabled");
    if (process.platform === "win32") throw new Error("unsupported-platform: Windows service process ownership is not implemented");
    if (this.running.has(plan.serviceId)) throw new Error(`already-running: ${plan.serviceId}`);
    if (!isAbsolute(plan.cwd) || !isAbsolute(plan.program)) throw new Error("invalid-launch: absolute cwd and program required");
    const cwd = realpathSync(plan.cwd);
    const within = relative(this.taskRoot, cwd);
    if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error("invalid-launch: cwd escapes task root");
    const child = spawn(plan.program, plan.args, { cwd, env: { ...plan.env }, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const emit = (stream: NodeJS.ReadableStream) => {
      let pending = "";
      let oversized = false;
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        pending += chunk;
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end);
          if (!oversized && line.length <= 2000) this.onLine(plan.serviceId, this.redact(line.replace(/\r$/, "")).slice(0, 2000));
          else this.onLine(plan.serviceId, "[output line exceeded 2000 characters]");
          pending = pending.slice(end + 1);
          oversized = false;
        }
        if (pending.length > 2000) { pending = ""; oversized = true; }
      });
      stream.on("end", () => {
        if (oversized) this.onLine(plan.serviceId, "[output line exceeded 2000 characters]");
        else if (pending) this.onLine(plan.serviceId, this.redact(pending).slice(0, 2000));
      });
    };
    emit(child.stdout);
    emit(child.stderr);
    const started = new Promise<number>((resolve, reject) => {
      child.once("spawn", () => resolve(child.pid!));
      child.once("error", reject);
    });
    const done = new Promise<void>((resolve) => {
      child.once("close", (code, signal) => {
        if (this.running.get(plan.serviceId)?.child === child) {
          this.running.delete(plan.serviceId);
          this.onExit(plan.serviceId, signal ? `signal:${signal}` : `exit:${code ?? "unknown"}`);
        }
        resolve();
      });
    });
    // Reserve the identity before awaiting spawn; concurrent starts cannot run twice.
    this.running.set(plan.serviceId, { child, done });
    try { return await started; }
    catch (error) { await done; throw error; }
  }

  async stopAll(): Promise<void> {
    this.closing = true;
    const results = await Promise.allSettled(this.ids().map(async (serviceId) => {
      try { await this.stop(serviceId); }
      catch (error) { if (!(error instanceof Error && error.message.startsWith("not-running:"))) throw error; }
    }));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private async closedWithin(done: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        done.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async stop(serviceId: string): Promise<void> {
    const owned = this.running.get(serviceId);
    if (!owned) throw new Error(`not-running: ${serviceId}`);
    const { child, done } = owned;
    const signal = (kind: NodeJS.Signals) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    signal("SIGTERM");
    if (await this.closedWithin(done, this.stopGraceMs)) return;
    signal("SIGKILL");
    if (await this.closedWithin(done, this.stopConfirmMs)) return;
    // A descendant may still own stdout/stderr after the leader exits.
    throw new Error(`termination-unconfirmed: ${serviceId} still owns open process output`);
  }
}
