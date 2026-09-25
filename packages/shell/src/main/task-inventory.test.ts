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

  it("rejects symlinked folders and root rather than scanning outside the configured root", () => {
    const dir = root();
    const outside = root();
    task(join(outside, "task-abcdef12"));
    symlinkSync(join(outside, "task-abcdef12"), join(dir, "task-abcdef12"));
    expect(() => listPersistedTasks(dir)).toThrow();
    const linkedRoot = join(root(), "link");
    symlinkSync(outside, linkedRoot);
    expect(() => listPersistedTasks(linkedRoot)).toThrow();
  });
});
