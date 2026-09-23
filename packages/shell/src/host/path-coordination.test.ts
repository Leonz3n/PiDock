import { describe, expect, it } from "vitest";
import {
  MAX_SHARED_PATH_KEYS,
  SharedPathCoordinator,
  classifyRealPath,
  normalizeScopePath,
  pathScopeOverlaps,
  scopeKeysFor,
  type SharedRoot,
} from "./path-coordination.js";

// Seam: [PiDock 09] (#11) real-path write coordination across tasks. The rules
// are pure so the Host dispatch, the renderer readout and these tests share one
// judgement: only the resolved real path decides, never the lexical one.

const roots = (...entries: [string, string][]): SharedRoot[] =>
  entries.map(([directoryId, realPath]) => ({ directoryId, sourcePath: realPath, realPath }));

describe("real path normalization", () => {
  it("collapses segments, separators and trailing slashes", () => {
    expect(normalizeScopePath("  /a/b/../c//")).toBe("/a/c");
    expect(normalizeScopePath("C:\\Users\\me\\Board\\")).toBe("c:/Users/me/Board");
    expect(normalizeScopePath("./relative/./path")).toBe("relative/path");
    expect(normalizeScopePath("   ")).toBe("");
  });

  it("overlaps only on real containment, not on shared prefixes", () => {
    expect(pathScopeOverlaps("/a/b", "/a/b")).toBe(true);
    expect(pathScopeOverlaps("/a/b", "/a/b/c.ts")).toBe(true);
    expect(pathScopeOverlaps("/a/b/c.ts", "/a/b")).toBe(true);
    expect(pathScopeOverlaps("/a/bc", "/a/b")).toBe(false);
    expect(pathScopeOverlaps("/a/b", "/x/b")).toBe(false);
    // A retargeted link resolves to a different real path: no overlap remains.
    expect(pathScopeOverlaps("/shared/docs", "/shared/docs-archive")).toBe(false);
  });

  it("reduces a claim to its outermost paths", () => {
    expect(scopeKeysFor(["/a/b/c.ts", "/a/b", "/a/b/c.ts/", "/a/b/d.ts"])).toEqual(["/a/b"]);
    // Ancestors of the outermost keys are separate keys, not collapsed.
    expect(scopeKeysFor(["/a/b", "/x/y"])).toEqual(["/a/b", "/x/y"]);
    expect(scopeKeysFor(["", "   "])).toEqual([]);
  });
});

describe("real-path scope validation", () => {
  const taskDir = "/work/tasks/task-a1f92c3d";

  it("accepts the task folder and its shared directories on the real path", () => {
    expect(classifyRealPath({ resolvedPath: "/work/tasks/task-a1f92c3d/saas-web/src/x.ts", taskDir, roots: [] })).toMatchObject({
      kind: "task",
    });
    expect(
      classifyRealPath({ resolvedPath: "/shared/invoice-docs/spec.md", taskDir, roots: roots(["invoice-docs", "/shared/invoice-docs"]) }),
    ).toMatchObject({ kind: "shared", directoryId: "invoice-docs" });
  });

  it("refuses a retargeted link whose source now resolves outside every allowed root", () => {
    // The link was recorded for `invoice-docs`, but the real path now points at
    // another shared directory: the lexical check would pass, the real one must
    // not.
    const verdict = classifyRealPath({
      resolvedPath: "/other/private/secrets/notes.md",
      taskDir,
      roots: roots(["invoice-docs", "/shared/invoice-docs"]),
    });
    expect(verdict.kind).toBe("outside");
    if (verdict.kind === "outside") expect(verdict.reason).toContain("真实路径");
  });

  it("resolves a nested link to the innermost matching root but still flags an escape", () => {
    const nested = classifyRealPath({
      resolvedPath: "/shared/invoice-docs/vendor/manual/spec.md",
      taskDir,
      roots: roots(["invoice-docs", "/shared/invoice-docs"], ["vendor-manual", "/shared/invoice-docs/vendor/manual"]),
    });
    expect(nested).toMatchObject({ kind: "shared", directoryId: "vendor-manual" });
    expect(classifyRealPath({ resolvedPath: "/shared/unknown/keep.md", taskDir, roots: roots(["invoice-docs", "/shared/invoice-docs"]) })).toMatchObject({
      kind: "outside",
    });
  });

  it("treats an empty path as not classifiable", () => {
    const verdict = classifyRealPath({ resolvedPath: "  ", taskDir, roots: roots(["invoice-docs", "/shared/invoice-docs"]) });
    expect(verdict.kind).toBe("outside");
  });
});

