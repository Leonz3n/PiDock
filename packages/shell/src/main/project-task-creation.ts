import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { readTaskRecordOnDisk } from "../host/task-store.js";
import type { HostTaskResult } from "../rpc/protocol.js";
import { buildLinkName, checkLinkNameCollisions } from "./multi-repo-provision.js";
import type { ProjectRegistry } from "./project-registry.js";
import { buildTaskBranch } from "./task-provision.js";
import { TaskRootIndex } from "./task-root-index.js";

interface Source { id: string; name: string; path: string; realPath: string; device: string; inode: string }
interface Repo extends Source { remote: string; remoteBranch: string; remoteDigest: string; commonDir: string; commit: string; repoDir: string }
interface Directory extends Source { linkName: string }
export interface CreationIntent {
  id: string; taskId: string; name: string; projectId: string; projectSnapshot: string;
  root: string; rootDevice: string | null; rootInode: string | null; rootRealPath: string | null;
  taskDir: string; branch: string; repos: Repo[]; directories: Directory[];
  sharedWriteConfirmed: boolean; state: "pending" | "complete" | "abandoned";
}
export interface CreationRequest {
  projectId: string; name: string;
  repositories: { sourceId: string; remote: string; remoteBranch: string }[];
  directoryIds: string[]; sharedWriteConfirmed: boolean; override: boolean;
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
type CreationBoundary = "root-before-mkdir" | "root-mkdir" | "root-marked" | "task-before-mkdir" | "task-mkdir" | "task-marked";
function createOwnedDirectory(target: string, marker: string, id: string, kind: "root" | "task",
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
function optionalGit(cwd: string, args: string[]): string | null {
  try { return git(cwd, args); } catch { return null; }
}
function remoteDigest(url: string): string {
  if (/^(?:ext::|[^:/]+::|-)/i.test(url) || /[\r\n\0]/.test(url)) throw new Error("不支持的远程传输方式");
  let transport: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const parsed = new URL(url);
    if (!["https:", "http:", "ssh:", "git:", "file:"].includes(parsed.protocol)) throw new Error("不支持的远程传输方式");
    parsed.username = ""; parsed.password = ""; parsed.search = ""; parsed.hash = "";
    transport = parsed.toString();
  } else if (/^(?:[^@:]+@)?[^/:]+:.+/.test(url) && !/^[a-z]:[\\/]/i.test(url)) {
    transport = url.replace(/^[^@:]+@/, "");
  } else transport = url;
  return createHash("sha256").update(transport).digest("hex");
}
function gitCommonDir(path: string): string {
  return realpathSync(resolve(path, git(path, ["rev-parse", "--git-common-dir"])));
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
  const row = strict(value, ["id", "taskId", "name", "projectId", "projectSnapshot", "root", "rootDevice", "rootInode", "rootRealPath", "taskDir", "branch", "repos", "directories", "sharedWriteConfirmed", "state"]);
  if (!UUID.test(string(row.id)) || !UUID.test(string(row.projectId)) || !/^task-[a-f0-9]{8}$/.test(string(row.taskId)) ||
      row.taskDir !== join(path(row.root), row.taskId as string) || !["pending", "complete", "abandoned"].includes(String(row.state)) ||
      typeof row.projectSnapshot !== "string" || row.projectSnapshot.length > 65536 || typeof row.sharedWriteConfirmed !== "boolean" ||
      !((row.rootDevice === null && row.rootInode === null && row.rootRealPath === null) ||
        (typeof row.rootDevice === "string" && typeof row.rootInode === "string" && typeof row.rootRealPath === "string" && isAbsolute(row.rootRealPath))) ||
      !Array.isArray(row.repos) || !row.repos.length || row.repos.length > 30 || !Array.isArray(row.directories) || row.directories.length > 30) throw new Error("创建意图损坏");
  string(row.name); string(row.branch);
  for (const raw of row.repos) {
    const item = strict(raw, ["id", "name", "path", "realPath", "device", "inode", "remote", "remoteBranch", "remoteDigest", "commonDir", "commit", "repoDir"]);
    if (!UUID.test(string(item.id)) || !/^[a-f0-9]{40}$/.test(String(item.commit)) || item.repoDir !== `repo-${(item.id as string).slice(0, 8)}`) throw new Error("仓库意图损坏");
    string(item.name); path(item.path); path(item.realPath); path(item.commonDir); string(item.device); string(item.inode); string(item.remote); string(item.remoteBranch);
    if (!/^[a-f0-9]{64}$/.test(String(item.remoteDigest))) throw new Error("远程身份意图损坏");
  }
  for (const raw of row.directories) {
    const item = strict(raw, ["id", "name", "path", "realPath", "device", "inode", "linkName"]);
    if (!UUID.test(string(item.id)) || item.linkName !== buildLinkName(item.id as string)) throw new Error("目录意图损坏");
    string(item.name); path(item.path); path(item.realPath); string(item.device); string(item.inode);
  }
  if (row.directories.length && !row.sharedWriteConfirmed) throw new Error("共享写入未经确认");
  return value as CreationIntent;
}

/** One main instance owns this file; first-write backup witnesses an initialized store. */
export class CreationIntentStore {
  constructor(private readonly userData: string) {}
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
  abandon(intent: CreationIntent): void {
    if (intent.state !== "pending" && intent.state !== "abandoned") throw new Error("不能放弃已完成的任务");
    const file = join(this.userData, `task-creation-abandon-${intent.id}.json`);
    if (!this.hasAbandonReceipt(intent)) {
      const receipt = { version: 1, intentId: intent.id, taskId: intent.taskId, projectId: intent.projectId,
        root: intent.root, taskDir: intent.taskDir, reason: "operator-abandon", at: new Date().toISOString() };
      const fd = openSync(file, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(receipt)); fsyncSync(fd); } finally { closeSync(fd); }
      syncDirectory(this.userData);
    }
    if (intent.state === "pending") this.write({ ...intent, state: "abandoned" });
  }
}

