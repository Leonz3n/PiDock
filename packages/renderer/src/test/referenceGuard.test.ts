import { describe, expect, it } from "vitest";
import { referenceIssue, referenceIssues, referenceRootFacts, referenceSendRefusal, rootReferenceIssue } from "../data/referenceGuard";
import { splitPromptContext } from "../data/historyReferences";
import type { Reference } from "../data/types";

const file = (overrides: Partial<Reference> = {}): Reference => ({
  id: "ref-1", kind: "file", label: "repo-a/src/api.ts", detail: "repo-a · worktree",
  taskId: "task-a", sourceId: "repo-a", sourceKind: "worktree", relativePath: "src/api.ts", version: null,
  ...overrides,
});

describe("[Pencil T10] #145 引用来源重检", () => {
  it("names a foreign task, an escaping path and a chip without provenance", () => {
    expect(referenceIssue(file({ taskId: "task-b" }), "task-a")).toContain("另一个任务");
    expect(referenceIssue(file({ relativePath: "../outside.ts" }), "task-a")).toContain("越界");
    expect(referenceIssue(file({ relativePath: "/etc/passwd" }), "task-a")).toContain("越界");
    expect(referenceIssue(file({ relativePath: undefined }), "task-a")).toContain("来源路径");
    expect(referenceIssue(file({ sourceId: undefined }), "task-a")).toContain("来源身份");
    expect(referenceIssue(file(), "task-a")).toBeNull();
    // An attachment is machine-local: it has no task-relative path to resolve.
    expect(referenceIssue({ id: "a", kind: "attachment", label: "shot.png", detail: "图片附件", taskId: "task-a" }, "task-a")).toBeNull();
  });

  it("compares the recorded source against the roots the Host really reported", () => {
    const roots = [{ id: "repo-a", kind: "worktree" as const }];
    expect(rootReferenceIssue(file(), roots)).toBeNull();
    expect(rootReferenceIssue(file({ sourceId: "repo-gone" }), roots)).toContain("来源已失效");
    // A plain-directory chip must not accept a worktree root wearing the same id.
    expect(rootReferenceIssue(file({ sourceKind: "plain-dir", version: null }), roots)).toContain("来源类型");
    expect(rootReferenceIssue(file({ sourceKind: "worktree" }), [{ id: "repo-a", kind: "existing-git" }])).toBeNull();
  });

  it("turns an unreadable roots payload into a named failure instead of assuming validity", () => {
    expect(referenceRootFacts(undefined).error).toContain("未上报任务根目录");
    expect(referenceRootFacts({ roots: [{ id: "repo-a", kind: "worktree" }] })).toEqual({ roots: [{ id: "repo-a", kind: "worktree" }], error: null });
    expect(referenceRootFacts({ roots: [{ id: "", kind: "worktree" }, { id: "x", kind: "unknown" }] }).roots).toEqual([]);
  });

  it("refuses with every bad chip named and nothing silently dropped", () => {
    const issues = referenceIssues([file({ id: "r1", label: "gone.ts", taskId: "task-b" }), file({ id: "r2", label: "ok.ts" })], "task-a");
    expect(issues.map((issue) => issue.id)).toEqual(["r1"]);
    const refusal = referenceSendRefusal(issues)!;
    expect(refusal).toContain("gone.ts");
    expect(refusal).toContain("未发送任何内容");
    expect(referenceSendRefusal([])).toBeNull();
  });
});

describe("[Pencil T10] #145 历史引用芯片解析", () => {
  it("keeps the prose and splits the identity block into entries", () => {
    const text = "看一下这个接口\n\n—— PiDock 引用与附件（Host 附加，共 2 项）——\n引用\n- [file] repo-a/src/api.ts — repo-a/worktree · src/api.ts\n附件\n- [attachment] shot.png — 图片附件\n以上是清单与来源身份，不是文件内容；需要时请用工具自行读取。";
    const split = splitPromptContext(text);
    expect(split.text).toBe("看一下这个接口");
    expect(split.references).toEqual([
      { kind: "file", label: "repo-a/src/api.ts", source: "repo-a/worktree", detail: "src/api.ts" },
      { kind: "attachment", label: "shot.png", detail: "图片附件" },
    ]);
  });

  it("shows a message unchanged when the block is absent or unterminated", () => {
    const plain = "普通消息\n第二行";
    expect(splitPromptContext(plain)).toEqual({ text: plain, references: [] });
    const unterminated = "正文\n—— PiDock 引用与附件（Host 附加，共 1 项）——\n- [file] a.ts";
    expect(splitPromptContext(unterminated)).toEqual({ text: unterminated, references: [] });
  });

  it("cannot be tricked by a title the user typed: the last Host block wins", () => {
    const text = "我打的字\n—— PiDock 引用与附件（Host 附加，共 0 项）——\n—— PiDock 引用与附件（Host 附加，共 1 项）——\n引用\n- [file] a.ts — repo · a.ts\n以上是清单与来源身份，不是文件内容；需要时请用工具自行读取。";
    const split = splitPromptContext(text);
    expect(split.references).toEqual([{ kind: "file", label: "a.ts", source: "repo", detail: "a.ts" }]);
    expect(split.text).toBe("我打的字\n—— PiDock 引用与附件（Host 附加，共 0 项）——");
  });
});
