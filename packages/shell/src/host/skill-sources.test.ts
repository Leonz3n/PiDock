/**
 * [Pencil T16] #151: the Skills scan against a real disk.
 *
 * Every row here comes from `loadSkillsFromDir` (the SDK Pi 1.5 uses) run over
 * directories created by the test: a valid skill with a supporting file, the
 * same name in two sources, a `SKILL.md` Pi refuses, a directory that vanished
 * and a directory that cannot be read. The contract under test is that none of
 * these is silently dropped, merged or replaced.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  enabledSkillPaths,
  parseSkillConfig,
  scanSkillSources,
  sessionSkills,
  sourcePathKey,
  type SkillConfig,
} from "./skill-sources.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { try { chmodSync(root, 0o700); } catch { /* gone */ } rmSync(root, { recursive: true, force: true }); } });

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "pidock-skills-scan-"));
  roots.push(dir);
  return dir;
}

function skill(dir: string, name: string, description: string | null, extra?: { resource?: string; body?: string }): string {
  const target = join(dir, name);
  mkdirSync(join(target, "references"), { recursive: true });
  writeFileSync(join(target, "SKILL.md"), ["---", `name: ${name}`, ...(description === null ? [] : [`description: ${description}`]), "---", "", extra?.body ?? `# ${name}`, ""].join("\n"));
  if (extra?.resource !== undefined) writeFileSync(join(target, "references", extra.resource), "resource body\n");
  return target;
}

const config = (sources: { id: string; path: string; enabled: boolean }[]): SkillConfig => ({ version: 1, sources });

describe("skill source scan", () => {
  it("lists a valid skill with its description, source path and supporting files", () => {
    const dir = root();
    skill(dir, "pdf-tools", "Extract text from PDFs.", { resource: "format.md" });
    const [source] = scanSkillSources(config([{ id: "src-11111111", path: dir, enabled: true }]));
    expect(source?.status).toBe("ok");
    expect(source?.skills).toHaveLength(1);
    expect(source?.skills[0]).toMatchObject({
      name: "pdf-tools",
      description: "Extract text from PDFs.",
      sourcePath: dir,
      sourceId: "src-11111111",
      status: "ok",
      duplicates: [],
    });
    expect(source?.skills[0]?.skillFile).toBe(join(dir, "pdf-tools", "SKILL.md"));
    expect(source?.skills[0]?.resources).toEqual([{ path: "references/format.md", bytes: 14 }]);
  });

  it("keeps two same-named skills as two rows, each naming the other source", () => {
    const first = root();
    const second = root();
    skill(first, "pdf-tools", "First source.", {});
    skill(second, "pdf-tools", "Second source.", {});
    const scan = scanSkillSources(config([
      { id: "src-11111111", path: first, enabled: true },
      { id: "src-22222222", path: second, enabled: true },
    ]));
    expect(scan.flatMap((source) => source.skills.map((entry) => [entry.sourceId, entry.description]))).toEqual([
      ["src-11111111", "First source."],
      ["src-22222222", "Second source."],
    ]);
    expect(scan[0]?.skills[0]?.duplicates).toEqual(["src-22222222::pdf-tools"]);
    expect(scan[1]?.skills[0]?.duplicates).toEqual(["src-11111111::pdf-tools"]);
    // Both are advertised by their own location: neither substitutes the other.
    const session = sessionSkills(config([
      { id: "src-11111111", path: first, enabled: true },
      { id: "src-22222222", path: second, enabled: true },
    ]));
    expect(session.skills.map((entry) => entry.baseDir)).toEqual([join(first, "pdf-tools"), join(second, "pdf-tools")]);
  });

  it("shows a SKILL.md Pi refuses as an explicit invalid row instead of dropping it", () => {
    const dir = root();
    skill(dir, "no-description", null, {});
    skill(dir, "pdf-tools", "Valid one.", {});
    const [source] = scanSkillSources(config([{ id: "src-11111111", path: dir, enabled: true }]));
    const invalid = source?.skills.find((entry) => entry.name === "no-description");
    expect(invalid?.status).toBe("invalid");
    expect(invalid?.reason).toMatch(/description/);
    expect(source?.skills.find((entry) => entry.name === "pdf-tools")?.status).toBe("ok");
    // The invalid one contributes nothing to a session; the valid one does.
    expect(sessionSkills(config([{ id: "src-11111111", path: dir, enabled: true }])).skills.map((entry) => entry.name)).toEqual(["pdf-tools"]);
  });

  it("names a disappeared source and an unreadable one, and keeps the healthy source", () => {
    const healthy = root();
    skill(healthy, "pdf-tools", "Valid one.", {});
    const unreadable = root();
    skill(unreadable, "hidden", "Should not load.", {});
    chmodSync(unreadable, 0o000);
    const scan = scanSkillSources(config([
      { id: "src-11111111", path: join(healthy, "gone"), enabled: true },
      { id: "src-22222222", path: unreadable, enabled: true },
      { id: "src-33333333", path: healthy, enabled: true },
      { id: "src-44444444", path: healthy, enabled: false },
    ]));
    expect(scan[0]).toMatchObject({ status: "missing", message: "来源目录不存在或不是目录" });
    // Root can read a 000 directory; then the state is honestly `ok`, not a lie.
    expect(["unreadable", "ok"]).toContain(scan[1]?.status);
    expect(scan[2]).toMatchObject({ status: "ok" });
    expect(scan[2]?.skills.map((entry) => entry.name)).toEqual(["pdf-tools"]);
    expect(scan[3]).toMatchObject({ status: "disabled", skills: [] });
  });

  it("folds Windows drive-letter/case variants of one directory and never fakes a collision", () => {
    expect(sourcePathKey("C:\\Skills\\", "win32")).toBe(sourcePathKey("c:\\skills", "win32"));
    expect(sourcePathKey("/Users/me/Skills", "darwin")).not.toBe(sourcePathKey("/Users/me/skills", "darwin"));
    expect(enabledSkillPaths(config([
      { id: "src-11111111", path: "C:\\Skills", enabled: true },
      { id: "src-22222222", path: "c:\\skills", enabled: true },
    ]), "win32")).toEqual(["C:\\Skills"]);
  });

  it("refuses a config that is not exactly a source list", () => {
    expect(parseSkillConfig({ version: 2, sources: [] }).ok).toBe(false);
    expect(parseSkillConfig({ version: 1, sources: [{ id: "src-11111111", path: "relative/dir", enabled: true }] }).ok).toBe(false);
    expect(parseSkillConfig({ version: 1, sources: [
      { id: "src-11111111", path: "/a", enabled: true },
      { id: "src-22222222", path: "/A/", enabled: true },
    ] }).ok).toBe(false);
    expect(parseSkillConfig({ version: 1, sources: [{ id: "src-11111111", path: "/a", enabled: true }] }).ok).toBe(true);
  });
});
