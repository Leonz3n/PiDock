/**
 * [PiDock 03] (#6 盒子 9) 两个任务并发创建共享仓库的 worktree 不产生相互覆盖.
 *
 * WHAT THIS PROVES, and with what: the unit suite
 * (`worktree-metadata-lock.test.ts`) pins the lock file protocol; THIS suite
 * drives the REAL production services — `ProjectTaskCreation` and
 * `ProjectTaskAppend` — over REAL temporary Git repositories with real
 * worktrees and branches, and includes a REAL SECOND PROCESS:
 *
 * - a `node` child process runs the production lock module itself (loaded
 *   through the repository's own TypeScript, no build step) and holds the lock
 *   on the shared source repo's real path while this process drives a create
 *   and an append;
 * - the loser is asserted to refuse BY NAME **and to have created nothing**,
 *   proven against real git state (`worktree list`, `branch --list`) and the
 *   real task folder, not against its own message;
 * - two tasks of ONE source repo never overlap, two DIFFERENT repos never
 *   contend, and a sequential pair both succeed (the lock is not a barrier);
 * - the window between the conflict scan and the real `git worktree add` is
 *   closed twice: by the lock (a held lock means NO metadata write at all) and
 *   by the re-check inside the critical section (a competing worktree introduced
 *   after the scan is refused with the gate's own `branch-in-use`);
 * - a holder process killed with SIGKILL is taken over under the NAMED stale
 *   policy, and the crash does not block the app.
 *
 * FIXTURE: no Electron GUI, no Provider turn, no network git (remotes are bare
 * directories under the test's own temp home), macOS/POSIX. Every spawned
 * process is killed on every path, and every home is removed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskWorkspaceHost } from "../host/task-host.js";
import { diskTaskStore, readTaskRecordOnDisk } from "../host/task-store.js";
import type { HostTaskOp, HostTaskResult } from "../rpc/protocol.js";
import { buildRepoChildName } from "./multi-repo-provision.js";
import { ProjectRegistry } from "./project-registry.js";
import { CreationIntentStore, ProjectTaskCreation } from "./project-task-creation.js";
import { performCreationOperation } from "./project-task-ipc.js";
import { createNodeAppendGit, ProjectTaskAppend } from "./task-append.js";
import { createNodePrepScanDeps, createPrepScanAuthority } from "./task-prep-scan.js";
import { TaskRootIndex } from "./task-root-index.js";
import {
  WORKTREE_LOCK_DIRECTORY,
  WORKTREE_LOCK_STALE_TAKEOVER,
  WorktreeMetadataLock,
} from "./worktree-metadata-lock.js";

/** Real repositories and real processes: a loaded machine must not look like a failure. */
const EVIDENCE_TEST_TIMEOUT_MS = 90_000;

