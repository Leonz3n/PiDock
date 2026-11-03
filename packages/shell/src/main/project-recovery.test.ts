import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRegistry, projectRegistryPath } from "./project-registry.js";
import { TaskRootIndex } from "./task-root-index.js";
import { performProjectOperation, projectFailureMessage } from "./project-ipc.js";

const homes: string[] = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pidock-recovery-"));
  homes.push(home);
  const data = join(home, "data");
  const defaultRoot = join(home, "default");
  mkdirSync(defaultRoot);
  mkdirSync(data);
  const registry = new ProjectRegistry(data);
  const roots = new TaskRootIndex(data, defaultRoot);
  const workspace = (name: string, repositories: { name: string; path: string }[]) => registry.create({ name, description: "", repositories, directories: [] });
  const task = (taskId = "task-abcdef12") => {
    const dir = join(defaultRoot, taskId);
    mkdirSync(dir);
    writeFileSync(join(dir, "task.json"), JSON.stringify({ taskId, name: "Task", dirId: taskId, root: defaultRoot,
      taskDir: dir, branch: "task/main", remoteBranch: "main", baseCommit: "abc123", repos: [],
      createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }));
    return dir;
  };
  return { home, data, defaultRoot, registry, roots, workspace, task, file: projectRegistryPath(data) };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("project registry health and explicit recovery", () => {
  it("reports a missing primary with a valid backup as recoverable, and restores it on confirmation", async () => {
    const f = fixture();
    const repo = join(f.home, "repo");
    mkdirSync(repo);
    const created = await f.workspace("PiDock", [{ name: "pi-agent-ui", path: repo }]);
    const good = readFileSync(f.file, "utf8");
    // Simulate a lost primary: the durable backup is the only copy left.
    rmSync(f.file);
    const before = await performProjectOperation(f.registry, { op: "status" });
    expect(before).toEqual({ initialized: false, primary: "missing", backup: "ok", recoverable: true });
    await expect(performProjectOperation(f.registry, { op: "list" })).rejects.toThrow(/backup requires explicit recovery/);
    // Recovery is an explicit, confirmed operation — never a side effect of a read.
    await expect(performProjectOperation(f.registry, { op: "recover" })).rejects.toMatchObject({ code: "invalid-payload" });
    await expect(performProjectOperation(f.registry, { op: "recover", confirmed: false })).rejects.toMatchObject({ code: "invalid-payload" });
    const restored = await performProjectOperation(f.registry, { op: "recover", confirmed: true });
    expect(restored).toMatchObject({ initialized: true, projects: [{ id: created.id, name: "PiDock" }] });
    expect(JSON.parse(readFileSync(f.file, "utf8"))).toEqual(JSON.parse(good));
    // The backup is kept and the primary now loads through the normal read path.
    expect(readFileSync(`${f.file}.bak`, "utf8")).toBe(good);
    expect(await performProjectOperation(f.registry, { op: "list" })).toMatchObject({ initialized: true, projects: [{ id: created.id }] });
    expect(await performProjectOperation(f.registry, { op: "status" })).toEqual({ initialized: true, primary: "ok", backup: "ok", recoverable: false });
  });

  it("keeps a corrupt primary aside and refuses recovery when the backup is absent or invalid", async () => {
    const f = fixture();
    const created = await f.workspace("PiDock", []);
    writeFileSync(f.file, "{not json");
    expect(await performProjectOperation(f.registry, { op: "status" })).toMatchObject({ primary: "invalid", backup: "ok", recoverable: true });
    await performProjectOperation(f.registry, { op: "recover", confirmed: true });
    expect(readFileSync(`${f.file}.invalid`, "utf8")).toBe("{not json");
    expect(JSON.parse(readFileSync(f.file, "utf8")).projects[0].id).toBe(created.id);

    // No backup at all: recovery fails closed and changes nothing.
    rmSync(f.file);
    rmSync(`${f.file}.bak`);
    expect(await performProjectOperation(f.registry, { op: "status" })).toEqual({ initialized: false, primary: "missing", backup: "missing", recoverable: false });
    await expect(performProjectOperation(f.registry, { op: "recover", confirmed: true })).rejects.toThrow(/no valid backup/);
    // A structurally invalid backup is refused instead of being installed.
    writeFileSync(`${f.file}.bak`, JSON.stringify({ version: 3, projects: "wrong", memberships: [] }));
    expect(await performProjectOperation(f.registry, { op: "status" })).toEqual({ initialized: false, primary: "missing", backup: "invalid", recoverable: false });
    await expect(performProjectOperation(f.registry, { op: "recover", confirmed: true })).rejects.toThrow();
    expect(() => readFileSync(f.file, "utf8")).toThrow();
  });

  it("names the registry failure kinds the UI has to distinguish", () => {
    expect(projectFailureMessage(new Error("project registry missing; backup requires explicit recovery")))
      .toContain("项目注册表缺失，可从备份恢复");
    expect(projectFailureMessage(new Error("project registry audit integrity mismatch"))).toContain("审计摘要不一致");
    expect(projectFailureMessage(new Error("invalid project registry rows"))).toContain("内容损坏");
    expect(projectFailureMessage(new Error("unsupported project registry version"))).toContain("版本不受支持");
    expect(projectFailureMessage(new Error("project registry too large"))).toContain("内容损坏");
    expect(projectFailureMessage(new Error("something else"))).toBe("项目注册表操作失败，请检查本机项目数据后重试");
  });
});

