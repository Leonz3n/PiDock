import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskRootIndex, taskRootIndexPath } from "./task-root-index.js";

const dirs: string[] = [];
function setup() {
  const home = mkdtempSync(join(tmpdir(), "pidock-root-index-"));
  dirs.push(home);
  const defaultRoot = join(home, "default");
  const override = join(home, "override");
  mkdirSync(defaultRoot);
  mkdirSync(override);
  const userData = join(home, "userData");
  return { home, defaultRoot, override, userData, index: new TaskRootIndex(userData, defaultRoot) };
}
function task(root: string, id = "task-abcdef12", taskId = id, createdAt = "2026-09-22T10:00:00Z") {
  const dir = join(root, id);
  mkdirSync(dir);
  writeFileSync(join(dir, "task.json"), JSON.stringify({ taskId, name: "Real", dirId: id, root, taskDir: dir,
    branch: "task/main", remoteBranch: "main", baseCommit: "abc123", repos: [], createdAt, updatedAt: createdAt }));
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("main-owned override task root index", () => {
  it("registers only successfully persisted override identities, reopens and idempotently retries", async () => {
    const { defaultRoot, override, userData, index } = setup();
    const original = task(defaultRoot, "task-00000001");
    const extra = task(override);
    expect(index.inventory().tasks.map((row) => row.taskId)).toEqual(["task-00000001"]);
    await index.register(extra);
    await index.register(extra);
    await index.register(original);
    const reopened = new TaskRootIndex(userData, defaultRoot);
    expect(reopened.inventory().tasks.map((row) => row.taskId)).toEqual(["task-00000001", "task-abcdef12"]);
    expect(reopened.resolve("task-abcdef12")).toBe(extra);
    expect(JSON.parse(readFileSync(taskRootIndexPath(userData), "utf8")).roots[0].tasks).toHaveLength(1);
    expect(JSON.parse(readFileSync(`${taskRootIndexPath(userData)}.bak`, "utf8")).roots[0].tasks).toHaveLength(1);
  });

  it("recovers only the selected legacy root and rejects duplicate/imported identity conflicts", async () => {
    const { defaultRoot, override, home, index } = setup();
    task(override);
    const unknown = join(home, "unknown");
    mkdirSync(unknown);
    task(unknown, "task-00000003");
    expect(index.inventory().tasks).toHaveLength(0);
    expect(await index.importRoot(override)).toBe(1);
    expect(index.inventory().tasks).toHaveLength(1);
    expect(index.resolve("task-00000003")).toBeNull();
    expect(await index.importRoot(override)).toBe(1);
    task(defaultRoot, "task-00000004", "task-00000003");
    await expect(index.importRoot(unknown)).rejects.toThrow(/conflicts/);
    await expect(index.importRoot(defaultRoot)).rejects.toThrow(/default/);
  });

  it("isolates missing, corrupt and retargeted override roots without inventing default-root tasks", async () => {
    const { defaultRoot, override, home, index } = setup();
    task(defaultRoot, "task-00000001");
    const target = task(override);
    await index.register(target);
    rmSync(override, { recursive: true });
    expect(index.inventory().tasks.map((row) => row.taskId)).toEqual(["task-00000001"]);
    expect(index.inventory().roots[1]).toMatchObject({ state: "error" });
    expect(index.resolve("task-abcdef12")).toBeNull();
    const replacement = join(home, "replacement");
    mkdirSync(replacement);
    task(replacement);
    symlinkSync(replacement, override);
    expect(index.inventory().roots[1]).toMatchObject({ state: "error" });
    rmSync(override);
    mkdirSync(override);
    task(override, "task-abcdef12", "other-identity");
    expect(index.inventory().roots[1]).toMatchObject({ state: "error" });
  });

  it("rejects changed disk record, linked task and ID conflict across existing roots", async () => {
    const { defaultRoot, override, home, index } = setup();
    const dir = task(override);
    await index.register(dir);
    task(defaultRoot, "task-00000002", "task-abcdef12");
    expect(index.inventory().tasks).toEqual([]);
    expect(index.inventory().roots.slice(0, 2).every((root) => root.state === "error")).toBe(true);
    rmSync(join(defaultRoot, "task-00000002"), { recursive: true });
    writeFileSync(join(dir, "task.json"), "{broken");
    expect(index.inventory().roots[1]?.state).toBe("error");
    rmSync(dir, { recursive: true });
    const other = join(home, "outside");
    mkdirSync(other);
    task(other);
    symlinkSync(join(other, "task-abcdef12"), dir);
    expect(index.inventory().roots[1]?.state).toBe("error");
  });

  it("keeps an unaffected registered root visible when another root fails", async () => {
    const { home, defaultRoot, override, index } = setup();
    task(defaultRoot, "task-00000001");
    task(override);
    await index.importRoot(override);
    const second = join(home, "second");
    mkdirSync(second);
    task(second, "task-00000002");
    await index.importRoot(second);
    rmSync(override, { recursive: true });
    expect(index.inventory().tasks.map((row) => row.taskId)).toEqual(["task-00000001", "task-00000002"]);
    expect(index.inventory().roots.map((root) => root.state)).toEqual(["ready", "error", "ready"]);
    expect(index.resolve("task-00000002")).toBe(join(second, "task-00000002"));
    expect(index.resolve("task-abcdef12")).toBeNull();
  });

  it("serializes concurrent registrations and rejects changed identity on retry", async () => {
    const { override, index } = setup();
    const first = task(override, "task-00000001");
    const second = task(override, "task-00000002");
    await Promise.all([index.register(first), index.register(second)]);
    expect(index.inventory().tasks).toHaveLength(2);
    await index.register(first);
    writeFileSync(join(first, "task.json"), JSON.stringify({ taskId: "task-00000001", name: "Moved", dirId: "task-00000001", root: override,
      taskDir: first, branch: "task/main", remoteBranch: "main", baseCommit: "abc123", repos: [], createdAt: "changed", updatedAt: "changed" }));
    await expect(index.register(first)).rejects.toThrow(/conflict/);
    expect(index.inventory().roots[1]?.state).toBe("error");
  });

  it("rejects a linked index file instead of following it or recreating an empty index", async () => {
    const { home, override, userData, index } = setup();
    const dir = task(override);
    const file = taskRootIndexPath(userData);
    mkdirSync(userData);
    const outside = join(home, "outside.json");
    writeFileSync(outside, JSON.stringify({ version: 1, roots: [] }));
    symlinkSync(outside, file);
    expect(index.inventory().roots.at(-1)?.label).toBe("覆盖根索引");
    await expect(index.register(dir)).rejects.toThrow(/index file/);
    expect(readFileSync(outside, "utf8")).toContain("roots");
  });

  it("fails closed when primary is removed, corrupt, versioned wrong or interrupted after first backup", async () => {
    const { override, userData, index } = setup();
    const dir = task(override);
    await index.register(dir);
    const file = taskRootIndexPath(userData);
    rmSync(file);
    expect(index.inventory().roots.at(-1)?.label).toBe("覆盖根索引");
    await expect(index.register(dir)).rejects.toThrow(/backup requires explicit recovery/);
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, "{broken");
    expect(index.inventory().roots.at(-1)?.state).toBe("error");
    await expect(index.importRoot(override)).rejects.toThrow();
    writeFileSync(file, JSON.stringify({ version: 2, roots: [] }));
    expect(index.inventory().roots.at(-1)?.state).toBe("error");
    rmSync(file);
    const fresh = setup();
    const next = task(fresh.override);
    await expect(new TaskRootIndex(fresh.userData, fresh.defaultRoot, { afterBackup: () => { throw new Error("interrupted"); } }).register(next)).rejects.toThrow("interrupted");
    expect(existsSync(`${taskRootIndexPath(fresh.userData)}.bak`)).toBe(true);
    await expect(fresh.index.register(next)).rejects.toThrow(/backup requires explicit recovery/);
    const before = setup();
    const earlier = task(before.override);
    await expect(new TaskRootIndex(before.userData, before.defaultRoot, { beforeCommit: () => { throw new Error("disk full"); } }).register(earlier)).rejects.toThrow("disk full");
    expect(before.index.inventory().roots).toEqual([{ label: "默认任务根", state: "ready" }]);
  });
});