describe("cross-task shared path coordination", () => {
  it("refuses an overlapping write from another task and names the holder", () => {
    const shared = new SharedPathCoordinator();
    expect(
      shared.claim({ taskId: "release", sessionId: "main", label: "回合工具 fs.write", paths: ["/shared/invoice-docs/spec.md"] }),
    ).toMatchObject({ ok: true });
    const blocked = shared.claim({
      taskId: "checkout",
      sessionId: "main",
      label: "回合工具 fs.write",
      paths: ["/shared/invoice-docs/spec.md"],
    });
    expect(blocked).toMatchObject({ ok: false });
    if (!blocked.ok) {
      expect(blocked.reason).toContain("shared-path-locked");
      expect(blocked.reason).toContain("release");
      expect(blocked.conflicts[0]?.holder.label).toBe("回合工具 fs.write");
    }
  });

  it("lets another task write a non-overlapping path in the same shared directory", () => {
    const shared = new SharedPathCoordinator();
    shared.claim({ taskId: "release", sessionId: "main", label: "写 spec", paths: ["/shared/invoice-docs/spec.md"] });
    expect(
      shared.claim({ taskId: "checkout", sessionId: "main", label: "写 notes", paths: ["/shared/invoice-docs/notes/rfc.md"] }),
    ).toMatchObject({ ok: true });
    expect(shared.snapshot().map((holder) => holder.taskId).sort()).toEqual(["checkout", "release"]);
  });

  it("treats a nested link target as overlapping through its ancestor", () => {
    const shared = new SharedPathCoordinator();
    // release claims the outer shared directory; checkout works inside the
    // nested link target that lives below it.
    shared.claim({ taskId: "release", sessionId: "main", label: "写共享目录", paths: ["/shared/invoice-docs"] });
    expect(
      shared.claim({ taskId: "checkout", sessionId: "main", label: "写嵌套链接", paths: ["/shared/invoice-docs/vendor/manual/spec.md"] }),
    ).toMatchObject({ ok: false });
  });

  it("keeps a derived execution's keys after its turn settles and frees them on end", () => {
    const shared = new SharedPathCoordinator();
    shared.claim({
      taskId: "release",
      sessionId: "main",
      label: "构建子进程",
      paths: ["/shared/invoice-docs/dist"],
      derivedExecutionIds: ["svc-build"],
    });
    const partial = shared.release({ taskId: "release", sessionId: "main", keepDerivedExecutionIds: ["svc-build"] });
    expect(partial.holder?.keys).toEqual(["/shared/invoice-docs/dist"]);
    expect(
      shared.claim({ taskId: "checkout", sessionId: "main", label: "写 dist", paths: ["/shared/invoice-docs/dist/out.js"] }),
    ).toMatchObject({ ok: false });
    shared.release({ taskId: "release", sessionId: "main" });
    expect(shared.claim({ taskId: "checkout", sessionId: "main", label: "写 dist", paths: ["/shared/invoice-docs/dist/out.js"] })).toMatchObject({
      ok: true,
    });
  });

  it("releases the old key when a link is retargeted and claims the new one", () => {
    const shared = new SharedPathCoordinator();
    shared.claim({ taskId: "release", sessionId: "main", label: "写旧目标", paths: ["/shared/invoice-docs/spec.md"] });
    shared.release({ taskId: "release", sessionId: "main" });
    // The link now resolves to another shared directory: the new key is free
    // (the old holder did not keep it) and the old key is no longer held.
    expect(shared.holderOf("/shared/invoice-docs/spec.md")).toBeNull();
    expect(
      shared.claim({ taskId: "release", sessionId: "main", label: "写新目标", paths: ["/shared/marketing-site/index.html"] }),
    ).toMatchObject({ ok: true });
    expect(shared.holderOf("/shared/marketing-site/index.html")?.taskId).toBe("release");
  });

  it("refuses another session of the same task on an overlapping real path", () => {
    const shared = new SharedPathCoordinator();
    shared.claim({ taskId: "release", sessionId: "main", label: "写 spec", paths: ["/shared/invoice-docs/spec.md"] });
    // Same task, other session: the shared rule holds even without the task lock.
    expect(
      shared.claim({ taskId: "release", sessionId: "review", label: "写 spec", paths: ["/shared/invoice-docs"] }),
    ).toMatchObject({ ok: false });
    // Re-claiming from the holder extends its own holder instead of conflicting.
    expect(shared.claim({ taskId: "release", sessionId: "main", label: "写 spec 第二轮", paths: ["/shared/invoice-docs"] })).toMatchObject({
      ok: true,
    });
    expect(shared.snapshot()).toHaveLength(1);
  });

  it("cancels a whole task and stays bounded", () => {
    const shared = new SharedPathCoordinator();
    shared.claim({ taskId: "release", sessionId: "main", label: "a", paths: ["/shared/a"] });
    shared.claim({ taskId: "release", sessionId: "deploy", label: "b", paths: ["/shared/b"] });
    expect(shared.releaseTask("release")).toEqual(["main", "deploy"]);
    expect(shared.snapshot()).toEqual([]);
    const many = Array.from({ length: MAX_SHARED_PATH_KEYS + 4 }, (_, index) => `/shared/keys/p${index}/file.ts`);
    const claim = shared.claim({ taskId: "release", sessionId: "main", label: "很多路径", paths: many });
    expect(claim).toMatchObject({ ok: false });
    expect(String(claim.ok === false ? claim.reason : "")).toContain("上限");
  });
});
