/**
 * [Pencil T16] #151: the read-only Skills resource grant at the ONE enforcement
 * point (`SdkAgentToolBroker`).
 *
 * The gap this suite pins: a source the user added through 能力管理 → Skills is
 * usually outside the task folder, so the advertised `SKILL.md` (and the
 * relative files its instructions reference) was refused by task confinement and
 * a real session could not use the rows the pane showed.
 *
 * Every case uses real temporary directories, the real app-private document and
 * the real broker: nothing here stubs a filesystem. What is NOT granted is
 * asserted in the same suite (write/command/listing outside the task, disabled
 * and removed sources, symlink escape, in-task behaviour unchanged).
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SdkAgentToolBroker, type SdkAgentToolChannel, type SdkAgentToolScope } from "./sdk-agent-tool-broker.js";
import type { SdkAgentToolOutcome } from "./sdk-agent-tool-contract.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

const SKILL_BODY = "---\nname: pdf-tools\ndescription: Extract text from PDFs.\n---\n\nRead references/format.md.\n";
const RESOURCE_BODY = "FORMAT-MARKER-7Q\n";
const OUTSIDE_SECRET = "outside the source\n";

function realpathDeep(path: string): string {
  const { existsSync, realpathSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const { basename, dirname } = process.getBuiltinModule("node:path") as typeof import("node:path");
  const suffix: string[] = [];
  let current = path.trim();
  while (current.length > 0 && !existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    suffix.unshift(basename(current));
    current = parent;
  }
  let resolved = current;
  try { resolved = realpathSync(current); } catch { resolved = current; }
  return suffix.length > 0 ? `${resolved.replace(/[\\/]+$/, "")}/${suffix.join("/")}` : resolved;
}

interface Fixture {
  root: string;
  taskDir: string;
  /** The external source directory (outside the task). */
  source: string;
  skillDir: string;
  /** A directory outside both the task and the source. */
  outside: string;
  appDir: string;
  configFile: string;
  broker: SdkAgentToolBroker;
  call(tool: string, args: Record<string, unknown>): Promise<SdkAgentToolOutcome>;
  writeConfig(enabled: boolean): void;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pidock-skill-read-"));
  roots.push(root);
  // The task root holds ONLY tasks, like production: an added source is elsewhere.
  const tasksRoot = join(root, "tasks");
  const taskDir = join(tasksRoot, "task");
  const source = join(root, "external-skills");
  const skillDir = join(source, "pdf-tools");
  const outside = join(root, "outside");
  const appDir = join(root, "app");
  for (const dir of [taskDir, join(taskDir, "repo"), join(skillDir, "references"), outside, appDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), SKILL_BODY);
  writeFileSync(join(skillDir, "references", "format.md"), RESOURCE_BODY);
  writeFileSync(join(outside, "secret.txt"), OUTSIDE_SECRET);
  // A link inside the source that resolves outside it: the escape the real-path
  // containment must refuse by name.
  symlinkSync(outside, join(source, "escape"), "dir");
  const configFile = join(appDir, "skill-sources.json");
  const writeConfig = (enabled: boolean): void => {
    writeFileSync(configFile, JSON.stringify({ version: 1, sources: [{ id: "src-aaaa1111", path: source, enabled }] }));
  };
  writeConfig(true);
  const scope: SdkAgentToolScope = {
    taskDir, taskRoot: tasksRoot, worktrees: [{ repoDir: "repo", path: join(taskDir, "repo") }],
    primaryCheckouts: [], assertProtected: () => {},
  };
  const channel: SdkAgentToolChannel = {
    currentPermission: "auto",
    previewGate: () => ({ verdict: "allow" }),
    gate: () => ({ verdict: "allow" }),
    consumeApproval: () => true,
    reject: () => {},
    snapshot: () => ({ approvals: [] }),
  };
  const broker = new SdkAgentToolBroker({
    sessionKnown: (sessionId) => sessionId === "main",
    channel: () => channel,
    persist: () => {},
    write: { claimWrite: () => ({ ok: true, claimId: "claim-1" }), releaseWrite: () => {} },
    scope: () => scope,
    resolveRealPath: realpathDeep,
    skillSourcesFile: () => configFile,
    closing: () => false,
  });
  return {
    root, taskDir, source, skillDir, outside, appDir, configFile, broker, writeConfig,
    call: (tool, args) => broker.call("main", { tool, args }),
  };
}

