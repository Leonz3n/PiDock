import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync, renameSync } from "node:fs";
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
  return { home, repo, root, profile, remote, project, projects, roots, storage, service, host, request, getCalls: () => calls };
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
    await expect(env.service.abandon(preview.id)).rejects.toThrow(/不能放弃/);
    expect(existsSync(join(env.profile, `task-creation-abandon-${preview.id}.json`))).toBe(false);
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
  it("refuses profile, alias and ancestor source selections before creating an intent or calling Host", async () => {
    const env = await setup(), alias = join(env.home, "profile-alias");
    if (process.platform !== "win32") symlinkSync(env.profile, alias, "dir");
    for (const source of [env.profile, env.home, ...(process.platform !== "win32" ? [alias] : [])]) {
      const project = await env.projects.update(env.project.id, { description: "", repositories: env.project.repositories,
        directories: [{ name: "protected", path: source }] });
      await expect(env.service.prepare({ ...env.request, directoryIds: [project.directories[0]!.id] })).rejects.toThrow("protected-application-path");
      expect(env.storage.read()).toBeNull(); expect(env.getCalls()).toBe(0);
    }
    await expect(env.service.prepare({ ...env.request, override: true, directoryIds: [] }, env.profile)).rejects.toThrow("protected-application-path");
    expect(env.storage.read()).toBeNull(); expect(env.getCalls()).toBe(0);
  });
  it.skipIf(process.platform === "win32")("refuses a source retargeted to profile between prepare and commit, retaining the intent", async () => {
    const env = await setup(), source = join(env.home, "shared");
    const intent = await env.service.prepare(env.request);
    renameSync(source, `${source}-old`); symlinkSync(env.profile, source, "dir");
    await expect(env.service.commit(intent.id)).rejects.toThrow("protected-application-path");
    expect(env.getCalls()).toBe(0); expect(env.storage.read()?.id).toBe(intent.id); expect(existsSync(intent.taskDir)).toBe(false);
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
  it("fails closed at unmarked mkdir gaps, records explicit abandon, and restarts with a fresh task ID", async () => {
    for (const phase of ["root-mkdir", "task-mkdir"] as const) {
      const env = await setup();
      const root = join(env.home, `new-${phase}`);
      const override = phase === "root-mkdir";
      const preview = await env.service.prepare({ ...env.request, override }, override ? root : undefined);
      const interrupted = new ProjectTaskCreation(env.storage, env.projects, env.roots, env.host, env.root, (boundary) => {
        if (boundary === phase) throw new Error(`interrupted ${phase}`);
      });
      await expect(interrupted.commit(preview.id)).rejects.toThrow(`interrupted ${phase}`);
      const unmarked = override ? root : preview.taskDir;
      expect(readdirSync(unmarked)).toEqual([]);
      const reopened = new ProjectTaskCreation(new CreationIntentStore(env.profile), new ProjectRegistry(env.profile), new TaskRootIndex(env.profile, env.root), env.host, env.root);
      await expect(reopened.commit(preview.id)).rejects.toThrow(/不能接管|标记不匹配/);
      expect(reopened.current()?.id).toBe(preview.id);
      expect(await reopened.abandon(preview.id)).toEqual({ taskId: preview.taskId, abandoned: true });
      expect(reopened.current()).toBeNull();
      const receipt = JSON.parse(readFileSync(join(env.profile, `task-creation-abandon-${preview.id}.json`), "utf8"));
      expect(receipt).toMatchObject({ reason: "operator-abandon", intentId: preview.id, taskId: preview.taskId, taskDir: preview.taskDir });
      expect(readdirSync(unmarked)).toEqual([]);
      const restarted = await reopened.prepare(env.request);
      expect(restarted.taskId).not.toBe(preview.taskId);
      expect(await reopened.commit(restarted.id)).toEqual({ taskId: restarted.taskId, projectId: env.project.id });
      expect(readdirSync(unmarked)).toEqual([]);
    }
  });
  it("recovers after durable markers before the root identity or task record is written", async () => {
    for (const phase of ["root-marked", "task-marked"] as const) {
      const env = await setup();
      const root = join(env.home, `new-${phase}`);
      const override = phase === "root-marked";
      const preview = await env.service.prepare({ ...env.request, override }, override ? root : undefined);
      const interrupted = new ProjectTaskCreation(env.storage, env.projects, env.roots, env.host, env.root, (boundary) => {
        if (boundary === phase) throw new Error(`interrupted ${phase}`);
      });
      await expect(interrupted.commit(preview.id)).rejects.toThrow(`interrupted ${phase}`);
      expect(readFileSync(join(override ? root : preview.taskDir, override ? ".pidock-created-root" : ".pidock-creation"), "utf8")).toBe(preview.id);
      const reopened = new ProjectTaskCreation(new CreationIntentStore(env.profile), new ProjectRegistry(env.profile), new TaskRootIndex(env.profile, env.root), env.host, env.root);
      if (!override) await expect(reopened.abandon(preview.id)).rejects.toThrow(/不能放弃/);
      expect(await reopened.commit(preview.id)).toEqual({ taskId: preview.taskId, projectId: env.project.id });
      expect(readTaskRecordOnDisk(preview.taskDir)?.taskId).toBe(preview.taskId);
    }
  });
  it("cannot commit an intent after its abandon receipt is durable but state transition was interrupted", async () => {
    const env = await setup();
    const preview = await env.service.prepare(env.request);
    await env.service.abandon(preview.id);
    env.storage.write({ ...preview, state: "pending" });
    const reopened = new ProjectTaskCreation(new CreationIntentStore(env.profile), new ProjectRegistry(env.profile), new TaskRootIndex(env.profile, env.root), env.host, env.root);
    await expect(reopened.commit(preview.id)).rejects.toThrow(/凭据已写入/);
    expect(existsSync(preview.taskDir)).toBe(false);
    expect(await reopened.abandon(preview.id)).toEqual({ taskId: preview.taskId, abandoned: true });
    expect(reopened.current()).toBeNull();
    expect(env.getCalls()).toBe(0);
  });
  it("does not replace a competitor's empty final directory between the check and exclusive mkdir", async () => {
    for (const phase of ["root-before-mkdir", "task-before-mkdir"] as const) {
      const env = await setup();
      const root = join(env.home, `raced-${phase}`);
      const override = phase === "root-before-mkdir";
      const preview = await env.service.prepare({ ...env.request, override }, override ? root : undefined);
      const target = override ? root : preview.taskDir;
      const competing = new ProjectTaskCreation(env.storage, env.projects, env.roots, env.host, env.root, (boundary) => {
        if (boundary === phase) mkdirSync(target);
      });
      await expect(competing.commit(preview.id)).rejects.toThrow(/EEXIST/);
      expect(readdirSync(target)).toEqual([]);
      expect(readTaskRecordOnDisk(preview.taskDir)).toBeNull();
      await expect(competing.commit(preview.id)).rejects.toThrow(/不能接管|标记不匹配/);
      expect(await competing.abandon(preview.id)).toEqual({ taskId: preview.taskId, abandoned: true });
      expect(readdirSync(target)).toEqual([]);
    }
  });
  it("refuses an unmarked user-created root after prepare without writing into it", async () => {
    const env = await setup();
    const root = join(env.home, "chosen");
    const preview = await env.service.prepare({ ...env.request, override: true }, root);
    mkdirSync(root); writeFileSync(join(root, "user.txt"), "preserve");
    await expect(env.service.commit(preview.id)).rejects.toThrow(/不能接管/);
    expect(readFileSync(join(root, "user.txt"), "utf8")).toBe("preserve");
    expect(env.getCalls()).toBe(0);
  });
  it("refuses two registered worktrees of the same Git common directory before intent creation", async () => {
    const env = await setup();
    const second = join(env.home, "second-worktree");
    git(env.repo, "worktree", "add", "-b", "another", second);
    const updated = await env.projects.update(env.project.id, { description: "", repositories: [...env.project.repositories, { name: "second", path: second }], directories: env.project.directories });
    await expect(env.service.prepare({ ...env.request, repositories: [env.request.repositories[0]!, { sourceId: updated.repositories[1]!.id, remote: "origin", remoteBranch: "main" }] })).rejects.toThrow(/同一 Git 仓库/);
    expect(env.storage.read()).toBeNull();
    expect(readdirSync(env.root)).toEqual([]);
  });
  it("accepts a user commit on the expected task branch after a later claim failure", async () => {
    const env = await setup();
    const preview = await env.service.prepare(env.request);
    const claim = env.projects.claim.bind(env.projects);
    env.projects.claim = (() => { throw new Error("claim interrupted"); }) as typeof env.projects.claim;
    await expect(env.service.commit(preview.id)).rejects.toThrow(/claim interrupted/);
    env.projects.claim = claim;
    const worktree = join(preview.taskDir, preview.repos[0]!.repoDir);
    git(worktree, "config", "user.email", "test@localhost"); git(worktree, "config", "user.name", "Test");
    writeFileSync(join(worktree, "work.txt"), "user change\n");
    git(worktree, "add", "work.txt"); git(worktree, "commit", "-m", "user work");
    const userHead = git(worktree, "rev-parse", "HEAD");
    expect(userHead).not.toBe(preview.repos[0]!.commit);
    expect(await env.service.commit(preview.id)).toEqual({ taskId: preview.taskId, projectId: env.project.id });
    expect(git(worktree, "rev-parse", "HEAD")).toBe(userHead);
    expect(readTaskRecordOnDisk(preview.taskDir)?.repoSources?.[0]?.baseCommit).toBe(preview.repos[0]!.commit);
  });
  it("recovers a user commit in the first worktree after a later repository branch conflict", async () => {
    const env = await setup();
    const second = join(env.home, "independent-repo"); mkdirSync(second);
    git(second, "init", "-b", "main"); git(second, "remote", "add", "origin", env.remote);
    git(second, "fetch", "origin", "main"); git(second, "checkout", "-B", "main", "FETCH_HEAD");
    const updated = await env.projects.update(env.project.id, { description: "", repositories: [...env.project.repositories, { name: "independent", path: second }], directories: env.project.directories });
    const selection = { ...env.request, repositories: [env.request.repositories[0]!, { sourceId: updated.repositories[1]!.id, remote: "origin", remoteBranch: "main" }] };
    const preview = await env.service.prepare(selection);
    git(second, "branch", preview.branch);
    await expect(env.service.commit(preview.id)).rejects.toThrow(/任务分支已存在/);
    expect(readTaskRecordOnDisk(preview.taskDir)).toBeNull();
    const first = join(preview.taskDir, preview.repos[0]!.repoDir);
    git(first, "config", "user.email", "test@localhost"); git(first, "config", "user.name", "Test");
    writeFileSync(join(first, "work.txt"), "user change\n"); git(first, "add", "work.txt"); git(first, "commit", "-m", "user work");
    const userHead = git(first, "rev-parse", "HEAD");
    git(second, "branch", "-D", preview.branch);
    expect(await env.service.commit(preview.id)).toEqual({ taskId: preview.taskId, projectId: env.project.id });
    expect(git(first, "rev-parse", "HEAD")).toBe(userHead);
    expect(readTaskRecordOnDisk(preview.taskDir)?.repoSources?.map((repo) => repo.baseCommit)).toEqual(preview.repos.map((repo) => repo.commit));
  });
  it("rejects an unrelated branch even when its history contains the pinned base", async () => {
    const env = await setup();
    const preview = await env.service.prepare(env.request);
    env.projects.claim = (() => { throw new Error("claim interrupted"); }) as typeof env.projects.claim;
    await expect(env.service.commit(preview.id)).rejects.toThrow(/claim interrupted/);
    const worktree = join(preview.taskDir, preview.repos[0]!.repoDir);
    git(worktree, "switch", "-c", "unrelated");
    await expect(env.service.commit(preview.id)).rejects.toThrow(/固定任务提交不符/);
    expect(env.storage.read()?.state).toBe("pending");
  });
  it("pins a credential-free remote transport digest across prepare and commit", async () => {
    const env = await setup();
    const preview = await env.service.prepare(env.request);
    const mirror = join(env.home, "mirror.git");
    git(env.home, "clone", "--bare", env.remote, mirror);
    git(env.repo, "remote", "set-url", "origin", mirror);
    await expect(env.service.commit(preview.id)).rejects.toThrow(/传输地址已改变/);
    expect(env.getCalls()).toBe(0);
    expect(existsSync(preview.taskDir)).toBe(false);
    expect(JSON.stringify(env.storage.read())).not.toContain(env.remote);
  });
  it("rejects a file URL whose symlink-then-dotdot path reaches a different repository with the same commit", async () => {
    const env = await setup();
    const alternate = join(env.home, "alternate");
    mkdirSync(join(alternate, "child"), { recursive: true });
    git(env.home, "clone", "--bare", env.remote, join(alternate, "remote.git"));
    const baseline = git(env.repo, "rev-parse", "HEAD");
    git(env.home, `--git-dir=${join(alternate, "remote.git")}`, "branch", "alternate-only", baseline);
    symlinkSync(join(alternate, "child"), join(env.home, "link"), "dir");
    const direct = `file://${env.remote}`;
    const shifted = `file://${env.home}/link/../remote.git`;
    expect(new URL(direct).toString()).toBe(new URL(shifted).toString());
    expect(git(env.home, "ls-remote", direct, "refs/heads/alternate-only")).toBe("");
    expect(git(env.home, "ls-remote", shifted, "refs/heads/alternate-only")).toContain("refs/heads/alternate-only");
    expect(git(env.home, "ls-remote", shifted, "refs/heads/main")).toContain(baseline);
    git(env.repo, "remote", "set-url", "origin", direct);
    const preview = await env.service.prepare(env.request);
    git(env.repo, "remote", "set-url", "origin", shifted);
    await expect(env.service.commit(preview.id)).rejects.toThrow(/传输地址已改变/);
    expect(existsSync(preview.taskDir)).toBe(false);
    expect(env.getCalls()).toBe(0);
    expect(JSON.stringify(env.storage.read())).not.toContain(direct);
    expect(JSON.stringify(env.storage.read())).not.toContain(shifted);
  });
  it("pins the SSH account for URL and SCP remotes even when host, path and commit are unchanged", async () => {
    const env = await setup();
    const helper = join(env.home, "local-ssh");
    writeFileSync(helper, "#!/bin/sh\nshift\nexec sh -c \"$*\"\n", { mode: 0o700 });
    const previous = { ssh: process.env.GIT_SSH, variant: process.env.GIT_SSH_VARIANT };
    process.env.GIT_SSH = helper; process.env.GIT_SSH_VARIANT = "simple";
    try {
      for (const scp of [false, true]) {
        const current = await setup();
        const url = (user: string) => scp ? `${user}@local:${current.remote}` : `ssh://${user}@local${current.remote}`;
        git(current.repo, "remote", "set-url", "origin", url("user-a"));
        const preview = await current.service.prepare(current.request);
        expect(preview.repos[0]?.commit).toBe(git(current.repo, "rev-parse", "HEAD"));
        expect(JSON.stringify(current.storage.read())).not.toContain(url("user-a"));
        git(current.repo, "remote", "set-url", "origin", url("user-b"));
        await expect(current.service.commit(preview.id)).rejects.toThrow(/传输地址已改变/);
        expect(existsSync(preview.taskDir)).toBe(false);
        expect(current.getCalls()).toBe(0);
      }
    } finally {
      if (previous.ssh === undefined) delete process.env.GIT_SSH; else process.env.GIT_SSH = previous.ssh;
      if (previous.variant === undefined) delete process.env.GIT_SSH_VARIANT; else process.env.GIT_SSH_VARIANT = previous.variant;
    }
  });
  it("rejects URL query or fragment selectors at prepare and after a credential-free preview", async () => {
    const env = await setup();
    for (const suffix of ["?selector=one", "#selector-two"]) {
      git(env.repo, "remote", "set-url", "origin", `file://${env.remote}${suffix}`);
      await expect(env.service.prepare(env.request)).rejects.toThrow(/查询或片段/);
      expect(env.storage.read()).toBeNull();
    }
    git(env.repo, "remote", "set-url", "origin", `file://${env.remote}`);
    const preview = await env.service.prepare(env.request);
    git(env.repo, "remote", "set-url", "origin", `file://${env.remote}?selector=two`);
    await expect(env.service.commit(preview.id)).rejects.toThrow(/查询或片段/);
    expect(existsSync(preview.taskDir)).toBe(false);
    expect(env.getCalls()).toBe(0);
  });
  it("rejects HTTP token userinfo and SSH password userinfo without logging or storing credentials", async () => {
    const env = await setup();
    for (const url of ["https://token-secret@example.invalid/repo.git", "https://user:token-secret@example.invalid/repo.git", "ssh://user:token-secret@local/repo.git", "ssh://user%3Atoken-secret@local/repo.git", "user%3Atoken-secret@local:repo.git"]) {
      git(env.repo, "remote", "set-url", "origin", url);
      const error = await env.service.prepare(env.request).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/含凭据/);
      expect((error as Error).message).not.toContain("token-secret");
      expect(env.storage.read()).toBeNull();
    }
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
