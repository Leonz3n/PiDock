import { afterEach, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDefaultTaskRoot } from "./default-root-init.js";
import { createDirectoryLink } from "./directory-link.js";
import { ProjectRegistry } from "./project-registry.js";
import { TaskRootIndex } from "./task-root-index.js";

const homes: string[] = [];
const createdAt = "2026-10-15T00:00:00Z";
const initialTaskId = "task-abcdef12";
const movedMessage = "任务根目录已移走或链接已更改，请检查原位置";

/** A first-run profile: `<home>/PiDockTasks` does not exist yet and `data` is a fresh userData. */
function firstRunProfile() {
  const home = mkdtempSync(join(tmpdir(), "pidock-default-root-"));
  homes.push(home);
  const data = join(home, "data"), defaultRoot = join(home, "PiDockTasks");
  const registry = new ProjectRegistry(data);
  const rootStatus = () => new TaskRootIndex(data, defaultRoot).inventory().roots;
  return { home, data, defaultRoot, registry, rootStatus };
}
function taskRecord(root: string, taskId: string): string {
  const dir = join(root, taskId);
  mkdirSync(dir);
  writeFileSync(join(dir, "task.json"), JSON.stringify({ taskId, name: "First task", dirId: taskId, root, taskDir: dir,
    branch: "task/main", remoteBranch: "main", baseCommit: "abc123", repos: [], createdAt, updatedAt: createdAt }));
  return dir;
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("default task root on a first run", () => {
  it("establishes a never-used default root with the ownership marker the creation flow writes", () => {
    const f = firstRunProfile();
    expect(f.registry.usedTaskRoot(f.defaultRoot)).toBe(false);
    expect(initializeDefaultTaskRoot(f.defaultRoot, () => f.registry.usedTaskRoot(f.defaultRoot)))
      .toEqual({ state: "created", root: f.defaultRoot });
    expect(lstatSync(f.defaultRoot).isDirectory()).toBe(true);
    expect(readFileSync(join(f.defaultRoot, ".pidock-created-root"), "utf8").length).toBeGreaterThan(0);
    expect(f.rootStatus()).toEqual([{ label: "默认任务根", state: "ready" }]);
  });

  it("keeps the named repair state and creates nothing for a default root this profile already used", async () => {
    const f = firstRunProfile();
    mkdirSync(f.defaultRoot);
    taskRecord(f.defaultRoot, initialTaskId);
    const project = await f.registry.create({ name: "Billing", description: "",
      repositories: [{ name: "source", path: join(f.home, "repo") }], directories: [] });
    await f.registry.claim(initialTaskId, project.id, new TaskRootIndex(f.data, f.defaultRoot));
    expect(f.registry.usedTaskRoot(f.defaultRoot)).toBe(true);
    rmSync(f.defaultRoot, { recursive: true, force: true });

    expect(initializeDefaultTaskRoot(f.defaultRoot, () => f.registry.usedTaskRoot(f.defaultRoot)))
      .toEqual({ state: "unavailable", root: f.defaultRoot, reason: "used-before" });
    expect(existsSync(f.defaultRoot)).toBe(false);
    expect(f.rootStatus()).toEqual([{ label: "默认任务根", state: "error", message: movedMessage }]);
  });

  it("leaves an existing directory untouched, marker included, whoever created it", () => {
    const f = firstRunProfile();
    mkdirSync(f.defaultRoot);
    writeFileSync(join(f.defaultRoot, "keep.txt"), "keep\n");
    expect(initializeDefaultTaskRoot(f.defaultRoot, () => false)).toEqual({ state: "existing", root: f.defaultRoot });
    expect(readFileSync(join(f.defaultRoot, "keep.txt"), "utf8")).toBe("keep\n");
    expect(existsSync(join(f.defaultRoot, ".pidock-created-root"))).toBe(false);
    expect(f.rootStatus()).toEqual([{ label: "默认任务根", state: "ready" }]);
  });

  it("refuses a path that is not a directory and never writes through a link", () => {
    const f = firstRunProfile();
    writeFileSync(f.defaultRoot, "not a directory");
    expect(initializeDefaultTaskRoot(f.defaultRoot, () => false))
      .toEqual({ state: "unavailable", root: f.defaultRoot, reason: "path-not-directory" });
    expect(readFileSync(f.defaultRoot, "utf8")).toBe("not a directory");

    const target = join(f.home, "target");
    mkdirSync(target); writeFileSync(join(target, "keep.txt"), "keep\n");
    const linked = join(f.home, "linked-root");
    createDirectoryLink(target, linked);
    expect(initializeDefaultTaskRoot(linked, () => false))
      .toEqual({ state: "unavailable", root: linked, reason: "path-not-directory" });
    expect(existsSync(join(target, ".pidock-created-root"))).toBe(false);
    expect(new TaskRootIndex(f.data, linked).inventory().roots)
      .toEqual([{ label: "默认任务根", state: "error", message: movedMessage }]);
  });

  it("refuses when the persisted history is unreadable and when the directory cannot be created", () => {
    const f = firstRunProfile();
    expect(initializeDefaultTaskRoot(f.defaultRoot, () => { throw new Error("project registry missing; backup requires explicit recovery"); }))
      .toEqual({ state: "unavailable", root: f.defaultRoot, reason: "history-unreadable" });
    expect(existsSync(f.defaultRoot)).toBe(false);

    const unreachable = join(f.home, "absent", "PiDockTasks");
    expect(initializeDefaultTaskRoot(unreachable, () => false))
      .toEqual({ state: "unavailable", root: unreachable, reason: "create-failed" });
    expect(existsSync(unreachable)).toBe(false);
  });
});
