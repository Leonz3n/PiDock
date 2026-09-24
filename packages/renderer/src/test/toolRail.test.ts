import { describe, expect, it } from "vitest";
import { nextActivePanel, resolveActivePanel } from "../data/toolRail";

/**
 * [UI 对齐 04] (#28) rail bookkeeping. The strip keeps the open order, so the
 * active tab after a close is the still-open current tab or the most recently
 * opened survivor — never a tab that is not in the strip.
 */
describe("tool rail active tab", () => {
  it("keeps the open order and hands the active tab to the last survivor", () => {
    // `panels` is the strip *after* the closed tab was removed.
    expect(nextActivePanel(["logs"], "files", "files")).toBe("logs");
    expect(nextActivePanel(["files"], "logs", "logs")).toBe("files");
    // Closing a tab the user is not looking at must not move the selection.
    expect(nextActivePanel(["logs", "runtime"], "files", "logs")).toBe("logs");
    // The last tab closes: nothing is left to activate.
    expect(nextActivePanel([], "files", "files")).toBeUndefined();
    // A stale "current" that is no longer open cannot win.
    expect(nextActivePanel(["logs"], "files", "runtime")).toBe("logs");
  });

  it("falls back to the last opened tab when the stored tab is not open", () => {
    expect(resolveActivePanel([], "files")).toBeUndefined();
    expect(resolveActivePanel(["files", "logs"], "files")).toBe("files");
    expect(resolveActivePanel(["files", "logs"], undefined)).toBe("logs");
    expect(resolveActivePanel(["files", "logs"], "runtime")).toBe("logs");
  });
});