const here = dirname(fileURLToPath(import.meta.url));
const homes: string[] = [];
const children: ChildProcess[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

interface RepoFixture {
  repo: string;
  remote: string;
}

/** A real repository with a real bare remote under the test's own temp home. */
function makeRepo(home: string, name: string): RepoFixture {
  const remote = join(home, `${name}-remote.git`);
  const repo = join(home, name);
  mkdirSync(repo);
  git(home, "init", "--bare", remote);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@localhost");
  git(repo, "config", "user.name", "Test");
  git(repo, "remote", "add", "origin", remote);
  writeFileSync(join(repo, "README.md"), `${name} baseline\n`);
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", `${name} baseline`);
  git(repo, "push", "-u", "origin", "main");
  return { repo, remote };
}

type AfterHostRoute = (op: HostTaskOp, taskId: string) => void | Promise<void>;

/**
 * The Host seam of `task-append.test.ts`, plus one hook used to introduce the
 * competing state at the exact point production would be suspended: after the
 * Host has answered (the planning scan already ran) and before main executes the
 * plan's real `git worktree add`.
 */
function createHost(root: string, afterHostRoute?: AfterHostRoute) {
  return {
    async routeTaskOp(params: {
      taskId: string;
      op: HostTaskOp;
      payload: Record<string, unknown>;
    }): Promise<HostTaskResult> {
      const taskRoot = join((params.payload["rootOverride"] as string | undefined) ?? root, params.taskId);
      const instance = new TaskWorkspaceHost(params.taskId, taskRoot, diskTaskStore);
      const answer = (payload: Record<string, unknown>): HostTaskResult => ({
        workspaceId: "w",
        taskId: params.taskId,
        op: params.op,
        payload,
      });
      let result: HostTaskResult;
      if (params.op === "task/provision") {
        const { record, plan } = instance.provision(params.payload as never);
        result = answer({ ...record, plan });
      } else if (params.op === "task/appendRepos") {
        const appended = instance.appendRepos(params.payload as never);
        result = answer({ ...appended.record, plan: appended.plan, appended: appended.appended, skipped: appended.skipped });
      } else if (params.op === "task/appendDirs") {
        const recorded = instance.appendDirs(params.payload as never);
        result = answer({ ...recorded.record });
      } else if (params.op === "task/prepareStatus") {
        result = answer(instance.prepareStatus() as unknown as Record<string, unknown>);
      } else if (params.op === "task/resumeAppend") {
        const resumed = instance.resumeAppend(params.payload as never);
        result = answer({
          outcomes: resumed.outcomes,
          created: resumed.created,
          pending: resumed.pending,
          failed: resumed.failed,
          retry: resumed.retry,
          hold: resumed.hold,
          resumed: resumed.resumed,
          plan: resumed.plan,
        });
      } else {
        throw new Error(`unexpected op ${params.op}`);
      }
      await afterHostRoute?.(params.op, params.taskId);
      return result;
    },
  };
}

interface TaskFixture {
  id: string;
  taskId: string;
  taskDir: string;
  branch: string;
}

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "pidock-repolock-"));
  homes.push(home);
  const root = join(home, "tasks");
  mkdirSync(root);
  const first = makeRepo(home, "first");
  const second = makeRepo(home, "second");
  const third = makeRepo(home, "third");
  const profile = join(home, "profile");
  const projects = new ProjectRegistry(profile);
  const project = await projects.create({
    name: "Genuine",
    description: "",
    repositories: [
      { name: "first", path: first.repo },
      { name: "second", path: second.repo },
      { name: "third", path: third.repo },
    ],
    directories: [],
  });
  const roots = new TaskRootIndex(profile, root);
  const storage = new CreationIntentStore(profile);
  const creation = new ProjectTaskCreation(storage, projects, roots, createHost(root), root, undefined, new WorktreeMetadataLock(profile));
  const selection = (fixture: RepoFixture) => ({
    sourceId: repoIdOf(project, fixture),
    remote: "origin",
    remoteBranch: "main",
  });
  const append = (afterHostRoute?: AfterHostRoute): ProjectTaskAppend =>
    new ProjectTaskAppend(
      createHost(root, afterHostRoute),
      createPrepScanAuthority(projects, roots),
      createNodePrepScanDeps(),
      createNodeAppendGit(),
      // A separate instance per service, on the same app data directory: the
      // same real-path keys, the same lock files, no shared memory.
      new WorktreeMetadataLock(profile),
    );
  const createTask = async (fixture: RepoFixture, name: string): Promise<TaskFixture> => {
    const prepared = (await performCreationOperation(
      creation,
      {
        op: "prepare",
        input: {
          projectId: project.id,
          name,
          repositories: [selection(fixture)],
          directoryIds: [],
          sharedWriteConfirmed: false,
          override: false,
        },
      },
      async () => null,
      () => undefined,
    )) as { canceled: boolean; intent: TaskFixture };
    if (prepared.canceled) throw new Error("creation was canceled");
    await performCreationOperation(creation, { op: "commit", id: prepared.intent.id }, async () => null, () => undefined);
    return prepared.intent;
  };
  const prepareIntent = async (fixture: RepoFixture) => {
    const prepared = (await performCreationOperation(
      creation,
      {
        op: "prepare",
        input: {
          projectId: project.id,
          name: "Pending work",
          repositories: [selection(fixture)],
          directoryIds: [],
          sharedWriteConfirmed: false,
          override: false,
        },
      },
      async () => null,
      () => undefined,
    )) as { canceled: boolean; intent: TaskFixture };
    if (prepared.canceled) throw new Error("creation was canceled");
    return prepared.intent;
  };
  const worktreeOf = (task: TaskFixture, fixture: RepoFixture): string =>
    join(task.taskDir, buildRepoChildName(repoIdOf(project, fixture)));
  const lockFile = (fixture: RepoFixture): string => new WorktreeMetadataLock(profile).fileFor(realpathSync(fixture.repo));
  const receipts = (): string[] => {
    const directory = join(profile, WORKTREE_LOCK_DIRECTORY);
    return existsSync(directory) ? readdirSync(directory).filter((name) => name.includes(".stale-")) : [];
  };
  return {
    home, root, profile, projects, project, roots, creation, append, first, second, third,
    selection, createTask, prepareIntent, worktreeOf, lockFile, receipts,
    recordOf: (task: TaskFixture): Buffer => readFileSync(join(task.taskDir, "task.json")),
  };
}

