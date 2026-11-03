import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { protectApplicationProfile, type TaskPathProtection } from "../host/protected-application-path.js";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { readTaskRecordOnDisk } from "../host/task-store.js";
import type { HostTaskResult } from "../rpc/protocol.js";
import { remoteDigest } from "./remote-identity.js";
import type { WorkspaceMode } from "./workspace-files.js";
import { createDirectoryLink, linkTargetMatches } from "./directory-link.js";
import { buildLinkName, buildRepoChildName, checkLinkNameCollisions, REMOTE_NAME } from "./multi-repo-provision.js";
import type { ProjectRegistry } from "./project-registry.js";
import { buildTaskBranch, normalizeTaskPath } from "./task-provision.js";
import {
  createdRepoCount, deriveRepoState, summarizeCleanup, summarizePartialFailure,
  type CleanupResourceResult, type RepoFailure, type RepoFailureCode, type RepoObservation,
  type RepoProvisionState, type RepoSeed,
} from "./creation-repo-state.js";
import { describeFetchFailure } from "./task-append.js";
import { TaskRootIndex } from "./task-root-index.js";
import { WorktreeMetadataLock, type WorktreeLockAcquisition, type WorktreeLockOwner } from "./worktree-metadata-lock.js";

interface Source { id: string; name: string; path: string; realPath: string; device: string; inode: string }
interface Repo extends Source { remote: string; remoteBranch: string; remoteDigest: string; commonDir: string; commit: string; repoDir: string }
interface Directory extends Source { linkName: string }
export interface CreationIntent {
  id: string; taskId: string; name: string; projectId: string; projectSnapshot: string;
  root: string; rootDevice: string | null; rootInode: string | null; rootRealPath: string | null;
  taskDir: string; branch: string; repos: Repo[]; directories: Directory[];
  sharedWriteConfirmed: boolean; state: "pending" | "complete" | "abandoned";
  /**
   * [Pencil T02] #137: how this task treats its Git sources. Optional only for
   * intents written before the mode existed; `validate`/`current` migrate those
   * (worktree with repos, plain-directory without) instead of failing them.
   */
  workspaceMode?: WorkspaceMode;
  /**
   * [Pencil T08] #143: per-repository provisioning state, keyed by `repoDir`.
   * Optional so an intent written before it existed is still readable (and is
   * migrated by `validate`), and so a plain `pending`/`complete` intent that
   * never failed carries no empty object.
   */
  repoStates?: Record<string, RepoProvisionState>;
}

/** One repository as the recovery surface reads it ([Pencil T08] #143). */
export interface CreationRepoStatus extends RepoProvisionState {
  repoDir: string;
  /** Phase label the renderer shows without re-deriving anything. */
  label: string;
  /** Set when the task branch exists but no worktree holds it. */
  orphan?: { commit: string; adoptable: boolean };
}

/** Read-only per-repository recovery status of the current creation intent. */
export interface CreationStatus {
  intent: { id: string; taskId: string; name: string; taskDir: string; root: string; branch: string;
    state: "pending" | "complete" | "abandoned"; workspaceMode: WorkspaceMode } | null;
  repos: CreationRepoStatus[];
  directories: { id: string; name: string; path: string; linkName: string; linkPresent: boolean }[];
  /** True when at least one repository is really failing (the retry set). */
  canRetry: boolean;
  /** True when an adoptable orphan task branch was observed (explicit adopt). */
  canAdoptOrphans: boolean;
  /** Number of repositories whose worktree really exists (retry never re-creates them). */
  createdRepos: number;
  message: string;
}

/** Frees only identity-confirmed repositories that belong to this creation. */
export type AbandonCleanup = "keep" | "owned";

