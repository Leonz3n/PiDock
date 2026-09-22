import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDiskTaskDirResolver,
  defaultTasksRoot,
  expandTaskRoot,
} from "./task-resolver.js";
import { normalizeTaskPath } from "./task-provision.js";

// Seam: production task-id -> task-dir resolution for the per-task registry
// (P0 follow-up). The resolver stays injected/fakeable; only defaults touch
// the filesystem. Task ids are globally unique: at most one folder wins.

function taskRecord(taskId: string, taskDir: string, extra?: Record<string, unknown>) {
  return {
    taskId,
    name: "发布前检查",
    dirId: "task-abcdef12",
    branch: "task/task-abcdef12",
    root: "/tmp/pidock-root",
    taskDir,
    remoteBranch: "main",
    baseCommit: "a5a4a0d1234",
    repos: [],
    createdAt: "2026-09-22T10:00:00+08:00",
    updatedAt: "2026-09-22T10:00:00+08:00",
    ...extra,
  };
}

function seedRoot(): { root: string; taskDir: string } {
  const root = mkdtempSync(join(tmpdir(), "pidock-resolver-"));
  const taskDir = join(root, "task-abcdef12");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "task.json"), JSON.stringify(taskRecord("task-a", taskDir)), "utf8");
  return { root, taskDir };
}

describe("disk task-id resolver", () => {
  it("resolves a provisioned task folder from its on-disk record", () => {
    const { root, taskDir } = seedRoot();
    expect(createDiskTaskDirResolver(root)("task-a")).toBe(taskDir);
  });

  it("fails closed on unprovisioned ids (null; never a path guess)", () => {
    const { root } = seedRoot();
    expect(createDiskTaskDirResolver(root)("task-ghost")).toBeNull();
    expect(createDiskTaskDirResolver(root)("")).toBeNull();
  });

  it("fails closed on a missing/unreadable tasks root", () => {
    expect(createDiskTaskDirResolver(join(tmpdir(), "pidock-missing-root-xyz"))("task-a")).toBeNull();
  });

  it("ignores corrupt records and records naming another folder", () => {
    const root = mkdtempSync(join(tmpdir(), "pidock-resolver-bad-"));
    const evil = join(root, "task-abcdef12");
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, "task.json"), JSON.stringify(taskRecord("task-a", "/elsewhere/root")), "utf8");
    const bad = join(root, "task-bad00000");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "task.json"), "{not json", "utf8");
    expect(createDiskTaskDirResolver(root)("task-a")).toBeNull();
  });

  it("treats task ids as globally unique: first sorted folder wins", () => {
    const root = mkdtempSync(join(tmpdir(), "pidock-resolver-dup-"));
    for (const folder of ["aaa-task-abcdef12", "zzz-task-abcdef12"]) {
      const dir = join(root, folder);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "task.json"), JSON.stringify(taskRecord("task-a", dir)), "utf8");
    }
    expect(createDiskTaskDirResolver(root)("task-a")).toBe(join(root, "aaa-task-abcdef12"));
  });

  it("derives the machine tasks root (env override or ~/PiDockTasks)", () => {
    expect(defaultTasksRoot({}, "/Users/name")).toBe(join("/Users/name", "PiDockTasks"));
    expect(defaultTasksRoot({ PIDOCK_DEFAULT_ROOT: "/Volumes/Data/Tasks" }, "/Users/name")).toBe(
      "/Volumes/Data/Tasks",
    );
    expect(defaultTasksRoot({ PIDOCK_DEFAULT_ROOT: "relative/tasks" }, "/Users/name")).toBe(
      join("/Users/name", "PiDockTasks"),
    );
    expect(expandTaskRoot("~/PiDockTasks", "/Users/name")).toBe(join("/Users/name", "PiDockTasks"));
  });

  it("matches POSIX/Windows spellings of the same folder", () => {
    expect(normalizeTaskPath("C:\\Tasks\\a\\")).toBe(normalizeTaskPath("c:/Tasks/a"));
    const root = mkdtempSync(join(tmpdir(), "pidock-resolver-win-"));
    expect(createDiskTaskDirResolver(root)("task-a")).toBeNull();
  });

  it("production wired: main.ts injects the disk resolver with the default root", async () => {
    // Shape guard only: `main.ts` must keep injecting the disk resolver
    // with the default tasks root. Behavioral coverage (seeded root +
    // real resolver + fake spawn asserting first-use forks) lives in
    // `task-hosts.test.ts` ("resolves provisioned tasks exactly as
    // main.ts wires the registry").
    const { readFileSync } = await import("node:fs");
    const { join: joinPath, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(joinPath(here, "main.ts"), "utf8");
    expect(source).toContain("createDiskTaskDirResolver");
    expect(source).toContain("defaultTasksRoot()");
    expect(source).not.toMatch(/new PerTaskHostRegistry\(workspaceId\)(?!\s*,)/);
  });
});
