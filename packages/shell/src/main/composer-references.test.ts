import { describe, expect, it } from "vitest";
import {
  boundSnippet,
  buildFileReference,
  classifyComposerAttachment,
  describeReferenceScope,
  fuzzyScore,
  searchTaskFiles,
  validateDraftReference,
  validateDraftReferences,
  type TaskFileEntry,
} from "./composer-references.js";

const entries: TaskFileEntry[] = [
  { sourceId: "repo-front", sourceKind: "worktree", displayName: "front-monorepo", relativePath: "src/api.ts", kind: "file", size: 1200 },
  { sourceId: "repo-bff", sourceKind: "worktree", displayName: "bff-service", relativePath: "src/api.ts", kind: "file", size: 900 },
  { sourceId: "repo-front", sourceKind: "worktree", displayName: "front-monorepo", relativePath: "src/checkout/view.tsx", kind: "file" },
  { sourceId: "repo-front", sourceKind: "worktree", displayName: "front-monorepo", relativePath: "node_modules/left-pad/index.js", kind: "file" },
  { sourceId: "dir-docs", sourceKind: "plain-dir", displayName: "release-docs", target: "/Users/x/docs", relativePath: "spec.md", kind: "file" },
];

describe("composer reference rules", () => {
  it("searches both worktrees and plain dirs, keeps same-named paths apart and respects ignore rules", () => {
    const { items } = searchTaskFiles(entries, "api");
    expect(items.map((item) => item.label)).toEqual(["bff-service/src/api.ts", "front-monorepo/src/api.ts"]);
    expect(items[0].sourceId).toBe("repo-bff");
    expect(items[1].sourceId).toBe("repo-front");
    // Ignored directories never become candidates.
    expect(searchTaskFiles(entries, "left-pad").items).toEqual([]);
    // Plain-directory sources are searched too.
    expect(searchTaskFiles(entries, "spec").items[0]).toMatchObject({ sourceKind: "plain-dir", label: "release-docs/spec.md" });
  });

  it("bounds the candidate list and reports truncation", () => {
    const many: TaskFileEntry[] = Array.from({ length: 30 }, (_, index) => ({
      sourceId: "repo-front",
      sourceKind: "worktree",
      displayName: "front-monorepo",
      relativePath: `src/file-${index}.ts`,
      kind: "file",
    }));
    const bounded = searchTaskFiles(many, "file", { limit: 5 });
    expect(bounded.items).toHaveLength(5);
    expect(bounded.truncated).toBe(true);
  });

  it("prefers contiguous matches and refuses non-subsequences", () => {
    expect(fuzzyScore("api", "src/api.ts")).not.toBeNull();
    expect(fuzzyScore("apx", "src/api.ts")).toBeNull();
    expect((fuzzyScore("api", "src/api.ts") ?? 0) > (fuzzyScore("api", "a-p-i.ts") ?? 0)).toBe(true);
  });

  it("checks local attachments before sending and never grants directory access", () => {
    const image = classifyComposerAttachment({ name: "shot.png", size: 2000, type: "image/png" });
    expect(image).toMatchObject({ ok: true, kind: "image" });
    expect(image.ok && image.detail).toContain("未授权访问所在目录");
    expect(classifyComposerAttachment({ name: "notes.md", size: 3000, type: "text/markdown" })).toMatchObject({ ok: true, kind: "text" });
    expect(classifyComposerAttachment({ name: "archive.zip", size: 1000, type: "application/zip" })).toMatchObject({ ok: false, code: "unsupported-type" });
    expect(classifyComposerAttachment({ name: "huge.txt", size: 2 * 1024 * 1024, type: "text/plain" })).toMatchObject({ ok: false, code: "too-large" });
  });

  it("records source identity, version and real target separately", () => {
    const worktree = buildFileReference({
      id: "ref-1",
      taskId: "task-a",
      entry: entries[0],
      worktreeVersion: "abc123",
    });
    expect(worktree).toMatchObject({ sourceKind: "worktree", displayName: "front-monorepo", relativePath: "src/api.ts", version: "abc123", kind: "file" });
    expect(worktree.detail).toContain("worktree @ abc123");

    const plain = buildFileReference({ id: "ref-2", taskId: "task-a", entry: entries[4], worktreeVersion: "abc123" });
    expect(plain.version).toBeNull();
    expect(plain.target).toBe("/Users/x/docs");
    expect(plain.detail).toContain("无 Git 版本");

    const snippet = buildFileReference({ id: "ref-3", taskId: "task-a", entry: entries[2], worktreeVersion: "abc123", lines: { from: 10, to: 24 } });
    expect(snippet.kind).toBe("snippet");
    expect(snippet.label).toBe("front-monorepo/src/checkout/view.tsx:10-24");
  });

  it("bounds snippets and refuses over-long selections", () => {
    expect(boundSnippet({ from: 1, to: 10 }, "x".repeat(100))).toEqual({ ok: true, lines: { from: 1, to: 10 }, chars: 100 });
    expect(boundSnippet({ from: 1, to: 500 }, "x")).toMatchObject({ ok: false, code: "too-many-lines" });
    expect(boundSnippet({ from: 1, to: 10 }, "x".repeat(30_000))).toMatchObject({ ok: false, code: "too-long" });
  });

  it("reports moved, stale, cross-task and out-of-bounds drafts without falling back to the main checkout", () => {
    const context = { taskId: "task-a", entries, worktreeVersion: "abc123" };
    const base = { taskId: "task-a", sourceId: "repo-front", sourceKind: "worktree" as const, relativePath: "src/api.ts", version: "abc123" };
    expect(validateDraftReference(base, context)).toEqual({ state: "ok" });
    expect(validateDraftReference({ ...base, taskId: "task-b" }, context)).toMatchObject({ code: "cross-task" });
    expect(validateDraftReference({ ...base, relativePath: "src/gone.ts" }, context)).toMatchObject({ code: "moved" });
    expect(validateDraftReference({ ...base, sourceId: "repo-gone" }, context)).toMatchObject({ code: "stale-source" });
    expect(validateDraftReference({ ...base, relativePath: "../outside.ts" }, context)).toMatchObject({ code: "out-of-bounds" });
    expect(validateDraftReference({ ...base, version: "old999" }, context)).toMatchObject({ code: "no-version" });
    expect(validateDraftReference({ ...base, version: null }, context)).toMatchObject({ code: "no-version" });

    const report = validateDraftReferences(
      [{ id: "a", ...base }, { id: "b", ...base, relativePath: "src/gone.ts" }],
      context,
    );
    expect(report.requiresReselect).toBe(true);
    expect(report.references.map((item) => item.status.state)).toEqual(["ok", "invalid"]);
  });

  it("labels estimated size as an estimate, never as reported usage", () => {
    const reference = buildFileReference({ id: "ref-1", taskId: "task-a", entry: entries[0], worktreeVersion: "abc123" });
    const scope = describeReferenceScope(reference);
    expect(scope).toContain("估算");
    expect(scope).toContain("不计入实报 Token");
  });
});