describe("Skills resource read through the broker", () => {
  it("reads SKILL.md and a relative resource of an external, enabled source", async () => {
    const f = fixture();
    const skill = await f.call("fs.read", { path: join(f.skillDir, "SKILL.md") });
    expect(skill).toMatchObject({ outcome: "ok" });
    expect(skill.text).toContain("Read references/format.md.");

    const resource = await f.call("fs.read", { path: join(f.skillDir, "references", "format.md") });
    expect(resource).toMatchObject({ outcome: "ok" });
    expect(resource.text).toContain("FORMAT-MARKER-7Q");

    // The bounded reader still applies (offset/limit), and a missing file is a
    // named refusal - never a silent substitution of another file.
    expect((await f.call("fs.read", { path: join(f.skillDir, "SKILL.md"), offset: 1, limit: 1 })).text).toContain("1\t---");
    expect(await f.call("fs.read", { path: join(f.skillDir, "references", "absent.md") }))
      .toMatchObject({ outcome: "refused", code: "tool-refused:not-found" });
  });

  it("refuses a symlink inside the source that resolves outside it, by name", async () => {
    const f = fixture();
    const escaped = await f.call("fs.read", { path: join(f.source, "escape", "secret.txt") });
    expect(escaped).toMatchObject({ outcome: "refused", code: "tool-refused:skill-source-escape" });
    expect(escaped.text).not.toContain(OUTSIDE_SECRET);
    // The escape link is not a side door into another registered source either:
    // the lexical spelling is what selects the source, and the real path decides.
    expect(await f.call("fs.read", { path: join(f.outside, "secret.txt") }))
      .toMatchObject({ outcome: "refused", code: "tool-refused:out-of-scope" });
  });

  it("withdraws the capability immediately when the source is disabled or removed", async () => {
    const f = fixture();
    expect(await f.call("fs.read", { path: join(f.skillDir, "SKILL.md") })).toMatchObject({ outcome: "ok" });

    // Disabled: the document is re-read on every call, so the very next read is
    // refused by name instead of serving a stale grant.
    f.writeConfig(false);
    expect(await f.call("fs.read", { path: join(f.skillDir, "SKILL.md") }))
      .toMatchObject({ outcome: "refused", code: "tool-refused:skill-source-disabled" });
    expect(await f.call("fs.read", { path: join(f.skillDir, "references", "format.md") }))
      .toMatchObject({ outcome: "refused", code: "tool-refused:skill-source-disabled" });

    // Re-enabled: usable again, without restarting anything.
    f.writeConfig(true);
    expect(await f.call("fs.read", { path: join(f.skillDir, "SKILL.md") })).toMatchObject({ outcome: "ok" });

    // Removed: no source contains the path any more, so it falls back to the
    // task rule (out-of-scope) - never to another source.
    writeFileSync(f.configFile, JSON.stringify({ version: 1, sources: [] }));
    expect(await f.call("fs.read", { path: join(f.skillDir, "SKILL.md") }))
      .toMatchObject({ outcome: "refused", code: "tool-refused:out-of-scope" });
  });

  it("names a missing source and never falls through to a nested enabled source", async () => {
    const f = fixture();
    // A registered source whose directory vanished.
    const gone = join(f.root, "gone-skills");
    writeFileSync(f.configFile, JSON.stringify({ version: 1, sources: [
      { id: "src-bbbb2222", path: gone, enabled: true },
      { id: "src-aaaa1111", path: f.source, enabled: true },
    ] }));
    expect(await f.call("fs.read", { path: join(gone, "demo", "SKILL.md") }))
      .toMatchObject({ outcome: "refused", code: "tool-refused:skill-source-missing" });

    // Overlapping sources, outer disabled and inner enabled: the first source
    // that contains the requested spelling answers. It must not silently use the
    // inner source's grant ("no fallback to another source").
    mkdirSync(join(f.source, "nested"), { recursive: true });
    writeFileSync(join(f.source, "nested", "note.md"), "nested resource\n");
    writeFileSync(f.configFile, JSON.stringify({ version: 1, sources: [
      { id: "src-cccc3333", path: f.source, enabled: false },
      { id: "src-dddd4444", path: join(f.source, "nested"), enabled: true },
    ] }));
    expect(await f.call("fs.read", { path: join(f.source, "nested", "note.md") }))
      .toMatchObject({ outcome: "refused", code: "tool-refused:skill-source-disabled" });
  });

  it("grants nothing when the document is absent/invalid or no source is registered", async () => {
    const f = fixture();
    writeFileSync(f.configFile, "{ not json");
    expect(await f.call("fs.read", { path: join(f.skillDir, "SKILL.md") }))
      .toMatchObject({ outcome: "refused", code: "tool-refused:out-of-scope" });
    rmSync(f.configFile, { force: true });
    expect(await f.call("fs.read", { path: join(f.skillDir, "SKILL.md") }))
      .toMatchObject({ outcome: "refused", code: "tool-refused:out-of-scope" });
  });

  it("keeps write, command and directory listing outside the task forbidden", async () => {
    const f = fixture();
    // Reads of the source are granted...
    expect(await f.call("fs.read", { path: join(f.skillDir, "SKILL.md") })).toMatchObject({ outcome: "ok" });

    // ...but the grant is read-only and does not widen any other tool.
    const written = await f.call("fs.write", { path: join(f.skillDir, "planted.md"), content: "planted" });
    expect(written).toMatchObject({ outcome: "refused", code: "tool-refused:out-of-scope" });
    expect(await f.call("fs.search", { path: f.source }))
      .toMatchObject({ outcome: "refused", code: "tool-refused:out-of-scope" });
    expect(await f.call("fs.search", { path: f.source, pattern: "FORMAT" }))
      .toMatchObject({ outcome: "refused", code: "tool-refused:out-of-scope" });
    const command = await f.call("exec.run", { command: `cat "${join(f.skillDir, "SKILL.md")}"` });
    expect(command).toMatchObject({ outcome: "refused", code: "tool-refused:out-of-scope" });
    // A directory target is refused, not listed.
    expect(await f.call("fs.read", { path: f.source }))
      .toMatchObject({ outcome: "refused", code: "tool-refused:invalid-target" });
  });

  it("keeps in-task reads and listing exactly as they were", async () => {
    const f = fixture();
    writeFileSync(join(f.taskDir, "notes.txt"), "task content\n");
    writeFileSync(join(f.taskDir, "repo", "file.txt"), "repo content\n");

    const read = await f.call("fs.read", { path: "notes.txt" });
    expect(read).toMatchObject({ outcome: "ok" });
    expect(read.text).toContain("task content");
    const listed = await f.call("fs.search", { path: "repo" });
    expect(listed).toMatchObject({ outcome: "ok" });
    expect(listed.text).toContain("file.txt");
    // An in-task read never depends on the Skills document.
    writeFileSync(f.configFile, "{ not json");
    expect(await f.call("fs.read", { path: "repo/file.txt" })).toMatchObject({ outcome: "ok" });
  });

  it("does not treat a task link into a source as a skill resource", async () => {
    const f = fixture();
    symlinkSync(f.source, join(f.taskDir, "skills-link"), "dir");
    // The request's lexical spelling is inside the task, so the task rules decide
    // and the real path is outside: out-of-scope, not a grant.
    expect(await f.call("fs.read", { path: join(f.taskDir, "skills-link", "pdf-tools", "SKILL.md") }))
      .toMatchObject({ outcome: "refused", code: "tool-refused:out-of-scope" });
  });
});
