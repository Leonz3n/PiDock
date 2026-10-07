import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import type { ServiceOwnerIdentity, ServiceOwnerLaunch, ServiceOwnerReceipt, ServiceOwnerSession } from "./service-execution-experiment.js";

/** Only these audited bytes earn a no-child capability; a caller-supplied arbitrary hash cannot. */
export const SERVICE_LEAF_SOURCE_SHA256 = "8aa5c2acb10d465ad2d8eac449cf8f4a29f0b2de89dbb9dd3d60191f6dabc096";
function hash(path: string, limit: number): string {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.size <= 0n || before.size > BigInt(limit) || realpathSync(path) !== path) throw Error();
  const bytes = readFileSync(path);
  const after = lstatSync(path, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw Error();
  return createHash("sha256").update(bytes).digest("hex");
}
function launchEncoding(launch: ServiceOwnerLaunch): string {
  return JSON.stringify([launch.capability, launch.program, launch.args, launch.cwd, launch.envRevision, launch.programSha256, launch.sourceSha256,
    Object.entries(launch.env).sort(([a], [b]) => a.localeCompare(b))]);
}

/** Explicit trusted fixture installation only. No production discovery or general process-tree driver.
 * Byte/path checks are snapshots, not atomic exec attestation or a same-UID sandbox.
 * Native close proves only this reviewed fixed program's no-child lifetime. */
export class ReviewedServiceLeafDriver {
  private readonly launch: ServiceOwnerLaunch;
  private used = false;
  private observed: { pid: number | null; startedAt: string | null; close: { code: number | null; signal: string | null } | null; fixtureMatched: boolean; uncertain: boolean } =
    { pid: null, startedAt: null, close: null, fixtureMatched: false, uncertain: false };
  constructor(approved: ServiceOwnerLaunch) { this.launch = structuredClone(approved); }
  observation() { return structuredClone(this.observed); }
  async start(identity: ServiceOwnerIdentity, requested: ServiceOwnerLaunch): Promise<ServiceOwnerSession> {
    identity = { ...identity };
    const launch = this.launch;
    const receipt = (result: { event: "unconfirmed" | "not-started" } | { event: "exit"; code: number }): ServiceOwnerReceipt =>
      ({ ...identity, capability: launch.capability, programSha256: launch.programSha256, sourceSha256: launch.sourceSha256, envRevision: launch.envRevision, ...result });
    try {
      if (this.used || process.platform !== "darwin" || process.versions.node !== "24.21.0" || launch.capability !== "reviewed-no-child-fixture" ||
          launch.program !== realpathSync(process.execPath) || launch.args.length !== 1 || launch.sourceSha256 !== SERVICE_LEAF_SOURCE_SHA256 ||
          launchEncoding(requested) !== launchEncoding(launch) || Object.keys(launch.env).sort().join(",") !== "FIXTURE_VALUE" ||
          launch.env.FIXTURE_VALUE !== "synthetic-service-value" || !launch.envRevision || realpathSync(launch.cwd) !== launch.cwd ||
          !lstatSync(launch.cwd).isDirectory() || hash(launch.program, 256 * 1024 * 1024) !== launch.programSha256 ||
          hash(launch.args[0], 4096) !== launch.sourceSha256) throw Error();
    } catch {
      const completion = Promise.resolve(receipt({ event: "not-started" }));
      return { completion, stop: () => completion };
    }
    this.used = true;
    let finish!: (value: ServiceOwnerReceipt) => void;
    const completion = new Promise<ServiceOwnerReceipt>((resolve) => { finish = resolve; });
    let settled = false;
    const settle = (result: { event: "unconfirmed" } | { event: "exit"; code: number }) => {
      if (settled) return;
      settled = true; clearTimeout(deadline);
      if (result.event === "unconfirmed") this.observed.uncertain = true;
      finish(receipt(result));
    };
    const deadline = setTimeout(() => settle({ event: "unconfirmed" }), 10_000);
    try {
      const child = spawn(launch.program, [...launch.args], { cwd: launch.cwd, env: { ...launch.env }, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      this.observed.pid = child.pid ?? null;
      child.once("spawn", () => { this.observed.pid = child.pid ?? null; this.observed.startedAt = new Date().toISOString(); });
      let output = "", invalid = false;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (text: string) => { if (output.length + text.length > 4096) { invalid = true; output = ""; } else if (!invalid) output += text; });
      child.stderr.on("data", () => { invalid = true; });
      child.stdout.on("error", () => settle({ event: "unconfirmed" }));
      child.stderr.on("error", () => settle({ event: "unconfirmed" }));
      child.once("error", () => settle({ event: "unconfirmed" }));
      child.once("close", (code, signal) => {
        this.observed.close = { code, signal };
        try {
          const lines = output.trimEnd().split("\n"), row: unknown = JSON.parse(lines[0]);
          if (!row || typeof row !== "object" || Array.isArray(row)) throw Error();
          const record = row as Record<string, unknown>;
          this.observed.fixtureMatched = !invalid && lines.length === 2 && lines[1] === "fixed-service-leaf-complete" &&
            Object.keys(record).sort().join(",") === "cwd,keys,kind,pid,value" && record.kind === "fixed-service-leaf" && record.value === launch.env.FIXTURE_VALUE &&
            record.cwd === launch.cwd && record.pid === child.pid && Array.isArray(record.keys) && record.keys.includes("FIXTURE_VALUE") &&
            record.keys.every((key) => key === "FIXTURE_VALUE" || key === "__CF_USER_TEXT_ENCODING");
        } catch { this.observed.fixtureMatched = false; }
        settle(code === 0 && signal === null && this.observed.fixtureMatched ? { event: "exit", code } : { event: "unconfirmed" });
      });
    } catch { settle({ event: "unconfirmed" }); }
    // Stop means wait for the finite fixture's own completion. No PID signal or transport teardown.
    return { completion, stop: () => completion };
  }
}
