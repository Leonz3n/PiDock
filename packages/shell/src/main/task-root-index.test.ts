import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  it("distinguishes a valid empty default root from a missing root and retries after explicit restoration", () => {
    const { home, defaultRoot, userData, index } = setup();
    expect(index.inventory()).toEqual({ tasks: [], roots: [{ label: "默认任务根", state: "ready" }] });
    const dir = task(defaultRoot);
    expect(index.resolve("task-abcdef12")).toBe(dir);
    const moved = join(home, "moved-default");
    renameSync(defaultRoot, moved);
    const unavailable = { tasks: [], roots: [{ label: "默认任务根", state: "error", message: expect.stringContaining("移走") }] };
    expect(index.inventory()).toEqual(unavailable);
    expect(index.resolve("task-abcdef12")).toBeNull();
    expect(new TaskRootIndex(userData, defaultRoot).inventory()).toEqual(unavailable);
    expect(existsSync(defaultRoot)).toBe(false);
    renameSync(moved, defaultRoot);
    expect(index.inventory().roots).toEqual([{ label: "默认任务根", state: "ready" }]);
    expect(index.resolve("task-abcdef12")).toBe(dir);
  });

  it.each(["missing", "file", "empty-link"])("refuses a %s default root on first inventory without creating or routing a task", (kind) => {
    const { home, defaultRoot, index } = setup();
    rmSync(defaultRoot, { recursive: true });
    if (kind === "file") writeFileSync(defaultRoot, "not a directory");
    if (kind === "empty-link") {
      const outside = join(home, "outside-empty");
      mkdirSync(outside);
      symlinkSync(outside, defaultRoot);
    }
    expect(index.inventory()).toEqual({ tasks: [], roots: [{ label: "默认任务根", state: "error", message: expect.stringContaining("移走") }] });
    expect(index.resolve("task-abcdef12")).toBeNull();
    if (kind === "missing") expect(existsSync(defaultRoot)).toBe(false);
  });

  it.each(["missing", "equal-replacement"])("reports %s indexed identities as unavailable, not as unindexed tasks to import", async (kind) => {
    const { override, index } = setup();
    const original = task(override);
    await index.importRoot(override);
    rmSync(original, { recursive: true });
    if (kind === "equal-replacement") task(override, "task-00000002");
    const inventory = index.inventory();
    expect(inventory.roots[1]).toMatchObject({ state: "error" });
    expect(inventory.roots[1]?.message).not.toContain("未登记");
    expect(inventory.tasks).toEqual([]);
    expect(index.resolve("task-abcdef12")).toBeNull();
    expect(index.resolve("task-00000002")).toBeNull();
  });

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
    expect(index.inventory().roots[1]).toMatchObject({ state: "error", message: expect.stringContaining("移走") });
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

  it.each(["corrupt", "missing"])("never routes a default task into a %s override root sharing its ID", async (failure) => {
    const { defaultRoot, override, index } = setup();
    const old = task(override);
    await index.register(old);
    if (failure === "corrupt") writeFileSync(join(old, "task.json"), "{broken");
    else rmSync(override, { recursive: true });
    task(defaultRoot, "task-00000001", "task-abcdef12");
    expect(index.inventory().tasks).toEqual([]);
    expect(index.inventory().roots.slice(0, 2).map((root) => root.state)).toEqual(["error", "error"]);
    expect(index.resolve("task-abcdef12")).toBeNull();
  });

  it("preserves unrelated validated tasks when a failed root retains a colliding ID", async () => {
    const { home, defaultRoot, override, index } = setup();
    const old = task(override);
    await index.register(old);
    const second = join(home, "second");
    mkdirSync(second);
    const valid = task(second, "task-00000002");
    await index.register(valid);
    task(defaultRoot, "task-00000001", "task-abcdef12");
    task(defaultRoot, "task-00000003");
    writeFileSync(join(old, "task.json"), "{broken");
    expect(index.inventory().tasks.map((row) => row.taskId)).toEqual(["task-00000002"]);
    expect(index.resolve("task-00000002")).toBe(valid);
    expect(index.resolve("task-abcdef12")).toBeNull();
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

  it("discloses unindexed legacy tasks in an otherwise registered root until explicit import", async () => {
    const { override, index } = setup();
    task(override);
    await index.importRoot(override);
    task(override, "task-00000002");
    expect(index.inventory().roots[1]).toMatchObject({ state: "error", message: expect.stringContaining("未登记") });
    expect(index.inventory().tasks).toEqual([]);
    await index.importRoot(override);
    expect(index.inventory().tasks).toHaveLength(2);
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
    const { defaultRoot, override, userData, index } = setup();
    const dir = task(override);
    await index.register(dir);
    const file = taskRootIndexPath(userData);
    rmSync(file);
    expect(index.inventory().roots.at(-1)?.label).toBe("覆盖根索引");
    await expect(index.register(dir)).rejects.toThrow(/backup requires explicit recovery/);
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, "{broken");
    task(defaultRoot, "task-00000001");
    expect(index.inventory().tasks).toEqual([]);
    expect(index.resolve("task-00000001")).toBeNull();
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
