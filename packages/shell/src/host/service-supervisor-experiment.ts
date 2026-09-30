import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

export interface SupervisorLaunch {
  taskRoot: string; cwd: string; program: string; args: string[]; env: Record<string, string>; graceMs: number;
  rootIdentity: { device: string; inode: string }; cwdIdentity: { device: string; inode: string };
}
type Terminal = { event: "exit"; code: number } | { event: "stopped" };
export type SupervisorResult = Terminal | { event: "unconfirmed" };
export interface SupervisorSession {
  pid: number;
  completion: Promise<SupervisorResult>;
  stop(): Promise<SupervisorResult>;
  disconnect(): Promise<SupervisorResult>;
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** Isolated experiment only. No production RPC, binary discovery, or identity capture. */
export async function launchSupervisorExperiment(binary: string, launch: SupervisorLaunch, options: {
  redact: (line: string) => string; onLine: (line: string) => void;
  readyMs?: number; stopMs?: number;
}): Promise<SupervisorSession> {
  const readyMs = options.readyMs ?? 3000;
  const stopMs = options.stopMs ?? 6000;
  if (!isAbsolute(binary) || !Number.isInteger(readyMs) || readyMs < 20 || readyMs > 10000 ||
      !Number.isInteger(stopMs) || stopMs < 20 || stopMs > 10000) throw new Error("invalid-supervisor-options");
  const input = JSON.stringify(launch);
  if (Buffer.byteLength(input) > 256 * 1024 - 1 || input.includes("\n")) throw new Error("invalid-supervisor-launch");
  const child = spawn(binary, [], { env: {}, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let readyResolve: (pid: number | null) => void = () => {};
  const ready = new Promise<number | null>((resolve) => { readyResolve = resolve; });
  let closeResolve: () => void = () => {};
  const closed = new Promise<void>((resolve) => { closeResolve = resolve; });
  let complete: (result: SupervisorResult) => void = () => {};
  const completion = new Promise<SupervisorResult>((resolve) => { complete = resolve; });
  let pid: number | null = null;
  let terminal: Terminal | null = null;
  let invalid = false;
  let finished = false;
  let requested = false;
  const fail = () => {
    invalid = true; readyResolve(null);
    child.stdin.destroy();
    child.kill("SIGKILL");
  };
  let status = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (invalid) return;
    for (const char of chunk) {
      if (char !== "\n") { status += char; if (status.length > 512) { fail(); return; } continue; }
      let row: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(status); status = "";
        if (!value || typeof value !== "object" || Array.isArray(value)) { fail(); return; }
        row = value as Record<string, unknown>;
      } catch { fail(); return; }
      const keys = Object.keys(row).sort().join(",");
      if (row["event"] === "ready" && keys === "event,pid" && pid === null && !terminal &&
          Number.isSafeInteger(row["pid"]) && Number(row["pid"]) > 0) {
        pid = Number(row["pid"]); readyResolve(pid);
      } else if (row["event"] === "exit" && (keys === "code,event" || keys === "event") && pid !== null && !terminal &&
          (row["code"] === undefined || (Number.isSafeInteger(row["code"]) && Number(row["code"]) >= -1 && Number(row["code"]) <= 0xffffffff))) {
        terminal = { event: "exit", code: row["code"] === undefined ? 0 : Number(row["code"]) };
      } else if (row["event"] === "stopped" && keys === "event" && pid !== null && !terminal && requested) {
        terminal = { event: "stopped" };
      } else { fail(); return; }
    }
  });
  let log = "";
  let oversized = false;
  let logCount = 0;
  const emit = () => {
    try {
      if (logCount < 200) options.onLine(oversized ? "[output line exceeded 2000 characters]" : options.redact(log.replace(/\r$/, "")).slice(0, 2000));
      else if (logCount === 200) options.onLine("[output exceeded 200 lines]");
      logCount++;
    }
    catch { fail(); }
    log = ""; oversized = false;
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (invalid) return;
    for (const char of chunk) {
      if (char === "\n") { emit(); if (invalid) return; }
      else if (!oversized) { log += char; if (log.length > 2000) { log = ""; oversized = true; } }
    }
  });
  child.stderr.on("end", () => { if (!invalid && (log || oversized)) emit(); });
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stdout.on("error", fail);
  child.stderr.on("error", fail);
  child.once("close", (code, signal) => {
    finished = true;
    readyResolve(null);
    complete(!invalid && !status && code === 0 && signal === null && terminal ? terminal : { event: "unconfirmed" });
    closeResolve();
  });
  child.stdin.write(input + "\n");
  const servicePid = await within(ready, readyMs);
  const abandon = async () => {
    fail();
    if (!(await within(closed.then(() => true), stopMs))) {
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      complete({ event: "unconfirmed" });
    }
  };
  if (!servicePid || invalid) {
    await abandon();
    throw new Error(servicePid === undefined ? "supervisor-ready-timeout" : "supervisor-launch-unconfirmed");
  }
  const end = async (disconnect: boolean): Promise<SupervisorResult> => {
    if (!finished && !requested) {
      requested = true;
      if (disconnect) child.stdin.end(); else child.stdin.write("stop\n");
    }
    const result = await within(completion, stopMs);
    if (result) return result;
    await abandon();
    return { event: "unconfirmed" };
  };
  return { pid: servicePid, completion, stop: () => end(false), disconnect: () => end(true) };
}
