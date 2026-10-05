import { mkdirSync, mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { ExperimentalHostRelease } from "./host-release-experiment.js";
import { ExperimentalServiceRecoveryStore, type CheckpointHostInstance } from "./service-recovery-store-experiment.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
it.skipIf(process.platform === "win32")("consumes real store confirmation and disposes its writer only after native Host revocation", async () => {
  const home = mkdtempSync(join(tmpdir(), "pidock-release-store-")); homes.push(home);
  const profile = join(home, "profile"), root = join(home, "tasks"), taskId = "task-a", taskDir = join(root, taskId);
  mkdirSync(profile, { mode: 0o700 }); mkdirSync(taskDir, { recursive: true }); const stat = statSync(taskDir, { bigint: true });
  const authority = { projectExists: () => true, task: () => ({ projectId: "project-a", rootIds: ["repo-a"], identity: {
    taskId, createdAt: "2026-01-01T00:00:00.000Z", root, realRoot: root, dirId: taskId, directoryDevice: String(stat.dev), directoryInode: String(stat.ino),
  } }) };
  const store = new ExperimentalServiceRecoveryStore(profile, authority, () => ["service-a"]);
  const listeners = new Set<() => void>(); let exited = false;
  const owner: CheckpointHostInstance = { sender: {}, hasExited: () => exited, subscribeExit: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const lease = store.acquire(taskId, owner), report = { schemaVersion: 1 as const, taskId, hostEpoch: lease.epoch, status: "closed" as const };
  lease.port(owner.sender, "service-a").write({ schemaVersion: 1, taskId, serviceId: "service-a", state: "stopped", ownerSessionId: null });
  lease.request(owner.sender, { op: "shutdown", epoch: lease.epoch, report });
  const lock = join(profile, "service-execution-recovery", "writer.lock"), exitRequested = vi.fn(), dispose = vi.fn(() => store.dispose());
  const release = new ExperimentalHostRelease({ hosts: [{ taskId, epoch: lease.epoch, host: owner, requestClose: async () => ({ ok: true, report }),
    confirm: (sender, receipt) => lease.confirmShutdown(sender, receipt), requestExit: exitRequested }], seal() {}, verify() {}, dispose, timeoutMs: 1000 });
  try {
    const closing = release.close(); await vi.waitFor(() => expect(exitRequested).toHaveBeenCalledTimes(1), { interval: 1 });
    expect(existsSync(lock)).toBe(true); expect(dispose).not.toHaveBeenCalled(); expect(() => store.dispose()).toThrow("service-recovery-hosts-active");
    expect(() => lease.confirmShutdown(owner.sender, report)).toThrow("service-recovery-lease-stale");
    exited = true; for (const listener of [...listeners]) listener();
    expect(await closing).toEqual({ ok: true, status: "released" }); expect(dispose).toHaveBeenCalledTimes(1); expect(existsSync(lock)).toBe(false);
    expect(() => lease.request(owner.sender, { op: "read", epoch: lease.epoch, serviceId: "service-a" })).toThrow("service-recovery-lease-stale");
  } finally { exited = true; for (const listener of [...listeners]) listener(); store.dispose(); }
});
