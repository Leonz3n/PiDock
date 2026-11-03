/**
 * [Pencil T16] #151: the Skills channel accepts exactly its named ops and never
 * a config document, a relative path or an extra field. `open` resolves the
 * row's own file from main's scan, so the page never names a path and a source
 * that is off/removed loses the file immediately.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { performSkillSourcesOperation } from "./skill-sources-ipc.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function app(): { userData: string; source: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "pidock-skills-ipc-"));
  roots.push(root);
  const userData = join(root, "userData");
  const source = join(root, "skills");
  mkdirSync(join(source, "demo"), { recursive: true });
  mkdirSync(userData, { recursive: true });
  writeFileSync(join(source, "demo", "SKILL.md"), "---\nname: demo\ndescription: A demo skill.\n---\n");
  writeFileSync(join(userData, "file.txt"), "not a directory");
  return { userData, source, file: join(userData, "file.txt") };
}

describe("skills op", () => {
  it("lists, adds, toggles and removes through one app-private document", () => {
    const { userData, source } = app();
    const empty = performSkillSourcesOperation({ op: "list" }, userData);
    expect(empty).toMatchObject({ ok: true, view: { state: "empty", sources: [] } });

    const added = performSkillSourcesOperation({ op: "add", path: source }, userData);
    expect(added.ok).toBe(true);
    const id = added.ok ? added.view.sources[0]!.id : "";
    expect(added.ok && added.view.sources[0]?.skills.map((skill) => skill.name)).toEqual(["demo"]);

    const off = performSkillSourcesOperation({ op: "setEnabled", id, enabled: false }, userData);
    expect(off.ok && off.view.sources[0]).toMatchObject({ id, enabled: false, status: "disabled" });

    const removed = performSkillSourcesOperation({ op: "remove", id }, userData);
    expect(removed.ok && removed.view.sources).toEqual([]);
  });

  it("refuses a missing/relative/file path by name instead of adding a broken row", () => {
    const { userData, source, file } = app();
    expect(performSkillSourcesOperation({ op: "add", path: "relative/dir" }, userData)).toMatchObject({ ok: false, error: "请添加绝对路径的本地目录" });
    expect(performSkillSourcesOperation({ op: "add", path: `${source}-gone` }, userData)).toMatchObject({ ok: false, error: "该目录不存在或不可访问" });
    expect(performSkillSourcesOperation({ op: "add", path: file }, userData)).toMatchObject({ ok: false, error: "该路径不是目录" });
  });

  it("opens a skill file from its own row and re-verifies the source per call", () => {
    const { userData, source } = app();
    const added = performSkillSourcesOperation({ op: "add", path: source }, userData);
    if (!added.ok) throw new Error(added.error);
    const row = added.view.sources[0]!;
    const key = row.skills[0]!.key;
    const opened = performSkillSourcesOperation({ op: "open", key }, userData);
    expect(opened).toMatchObject({ ok: true, open: join(source, "demo", "SKILL.md") });

    // A path is never accepted from the page: only the row key is.
    expect(performSkillSourcesOperation({ op: "open", key, path: join(source, "demo", "SKILL.md") }, userData))
      .toMatchObject({ ok: false, error: "Skills 操作包含多余字段" });
    expect(performSkillSourcesOperation({ op: "open", key: "../etc/passwd" }, userData))
      .toMatchObject({ ok: false });

    // Switched off: the scan has no such row any more, so nothing is opened.
    expect(performSkillSourcesOperation({ op: "setEnabled", id: row.id, enabled: false }, userData).ok).toBe(true);
    expect(performSkillSourcesOperation({ op: "open", key }, userData))
      .toMatchObject({ ok: false, error: "该技能来源已停用，重新启用后才能打开" });

    // Removed: the id no longer exists at all.
    expect(performSkillSourcesOperation({ op: "remove", id: row.id }, userData).ok).toBe(true);
    expect(performSkillSourcesOperation({ op: "open", key }, userData))
      .toMatchObject({ ok: false, error: "技能不存在或来源已被移除" });
  });

  it("refuses unknown ops, extra fields and malformed ids", () => {
    const { userData } = app();
    expect(performSkillSourcesOperation({ op: "load", path: "/a" }, userData)).toMatchObject({ ok: false, error: "未知的 Skills 操作" });
    expect(performSkillSourcesOperation({ op: "list", file: "/etc/passwd" }, userData)).toMatchObject({ ok: false, error: "Skills 操作包含多余字段" });
    expect(performSkillSourcesOperation({ op: "setEnabled", id: "../x", enabled: true }, userData)).toMatchObject({ ok: false, error: "来源标识无效" });
    expect(performSkillSourcesOperation({ op: "setEnabled", id: "src-11111111", enabled: "yes" }, userData)).toMatchObject({ ok: false, error: "启停状态必须是布尔值" });
    expect(performSkillSourcesOperation(null, userData)).toMatchObject({ ok: false });
  });
});
