import { describe, expect, it } from "vitest";
import { createDirectoryLink, linkTargetMatches, normalizeLinkTarget, type DirectoryLinkOps } from "./directory-link.js";

/** The real error shape a de-privileged Windows token gets for a `"dir"` symlink. */
function eperm(): NodeJS.ErrnoException {
  return Object.assign(new Error("EPERM: operation not permitted, symlink"), {
    code: "EPERM",
    errno: -4048,
    syscall: "symlink",
  });
}

/** A fake ops whose platform is a *value* and whose `symlink` records call order. */
function recordingOps(platform: string, fail?: (type: "dir" | "junction") => NodeJS.ErrnoException | null) {
  const calls: ("dir" | "junction")[] = [];
  const ops: DirectoryLinkOps = {
    platform,
    symlink: (_target, _path, type) => {
      calls.push(type);
      const error = fail?.(type);
      if (error) throw error;
    },
  };
  return { ops, calls };
}

describe("createDirectoryLink", () => {
  it("creates a plain directory symlink and reports its kind", () => {
    const { ops, calls } = recordingOps("linux");
    expect(createDirectoryLink("/src", "/lnk", ops)).toBe("symlink");
    expect(calls).toEqual(["dir"]);
  });

  it("on win32 prefers the dir symlink when the privilege exists", () => {
    const { ops, calls } = recordingOps("win32");
    expect(createDirectoryLink("C:\\src", "C:\\lnk", ops)).toBe("symlink");
    expect(calls).toEqual(["dir"]);
  });

  it("on win32 falls back to a junction on EPERM only", () => {
    const { ops, calls } = recordingOps("win32", (type) => (type === "dir" ? eperm() : null));
    expect(createDirectoryLink("C:\\src", "C:\\lnk", ops)).toBe("junction");
    expect(calls).toEqual(["dir", "junction"]);
  });

  it.each(["EACCES", "EEXIST", "ENOTDIR", "ENOSPC"])(
    "on win32 does NOT fall back for %s and preserves the error verbatim",
    (code) => {
      const original = Object.assign(new Error(`${code}: ..., symlink`), {
        code,
        errno: -1,
        syscall: "symlink",
        path: "C:\\lnk",
      });
      const { ops, calls } = recordingOps("win32", (type) => (type === "dir" ? original : null));
      let caught: unknown;
      try {
        createDirectoryLink("C:\\src", "C:\\lnk", ops);
      } catch (error) {
        caught = error;
      }
      // Exactly one attempt: a non-privilege error is never retried as another
      // link kind, and the SAME error object / fields escape (not wrapped,
      // not replaced by a generic error).
      expect(calls).toEqual(["dir"]);
      expect(caught).toBe(original);
      expect((caught as NodeJS.ErrnoException).code).toBe(code);
      expect((caught as NodeJS.ErrnoException).syscall).toBe("symlink");
      expect((caught as NodeJS.ErrnoException).path).toBe("C:\\lnk");
    },
  );

  it("on win32 does not fall back when the junction also fails: the junction error escapes verbatim", () => {
    const first = eperm();
    const second = Object.assign(new Error("EACCES: permission denied, symlink"), {
      code: "EACCES",
      errno: -4092,
      syscall: "symlink",
      path: "C:\\lnk",
    });
    const { ops, calls } = recordingOps("win32", (type) => (type === "dir" ? first : second));
    let caught: unknown;
    try {
      createDirectoryLink("C:\\src", "C:\\lnk", ops);
    } catch (error) {
      caught = error;
    }
    expect(calls).toEqual(["dir", "junction"]);
    // The retry-failure path surfaces the junction attempt's own error object
    // (design §3.1). It stays a real permission-class error with its code/syscall/
    // path, so "fall back" never becomes a misleading success or a generic mask.
    expect(caught).toBe(second);
    expect((caught as NodeJS.ErrnoException).code).toBe("EACCES");
  });

  it("off win32 the fallback is unreachable", () => {
    const original = eperm();
    const { ops, calls } = recordingOps("darwin", () => original);
    let caught: unknown;
    try {
      createDirectoryLink("/src", "/lnk", ops);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(original);
    expect(calls).toEqual(["dir"]);
  });
});

describe("link target comparison", () => {
  it("normalizes an extended-prefix junction target to the recorded source", () => {
    expect(linkTargetMatches("\\\\?\\C:\\a\\b", "C:\\a\\b")).toBe(true);
    expect(linkTargetMatches("\\??\\C:\\a\\b", "C:\\a\\b")).toBe(true);
    expect(linkTargetMatches("C:\\a\\b", "\\\\?\\C:\\a\\b")).toBe(true);
  });

  it("normalizes separator spelling, trailing separators and the drive letter", () => {
    expect(linkTargetMatches("C:\\a\\b\\", "C:\\a\\b")).toBe(true);
    expect(linkTargetMatches("c:/a/b", "C:\\a\\b")).toBe(true);
    expect(linkTargetMatches("C:/a/b", "C:\\a\\b")).toBe(true);
  });

  it("accepts a link whose recorded source was spelled with a trailing separator (pre-existing compare defect)", () => {
    // `readlink` strips the target's trailing separator while the raw source
    // string may still carry it, so a strict `!==` wrongly refused a correct
    // link. Both link kinds are affected; the trailing separator is dropped on
    // both sides here, and only on both sides.
    expect(linkTargetMatches("C:\\a\\b", "C:\\a\\b\\")).toBe(true);
    expect(linkTargetMatches("C:\\a\\b\\", "C:\\a\\b\\")).toBe(true);
    expect(linkTargetMatches("/tmp/a", "/tmp/a/")).toBe(true);
  });

  it("stays case-sensitive below the drive letter (no loosening)", () => {
    expect(linkTargetMatches("C:\\A\\b", "C:\\a\\b")).toBe(false);
    expect(linkTargetMatches("c:\\a\\b", "C:\\a\\b")).toBe(true);
  });

  it("does not fold a UNC extended path into a drive path", () => {
    expect(linkTargetMatches("\\\\?\\UNC\\srv\\share\\x", "C:\\x")).toBe(false);
    expect(linkTargetMatches("\\\\srv\\share", "C:\\srv\\share")).toBe(false);
  });

  it("still refuses a genuinely different target", () => {
    expect(linkTargetMatches("C:\\a\\bc", "C:\\a\\b")).toBe(false);
    expect(linkTargetMatches("C:\\a\\b\\c", "C:\\a\\b")).toBe(false);
    expect(linkTargetMatches("D:\\a\\b", "C:\\a\\b")).toBe(false);
  });

  it("keeps POSIX comparison byte-exact: a backslash is never a separator", () => {
    // `\` is a legal filename byte on POSIX. The window-only normalisation must
    // not run there, or a backslash spelling would compare equal to the slash
    // spelling and loosen the "a recorded link must not be retargeted" guard.
    expect(normalizeLinkTarget("/tmp/a\\b")).toBe("/tmp/a\\b");
    expect(linkTargetMatches("/tmp/a\\b", "/tmp/a/b")).toBe(false);
    expect(linkTargetMatches("/tmp/a/b", "/tmp/a/b")).toBe(true);
  });

  it("drops a trailing separator on POSIX too, but never folds an interior backslash into a separator", () => {
    // The trailing separator is dropped on BOTH sides and on both branches (the
    // pre-existing compare defect), while an interior `\` still distinguishes a
    // POSIX filename from the slash spelling.
    expect(linkTargetMatches("/tmp/a/", "/tmp/a")).toBe(true);
    expect(linkTargetMatches("/tmp/a\\b/", "/tmp/a/b")).toBe(false);
  });
});
