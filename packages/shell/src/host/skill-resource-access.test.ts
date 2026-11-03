/**
 * [Pencil T16] #151: the Skills resource decision itself, against real dirs.
 *
 * The broker suite proves the capability end-to-end; this file pins the pure
 * decision's named outcomes (grant / disabled / missing / unreadable / escape /
 * not-a-source) without any tool plumbing, so a later refactor of the broker
 * cannot quietly relax one of them.
 */

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decideSkillResourceRead } from "./skill-resource-access.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try { chmodSync(root, 0o700); } catch { /* gone */ }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function fixture(): { root: string; source: string; appDir: string; configFile: string } {
  const root = mkdtempSync(join(tmpdir(), "pidock-skill-access-"));
  roots.push(root);
  const source = join(root, "skills");
  const appDir = join(root, "app");
  mkdirSync(join(source, "pdf-tools", "references"), { recursive: true });
  mkdirSync(appDir);
  writeFileSync(join(source, "pdf-tools", "SKILL.md"), "---\nname: pdf-tools\ndescription: PDFs.\n---\n");
  writeFileSync(join(source, "pdf-tools", "references", "format.md"), "format\n");
  const configFile = join(appDir, "skill-sources.json");
  writeFileSync(configFile, JSON.stringify({ version: 1, sources: [{ id: "src-aaaa1111", path: source, enabled: true }] }));
  return { root, source, appDir, configFile };
}

const skillFile = (source: string): string => join(source, "pdf-tools", "SKILL.md");

describe("skill resource decision", () => {
  it("grants an enabled source's own file and a relative resource", () => {
    const { source, configFile } = fixture();
    // `real` is the fully resolved path (macOS `/var` -> `/private/var`), exactly
    // what the broker hands in from its link-chain resolver.
    const file = skillFile(source);
    expect(decideSkillResourceRead(configFile, { lexical: file, real: realpathSync(file) }))
      .toMatchObject({ kind: "grant", sourceId: "src-aaaa1111", sourcePath: source });
    const resource = join(source, "pdf-tools", "references", "format.md");
    expect(decideSkillResourceRead(configFile, { lexical: resource, real: realpathSync(resource) })).toMatchObject({ kind: "grant" });
  });

  it("refuses a path that resolves outside its source and never follows the link", () => {
    const { root, source, configFile } = fixture();
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    symlinkSync(outside, join(source, "link"), "dir");
    const lexical = join(source, "link", "secret.txt");
    const real = join(outside, "secret.txt");
    expect(decideSkillResourceRead(configFile, { lexical, real }))
      .toMatchObject({ kind: "refused", code: "tool-refused:skill-source-escape" });
  });

  it("refuses a disabled source and does not fall back to a nested enabled one", () => {
    const { source, configFile } = fixture();
    mkdirSync(join(source, "nested"));
    writeFileSync(join(source, "nested", "note.md"), "note\n");
    writeFileSync(configFile, JSON.stringify({ version: 1, sources: [
      { id: "src-bbbb2222", path: source, enabled: false },
      { id: "src-cccc3333", path: join(source, "nested"), enabled: true },
    ] }));
    const lexical = join(source, "nested", "note.md");
    expect(decideSkillResourceRead(configFile, { lexical, real: lexical }))
      .toMatchObject({ kind: "refused", code: "tool-refused:skill-source-disabled" });
  });

  it("names a missing source, and treats a removed source as not-a-source", () => {
    const { root, configFile } = fixture();
    const gone = join(root, "gone");
    writeFileSync(configFile, JSON.stringify({ version: 1, sources: [{ id: "src-dddd4444", path: gone, enabled: true }] }));
    const lexical = join(gone, "pdf-tools", "SKILL.md");
    expect(decideSkillResourceRead(configFile, { lexical, real: lexical }))
      .toMatchObject({ kind: "refused", code: "tool-refused:skill-source-missing" });

    writeFileSync(configFile, JSON.stringify({ version: 1, sources: [] }));
    expect(decideSkillResourceRead(configFile, { lexical, real: lexical })).toBeNull();
  });

  it("names an unreadable source instead of an empty grant", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return; // chmod is not a boundary here
    const { root, source, configFile } = fixture();
    // The failure this names is "the source root cannot be resolved": its parent
    // directory denies the traversal, which is a real EACCES, not an empty folder.
    const holder = join(root, "holder");
    mkdirSync(holder);
    const inner = join(holder, "skills");
    renameSync(source, inner);
    writeFileSync(configFile, JSON.stringify({ version: 1, sources: [{ id: "src-aaaa1111", path: inner, enabled: true }] }));
    chmodSync(holder, 0o000);
    const file = join(inner, "pdf-tools", "SKILL.md");
    try {
      expect(decideSkillResourceRead(configFile, { lexical: file, real: file }))
        .toMatchObject({ kind: "refused", code: "tool-refused:skill-source-unreadable" });
    } finally {
      chmodSync(holder, 0o700);
    }
  });

  it("treats an absent/invalid document and an outside spelling as no grant", () => {
    const { root, source, configFile } = fixture();
    const file = skillFile(source);
    writeFileSync(configFile, "{ not json");
    expect(decideSkillResourceRead(configFile, { lexical: file, real: file })).toBeNull();
    expect(decideSkillResourceRead(undefined, { lexical: file, real: file })).toBeNull();
    // A path whose real location is inside the source but whose spelling is not
    // is never a Skills request: the task rule still owns it.
    writeFileSync(configFile, JSON.stringify({ version: 1, sources: [{ id: "src-aaaa1111", path: source, enabled: true }] }));
    const outsideLink = join(root, "task-link");
    symlinkSync(source, outsideLink, "dir");
    const viaLink = join(outsideLink, "pdf-tools", "SKILL.md");
    expect(decideSkillResourceRead(configFile, { lexical: viaLink, real: file })).toBeNull();
  });
});