function repoIdOf(project: { repositories: { id: string; name: string; path: string }[] }, fixture: RepoFixture): string {
  const found = project.repositories.find((row) => row.path === fixture.repo);
  if (!found) throw new Error("fixture is not a project repository");
  return found.id;
}

/**
 * The child's own module map: Node runs TypeScript directly (types are
 * stripped), but this repository writes `.js` specifiers for files that exist
 * as `.ts`. This hook — test scaffolding only, no production file — maps such a
 * specifier to its `.ts` source, so the CHILD really executes the production
 * lock module instead of a re-implementation of its file format.
 */
const RESOLVER_HOOK = `
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".js") && (specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
      const candidate = new URL(specifier, context.parentURL);
      const tsUrl = new URL(candidate.href.replace(/\\.js$/, ".ts"));
      if (!existsSync(fileURLToPath(candidate)) && existsSync(fileURLToPath(tsUrl))) return { url: tsUrl.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
`;

/** A real second process that acquires the production lock and holds it. */
const holderSource = (modulePath: string): string => `
import { WorktreeMetadataLock } from ${JSON.stringify(modulePath)};

const [userData, source, taskId, label] = process.argv.slice(2);
const lock = new WorktreeMetadataLock(userData);
const acquisition = lock.acquireFor([source], { taskId, label });
if (!acquisition.ok) {
  process.stdout.write(JSON.stringify({ ok: false, error: acquisition.error }) + "\\n");
  process.exit(2);
}
process.stdout.write(JSON.stringify({ ok: true, keys: acquisition.keys, pid: process.pid }) + "\\n");
const stop = () => { acquisition.release(); process.exit(0); };
process.stdin.resume();
process.stdin.on("data", stop);
process.stdin.on("end", stop);
setTimeout(stop, 120000);
`;

interface Holder {
  child: ChildProcess;
  keys: string[];
  pid: number;
}

function readLine(child: ChildProcess, boundMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`holder produced no line within ${boundMs}ms: ${stderr}`)), boundMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolve(buffer.slice(0, newline));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`holder exited before holding the lock (code ${String(code)}): ${stderr}`));
    });
  });
}

