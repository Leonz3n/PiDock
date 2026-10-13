/**
 * [PiDock 04] (#7 box 7) the RECORDING half of the platform verification, with
 * REAL child processes.
 *
 * Evidence split (stated, not implied):
 * - REAL subprocess: the launch goes through the production dispatch
 *   (`runHumanServiceControl`) into the real `TaskServiceProcesses` driver, and
 *   the fixture script writes its own pid so the recorded program+argv is
 *   checked against a child that really ran.
 * - REAL store: the verification document is written to, and re-read from, the
 *   task workspace (`service-launch-verification.json`) through
 *   `diskLaunchVerificationLog`, exactly as the Host wires it in `host.ts`.
 * - NOT covered here: any platform other than this machine's. Windows cannot be
 *   run in this environment, so the win32 assertions below are the HONEST
 *   NEGATIVE ones (an unverified platform must not read as verified), never a
 *   claim that Windows was tested.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostPlatformLabel } from "../main/service-config.js";
import { runHumanServiceControl } from "./service-control.js";
import { hostInstallationId } from "./installation-identity.js";
import { TaskServiceProcesses } from "./service-processes.js";
import { publicServiceStatus } from "./service-public.js";
import { TaskServiceRuntime } from "./service-runtime.js";
import { diskLaunchVerificationLog, memoryLaunchVerificationLog, type LaunchVerificationLog } from "./service-launch-verification.js";
import {
  emptyLaunchVerificationDiskRecord,
  launchVerificationFilePath,
  parseLaunchVerificationRecord,
  readLaunchVerificationOnDisk,
  writeLaunchVerificationOnDisk,
} from "./task-store.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

const dirs: string[] = [];
function taskDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pidock-launch-verification-"));
  dirs.push(dir);
  cleanups.push(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let elapsed = 0; elapsed < 20_000; elapsed += 25) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw Error(`timed out waiting for ${label}`);
}

/** A service whose script proves it ran by writing its own pid. */
function fixture(dir: string, options: { log?: LaunchVerificationLog } = {}) {
  // The Host gets its installation identity from the application profile main
  // forks it with; the fixture provides one so a real launch is bound to THIS
  // installation rather than to nothing.
  const profile = join(dir, "profile");
  mkdirSync(profile, { recursive: true });
  vi.stubEnv("PIDOCK_PROTECTED_PROFILE", profile);
  const marker = join(dir, "child-pid.txt");
  const services = new TaskServiceRuntime(dir, undefined, options.log ?? diskLaunchVerificationLog(dir));
  services.register({
    serviceId: "svc",
    descriptor: {
      name: "svc",
      program: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid))\nsetInterval(() => {}, 1000)`],
      cwd: dir,
      ports: [],
      runType: "long-lived",
    },
    layers: { repoDefaults: [], shared: [], privateEntries: [], task: [] },
    templateVersion: "v1",
    launchSource: "catalog",
  });
  const processes = new TaskServiceProcesses(dir, () => {}, () => {}, (line) => line);
  cleanups.push(async () => { if (processes.ids().length > 0) await processes.stopAll(); });
  const driver = {
    start: async (serviceId: string) => ({ pid: await processes.start(services.planRegisteredStart(serviceId)) }),
    stop: async (serviceId: string) => { await processes.stop(serviceId); },
  };
  return { marker, services, processes, driver };
}

describe.skipIf(process.platform === "win32")("#7 platform launch verification is recorded by a real launch", () => {
  it("records THIS platform only after a real child start and stop, and the record survives a re-read", async () => {
    const dir = taskDir();
    const { marker, services, driver } = fixture(dir);

    const started = await runHumanServiceControl({ services, driver, serviceId: "svc", action: "start", label: "ui" });
    expect(started.ok).toBe(true);
    await until(() => existsSync(marker), "the fixture script to write its pid");

    // The record describes a launch that really happened: the plan the driver
    // spawned, this process's own platform/node, and this child's pid.
    const plan = services.planRegisteredStart("svc");
    const document = readLaunchVerificationOnDisk(dir);
    expect(document.entries).toHaveLength(1);
    const entry = document.entries[0];
    expect(entry.serviceId).toBe("svc");
    expect(entry.platform).toBe(hostPlatformLabel());
    expect(entry.platform.startsWith(process.platform)).toBe(true);
    expect(entry.nodeVersion).toBe(process.versions.node);
    expect(entry.program).toBe(plan.program);
    expect(entry.args).toEqual(plan.args);
    expect(entry.startedAt.length).toBeGreaterThan(0);
    expect(entry.stopped).toBe(false);
    expect(entry.stoppedAt).toBeUndefined();
    expect(Number(readFileSync(marker, "utf8"))).toBeGreaterThan(0);

    // This machine's row is the verified one, and it names what was observed.
    const afterStart = publicServiceStatus(services.get("svc")!);
    expect(afterStart.launchVerification.platform).toBe(hostPlatformLabel());
    const mine = afterStart.launchVerification.rows.filter((row) => row.verified);
    expect(mine).toEqual([expect.objectContaining({ platform: hostPlatformLabel(), program: plan.program, nodeVersion: process.versions.node, stopped: false })]);

    const stopped = await runHumanServiceControl({ services, driver, serviceId: "svc", action: "stop", label: "ui" });
    expect(stopped.ok).toBe(true);
    const afterStop = readLaunchVerificationOnDisk(dir);
    expect(afterStop.entries).toHaveLength(1);
    expect(afterStop.entries[0].stopped).toBe(true);
    expect(afterStop.entries[0].stoppedAt).toBeDefined();
    // The stop observed the same launch: it merged into the platform's entry
    // instead of replacing the start fact.
    expect(afterStop.entries[0].startedAt).toBe(entry.startedAt);

    // A re-read through the real store: a NEW runtime (the shape of a Host
    // restart) still knows this platform was verified.
    const restarted = new TaskServiceRuntime(dir, undefined, diskLaunchVerificationLog(dir));
    restarted.register({
      serviceId: "svc",
      descriptor: { name: "svc", program: process.execPath, args: ["-e", ""], cwd: dir, ports: [], runType: "long-lived" },
      layers: { repoDefaults: [], shared: [], privateEntries: [], task: [] },
      templateVersion: "v1",
      launchSource: "catalog",
    });
    const reloaded = publicServiceStatus(restarted.get("svc")!);
    expect(reloaded.launchVerification.rows.filter((row) => row.verified)).toEqual([
      expect.objectContaining({ platform: hostPlatformLabel(), program: process.execPath, stopped: true }),
    ]);
  }, 30_000);

  it("keeps a platform unverified when the record cannot be persisted, instead of claiming a pass", async () => {
    const dir = taskDir();
    // The store refuses every write (a corrupt document, a read-only workspace):
    // the launch itself still succeeds, but nothing may then read as verified.
    const refusing: LaunchVerificationLog = {
      read: () => [],
      record: () => { throw new Error("invalid-payload: launch verification record is not valid JSON"); },
    };
    const { services, driver } = fixture(dir, { log: refusing });
    const started = await runHumanServiceControl({ services, driver, serviceId: "svc", action: "start", label: "ui" });
    expect(started.ok).toBe(true);
    expect(services.get("svc")?.launchVerifications).toEqual([]);
    expect(services.get("svc")?.events.some((event) => event.startsWith("launch-verification-unrecorded:"))).toBe(true);
    const status = publicServiceStatus(services.get("svc")!);
    expect(status.launchVerification.rows.every((row) => !row.verified)).toBe(true);
    expect(status.launchVerification.rows.find((row) => row.platform === hostPlatformLabel())?.reason).toBe("本任务尚无该平台的实测启动记录");
  }, 30_000);
});

describe.skipIf(process.platform === "win32")("#7 an unverified platform is named, never implied", () => {
  it("reads every platform as NOT verified while no launch was recorded, and Windows BY NAME", () => {
    const dir = taskDir();
    const { services } = fixture(dir, { log: memoryLaunchVerificationLog() });
    const status = publicServiceStatus(services.get("svc")!);
    expect(status.launchVerification.rows.map((row) => row.platform).sort())
      .toEqual([...new Set(["darwin-arm64", "win32-x64", hostPlatformLabel()])].sort());
    expect(status.launchVerification.rows.every((row) => !row.verified)).toBe(true);
    // Windows is present and explicitly unverified - the platform this
    // environment can never run is never silently absent.
    expect(status.launchVerification.rows.find((row) => row.platform === "win32-x64")).toEqual({ platform: "win32-x64", verified: false, reason: "本机未运行该平台，未实测" });
    // The serialized payload cannot be read as a pass for any platform.
    const serialized = JSON.parse(JSON.stringify(status)) as { launchVerification: { rows: { verified: boolean }[] } };
    expect(serialized.launchVerification.rows.some((row) => row.verified)).toBe(false);
  });

  it("does not promote another platform's record to a pass on this machine", () => {
    const dir = taskDir();
    const { services } = fixture(dir, { log: memoryLaunchVerificationLog() });
    const installationId = hostInstallationId();
    expect(installationId).toBeDefined();
    services.recordLaunchVerification("svc", { platform: "win32-x64", nodeVersion: "24.21.0", ok: true, program: "pnpm.cmd", args: ["dev"], installationId });
    const status = publicServiceStatus(services.get("svc")!);
    const windows = status.launchVerification.rows.find((row) => row.platform === "win32-x64");
    // Read by a Host running on this macOS machine: the record is real evidence
    // for win32-x64, never a verification of the platform answering.
    expect(windows?.verified).toBe(false);
    expect(windows?.reason).toBe(`记录来自其他平台（win32-x64），本机 ${hostPlatformLabel()} 未实测`);
    // Read by a Host that really is on win32-x64, the same record is a pass.
    expect(publicServiceStatus(services.get("svc")!, "win32-x64", installationId).launchVerification.rows.find((row) => row.platform === "win32-x64")?.verified).toBe(true);
    // A record that named no launch observation (the pre-existing input shape)
    // is not evidence either, and the row says exactly why.
    services.recordLaunchVerification("svc", { platform: "linux-x64", nodeVersion: "24.21.0", ok: true });
    const linux = publicServiceStatus(services.get("svc")!, "linux-x64").launchVerification.rows.find((row) => row.platform === "linux-x64");
    expect(linux).toEqual({ platform: "linux-x64", verified: false, reason: "该平台只有未记录实测事实的条目，不算已验证" });
  });

  it("does not verify a same-platform record written by ANOTHER installation", () => {
    const dir = taskDir();
    const platform = hostPlatformLabel();
    // The task folder was copied from another machine of the same platform: the
    // record is a real launch, but not of THIS installation.
    const foreign = {
      schemaVersion: 1 as const, serviceId: "svc", platform, nodeVersion: "24.21.0", program: "pnpm", args: ["dev"],
      startedAt: "2026-10-08T00:00:00.000Z", stopped: false, installationId: "other-installation", templateVersion: "v1",
    };
    const { services } = fixture(dir, { log: memoryLaunchVerificationLog([foreign]) });
    const row = publicServiceStatus(services.get("svc")!, platform, "this-installation").launchVerification.rows.find((r) => r.platform === platform);
    expect(row).toEqual({ platform, verified: false, reason: "记录来自其他安装（同一平台），本安装未实测" });
    // The SAME record read by the installation that really observed it IS the
    // verification: the binding denies the copy, not the observation.
    expect(publicServiceStatus(services.get("svc")!, platform, "other-installation").launchVerification.rows.find((r) => r.platform === platform)?.verified).toBe(true);
    // A record with no installation binding (written before this binding
    // existed) and one whose template was superseded both stay unverified, by
    // name, with the reason that says so.
    const unbound = { ...foreign, serviceId: "svc", installationId: undefined };
    const stale = { ...foreign, serviceId: "svc", installationId: "this-installation", templateVersion: "v0" };
    const { services: unboundServices } = fixture(taskDir(), { log: memoryLaunchVerificationLog([unbound]) });
    expect(publicServiceStatus(unboundServices.get("svc")!, platform, "this-installation").launchVerification.rows.find((r) => r.platform === platform)).toEqual({ platform, verified: false, reason: "记录未绑定安装标识，本安装未实测" });
    const { services: staleServices } = fixture(taskDir(), { log: memoryLaunchVerificationLog([stale]) });
    expect(publicServiceStatus(staleServices.get("svc")!, platform, "this-installation").launchVerification.rows.find((r) => r.platform === platform)).toEqual({ platform, verified: false, reason: `记录来自模板 v0，当前模板 v1，未算已验证` });
  });

  it("lists the exact row shape the renderer parses, so the two ends cannot drift apart", () => {
    const dir = taskDir();
    const { services } = fixture(dir, { log: memoryLaunchVerificationLog() });
    const installationId = hostInstallationId();
    services.recordLaunchVerification("svc", { platform: hostPlatformLabel(), nodeVersion: "24.21.0", ok: true, program: "pnpm", args: ["dev", "web"], installationId });
    const status = publicServiceStatus(services.get("svc")!);
    expect(Object.keys(status.launchVerification).sort()).toEqual(["platform", "rows"]);
    const mine = status.launchVerification.rows.find((row) => row.platform === hostPlatformLabel())!;
    expect(Object.keys(mine).sort()).toEqual(["nodeVersion", "platform", "program", "startedAt", "stopped", "verified"]);
    const other = status.launchVerification.rows.find((row) => row.platform === "win32-x64")!;
    expect(Object.keys(other).sort()).toEqual(["platform", "reason", "verified"]);
    // The argv stays in the task Host: only the program token is projected.
    expect(JSON.stringify(status.launchVerification)).not.toContain("dev");
  });

  it("degrades a record with unusable launch facts to THAT row instead of blanking the status", () => {
    // `program: ""` is the exact shape the old projection turned into
    // `program: ""`, which the renderer's `optionalText` rejects - blanking the
    // ENTIRE service status. It must fail locally instead.
    const platform = hostPlatformLabel();
    const unusable = {
      schemaVersion: 1 as const, serviceId: "svc", platform, nodeVersion: "24.21.0", program: "", args: [],
      startedAt: "2026-10-08T00:00:00.000Z", stopped: false, installationId: "this-installation", templateVersion: "v1",
    };
    const { services } = fixture(taskDir(), { log: memoryLaunchVerificationLog([unusable]) });
    const status = publicServiceStatus(services.get("svc")!, platform, "this-installation");
    expect(status.launchVerification.rows.find((row) => row.platform === platform)).toEqual({ platform, verified: false, reason: "该平台的记录缺少启动事实，未算已验证" });
    // The rest of the read survives: one bad record never hides the other rows.
    expect(status.launchVerification.rows.map((row) => row.platform)).toEqual(expect.arrayContaining(["win32-x64"]));
  });
});

describe("#7 the task workspace's launch verification document", () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1 as const,
    serviceId: "svc",
    platform: "darwin-arm64",
    nodeVersion: "24.21.0",
    program: "pnpm",
    args: ["dev"],
    startedAt: "2026-10-08T00:00:00.000Z",
    stopped: false,
    ...over,
  });

  it("round-trips one entry atomically and keeps every other entry", () => {
    const dir = taskDir();
    writeLaunchVerificationOnDisk(dir, { version: 1, entries: [entry()] });
    const log = diskLaunchVerificationLog(dir);
    log.record({ ...entry({ serviceId: "other" }) } as never);
    const document = readLaunchVerificationOnDisk(dir);
    expect(document.entries.map((row) => row.serviceId).sort()).toEqual(["other", "svc"]);
    // The real temp name is `${file}.${uuid}.tmp`; the previous assertion
    // (`existsSync(`${file}.tmp`)`) could never be true and proved nothing.
    // Assert the real invariant: no temp file matching the real pattern is left
    // behind next to the document.
    const documentPath = launchVerificationFilePath(dir);
    expect(readdirSync(dir).filter((name) => name.startsWith(`${basename(documentPath)}.`) && name.endsWith(".tmp"))).toEqual([]);
    expect(readFileSync(launchVerificationFilePath(dir), "utf8")).toBe(JSON.stringify(document, null, 2));
  });

  it("refuses a corrupt document instead of believing part of it", () => {
    const dir = taskDir();
    expect(readLaunchVerificationOnDisk(dir)).toEqual(emptyLaunchVerificationDiskRecord());
    // A stop time with no stop, a stop with no time, a duplicate
    // (service, platform) row and a non-label platform are all corrupt.
    expect(() => parseLaunchVerificationRecord(JSON.stringify({ version: 1, entries: [entry({ stoppedAt: "2026-10-08T00:00:00.000Z" })] }))).toThrow("stoppedAt requires stopped");
    expect(() => parseLaunchVerificationRecord(JSON.stringify({ version: 1, entries: [entry({ stopped: true })] }))).toThrow("stoppedAt is required");
    expect(() => parseLaunchVerificationRecord(JSON.stringify({ version: 1, entries: [entry(), entry()] }))).toThrow("duplicate launch verification entry");
    expect(() => parseLaunchVerificationRecord(JSON.stringify({ version: 1, entries: [entry({ platform: "darwin" })] }))).toThrow("platform must be a <platform>-<arch> label");
    // The installation/template binding is optional on read, but a present
    // value must be usable: an empty string would read as "bound to nothing".
    expect(() => parseLaunchVerificationRecord(JSON.stringify({ version: 1, entries: [entry({ installationId: "" })] }))).toThrow("installationId must be a non-empty string");
    expect(() => parseLaunchVerificationRecord(JSON.stringify({ version: 1, entries: [entry({ templateVersion: "" })] }))).toThrow("templateVersion must be a non-empty string");
    expect(() => writeLaunchVerificationOnDisk(dir, { version: 99 as never, entries: [] })).toThrow("record.version must be 1");
  });

  it("leaves the platform unverified when the document cannot be read, and refuses to overwrite it", () => {
    const dir = taskDir();
    writeLaunchVerificationOnDisk(dir, { version: 1, entries: [entry()] });
    const log = diskLaunchVerificationLog(dir);
    expect(log.read()).toHaveLength(1);
    // Corrupt the document the way a hand edit or a partial mirror would.
    rmSync(launchVerificationFilePath(dir));
    writeLaunchVerificationOnDisk(dir, { version: 1, entries: [entry()] });
    expect(parseLaunchVerificationRecord(readFileSync(launchVerificationFilePath(dir), "utf8")).entries).toHaveLength(1);
    rmSync(launchVerificationFilePath(dir));
    writeFileSync(launchVerificationFilePath(dir), "{ not json", "utf8");
    // Reading is none-verified rather than a guess, and a new observation is
    // refused (the unreadable file may hold the only evidence there is).
    expect(log.read()).toEqual([]);
    expect(() => log.record({ ...entry({ serviceId: "other" }) } as never)).toThrow();
  });
});
