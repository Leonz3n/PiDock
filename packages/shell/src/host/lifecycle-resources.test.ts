/**
 * Real-filesystem evidence for [PiDock 14] (#17) link cleanup: removing an
 * in-task link must delete only the directory entry, never the recorded source
 * directory or its contents.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLifecycleResources } from "./lifecycle-resources.js";
import type { TaskWorkspaceHost } from "./task-host.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function resources() {
  return createLifecycleResources({
    host: {} as TaskWorkspaceHost,
    services: () => null,
    terminals: () => null,
    sessionIds: () => [],
  });
}

describe("createLifecycleResources link removal", () => {
  it("removes only the in-task symlink and preserves the source directory contents", () => {
    const root = mkdtempSync(join(tmpdir(), "pidock-link-cleanup-"));
    roots.push(root);
    const source = join(root, "invoice-docs");
    mkdirSync(source);
    writeFileSync(join(source, "spec.md"), "original content");
    const taskDir = join(root, "task-abcdef12");
    mkdirSync(taskDir);
    const link = join(taskDir, "dir-invoice-docs");
    symlinkSync(source, link);

    const lifecycle = resources();
    expect(lifecycle.observeInTaskPath(link)).toMatchObject({ isSymlink: true, isDirectory: false, currentTarget: source });
    lifecycle.removeInTaskPath(link);

    expect(existsSync(link)).toBe(false);
    expect(readFileSync(join(source, "spec.md"), "utf8")).toBe("original content");
  });

  it("removes a dangling or self-referential link without resolving through it", () => {
    const root = mkdtempSync(join(tmpdir(), "pidock-link-cleanup-"));
    roots.push(root);
    const taskDir = join(root, "task-abcdef12");
    mkdirSync(taskDir);
    const dangling = join(taskDir, "dir-missing");
    symlinkSync(join(root, "missing-source"), dangling);
    const loop = join(taskDir, "dir-loop");
    symlinkSync(loop, loop);

    const lifecycle = resources();
    expect(lifecycle.observeInTaskPath(dangling)).toMatchObject({ isSymlink: true, isDirectory: false });
    lifecycle.removeInTaskPath(dangling);
    expect(existsSync(dangling)).toBe(false);

    expect(lifecycle.observeInTaskPath(loop)).toMatchObject({ isSymlink: true, isDirectory: false });
    lifecycle.removeInTaskPath(loop);
    expect(existsSync(loop)).toBe(false);
  });
});