async function startHolder(
  env: Awaited<ReturnType<typeof setup>>,
  sourcePath: string,
  taskId: string,
  label: string,
): Promise<Holder> {
  const hook = join(env.home, "ts-js-resolver.mjs");
  const script = join(env.home, `holder-${taskId}.ts`);
  writeFileSync(hook, RESOLVER_HOOK);
  writeFileSync(script, holderSource(join(here, "worktree-metadata-lock.ts")));
  const child = spawn(process.execPath, ["--import", hook, script, env.profile, sourcePath, taskId, label], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const line = JSON.parse(await readLine(child, EVIDENCE_TEST_TIMEOUT_MS)) as {
    ok: boolean;
    keys?: string[];
    pid?: number;
    error?: string;
  };
  if (!line.ok) throw new Error(`the second process refused to hold the lock: ${line.error ?? "unknown"}`);
  return { child, keys: line.keys ?? [], pid: line.pid ?? -1 };
}

async function stopHolder(holder: Holder): Promise<void> {
  if (holder.child.exitCode !== null || holder.child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => holder.child.once("exit", () => resolve()));
  holder.child.stdin?.write("release\n");
  holder.child.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
  if (holder.child.exitCode === null && holder.child.signalCode === null) holder.child.kill("SIGKILL");
}

async function killHolder(holder: Holder): Promise<void> {
  if (holder.child.exitCode !== null || holder.child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => holder.child.once("exit", () => resolve()));
  holder.child.kill("SIGKILL");
  await exited;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("[PiDock 03] (#6 盒子 9) repository-level worktree creation is mutually exclusive", () => {
  it("refuses a create BY NAME and creates nothing while a REAL second process holds the source repo's lock", { timeout: EVIDENCE_TEST_TIMEOUT_MS }, async () => {
    const env = await setup();
    const holder = await startHolder(env, env.first.repo, "task-child001", "追加仓库");
    try {
      // The key the second process holds IS the real path of the shared source
      // repository — resolved by the production module in that process.
      expect(holder.keys).toEqual([realpathSync(env.first.repo)]);
      expect(holder.pid).not.toBe(process.pid);
      expect(existsSync(env.lockFile(env.first))).toBe(true);

      const intent = await env.prepareIntent(env.first);
      const worktreesBefore = git(env.first.repo, "worktree", "list", "--porcelain");
      const branchesBefore = git(env.first.repo, "branch", "--list", "--format=%(refname:short)");

      await expect(env.creation.commit(intent.id)).rejects.toThrow(/^worktree-locked: /);
      await expect(env.creation.commit(intent.id)).rejects.toThrow(new RegExp(String(holder.pid)));

      // "Created nothing" is asserted against REAL git state and the real task
      // folder, never against the refusal's own wording.
      expect(existsSync(intent.taskDir)).toBe(false);
      expect(existsSync(join(env.root, intent.taskId))).toBe(false);
      expect(git(env.first.repo, "worktree", "list", "--porcelain")).toBe(worktreesBefore);
      expect(git(env.first.repo, "branch", "--list", "--format=%(refname:short)")).toBe(branchesBefore);
      expect(git(env.first.repo, "branch", "--list", intent.branch)).toBe("");
      expect(env.receipts()).toEqual([]);

      // The same intent succeeds once the holder is gone: the lock is neither a
      // permanent barrier nor a claim the operation never really lost.
      await stopHolder(holder);
      expect(await env.creation.commit(intent.id)).toEqual({ taskId: intent.taskId, projectId: env.project.id });
      expect(git(env.worktreeOf(intent, env.first), "rev-parse", "--abbrev-ref", "HEAD")).toBe(intent.branch);
      expect(git(env.first.repo, "branch", "--list", intent.branch, "--format=%(refname:short)")).toBe(intent.branch);
      // The shared SOURCE checkout is untouched: still on its own branch, with
      // its own file, and the lock created nothing inside it.
      expect(git(env.first.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
      expect(readFileSync(join(env.first.repo, "README.md"), "utf8")).toBe("first baseline\n");
      expect(git(env.first.repo, "status", "--porcelain")).toBe("");
      // Released on success: the real git worktree exists and the lock is free.
      expect(existsSync(env.lockFile(env.first))).toBe(false);
    } finally {
      await stopHolder(holder);
    }
  });

  it("lets a task in a DIFFERENT source repository proceed while the lock on another repo is held", { timeout: EVIDENCE_TEST_TIMEOUT_MS }, async () => {
    const env = await setup();
    const holder = await startHolder(env, env.first.repo, "task-child002", "创建任务");
    try {
      const intent = await env.prepareIntent(env.second);
      expect(await env.creation.commit(intent.id)).toEqual({ taskId: intent.taskId, projectId: env.project.id });
      expect(git(env.worktreeOf(intent, env.second), "rev-parse", "--abbrev-ref", "HEAD")).toBe(intent.branch);
      // The lock on the other repository never moved.
      expect(existsSync(env.lockFile(env.first))).toBe(true);
      expect(existsSync(env.lockFile(env.second))).toBe(false);
      expect(env.receipts()).toEqual([]);
    } finally {
      await stopHolder(holder);
    }
  });

  it("refuses an append BY NAME with no metadata write at all while a second service instance holds the lock", { timeout: EVIDENCE_TEST_TIMEOUT_MS }, async () => {
    const env = await setup();
    const taskA = await env.createTask(env.first, "Task A");
    const taskB = await env.createTask(env.first, "Task B");

    // Task A's append pauses EXACTLY where production suspends: its conflict
    // scan has run and the Host has answered, while its lock is still held.
    let entered!: () => void;
    const insideCriticalSection = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let leave!: () => void;
    const gate = new Promise<void>((resolve) => {
      leave = resolve;
    });
    const serviceA = env.append(async (op) => {
      if (op !== "task/appendRepos") return;
      entered();
      await gate;
    });
    const pendingA = serviceA.append({ taskId: taskA.taskId, repositories: [env.selection(env.second)] });
    await insideCriticalSection;

    const recordB = env.recordOf(taskB);
    const listingB = readdirSync(taskB.taskDir).sort();
    const worktreesBefore = git(env.second.repo, "worktree", "list", "--porcelain");

    // A SECOND service instance (another append in the same app data directory)
    // must refuse by name while the lock is held, and write nothing at all.
    await expect(
      env.append().append({ taskId: taskB.taskId, repositories: [env.selection(env.second)] }),
    ).rejects.toThrow(/^worktree-locked: /);
    expect(env.recordOf(taskB)).toEqual(recordB);
    expect(readdirSync(taskB.taskDir).sort()).toEqual(listingB);
    expect(git(env.second.repo, "branch", "--list", taskB.branch)).toBe("");
    expect(existsSync(env.worktreeOf(taskB, env.second))).toBe(false);
    expect(git(env.second.repo, "worktree", "list", "--porcelain")).toBe(worktreesBefore);
    expect(existsSync(env.lockFile(env.second))).toBe(true);

    // The holder really did create its own worktree: the refusal was about the
    // other operation, not about a broken fixture.
    leave();
    const resultA = await pendingA;
    expect(resultA.appended.map((repo) => repo.repoDir)).toEqual([buildRepoChildName(repoIdOf(env.project, env.second))]);
    expect(git(env.worktreeOf(taskA, env.second), "rev-parse", "--abbrev-ref", "HEAD")).toBe(taskA.branch);
    expect(existsSync(env.lockFile(env.second))).toBe(false);
  });

  it("lets two tasks of one source repository create their worktrees one after the other", { timeout: EVIDENCE_TEST_TIMEOUT_MS }, async () => {
    const env = await setup();
    const taskA = await env.createTask(env.first, "Task A");
    const taskB = await env.createTask(env.first, "Task B");

    const first = await env.append().append({ taskId: taskA.taskId, repositories: [env.selection(env.second)] });
    expect(first.appended).toHaveLength(1);
    const second = await env.append().append({ taskId: taskB.taskId, repositories: [env.selection(env.second)] });
    expect(second.appended).toHaveLength(1);

    // Both worktrees of the ONE source repository exist, each on its own branch.
    expect(git(env.worktreeOf(taskA, env.second), "rev-parse", "--abbrev-ref", "HEAD")).toBe(taskA.branch);
    expect(git(env.worktreeOf(taskB, env.second), "rev-parse", "--abbrev-ref", "HEAD")).toBe(taskB.branch);
    expect(git(env.second.repo, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(3);
    expect(existsSync(env.lockFile(env.second))).toBe(false);
  });

  it("leaves the lock free when the operation fails inside the critical section, so the retry succeeds", { timeout: EVIDENCE_TEST_TIMEOUT_MS }, async () => {
    const env = await setup();
    const task = await env.createTask(env.first, "Task A");
    // The third repository's remote branch disappears: its fetch fails INSIDE the
    // critical section, after the batch's first repository was already fetched.
    git(env.home, `--git-dir=${env.third.remote}`, "update-ref", "-d", "refs/heads/main");
    await expect(
      env.append().append({ taskId: task.taskId, repositories: [env.selection(env.second), env.selection(env.third)] }),
    ).rejects.toThrow(/^fetch-failed: /);

    // A failed operation must not leave the app blocked: the lock is gone.
    expect(existsSync(env.lockFile(env.second))).toBe(false);
    expect(existsSync(env.lockFile(env.third))).toBe(false);

    git(env.third.repo, "push", "origin", "main");
    const retry = await env.append().append({ taskId: task.taskId, repositories: [env.selection(env.second), env.selection(env.third)] });
    expect(retry.appended.map((repo) => repo.repoDir).sort()).toEqual(
      [buildRepoChildName(repoIdOf(env.project, env.second)), buildRepoChildName(repoIdOf(env.project, env.third))].sort(),
    );
    expect(existsSync(env.lockFile(env.second))).toBe(false);
    expect(existsSync(env.lockFile(env.third))).toBe(false);
  });

  it("refuses BY NAME a competing worktree that appears after the planning scan, duplicating nothing", { timeout: EVIDENCE_TEST_TIMEOUT_MS }, async () => {
    const env = await setup();
    const task = await env.createTask(env.first, "Task A");
    const competitor = join(env.home, "competitor");
    // The competing state is introduced at the ONE gap the lock cannot cover: a
    // non-cooperating actor creating a worktree on this task's branch AFTER the
    // conflict scan and BEFORE the real `git worktree add`.
    const service = env.append((op) => {
      if (op !== "task/appendRepos") return;
      git(env.second.repo, "worktree", "add", "-b", task.branch, competitor, "main");
    });
    await expect(
      service.append({ taskId: task.taskId, repositories: [env.selection(env.second)] }),
    ).rejects.toThrow(/^branch-in-use: /);

    // Refused, not duplicated and not clobbered: exactly one worktree holds the
    // branch, and this task created no worktree of its own.
    expect(git(env.second.repo, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(2);
    expect(git(competitor, "rev-parse", "--abbrev-ref", "HEAD")).toBe(task.branch);
    expect(existsSync(env.worktreeOf(task, env.second))).toBe(false);
    expect(git(env.second.repo, "branch", "--list", task.branch, "--format=%(refname:short)")).toBe(task.branch);
    expect(existsSync(env.lockFile(env.second))).toBe(false);
  });

  it("takes over under the NAMED stale policy after a holder process is killed, and the app is not blocked", { timeout: EVIDENCE_TEST_TIMEOUT_MS }, async () => {
    const env = await setup();
    const holder = await startHolder(env, env.first.repo, "task-child003", "创建任务");
    await killHolder(holder);
    expect(existsSync(env.lockFile(env.first))).toBe(true);

    const notices: string[] = [];
    const takeover = new WorktreeMetadataLock(env.profile, { notify: (message) => notices.push(message) })
      .acquireFor([env.first.repo], { taskId: "task-aaaaaaaa", label: "创建任务" });
    expect(takeover.ok).toBe(true);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(WORKTREE_LOCK_STALE_TAKEOVER);
    expect(notices[0]).toContain("task-child003");
    expect(env.receipts()).toHaveLength(1);
    if (takeover.ok) takeover.release();

    // The crashed holder really did not block the app: the real creation flow
    // completes against the same source repository.
    const intent = await env.prepareIntent(env.first);
    expect(await env.creation.commit(intent.id)).toEqual({ taskId: intent.taskId, projectId: env.project.id });
    expect(git(env.worktreeOf(intent, env.first), "rev-parse", "--abbrev-ref", "HEAD")).toBe(intent.branch);
    expect(readTaskRecordOnDisk(intent.taskDir)?.taskId).toBe(intent.taskId);
  });

  it("production wired: main.ts injects the app-private lock into BOTH services", async () => {
    // Behavioural coverage is above; this guards the production injection point
    // only, because a capability nothing in production reaches is not a fix.
    const source = readFileSync(join(here, "main.ts"), "utf8");
    expect(source).toContain("new WorktreeMetadataLock(app.getPath(\"userData\")");
    expect(source).toContain("defaultTasksRoot(), undefined, worktreeLock)");
    expect(source).toContain("createNodeAppendGit(),\n    worktreeLock,");
  });
});
