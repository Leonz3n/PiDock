/**
 * Real `TaskLifecycleResources` for [PiDock 14] (#17), wired in `host.ts`.
 *
 * Everything the lifecycle state machine needs comes from an existing seam:
 * session channels for runs/drafts/approvals/permissions, the task record for
 * worktrees and plain-directory links, the service topology for running
 * services and their registered process identities, the terminal registry for
 * terminal instances, and this task folder for link `lstat`/removal. No
 * renderer-supplied path or identity reaches this module's destructive calls:
 * `removeInTaskPath` re-derives the path from the Host's own task folder plus a
 * link name that is in the task record.
 */

import { dirname, join, basename } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, lstatSync, readlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createNodeRepoProbe, observeRecordedRepo, type RepoProbe } from "./repo-identity.js";
import type { TaskWorkspaceHost } from "./task-host.js";
import type { LifecycleSession, LifecycleWorktree, TaskLifecycleResources } from "./task-lifecycle.js";
import type { TaskServiceTopology } from "./service-topology.js";
import type { TaskTerminalRegistry } from "../main/terminal-config.js";
import type { CleanupSelection, LiveProcessObservation, RepoDeliveryObservation } from "../main/task-lifecycle.js";

export interface LifecycleResourceInput {
  host: TaskWorkspaceHost;
  services: () => TaskServiceTopology | null;
  terminals: () => TaskTerminalRegistry | null;
  /** Session ids known on disk, so a restart shows archived-but-not-open sessions. */
  sessionIds: () => string[];
  repoProbe?: RepoProbe;
  /** Process observation (pid + start time + command/cwd) of the machine. */
  liveProcesses?: () => readonly LiveProcessObservation[];
}

/**
 * `ps -axo pid=,lstart=,command=` — one row per process with its OS start time.
 * Fixed argv and no shell; a failure yields no observations (fail closed: an
 * unknown process can never be claimed).
 */
export function readLiveProcesses(): LiveProcessObservation[] {
  const { execFileSync } = process.getBuiltinModule("node:child_process") as typeof import("node:child_process");
  try {
    const output = execFileSync("ps", ["-axo", "pid=,lstart=,command="], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        // "12345 Mon Sep 22 10:00:00 2026 node server.js"
        const match = /^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
        if (!match) return [];
        const [, pid, startedAt, command] = match;
        return [{ pid: Number(pid), startedAt: startedAt ?? "", command: command ?? "", cwd: "" }];
      });
  } catch {
    return [];
  }
}

function recordOf(input: LifecycleResourceInput) {
  return input.host.store.readTask(input.host.taskDir);
}

function readSessions(host: TaskWorkspaceHost): LifecycleSession[] {
  return host.sessionIds().map((sessionId) => {
    const snapshot = host.openSession(sessionId).snapshot();
    const latestApproval = [...snapshot.approvals].reverse()[0];
    return {
      sessionId,
      permission: snapshot.permission,
      // The permission a gated request actually ran under is recorded on the
      // approval; without one there is no "actual" record to show.
      actualPermission: latestApproval?.permissionAtRequest ?? null,
      runState: snapshot.runState,
      ...(snapshot.draft !== undefined ? { draft: snapshot.draft } : {}),
      approvals: snapshot.approvals.map((approval) => ({
        id: approval.id,
        status: approval.status,
        executed: approval.executed,
        ...(approval.consumedAt !== undefined ? { consumedAt: approval.consumedAt } : {}),
      })),
    };
  });
}

function worktreesOf(input: LifecycleResourceInput): LifecycleWorktree[] {
  const record = recordOf(input);
  if (!record) return [];
  const sources = record.repoSources;
  if (sources !== undefined && sources.length > 0) {
    return sources.map((source) => ({ repoDir: join(record.taskDir, source.repoDir), branch: record.branch, baseCommit: source.baseCommit }));
  }
  return record.repos.map((repo) => ({ repoDir: join(record.taskDir, repo), branch: record.branch, baseCommit: record.baseCommit }));
}

