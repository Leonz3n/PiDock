import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { experimentalShutdownReport, type ExperimentalShutdownReport } from "../rpc/host-shutdown-report.js";
import { serviceExecutionCheckpoint, type ServiceExecutionCheckpoint } from "../rpc/service-execution-checkpoint.js";
import type { ServiceExecutionRecoveryPort } from "../host/service-execution-experiment.js";
import type { ServiceCatalogAuthority } from "./service-catalog.js";

const MAX_BYTES = 64 * 1024;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function fail(code = "service-recovery-unavailable"): never { throw Error(code); }
interface Document { schemaVersion: 1; taskId: string; identityDigest: string; hostEpoch: string; entries: ServiceExecutionCheckpoint[]; shutdown?: ExperimentalShutdownReport }
export interface CheckpointHostInstance {
  /** Main-held actual child object; never a JSON actor id or PID. */
  sender: object;
  hasExited(): boolean;
  subscribeExit(listener: () => void): () => void;
}
interface Slot {
  taskId: string; identityDigest: string; hostEpoch: string; owner: CheckpointHostInstance;
  services: Set<string>; written: Set<string>; closed: boolean; confirmed: boolean; stamp: string | null; revoked: boolean; uncertain: boolean; detach: () => void;
}
export interface ExperimentalCheckpointLease {
  readonly epoch: string;
  /** Only after the current actual Host returns its successful post-ack receipt. Does not kill it. */
  confirmShutdown(sender: object, report: unknown): void;
  verifyShutdown(sender: object, report: unknown): void;
  request(sender: object, message: unknown): ServiceExecutionCheckpoint | undefined;
  /** Same-process test adapter only. Not a synchronous utilityProcess RPC. */
  port(sender: object, serviceId: string): ServiceExecutionRecoveryPort;
}
function sameFile(a: BigIntStats, b: BigIntStats) { return a.dev === b.dev && a.ino === b.ino; }
function contained(parent: string, child: string) {
  const rel = relative(parent, child); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Main-only POSIX experiment. Not imported by production Host/main or exposed to renderer. */
export class ExperimentalServiceRecoveryStore {
  private readonly directory: string;
  private readonly profilePath: string;
  private readonly profileIdentity: BigIntStats;
  private readonly directoryFd: number;
  private readonly directoryIdentity: BigIntStats;
  private readonly lockIdentity: BigIntStats;
  private readonly writerFd: number;
  private readonly active = new Map<string, Slot>();
  private disposed = false;
  private readonly uid: bigint;
  constructor(profile: string, private readonly authority: ServiceCatalogAuthority, private readonly serviceIds: (taskId: string) => readonly string[]) {
    if (process.platform === "win32" || !process.geteuid || !isAbsolute(profile)) fail();
    this.uid = BigInt(process.geteuid());
    let directoryFd: number | undefined, lockFd: number | undefined, lockIdentity: BigIntStats | undefined, directory: string | undefined;
    try {
      const profileStat = lstatSync(profile, { bigint: true });
      if (!profileStat.isDirectory() || profileStat.uid !== this.uid || (profileStat.mode & 0o022n) !== 0n) fail();
      this.profilePath = realpathSync(profile); this.profileIdentity = profileStat;
      this.directory = directory = join(this.profilePath, "service-execution-recovery");
      try { mkdirSync(this.directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      directoryFd = openSync(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(directoryFd, { bigint: true });
      if (!stat.isDirectory() || stat.uid !== this.uid || (stat.mode & 0o077n) !== 0n || !sameFile(stat, lstatSync(this.directory, { bigint: true }))) fail();
      lockFd = openSync(join(this.directory, "writer.lock"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      lockIdentity = fstatSync(lockFd, { bigint: true });
      writeFileSync(lockFd, randomUUID()); fsyncSync(lockFd); fsyncSync(directoryFd);
      this.directoryFd = directoryFd; this.directoryIdentity = stat; this.lockIdentity = lockIdentity;
      this.writerFd = lockFd; this.checkDirectory(); lockFd = undefined;
    } catch {
      if (lockIdentity && directory) {
        try { const path = join(directory, "writer.lock"); if (sameFile(lockIdentity, lstatSync(path, { bigint: true }))) unlinkSync(path); } catch { /* Never remove an unknown lock. */ }
      }
      if (directoryFd !== undefined) closeSync(directoryFd);
      fail();
    } finally { if (lockFd !== undefined) closeSync(lockFd); }
  }
  private checkDirectory() {
    if (this.disposed) fail();
    const profile = lstatSync(this.profilePath, { bigint: true });
    if (!profile.isDirectory() || profile.uid !== this.uid || (profile.mode & 0o022n) !== 0n || !sameFile(profile, this.profileIdentity)) fail();
    const current = lstatSync(this.directory, { bigint: true });
    if (!current.isDirectory() || current.uid !== this.uid || (current.mode & 0o077n) !== 0n ||
        !sameFile(current, this.directoryIdentity) || !sameFile(fstatSync(this.directoryFd, { bigint: true }), current)) fail();
    const lock = lstatSync(join(this.directory, "writer.lock"), { bigint: true });
    if (!lock.isFile() || lock.nlink !== 1n || lock.uid !== this.uid || (lock.mode & 0o077n) !== 0n || !sameFile(lock, this.lockIdentity) || !sameFile(lock, fstatSync(this.writerFd, { bigint: true }))) fail();
  }
  private taskScope(taskId: string) {
    if (!ID.test(taskId)) fail();
    const task = this.authority.task(taskId);
    if (!task || task.identity.taskId !== taskId || !this.authority.projectExists(task.projectId)) fail("service-recovery-task-unavailable");
    const taskRoot = join(task.identity.realRoot, task.identity.dirId);
    if (contained(taskRoot, this.directory) || contained(this.directory, taskRoot)) fail("service-recovery-storage-overlap");
    const identity = task.identity;
    const identityDigest = digest(JSON.stringify({ projectId: task.projectId, taskId, createdAt: identity.createdAt,
      root: identity.root, realRoot: identity.realRoot, dirId: identity.dirId, device: identity.directoryDevice, inode: identity.directoryInode }));
    const ids = [...this.serviceIds(taskId)];
    if (ids.length > 100 || ids.some((id) => !ID.test(id)) || new Set(ids).size !== ids.length) fail();
    return { identityDigest, services: new Set(ids) };
  }
  private file(taskId: string) { return join(this.directory, `${digest(taskId)}.json`); }
  private bounded(path: string): string | null {
    let fd: number | undefined;
    try {
      try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.uid !== this.uid || (before.mode & 0o077n) !== 0n || before.size <= 0n || before.size > BigInt(MAX_BYTES)) fail();
      const buffer = Buffer.alloc(Number(before.size) + 1); let count = 0;
      while (count < buffer.length) { const read = readSync(fd, buffer, count, buffer.length - count, null); if (!read) break; count += read; }
      const after = fstatSync(fd, { bigint: true }), atPath = lstatSync(path, { bigint: true });
      if (count !== Number(before.size) || !sameFile(before, after) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
          !atPath.isFile() || !sameFile(after, atPath) || after.mode !== atPath.mode || after.nlink !== 1n || after.uid !== this.uid || (after.mode & 0o077n) !== 0n) fail();
      return buffer.subarray(0, count).toString("utf8");
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  private parse(text: string, taskId: string, identityDigest: string): Document {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    const row = value as Record<string, unknown>;
    if (!["entries,hostEpoch,identityDigest,schemaVersion,taskId", "entries,hostEpoch,identityDigest,schemaVersion,shutdown,taskId"].includes(Object.keys(row).sort().join(",")) || row.schemaVersion !== 1 || row.taskId !== taskId ||
        row.identityDigest !== identityDigest || typeof row.hostEpoch !== "string" || !UUID.test(row.hostEpoch) || !Array.isArray(row.entries) || row.entries.length > 100) fail();
    const entries = row.entries.map((raw: unknown) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail();
      const serviceId = (raw as Record<string, unknown>).serviceId;
      if (typeof serviceId !== "string" || !ID.test(serviceId)) fail();
      return serviceExecutionCheckpoint(raw, taskId, serviceId);
    });
    if (new Set(entries.map((entry) => entry.serviceId)).size !== entries.length) fail();
    const shutdown = row.shutdown === undefined ? undefined : experimentalShutdownReport(row.shutdown, taskId, row.hostEpoch);
    if (shutdown && entries.some((entry) => (entry.state !== "stopped" && entry.state !== "exited") || entry.ownerSessionId !== null)) fail();
    return { schemaVersion: 1, taskId, identityDigest, hostEpoch: row.hostEpoch, entries, ...(shutdown ? { shutdown } : {}) };
  }
  private load(taskId: string, identityDigest: string) {
    this.checkDirectory();
    const file = this.file(taskId), body = this.bounded(file), backup = this.bounded(`${file}.bak`);
    if (backup !== null) this.parse(backup, taskId, identityDigest);
    if (body === null && backup !== null) fail("service-recovery-primary-missing");
    const document = body === null ? null : this.parse(body, taskId, identityDigest);
    this.checkDirectory();
    return { document, body, stamp: body === null ? null : digest(body) };
  }
  acquire(taskId: string, owner: CheckpointHostInstance): ExperimentalCheckpointLease {
    try {
      this.checkDirectory();
      if (this.active.has(taskId) || [...this.active.values()].some((slot) => slot.owner.sender === owner.sender)) fail("service-recovery-lease-busy");
      if (this.active.size >= 128 || !owner.sender || typeof owner.sender !== "object" || owner.hasExited()) fail();
      owner = { sender: owner.sender, hasExited: owner.hasExited.bind(owner), subscribeExit: owner.subscribeExit.bind(owner) };
      const scope = this.taskScope(taskId), loaded = this.load(taskId, scope.identityDigest);
      if (loaded.document?.entries.some((row) => !scope.services.has(row.serviceId) && row.state !== "stopped" && row.state !== "exited")) fail("service-recovery-unbound-resource");
      const slot: Slot = { taskId, ...scope, hostEpoch: randomUUID(), owner, written: new Set(), closed: false, confirmed: false, stamp: loaded.stamp, revoked: false, uncertain: false, detach: () => {} };
      this.active.set(taskId, slot);
      try {
        slot.detach = owner.subscribeExit(() => {
          slot.revoked = true;
          if (this.active.get(taskId) === slot) this.active.delete(taskId);
          slot.detach();
        });
        if (owner.hasExited() || slot.revoked) fail();
      } catch { slot.revoked = true; if (this.active.get(taskId) === slot) this.active.delete(taskId); slot.detach(); throw Error(); }
      const request = (sender: object, message: unknown) => this.request(slot, sender, message);
      return Object.freeze({ epoch: slot.hostEpoch, request, confirmShutdown: (sender: object, report: unknown) => this.confirmShutdown(slot, sender, report, true), verifyShutdown: (sender: object, report: unknown) => this.confirmShutdown(slot, sender, report, false), port: (sender: object, serviceId: string): ServiceExecutionRecoveryPort => ({
        read: () => request(sender, { epoch: slot.hostEpoch, op: "read", serviceId }),
        write: (checkpoint) => { request(sender, { epoch: slot.hostEpoch, op: "write", serviceId, checkpoint }); return undefined; },
      }) });
    } catch (error) { this.sanitize(error); }
  }
  private request(slot: Slot, sender: object, message: unknown): ServiceExecutionCheckpoint | undefined {
    try {
      if (this.disposed || slot.revoked || slot.uncertain || this.active.get(slot.taskId) !== slot || sender !== slot.owner.sender || slot.owner.hasExited()) fail("service-recovery-lease-stale");
      if (!message || typeof message !== "object" || Array.isArray(message) || Buffer.byteLength(JSON.stringify(message)) > 4096) fail("invalid-service-recovery-request");
      const row = message as Record<string, unknown>, write = row.op === "write";
      if (row.op === "shutdown") {
        this.closeReport(slot, row);
        return undefined;
      }
      if (write && slot.closed) fail("service-recovery-lease-stale");
      if ((row.op !== "read" && !write) || row.epoch !== slot.hostEpoch || typeof row.serviceId !== "string" || !slot.services.has(row.serviceId) ||
          Object.keys(row).sort().join(",") !== (write ? "checkpoint,epoch,op,serviceId" : "epoch,op,serviceId")) fail("invalid-service-recovery-request");
      const scope = this.taskScope(slot.taskId);
      if (scope.identityDigest !== slot.identityDigest || !scope.services.has(row.serviceId)) fail("service-recovery-task-changed");
      const loaded = this.load(slot.taskId, slot.identityDigest);
      if (loaded.stamp !== slot.stamp) { slot.uncertain = true; fail("service-recovery-write-uncertain"); }
      if (!write) return loaded.document?.entries.find((entry) => entry.serviceId === row.serviceId);
      const checkpoint = serviceExecutionCheckpoint(row.checkpoint, slot.taskId, row.serviceId);
      const entries = loaded.document?.entries.filter((entry) => entry.serviceId !== row.serviceId) ?? [];
      entries.push(checkpoint); entries.sort((a, b) => a.serviceId.localeCompare(b.serviceId));
      const body = JSON.stringify({ schemaVersion: 1, taskId: slot.taskId, identityDigest: slot.identityDigest, hostEpoch: slot.hostEpoch, entries });
      if (Buffer.byteLength(body) > MAX_BYTES || entries.length > 100) fail();
      try { this.publish(slot, checkpoint.serviceId, body, loaded.body); }
      catch { slot.uncertain = true; fail("service-recovery-write-uncertain"); }
      slot.stamp = digest(body); slot.written.add(checkpoint.serviceId);
      return undefined;
    } catch (error) { this.sanitize(error); }
  }
  private closeScope(slot: Slot) {
    const scope = this.taskScope(slot.taskId);
    if (scope.identityDigest !== slot.identityDigest || scope.services.size !== slot.services.size || [...scope.services].some((id) => !slot.services.has(id))) fail("service-recovery-task-changed");
    const loaded = this.load(slot.taskId, slot.identityDigest);
    if (loaded.stamp !== slot.stamp) { slot.uncertain = true; fail("service-recovery-write-uncertain"); }
    if ([...slot.services].some((id) => !slot.written.has(id) || !loaded.document?.entries.some((entry) => entry.serviceId === id && (entry.state === "stopped" || entry.state === "exited") && entry.ownerSessionId === null)) ||
        loaded.document?.entries.some((entry) => entry.state !== "stopped" && entry.state !== "exited")) fail("service-recovery-shutdown-unconfirmed");
    return loaded;
  }
  private closeReport(slot: Slot, row: Record<string, unknown>) {
    if (slot.closed || Object.keys(row).sort().join(",") !== "epoch,op,report" || row.epoch !== slot.hostEpoch) fail("invalid-service-recovery-request");
    const shutdown = experimentalShutdownReport(row.report, slot.taskId, slot.hostEpoch), loaded = this.closeScope(slot);
    const body = JSON.stringify({ schemaVersion: 1, taskId: slot.taskId, identityDigest: slot.identityDigest, hostEpoch: slot.hostEpoch, entries: loaded.document?.entries ?? [], shutdown });
    if (Buffer.byteLength(body) > MAX_BYTES) fail();
    try { this.publish(slot, undefined, body, loaded.body); }
    catch { slot.uncertain = true; fail("service-recovery-write-uncertain"); }
    slot.stamp = digest(body); slot.closed = true;
  }
  private confirmShutdown(slot: Slot, sender: object, value: unknown, consume: boolean): void {
    try {
      if (this.disposed || slot.revoked || slot.uncertain || slot.confirmed || !slot.closed || sender !== slot.owner.sender || slot.owner.hasExited() || this.active.get(slot.taskId) !== slot) fail("service-recovery-lease-stale");
      const report = experimentalShutdownReport(value, slot.taskId, slot.hostEpoch), loaded = this.closeScope(slot);
      if (JSON.stringify(loaded.document?.shutdown) !== JSON.stringify(report)) fail("service-recovery-shutdown-unconfirmed");
      if (consume) slot.confirmed = true;
    } catch (error) { this.sanitize(error); }
  }
  private publish(slot: Slot, serviceId: string | undefined, body: string, prior: string | null) {
    const file = this.file(slot.taskId), temps: { path: string; stat: BigIntStats }[] = [];
    const stage = (suffix: string, text: string) => {
      this.checkDirectory();
      const path = `${file}.${randomUUID()}.${suffix}`;
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { temps.push({ path, stat: fstatSync(fd, { bigint: true }) }); writeFileSync(fd, text); fsyncSync(fd); }
      finally { closeSync(fd); }
      return path;
    };
    try {
      const temp = stage("tmp", body), backup = stage("bak.tmp", prior ?? body);
      if (this.load(slot.taskId, slot.identityDigest).stamp !== slot.stamp) fail();
      const scope = this.taskScope(slot.taskId);
      if (serviceId === undefined) this.closeScope(slot);
      if (scope.identityDigest !== slot.identityDigest || (serviceId !== undefined && !scope.services.has(serviceId)) || slot.owner.hasExited() || slot.revoked) fail();
      renameSync(backup, `${file}.bak`); renameSync(temp, file);
      fsyncSync(this.directoryFd); this.checkDirectory();
      if (this.bounded(file) !== body || this.bounded(`${file}.bak`) !== (prior ?? body)) fail();
    } finally {
      for (const temp of temps) {
        try { this.checkDirectory(); if (sameFile(temp.stat, lstatSync(temp.path, { bigint: true }))) unlinkSync(temp.path); } catch { /* Do not clean a redirected/replaced path. */ }
      }
    }
  }
  /** Main calls this only after every registered Host exit has revoked its lease. */
  dispose(): void {
    if (this.disposed) return;
    try {
      if (this.active.size) fail("service-recovery-hosts-active");
      this.checkDirectory(); unlinkSync(join(this.directory, "writer.lock")); this.disposed = true;
      try { fsyncSync(this.directoryFd); }
      finally { closeSync(this.writerFd); closeSync(this.directoryFd); }
    } catch (error) { this.sanitize(error); }
  }
  private sanitize(error: unknown): never {
    const message = error instanceof Error ? error.message : "";
    if (/^(?:service-recovery-(?:unavailable|task-unavailable|storage-overlap|primary-missing|lease-busy|unbound-resource|lease-stale|task-changed|write-uncertain|hosts-active|shutdown-unconfirmed)|invalid-service-recovery(?:-request)?|invalid-shutdown-report)$/.test(message)) throw Error(message);
    return fail();
  }
}
