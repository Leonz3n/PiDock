import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskWorkspaceHost } from "./task-host.js";
import { diskTaskStore } from "./task-store.js";

/**
 * [#117 第 7 项 / 业主定 A] The desktop draft lives in the Host, and the
 * references travel with it. For the composer to show the draft again after a
 * restart, the Host must be able to READ the draft back - `task/sessionStates`
 * only reports `hasDraft`, which says "there is one" and not "this is it".
 *
 * The second instance below is a fresh `TaskWorkspaceHost` over the same task
 * folder: that is the restart the renderer will see.
 */
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function taskDir() {
  const dir = mkdtempSync(join(tmpdir(), "pidock-draft-")); dirs.push(dir); return dir;
}

const reference = {
  id: "task-task-file:repo-a:invoice.md",
  kind: "file",
  label: "repo-a/invoice.md",
  detail: "repo-a · 任务代码引用",
  sourceKind: "worktree",
};

it("reads back the draft it stored, references included, from a fresh Host over the same folder", () => {
  const dir = taskDir();
  const first = new TaskWorkspaceHost("task-a", dir, diskTaskStore);
  first.saveDraft("main", { text: "请看这两个文件", references: [reference], skillSource: "review" });
  expect(first.readDraft("main")).toMatchObject({ text: "请看这两个文件", references: [reference], skillSource: "review" });

  // The restart: a new Host object, nothing in memory, the same task folder.
  const restarted = new TaskWorkspaceHost("task-a", dir, diskTaskStore);
  expect(restarted.readDraft("main")).toMatchObject({ text: "请看这两个文件", references: [reference] });
});

it("returns null for a session that never had a draft, without creating one", () => {
  const dir = taskDir();
  const host = new TaskWorkspaceHost("task-a", dir, diskTaskStore);
  expect(host.readDraft("main")).toBeNull();
  // A read must not materialize a session or a draft file.
  expect(host.sessionIds()).toEqual([]);
  expect(readdirSync(dir)).toEqual([]);
});

it("reports the cleared draft as absent instead of an empty record", () => {
  const dir = taskDir();
  const host = new TaskWorkspaceHost("task-a", dir, diskTaskStore);
  host.saveDraft("main", { text: "草稿" });
  host.clearDraft("main");
  expect(host.readDraft("main")).toBeNull();
  const restarted = new TaskWorkspaceHost("task-a", dir, diskTaskStore);
  expect(restarted.readDraft("main")).toBeNull();
});