function otherTaskDirs(input: LifecycleResourceInput): string[] {
  const parent = dirname(input.host.taskDir);
  const self = basename(input.host.taskDir);
  try {
    return readdirSync(parent)
      .filter((entry) => entry !== self)
      .map((entry) => join(parent, entry))
      .filter((path) => {
        try {
          return lstatSync(join(path, "task.json")).isFile();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/**
 * [T12] #147: read every repository of this task with real git, index-neutrally.
 * `GIT_OPTIONAL_LOCKS=0` keeps `status --porcelain` from refreshing/rewriting the
 * user's index (and from colliding with the user's own git on `index.lock`);
 * `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` are cleared so a read can only
 * answer about this repo. A failed read is `null` (unknown), never "clean".
 */
function readRepoDelivery(repoDir: string): RepoDeliveryObservation {
  const git = (args: readonly string[]): { ok: true; stdout: string } | { ok: false; code?: unknown } => {
    try {
      const stdout = execFileSync("git", ["-C", repoDir, ...args], {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
        stdio: ["ignore", "pipe", "ignore"],
      });
      return { ok: true, stdout };
    } catch (error) {
      return { ok: false, code: (error as { code?: unknown }).code };
    }
  };
  try {
    if (!lstatSync(repoDir).isDirectory()) return { repoDir, uncommitted: null, delivered: null, reason: "工作副本路径不可读" };
    const status = git(["--no-optional-locks", "status", "--porcelain"]);
    if (!status.ok) {
      return { repoDir, uncommitted: null, delivered: null, reason: status.code === "ENOENT" ? "本机没有可用的 Git 命令" : "Git 状态读取失败" };
    }
    // [Pencil T13] #148 read, not a success ledger: a commit that no
    // remote-tracking ref contains is undelivered (`rev-list HEAD --not
    // --remotes`). When that read fails the delivery stays `null` = unknown,
    // which cleanup does NOT treat as delivered.
    const ahead = git(["rev-list", "--count", "HEAD", "--not", "--remotes"]);
    const delivered = ahead.ok ? Number.parseInt(ahead.stdout.trim(), 10) === 0 : null;
    return { repoDir, uncommitted: status.stdout.trim().length > 0, delivered };
  } catch {
    return { repoDir, uncommitted: null, delivered: null, reason: "Git 状态读取失败" };
  }
}

/** One row per recorded repository, each read on its own (never one repo for all). */
function repoDeliveryOf(input: LifecycleResourceInput): RepoDeliveryObservation[] {
  return worktreesOf(input).map((worktree) => readRepoDelivery(worktree.repoDir));
}

function deliveryOf(input: LifecycleResourceInput): { uncommitted: boolean; undelivered: boolean } {
  // Aggregate view kept for the older single-`code` preview: unknown counts as
  // a change (conservative), so a failed read never reads as "safe to delete".
  const rows = repoDeliveryOf(input);
  if (rows.length === 0) return { uncommitted: false, undelivered: false };
  return {
    uncommitted: rows.some((row) => row.uncommitted !== false),
    undelivered: rows.some((row) => row.delivered !== true),
  };
}

/** Bounded wait for this task's in-flight turns and held write rights. */
async function waitForIdle(input: LifecycleResourceInput): Promise<string[]> {
  const waited: string[] = [];
  const deadline = Date.now() + 30_000;
  for (;;) {
    const busy = readSessions(input.host).filter((session) => session.runState === "running" || session.runState === "approval");
    const write = input.host.writeState().write;
    const ownedLock = write.owner !== null && write.owner.length > 0;
    if (busy.length === 0 && !ownedLock) return waited;
    if (Date.now() > deadline) {
      throw new Error(`cleanup-wait-timeout: 仍在等待 ${[...busy.map((session) => `会话 ${session.sessionId}`), ...(ownedLock ? [`写入权 ${String(write.owner)}`] : [])].join("、")}`);
    }
    for (const session of busy) waited.push(`turn:${session.sessionId}`);
    if (ownedLock) waited.push(`lock:${String(write.owner)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Export the selected records into an independent keep bundle and verify each
 * written file by reading it back. What is a physical copy here is the exported
 * evidence (sessions/drafts/usage + manifest naming the retained code
 * position); the code worktree itself is never deleted by cleanup, so its
 * position is recorded rather than duplicated.
 */
function keepAndExport(
  input: LifecycleResourceInput,
  request: { selection: CleanupSelection; keepRoot: string },
): { codeCopyOk: boolean; exportsOk: boolean; retainedPosition: string | null; detail: string } {
  const record = recordOf(input);
  const dir = join(request.keepRoot, input.host.taskId);
  const sessionIds = input.sessionIds();
  const usage = input.host.store.readUsage(input.host.taskDir);
  const exports: string[] = [];
  try {
    mkdirSync(dir, { recursive: true });
    const writeVerified = (name: string, content: string): void => {
      const path = join(dir, name);
      writeFileSync(path, content, "utf8");
      if (readFileSync(path, "utf8") !== content) throw new Error(`keep-verify-failed: ${name}`);
      exports.push(name);
    };
    const manifest = {
      taskId: input.host.taskId,
      taskDir: input.host.taskDir,
      keptAt: new Date().toISOString(),
      codePosition: worktreesOf(input).map((worktree) => `${worktree.repoDir}@${worktree.baseCommit}`),
      selection: request.selection,
    };
    writeVerified("manifest.json", JSON.stringify(manifest, null, 2));
    if (request.selection.exportSessions || request.selection.exportDrafts) {
      const snapshots = sessionIds
        .map((sessionId) => input.host.store.readSession(input.host.taskDir, sessionId))
        .filter((snapshot) => snapshot !== null);
      writeVerified("sessions.json", JSON.stringify(snapshots, null, 2));
    }
    if (request.selection.exportUsage) {
      writeVerified("usage.json", JSON.stringify(usage.details, null, 2));
    }
    return {
      codeCopyOk: record !== null && worktreesOf(input).length > 0,
      exportsOk: true,
      retainedPosition: dir,
      detail: `保留位置 ${dir}（清单 + 导出核验通过）`,
    };
  } catch (error) {
    return {
      codeCopyOk: false,
      exportsOk: false,
      retainedPosition: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createLifecycleResources(input: LifecycleResourceInput): TaskLifecycleResources {
  const probe = input.repoProbe ?? createNodeRepoProbe();
  return {
    platform: () => process.platform,
    sessions: () => readSessions(input.host),
    cancelSession: (sessionId) => {
      const channel = input.host.openSession(sessionId);
      channel.cancel();
      input.host.store.writeSession(input.host.taskDir, channel.snapshot());
    },
    stopService: (serviceId) => {
      const topology = input.services();
      if (!topology) return;
      for (const record of topology.runs()) {
        if (record.endedAt === undefined && record.serviceId === serviceId) topology.exitRun(record.runId, "app-quit");
      }
    },
    stopTerminal: (instanceId) => {
      const terminals = input.terminals();
      if (!terminals) return;
      terminals.markExited(instanceId, { reason: "app-quit" });
    },
    stopProcessTree: (resourceId) => {
      input.host.endDerivedExecution(resourceId);
    },
    worktrees: () => worktreesOf(input),
    observeRepo: (worktree) => observeRecordedRepo({ repoDir: worktree.repoDir, baseCommit: worktree.baseCommit }, probe),
    usageCount: () => input.host.usageReport({}).details.length,
    services: () => {
      const topology = input.services();
      if (!topology) return [];
      const identities = topology.registeredIdentities();
      return topology
        .runs()
        .filter((record) => record.endedAt === undefined)
        .map((record) => {
          const identity = identities.find((entry) => entry.serviceId === record.serviceId);
          return {
            serviceId: record.serviceId,
            running: true,
            ...(identity !== undefined ? { process: { pid: identity.pid, startedAt: identity.startedAt } } : {}),
          };
        });
    },
    terminals: () => {
      const terminals = input.terminals();
      if (!terminals) return [];
      return terminals.list().map((terminal) => ({
        instanceId: terminal.instanceId,
        live: terminal.lifecycle === "running",
        ...(terminal.processId !== undefined ? { process: { pid: terminal.processId, startedAt: terminal.startedAt } } : {}),
      }));
    },
    // Derived executions record no OS process yet (no spawner): they are
    // reported as live-but-unreported, so the quit plan never invents a pid.
    processTrees: () =>
      input.host.writeState().derived.map((entry) => ({ resourceId: entry.resourceId, live: true })),
    links: () => (recordOf(input)?.dirLinks ?? []).map((link) => ({ linkName: link.linkName, sourcePath: link.sourcePath })),
    observeInTaskPath: (path) => {
      try {
        const stats = lstatSync(path);
        return {
          isSymlink: stats.isSymbolicLink(),
          isDirectory: stats.isDirectory(),
          currentTarget: stats.isSymbolicLink() ? readlinkSync(path) : null,
        };
      } catch {
        return undefined;
      }
    },
    // `unlinkSync` removes exactly the directory entry (the link), never the
    // link target; `verifyLinkRemoval` already proved it is a symlink.
    removeInTaskPath: (path) => rmSync(path, { force: true }),
    originalCheckoutPaths: () => {
      const record = recordOf(input);
      if (!record) return [];
      // [T12] #147 the ORIGINAL checkout is the source repository a worktree was
      // derived from, never `record.root`: with the production task-root layout
      // `record.root` is the PARENT of every task directory, so returning it made
      // every managed worktree look like it was "inside the original checkout" and
      // the destructive cleanup refused every removal while still reporting a
      // success receipt. Records written before the source binding existed keep
      // the old fallback so nothing becomes removable that was not removable then.
      const sources = (record.repoSources ?? []).flatMap((source) =>
        [source.sourceRealPath, source.sourcePath].filter((path): path is string => typeof path === "string" && path.length > 0));
      return sources.length > 0 ? sources : [record.root];
    },
    otherTaskDirs: () => otherTaskDirs(input),
    delivery: () => deliveryOf(input),
    repoDelivery: () => repoDeliveryOf(input),
    heldLocks: () => {
      const owner = input.host.writeState().write.owner;
      return owner === null || owner.length === 0 ? [] : [{ resourceId: input.host.taskDir, owner: input.host.taskId }];
    },
    waitForIdle: () => {
      const waited: string[] = [];
      return waitForIdle(input).then((entries) => {
        waited.push(...entries);
        return [...new Set(waited)];
      });
    },
    // `git worktree remove` removes only the registered worktree's own admin
    // entry + directory; the source repository, its branches and commits stay.
    // Called only after `verifyGitResourceIdentity` matched this task's record.
    removeManagedWorktree: (repoDir) => {
      const record = recordOf(input);
      if (!record) return { ok: false, reason: "任务记录缺失，拒绝移除工作副本" };
      const registered = worktreesOf(input).some((worktree) => worktree.repoDir === repoDir);
      if (!registered) return { ok: false, reason: `${repoDir} 不在本任务登记的工作副本中，拒绝移除` };
      // [T12] #147 `git worktree remove` must run inside the repository that OWNS
      // the worktree. `record.root` is the task ROOT (the parent of every task
      // directory), not a repository, so it cannot address the worktree: use the
      // recorded source checkout first and keep the record root only as the
      // legacy fallback for records written before the source binding existed.
      const source = (record.repoSources ?? []).find((row) => join(record.taskDir, row.repoDir) === repoDir);
      const candidates = [source?.sourceRealPath, source?.sourcePath, record.root]
        .filter((path): path is string => typeof path === "string" && path.length > 0)
        .filter((path, index, all) => all.indexOf(path) === index);
      let lastError = "";
      for (const cwd of candidates) {
        try {
          execFileSync("git", ["-C", cwd, "worktree", "remove", "--force", repoDir], {
            encoding: "utf8",
            timeout: 20_000,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
            stdio: ["ignore", "pipe", "pipe"],
          });
          lastError = "";
          break;
        } catch (error) {
          const stderr = (error as { stderr?: unknown }).stderr;
          lastError = `${cwd}: ${String(stderr ?? (error instanceof Error ? error.message : error)).trim()}`;
        }
      }
      if (lastError.length > 0) return { ok: false, reason: lastError };
      if (existsSync(repoDir)) return { ok: false, reason: `${repoDir} 移除后仍然存在，保留恢复入口` };
      return { ok: true, reason: `已移除受管工作副本 ${repoDir}，原仓库 ${candidates[0] ?? ""} 保留` };
    },
    // [#117 第 5 项] No `browserPages` probe: the persistent partition is
    // main's, so page/retention facts reach the lifecycle state machine as an
    // injected observation (`TaskBrowserObservation`) on the calls that need
    // them, never as a Host-side `() => []` that reads like "nothing there".
    availableFiles: () => [],
    availableSkills: () => [],
    liveProcesses: () => (input.liveProcesses ?? readLiveProcesses)(),
    keepAndExport: (request) => keepAndExport(input, request),
    deleteSession: (sessionId) => input.host.store.deleteSession(input.host.taskDir, sessionId),
    // Usage removal reuses the Host's recorded cleanup scope (the same op the
    // statistics page calls): the removed ledger keys are persisted, so a later
    // sync cannot re-derive them from session records that a failed step left
    // behind — otherwise the details would be revived after the cleanup.
    clearUsage: () => {
      input.host.clearUsage({ kind: "all" });
    },
    delegateCleanup: (itemId) => {
      if (itemId === "terminals") {
        // Terminal records live in memory only (no spawner yet): quitting drops
        // them, so there is no persisted terminal data left for cleanup.
        return { ok: true, reason: "终端记录只在内存中，随 Host 生命周期结束，无持久数据可移除" };
      }
      return { ok: false, reason: `未接线：${itemId}` };
    },
  };
}
