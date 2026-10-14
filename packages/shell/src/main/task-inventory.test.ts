import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPersistedTasks } from "./task-inventory.js";

const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "pidock-inventory-"));
  roots.push(value);
  return value;
}

function task(dir: string, overrides: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task.json"), JSON.stringify({
    taskId: "task-abc", name: "Real task", dirId: "task-abcdef12", branch: "task/abc",
    root: join(dir, ".."), taskDir: dir, remoteBranch: "main", baseCommit: "abc123",
    repos: ["repo"], createdAt: "2026-09-22T10:00:00Z", updatedAt: "2026-09-22T10:00:00Z",
    ...overrides,
  }));
}

afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("persisted task inventory", () => {
  it("returns empty for an unprovisioned root", () => {
    const dir = root();
    expect(listPersistedTasks(join(dir, "not-created"))).toEqual([]);
    expect(listPersistedTasks(dir)).toEqual([]);
  });

  it("reads only safe persisted task summaries and returns the same identity after reopen", () => {
    const dir = root();
    task(join(dir, "task-abcdef12"));
    mkdirSync(join(dir, "not-a-task"));
    const rows = listPersistedTasks(dir);
    expect(rows).toEqual([{ taskId: "task-abc", name: "Real task", branch: "task/abc", repoCount: 1, updatedAt: "2026-09-22T10:00:00Z" }]);
    expect(listPersistedTasks(dir)).toEqual(rows);
    expect(JSON.stringify(rows)).not.toContain(dir);
  });

  it("does not falsely discover override-root tasks outside the configured default root", () => {
    const configured = root();
    const override = root();
    task(join(override, "task-abcdef12"), { root: override });
    expect(listPersistedTasks(configured)).toEqual([]);
    expect(listPersistedTasks(override)).toHaveLength(1);
  });

  it("rejects corrupt, mismatched and duplicate records instead of displaying a partial list", () => {
    const dir = root();
    task(join(dir, "task-abcdef12"));
    const second = join(dir, "task-12345678");
    task(second, { taskId: "task-other", taskDir: "/elsewhere" });
    expect(() => listPersistedTasks(dir)).toThrow();
    task(second, { taskId: "task-abc" });
    expect(() => listPersistedTasks(dir)).toThrow();
    writeFileSync(join(second, "task.json"), "{invalid");
    expect(() => listPersistedTasks(dir)).toThrow();
  });

  it("rejects symlinked folders, record files and root rather than scanning outside the configured root", () => {
    const dir = root();
    const outside = root();
    task(join(outside, "task-abcdef12"));
    // win32: a plain directory symlink needs SeCreateSymbolicLinkPrivilege; a junction is the directory link this platform can create without it (#57).
    symlinkSync(join(outside, "task-abcdef12"), join(dir, "task-abcdef12"), process.platform === "win32" ? "junction" : "dir");
    expect(() => listPersistedTasks(dir)).toThrow();
    const recordRoot = root();
    const recordDir = join(recordRoot, "task-abcdef12");
    mkdirSync(recordDir);
    // win32 (#57): a link to a record FILE needs SeCreateSymbolicLinkPrivilege and a junction cannot
    // stand in for a file, so a normal user cannot build this case. NOT actually covered on win32 by
    // a sibling: the junctions above and below reach the root and folder refusals
    // (task-inventory.ts:23/:30), not the invalid-record-file refusal at :39. Unobserved on win32.
    if (process.platform !== "win32") {
      symlinkSync(join(outside, "task-abcdef12", "task.json"), join(recordDir, "task.json"));
      expect(() => listPersistedTasks(recordRoot)).toThrow();
    }
    const linkedRoot = join(root(), "link");
    symlinkSync(outside, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    expect(() => listPersistedTasks(linkedRoot)).toThrow();
  });
});
