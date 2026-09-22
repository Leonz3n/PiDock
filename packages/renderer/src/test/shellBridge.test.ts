import { describe, expect, it, vi } from "vitest";
import { provisionTaskThroughShell, shellBridge, shellTaskOp } from "../data/shellBridge";

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

  it("keeps malformed bridge results and rejected invokes as {ok:false} envelopes", async () => {
    const malformed = vi.fn(async () => null);
    vi.stubGlobal("window", { pidock: { taskOp: malformed } });
    const guarded = await shellTaskOp("task-a", "task/cancel", {});
    expect(guarded.ok).toBe(false);
    vi.unstubAllGlobals();

    const rejecting = vi.fn(async () => {
      throw new Error("invoke failed");
    });
    vi.stubGlobal("window", { pidock: { taskOp: rejecting } });
    const provisioned = await provisionTaskThroughShell({
      taskId: "task-a",
      name: "表单任务",
      dirId: "task-a1f92c3d",
      remoteBranch: "origin/main",
      fetchedCommit: "9acb5b6",
    });
    expect(provisioned.ok).toBe(false);
    expect(provisioned.error).toContain("invoke failed");
    expect(rejecting).toHaveBeenCalledWith(
      "task-a",
      "task/provision",
      expect.objectContaining({ name: "表单任务", dirId: "task-a1f92c3d" }),
    );
    vi.unstubAllGlobals();
  });
});

describe("#6 append + probe bridge (S3)", () => {
  it("forwards appendRepos and probeLink payloads without Node access", async () => {
    const { appendReposThroughShell, probeLinkThroughShell } = await import("../data/shellBridge");
    const taskOp = vi.fn(async () => ({ ok: true, payload: {} }));
    vi.stubGlobal("window", { pidock: { taskOp } });
    try {
      const appended = await appendReposThroughShell({
        taskId: "task-abcdef12",
        repoSelections: [
          { repoDir: "shipment", remote: "origin", remoteBranch: "main", mainCheckoutDir: "/src/shipment" },
        ],
        fetchedCommits: { shipment: "c0ffee1234" },
        takenPaths: [],
        branchesInUse: [],
      });
      expect(appended.ok).toBe(true);
      expect(taskOp).toHaveBeenCalledWith(
        "task-abcdef12",
        "task/appendRepos",
        expect.objectContaining({ fetchedCommits: { shipment: "c0ffee1234" } }),
      );
      const probed = await probeLinkThroughShell({ taskId: "task-abcdef12", sourcePath: "/data/notes" });
      expect(probed.ok).toBe(true);
      expect(taskOp).toHaveBeenCalledWith("task-abcdef12", "task/probeLink", { sourcePath: "/data/notes" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
