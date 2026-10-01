import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, linkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { protectApplicationProfile } from "./protected-application-path.js";
import { TaskWorkspaceFiles, realWorkspaceFileReaders } from "./workspace-files.js";
import { TaskWorkspaceHost, memoryTaskStore } from "./task-host.js";
import { buildTaskDiskRecord } from "./task-store.js";
import { scanTaskServiceImportHints } from "./service-import.js";
const homes: string[] = [];
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pidock-profile-boundary-")); homes.push(home);
  const profile = join(home, "profile"), taskId = "task-abcdef12", taskDir = join(home, "tasks", taskId), repo = join(taskDir, "repo-a"), shared = join(home, "shared");
  mkdirSync(profile); mkdirSync(repo, { recursive: true }); mkdirSync(shared);
  writeFileSync(join(profile, "private.json"), "synthetic-profile-value"); writeFileSync(join(repo, "public.txt"), "public");
  const store = memoryTaskStore();
  const record = buildTaskDiskRecord({ taskId, name: "Protection", dirId: taskId, root: join(home, "tasks"), taskDir, branch: "task/main", remoteBranch: "main", baseCommit: "test", repos: ["repo-a"], now: "2026-01-01T00:00:00.000Z" });
  store.writeTask(taskDir, record);
  const protection = protectApplicationProfile(profile);
  const files = () => new TaskWorkspaceFiles(taskId, taskDir, store, realWorkspaceFileReaders, undefined, protection);
  const host = () => new TaskWorkspaceHost(taskId, taskDir, store, undefined, undefined, undefined, undefined, undefined, undefined, undefined, protection);
  return { home, profile, taskId, taskDir, repo, shared, store, record, protection, files, host };
}
it("refuses profile, descendants, ancestors and prospective descendants with no private path error text", () => {
  const f = fixture();
  for (const path of [f.profile, join(f.profile, "private.json"), join(f.profile, "missing", "new.json"), f.home, "relative", "", `${f.repo}\0private`]) {
    try { f.protection.assert(path); throw Error("expected refusal"); }
    catch (error) { expect(String(error)).toContain("protected-application-path"); expect(String(error)).not.toContain(f.profile); }
  }
  expect(() => f.protection.assert(f.repo)).not.toThrow(); expect(() => f.protection.assert(join(f.shared, "new", "file"))).not.toThrow();
  const lookalike = `${f.profile}-public`; mkdirSync(lookalike); expect(() => f.protection.assert(lookalike)).not.toThrow();
});
it("fails closed after the captured profile directory moves or is replaced", () => {
  const f = fixture(); renameSync(f.profile, `${f.profile}-old`); mkdirSync(f.profile);
  expect(() => f.protection.assert(f.repo)).toThrow("protected-application-path");
  expect(() => f.host()).toThrow("protected-application-path");
  expect(() => protectApplicationProfile(join(f.home, "missing-profile"))).toThrow("protected-application-path");
});
it("refuses protected checkout sources before returning provision or append plans", () => {
  const f = fixture(), host = f.host();
  expect(() => host.provision({ name: "bad", dirId: f.taskId, remoteBranch: "main", fetchedCommit: "test", mainCheckouts: { "repo-a": f.profile } })).toThrow("protected-application-path");
  expect(() => host.appendRepos({ repoSelections: [], fetchedCommits: {}, mainCheckouts: { "repo-b": f.profile }, takenPaths: [], branchesInUse: [] })).toThrow("protected-application-path");
  expect(f.store.readTask(f.taskDir)).toEqual(f.record);
});
it("allows ordinary file previews and source attribution unchanged", () => {
  const f = fixture(); expect(f.files().roots()).toHaveLength(1);
  expect(f.files().preview({ rootId: "repo-a", relative: "public.txt" }).ok).toBe(true);
  expect(f.files().tree({ rootId: "repo-a" }).ok).toBe(true);
});
it("refuses an old task record that directly registers protected or ancestor shared roots", () => {
  const f = fixture();
  for (const sourcePath of [f.profile, f.home]) {
    f.store.writeTask(f.taskDir, { ...f.record, dirLinks: [{ directoryId: "abcd1234", linkName: "dir-abcd1234", sourcePath, snapshotAt: f.record.createdAt }] });
    expect(() => f.files().roots()).toThrow("protected-application-path"); expect(() => f.host().sharedRoots()).toThrow("protected-application-path");
  }
});
describe.skipIf(process.platform === "win32")("real aliases and use-time checks", () => {
  it("refuses directory symlinks, profile aliases and dangling symlinks without lexical fallback", () => {
    const f = fixture(), alias = join(f.home, "profile-alias"), dangling = join(f.repo, "dangling");
    symlinkSync(f.profile, alias, "dir"); symlinkSync(join(f.home, "missing"), dangling);
    for (const path of [alias, join(alias, "new.json"), `${alias}/../profile/private.json`, `${f.repo}/./public.txt`, dangling, join(dangling, "new.json")]) expect(() => f.protection.assert(path)).toThrow();
    const profileAliasGuard = protectApplicationProfile(alias);
    expect(() => profileAliasGuard.assert(join(f.profile, "private.json"))).toThrow();
  });
  it("hides links to profile from tree and blocks preview, tool read/write and import scanning", () => {
    const f = fixture(); symlinkSync(f.profile, join(f.repo, "private"), "dir");
    const readers = { ...realWorkspaceFileReaders, readTextFile: vi.fn(realWorkspaceFileReaders.readTextFile), runGit: vi.fn(realWorkspaceFileReaders.runGit) };
    const files = new TaskWorkspaceFiles(f.taskId, f.taskDir, f.store, readers, undefined, f.protection);
    const tree = files.tree({ rootId: "repo-a" }); expect(tree.ok).toBe(true);
    if (tree.ok) expect(tree.tree.entries.map((entry) => entry.name)).not.toContain("private");
    expect(files.preview({ rootId: "repo-a", relative: "private/private.json" }).ok).toBe(false);
    expect(files.diff({ rootId: "repo-a", relative: "private/private.json" }).ok).toBe(false);
    expect(readers.readTextFile).not.toHaveBeenCalled(); expect(readers.runGit).not.toHaveBeenCalled();
    const host = f.host(); host.openSession("main", { providerId: "local", model: "test", permission: "auto" });
    for (const tool of ["fs.read", "fs.write"] as const) {
      const execute = vi.fn(); expect(() => host.sendMessage("main", "private", { tool, target: "repo-a/private/private.json", execute })).toThrow("protected-application-path");
      expect(execute).not.toHaveBeenCalled(); expect(host.writeState().write.owner).toBeNull();
    }
    mkdirSync(join(f.repo, ".vscode")); symlinkSync(join(f.profile, "private.json"), join(f.repo, ".vscode", "launch.json"));
    const scan = scanTaskServiceImportHints({ taskDir: f.taskDir, roots: files.roots(), protection: f.protection }, "repo-a");
    expect(scan.errors.some((row) => row.source === ".vscode/launch.json")).toBe(true);
    expect(JSON.stringify(scan)).not.toContain("synthetic-profile-value"); expect(JSON.stringify(scan)).not.toContain(f.profile);
  });
  it("checks task directory before task metadata reads when an old task directory is retargeted", () => {
    const f = fixture(); renameSync(f.taskDir, `${f.taskDir}-old`); symlinkSync(f.profile, f.taskDir, "dir");
    const read = vi.spyOn(f.store, "readTask");
    expect(() => f.files().roots()).toThrow("protected-application-path");
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects a retargeted ordinary source alias at root use without changing the persisted record", () => {
    const f = fixture(), source = join(f.home, "source-alias"), link = join(f.taskDir, "dir-abcd1234");
    symlinkSync(f.shared, source, "dir"); symlinkSync(source, link, "dir");
    const record = { ...f.record, dirLinks: [{ directoryId: "abcd1234", linkName: "dir-abcd1234", sourcePath: source, snapshotAt: f.record.createdAt }] };
    f.store.writeTask(f.taskDir, record); expect(f.files().roots()).toHaveLength(2);
    rmSync(source); symlinkSync(f.profile, source, "dir");
    expect(() => f.files().roots()).toThrow(); expect(() => f.host().sharedRoots()).toThrow();
    expect(f.store.readTask(f.taskDir)).toEqual(record);
  });
  it("rejects profile-file hardlinks before preview or import body reads", () => {
    const f = fixture(); linkSync(join(f.profile, "private.json"), join(f.repo, "copy.json"));
    expect(() => f.protection.assert(join(f.repo, "copy.json"))).toThrow();
    expect(f.files().preview({ rootId: "repo-a", relative: "copy.json" }).ok).toBe(false);
    linkSync(join(f.profile, "private.json"), join(f.repo, "package.json"));
    expect(scanTaskServiceImportHints({ taskDir: f.taskDir, roots: f.files().roots(), protection: f.protection }, "repo-a").hints).toEqual([]);
    expect(readFileSync(join(f.profile, "private.json"), "utf8")).toBe("synthetic-profile-value");
  });
  it("rechecks the protected target before approving an existing plan", () => {
    const f = fixture(), alias = join(f.repo, "output"); symlinkSync(f.shared, alias, "dir");
    f.store.writeTask(f.taskDir, { ...f.record, dirLinks: [{ directoryId: "abcd1234", linkName: "dir-abcd1234", sourcePath: f.shared, snapshotAt: f.record.createdAt }] });
    symlinkSync(f.shared, join(f.taskDir, "dir-abcd1234"), "dir");
    const host = f.host(); host.openSession("main", { providerId: "local", model: "test", permission: "default" });
    const execute = vi.fn((call) => ({ ...call, output: "executed" }));
    const asked = host.sendMessage("main", "write", { tool: "exec.run", target: join(alias, "new.txt"), execute });
    expect(asked.state).toBe("approval"); expect(execute).toHaveBeenCalledTimes(1);
    rmSync(alias); symlinkSync(f.profile, alias, "dir");
    expect(() => host.approve("main", asked.approvalId!)).toThrow("protected-application-path");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(host.listApprovals("main")[0].status).toBe("pending");
    expect(readFileSync(join(f.profile, "private.json"), "utf8")).toBe("synthetic-profile-value");
  });
});