/** The intent is the recovery authority; success is exposed only after all three records agree. */
export class ProjectTaskCreation {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: CreationIntentStore, private readonly projects: ProjectRegistry,
    private readonly roots: TaskRootIndex, private readonly host: CreationHost, private readonly defaultRoot: string,
    private readonly afterBoundary?: (boundary: CreationBoundary) => void) {}
  private run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action); this.queue = result.catch(() => undefined); return result;
  }
  current(): CreationIntent | null {
    const intent = this.store.read();
    if (intent?.state === "abandoned") {
      if (!this.store.hasAbandonReceipt(intent)) throw new Error("放弃创建凭据丢失，需要显式恢复");
      return null;
    }
    return intent;
  }
  abandon(id: string): Promise<{ taskId: string; abandoned: true }> {
    return this.run(async () => {
      const intent = this.store.read();
      if (!intent || intent.id !== id) throw new Error("创建意图已改变，请重新读取");
      if (intent.state === "complete") throw new Error("已完成任务不能放弃");
      if (intent.state === "abandoned" && !this.store.hasAbandonReceipt(intent)) throw new Error("放弃创建凭据丢失，需要显式恢复");
      if (intent.state === "pending") {
        if (this.roots.inventory().roots.some((row) => row.state === "error") ||
            this.projects.association(intent.taskId, this.roots).state !== "unavailable" ||
            pathPresent(join(intent.taskDir, "task.json")) || matchesMarker(intent.taskDir, ".pidock-creation", intent.id)) {
          throw new Error("任务记录、工作区或关联已存在，不能放弃；请恢复原任务");
        }
      }
      this.store.abandon(intent);
      return { taskId: intent.taskId, abandoned: true };
    });
  }
  prepare(input: CreationRequest, selectedRoot?: string): Promise<CreationIntent> {
    return this.run(async () => {
      const prior = this.store.read();
      if (prior?.state === "pending") throw new Error("已有待完成的任务，请先恢复");
      if (prior?.state === "abandoned" && !this.store.hasAbandonReceipt(prior)) throw new Error("放弃创建凭据丢失，需要显式恢复");
      const project = this.projects.get(input.projectId);
      if (!project) throw new Error("项目已删除或不可读取");
      if (!Array.isArray(input.repositories) || !input.repositories.length || input.repositories.length > 30 ||
          !Array.isArray(input.directoryIds) || input.directoryIds.length > 30) throw new Error("当前创建流程至少需要一个 Git 仓库");
      if (input.directoryIds.length && input.sharedWriteConfirmed !== true) throw new Error("请确认普通目录的共享写入风险");
      if (input.override !== (selectedRoot !== undefined)) throw new Error("任务根选择结果与请求不符");
      const name = string(input.name), root = path(selectedRoot ?? this.defaultRoot);
      const inventory = this.roots.inventory();
      if (inventory.roots.some((entry) => entry.state === "error")) throw new Error("任务根身份不可读取，请先修复后创建");
      const rootIdentity = existsSync(root) ? diskIdentity(root) : null;
      if (!rootIdentity) diskIdentity(dirname(root));
      const repoIds = new Set<string>(), dirIds = new Set<string>(), commonDirs = new Set<string>();
      const repos: Repo[] = input.repositories.map((selection) => {
        if (!selection || !UUID.test(string(selection.sourceId)) || repoIds.has(selection.sourceId)) throw new Error("仓库选择重复或无效");
        repoIds.add(selection.sourceId);
        const source = project.repositories.find((row) => row.id === selection.sourceId);
        if (!source) throw new Error("项目仓库已改变");
        const remote = string(selection.remote), remoteBranch = string(selection.remoteBranch);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) throw new Error("远程名称无效");
        git(source.path, ["check-ref-format", `refs/heads/${remoteBranch}`]);
        const repo: Repo = { ...source, ...diskIdentity(source.path), remote, remoteBranch,
          commonDir: gitCommonDir(source.path), remoteDigest: remoteDigest(git(source.path, ["remote", "get-url", remote])),
          commit: "0".repeat(40), repoDir: `repo-${source.id.slice(0, 8)}` };
        if (commonDirs.has(repo.commonDir)) throw new Error("所选仓库属于同一 Git 仓库，请仅选择一个工作树");
        commonDirs.add(repo.commonDir);
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
        sharedWriteConfirmed: input.sharedWriteConfirmed === true, state: "pending" };
      this.store.write(intent);
      return intent;
    });
  }
  commit(id: string): Promise<{ taskId: string; projectId: string }> {
    return this.run(async () => {
      const intent = this.store.read();
      if (!intent || intent.id !== id) throw new Error("创建意图已改变，请重新读取");
      if (intent.state === "abandoned") throw new Error("创建意图已放弃，请重新创建任务");
      if (this.store.hasAbandonReceipt(intent)) throw new Error("放弃创建凭据已写入，只能继续放弃，不能提交原任务");
      if (intent.state === "complete") {
        const association = this.projects.association(intent.taskId, this.roots);
        if (association.state !== "assigned" || association.projectId !== intent.projectId) throw new Error("任务归属需要修复");
        return { taskId: intent.taskId, projectId: intent.projectId };
      }
      const checkProject = () => {
        const current = this.projects.get(intent.projectId);
        if (!current || JSON.stringify(current) !== intent.projectSnapshot) throw new Error("项目或来源已变更，保留待恢复任务，不自动重新归属");
      };
      checkProject();
      if (intent.rootDevice === null) {
        if (!pathPresent(intent.root)) {
          diskIdentity(dirname(intent.root));
          createOwnedDirectory(intent.root, ".pidock-created-root", intent.id, "root", this.afterBoundary);
        } else if (!matchesMarker(intent.root, ".pidock-created-root", intent.id)) {
          throw new Error("任务根在准备后被建立，不能接管；需要显式恢复");
        }
        const fresh = diskIdentity(intent.root);
        intent.rootDevice = fresh.device; intent.rootInode = fresh.inode; intent.rootRealPath = fresh.realPath;
        this.store.write(intent);
      }
      const rootIdentity = diskIdentity(intent.root);
      if (rootIdentity.device !== intent.rootDevice || rootIdentity.inode !== intent.rootInode || rootIdentity.realPath !== intent.rootRealPath) throw new Error("任务根身份已改变");
      for (const repo of intent.repos) verifyRepo(repo);
      const taskRealPath = join(realpathSync(intent.root), intent.taskId);
      checkWorkspaceOverlap(taskRealPath, intent.repos, intent.directories);
      for (const dir of intent.directories) checkSource(dir);
      if (!pathPresent(intent.taskDir)) {
        createOwnedDirectory(intent.taskDir, ".pidock-creation", intent.id, "task", this.afterBoundary);
      } else if (!matchesMarker(intent.taskDir, ".pidock-creation", intent.id)) {
        throw new Error("任务目录已占用或创建标记不匹配");
      }
      for (const repo of intent.repos) {
        const target = join(intent.taskDir, repo.repoDir);
        if (existsSync(target)) {
          if (!lstatSync(target).isDirectory() || realpathSync(target) !== join(realpathSync(intent.taskDir), repo.repoDir) ||
              git(target, ["merge-base", "--is-ancestor", repo.commit, "HEAD"]) !== "" ||
              git(target, ["symbolic-ref", "--quiet", "HEAD"]) !== `refs/heads/${intent.branch}` || gitCommonDir(target) !== repo.commonDir) {
            throw new Error("工作树与固定任务提交不符");
          }
          continue;
        }
        git(repo.path, ["fetch", "--no-tags", repo.remote, `refs/heads/${repo.remoteBranch}`]);
        if (git(repo.path, ["rev-parse", "FETCH_HEAD"]) !== repo.commit) throw new Error("远程分支已变化，不使用旧基线");
        if (optionalGit(repo.path, ["show-ref", "--verify", "--hash", `refs/heads/${intent.branch}`]) !== null) throw new Error("任务分支已存在但工作树不在原位置，请人工恢复");
        git(repo.path, ["worktree", "add", "-b", intent.branch, target, repo.commit]);
      }
      for (const dir of intent.directories) {
        checkSource(dir);
        const target = join(intent.taskDir, dir.linkName);
        let exists = false;
        try { lstatSync(target); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (exists) {
          if (!lstatSync(target).isSymbolicLink() || readlinkSync(target) !== dir.path) throw new Error("普通目录链接已改变");
        } else symlinkSync(dir.path, target, "dir");
      }
      let previous: ReturnType<typeof readTaskRecordOnDisk>;
      try { previous = readTaskRecordOnDisk(intent.taskDir); }
      catch { throw new Error("现有任务记录损坏，不能覆盖"); }
      if (!previous) {
        try { lstatSync(join(intent.taskDir, "task.json")); throw new Error("现有任务记录损坏或链接，不能覆盖"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const first = intent.repos[0]!;
        const result = await this.host.routeTaskOp({ taskId: intent.taskId, op: "task/provision", payload: {
          name: intent.name, dirId: intent.taskId, rootOverride: intent.root,
          remoteBranch: first.remoteBranch, fetchedCommit: first.commit,
          repoSelections: intent.repos.map((repo) => ({ repoDir: repo.repoDir, remote: repo.remote, remoteBranch: repo.remoteBranch, mainCheckoutDir: repo.path })),
          fetchedCommits: Object.fromEntries(intent.repos.map((repo) => [repo.repoDir, repo.commit])),
          plainDirs: intent.directories.map((dir) => ({ directoryId: dir.id, sourcePath: dir.path })),
        } });
        if (result.taskId !== intent.taskId) throw new Error("Host 任务身份不符");
      }
      const record = readTaskRecordOnDisk(intent.taskDir);
      if (!record || record.taskId !== intent.taskId || record.dirId !== intent.taskId || record.root !== intent.root || record.taskDir !== intent.taskDir ||
          record.branch !== intent.branch || record.name !== intent.name || record.repos.length !== intent.repos.length ||
          intent.repos.some((repo) => !record.repoSources?.some((entry) => entry.repoDir === repo.repoDir && entry.remote === repo.remote && entry.remoteBranch === repo.remoteBranch && entry.baseCommit === repo.commit)) ||
          record.dirLinks?.length !== intent.directories.length || intent.directories.some((dir) => !record.dirLinks?.some((entry) => entry.directoryId === dir.id && entry.linkName === dir.linkName && entry.sourcePath === dir.path))) {
        throw new Error("任务磁盘记录与创建意图不符");
      }
      await this.roots.register(intent.taskDir);
      checkProject();
      const association = this.projects.association(intent.taskId, this.roots);
      if (association.state === "unassigned") await this.projects.claim(intent.taskId, intent.projectId, this.roots);
      else if (association.state !== "assigned" || association.projectId !== intent.projectId) throw new Error("任务归属身份冲突，需要人工修复");
      intent.state = "complete"; this.store.write(intent);
      return { taskId: intent.taskId, projectId: intent.projectId };
    });
  }
}
