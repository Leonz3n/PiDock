import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SdkTurnTransport } from "./sdk-turn-transport.js";
import type { SdkTurnKernelPort } from "./sdk-kernel-router.js";

/**
 * [#117 第 3 项 / 业主定 A] 退出时先中止 Agent，再停服务与终端子进程。
 * `abortAll` is the Agent half of that order; the Host half (children after the
 * abort, SDK last) is asserted in `service-execution-wiring.test.ts` with a real
 * child process.
 */
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pidock-turn-abort-")); homes.push(home);
  const taskDir = join(home, "task-a"); mkdirSync(taskDir);
  const cancelled = new Set<string>();
  const cancel = vi.fn(async (sessionId: string) => { cancelled.add(sessionId); });
  const prompt = vi.fn<SdkTurnKernelPort["prompt"]>(async (sessionId) => {
    // The turn only settles once the abort reaches the kernel.
    while (!cancelled.has(sessionId)) await new Promise((resolve) => setTimeout(resolve, 1));
    return { state: "cancelled", text: "", events: [] };
  });
  const kernel: SdkTurnKernelPort = {
    open: async () => ({ sdkId: "fixture", file: "fixture.jsonl", tools: [] }),
    prompt,
    cancel,
    dispose: async () => {},
    projection: () => { throw new Error("unused"); },
  };
  return { cancel, prompt, transport: new SdkTurnTransport("task-a", taskDir, kernel) };
}

it("aborts the running turn before it returns, and reports the turn it stopped", async () => {
  const f = fixture();
  const started = await f.transport.start("main", "request-a", "hello", () => {});
  const aborted = await f.transport.abortAll();
  expect(f.cancel).toHaveBeenCalledTimes(1);
  expect(f.cancel).toHaveBeenCalledWith("main");
  expect(aborted).toEqual([started.turnId]);
  // The abort left a terminal record, not a turn the Host still has to wait for.
  expect(f.transport.status("main", "request-a")).toMatchObject({ state: "cancelled" });
  await expect(f.transport.waitForTerminal()).resolves.toBeUndefined();
});

it("is a no-op without a running turn, and never calls the kernel", async () => {
  const f = fixture();
  await expect(f.transport.abortAll()).resolves.toEqual([]);
  expect(f.cancel).not.toHaveBeenCalled();
});

it("still settles and reports the turn when the kernel's own cancel refuses", async () => {
  const f = fixture();
  let release!: () => void;
  const settled = new Promise<void>((resolve) => { release = resolve; });
  f.prompt.mockImplementation(async () => { await settled; return { state: "failed", text: "", events: [] }; });
  const started = await f.transport.start("main", "request-a", "hello", () => {});
  f.cancel.mockImplementation(async () => { throw new Error("sdk-cancel-refused"); });
  const aborting = f.transport.abortAll();
  release();
  // A refused cancel is not reported as a stopped turn: the run's own terminal
  // record is what the caller gets, and only a really dead run settles here.
  expect(await aborting).toEqual([started.turnId]);
  expect(f.transport.status("main", "request-a")).toMatchObject({ state: "failed" });
});
