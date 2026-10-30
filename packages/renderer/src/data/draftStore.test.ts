import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_DRAFT_BYTES, draftFromHost, readHostDraft, saveHostDraft } from "./draftStore";

/**
 * [#117 第 7 项 / 业主定 A] 桌面草稿由 Host 持有（`task/saveDraft` / `task/readDraft`），
 * 引用随草稿一起持久化。这个模块是渲染层唯一的读写口：它不拼提示词、不改写 Host
 * 的返回，只做两件事——把 Host 的记录读成 `Reference[]`，把本地状态写回去。
 *
 * 与旧 localStorage 实现的区别正是这些断言的重点：失败必须是**具名**的，读回的引用
 * 若形状不对要被**点名跳过**，超限文字**不静默截断**。
 */

const reference = {
  id: "task-task-file:repo-a:invoice.md",
  kind: "file" as const,
  label: "repo-a/invoice.md",
  detail: "repo-a · 任务代码引用",
  sourceKind: "worktree" as const,
};

function bridge(handler: (op: string, payload: Record<string, unknown>) => unknown) {
  const taskOp = vi.fn(async (_taskId: string, op: string, payload: Record<string, unknown>) => handler(op, payload));
  window.pidock = { taskOp: taskOp as never };
  return taskOp;
}
afterEach(() => { delete window.pidock; vi.restoreAllMocks(); });

describe("reading the draft back from the Host", () => {
  it("returns the stored text and its references", async () => {
    const taskOp = bridge((op) => op === "task/readDraft"
      ? { ok: true, payload: { workspaceId: "w", taskId: "task-a", op, payload: { sessionId: "main", draft: { text: "请看这个文件", updatedAt: "2026-10-19T00:00:00Z", references: [reference] } } } }
      : { ok: false, error: "unexpected" });
    expect(await readHostDraft("task-a")).toEqual({ draft: { text: "请看这个文件", references: [reference] }, error: null });
    expect(taskOp).toHaveBeenCalledWith("task-a", "task/readDraft", { sessionId: "main" });
  });

  it("reports 'no draft' distinctly from 'empty draft'", async () => {
    bridge((op) => ({ ok: true, payload: { workspaceId: "w", taskId: "task-a", op, payload: { sessionId: "main", draft: null } } }));
    expect(await readHostDraft("task-a")).toEqual({ draft: null, error: null });
  });

  it("names a failed read instead of pretending the composer is empty", async () => {
    bridge(() => ({ ok: false, error: "task-host-closing" }));
    const read = await readHostDraft("task-a");
    expect(read.draft).toBeNull();
    expect(read.error).toContain("草稿读取失败");
    expect(read.error).toContain("task-host-closing");
    expect(read.error).toContain("仍可编辑和发送");
  });

  it("keeps the text, skips a malformed reference and says how many it skipped", async () => {
    bridge((op) => ({ ok: true, payload: { workspaceId: "w", taskId: "task-a", op, payload: { sessionId: "main",
      draft: { text: "正文", updatedAt: "2026-10-19T00:00:00Z", references: [reference, { kind: "file", id: "x", detail: "d" }, { kind: "web", id: "y", label: "l", detail: "d" }] } } } }));
    const read = await readHostDraft("task-a");
    expect(read.draft).toEqual({ text: "正文", references: [reference] });
    expect(read.error).toContain("已跳过 2 项无法读取的引用");
  });

  it("refuses an over-long stored text instead of truncating it into the composer", async () => {
    bridge((op) => ({ ok: true, payload: { workspaceId: "w", taskId: "task-a", op, payload: { sessionId: "main",
      draft: { text: "中".repeat(5462), updatedAt: "2026-10-19T00:00:00Z" } } } }));
    const read = await readHostDraft("task-a");
    expect(read.draft).toEqual({ text: "", references: [] });
    expect(read.error).toContain("超过 16 KiB");
  });
});

describe("writing the draft back to the Host", () => {
  it("sends the text and the references together, and reports success as null", async () => {
    const taskOp = bridge((op) => ({ ok: true, payload: { workspaceId: "w", taskId: "task-a", op, payload: { sessionId: "main" } } }));
    expect(await saveHostDraft("task-a", { text: "草稿", references: [reference] })).toBeNull();
    expect(taskOp).toHaveBeenCalledWith("task-a", "task/saveDraft", { sessionId: "main", text: "草稿", references: [reference] });
  });

  it("saves an emptied composer without inventing an empty reference list", async () => {
    const taskOp = bridge((op) => ({ ok: true, payload: { workspaceId: "w", taskId: "task-a", op, payload: { sessionId: "main" } } }));
    expect(await saveHostDraft("task-a", { text: "", references: [] })).toBeNull();
    expect(taskOp).toHaveBeenCalledWith("task-a", "task/saveDraft", { sessionId: "main", text: "" });
  });

  it("refuses over-long text locally, without calling the Host at all", async () => {
    const taskOp = bridge(() => ({ ok: true, payload: {} }));
    const error = await saveHostDraft("task-a", { text: "中".repeat(5462), references: [] });
    expect(error).toContain("文字超过 16 KiB");
    expect(taskOp).not.toHaveBeenCalled();
    expect(MAX_DRAFT_BYTES).toBe(16_384);
  });

  it("quotes the Host's own refusal instead of claiming the draft was saved", async () => {
    bridge(() => ({ ok: false, error: "invalid-payload: task/saveDraft.references[0].label must be a non-empty string" }));
    const error = await saveHostDraft("task-a", { text: "草稿", references: [reference] });
    expect(error).toContain("草稿未保存");
    expect(error).toContain("invalid-payload: task/saveDraft.references[0].label");
    expect(error).toContain("仍可编辑");
  });
});

describe("draftFromHost shape rules", () => {
  it("accepts the documented draft shape and nothing else", () => {
    expect(draftFromHost({ draft: { text: "t", updatedAt: "now", references: [reference] } })).toEqual({ draft: { text: "t", references: [reference] }, skipped: 0, error: null });
    expect(draftFromHost({ draft: null })).toEqual({ draft: null, skipped: 0, error: null });
    // An envelope without `draft` is not "no draft": it is an unreadable answer.
    expect(draftFromHost({}).error).toContain("Host 未上报草稿");
    expect(draftFromHost({ draft: { text: 42 } }).error).toContain("Host 上报的草稿不可读取");
  });
});
