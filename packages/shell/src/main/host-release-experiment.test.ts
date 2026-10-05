import { afterEach, expect, it, vi } from "vitest";
import { ExperimentalHostRelease } from "./host-release-experiment.js";
import type { CheckpointHostInstance } from "./service-recovery-store-experiment.js";

afterEach(() => vi.useRealTimers());
const epoch = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function host(taskId: string, events: string[]) {
  let exited = false;
  const listeners = new Set<() => void>();
  const owner: CheckpointHostInstance = { sender: {}, hasExited: () => exited,
    subscribeExit: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const report = { schemaVersion: 1 as const, taskId, hostEpoch: epoch, status: "closed" as const };
  const requestClose = vi.fn(async (): Promise<unknown> => { events.push(`${taskId}:close`); return { ok: true, report }; });
  const confirm = vi.fn(() => { events.push(`${taskId}:confirm`); });
  const requestExit = vi.fn(() => { events.push(`${taskId}:release`); });
  return { entry: { taskId, epoch, host: owner, requestClose, confirm, requestExit }, report,
    exit: () => { exited = true; for (const listener of [...listeners]) listener(); }, notify: () => { for (const listener of [...listeners]) listener(); }, listeners: () => listeners.size };
}
function fixture(count = 1) {
  const events: string[] = [], hosts = Array.from({ length: count }, (_, i) => host(`task-${i}`, events));
  const seal = vi.fn(() => { events.push("seal"); }), verify = vi.fn(() => {}), dispose = vi.fn(() => { events.push("dispose"); });
  const release = new ExperimentalHostRelease({ hosts: hosts.map((h) => h.entry), seal, verify, dispose, timeoutMs: 1000 });
  return { events, hosts, seal, verify, dispose, release };
}
it("seals synchronously, confirms every Host before release, and waits for actual native exits", async () => {
  const f = fixture(2), closing = f.release.close(); expect(f.release.close()).toBe(closing); expect(f.seal).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(f.hosts[1]!.entry.requestExit).toHaveBeenCalledTimes(1), { interval: 1 });
  expect(f.events.slice(0, 7)).toEqual(["seal", "task-0:close", "task-1:close", "task-0:confirm", "task-1:confirm", "task-0:release", "task-1:release"]);
  expect(f.dispose).not.toHaveBeenCalled(); f.hosts[0]!.exit(); await Promise.resolve(); expect(f.dispose).not.toHaveBeenCalled();
  f.hosts[1]!.exit(); expect(await closing).toEqual({ ok: true, status: "released" }); expect(f.dispose).toHaveBeenCalledTimes(1);
  expect(f.hosts.every((h) => h.listeners() === 0)).toBe(true);
});
it("retains every Host when one close receipt is unknown, despite draining its siblings", async () => {
  const f = fixture(2); f.hosts[0]!.entry.requestClose.mockResolvedValue({ ok: false, error: "synthetic-private" });
  expect(await f.release.close()).toEqual({ ok: false, error: "host-release-unconfirmed" });
  expect(f.hosts[1]!.entry.requestClose).toHaveBeenCalledTimes(1);
  expect(f.hosts.every((h) => h.entry.requestExit.mock.calls.length === 0)).toBe(true); expect(f.dispose).not.toHaveBeenCalled();
});
it.each([null, { ok: true }, { ok: true, report: { schemaVersion: 1, taskId: "foreign", hostEpoch: epoch, status: "closed" } }, { ok: true, report: { schemaVersion: 1, taskId: "task-0", hostEpoch: "old", status: "closed" } }])("rejects missing or foreign shutdown receipt %j", async (value) => {
  const f = fixture(); f.hosts[0]!.entry.requestClose.mockResolvedValue(value);
  expect((await f.release.close()).ok).toBe(false); expect(f.hosts[0]!.entry.confirm).not.toHaveBeenCalled(); expect(f.dispose).not.toHaveBeenCalled();
});
it("rejects extra completion fields rather than forwarding arbitrary Host data", async () => {
  const f = fixture(); f.hosts[0]!.entry.requestClose.mockResolvedValue({ ok: true, report: f.hosts[0]!.report, pid: 123 });
  expect((await f.release.close()).ok).toBe(false); expect(f.hosts[0]!.entry.requestExit).not.toHaveBeenCalled();
});
it("does not treat publication alone as confirmation or release authority", async () => {
  const f = fixture(); f.hosts[0]!.entry.confirm.mockImplementation(() => { throw Error("report-not-acknowledged"); });
  expect((await f.release.close()).ok).toBe(false); expect(f.hosts[0]!.entry.requestExit).not.toHaveBeenCalled(); expect(f.dispose).not.toHaveBeenCalled();
});
it("refuses native death before post-ack confirmation, without adopting a closed report", async () => {
  const f = fixture(), result = deferred<unknown>(); f.hosts[0]!.entry.requestClose.mockImplementation(() => result.promise);
  const closing = f.release.close(); f.hosts[0]!.exit(); result.resolve({ ok: true, report: f.hosts[0]!.report });
  expect((await closing).ok).toBe(false); expect(f.hosts[0]!.entry.confirm).not.toHaveBeenCalled(); expect(f.dispose).not.toHaveBeenCalled();
});
it("refuses an exit notification not backed by the actual Host exit observation", async () => {
  const f = fixture(); f.hosts[0]!.entry.requestExit.mockImplementation(() => { f.hosts[0]!.notify(); });
  expect((await f.release.close()).ok).toBe(false); expect(f.dispose).not.toHaveBeenCalled();
});
it("caches close timeouts and never releases on late completion", async () => {
  vi.useFakeTimers(); const f = fixture(), result = deferred<unknown>(); f.hosts[0]!.entry.requestClose.mockImplementation(() => result.promise);
  const closing = f.release.close(); await vi.advanceTimersByTimeAsync(1100); expect((await closing).ok).toBe(false);
  result.resolve({ ok: true, report: f.hosts[0]!.report }); await Promise.resolve();
  expect(f.release.close()).toBe(closing); expect(f.hosts[0]!.entry.confirm).not.toHaveBeenCalled(); expect(f.dispose).not.toHaveBeenCalled();
});
it("caches missing native-exit failure; later exit does not authorize writer disposal", async () => {
  vi.useFakeTimers(); const f = fixture(), closing = f.release.close(); await vi.advanceTimersByTimeAsync(1100);
  expect((await closing).ok).toBe(false); expect(f.hosts[0]!.entry.requestExit).toHaveBeenCalledTimes(1);
  f.hosts[0]!.exit(); expect(f.release.close()).toBe(closing); expect(f.dispose).not.toHaveBeenCalled(); expect(f.hosts[0]!.listeners()).toBe(0);
});
it("bounds all close receipts with one shared budget and ignores late sibling success", async () => {
  vi.useFakeTimers(); const f = fixture(3), pending = f.hosts.map(() => deferred<unknown>());
  for (const [i, h] of f.hosts.entries()) h.entry.requestClose.mockImplementation(() => pending[i]!.promise);
  const closing = f.release.close(); await vi.advanceTimersByTimeAsync(1100);
  let settled = false; void closing.then(() => { settled = true; }); await Promise.resolve();
  expect(settled).toBe(true); expect((await closing).ok).toBe(false);
  for (const [i, h] of f.hosts.entries()) {
    expect(h.entry.requestClose).toHaveBeenCalledTimes(1); pending[i]!.resolve({ ok: true, report: h.report });
  }
  await Promise.resolve(); await Promise.resolve();
  expect(f.hosts.every((h) => h.entry.confirm.mock.calls.length === 0 && h.entry.requestExit.mock.calls.length === 0)).toBe(true);
  expect(f.dispose).not.toHaveBeenCalled();
});
it("rechecks inventory after confirmation and before metadata disposal", async () => {
  for (const phase of ["confirmed", "exited"] as const) {
    const f = fixture(); f.verify.mockImplementation(() => {
      if (phase === "confirmed" ? f.hosts[0]!.entry.confirm.mock.calls.length > 0 : f.events.includes("native-exit")) throw Error("inventory-changed");
    });
    if (phase === "exited") f.hosts[0]!.entry.requestExit.mockImplementation(() => { f.events.push("native-exit"); f.hosts[0]!.exit(); });
    expect((await f.release.close()).ok).toBe(false); expect(f.dispose).not.toHaveBeenCalled();
  }
});
it("retains writer authority after a partial multi-Host exit request failure", async () => {
  const f = fixture(2); f.hosts[0]!.entry.requestExit.mockImplementation(() => { f.hosts[0]!.exit(); });
  f.hosts[1]!.entry.requestExit.mockImplementation(() => { throw Error("send-failed"); });
  const closing = f.release.close(); expect((await closing).ok).toBe(false);
  expect(f.hosts[0]!.entry.requestExit).toHaveBeenCalledTimes(1); expect(f.hosts[1]!.entry.requestExit).toHaveBeenCalledTimes(1);
  expect(f.dispose).not.toHaveBeenCalled(); f.hosts[1]!.exit(); expect(f.release.close()).toBe(closing); expect(f.dispose).not.toHaveBeenCalled();
});
it("rejects duplicate task/sender scopes and invalid deadlines", () => {
  const events: string[] = [], first = host("task-a", events), second = host("task-b", events);
  const dependencies = { hosts: [first.entry, second.entry], seal() {}, verify() {}, dispose() {} };
  expect(() => new ExperimentalHostRelease({ ...dependencies, timeoutMs: 0 })).toThrow("invalid-host-release-scope");
  expect(() => new ExperimentalHostRelease({ ...dependencies, hosts: [] })).toThrow("invalid-host-release-scope");
  expect(() => new ExperimentalHostRelease({ ...dependencies, hosts: [first.entry, { ...second.entry, taskId: "task-a" }] })).toThrow("invalid-host-release-scope");
  expect(() => new ExperimentalHostRelease({ ...dependencies, hosts: [first.entry, { ...second.entry, host: first.entry.host }] })).toThrow("invalid-host-release-scope");
});
it("handles seal, release-send and metadata-disposal failures without retry or private errors", async () => {
  for (const phase of ["seal", "exit", "dispose"] as const) {
    const f = fixture(), fail = () => { throw Error("synthetic-private-error"); };
    if (phase === "seal") f.seal.mockImplementation(fail);
    else if (phase === "exit") f.hosts[0]!.entry.requestExit.mockImplementation(fail);
    else { f.hosts[0]!.entry.requestExit.mockImplementation(() => { f.hosts[0]!.exit(); }); f.dispose.mockImplementation(fail); }
    const closing = f.release.close(); expect(await closing).toEqual({ ok: false, error: "host-release-unconfirmed" }); expect(f.release.close()).toBe(closing);
  }
});
