import { describe, expect, it } from "vitest";
import {
  asHostAttentionItem,
  attentionClearsOnRead,
  attentionItemFromHost,
  attentionLabel,
  groupAttentionItems,
  splitAttentionRead,
  type HostAttentionItem,
} from "../data/attentionRules";
import type { AttentionItem } from "../data/types";

function hostItem(overrides: Partial<HostAttentionItem> = {}): HostAttentionItem {
  return {
    id: "attention-approval-release-approval-1",
    kind: "approval",
    executionId: "exec-1",
    taskId: "release",
    sessionId: "main",
    taskName: "发布",
    detail: "待确认：回合工具 exec.run",
    at: "2026-09-22T10:00:00.000Z",
    read: false,
    ...overrides,
  };
}

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "attention-completed-unread-release-exec-2",
    kind: "completed-unread",
    projectId: "atlas",
    taskId: "release",
    sessionId: "main",
    label: "Atlas · 发布",
    detail: "完成未读：回合工具 fs.write",
    at: "2026-09-22T10:00:00.000Z",
    ...overrides,
  };
}

describe("attention rules", () => {
  it("accepts a well-formed Host item and rejects a partial or unknown one", () => {
    expect(asHostAttentionItem(hostItem())).toEqual(hostItem());
    // A misspelled kind or a missing locator never renders as a real item.
    expect(asHostAttentionItem({ ...hostItem(), kind: "blocked" })).toBeUndefined();
    expect(asHostAttentionItem({ ...hostItem(), sessionId: "" })).toBeUndefined();
    expect(asHostAttentionItem("attention-approval")).toBeUndefined();
    // A Host item without a task name still labels with its task id.
    expect(asHostAttentionItem({ ...hostItem(), taskName: "" })?.taskName).toBe("release");
  });

  it("labels one item with its project once it is known", () => {
    expect(attentionLabel("Atlas", "发布")).toBe("Atlas · 发布");
    expect(attentionLabel(undefined, "发布")).toBe("发布");
    expect(attentionLabel("", "发布")).toBe("发布");
    expect(attentionItemFromHost(hostItem(), { id: "atlas", name: "Atlas" })).toMatchObject({
      id: hostItem().id,
      kind: "approval",
      projectId: "atlas",
      taskId: "release",
      sessionId: "main",
      label: "Atlas · 发布",
      read: false,
    });
    // An unknown project leaves the label as the task name instead of a blank.
     expect(attentionItemFromHost(hostItem(), undefined).label).toBe("发布");
  });

  it("keeps 待处理 and 完成未读 apart and orders both newest first", () => {
    const groups = groupAttentionItems([
      item({ id: "u-old", at: "2026-09-22T09:00:00.000Z" }),
      item({ id: "u-new", at: "2026-09-22T12:00:00.000Z" }),
      item({ kind: "expired", id: "exp", detail: "确认已过期" }),
      item({ kind: "failed", id: "fail", detail: "执行失败" }),
      item({ kind: "approval", id: "appr", detail: "待确认" }),
    ]);
    expect(groups.pending.map((entry) => entry.id)).toEqual(["appr", "fail", "exp"]);
    expect(groups.unread.map((entry) => entry.id)).toEqual(["u-new", "u-old"]);
    // An already-read completion is not part of the unread group.
    const read = groupAttentionItems([item({ read: true })]);
    expect(read.unread).toEqual([]);
    expect(read.pending).toEqual([]);
  });

  it("clears only the unread kind on read and reports what still needs handling", () => {
    expect(attentionClearsOnRead("completed-unread")).toBe(true);
    expect(attentionClearsOnRead("approval")).toBe(false);
    expect(attentionClearsOnRead("failed")).toBe(false);
    expect(attentionClearsOnRead("expired")).toBe(false);
    expect(splitAttentionRead([item(), item({ id: "attention-approval-x", kind: "approval" })])).toEqual({
      clearable: ["attention-completed-unread-release-exec-2"],
      handled: ["attention-approval-x"],
    });
  });
});
