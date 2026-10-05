import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { shutdownDeadline } from "./shutdown-deadline.js";
import { SdkTurnTransport } from "./sdk-turn-transport.js";
import type { SdkTurnKernelPort } from "./sdk-kernel-router.js";

const homes: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pidock-turn-seal-")); homes.push(home); const taskDir = join(home, "task-a"); mkdirSync(taskDir);
  const open = vi.fn(async () => ({ sdkId: "fixture", file: "fixture.jsonl", tools: [] as string[] }));
  const prompt = vi.fn<SdkTurnKernelPort["prompt"]>(async () => ({ state: "done", text: "fixture", events: [] }));
  const kernel: SdkTurnKernelPort = { open, prompt, cancel: async () => {}, dispose: async () => {}, projection: () => { throw Error("unused"); } };
  const transport = new SdkTurnTransport("task-a", taskDir, kernel);
  return { taskDir, kernel, open, prompt, transport };
}
it("seals pending open before journal acceptance and waits for its refusal", async () => {
  const f = fixture(), opened = deferred<Awaited<ReturnType<SdkTurnKernelPort["open"]>>>(); f.open.mockImplementation(() => opened.promise);
  const starting = f.transport.start("main", "request-a", "hello", () => {}), refusal = expect(starting).rejects.toThrow("sdk-host-closing");
  f.transport.seal(); let settled = false; const closing = f.transport.waitForTerminal().then(() => { settled = true; });
  await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false);
  opened.resolve({ sdkId: "fixture", file: "fixture.jsonl", tools: [] }); await refusal; await closing;
  expect(f.prompt).not.toHaveBeenCalled(); expect(existsSync(join(f.taskDir, ".pidock-sdk-turns", "main", "request-a.json"))).toBe(false);
});
it("refuses accepted journal uncertainty during shutdown, even after the fsync adapter recovers", async () => {
  const f = fixture(); let fail = true;
  const transport = new SdkTurnTransport("task-a", f.taskDir, f.kernel, () => { if (fail) throw Error("synthetic-fsync-failure"); });
  await expect(transport.start("main", "request-a", "hello", () => {})).rejects.toThrow("sdk-journal-sync-failed");
  expect(transport.status("main", "request-a")).toMatchObject({ state: "interrupted", needsResync: true });
  fail = false; await expect(transport.waitForTerminal()).rejects.toThrow("sdk-turn-journal-uncommitted");
  await expect(transport.start("main", "request-b", "again", () => {})).rejects.toThrow("sdk-turn-journal-uncommitted");
  expect(f.prompt).not.toHaveBeenCalled();
});
it("tracks synchronous prompt failure as a terminal run rather than retaining a phantom active turn", async () => {
  const f = fixture(); f.prompt.mockImplementation(() => { throw Error("synthetic-prompt-failure"); });
  await f.transport.start("main", "request-a", "hello", () => {});
  await expect(f.transport.waitForTerminal()).resolves.toBeUndefined();
  expect(f.transport.status("main", "request-a")).toMatchObject({ state: "failed", error: "synthetic-prompt-failure" });
});
it("refuses all new and idempotent starts after seal while keeping terminal status readable", async () => {
  const f = fixture(); await f.transport.start("main", "request-a", "hello", () => {}); await f.transport.waitForTerminal();
  f.transport.seal(); f.transport.seal();
  for (const requestId of ["request-a", "request-b"]) await expect(f.transport.start("main", requestId, "hello", () => {})).rejects.toThrow("sdk-host-closing");
  expect(f.transport.status("main", "request-a")).toMatchObject({ state: "done" }); expect(f.prompt).toHaveBeenCalledTimes(1);
});
it("waits for the accepted active turn's terminal record after sealing", async () => {
  const f = fixture(), result = deferred<Awaited<ReturnType<SdkTurnKernelPort["prompt"]>>>(); f.prompt.mockImplementation(() => result.promise);
  await f.transport.start("main", "request-a", "hello", () => {}); f.transport.seal();
  let settled = false; const closing = f.transport.waitForTerminal().then(() => { settled = true; }); await Promise.resolve(); await Promise.resolve();
  expect(settled).toBe(false); result.resolve({ state: "cancelled", text: "", events: [] }); await closing;
  expect(f.transport.status("main", "request-a")).toMatchObject({ state: "cancelled" });
});
it("does not publish a late open after a bounded close wait has failed", async () => {
  vi.useFakeTimers(); const f = fixture(), opened = deferred<Awaited<ReturnType<SdkTurnKernelPort["open"]>>>(); f.open.mockImplementation(() => opened.promise);
  const starting = f.transport.start("main", "request-a", "hello", () => {}), refused = expect(starting).rejects.toThrow("sdk-host-closing"); f.transport.seal();
  const closing = shutdownDeadline(f.transport.waitForTerminal(), 20, "sdk-turns-shutdown-unconfirmed"), failure = expect(closing).rejects.toThrow("sdk-turns-shutdown-unconfirmed");
  await vi.advanceTimersByTimeAsync(30); await failure; opened.resolve({ sdkId: "fixture", file: "fixture.jsonl", tools: [] }); await refused;
  expect(f.prompt).not.toHaveBeenCalled(); expect(f.transport.status("main", "request-a")).toBeNull();
});
