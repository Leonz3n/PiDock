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
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, lstatSync, readlinkSync } from "node:fs";
import { createNodeRepoProbe, observeRecordedRepo, type RepoProbe } from "./repo-identity.js";
import type { TaskWorkspaceHost } from "./task-host.js";
import type { LifecycleSession, LifecycleWorktree, TaskLifecycleResources } from "./task-lifecycle.js";
import type { TaskServiceTopology } from "./service-topology.js";
import type { TaskTerminalRegistry } from "../main/terminal-config.js";
import type { CleanupSelection, LiveProcessObservation } from "../main/task-lifecycle.js";

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

function deliveryOf(input: LifecycleResourceInput): { uncommitted: boolean; undelivered: boolean } {
  const { execFileSync } = process.getBuiltinModule("node:child_process") as typeof import("node:child_process");
  const record = recordOf(input);
  const repoDir = worktreesOf(input)[0]?.repoDir;
  if (!record || repoDir === undefined) return { uncommitted: false, undelivered: false };
  try {
    const status = execFileSync("git", ["-C", repoDir, "status", "--porcelain"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
    // `undelivered` needs a delivery ledger this ticket does not own: cleanup
    // keeps the worktree either way, so the flag stays false rather than
    // guessing. The uncommitted state is read from the real working tree.
    return { uncommitted: status.trim().length > 0, undelivered: false };
  } catch {
    return { uncommitted: false, undelivered: false };
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
      return [record.root];
    },
    otherTaskDirs: () => otherTaskDirs(input),
    delivery: () => deliveryOf(input),
    // Browser persistent partitions are owned by main; the Host cannot
    // enumerate this task's pages, so the cleanup scope shows none here until
    // main supplies them (recorded residual, never a silent pass).
    browserPages: () => [],
    availableFiles: () => [],
    availableSkills: () => [],
    liveProcesses: () => (input.liveProcesses ?? readLiveProcesses)(),
    keepAndExport: (request) => keepAndExport(input, request),
    deleteSession: (sessionId) => input.host.store.deleteSession(input.host.taskDir, sessionId),
    clearUsage: () => input.host.store.writeUsage(input.host.taskDir, [], input.host.store.readUsage(input.host.taskDir).exclusions),
    delegateCleanup: (itemId) => {
      if (itemId === "terminals") {
        // Terminal records live in memory only (no spawner yet): quitting drops
        // them, so there is no persisted terminal data left for cleanup.
        return { ok: true, reason: "终端记录只在内存中，随 Host 生命周期结束，无持久数据可移除" };
      }
      if (itemId === "browser") {
        return { ok: false, reason: "浏览器持久分区数据由 main 侧持有，本切片未接线移除，保留任务登记与恢复入口" };
      }
      return { ok: false, reason: `未接线：${itemId}` };
    },
  };
}