export interface CreationRequest {
  projectId: string; name: string;
  repositories: { sourceId: string; remote: string; remoteBranch: string }[];
  directoryIds: string[]; sharedWriteConfirmed: boolean; override: boolean;
  /** Absent only on a legacy caller; derived from the selected sources then. */
  workspaceMode?: WorkspaceMode;
}
export interface CreationHost {
  routeTaskOp(params: { taskId: string; op: "task/provision"; payload: Record<string, unknown> }): Promise<HostTaskResult>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILE = "task-creations.json";
function string(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256 || value.trim() !== value || value.includes("\0")) throw new Error("invalid creation value");
  return value;
}
function path(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || value.length > 4096 || value.includes("\0")) throw new Error("invalid creation path");
  return value;
}
function diskIdentity(source: string): Pick<Source, "realPath" | "device" | "inode"> {
  const stat = lstatSync(source, { bigint: true });
  if (!stat.isDirectory() || stat.dev <= 0n || stat.ino <= 0n) throw new Error("目录缺失、链接或身份不可用");
  return { realPath: realpathSync(source), device: String(stat.dev), inode: String(stat.ino) };
}
function checkSource(source: Source): void {
  const current = diskIdentity(source.path);
  if (current.device !== source.device || current.inode !== source.inode || current.realPath !== source.realPath) throw new Error("来源目录已移动或改变");
}
function overlaps(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel));
}
function checkWorkspaceOverlap(taskPath: string, repos: Repo[], directories: Directory[]): void {
  if (repos.some((repo) => overlaps(repo.realPath, taskPath) || overlaps(taskPath, repo.realPath))) throw new Error("任务工作区不能与来源仓库重叠");
  if (directories.some((dir) => overlaps(dir.realPath, taskPath) || overlaps(taskPath, dir.realPath))) throw new Error("普通目录与任务工作区重叠");
}
function syncDirectory(dir: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function pathPresent(target: string): boolean {
  try { lstatSync(target); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function matchesMarker(dir: string, marker: string, id: string): boolean {
  try { return lstatSync(dir).isDirectory() && lstatSync(join(dir, marker)).isFile() && readFileSync(join(dir, marker), "utf8") === id; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
/**
 * Ownership marker of a root this app created itself. It is written only into a
 * directory the app has just created, never into a folder it did not create, and
 * is what lets a later commit refuse a root that appeared after `prepare`.
 */
export const CREATED_ROOT_MARKER = ".pidock-created-root";
export type CreationBoundary = "root-before-mkdir" | "root-mkdir" | "root-marked" | "task-before-mkdir" | "task-mkdir" | "task-marked";
export function createOwnedDirectory(target: string, marker: string, id: string, kind: "root" | "task",
  afterBoundary?: (boundary: CreationBoundary) => void): void {
  afterBoundary?.(`${kind}-before-mkdir`);
  mkdirSync(target, { mode: 0o700 });
  afterBoundary?.(`${kind}-mkdir`);
  const fd = openSync(join(target, marker), "wx", 0o600);
  try { writeFileSync(fd, id); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(target);
  syncDirectory(dirname(target));
  afterBoundary?.(`${kind}-marked`);
}
function git(cwd: string, args: string[]): string {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { throw new Error("Git 获取或工作树创建失败，请检查远程、分支与本机仓库后重试"); }
}
/** Same invocation, but the failed call hands back stderr so a refusal can be named. */
function tryGit(cwd: string, args: string[]): { ok: true; stdout: string } | { ok: false; stderr: string } {
  try {
    return { ok: true, stdout: execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }, stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    return { ok: false, stderr: typeof stderr === "string" ? stderr.trim().slice(0, 400) : "" };
  }
}
/** `lstat` that treats "a parent is not a directory" as absent, for cleanup paths. */
function safelyPresent(target: string): boolean {
  try { lstatSync(target); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}
/** One repository's failure, carried as a code so the state can be persisted. */
class RepoFailureError extends Error {
  constructor(readonly code: RepoFailureCode, message: string) { super(message); }
}
function asRepoFailure(error: unknown, repo: Repo, fallback: RepoFailureCode, label: string): RepoFailure {
  if (error instanceof RepoFailureError) return { code: error.code, detail: error.message };
  const detail = error instanceof Error ? error.message : String(error);
  return { code: fallback, detail: `${label} ${repo.repoDir}：${detail}` };
}
/**
 * Worktrees of one source checkout that currently hold `branch`. A task branch
 * checked out elsewhere is never adopted: that would take another task's (or a
 * hand-made) checkout away.
 */
function worktreeHolders(cwd: string, branch: string): string[] {
  const holders: string[] = [];
  let current: string | null = null;
  for (const line of git(cwd, ["worktree", "list", "--porcelain"]).split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) { if (current) holders.push(current); }
    else if (line.trim() === "") current = null;
  }
  return holders;
}
/** The branch a registered worktree path is on, or null when it is not registered. */
function registeredWorktreeBranch(cwd: string, target: string): string | null {
  let wanted: string;
  try { wanted = realpathSync(target); } catch { return null; }
  const lines = git(cwd, ["worktree", "list", "--porcelain"]).split("\n");
  let current: string | null = null;
  for (const line of lines) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/") && current !== null) {
      let real: string | null = null;
      try { real = realpathSync(current); } catch { real = null; }
      if (real === wanted) return line.slice("branch refs/heads/".length);
    } else if (line.trim() === "") current = null;
  }
  return null;
}
/**
 * [Pencil T07] #142: the one fetch a worktree creation makes for one repo.
 * A failure is named by repository and branch, and states the two things the
 * creation must NOT do: reuse a stale baseline, or quietly become an
 * existing-directory task. The pin taken at `prepare` is never exchanged for
 * a cached local ref on this path.
 */
function fetchPinnedBaseline(repo: Repo): void {
  const fetched = tryGit(repo.path, ["fetch", "--no-tags", repo.remote, `refs/heads/${repo.remoteBranch}`]);
  if (!fetched.ok) {
    // [Pencil T08] #143: the same reason classification the append/resume path
    // uses (deleted branch / auth / unreachable) so the user can tell "fix the
    // branch" from "fix the credential". Unknown stderr stays generic.
    throw new RepoFailureError("WORKTREE_FETCH_FAILED",
      `获取失败（${describeFetchFailure(fetched.stderr)}）：仓库 ${repo.repoDir} 的 ${repo.remote}/${repo.remoteBranch} 未获取成功，已保留本次创建意图以便重试；未使用旧基线，也不会改用已有 Git 目录模式`);
  }
}
function optionalGit(cwd: string, args: string[]): string | null {
  try { return git(cwd, args); } catch { return null; }
}
function gitCommonDir(path: string): string {
  return realpathSync(resolve(path, git(path, ["rev-parse", "--git-common-dir"])));
}
/**
 * [Pencil T07] #142: the ACTUAL identity of the checkout this creation just
 * made/verified — real path, branch and HEAD read back from the worktree. An
 * unreadable branch is refused by name instead of being recorded as the
 * declared task branch; the observed values are what the record keeps.
 */
function observeCheckout(target: string, branch: string): { targetRealPath: string; targetBranch: string; targetHead: string } {
  let targetRealPath: string;
  try { targetRealPath = realpathSync(target); }
  catch { throw new Error(`任务工作副本路径不可读取（${target}），未创建任务记录`); }
  const head = optionalGit(target, ["rev-parse", "--verify", "HEAD"]);
  if (head === null || !/^[a-f0-9]{40}$/.test(head)) throw new Error("任务工作副本 HEAD 不可读取，未创建任务记录");
  const actual = optionalGit(target, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (actual !== branch) throw new Error(`任务工作副本不在任务分支 ${branch} 上（实际 ${actual ?? "detached"}），未创建任务记录`);
  return { targetRealPath, targetBranch: actual, targetHead: head };
}
function verifyRepo(repo: Repo): void {
  checkSource(repo);
  if (realpathSync(git(repo.path, ["rev-parse", "--show-toplevel"])) !== repo.realPath || gitCommonDir(repo.path) !== repo.commonDir) throw new Error("仓库检出身份已改变");
  if (!git(repo.path, ["remote"]).split("\n").includes(repo.remote)) throw new Error("仓库远程已改变");
  if (remoteDigest(git(repo.path, ["remote", "get-url", repo.remote])) !== repo.remoteDigest) throw new Error("仓库远程传输地址已改变");
}
function strict(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== [...fields].sort().join()) throw new Error("创建意图损坏");
  return value as Record<string, unknown>;
}
function validate(value: unknown): CreationIntent {
  const intentFields = ["id", "taskId", "name", "projectId", "projectSnapshot", "root", "rootDevice", "rootInode", "rootRealPath", "taskDir", "branch", "repos", "directories", "sharedWriteConfirmed", "state"];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("创建意图损坏");
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  // [Pencil T02] #137 / [Pencil T08] #143 migration: `workspaceMode` and
  // `repoStates` are optional additions. An intent written before them has no
  // such key and is accepted (mode migrated below, states re-derived from the
  // disk) instead of being called damaged, so an interrupted creation from an
  // earlier build stays recoverable.
  const allowed = new Set([...intentFields, "workspaceMode", "repoStates"]);
  if (keys.some((key) => !allowed.has(key)) || intentFields.some((field) => !keys.includes(field))) throw new Error("创建意图损坏");
  const legacy = !keys.includes("workspaceMode");
  const workspaceMode: WorkspaceMode = legacy
    ? (Array.isArray(row.repos) && row.repos.length > 0 ? "worktree" : "plain-dirs")
    : row.workspaceMode as WorkspaceMode;
  if (workspaceMode !== "worktree" && workspaceMode !== "existing-git" && workspaceMode !== "plain-dirs") throw new Error("创建意图损坏");
  if (!UUID.test(string(row.id)) || !UUID.test(string(row.projectId)) || !/^task-[a-f0-9]{8}$/.test(string(row.taskId)) ||
      row.taskDir !== join(path(row.root), row.taskId as string) || !["pending", "complete", "abandoned"].includes(String(row.state)) ||
      typeof row.projectSnapshot !== "string" || row.projectSnapshot.length > 65536 || typeof row.sharedWriteConfirmed !== "boolean" ||
      !((row.rootDevice === null && row.rootInode === null && row.rootRealPath === null) ||
        (typeof row.rootDevice === "string" && typeof row.rootInode === "string" && typeof row.rootRealPath === "string" && isAbsolute(row.rootRealPath))) ||
      !Array.isArray(row.repos) || row.repos.length > 30 || !Array.isArray(row.directories) || row.directories.length > 30 ||
      (!row.repos.length && !row.directories.length)) throw new Error("创建意图损坏");
  string(row.name); string(row.branch);
  for (const raw of row.repos) {
    const item = strict(raw, ["id", "name", "path", "realPath", "device", "inode", "remote", "remoteBranch", "remoteDigest", "commonDir", "commit", "repoDir"]);
    if (!UUID.test(string(item.id)) || !/^[a-f0-9]{40}$/.test(String(item.commit)) || item.repoDir !== buildRepoChildName(item.id as string)) throw new Error("仓库意图损坏");
    string(item.name); path(item.path); path(item.realPath); path(item.commonDir); string(item.device); string(item.inode); string(item.remote); string(item.remoteBranch);
    if (!/^[a-f0-9]{64}$/.test(String(item.remoteDigest))) throw new Error("远程身份意图损坏");
  }
  for (const raw of row.directories) {
    const item = strict(raw, ["id", "name", "path", "realPath", "device", "inode", "linkName"]);
    if (!UUID.test(string(item.id)) || item.linkName !== buildLinkName(item.id as string)) throw new Error("目录意图损坏");
    string(item.name); path(item.path); path(item.realPath); string(item.device); string(item.inode);
  }
  if (row.directories.length && !row.sharedWriteConfirmed) throw new Error("共享写入未经确认");
  const repos = row.repos as unknown[];
  if ((workspaceMode === "plain-dirs" && repos.length > 0) || (workspaceMode !== "plain-dirs" && repos.length === 0)) throw new Error("创建意图与工作区模式不符");
  // [Pencil T08] #143: the persisted per-repository state must keep its exact
  // shape. A failed repository must carry a named code; a created one must not
  // keep a stale failure that would read as "still failing".
  let repoStates: Record<string, RepoProvisionState> | undefined;
  if (row.repoStates !== undefined) {
    if (!row.repoStates || typeof row.repoStates !== "object" || Array.isArray(row.repoStates)) throw new Error("仓库状态损坏");
    const fields = ["repoRoot", "branch", "baseCommit", "worktreePath", "phase", "managed", "createdByPidock"];
    const codes = new Set<string>(["WORKTREE_FETCH_FAILED", "WORKTREE_BASE_CHANGED", "WORKTREE_BRANCH_ORPHANED", "WORKTREE_BRANCH_DIVERGED",
      "WORKTREE_BRANCH_HELD_ELSEWHERE", "WORKTREE_ADD_FAILED", "WORKTREE_IDENTITY_MISMATCH", "WORKTREE_SOURCE_CHANGED"]);
    const parsed: Record<string, RepoProvisionState> = {};
    for (const [repoDir, raw] of Object.entries(row.repoStates as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("仓库状态损坏");
      const state = raw as Record<string, unknown>;
      const stateKeys = Object.keys(state);
      if (stateKeys.some((key) => !fields.includes(key) && key !== "failure" && key !== "previousFailure" && key !== "repoDir") ||
          fields.some((field) => !stateKeys.includes(field))) throw new Error("仓库状态损坏");
      // `repoDir` is the map key; when the state carries it too it must agree.
      if (state.repoDir !== undefined && state.repoDir !== repoDir) throw new Error("仓库状态损坏");
      if (!["pending", "created", "failed"].includes(String(state.phase)) ||
          typeof state.managed !== "boolean" || typeof state.createdByPidock !== "boolean") throw new Error("仓库状态损坏");
      path(state.repoRoot); path(state.worktreePath); string(state.branch);
      if (!/^[a-f0-9]{40}$/.test(String(state.baseCommit))) throw new Error("仓库状态损坏");
      if (state.phase === "failed") {
        const failure = strict(state.failure, ["code", "detail"]);
        if (!codes.has(String(failure.code))) throw new Error("仓库失败代码损坏");
        string(failure.detail);
        if (state.previousFailure !== undefined) {
          const previous = strict(state.previousFailure, ["code", "detail"]);
          if (!codes.has(String(previous.code))) throw new Error("仓库失败代码损坏");
          string(previous.detail);
        }
      } else if (state.failure !== undefined || state.previousFailure !== undefined) throw new Error("仓库状态损坏");
      parsed[repoDir] = state as unknown as RepoProvisionState;
    }
    repoStates = parsed;
  }
  return { ...(value as CreationIntent), workspaceMode, ...(repoStates ? { repoStates } : {}) };
}

/** One main instance owns this file; first-write backup witnesses an initialized store. */
export class CreationIntentStore {
  private protection: TaskPathProtection | undefined;
  assertTaskPath(path: string): void {
    this.protection ??= protectApplicationProfile(this.userData);
    this.protection.assert(path);
  }
  constructor(private readonly userData: string) {}
  /** The application data directory this store writes its receipts into. */
  userDataPath(): string { return this.userData; }
  read(): CreationIntent | null {
    const file = join(this.userData, FILE);
    const regular = (name: string) => { try { if (!lstatSync(name).isFile()) throw new Error("创建意图文件已链接或损坏"); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } };
    if (!regular(file)) { if (regular(`${file}.bak`)) throw new Error("创建意图文件丢失，需要显式恢复"); return null; }
    const data = readFileSync(file);
    if (data.length > 1024 * 1024) throw new Error("创建意图过大");
    const doc = strict(JSON.parse(data.toString("utf8")), ["version", "intent"]);
    if (doc.version !== 1) throw new Error("不支持的创建意图版本");
    return doc.intent === null ? null : validate(doc.intent);
  }
  write(intent: CreationIntent): void {
    const previous = this.read();
    const file = join(this.userData, FILE), text = JSON.stringify({ version: 1, intent: validate(intent) });
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("创建意图过大");
    if (!existsSync(this.userData)) mkdirSync(this.userData, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.userData).isDirectory()) throw new Error("应用数据目录无效");
    const tmp = `${file}.${randomUUID()}.tmp`, backupTmp = `${file}.${randomUUID()}.bak.tmp`;
    const write = (name: string, content: string) => { const fd = openSync(name, "wx", 0o600); try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); } };
    const sync = () => { if (process.platform !== "win32") { const fd = openSync(this.userData, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } } };
    try {
      write(tmp, text);
      const prior = previous ? readFileSync(file, "utf8") : text;
      const doc = strict(JSON.parse(prior), ["version", "intent"]);
      if (doc.version !== 1 || (doc.intent !== null && !validate(doc.intent))) throw new Error("旧创建意图损坏");
      try {
        if (!lstatSync(`${file}.bak`).isFile()) throw new Error("创建意图备份损坏");
        const backup = strict(JSON.parse(readFileSync(`${file}.bak`, "utf8")), ["version", "intent"]);
        if (backup.version !== 1 || (backup.intent !== null && !validate(backup.intent))) throw new Error("创建意图备份损坏");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      write(backupTmp, prior); renameSync(backupTmp, `${file}.bak`); sync();
      renameSync(tmp, file); sync();
    } finally { rmSync(tmp, { force: true }); rmSync(backupTmp, { force: true }); }
  }
  hasAbandonReceipt(intent: CreationIntent): boolean {
    const file = join(this.userData, `task-creation-abandon-${intent.id}.json`);
    if (!pathPresent(file)) return false;
    if (!lstatSync(file).isFile()) throw new Error("放弃创建凭据损坏");
    const existing = strict(JSON.parse(readFileSync(file, "utf8")), ["version", "intentId", "taskId", "projectId", "root", "taskDir", "reason", "at"]);
    if (existing.version !== 1 || existing.intentId !== intent.id || existing.taskId !== intent.taskId ||
        existing.projectId !== intent.projectId || existing.root !== intent.root || existing.taskDir !== intent.taskDir ||
        existing.reason !== "operator-abandon" || typeof existing.at !== "string" || !Number.isFinite(Date.parse(existing.at))) {
      throw new Error("放弃创建凭据损坏");
    }
    return true;
  }
  /**
   * The `.pidock-creation` marker this intent may remove: present only when the
   * task path really is this creation's own directory and the marker is a regular
   * file whose content is this intent's id. Anything else (another creation's
   * marker, a symlink, a file where the directory should be) is not this
   * creation's to touch and is left exactly as it is: a pending intent that
   * cannot be committed must still be terminal, so this never refuses.
   */
  private ownedCreationMarker(intent: CreationIntent): string | null {
    const marker = join(intent.taskDir, ".pidock-creation");
    try { return matchesMarker(intent.taskDir, ".pidock-creation", intent.id) ? marker : null; }
    catch { return null; }
  }
  async abandon(intent: CreationIntent): Promise<void> {
    if (intent.state !== "pending" && intent.state !== "abandoned") throw new Error("不能放弃已完成的任务");
    const file = join(this.userData, `task-creation-abandon-${intent.id}.json`);
    if (!this.hasAbandonReceipt(intent)) {
      const receipt = { version: 1, intentId: intent.id, taskId: intent.taskId, projectId: intent.projectId,
        root: intent.root, taskDir: intent.taskDir, reason: "operator-abandon", at: new Date().toISOString() };
      const fd = openSync(file, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(receipt)); fsyncSync(fd); } finally { closeSync(fd); }
      syncDirectory(this.userData);
    }
    if (intent.state === "pending") {
      const marker = this.ownedCreationMarker(intent);
      if (marker) {
        unlinkSync(marker);
        syncDirectory(intent.taskDir);
      }
      this.write({ ...intent, state: "abandoned" });
    }
  }
}

/** The intent is the recovery authority; success is exposed only after all three records agree. */
export class ProjectTaskCreation {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: CreationIntentStore, private readonly projects: ProjectRegistry,
    private readonly roots: TaskRootIndex, private readonly host: CreationHost, private readonly defaultRoot: string,
    private readonly afterBoundary?: (boundary: CreationBoundary) => void,
    private readonly lock?: WorktreeMetadataLock) {}
  private run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action); this.queue = result.catch(() => undefined); return result;
  }
  /**
   * The repository-level mutual exclusion of [PiDock 03] (#6 盒子 9), keyed by
   * the REAL path of each shared source repository. Without a wired lock this
   * instance has only its intra-process queue — the pre-box-9 behaviour, which
   * production never uses: `main.ts` wires the app-private lock into every
   * creation/append service. The key is resolved from the live filesystem
   * (`WorktreeMetadataLock.acquireFor` realpaths each source), and a source
   * whose real path cannot be resolved refuses by name instead of running
   * unlocked.
   */
  private acquireWorktreeLock(sources: readonly string[], owner: WorktreeLockOwner): WorktreeLockAcquisition {
    if (!this.lock) return { ok: true, keys: [], release: () => undefined };
    return this.lock.acquireFor(sources, owner);
  }
  current(): CreationIntent | null {
    const intent = this.store.read();
    if (intent?.state === "abandoned") {
      if (!this.store.hasAbandonReceipt(intent)) throw new Error("放弃创建凭据丢失，需要显式恢复");
      return null;
    }
    return intent;
  }
  abandon(id: string, confirmed: boolean, cleanup: AbandonCleanup = "keep"): Promise<{ taskId: string; abandoned: true; message: string;
    /** Present only for an `owned` cleanup: one row per resource, really touched or really kept. */
    cleanup?: CleanupResourceResult[] }> {
    return this.run(async () => {
      if (confirmed !== true) throw new Error("放弃本次创建需要显式确认");
      if (cleanup !== "keep" && cleanup !== "owned") throw new Error("放弃创建的清理范围无效");
      const intent = this.store.read();
      if (!intent || intent.id !== id) throw new Error("创建意图已改变，请重新读取");
      if (intent.state === "complete") throw new Error("已完成任务不能放弃");
      if (intent.state === "abandoned" && !this.store.hasAbandonReceipt(intent)) throw new Error("放弃创建凭据丢失，需要显式恢复");
      this.store.assertTaskPath(intent.taskDir);
      // #88: every reason this creation may not abandon its own intent is checked
      // BEFORE the durable abandon receipt is written. The receipt forecloses
      // `commit` ("放弃创建凭据已写入，只能继续放弃"), so refusing after writing it
      // would leave a task that can neither be committed nor abandoned.
      if (intent.state === "pending") {
        const association = this.projects.association(intent.taskId, this.roots);
        if (association.state === "assigned") {
          // This creation did not make the association, so it does not undo it:
          // the codebase never re-associates (or de-associates) a task on its own
          // (`commit` refuses with "不自动重新归属" for the same reason). The user
          // has the real control, so the refusal names it instead of acting.
          throw new Error(`该任务已关联到项目 ${association.projectId}，放弃本次创建不会替你解除关联；请先在「项目管理」里解绑该任务，再放弃本次创建`);
        }
        if (association.state !== "unassigned" && association.state !== "unavailable") {
          throw new Error("任务归属身份需要人工修复，未能放弃本次创建");
        }
      }
      // [Pencil T08] #143: the ownership proof is captured BEFORE the receipt
      // and the `.pidock-creation` marker are written away, so a cleanup can
      // only ever touch resources this creation really made.
      const ownedTaskDir = this.ownsTaskDir(intent);
      await this.store.abandon(intent);
      const cleanupResults = cleanup === "owned" ? this.removeOwnedResources(intent, ownedTaskDir) : [];
      if (cleanup === "owned") this.writeCleanupReceipt(intent, cleanupResults);
      return { taskId: intent.taskId, abandoned: true, ...(cleanup === "owned" ? { cleanup: cleanupResults } : {}),
        message: summarizeCleanup(cleanupResults, cleanup) };
    });
  }
  /**
   * Ownership of the task folder itself: the `.pidock-creation` marker is a
   * regular file whose content is THIS intent's id. Anything else (another
   * creation's marker, a symlink, a real user folder in the way) is not ours,
   * and every cleanup below is refused for it.
   */
  private ownsTaskDir(intent: CreationIntent): boolean {
    try { return matchesMarker(intent.taskDir, ".pidock-creation", intent.id); }
    catch { return false; }
  }
  /**
   * Remove only resources whose ownership AND identity are confirmed: a
   * worktree registered in this source repository at this task path and on the
   * task branch, the task branch itself only while it sits on the pinned
   * commit and no worktree holds it, an in-task link whose target is still the
   * recorded source, the task folder only when only owned files remain, and
   * the created root only when it is empty. The user's source checkout is
   * never a target: every path is inside the task folder or the root.
   *
   * A per-resource failure is reported and does not abort the rest: the state
   * stays explainable (which resource is left, and why).
   */
  private removeOwnedResources(intent: CreationIntent, ownedTaskDir: boolean): CleanupResourceResult[] {
    const results: CleanupResourceResult[] = [];
    if (!ownedTaskDir) {
      return [{ resource: "任务目录", path: intent.taskDir, action: "kept", reason: "任务创建标记不匹配，拒绝清理任何资源" }];
    }
    if (intent.workspaceMode !== "existing-git") {
      for (const repo of intent.repos) {
        const target = join(intent.taskDir, repo.repoDir);
        const worktreeResource = `工作树 ${repo.repoDir}`;
        if (!safelyPresent(target)) continue;
        const registered = (() => { try { return registeredWorktreeBranch(repo.path, target); } catch { return null; } })();
        if (registered !== intent.branch) {
          // A failed `worktree add` can leave an EMPTY folder behind. It is
          // inside this creation's own task folder and holds nothing, so it is
          // removed; anything else at that path is kept and named.
          try {
            if (readdirSync(target).length === 0) { rmdirSync(target); results.push({ resource: worktreeResource, path: target, action: "removed" }); continue; }
          } catch { /* fall through to the kept row */ }
          results.push({ resource: worktreeResource, path: target, action: "kept", reason: "未登记在来源仓库的任务分支上，无法确认归属" });
          continue;
        }
        const removed = tryGit(repo.path, ["worktree", "remove", target]);
        if (!removed.ok) {
          results.push({ resource: worktreeResource, path: target, action: "failed",
            reason: `${removed.stderr || "工作树含未提交改动"}；可人工处理后重试清理` });
          continue;
        }
        results.push({ resource: worktreeResource, path: target, action: "removed" });
        const branchResource = `任务分支 ${intent.branch}`;
        const ref = optionalGit(repo.path, ["show-ref", "--verify", "--hash", `refs/heads/${intent.branch}`]);
        if (ref === null) continue;
        if (ref !== repo.commit) {
          results.push({ resource: branchResource, path: repo.path, action: "kept", reason: "分支已不在固定提交上（可能含用户提交）" });
          continue;
        }
        if (worktreeHolders(repo.path, intent.branch).length > 0) {
          results.push({ resource: branchResource, path: repo.path, action: "kept", reason: "分支仍被工作树占用" });
          continue;
        }
        const deleted = tryGit(repo.path, ["branch", "-D", intent.branch]);
        results.push(deleted.ok
          ? { resource: branchResource, path: repo.path, action: "removed" }
          : { resource: branchResource, path: repo.path, action: "failed", reason: deleted.stderr || "删除任务分支失败" });
      }
    }
    for (const dir of intent.directories) {
      const target = join(intent.taskDir, dir.linkName);
      const resource = `目录链接 ${dir.linkName}`;
      try {
        if (!lstatSync(target).isSymbolicLink()) { results.push({ resource, path: target, action: "kept", reason: "不是本应用建立的链接" }); continue; }
        if (!linkTargetMatches(readlinkSync(target), dir.path)) { results.push({ resource, path: target, action: "kept", reason: "链接目标已改变" }); continue; }
        unlinkSync(target);
        results.push({ resource, path: target, action: "removed" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        results.push({ resource, path: target, action: "failed", reason: error instanceof Error ? error.message : String(error) });
      }
    }
    // The task folder is removed only when nothing but this creation's own
    // marker remains: a folder still holding a worktree that could not be
    // removed (or a task record) is left and named.
    try {
      const remaining = readdirSync(intent.taskDir).filter((name) => name !== ".pidock-creation");
      if (remaining.length > 0) {
        results.push({ resource: "任务目录", path: intent.taskDir, action: "kept", reason: `仍含 ${remaining.length} 个未清理项：${remaining.slice(0, 5).join("、")}` });
      } else {
        // The abandon receipt already removed the ownership marker; only an
        // empty task folder is removed here, never one that still holds work.
        rmSync(join(intent.taskDir, ".pidock-creation"), { force: true });
        rmdirSync(intent.taskDir);
        results.push({ resource: "任务目录", path: intent.taskDir, action: "removed" });
        if (intent.rootDevice !== null && matchesMarker(intent.root, CREATED_ROOT_MARKER, intent.id)) {
          try {
            if (readdirSync(intent.root).length === 0) { rmdirSync(intent.root); results.push({ resource: "任务根", path: intent.root, action: "removed" }); }
            else results.push({ resource: "任务根", path: intent.root, action: "kept", reason: "任务根内仍有其它内容" });
          } catch { /* the root is not this cleanup's problem */ }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        results.push({ resource: "任务目录", path: intent.taskDir, action: "failed", reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  }
  /** Per-resource cleanup receipt, so a partial cleanup stays explainable after a restart. */
  private writeCleanupReceipt(intent: CreationIntent, results: CleanupResourceResult[]): void {
    const file = join(this.store.userDataPath(), `task-creation-cleanup-${intent.id}.json`);
    const payload = JSON.stringify({ version: 1, intentId: intent.id, taskId: intent.taskId,
      removed: results.filter((row) => row.action === "removed").map((row) => row.resource),
      kept: results.filter((row) => row.action === "kept").map((row) => ({ resource: row.resource, reason: row.reason ?? "" })),
      failed: results.filter((row) => row.action === "failed").map((row) => ({ resource: row.resource, reason: row.reason ?? "" })),
      partialFailure: results.some((row) => row.action === "failed"), at: new Date().toISOString() });
    const tmp = `${file}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, "wx", 0o600);
    try { writeFileSync(fd, payload); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
    syncDirectory(this.store.userDataPath());
  }
  prepare(input: CreationRequest, selectedRoot?: string): Promise<CreationIntent> {
    return this.run(async () => {
      const prior = this.store.read();
      if (prior?.state === "pending") throw new Error("已有待完成的任务，请先恢复");
      if (prior?.state === "abandoned" && !this.store.hasAbandonReceipt(prior)) throw new Error("放弃创建凭据丢失，需要显式恢复");
      const project = this.projects.get(input.projectId);
      if (!project) throw new Error("项目已删除或不可读取");
      if (!Array.isArray(input.repositories) || input.repositories.length > 30 ||
          !Array.isArray(input.directoryIds) || input.directoryIds.length > 30) throw new Error("当前创建流程至少需要选择一个仓库或目录");
      if (input.directoryIds.length && input.sharedWriteConfirmed !== true) throw new Error("请确认普通目录的共享写入风险");
      // [Pencil T02] #137: the task workspace mode is enforced HERE, in main.
      // A UI that never selected a mode keeps the legacy default, but an
      // explicit mode is validated against the selected sources: plain-dirs
      // refuses Git repos, and the two Git modes refuse an empty repo list.
      const mode: WorkspaceMode = input.workspaceMode ?? (input.repositories.length > 0 ? "worktree" : "plain-dirs");
      if (mode !== "worktree" && mode !== "existing-git" && mode !== "plain-dirs") throw new Error("任务工作区模式无效");
      if (mode === "plain-dirs" && input.repositories.length > 0) throw new Error("仅普通目录模式不接受 Git 仓库来源，请改用独立 Worktree 或已有 Git 目录模式");
      if (mode === "existing-git" && input.repositories.length === 0) throw new Error("已有 Git 目录模式至少需要一个已登记的 Git 仓库来源");
      if (mode === "worktree" && input.repositories.length === 0) throw new Error("独立 Worktree 模式至少需要一个已登记的 Git 仓库来源；仅普通目录请选择「仅普通目录」模式");
      if (!input.repositories.length && !input.directoryIds.length) throw new Error("当前创建流程至少需要选择一个仓库或目录");
      if (input.override !== (selectedRoot !== undefined)) throw new Error("任务根选择结果与请求不符");
      const name = string(input.name), root = path(selectedRoot ?? this.defaultRoot);
      this.store.assertTaskPath(root);
      for (const selected of input.repositories) {
        const source = project.repositories.find((row) => row.id === selected?.sourceId);
        if (source) this.store.assertTaskPath(source.path);
      }
      for (const id of input.directoryIds) {
        const source = project.directories.find((row) => row.id === id);
        if (source) this.store.assertTaskPath(source.path);
      }
      if (!this.roots.isRootAvailable(root)) throw new Error("任务根身份不可读取，请先修复后创建");
      const rootIdentity = existsSync(root) ? diskIdentity(root) : null;
      if (!rootIdentity) diskIdentity(dirname(root));
      const repoIds = new Set<string>(), dirIds = new Set<string>(), commonDirs = new Set<string>();
      const repos: Repo[] = input.repositories.map((selection) => {
        if (!selection || !UUID.test(string(selection.sourceId)) || repoIds.has(selection.sourceId)) throw new Error("仓库选择重复或无效");
        repoIds.add(selection.sourceId);
        const source = project.repositories.find((row) => row.id === selection.sourceId);
        if (!source) throw new Error("项目仓库已改变");
        const remote = string(selection.remote);
        if (!REMOTE_NAME.test(remote)) throw new Error("远程名称无效");
        const repo: Repo = { ...source, ...diskIdentity(source.path), remote, remoteBranch: "",
          commonDir: gitCommonDir(source.path), remoteDigest: remoteDigest(git(source.path, ["remote", "get-url", remote])),
          commit: "0".repeat(40), repoDir: buildRepoChildName(source.id) };
        if (commonDirs.has(repo.commonDir)) throw new Error("所选仓库属于同一 Git 仓库，请仅选择一个工作树");
        commonDirs.add(repo.commonDir);
        if (mode === "existing-git") {
          // Existing-Git-dir mode ([Pencil T02] #137) uses the registered
          // checkout IN PLACE: no fetch, no `ls-remote`, no worktree, no task
          // branch. The recorded facts are the checkout's real current branch
          // and observed HEAD; uncommitted work stays exactly as it is.
          const branch = optionalGit(source.path, ["symbolic-ref", "--short", "-q", "HEAD"]);
          if (branch === null || branch.length === 0) throw new Error("已有 Git 目录不在任何本地分支上（分离头指针或空仓库），无法记录任务分支");
          const head = optionalGit(source.path, ["rev-parse", "--verify", "HEAD"]);
          if (head === null || !/^[a-f0-9]{40}$/.test(head)) throw new Error("已有 Git 目录没有可记录的提交");
          repo.remoteBranch = branch;
          repo.commit = head;
          verifyRepo(repo);
          return repo;
        }
        const remoteBranch = string(selection.remoteBranch);
        git(source.path, ["check-ref-format", `refs/heads/${remoteBranch}`]);
        repo.remoteBranch = remoteBranch;
        verifyRepo(repo);
        const [commit, ref] = git(repo.path, ["ls-remote", "--exit-code", repo.remote, `refs/heads/${remoteBranch}`]).split(/\s+/);
        if (!/^[a-f0-9]{40}$/.test(commit ?? "") || ref !== `refs/heads/${remoteBranch}`) throw new Error("远程分支不可用");
        repo.commit = commit!; return repo;
      });
      const directories: Directory[] = input.directoryIds.map((sourceId) => {
        if (!UUID.test(string(sourceId)) || dirIds.has(sourceId)) throw new Error("目录选择重复或无效");
        dirIds.add(sourceId);
        const source = project.directories.find((row) => row.id === sourceId);
        if (!source) throw new Error("项目普通目录已改变");
        return { ...source, ...diskIdentity(source.path), linkName: buildLinkName(sourceId) };
      });
      if (!checkLinkNameCollisions([...dirIds]).ok || new Set(repos.map((row) => row.repoDir)).size !== repos.length) throw new Error("任务来源名称冲突");
      let taskId: string;
      do { taskId = `task-${randomUUID().replace(/-/g, "").slice(0, 8)}`; }
      while (existsSync(join(root, taskId)) || this.roots.inventory().tasks.some((row) => row.taskId === taskId));
      const realRoot = rootIdentity?.realPath ?? join(realpathSync(dirname(root)), basename(root));
      checkWorkspaceOverlap(join(realRoot, taskId), repos, directories);
      const branch = buildTaskBranch(taskId);
      if (!branch.ok) throw new Error(branch.error.message);
      const intent: CreationIntent = { id: randomUUID(), taskId, name, projectId: project.id, projectSnapshot: JSON.stringify(project),
        root, rootDevice: rootIdentity?.device ?? null, rootInode: rootIdentity?.inode ?? null, rootRealPath: rootIdentity?.realPath ?? null,
        taskDir: join(root, taskId), branch: branch.branch, repos, directories,
        sharedWriteConfirmed: input.sharedWriteConfirmed === true, state: "pending", workspaceMode: mode };
      this.store.write(intent);
      return intent;
    });
  }
  commit(id: string): Promise<{ taskId: string; projectId: string }> {
    return this.run(async () => {
      const intent = this.store.read();
      if (!intent || intent.id !== id) throw new Error("创建意图已改变，请重新读取");
      return this.commitIntent(intent, false);
    });
  }
  /**
   * [Pencil T08] #143 recovery entry point: retry the repositories that are
   * still failing. The retry set is proven from the disk (a repository whose
   * worktree already exists and matches is `created` and is NOT touched), so a
   * retry never re-creates a successful copy. `adoptOrphanBranches` is the
   * explicit choice for a task branch that exists without a worktree; without
   * it the orphan stays a named refusal with both options spelled out.
   */
  retry(id: string, adoptOrphanBranches = false): Promise<{ taskId: string; projectId: string; retried: string[] }> {
    return this.run(async () => {
      const intent = this.store.read();
      if (!intent || intent.id !== id) throw new Error("创建意图已改变，请重新读取");
      const status = this.statusOf(intent);
      if (!status.canRetry) throw new Error("当前创建的所有仓库都已创建，无需重试；请直接提交或放弃本次创建");
      const retried = status.repos.filter((row) => row.phase === "failed").map((row) => row.repoDir);
      const result = await this.commitIntent(intent, adoptOrphanBranches);
      return { ...result, retried };
    });
  }
  /** Read-only per-repository recovery state of the pending creation. */
  status(): Promise<CreationStatus> {
    return this.run(async () => {
      const intent = this.store.read();
      if (!intent) {
        return { intent: null, repos: [], directories: [], canRetry: false, canAdoptOrphans: false, createdRepos: 0, message: "没有待重建的任务" };
      }
      return this.statusOf(intent);
    });
  }
  /**
   * Derive every repository's state from what the disk really says now, with the
   * persisted state as the restart fallback. Nothing is fabricated: a repository
   * that was never attempted stays `pending`, one whose worktree was made stays
   * `created`, and one that failed keeps its named code after a restart.
   */
  private statusOf(intent: CreationIntent): CreationStatus {
    const seed = (repo: Repo): RepoSeed => ({ repoDir: repo.repoDir, repoRoot: repo.path, branch: intent.branch,
      baseCommit: repo.commit, worktreePath: join(intent.taskDir, repo.repoDir), createdByPidock: true });
    const observations = new Map<string, RepoObservation>();
    for (const repo of intent.repos) observations.set(repo.repoDir, this.observeRepo(intent, repo));
    const repos: CreationRepoStatus[] = intent.repos.map((repo) => {
      const observation = observations.get(repo.repoDir);
      const recorded = intent.repoStates?.[repo.repoDir];
      const state = deriveRepoState(seed(repo), recorded, observation);
      return { ...state,
        ...(recorded?.previousFailure && recorded.previousFailure.code !== state.failure?.code
          ? { previousFailure: recorded.previousFailure } : {}), repoDir: repo.repoDir, label: state.phase === "created" ? "已创建" : state.phase === "failed" ? "失败" : "待准备",
        ...(observation?.orphan ? { orphan: observation.orphan } : {}) };
    });
    // An interrupted creation (a crash before any repository was attempted) and
    // a partial one (some repositories failed) both have work left: `canRetry`
    // means "not every repository is created", never "at least one failed".
    const canRetry = repos.some((row) => row.phase !== "created");
    const anyFailed = repos.some((row) => row.phase === "failed");
    const canAdoptOrphans = repos.some((row) => row.orphan?.adoptable === true);
    return {
      intent: { id: intent.id, taskId: intent.taskId, name: intent.name, taskDir: intent.taskDir, root: intent.root,
        branch: intent.branch, state: intent.state, workspaceMode: intent.workspaceMode ?? "worktree" },
      repos,
      directories: intent.directories.map((dir) => ({ id: dir.id, name: dir.name, path: dir.path, linkName: dir.linkName,
        linkPresent: (() => { try { return lstatSync(join(intent.taskDir, dir.linkName)).isSymbolicLink(); } catch { return false; } })() })),
      canRetry,
      canAdoptOrphans,
      createdRepos: createdRepoCount(repos),
      message: anyFailed
        ? summarizePartialFailure(repos.map((row) => ({ repoDir: row.repoDir, state: row })))
        : canRetry ? "创建被中断：仓库工作副本尚未全部准备，可继续创建" : "本次创建的仓库工作副本均已准备好",
    };
  }
  /** Real, read-only observation of one repository's worktree/branch state. */
  private observeRepo(intent: CreationIntent, repo: Repo): RepoObservation {
    if (intent.workspaceMode === "existing-git") return { worktreeIdentityOk: true };
    const target = join(intent.taskDir, repo.repoDir);
    if (pathPresent(target)) {
      try {
        if (!lstatSync(target).isDirectory() || realpathSync(target) !== join(realpathSync(intent.taskDir), repo.repoDir) ||
            git(target, ["merge-base", "--is-ancestor", repo.commit, "HEAD"]) !== "" ||
            git(target, ["symbolic-ref", "--quiet", "HEAD"]) !== `refs/heads/${intent.branch}` || gitCommonDir(target) !== repo.commonDir) {
          return { worktreeIdentityOk: false, failure: { code: "WORKTREE_IDENTITY_MISMATCH",
            detail: `工作树 ${target} 与固定任务提交或来源不同，需要明确修复` } };
        }
        return { worktreeIdentityOk: true };
      } catch (error) {
        return { worktreeIdentityOk: false, failure: { code: "WORKTREE_IDENTITY_MISMATCH",
          detail: `工作树 ${target} 不可读取：${error instanceof Error ? error.message : String(error)}` } };
      }
    }
    const ref = optionalGit(repo.path, ["show-ref", "--verify", "--hash", `refs/heads/${intent.branch}`]);
    if (ref === null) return { worktreeIdentityOk: false };
    let holders: string[] = [];
    try { holders = worktreeHolders(repo.path, intent.branch); } catch { holders = []; }
    if (holders.length > 0) {
      return { worktreeIdentityOk: false, failure: { code: "WORKTREE_BRANCH_HELD_ELSEWHERE",
        detail: `任务分支已存在（${intent.branch}）且已被工作树 ${holders.join("、")} 占用，拒绝接管` } };
    }
    return { worktreeIdentityOk: false, orphan: { commit: ref, adoptable: ref === repo.commit } };
  }
  private async commitIntent(intent: CreationIntent, adoptOrphanBranches: boolean): Promise<{ taskId: string; projectId: string }> {
    {
      if (intent.state === "abandoned") throw new Error("创建意图已放弃；本次没有删除任务目录、工作区、链接或会话，已有任务记录现为未归属任务。请重新创建任务");
      this.store.assertTaskPath(intent.taskDir);
      for (const source of [...intent.repos, ...intent.directories]) this.store.assertTaskPath(source.path);
      if (this.store.hasAbandonReceipt(intent)) throw new Error("放弃创建凭据已写入，只能继续放弃，不能提交原任务；继续放弃会保留已产生的任务内容，并将已有任务记录置为未归属。");
      if (intent.state === "complete") {
        const association = this.projects.association(intent.taskId, this.roots);
        if (association.state !== "assigned" || association.projectId !== intent.projectId) throw new Error("任务归属需要修复");
        return { taskId: intent.taskId, projectId: intent.projectId };
      }
      const checkProject = () => {
        const current = this.projects.get(intent.projectId);
        if (!current) throw new Error("项目在准备后已删除或不可读取，无法按原意图续跑；可显式放弃本次创建（不清理已产生的任务内容；已有任务记录将保留为未归属任务），恢复或重新建立项目后再创建。");
        if (JSON.stringify(current) !== intent.projectSnapshot) {
          throw new Error("项目或其来源在准备后被改动，无法按原快照续跑；可先恢复到准备时状态后重试，或显式放弃本次创建（不清理已产生的任务目录、工作区、链接与会话；已有任务记录将成为未归属任务），再用该项目重新创建。");
        }
      };
      checkProject();
      // [PiDock 03] (#6 盒子 9) the repository-level critical section: every
      // shared source repo of this intent is locked by its REAL path before
      // anything is created, so the conflict scan (the missing-repo validation
      // below: target folder, `FETCH_HEAD` pin, task-branch ref) AND the real
      // `git worktree add` run inside ONE cross-process critical section. A
      // competing process creating a task in the same source repository is
      // refused BY NAME here, before this commit creates any directory, fetch,
      // branch, worktree or record.
      const acquisition = this.acquireWorktreeLock(intent.repos.map((repo) => repo.path), { taskId: intent.taskId, label: "创建任务" });
      if (!acquisition.ok) throw new Error(acquisition.error);
      // Observed identity of every task worktree, keyed by repoDir: filled only
      // from a real read of the created checkout, never derived from the pin.
      const checkoutIdentities: Record<string, { targetRealPath: string; targetBranch: string; targetHead: string }> = {};
      try {
        if (intent.rootDevice === null) {
          if (!pathPresent(intent.root)) {
            diskIdentity(dirname(intent.root));
            createOwnedDirectory(intent.root, CREATED_ROOT_MARKER, intent.id, "root", this.afterBoundary);
          } else if (!matchesMarker(intent.root, CREATED_ROOT_MARKER, intent.id)) {
            throw new Error("任务根在准备后被建立，不能接管；需要显式恢复");
          }
          const fresh = diskIdentity(intent.root);
          intent.rootDevice = fresh.device; intent.rootInode = fresh.inode; intent.rootRealPath = fresh.realPath;
          this.store.write(intent);
        }
        const rootIdentity = diskIdentity(intent.root);
        if (rootIdentity.device !== intent.rootDevice || rootIdentity.inode !== intent.rootInode || rootIdentity.realPath !== intent.rootRealPath) throw new Error("任务根身份已改变");
        for (const repo of intent.repos) {
          verifyRepo(repo);
          if (intent.workspaceMode === "existing-git") {
            // Re-verify the source binding before anything is recorded: the
            // branch must be the one prepared against, and the HEAD snapshot is
            // re-read (a commit made in the meantime is legitimate observed
            // work, never rewritten). No fetch/pull/merge/reset/stash ever runs.
            const branch = optionalGit(repo.path, ["symbolic-ref", "--short", "-q", "HEAD"]);
            if (branch !== repo.remoteBranch) throw new Error("已有 Git 目录的当前分支在准备后已改变，无法按原来源创建；请重新创建任务");
            const head = optionalGit(repo.path, ["rev-parse", "--verify", "HEAD"]);
            if (head === null || !/^[a-f0-9]{40}$/.test(head)) throw new Error("已有 Git 目录的 HEAD 不可读取，无法记录任务事实");
            repo.commit = head;
          }
        }
        const taskRealPath = join(realpathSync(intent.root), intent.taskId);
        checkWorkspaceOverlap(taskRealPath, intent.repos, intent.directories);
        for (const dir of intent.directories) checkSource(dir);
        if (!pathPresent(intent.taskDir)) {
          createOwnedDirectory(intent.taskDir, ".pidock-creation", intent.id, "task", this.afterBoundary);
        } else if (!matchesMarker(intent.taskDir, ".pidock-creation", intent.id)) {
          throw new Error("任务目录已占用或创建标记不匹配");
        }
        // Validate every missing repository's fresh fetch before creating any new worktree.
        // Existing-Git-dir mode has no worktree phase at all: it never creates
        // `.worktrees/`, a task branch or a checkout in the original.
        // [Pencil T08] #143: each repository is its own unit. A repository whose
        // worktree already exists and matches is `created` and is never fetched
        // or re-created; the failing ones carry a named code. Phase 1 validates
        // every missing repository's fresh fetch, pin and task-branch state
        // before ANY new worktree is made (a fetch failure still creates
        // nothing), phase 2 makes the worktrees independently so one failure
        // leaves the successful copies in place.
        const worktreeRepos = intent.workspaceMode === "existing-git" ? [] : intent.repos;
        const repoStates: Record<string, RepoProvisionState> = { ...(intent.repoStates ?? {}) };
        const seedOf = (repo: Repo): RepoSeed => ({ repoDir: repo.repoDir, repoRoot: repo.path, branch: intent.branch,
          baseCommit: repo.commit, worktreePath: join(intent.taskDir, repo.repoDir), createdByPidock: true });
        const failures: RepoFailure[] = [];
        const recordFailure = (repo: Repo, failure: RepoFailure): void => {
          failures.push(failure);
          // A different failure on a retry is recorded ALONGSIDE the earlier
          // one: the original evidence is never silently replaced.
          const prior = repoStates[repo.repoDir]?.failure;
          repoStates[repo.repoDir] = { ...seedOf(repo), phase: "failed", failure,
            ...(prior && prior.code !== failure.code ? { previousFailure: prior } : {}), managed: true, createdByPidock: true };
        };
        const recordCreated = (repo: Repo): void => {
          repoStates[repo.repoDir] = { ...seedOf(repo), phase: "created", managed: true, createdByPidock: true };
        };
        const refuseIfFailed = (): void => {
          if (failures.length === 0) return;
          intent.repoStates = repoStates;
          this.store.write(intent);
          throw new Error(summarizePartialFailure(worktreeRepos.map((repo) => ({ repoDir: repo.repoDir,
            state: repoStates[repo.repoDir] ?? deriveRepoState(seedOf(repo), undefined, undefined) }))));
        };
        const missingRepos: Repo[] = [];
        const adoptableOrphans: Repo[] = [];
        for (const repo of worktreeRepos) {
          const target = join(intent.taskDir, repo.repoDir);
          if (existsSync(target)) {
            try {
              if (!lstatSync(target).isDirectory() || realpathSync(target) !== join(realpathSync(intent.taskDir), repo.repoDir) ||
                  git(target, ["merge-base", "--is-ancestor", repo.commit, "HEAD"]) !== "" ||
                  git(target, ["symbolic-ref", "--quiet", "HEAD"]) !== `refs/heads/${intent.branch}` || gitCommonDir(target) !== repo.commonDir) {
                throw new RepoFailureError("WORKTREE_IDENTITY_MISMATCH", `工作树与固定任务提交不符（${repo.repoDir}）`);
              }
              recordCreated(repo);
              continue;
            } catch (error) { recordFailure(repo, asRepoFailure(error, repo, "WORKTREE_IDENTITY_MISMATCH", "工作树校验失败")); continue; }
          }
          try {
            fetchPinnedBaseline(repo);
            if (git(repo.path, ["rev-parse", "FETCH_HEAD"]) !== repo.commit) {
              throw new RepoFailureError("WORKTREE_BASE_CHANGED", `远程分支已变化，不使用旧基线（${repo.repoDir} 的 ${repo.remote}/${repo.remoteBranch}）`);
            }
            const existing = optionalGit(repo.path, ["show-ref", "--verify", "--hash", `refs/heads/${intent.branch}`]);
            if (existing !== null) {
              if (existing !== repo.commit) {
                throw new RepoFailureError("WORKTREE_BRANCH_DIVERGED", `任务分支已存在（${intent.branch}）但不在固定提交 ${repo.commit} 上（实际 ${existing}），拒绝接管`);
              }
              const holders = worktreeHolders(repo.path, intent.branch);
              if (holders.length > 0) {
                throw new RepoFailureError("WORKTREE_BRANCH_HELD_ELSEWHERE", `任务分支已存在（${intent.branch}）且已被工作树 ${holders.join("、")} 占用，拒绝接管`);
              }
              if (adoptOrphanBranches !== true) {
                throw new RepoFailureError("WORKTREE_BRANCH_ORPHANED", `任务分支已存在（${intent.branch}）但工作树不在 ${target}；可显式接管该分支（同一固定提交）、或放弃本次创建并清理该分支，不会自动接管`);
              }
              adoptableOrphans.push(repo);
              continue;
            }
            missingRepos.push(repo);
          } catch (error) { recordFailure(repo, asRepoFailure(error, repo, "WORKTREE_FETCH_FAILED", "获取或校验失败")); }
        }
        refuseIfFailed();
        for (const repo of missingRepos) {
          try { git(repo.path, ["worktree", "add", "-b", intent.branch, join(intent.taskDir, repo.repoDir), repo.commit]); }
          catch (error) { recordFailure(repo, asRepoFailure(error, repo, "WORKTREE_ADD_FAILED", "工作树创建失败")); }
        }
        for (const repo of adoptableOrphans) {
          try { git(repo.path, ["worktree", "add", join(intent.taskDir, repo.repoDir), intent.branch]); }
          catch (error) { recordFailure(repo, asRepoFailure(error, repo, "WORKTREE_ADD_FAILED", "接管已有任务分支失败")); }
        }
        refuseIfFailed();
        // [Pencil T07] #142: read back the checkout THIS creation produced (or
        // verified on a retry) and keep that observation for the record. Read
        // inside the lock so no competing creation can swap the checkout
        // between `worktree add` and the recorded identity.
        for (const repo of worktreeRepos) {
          if (repoStates[repo.repoDir]?.phase === "failed") continue;
          try { checkoutIdentities[repo.repoDir] = observeCheckout(join(intent.taskDir, repo.repoDir), intent.branch); recordCreated(repo); }
          catch (error) { recordFailure(repo, asRepoFailure(error, repo, "WORKTREE_IDENTITY_MISMATCH", "工作副本身份不符")); }
        }
        refuseIfFailed();
        if (Object.keys(repoStates).length > 0) intent.repoStates = repoStates;
      } finally {
        // Released on success, on refusal and on every throw; a crash leaves the
        // named stale-lock policy (`worktree-metadata-lock.ts`) to clear it.
        acquisition.release();
      }
      for (const dir of intent.directories) {
        checkSource(dir);
        const target = join(intent.taskDir, dir.linkName);
        let exists = false;
        try { lstatSync(target); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (exists) {
          if (!lstatSync(target).isSymbolicLink() || !linkTargetMatches(readlinkSync(target), dir.path)) throw new Error("普通目录链接已改变");
        } else createDirectoryLink(dir.path, target);
      }
      let previous: ReturnType<typeof readTaskRecordOnDisk>;
      try { previous = readTaskRecordOnDisk(intent.taskDir); }
      catch { throw new Error("现有任务记录损坏，不能覆盖"); }
      if (!previous) {
        try { lstatSync(join(intent.taskDir, "task.json")); throw new Error("现有任务记录损坏或链接，不能覆盖"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const mode = intent.workspaceMode ?? "worktree";
        const existingGit = mode === "existing-git";
        const first = intent.repos[0];
        const result = await this.host.routeTaskOp({ taskId: intent.taskId, op: "task/provision", payload: {
          name: intent.name, dirId: intent.taskId, rootOverride: intent.root,
          workspaceMode: mode,
          remoteBranch: existingGit ? "" : (first?.remoteBranch ?? ""), fetchedCommit: existingGit ? "" : (first?.commit ?? ""),
          ...(existingGit ? {
            // The Host records the real checkout path, the branch observed at
            // prepare and the HEAD observed at commit. No repoSelections /
            // fetchedCommits: nothing is fetched or pinned in this mode.
            sharedRepos: intent.repos.map((repo) => ({ rootId: repo.repoDir, sourcePath: repo.realPath, remote: repo.remote,
              remoteBranch: repo.remoteBranch, headCommit: repo.commit, commonDir: repo.commonDir, remoteDigest: repo.remoteDigest,
              sourceDevice: repo.device, sourceInode: repo.inode })),
          } : {
            repoSelections: intent.repos.map((repo) => ({ repoDir: repo.repoDir, remote: repo.remote, remoteBranch: repo.remoteBranch, mainCheckoutDir: repo.path })),
            fetchedCommits: Object.fromEntries(intent.repos.map((repo) => [repo.repoDir, repo.commit])),
            repoIdentities: Object.fromEntries(intent.repos.map((repo) => [repo.repoDir, { sourcePath: repo.path, sourceRealPath: repo.realPath,
              sourceDevice: repo.device, sourceInode: repo.inode, commonDir: repo.commonDir, remoteDigest: repo.remoteDigest,
              ...(checkoutIdentities[repo.repoDir] ?? {}) }])),
          }),
          plainDirs: intent.directories.map((dir) => ({ directoryId: dir.id, sourcePath: dir.path })),
        } });
        if (result.taskId !== intent.taskId) throw new Error("Host 任务身份不符");
      }
      const record = readTaskRecordOnDisk(intent.taskDir);
      // #82: the record's `taskDir` is written by the forked Host from its spawn dir,
      // which production derives with `previewTaskPaths` (`<native root>/task-…`), so
      // the intent and the record spell the same folder with different separators.
      // Compare the canonical key; a record naming another folder still differs.
      const mode = intent.workspaceMode ?? "worktree";
      const expectedRepoCount = mode === "existing-git" ? 0 : intent.repos.length;
      // [Pencil T07] #142 (#137 leftover): the record's branch spelling must
      // match what this mode really created — a task branch only for worktrees.
      const expectedBranch = mode === "worktree" ? intent.branch : "";
      const expectedBranchKind = mode === "worktree" ? "task-worktree" : "none";
      // Existing-Git-dir mode records the shared checkout in `sharedRepos`
      // (real source path, branch, observed HEAD) and has no worktree folders;
      // worktree mode records one `repoSources` entry per repo. Neither shape
      // may silently stand in for the other.
      const repoRecordOk = mode === "existing-git"
        ? (record?.sharedRepos?.length ?? 0) === intent.repos.length &&
          intent.repos.every((repo) => record?.sharedRepos?.some((entry) => entry.rootId === repo.repoDir &&
            (entry.sourceRealPath ?? entry.sourcePath) === repo.realPath && entry.remoteBranch === repo.remoteBranch))
        : mode === "plain-dirs"
        ? (record?.repoSources?.length ?? 0) === 0
        : intent.repos.length > 0 && !intent.repos.some((repo) => !record?.repoSources?.some((entry) => entry.repoDir === repo.repoDir && entry.remote === repo.remote && entry.remoteBranch === repo.remoteBranch && entry.baseCommit === repo.commit &&
            // #142: the record keeps the ACTUAL observed checkout identity. Its
            // real path and branch are stable facts of this creation; the HEAD
            // may legitimately advance when the user commits in the worktree
            // between a failed attempt and a retry, so it is not compared (the
            // `merge-base --is-ancestor` check above already proves lineage).
            (entry.targetRealPath === undefined || entry.targetRealPath === checkoutIdentities[repo.repoDir]?.targetRealPath) &&
            (entry.targetBranch === undefined || entry.targetBranch === intent.branch)));
      if (!record || record.taskId !== intent.taskId || record.dirId !== intent.taskId || record.root !== intent.root ||
          normalizeTaskPath(record.taskDir) !== normalizeTaskPath(intent.taskDir) ||
          record.branch !== expectedBranch || (record.branchKind ?? "task-worktree") !== expectedBranchKind ||
          record.name !== intent.name || record.repos.length !== expectedRepoCount ||
          (record.workspaceMode ?? "worktree") !== mode || !repoRecordOk ||
          (record.dirLinks?.length ?? 0) !== intent.directories.length || intent.directories.some((dir) => !record.dirLinks?.some((entry) => entry.directoryId === dir.id && entry.linkName === dir.linkName && entry.sourcePath === dir.path))) {
        throw new Error("任务磁盘记录与创建意图不符");
      }
      this.store.assertTaskPath(intent.taskDir);
      for (const source of [...intent.repos, ...intent.directories]) this.store.assertTaskPath(source.path);
      await this.roots.register(intent.taskDir);
      checkProject();
      const association = this.projects.association(intent.taskId, this.roots);
      if (association.state === "unassigned") await this.projects.claim(intent.taskId, intent.projectId, this.roots);
      else if (association.state !== "assigned" || association.projectId !== intent.projectId) throw new Error("任务归属身份冲突，需要人工修复");
      intent.state = "complete"; this.store.write(intent);
      return { taskId: intent.taskId, projectId: intent.projectId };
    }
  }
}
