import { describe, expect, it, vi } from "vitest";
import { shellBridge, shellTaskOp } from "../data/shellBridge";

describe("shell bridge boundary", () => {
  it("returns null outside the shell and rejects task ops explicitly", async () => {
    vi.stubGlobal("window", {});
    expect(shellBridge()).toBeNull();
    await expect(shellTaskOp("task-a", "task/cancel")).rejects.toThrow("不在桌面壳内");
    vi.unstubAllGlobals();
  });

  it("routes a task op through window.pidock without Node access", async () => {
    const taskOp = vi.fn(async () => ({ ok: true, payload: { op: "task/cancel" } }));
    vi.stubGlobal("window", { pidock: { taskOp } });
    // The renderer page must not see Node/Electron globals even when bridged.
    expect(typeof (globalThis as Record<string, unknown>)["require"]).toBe("undefined");
    const result = await shellTaskOp("task-a", "task/cancel", {});
    expect(taskOp).toHaveBeenCalledWith("task-a", "task/cancel", {});
    expect(result).toEqual({ ok: true, payload: { op: "task/cancel" } });
    vi.unstubAllGlobals();
  });
});
