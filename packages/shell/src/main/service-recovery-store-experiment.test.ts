import { createHash } from "node:crypto";
import { chmodSync, existsSync, fsyncSync, fstatSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExperimentalServiceExecution, type ServiceExecutionCheckpoint } from "../host/service-execution-experiment.js";
import { TaskWriteCoordinator } from "../host/write-coordination.js";
import { ExperimentalServiceRecoveryStore, type CheckpointHostInstance } from "./service-recovery-store-experiment.js";
import { ServiceCatalog, serviceCatalogAuthority } from "./service-catalog.js";
import { ProjectRegistry } from "./project-registry.js";
import { TaskRootIndex, type VerifiedTaskIdentity } from "./task-root-index.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) };
});
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const taskId = "task-abcdef12", serviceId = "service-a";
type MockHost = { owner: CheckpointHostInstance; exit(): void; listenerCount(): number };
const homes: string[] = [], stores: ExperimentalServiceRecoveryStore[] = [], hosts: MockHost[] = [];
function host(): MockHost {
  let exited = false; const listeners = new Set<() => void>();
  const owner: CheckpointHostInstance = { sender: {}, hasExited: () => exited, subscribeExit: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const result = { owner, exit: () => { exited = true; for (const listener of [...listeners]) listener(); }, listenerCount: () => listeners.size };
  hosts.push(result); return result;
}
afterEach(() => {
  vi.mocked(fsyncSync).mockImplementation(actualFs.fsyncSync);
  for (const h of hosts.splice(0)) h.exit();
  for (const store of stores.splice(0)) { try { store.dispose(); } catch { /* Redirected test stores refuse cleanup. */ } }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-recovery-store-"))); homes.push(home);
  const profile = join(home, "profile"), root = join(home, "tasks"), taskDir = join(root, taskId);
  mkdirSync(profile, { mode: 0o700 }); mkdirSync(taskDir, { recursive: true, mode: 0o700 });
  const stat = statSync(taskDir, { bigint: true });
  let identity: VerifiedTaskIdentity | null = { taskId, createdAt: "2026-01-01T00:00:00.000Z", root, realRoot: root, dirId: taskId, directoryDevice: stat.dev.toString(), directoryInode: stat.ino.toString() };
  let projectId = "project-a", services = [serviceId, "service-b"];
  const authority = { projectExists: () => true, task: (id: string) => id === taskId && identity ? { identity: { ...identity }, projectId, rootIds: ["repo-a"] } : null };
  const open = () => { const store = new ExperimentalServiceRecoveryStore(profile, authority, () => services); stores.push(store); return store; };
  const directory = join(profile, "service-execution-recovery"), file = join(directory, `${createHash("sha256").update(taskId).digest("hex")}.json`);
  return { home, profile, root, taskDir, directory, file, open, authority, setIdentity: (value: VerifiedTaskIdentity | null) => { identity = value; }, identity: () => identity!, assign: () => { projectId = "other"; }, services: (ids: string[]) => { services = ids; } };
}
const checkpoint = (state: ServiceExecutionCheckpoint["state"] = "running", id = serviceId): ServiceExecutionCheckpoint => ({ schemaVersion: 1, taskId, serviceId: id, state, ownerSessionId: state === "stopped" || state === "exited" ? null : "main" });

describe.skipIf(process.platform === "win32")("main-only recovery store and Host instance leases", () => {
  it("refuses both journal copies deleted across a clean writer restart", () => {
    const f = fixture(), first = f.open(), h = host();
    first.acquire(taskId, h.owner).port(h.owner.sender, serviceId).write(checkpoint());
    h.exit(); first.dispose(); unlinkSync(f.file); unlinkSync(`${f.file}.bak`);
    const next = f.open();
    expect(() => next.acquire(taskId, host().owner)).toThrow("service-recovery-primary-missing");
    expect(existsSync(f.file)).toBe(false); expect(existsSync(`${f.file}.bak`)).toBe(false);
  });
  it("refuses a deleted recovery directory without recreating it", () => {
    const f = fixture(), first = f.open(); first.dispose();
    rmSync(f.directory, { recursive: true });
    expect(() => f.open()).toThrow("service-recovery-unavailable");
    expect(existsSync(f.directory)).toBe(false);
  });
  it("does not silently enroll a legacy directory or a deleted profile witness", () => {
    const legacy = fixture(); mkdirSync(legacy.directory, { mode: 0o700 });
    expect(() => legacy.open()).toThrow("service-recovery-unavailable");
    expect(readdirSync(legacy.directory)).toEqual([]);
    const f = fixture(), first = f.open(); first.dispose();
    unlinkSync(join(f.profile, "service-execution-recovery.witness.json"));
    expect(() => f.open()).toThrow("service-recovery-unavailable");
    expect(readdirSync(f.directory)).toEqual([]);
  });
  it("persists private path-free task witnesses before the first journal publication", () => {
    const f = fixture(), store = f.open(), h = host(), port = store.acquire(taskId, h.owner).port(h.owner.sender, serviceId);
    const path = join(f.profile, "service-execution-recovery.witness.json"), initial = readFileSync(path, "utf8");
    expect(JSON.parse(initial).tasks).toEqual({});
    let seen = false;
    vi.mocked(fsyncSync).mockImplementation((fd) => {
      actualFs.fsyncSync(fd);
      if (!existsSync(f.file) && Object.keys(JSON.parse(readFileSync(path, "utf8")).tasks).length) seen = true;
    });
    port.write(checkpoint());
    expect(seen).toBe(true); expect(statSync(path).mode & 0o777).toBe(0o600);
    const body = readFileSync(path, "utf8"), witness = JSON.parse(body);
    expect(Object.keys(witness.tasks)).toEqual([createHash("sha256").update(taskId).digest("hex")]);
    expect(body).not.toContain(f.home); expect(body).not.toContain(taskId); expect(body).not.toContain("main");
    h.exit(); store.dispose(); expect(readFileSync(path, "utf8")).toBe(body);
  });
  it("fences partial first publication without treating its durable reservation as fresh", () => {
    const f = fixture(), store = f.open(), h = host(), port = store.acquire(taskId, h.owner).port(h.owner.sender, serviceId);
    const path = join(f.profile, "service-execution-recovery.witness.json");
    vi.mocked(fsyncSync).mockImplementation((fd) => {
      actualFs.fsyncSync(fd);
      if (fstatSync(fd).isDirectory() && Object.keys(JSON.parse(readFileSync(path, "utf8")).tasks).length) throw Error("synthetic-private-fsync");
    });
    expect(() => port.write(checkpoint())).toThrow("service-recovery-write-uncertain");
    expect(() => port.write(checkpoint())).toThrow("service-recovery-lease-stale");
    vi.mocked(fsyncSync).mockImplementation(actualFs.fsyncSync);
    expect(existsSync(f.file)).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).tasks)).toHaveLength(1);
  });
  it("rejects linked, hardlinked, corrupt or public witnesses without replacing them", () => {
    for (const kind of ["symlink", "hardlink", "corrupt", "public"] as const) {
      const f = fixture(), first = f.open(); first.dispose();
      const path = join(f.profile, "service-execution-recovery.witness.json");
      if (kind === "symlink" || kind === "hardlink") {
        const outside = join(f.home, "outside-witness"); renameSync(path, outside);
        if (kind === "symlink") symlinkSync(outside, path); else linkSync(outside, path);
      } else if (kind === "corrupt") writeFileSync(path, "{"); else chmodSync(path, 0o644);
      expect(() => f.open()).toThrow("service-recovery-unavailable");
      expect(existsSync(join(f.directory, "writer.lock"))).toBe(false);
    }
  });
  it("rejects valid out-of-band witness changes before journal writes", () => {
    const f = fixture(), store = f.open(), h = host(), port = store.acquire(taskId, h.owner).port(h.owner.sender, serviceId);
    port.write(checkpoint()); const before = readFileSync(f.file, "utf8");
    const path = join(f.profile, "service-execution-recovery.witness.json");
    writeFileSync(path, readFileSync(path, "utf8") + "\n");
    expect(() => port.read()).toThrow(); expect(() => port.write(checkpoint("stopped"))).toThrow();
    expect(readFileSync(f.file, "utf8")).toBe(before);
  });
  it("permanently fences malformed witness reads even if external code restores the file", () => {
    const f = fixture(), store = f.open(), h = host(), port = store.acquire(taskId, h.owner).port(h.owner.sender, serviceId);
    port.write(checkpoint()); const before = readFileSync(f.file, "utf8");
    const path = join(f.profile, "service-execution-recovery.witness.json"), witness = readFileSync(path, "utf8");
    writeFileSync(path, "");
    expect(() => port.read()).toThrow("service-recovery-unavailable");
    writeFileSync(path, witness);
    expect(() => port.read()).toThrow("service-recovery-unavailable");
    expect(() => port.write(checkpoint("stopped"))).toThrow();
    h.exit(); expect(() => store.dispose()).toThrow("service-recovery-unavailable");
    expect(existsSync(join(f.directory, "writer.lock"))).toBe(true);
    expect(readFileSync(f.file, "utf8")).toBe(before);
  });
  it("rejects a replacement recovery inode under a surviving initialization witness", () => {
    const f = fixture(), first = f.open(); first.dispose();
    renameSync(f.directory, join(f.profile, "old-recovery")); mkdirSync(f.directory, { mode: 0o700 });
    expect(() => f.open()).toThrow("service-recovery-unavailable");
    expect(readdirSync(f.directory)).toEqual([]);
  });
  it("keeps a task presence reservation fail-closed when native exit interrupts first publication", () => {
    const f = fixture(), store = f.open(), h = host(), port = store.acquire(taskId, h.owner).port(h.owner.sender, serviceId);
    const path = join(f.profile, "service-execution-recovery.witness.json");
    vi.mocked(fsyncSync).mockImplementation((fd) => {
      actualFs.fsyncSync(fd);
      if (fstatSync(fd).isDirectory() && Object.keys(JSON.parse(readFileSync(path, "utf8")).tasks).length) h.exit();
    });
    expect(() => port.write(checkpoint())).toThrow("service-recovery-write-uncertain");
    vi.mocked(fsyncSync).mockImplementation(actualFs.fsyncSync);
    expect(existsSync(f.file)).toBe(false); expect(existsSync(`${f.file}.bak`)).toBe(false);
    store.dispose();
    const next = f.open(); expect(() => next.acquire(taskId, host().owner)).toThrow("service-recovery-primary-missing");
  });
  it("persists bounded minimal records outside the task with private permissions and durable backup", () => {
    const f = fixture(), store = f.open(), h = host(), lease = store.acquire(taskId, h.owner), port = lease.port(h.owner.sender, serviceId);
    expect(port.read()).toBeUndefined(); port.write(checkpoint());
    const body = readFileSync(f.file, "utf8"), doc = JSON.parse(body);
    expect(Object.keys(doc).sort()).toEqual(["entries", "hostEpoch", "identityDigest", "schemaVersion", "taskId"]);
    expect(doc.entries).toEqual([checkpoint()]); expect(doc.hostEpoch).toBe(lease.epoch); expect(doc.identityDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(body).not.toContain(f.root); expect(body).not.toContain(process.execPath); expect(body).not.toContain("pid");
    expect(statSync(f.directory).mode & 0o777).toBe(0o700); expect(statSync(f.file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(`${f.file}.bak`, "utf8")).entries).toEqual([checkpoint()]);
    expect(readdirSync(f.taskDir)).toEqual([]); expect(readdirSync(f.directory).some((name) => name.endsWith(".tmp"))).toBe(false);
    port.write(checkpoint("stopped")); expect(port.read()).toEqual(checkpoint("stopped"));
  });
  it("publishes a closed report only after every current-epoch service terminal, then requires explicit confirmation", () => {
    const f = fixture(), store = f.open(), h = host(), lease = store.acquire(taskId, h.owner);
    const report = { schemaVersion: 1, taskId, hostEpoch: lease.epoch, status: "closed" };
    for (const id of [serviceId, "service-b"]) lease.port(h.owner.sender, id).write(checkpoint("stopped", id));
    lease.request(h.owner.sender, { op: "shutdown", epoch: lease.epoch, report });
    expect(JSON.parse(readFileSync(f.file, "utf8")).shutdown).toEqual(report);
    expect(() => store.dispose()).toThrow("service-recovery-hosts-active");
    expect(() => lease.confirmShutdown({}, report)).toThrow("service-recovery-lease-stale");
    lease.verifyShutdown(h.owner.sender, report); lease.confirmShutdown(h.owner.sender, report);
    expect(() => lease.confirmShutdown(h.owner.sender, report)).toThrow("service-recovery-lease-stale");
    expect(() => lease.port(h.owner.sender, serviceId).write(checkpoint())).toThrow("service-recovery-lease-stale");
    h.exit(); const fresh = host(), next = store.acquire(taskId, fresh.owner);
    expect(() => next.confirmShutdown(fresh.owner.sender, report)).toThrow();
    expect(() => next.request(fresh.owner.sender, { op: "shutdown", epoch: next.epoch, report: { ...report, hostEpoch: next.epoch } })).toThrow("service-recovery-shutdown-unconfirmed");
  });
  it("refuses missing, running and unknown service terminals without treating absence as stopped", () => {
    for (const state of [undefined, "running", "unconfirmed"] as const) {
      const f = fixture(), h = host(), lease = f.open().acquire(taskId, h.owner);
      lease.port(h.owner.sender, serviceId).write(checkpoint("stopped"));
      if (state) lease.port(h.owner.sender, "service-b").write(checkpoint(state, "service-b"));
      expect(() => lease.request(h.owner.sender, { op: "shutdown", epoch: lease.epoch, report: { schemaVersion: 1, taskId, hostEpoch: lease.epoch, status: "closed" } })).toThrow("service-recovery-shutdown-unconfirmed");
      expect(JSON.parse(readFileSync(f.file, "utf8")).shutdown).toBeUndefined();
    }
  });
  it("rejects foreign epoch, extra fields and changed catalog membership for closing and confirmation", () => {
    const f = fixture(), h = host(), lease = f.open().acquire(taskId, h.owner);
    for (const id of [serviceId, "service-b"]) lease.port(h.owner.sender, id).write(checkpoint("stopped", id));
    const report = { schemaVersion: 1, taskId, hostEpoch: lease.epoch, status: "closed" }, packet = { op: "shutdown", epoch: lease.epoch, report };
    for (const invalid of [{ ...packet, epoch: "foreign" }, { ...packet, report: { ...report, secret: "synthetic-private" } }, { ...packet, path: f.profile }]) expect(() => lease.request(h.owner.sender, invalid)).toThrow();
    lease.request(h.owner.sender, packet); f.services([serviceId]);
    expect(() => lease.verifyShutdown(h.owner.sender, report)).toThrow("service-recovery-task-changed");
    expect(() => lease.confirmShutdown(h.owner.sender, report)).toThrow("service-recovery-task-changed");
  });
  it("fences a report whose primary was published but directory fsync failed", () => {
    const f = fixture(), h = host(), lease = f.open().acquire(taskId, h.owner);
    for (const id of [serviceId, "service-b"]) lease.port(h.owner.sender, id).write(checkpoint("stopped", id));
    const report = { schemaVersion: 1, taskId, hostEpoch: lease.epoch, status: "closed" };
    vi.mocked(fsyncSync).mockImplementation((fd) => { if (fstatSync(fd).isDirectory()) throw Error("synthetic-private-error"); actualFs.fsyncSync(fd); });
    expect(() => lease.request(h.owner.sender, { op: "shutdown", epoch: lease.epoch, report })).toThrow("service-recovery-write-uncertain");
    expect(JSON.parse(readFileSync(f.file, "utf8")).shutdown).toEqual(report);
    expect(() => lease.confirmShutdown(h.owner.sender, report)).toThrow("service-recovery-lease-stale");
  });
  it("rechecks identity after staging and refuses later out-of-band journal changes", () => {
    const f = fixture(), h = host(), lease = f.open().acquire(taskId, h.owner);
    for (const id of [serviceId, "service-b"]) lease.port(h.owner.sender, id).write(checkpoint("stopped", id));
    const before = readFileSync(f.file, "utf8"), report = { schemaVersion: 1, taskId, hostEpoch: lease.epoch, status: "closed" };
    vi.mocked(fsyncSync).mockImplementation((fd) => { actualFs.fsyncSync(fd); f.assign(); });
    expect(() => lease.request(h.owner.sender, { op: "shutdown", epoch: lease.epoch, report })).toThrow("service-recovery-write-uncertain"); expect(readFileSync(f.file, "utf8")).toBe(before);
    vi.mocked(fsyncSync).mockImplementation(actualFs.fsyncSync);
    const other = fixture(), current = host(), next = other.open().acquire(taskId, current.owner);
    for (const id of [serviceId, "service-b"]) next.port(current.owner.sender, id).write(checkpoint("stopped", id));
    const closed = { ...report, hostEpoch: next.epoch }; next.request(current.owner.sender, { op: "shutdown", epoch: next.epoch, report: closed });
    writeFileSync(other.file, readFileSync(other.file, "utf8") + "\n"); expect(() => next.confirmShutdown(current.owner.sender, closed)).toThrow("service-recovery-write-uncertain");
  });
  it("rejects native Host revocation during report staging before replacing the primary", () => {
    const f = fixture(), h = host(), lease = f.open().acquire(taskId, h.owner);
    for (const id of [serviceId, "service-b"]) lease.port(h.owner.sender, id).write(checkpoint("stopped", id));
    const before = readFileSync(f.file, "utf8"), report = { schemaVersion: 1, taskId, hostEpoch: lease.epoch, status: "closed" };
    vi.mocked(fsyncSync).mockImplementation((fd) => { actualFs.fsyncSync(fd); h.exit(); });
    expect(() => lease.request(h.owner.sender, { op: "shutdown", epoch: lease.epoch, report })).toThrow("service-recovery-write-uncertain");
    expect(readFileSync(f.file, "utf8")).toBe(before); expect(() => lease.confirmShutdown(h.owner.sender, report)).toThrow("service-recovery-lease-stale");
  });
  it("refuses another store/process writer and never guesses or steals a stale disk lock", () => {
    const f = fixture(), store = f.open();
    expect(() => f.open()).toThrow("service-recovery-unavailable");
    store.dispose(); writeFileSync(join(f.directory, "writer.lock"), "abandoned-test-lock", { mode: 0o600 });
    expect(() => f.open()).toThrow("service-recovery-unavailable");
    expect(readFileSync(join(f.directory, "writer.lock"), "utf8")).toBe("abandoned-test-lock");
  });
  it("permits one lease per task, binds the actual sender and rejects guessed epochs/paths", () => {
    const f = fixture(), store = f.open(), h = host(), lease = store.acquire(taskId, h.owner);
    expect(() => store.acquire(taskId, host().owner)).toThrow("service-recovery-lease-busy");
    expect(() => lease.request({}, { epoch: lease.epoch, op: "read", serviceId })).toThrow("service-recovery-lease-stale");
    for (const message of [null, { epoch: "old", op: "read", serviceId }, { epoch: lease.epoch, op: "read", serviceId: "../escape" },
      { epoch: lease.epoch, op: "read", serviceId, taskDir: f.taskDir }, { epoch: lease.epoch, op: "write", serviceId, checkpoint: { ...checkpoint(), env: { TOKEN: "synthetic-private" } } }]) {
      expect(() => lease.request(h.owner.sender, message)).toThrow();
    }
    expect(() => store.dispose()).toThrow("service-recovery-hosts-active");
    expect(() => lease.port(h.owner.sender, serviceId).write({ ...checkpoint(), taskId: "foreign" })).toThrow("invalid-service-recovery");
    expect(readdirSync(f.directory)).toEqual(["writer.lock"]);
  });
  it("revokes on real owner exit and denies old ports even after a new Host epoch is acquired", () => {
    const f = fixture(), store = f.open(), old = host(), first = store.acquire(taskId, old.owner), stale = first.port(old.owner.sender, serviceId);
    stale.write(checkpoint()); old.exit();
    const next = host(), second = store.acquire(taskId, next.owner), current = second.port(next.owner.sender, serviceId);
    expect(second.epoch).not.toBe(first.epoch); expect(current.read()).toEqual(checkpoint());
    expect(() => stale.write(checkpoint("stopped"))).toThrow("service-recovery-lease-stale");
    expect(() => stale.read()).toThrow("service-recovery-lease-stale");
    old.exit(); current.write(checkpoint("unconfirmed")); expect(current.read()).toEqual(checkpoint("unconfirmed"));
    expect(old.listenerCount()).toBe(0);
  });
  it("keeps distinct task leases independent but never binds one Host to two tasks", () => {
    const f = fixture(), otherTask = "task-fedcba21", original = f.authority.task;
    f.authority.task = (id) => id === otherTask ? { identity: { ...f.identity(), taskId: otherTask, dirId: otherTask }, projectId: "project-a", rootIds: ["repo-a"] } : original(id);
    const store = f.open(), a = host(), b = host(), first = store.acquire(taskId, a.owner);
    expect(() => store.acquire(otherTask, a.owner)).toThrow("service-recovery-lease-busy");
    const second = store.acquire(otherTask, b.owner), one = first.port(a.owner.sender, serviceId), two = second.port(b.owner.sender, serviceId);
    one.write(checkpoint()); two.write({ ...checkpoint("starting"), taskId: otherTask });
    expect(one.read()).toEqual(checkpoint()); expect(two.read()).toEqual({ ...checkpoint("starting"), taskId: otherTask });
    expect(() => first.request(b.owner.sender, { epoch: first.epoch, op: "read", serviceId })).toThrow("service-recovery-lease-stale");
    expect(() => two.write(checkpoint())).toThrow("invalid-service-recovery");
    a.exit(); expect(two.read()).toEqual({ ...checkpoint("starting"), taskId: otherTask });
  });
  it("refuses already exited owners and an exit during subscription without leaving a lease", () => {
    const f = fixture(), store = f.open(), h = host(); h.exit();
    expect(() => store.acquire(taskId, h.owner)).toThrow();
    const racing = host(); racing.owner.subscribeExit = (listener) => { racing.exit(); listener(); return () => {}; };
    expect(() => store.acquire(taskId, racing.owner)).toThrow();
    expect(() => store.acquire(taskId, host().owner)).not.toThrow();
  });
  it("rechecks task identity, project and service membership before reads or writes", () => {
    for (const change of ["identity", "project", "services", "unavailable"] as const) {
      const f = fixture(), store = f.open(), h = host(), port = store.acquire(taskId, h.owner).port(h.owner.sender, serviceId);
      port.write(checkpoint()); const before = readFileSync(f.file, "utf8");
      if (change === "identity") f.setIdentity({ ...f.identity(), directoryInode: "999" });
      if (change === "project") f.assign();
      if (change === "services") f.services([]);
      if (change === "unavailable") f.setIdentity(null);
      expect(() => port.write(checkpoint("stopped"))).toThrow(); expect(() => port.read()).toThrow();
      expect(readFileSync(f.file, "utf8")).toBe(before);
    }
  });
  it("does not allow removed nonterminal services to disappear on a new lease", () => {
    const f = fixture(), store = f.open(), old = host(), port = store.acquire(taskId, old.owner).port(old.owner.sender, serviceId);
    port.write(checkpoint()); old.exit(); f.services(["service-b"]);
    expect(() => store.acquire(taskId, host().owner)).toThrow("service-recovery-unbound-resource");
  });
  it("rejects a storage directory overlapping the trusted task", () => {
    const f = fixture(); f.setIdentity({ ...f.identity(), realRoot: f.home, root: f.home, dirId: "profile" });
    const store = f.open(); expect(() => store.acquire(taskId, host().owner)).toThrow("service-recovery-storage-overlap");
  });
  it("keeps interruption unconfirmed across a fresh main store without launching or adopting a PID", () => {
    const f = fixture(), first = f.open(), old = host(), port = first.acquire(taskId, old.owner).port(old.owner.sender, serviceId);
    port.write(checkpoint()); old.exit(); first.dispose();
    const second = f.open(), h = host(), recovered = second.acquire(taskId, h.owner).port(h.owner.sender, serviceId);
    let executed = false;
    const execution = new ExperimentalServiceExecution({ taskId, serviceId, taskDir: f.taskDir, revision: () => "test", write: new TaskWriteCoordinator(), recovery: recovered,
      start: async () => { executed = true; throw Error("must-not-launch"); } });
    expect(execution.snapshot().state).toBe("unconfirmed"); expect(executed).toBe(false);
    expect(execution.resources()).toMatchObject([{ verificationRequired: true, ownerSessionId: "main" }]);
  });
  it("refuses missing/corrupt/foreign primaries without restoring backups or inventing absence", () => {
    for (const change of ["missing", "corrupt", "extra", "identity", "oversized"] as const) {
      const f = fixture(), store = f.open(), h = host(), port = store.acquire(taskId, h.owner).port(h.owner.sender, serviceId);
      port.write(checkpoint()); h.exit();
      if (change === "missing") unlinkSync(f.file);
      else if (change === "corrupt") writeFileSync(f.file, "{", { mode: 0o600 });
      else if (change === "oversized") writeFileSync(f.file, "x".repeat(65537), { mode: 0o600 });
      else { const doc = JSON.parse(readFileSync(f.file, "utf8")); if (change === "extra") doc.pid = 123; else doc.identityDigest = "0".repeat(64); writeFileSync(f.file, JSON.stringify(doc), { mode: 0o600 }); }
      expect(() => store.acquire(taskId, host().owner)).toThrow();
      expect(JSON.parse(readFileSync(`${f.file}.bak`, "utf8")).entries).toEqual([checkpoint()]);
    }
  });
  it("refuses linked/hardlinked/public checkpoint files and public recovery directories", () => {
    for (const kind of ["symlink", "hardlink", "public-file", "public-directory"] as const) {
      const f = fixture(), store = f.open(), h = host(), port = store.acquire(taskId, h.owner).port(h.owner.sender, serviceId);
      port.write(checkpoint());
      if (kind === "symlink" || kind === "hardlink") { const outside = join(f.home, "outside.json"); renameSync(f.file, outside); if (kind === "symlink") symlinkSync(outside, f.file); else { linkSync(outside, f.file); } }
      if (kind === "public-file") chmodSync(f.file, 0o644);
      if (kind === "public-directory") chmodSync(f.directory, 0o755);
      expect(() => port.read()).toThrow(); expect(() => port.write(checkpoint("stopped"))).toThrow();
      if (kind === "public-directory") chmodSync(f.directory, 0o700);
    }
  });
  it("fences valid out-of-band modifications until the owner exits instead of blind overwriting", () => {
    const f = fixture(), store = f.open(), h = host(), port = store.acquire(taskId, h.owner).port(h.owner.sender, serviceId);
    port.write(checkpoint()); const doc = JSON.parse(readFileSync(f.file, "utf8")); doc.entries[0] = checkpoint("stopped");
    writeFileSync(f.file, JSON.stringify(doc), { mode: 0o600 }); const changed = readFileSync(f.file, "utf8");
    expect(() => port.write(checkpoint())).toThrow("service-recovery-write-uncertain");
    expect(() => port.read()).toThrow("service-recovery-lease-stale"); expect(readFileSync(f.file, "utf8")).toBe(changed);
  });
  it("rejects linked directories and replaced directory or lock identity without deleting foreign locks", () => {
    const f = fixture(), store = f.open(), h = host(), port = store.acquire(taskId, h.owner).port(h.owner.sender, serviceId);
    const original = join(f.profile, "old-recovery"); renameSync(f.directory, original); mkdirSync(f.directory, { mode: 0o700 });
    writeFileSync(join(f.directory, "writer.lock"), "foreign-lock", { mode: 0o600 });
    expect(() => port.read()).toThrow(); h.exit(); expect(() => store.dispose()).toThrow();
    expect(readFileSync(join(f.directory, "writer.lock"), "utf8")).toBe("foreign-lock");
    const other = fixture(); symlinkSync(f.directory, other.directory);
    expect(() => other.open()).toThrow();
    rmSync(f.directory, { recursive: true }); renameSync(original, f.directory);
  });
  it("fences failure before publication without retrying or leaking OS error text", () => {
    const f = fixture(), store = f.open(), h = host(), port = store.acquire(taskId, h.owner).port(h.owner.sender, serviceId);
    port.write(checkpoint("starting")); const before = readFileSync(f.file, "utf8");
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw Error(`synthetic-private ${f.profile}`); });
    expect(() => port.write(checkpoint())).toThrow("service-recovery-write-uncertain");
    expect(readFileSync(f.file, "utf8")).toBe(before);
    expect(() => port.write(checkpoint())).toThrow("service-recovery-lease-stale");
    expect(readdirSync(f.directory).some((name) => name.endsWith(".tmp"))).toBe(false);
  });
  it("does not acknowledge a partially successful publish or blindly retry after rename", () => {
    const f = fixture(), store = f.open(), h = host(), lease = store.acquire(taskId, h.owner), port = lease.port(h.owner.sender, serviceId);
    port.write(checkpoint("starting"));
    vi.mocked(fsyncSync).mockImplementation((fd) => {
      actualFs.fsyncSync(fd);
      if (fstatSync(fd).isDirectory()) throw Error("synthetic-private-directory-sync-error");
    });
    expect(() => port.write(checkpoint())).toThrow("service-recovery-write-uncertain");
    expect(JSON.parse(readFileSync(f.file, "utf8")).entries).toEqual([checkpoint()]);
    expect(JSON.parse(readFileSync(`${f.file}.bak`, "utf8")).entries).toEqual([checkpoint("starting")]);
    vi.mocked(fsyncSync).mockImplementation(actualFs.fsyncSync);
    expect(() => port.write(checkpoint("stopped"))).toThrow("service-recovery-lease-stale");
    expect(() => store.acquire(taskId, host().owner)).toThrow("service-recovery-lease-busy");
    h.exit(); const next = host(), recovered = store.acquire(taskId, next.owner).port(next.owner.sender, serviceId);
    expect(recovered.read()).toEqual(checkpoint());
    expect(() => port.write(checkpoint("stopped"))).toThrow("service-recovery-lease-stale");
  });
  it("rechecks service membership after staging and refuses numeric IDs or corrupt backups", () => {
    const f = fixture(), store = f.open(), h = host(), port = store.acquire(taskId, h.owner).port(h.owner.sender, serviceId);
    port.write(checkpoint("starting")); const before = readFileSync(f.file, "utf8");
    vi.mocked(fsyncSync).mockImplementationOnce((fd) => { actualFs.fsyncSync(fd); f.services([]); });
    expect(() => port.write(checkpoint())).toThrow("service-recovery-write-uncertain"); expect(readFileSync(f.file, "utf8")).toBe(before);
    h.exit(); f.services([serviceId]);
    const doc = JSON.parse(before); doc.entries[0] = { ...checkpoint("stopped"), serviceId: 123 };
    writeFileSync(f.file, JSON.stringify(doc)); expect(() => store.acquire(taskId, host().owner)).toThrow();
    writeFileSync(f.file, before); writeFileSync(`${f.file}.bak`, "{");
    expect(() => store.acquire(taskId, host().owner)).toThrow(); expect(readFileSync(f.file, "utf8")).toBe(before);
  });
  it("rejects publicly writable profiles and a changed profile parent even when the recovery inode is retained", () => {
    const publicProfile = fixture(); chmodSync(publicProfile.profile, 0o777);
    expect(() => publicProfile.open()).toThrow(); expect(existsSync(publicProfile.directory)).toBe(false);
    expect(statSync(publicProfile.profile).mode & 0o777).toBe(0o777);
    const f = fixture(), store = f.open(), h = host(), port = store.acquire(taskId, h.owner).port(h.owner.sender, serviceId);
    const oldProfile = join(f.home, "old-profile"); renameSync(f.profile, oldProfile); mkdirSync(f.profile, { mode: 0o700 });
    renameSync(join(oldProfile, "service-execution-recovery"), f.directory);
    expect(() => port.read()).toThrow(); expect(() => port.write(checkpoint())).toThrow();
    renameSync(f.directory, join(oldProfile, "service-execution-recovery")); rmSync(f.profile, { recursive: true }); renameSync(oldProfile, f.profile);
  });
  it("uses actual task/project/catalog authority rather than request paths", async () => {
    const f = fixture(); mkdirSync(join(f.taskDir, "repo-a"));
    writeFileSync(join(f.taskDir, "task.json"), JSON.stringify({ taskId, name: "Recovery", dirId: taskId, root: f.root, taskDir: f.taskDir, branch: "task/main",
      remoteBranch: "main", baseCommit: "test", repos: ["repo-a"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }));
    const roots = new TaskRootIndex(f.profile, f.root), projects = new ProjectRegistry(f.profile);
    const project = await projects.create({ name: "Recovery", description: "", repositories: [], directories: [] }); await projects.claim(taskId, project.id, roots);
    const authority = serviceCatalogAuthority(roots, projects), catalog = new ServiceCatalog(f.profile, authority);
    const template = catalog.saveTemplate({ projectId: project.id, descriptor: { name: "API", program: "node", args: [], ports: [], runType: "long-lived" }, shared: [] });
    catalog.bindTask({ taskId, serviceId: template.serviceId, templateVersion: 1, rootId: "repo-a", subdir: "", programPath: process.execPath, privateRefs: [] });
    const store = new ExperimentalServiceRecoveryStore(f.profile, authority, (id) => catalog.listTask(id).map((row) => row.binding.serviceId)); stores.push(store);
    const h = host(), port = store.acquire(taskId, h.owner).port(h.owner.sender, template.serviceId);
    port.write(checkpoint("starting", template.serviceId)); expect(port.read()).toEqual(checkpoint("starting", template.serviceId));
    expect(readFileSync(f.file, "utf8")).not.toContain(process.execPath);
  });
});
