import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskWorkspaceHost } from "../host/task-host.js";
import { diskTaskStore, readTaskRecordOnDisk } from "../host/task-store.js";
import { ProjectRegistry } from "./project-registry.js";
import { CreationIntentStore, ProjectTaskCreation } from "./project-task-creation.js";
import { performCreationOperation } from "./project-task-ipc.js";
import { TaskRootIndex } from "./task-root-index.js";

const homes: string[] = [];
function git(cwd: string, ...args: string[]) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
async function setup() {
  const home = mkdtempSync(join(tmpdir(), "pidock-42-")); homes.push(home);
  const remote = join(home, "remote.git"), repo = join(home, "repo"), root = join(home, "tasks"), profile = join(home, "profile"), shared = join(home, "shared");
  mkdirSync(root); mkdirSync(shared); mkdirSync(repo);
  git(home, "init", "--bare", remote); git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@localhost"); git(repo, "config", "user.name", "Test");
  git(repo, "remote", "add", "origin", remote);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md"); git(repo, "commit", "-m", "base"); git(repo, "push", "-u", "origin", "main");
  writeFileSync(join(repo, "dirty.txt"), "keep me\n");
  const projects = new ProjectRegistry(profile);
  const project = await projects.create({ name: "Genuine", description: "", repositories: [{ name: "source", path: repo }], directories: [{ name: "shared", path: shared }] });
  const roots = new TaskRootIndex(profile, root), storage = new CreationIntentStore(profile);
  let calls = 0;
  const host = { routeTaskOp: async ({ taskId, payload }: { taskId: string; op: "task/provision"; payload: Record<string, unknown> }) => {
    calls += 1;
    const instance = new TaskWorkspaceHost(taskId, join(payload.rootOverride as string, taskId), diskTaskStore);
    instance.provision(payload as never);
    return { workspaceId: "test", taskId, op: "task/provision" as const, payload: {} };
  } };
  const service = new ProjectTaskCreation(storage, projects, roots, host, root);
  const request = { projectId: project.id, name: "Actual work", repositories: [{ sourceId: project.repositories[0]!.id, remote: "origin", remoteBranch: "main" }],
    directoryIds: [project.directories[0]!.id], sharedWriteConfirmed: true, override: false };
  return { home, repo, root, profile, remote, project, projects, roots, storage, service, request, getCalls: () => calls };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("persistent Project task creation with local Git", () => {
  it("pins an actual remote commit, preserves dirty checkout, links only chosen directory and associates after Host record", async () => {
    const env = await setup();
    const preview = await env.service.prepare(env.request);
    expect(preview.taskDir).toBe(join(env.root, preview.taskId));
    expect(existsSync(preview.taskDir)).toBe(false);
    expect(preview.repos[0]?.commit).toBe(git(env.repo, "rev-parse", "HEAD"));
    expect(await env.service.commit(preview.id)).toEqual({ taskId: preview.taskId, projectId: env.project.id });
    expect(readFileSync(join(env.repo, "dirty.txt"), "utf8")).toBe("keep me\n");
    const record = readTaskRecordOnDisk(preview.taskDir);
    expect(record?.repoSources?.[0]?.baseCommit).toBe(preview.repos[0]?.commit);
    expect(record?.dirLinks?.[0]?.directoryId).toBe(env.project.directories[0]?.id);
    expect(git(join(preview.taskDir, preview.repos[0]!.repoDir), "rev-parse", "HEAD")).toBe(preview.repos[0]?.commit);
    expect(env.projects.association(preview.taskId, env.roots).state).toBe("assigned");
    expect(env.roots.inventory().tasks.map((task) => task.taskId)).toContain(preview.taskId);
    expect(await env.service.commit(preview.id)).toEqual({ taskId: preview.taskId, projectId: env.project.id });
    expect(env.getCalls()).toBe(1);
    const reopened = new ProjectTaskCreation(new CreationIntentStore(env.profile), new ProjectRegistry(env.profile), new TaskRootIndex(env.profile, env.root), { routeTaskOp: () => { throw new Error("Host should not reprovision"); } }, env.root);
    expect(await reopened.commit(preview.id)).toEqual({ taskId: preview.taskId, projectId: env.project.id });
  });
  it("stays pinned when remote branch moves before commit; retry does not use new baseline", async () => {
    const env = await setup();
    const preview = await env.service.prepare(env.request);
    writeFileSync(join(env.repo, "README.md"), "new\n");
    git(env.repo, "add", "README.md"); git(env.repo, "commit", "-m", "new"); git(env.repo, "push", "origin", "main");
    await expect(env.service.commit(preview.id)).rejects.toThrow(/变化/);
    expect(readTaskRecordOnDisk(preview.taskDir)).toBeNull();
    expect(env.storage.read()?.repos[0]?.commit).toBe(preview.repos[0]?.commit);
    expect(env.getCalls()).toBe(0);
  });
  it("fails closed for changed Project and missing selected remote without producing a fake task", async () => {
    const env = await setup();
    await expect(env.service.prepare({ ...env.request, repositories: [{ ...env.request.repositories[0]!, remoteBranch: "missing" }] })).rejects.toThrow();
    expect(env.storage.read()).toBeNull();
    const preview = await env.service.prepare(env.request);
    await env.projects.rename(env.project.id, "Changed");
    await expect(env.service.commit(preview.id)).rejects.toThrow(/变更/);
    expect(existsSync(preview.taskDir)).toBe(false);
  });
  it("retries an indexed but unassociated Host record without reprovisioning", async () => {
    const env = await setup();
    const preview = await env.service.prepare(env.request);
    const realClaim = env.projects.claim.bind(env.projects);
    env.projects.claim = (() => { throw new Error("injected write failure"); }) as typeof env.projects.claim;
    await expect(env.service.commit(preview.id)).rejects.toThrow(/injected/);
    expect(readTaskRecordOnDisk(preview.taskDir)).not.toBeNull();
    expect(env.roots.inventory().tasks.map((task) => task.taskId)).toContain(preview.taskId);
    env.projects.claim = realClaim;
    await env.service.commit(preview.id);
    expect(env.getCalls()).toBe(1);
    expect(env.projects.association(preview.taskId, env.roots).state).toBe("assigned");
  });
  it("recovers an explicitly selected override root from the same intent", async () => {
    const env = await setup();
    const override = join(env.home, "override"); mkdirSync(override);
    const preview = await env.service.prepare({ ...env.request, override: true }, override);
    expect(preview.root).toBe(override);
    await env.service.commit(preview.id);
    expect(new TaskRootIndex(env.profile, env.root).resolve(preview.taskId)).toBe(preview.taskDir);
    expect(env.projects.association(preview.taskId, env.roots).state).toBe("assigned");
  });
  it("rejects renderer paths and non-attested picker results", async () => {
    const env = await setup();
    const attest = () => { throw new Error("sender changed"); };
    await expect(performCreationOperation(env.service, { op: "prepare", input: { ...env.request, root: env.home } }, async () => env.home, () => undefined)).rejects.toThrow();
    await expect(performCreationOperation(env.service, { op: "prepare", input: { ...env.request, override: true } }, async () => env.home, attest)).rejects.toThrow(/sender/);
    expect(env.storage.read()).toBeNull();
  });
  it("rejects a selected task root inside the original Git checkout", async () => {
    const env = await setup();
    const nested = join(env.repo, "tasks"); mkdirSync(nested);
    await expect(env.service.prepare({ ...env.request, override: true }, nested)).rejects.toThrow(/仓库重叠/);
    expect(env.storage.read()).toBeNull();
    expect(env.getCalls()).toBe(0);
  });
  it("refuses to overwrite a corrupted existing task record during recovery", async () => {
    const env = await setup();
    const preview = await env.service.prepare(env.request);
    const claim = env.projects.claim.bind(env.projects);
    env.projects.claim = (() => { throw new Error("injected failure"); }) as typeof env.projects.claim;
    await expect(env.service.commit(preview.id)).rejects.toThrow(/injected/);
    env.projects.claim = claim;
    writeFileSync(join(preview.taskDir, "task.json"), "broken");
    await expect(env.service.commit(preview.id)).rejects.toThrow(/不能覆盖/);
    expect(env.getCalls()).toBe(1);
  });
  it("does not reset intent after primary loss and refuses a copied task directory", async () => {
    const env = await setup();
    const preview = await env.service.prepare(env.request);
    const impostor = join(env.home, "impostor"); mkdirSync(impostor);
    renameSync(impostor, preview.taskDir);
    await expect(env.service.commit(preview.id)).rejects.toThrow(/标记/);
    rmSync(preview.taskDir, { recursive: true });
    rmSync(join(env.profile, "task-creations.json"));
    expect(() => new CreationIntentStore(env.profile).read()).toThrow(/恢复/);
  });
});
