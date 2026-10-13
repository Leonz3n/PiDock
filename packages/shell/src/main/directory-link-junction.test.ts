import { afterEach, describe, expect, it } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDirectoryLink, linkTargetMatches, type DirectoryLinkOps } from "./directory-link.js";

// The fallback is Windows-only: on POSIX a directory symlink needs no privilege,
// so `createDirectoryLink` never reaches the junction branch (pinned by the pure
// `directory-link.test.ts`). There is therefore no POSIX counterpart to fake.
const win32It = it.skipIf(process.platform !== "win32");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("createDirectoryLink junction fallback on disk", () => {
  win32It("produces a real, usable junction when the directory symlink is EPERM", () => {
    const root = mkdtempSync(join(tmpdir(), "pidock-junction-"));
    roots.push(root);
    const source = join(root, "source");
    const link = join(root, "link");
    mkdirSync(source);
    writeFileSync(join(source, "spec.txt"), "junction bytes\n");

    // The real EPERM shape a de-privileged Windows token gets for `"dir"`, with
    // the `"junction"` attempt delegated to the real `symlinkSync` (measured to
    // succeed without the privilege). Exercises the fallback deterministically
    // without needing a non-elevated session, and lands a REAL junction on disk.
    const ops: DirectoryLinkOps = {
      platform: "win32",
      symlink: (target, path, type) => {
        if (type === "dir") {
          throw Object.assign(new Error(`EPERM: operation not permitted, symlink '${target}' -> '${path}'`), {
            code: "EPERM",
            errno: -4048,
            syscall: "symlink",
          });
        }
        symlinkSync(target, path, type);
      },
    };

    expect(createDirectoryLink(source, link, ops)).toBe("junction");
    // A junction is indistinguishable from a directory symlink under every guard
    // this product uses: it is a link, NOT a plain directory.
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(lstatSync(link).isDirectory()).toBe(false);
    expect(statSync(link).isDirectory()).toBe(true);
    expect(linkTargetMatches(readlinkSync(link), source)).toBe(true);

    // Usable: reads and writes flow through to the original directory.
    expect(readFileSync(join(link, "spec.txt"), "utf8")).toBe("junction bytes\n");
    writeFileSync(join(link, "spec.txt"), "written through junction\n");
    expect(readFileSync(join(source, "spec.txt"), "utf8")).toBe("written through junction\n");

    // Removal removes only the link; the source and its contents stay intact.
    rmSync(link, { force: true });
    expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
    expect(readFileSync(join(source, "spec.txt"), "utf8")).toBe("written through junction\n");
  });
});
