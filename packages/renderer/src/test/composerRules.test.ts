import { describe, expect, it } from "vitest";
import {
  BUILTIN_COMMANDS,
  activeCompletionToken,
  checkDraftReference,
  commandAvailability,
  commandCandidates,
  describeReferenceChip,
  fileCandidates,
  resolveComposerKey,
  skillCandidates,
  suggestCommand,
} from "../data/composerRules";
import { createMemoryHost } from "../data/memoryHost";
import type { Capability, Reference } from "../data/types";

/**
 * [PiDock 13] (#16) renderer mirror of the shell composer rules. The shell
 * side is locked by `packages/shell/src/main/composer-*.test.ts`; this file
 * pins the mirror the input box actually uses, so candidates, keyboard
 * intent and draft-reference checks cannot drift from it.
 */
describe("composer rule mirror", () => {
  it("keeps emails, URLs, paths, code and env dollars literal", () => {
    expect(activeCompletionToken("联系 a@b.com", 11)).toBeNull();
    expect(activeCompletionToken("看 https://x.dev/a", 16)).toBeNull();
    expect(activeCompletionToken("路径 C:\\Users\\a", 12)).toBeNull();
    expect(activeCompletionToken("$HOME", 5)).toBeNull();
    expect(activeCompletionToken("`@sr`", 4)).toBeNull();
    expect(activeCompletionToken("\\$skill", 7)).toBeNull();
    expect(activeCompletionToken("@sr", 3)).toEqual({ symbol: "@", query: "sr", start: 0, end: 3 });
    // `/` only opens the command list at the message start.
    expect(activeCompletionToken("/mo", 3)).toEqual({ symbol: "/", query: "mo", start: 0, end: 3 });
    expect(activeCompletionToken("先说明 /mo", 8)).toBeNull();
  });

  it("resolves keyboard intent without sending on candidate confirm", () => {
    expect(resolveComposerKey({ key: "Tab", candidateCount: 2 })).toBe("confirm-candidate");
    expect(resolveComposerKey({ key: "Enter", candidateCount: 2 })).toBe("confirm-candidate");
    expect(resolveComposerKey({ key: "Escape", candidateCount: 2 })).toBe("close-candidate");
    expect(resolveComposerKey({ key: "ArrowDown", candidateCount: 2 })).toBe("move-candidate-down");
    expect(resolveComposerKey({ key: "Enter" })).toBe("send");
    expect(resolveComposerKey({ key: "Enter", shift: true })).toBe("newline");
    expect(resolveComposerKey({ key: "Enter", composing: true })).toBe("ignore-composition");
  });

  it("lists task worktree files and plain-directory links, ignoring build output", () => {
    const rows = fileCandidates(
      {
        files: [
          { path: "front-monorepo/src/api.ts", status: "modified" },
          { path: "front-monorepo/node_modules/left-pad/index.js", status: "added" },
          { path: "bff-service/src/api.ts", status: "modified" },
        ],
        directories: [{ id: "dir-docs", name: "文档", path: "/Users/x/docs", linkName: "release-docs" }],
      },
      "api",
    );
    expect(rows.map((row) => row.label)).toEqual(["bff-service/src/api.ts", "front-monorepo/src/api.ts"]);
    expect(rows[0].sourceKind).toBe("worktree");
    const plain = fileCandidates(
      { files: [], directories: [{ id: "dir-docs", name: "文档", path: "/Users/x/docs", linkName: "release-docs" }] },
      "release",
    )[0];
    expect(plain).toMatchObject({ kind: "directory", sourceKind: "plain-dir", sourceId: "dir-docs" });
    expect(plain.detail).toContain("无 Git 版本");
  });

  it("keeps duplicated skill names as source-distinct candidates", () => {
    const capabilities: Capability[] = [
      { id: "cap-1", kind: "skill", name: "code-review", source: "全局 pi/skills", scope: "全局", status: "enabled" },
      { id: "cap-5", kind: "skill", name: "code-review", source: "项目 · .pi/skills", scope: "本任务工作区", status: "enabled" },
      { id: "cap-2", kind: "skill", name: "off", source: "项目 · .pi/skills", scope: "本任务工作区", status: "disabled" },
    ];
    const rows = skillCandidates(capabilities, "code");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.detail)).toEqual(["全局 pi/skills · 全局 · 已启用技能", "项目 · .pi/skills · 本任务工作区 · 已启用技能"]);
    expect(skillCandidates(capabilities, "off")).toEqual([]);
  });

  it("groups the / menu, shows availability and corrects unknown entries", () => {
    const idle = { runState: "idle" as const, permission: "default" as const };
    const menu = commandCandidates(BUILTIN_COMMANDS, "", idle);
    expect(menu).toHaveLength(1);
    expect(menu[0].items.map((row) => row.label)).toEqual(["/new", "/model", "/compact", "/skills", "/session", "/usage", "/help"]);
    const busy = commandCandidates(BUILTIN_COMMANDS, "compact", { runState: "approval", permission: "default" });
    expect(busy[0].items[0]).toMatchObject({ availability: "waiting" });
    expect(commandAvailability(BUILTIN_COMMANDS[0], { runState: "running", permission: "default" })).toMatchObject({ availability: "waiting" });
    expect(
      commandAvailability(
        { name: "/summarize", category: "template", source: "项目模板", description: "摘要", kind: "template" },
        { runState: "running", permission: "default" },
      ),
    ).toMatchObject({ availability: "unavailable" });
    expect(
      commandAvailability(
        { name: "/summarize", category: "template", source: "项目模板", description: "摘要", kind: "template" },
        { runState: "idle", permission: "read" },
      ),
    ).toMatchObject({ availability: "unavailable" });
    expect(suggestCommand("/modle", BUILTIN_COMMANDS.map((command) => command.name))).toBe("/model");
  });

  it("marks a moved, stale or cross-task draft reference for re-selection", () => {
    const task = {
      id: "task-release",
      files: [{ path: "front-monorepo/src/api.ts", status: "modified" as const }],
      directories: [{ id: "dir-docs", name: "文档", path: "/Users/x/docs", linkName: "release-docs" }],
    };
    const ok: Reference = { id: "r1", kind: "file", label: "front-monorepo/src/api.ts", detail: "x", taskId: "task-release", sourceId: "front-monorepo", sourceKind: "worktree", relativePath: "src/api.ts" };
    expect(checkDraftReference(ok, task)).toEqual({ state: "ok" });
    expect(checkDraftReference({ ...ok, id: "r2", relativePath: "src/gone.ts" }, task)).toMatchObject({ code: "moved" });
    expect(checkDraftReference({ ...ok, id: "r3", sourceId: "bff-service" }, task)).toMatchObject({ code: "stale-source" });
    expect(checkDraftReference({ ...ok, id: "r4", relativePath: "../outside.ts" }, task)).toMatchObject({ code: "out-of-bounds" });
    expect(checkDraftReference({ ...ok, id: "r5", taskId: "task-other" }, task)).toMatchObject({ code: "cross-task" });
    // An attachment authorizes only itself and is never a source error.
    expect(checkDraftReference({ id: "r6", kind: "attachment", label: "shot.png", detail: "图片附件" }, task)).toEqual({ state: "ok" });
    expect(describeReferenceChip(ok)).toContain("估算");
    expect(describeReferenceChip(ok)).toContain("不计入实报 Token");
  });

  it("mirrors the same @ outcome the memory task produces", async () => {
    const host = createMemoryHost();
    const workspace = await host.getWorkspace();
    const task = (await host.getTask(workspace.tasks[0].id)) ?? workspace.tasks[0];
    const rows = fileCandidates(task, "");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.sourceKind === "worktree" || row.sourceKind === "plain-dir")).toBe(true);
  });
});