describe("reference payload guard (Host boundary)", () => {
  const base = { id: "r1", kind: "file", label: "front-monorepo/src/api.ts", detail: "任务代码引用", taskId: "task-a", sourceId: "front-monorepo", sourceKind: "worktree", relativePath: "src/api.ts", version: "abc123" };

  it("accepts a well-formed task reference and rejects forged provenance", async () => {
    const { checkReferencePayload } = await import("./composer-references.js");
    expect(checkReferencePayload(base)).toEqual({ ok: true });
    expect(checkReferencePayload({ ...base, kind: "snippet" })).toEqual({ ok: true });
    expect(checkReferencePayload({ ...base, relativePath: "../escape.ts" })).toMatchObject({ ok: false });
    expect(checkReferencePayload({ ...base, relativePath: "/etc/passwd" })).toMatchObject({ ok: false });
    expect(checkReferencePayload({ ...base, kind: "unknown" })).toMatchObject({ ok: false });
    expect(checkReferencePayload({ ...base, label: "" })).toMatchObject({ ok: false });
    expect(checkReferencePayload(null)).toMatchObject({ ok: false });
    // A plain-directory link must not claim a Git version.
    expect(checkReferencePayload({ ...base, sourceKind: "plain-dir", version: "abc123" })).toMatchObject({ ok: false });
    expect(checkReferencePayload({ ...base, sourceKind: "plain-dir", version: null })).toEqual({ ok: true });
  });
});
