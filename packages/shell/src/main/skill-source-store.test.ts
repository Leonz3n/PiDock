/**
 * [Pencil T16] #151: the app-private Skills source list survives a restart,
 * keeps its order/ids/enabled flags, and never silently resets a document it
 * cannot read.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillSourceStore } from "./skill-source-store.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function app(): { userData: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), "pidock-skills-store-"));
  roots.push(root);
  const userData = join(root, "userData");
  const source = join(root, "skills");
  mkdirSync(join(source, "pdf-tools"), { recursive: true });
  mkdirSync(userData, { recursive: true });
  writeFileSync(join(source, "pdf-tools", "SKILL.md"), "---\nname: pdf-tools\ndescription: Extract PDFs.\n---\n");
  return { userData, source };
}

describe("skill source store", () => {
  it("persists sources and their enabled state across a restart", () => {
    const { userData, source } = app();
    const store = new SkillSourceStore(userData);
    expect(store.view()).toMatchObject({ state: "empty", sources: [] });
    const added = store.add(source);
    expect(added.ok).toBe(true);
    const id = added.ok ? added.source.id : "";
    expect(store.setEnabled(id, false).ok).toBe(true);

    // A fresh instance = the next app launch: same document, same row.
    const restarted = new SkillSourceStore(userData);
    const view = restarted.view();
    expect(view.state).toBe("ok");
    expect(view.sources).toHaveLength(1);
    expect(view.sources[0]).toMatchObject({ id, path: source, enabled: false, status: "disabled" });
    expect(restarted.sessionPaths()).toEqual([]);
    expect(restarted.setEnabled(id, true).ok).toBe(true);
    expect(new SkillSourceStore(userData).sessionPaths()).toEqual([source]);
    // No temp file is left behind and the document is the only write.
    expect(readdirSync(userData).filter((name) => name.includes(".tmp"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(userData, "skill-sources.json"), "utf8"))).toMatchObject({ version: 1 });
    expect(statSync(join(userData, "skill-sources.json")).mode & 0o077).toBe(0);
  });

  it("refuses the same real directory twice and keeps the rest of the list", () => {
    const { userData, source } = app();
    const store = new SkillSourceStore(userData);
    expect(store.add(source).ok).toBe(true);
    expect(store.add(`${source}/`)).toMatchObject({ ok: false });
    expect(store.view().sources).toHaveLength(1);
  });

  it("reports an unreadable document by name and never overwrites it", () => {
    const { userData, source } = app();
    const file = join(userData, "skill-sources.json");
    writeFileSync(file, "{ not json");
    const store = new SkillSourceStore(userData);
    expect(store.view()).toMatchObject({ state: "invalid", sources: [] });
    expect(store.view().message).toBe("配置不是合法 JSON");
    expect(store.add(source)).toMatchObject({ ok: false, error: expect.stringContaining("skill-config-invalid") });
    expect(readFileSync(file, "utf8")).toBe("{ not json");
    expect(store.sessionPaths()).toEqual([]);
  });

  it("removes a source without touching its directory", () => {
    const { userData, source } = app();
    const store = new SkillSourceStore(userData);
    const added = store.add(source);
    const id = added.ok ? added.source.id : "";
    expect(store.remove(id).ok).toBe(true);
    expect(store.view().sources).toEqual([]);
    expect(statSync(join(source, "pdf-tools", "SKILL.md")).isFile()).toBe(true);
  });
});
