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

  it("reports a link retargeted outside the task and still removes only the entry, preserving both targets", () => {
    const root = mkdtempSync(join(tmpdir(), "pidock-link-cleanup-"));
    roots.push(root);
    const original = join(root, "original-docs");
    mkdirSync(original);
    writeFileSync(join(original, "spec.md"), "original content");
    const elsewhere = join(root, "external-docs");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "notes.md"), "external content");
    const taskDir = join(root, "task-abcdef12");
    mkdirSync(taskDir);
    const link = join(taskDir, "dir-docs");
    symlinkSync(original, link);
    // The user (or another tool) points the link at a different directory.
    rmSync(link);
    symlinkSync(elsewhere, link);

    const lifecycle = resources();
    expect(lifecycle.observeInTaskPath(link)).toMatchObject({ isSymlink: true, currentTarget: elsewhere });
    lifecycle.removeInTaskPath(link);

    expect(existsSync(link)).toBe(false);
    expect(readFileSync(join(original, "spec.md"), "utf8")).toBe("original content");
    expect(readFileSync(join(elsewhere, "notes.md"), "utf8")).toBe("external content");
  });

  it("removes the identity-confirmed link and keeps going past a replaced entry without deleting it", () => {
    const root = mkdtempSync(join(tmpdir(), "pidock-link-cleanup-"));
    roots.push(root);
    const source = join(root, "invoice-docs");
    mkdirSync(source);
    writeFileSync(join(source, "spec.md"), "original content");
    const taskDir = join(root, "task-abcdef12");
    mkdirSync(taskDir);
    const link = join(taskDir, "dir-invoice-docs");
    symlinkSync(source, link);
    // The link was replaced by a real directory that is NOT this task's link:
    // `verifyLinkRemoval` refuses it, and the removal call itself must never
    // recurse into it.
    const replaced = join(taskDir, "dir-replaced");
    mkdirSync(replaced);
    writeFileSync(join(replaced, "keep.md"), "must survive");

    const lifecycle = resources();
    expect(lifecycle.observeInTaskPath(replaced)).toMatchObject({ isSymlink: false, isDirectory: true });
    expect(() => lifecycle.removeInTaskPath(replaced)).toThrow();
    lifecycle.removeInTaskPath(link);

    expect(existsSync(link)).toBe(false);
    expect(readFileSync(join(replaced, "keep.md"), "utf8")).toBe("must survive");
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