describe("source verification", () => {
  it("stats every registered source and reports ok, missing and not-directory per source", async () => {
    const f = fixture();
    const repo = join(f.home, "repo");
    const plain = join(f.home, "plain");
    const gone = join(f.home, "gone");
    const filePath = join(f.home, "note.txt");
    mkdirSync(repo);
    mkdirSync(plain);
    writeFileSync(filePath, "x");
    const created = await f.registry.create({ name: "PiDock", description: "",
      repositories: [{ name: "pi-agent-ui", path: repo }, { name: "gone", path: gone }],
      directories: [{ name: "plain", path: plain }, { name: "file", path: filePath }] });
    const result = await performProjectOperation(f.registry, { op: "verifySources", projectId: created.id });
    expect(result).toEqual({ projectId: created.id, sources: [
      { id: created.repositories[0]!.id, kind: "repository", status: "ok" },
      { id: created.repositories[1]!.id, kind: "repository", status: "missing" },
      { id: created.directories[0]!.id, kind: "directory", status: "ok" },
      { id: created.directories[1]!.id, kind: "directory", status: "not-directory" },
    ] });
    await expect(performProjectOperation(f.registry, { op: "verifySources", projectId: "../escape" })).rejects.toThrow(/invalid project ID/);
    await expect(performProjectOperation(f.registry, { op: "verifySources", projectId: created.id, path: repo })).rejects.toMatchObject({ code: "invalid-payload" });
  });

  it("refuses to verify a workspace that is not in the registry", async () => {
    const f = fixture();
    await expect(performProjectOperation(f.registry, { op: "verifySources", projectId: "0f3b0c8e-6a1a-4c2f-9c1b-3c9d2f6a1b99" }))
      .rejects.toThrow(/unknown project/);
  });
});

describe("delete blockers", () => {
  it("lists the tasks that block deletion with their association state", async () => {
    const f = fixture();
    f.task();
    const target = await f.workspace("PiDock", []);
    const other = await f.workspace("Other", []);
    await f.registry.claim("task-abcdef12", target.id, f.roots);
    expect(await performProjectOperation(f.registry, { op: "blockers", projectId: target.id }, f.roots))
      .toEqual({ projectId: target.id, tasks: [{ taskId: "task-abcdef12", state: "assigned" }] });
    expect(await performProjectOperation(f.registry, { op: "blockers", projectId: other.id }, f.roots))
      .toEqual({ projectId: other.id, tasks: [] });
    // The list is what makes the block actionable: unlink empties it and delete then succeeds.
    await performProjectOperation(f.registry, { op: "unlink", taskId: "task-abcdef12", expectedProjectId: target.id });
    expect(await performProjectOperation(f.registry, { op: "blockers", projectId: target.id }, f.roots))
      .toEqual({ projectId: target.id, tasks: [] });
    await expect(performProjectOperation(f.registry, { op: "delete", projectId: target.id })).resolves.toMatchObject({ action: "delete" });
    await expect(performProjectOperation(f.registry, { op: "blockers", projectId: target.id }, f.roots)).rejects.toThrow(/unknown project/);
    await expect(performProjectOperation(f.registry, { op: "blockers", projectId: other.id })).rejects.toThrow(/task root index unavailable/);
  });
});
