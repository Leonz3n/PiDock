import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SCHEDULE_TICK_MS, ScheduleDriver } from "./schedule-driver.js";

describe("[PiDock 18] schedule driver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("evaluates every running Host exactly once per tick and never for a task without one", async () => {
    const calls: string[] = [];
    const driver = new ScheduleDriver({
      hostTaskIds: () => ["task-b", "task-a"],
      evaluate: async (taskId) => {
        calls.push(taskId);
      },
    });
    expect(await driver.tick()).toEqual({ evaluated: ["task-b", "task-a"], skipped: [], failures: [] });
    expect(calls).toEqual(["task-b", "task-a"]);
    // No Host, no fork: an empty registry ticks into nothing.
    const empty = new ScheduleDriver({ hostTaskIds: () => [], evaluate: async () => undefined });
    expect(await empty.tick()).toEqual({ evaluated: [], skipped: [], failures: [] });
  });

  it("keeps going when one task's Host fails and reports it", async () => {
    const failures: string[] = [];
    const driver = new ScheduleDriver({
      hostTaskIds: () => ["task-a", "task-b"],
      evaluate: async (taskId) => {
        if (taskId === "task-a") throw new Error("unknown task: task-a");
        return undefined;
      },
      onError: (_error, taskId) => failures.push(taskId),
    });
    const result = await driver.tick();
    expect(result.evaluated).toEqual(["task-b"]);
    expect(result.failures).toEqual([{ taskId: "task-a", error: "unknown task: task-a" }]);
    expect(failures).toEqual(["task-a"]);
  });

  it("never overlaps its own ticks: a slow evaluation makes the next tick a no-op", async () => {
    let release: (() => void) | null = null;
    const calls: string[] = [];
    const driver = new ScheduleDriver({
      hostTaskIds: () => ["task-a"],
      evaluate: () =>
        new Promise<void>((resolve) => {
          calls.push("start");
          release = () => resolve();
        }),
    });
    const first = driver.tick();
    const second = await driver.tick();
    expect(second).toEqual({ evaluated: [], skipped: ["task-a"], failures: [] });
    release?.();
    await first;
    expect(calls).toEqual(["start"]);
  });

  it("runs on its own interval once started and releases it on stop", async () => {
    const calls: string[] = [];
    const driver = new ScheduleDriver(
      {
        hostTaskIds: () => ["task-a"],
        evaluate: async () => {
          calls.push("tick");
        },
      },
      { intervalMs: 1_000 },
    );
    expect(driver.running).toBe(false);
    driver.start();
    driver.start();
    expect(driver.running).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual(["tick"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toEqual(["tick", "tick", "tick"]);
    driver.stop();
    expect(driver.running).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(3);
    expect(DEFAULT_SCHEDULE_TICK_MS).toBe(30_000);
    expect(() => new ScheduleDriver({ hostTaskIds: () => [], evaluate: async () => undefined }, { intervalMs: 0 })).toThrow(
      "invalid-payload",
    );
  });
});
