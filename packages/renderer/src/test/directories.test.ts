import {
  directoryLinkName,
  directoryLinkPath,
  isDirectoryOnlyTask,
  newWorkspaceKey,
  normalizeDirectoryPath,
  toTaskDirectory,
  workspacePath,
} from "../data/directories";
import type { Task } from "../data/types";

describe("directory link naming", () => {
  it("derives a stable ASCII link name from the id, ignoring the display name", () => {
    expect(directoryLinkName({ id: "atlas-docs" })).toBe("dir-atlasdoc");
    expect(directoryLinkName({ id: "9f2c-1A2B-3C4D" })).toBe("dir-9f2c1a2b");
  });

  it("is stable across calls and independent of the Chinese name", () => {
    const first = directoryLinkName({ id: "atlas-docs" });
    const second = directoryLinkName({ id: "atlas-docs" });
    expect(first).toBe(second);
  });
});

describe("workspacePath", () => {
  it("joins root, task key and link name without duplicating separators", () => {
    expect(workspacePath("/Users/name/Tasks/", "task-a1f92c3d", "dir-atlasdoc")).toBe(
      "/Users/name/Tasks/task-a1f92c3d/dir-atlasdoc",
    );
  });

  it("computes the in-task symlink path from the task root and key", () => {
    expect(directoryLinkPath("/Users/name/Tasks", "task-a1f92c3d", { linkName: "dir-atlasdoc" })).toBe(
      "/Users/name/Tasks/task-a1f92c3d/dir-atlasdoc",
    );
  });
});

describe("newWorkspaceKey", () => {
  it("returns a distinct task-<8 hex> key for the create-task preview", () => {
    const first = newWorkspaceKey();
    expect(first).toMatch(/^task-[0-9a-f]{8}$/);
    expect(newWorkspaceKey()).not.toBe(first);
  });
});

describe("toTaskDirectory", () => {
  it("snapshots a project directory with its link name and leaves the original path alone", () => {
    const directory = toTaskDirectory({ id: "atlas-docs", name: "Atlas 设计资料", path: "/Users/me/design" });
    expect(directory).toEqual({
      id: "atlas-docs",
      name: "Atlas 设计资料",
      path: "/Users/me/design",
      linkName: "dir-atlasdoc",
    });
  });
});

describe("isDirectoryOnlyTask", () => {
  const base = { repos: [] as string[], directories: [] as Task["directories"] };
  it("is true only for a task with directories and no Git repos", () => {
    expect(isDirectoryOnlyTask({ ...base, directories: [toTaskDirectory({ id: "a", name: "A", path: "/a" })] } as Task)).toBe(true);
    expect(isDirectoryOnlyTask({ ...base, repos: ["front-monorepo"], directories: [toTaskDirectory({ id: "a", name: "A", path: "/a" })] } as Task)).toBe(false);
    expect(isDirectoryOnlyTask({ ...base } as Task)).toBe(false);
  });
});

describe("normalizeDirectoryPath", () => {
  it("ignores trailing separators so duplicate paths are detected", () => {
    expect(normalizeDirectoryPath("/Users/me/design/")).toBe(normalizeDirectoryPath("/Users/me/design"));
    expect(normalizeDirectoryPath("/Users/me/design")).toBe("/Users/me/design");
  });
});
