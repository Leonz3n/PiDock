import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { readTaskRecordOnDisk } from "../host/task-store.js";
import { isSafeTaskChildName, isTaskDirId } from "./task-provision.js";
import { listPersistedTasks, type PersistedTaskSummary } from "./task-inventory.js";
import { createDiskTaskDirResolver } from "./task-resolver.js";

interface IndexedTask { taskId: string; dirId: string; createdAt: string }
interface IndexedRoot { path: string; realPath: string; tasks: IndexedTask[] }
interface IndexDocument { version: 1; roots: IndexedRoot[] }
export interface RootStatus { label: string; state: "ready" | "error"; message?: string }
export interface TaskInventory { tasks: PersistedTaskSummary[]; roots: RootStatus[] }
export interface VerifiedTaskIdentity {
  taskId: string; createdAt: string; root: string; dirId: string; realRoot: string;
  directoryDevice: string; directoryInode: string;
}

const FILE = "task-roots.json";
const MAX_BYTES = 1024 * 1024;
export function taskRootIndexPath(userData: string): string { return join(userData, FILE); }

function regularFile(file: string): boolean {
  try {
    if (!lstatSync(file).isFile()) throw new Error("invalid task root index file");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function rootPath(path: unknown): string {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || path.includes("\0") || normalize(path) !== path || path === dirname(path)) {
    throw new Error("invalid task root path");
  }
  return path;
}
function validateDocument(value: unknown): IndexDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid task root index");
  const obj = value as Record<string, unknown>;
  if (obj["version"] !== 1) throw new Error("unsupported task root index version");
  if (Object.keys(obj).sort().join(",") !== "roots,version" || !Array.isArray(obj["roots"]) || obj["roots"].length > 100) throw new Error("invalid task root index");
  const roots = obj["roots"].map((raw: unknown): IndexedRoot => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("invalid task root entry");
    const row = raw as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "path,realPath,tasks" || !Array.isArray(row["tasks"]) || row["tasks"].length > 10000) throw new Error("invalid task root entry");
    const tasks = row["tasks"].map((item: unknown): IndexedTask => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error("invalid indexed task");
      const task = item as Record<string, unknown>;
      if (Object.keys(task).sort().join(",") !== "createdAt,dirId,taskId" ||
          typeof task["taskId"] !== "string" || !isSafeTaskChildName(task["taskId"]) ||
          typeof task["dirId"] !== "string" || !isTaskDirId(task["dirId"]) ||
          typeof task["createdAt"] !== "string" || !task["createdAt"]) throw new Error("invalid indexed task");
      return { taskId: task["taskId"], dirId: task["dirId"], createdAt: task["createdAt"] };
    });
    if (new Set(tasks.map((task) => task.taskId)).size !== tasks.length || new Set(tasks.map((task) => task.dirId)).size !== tasks.length) throw new Error("duplicate indexed task");
    return { path: rootPath(row["path"]), realPath: rootPath(row["realPath"]), tasks };
  });
  if (new Set(roots.map((root) => root.path)).size !== roots.length ||
      new Set(roots.map((root) => root.realPath)).size !== roots.length ||
      new Set(roots.flatMap((root) => root.tasks.map((task) => task.taskId))).size !== roots.reduce((n, root) => n + root.tasks.length, 0)) {
    throw new Error("duplicate task root or identity");
  }
  return { version: 1, roots };
}
function readDocument(file: string): IndexDocument {
  const data = readFileSync(file);
  if (data.length > MAX_BYTES) throw new Error("task root index too large");
  return validateDocument(JSON.parse(data.toString("utf8")));
}
function writeTemp(file: string, text: string): void {
  const fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(dir: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function verifiedRoot(path: string, bound?: string): string {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("task root missing or linked");
    throw error;
  }
  if (!stat.isDirectory()) throw new Error("task root missing or linked");
  const real = realpathSync(path);
  if (bound !== undefined && real !== bound) throw new Error("task root changed location");
  return real;
}
function verifyTask(root: string, task: IndexedTask): PersistedTaskSummary {
  const dir = join(root, task.dirId);
  if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== join(realpathSync(root), task.dirId)) throw new Error("task directory moved or linked");
  if (!lstatSync(join(dir, "task.json")).isFile()) throw new Error("task record linked or invalid");
  const record = readTaskRecordOnDisk(dir);
  if (!record || record.taskId !== task.taskId || record.dirId !== task.dirId || record.createdAt !== task.createdAt ||
      record.root !== root || record.taskDir !== dir) throw new Error("task record identity changed");
  return { taskId: record.taskId, name: record.name, branch: record.branch, repoCount: record.repos.length, updatedAt: record.updatedAt };
}

function rootFailure(error: unknown): string {
  if (error instanceof Error) {
    if (error.message === "task root missing or linked" || error.message === "task root changed location") return "任务根目录已移走或链接已更改，请检查原位置";
    if (error.message === "unindexed tasks in registered root") return "目录中有未登记的任务，请使用找回操作明确导入";
    if (["task directory moved or linked", "task record linked or invalid", "task record identity changed"].includes(error.message)) return "任务目录或磁盘记录身份已改变，请检查后重试";
  }
  return "任务根目录不可读取或任务身份冲突，请检查后重试";
}

function sameSummary(a: PersistedTaskSummary, b: PersistedTaskSummary): boolean {
  return a.taskId === b.taskId && a.name === b.name && a.branch === b.branch &&
    a.repoCount === b.repoCount && a.updatedAt === b.updatedAt;
}

interface ValidatedTask { summary: PersistedTaskSummary; root: string; realPath: string; identity: IndexedTask }
interface RootGroup { label: string; rows: ValidatedTask[]; message?: string }

/** Main owns one instance. A missing primary with backup requires explicit recovery. */
export class TaskRootIndex {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly userData: string, private readonly defaultRoot: string,
    private readonly hooks: { beforeCommit?: () => void; afterBackup?: () => void } = {}) {}

  private load(): { initialized: boolean; value: IndexDocument } {
    const file = taskRootIndexPath(this.userData);
    if (!regularFile(file)) {
      if (regularFile(`${file}.bak`)) throw new Error("task root index missing; backup requires explicit recovery");
      return { initialized: false, value: { version: 1, roots: [] } };
    }
    return { initialized: true, value: readDocument(file) };
  }
  private save(next: IndexDocument, previous: boolean): void {
    const file = taskRootIndexPath(this.userData);
    try { if (!lstatSync(this.userData).isDirectory()) throw new Error("invalid index directory"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(this.userData, { recursive: true, mode: 0o700 });
    }
    const text = JSON.stringify(validateDocument(next));
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("task root index too large");
    const tmp = `${file}.${randomUUID()}.tmp`;
    const backupTmp = `${file}.${randomUUID()}.bak.tmp`;
    try {
      writeTemp(tmp, text);
      this.hooks.beforeCommit?.();
      if (previous && regularFile(`${file}.bak`)) readDocument(`${file}.bak`);
      const backup = previous ? readFileSync(file, "utf8") : text;
      if (previous) validateDocument(JSON.parse(backup));
      writeTemp(backupTmp, backup);
      renameSync(backupTmp, `${file}.bak`);
      syncDirectory(this.userData);
      this.hooks.afterBackup?.();
      renameSync(tmp, file);
      syncDirectory(this.userData);
    } finally { rmSync(tmp, { force: true }); rmSync(backupTmp, { force: true }); }
  }
  private mutate<T>(fn: (doc: IndexDocument) => T): Promise<T> {
    const work = this.pending.then(() => {
      const { initialized, value } = this.load();
      const result = fn(value);
      this.save(value, initialized);
      return result;
    });
    this.pending = work.catch(() => undefined);
    return work;
  }
  /** Called only after the bound Host reports a successful provision. Safe to retry. */
  register(taskDir: string): Promise<void> {
    return this.mutate((doc) => {
      const root = rootPath(dirname(taskDir));
      if (root === this.defaultRoot) return;
      const realPath = verifiedRoot(root);
      const dirId = basename(taskDir);
      if (!isTaskDirId(dirId)) throw new Error("invalid task directory ID");
      const record = readTaskRecordOnDisk(taskDir);
      if (!record) throw new Error("missing task record after provision");
      const task = { taskId: record.taskId, dirId, createdAt: record.createdAt };
      verifyTask(root, task);
      const defaultIds = new Set(listPersistedTasks(this.defaultRoot).map((item) => item.taskId));
      if (defaultIds.has(task.taskId)) throw new Error("task ID conflicts with default root");
      const existing = doc.roots.find((entry) => entry.path === root);
      if (doc.roots.some((entry) => entry.path !== root && (entry.realPath === realPath || entry.tasks.some((item) => item.taskId === task.taskId)))) throw new Error("task root or ID conflict");
      if (existing && existing.realPath !== realPath) throw new Error("task root changed location");
      if (existing) {
        const old = existing.tasks.find((item) => item.taskId === task.taskId || item.dirId === task.dirId);
        if (old && (old.taskId !== task.taskId || old.dirId !== task.dirId || old.createdAt !== task.createdAt)) throw new Error("task identity conflict");
        if (!old) existing.tasks.push(task);
      } else doc.roots.push({ path: root, realPath, tasks: [task] });
    });
  }
  /** The selected directory is supplied by Electron's native picker, never page data. */
  importRoot(selected: string): Promise<number> {
    return this.mutate((doc) => {
      const path = rootPath(selected);
      if (path === this.defaultRoot) throw new Error("default task root is already available");
      const realPath = verifiedRoot(path);
      const found: IndexedTask[] = [];
      for (const name of readdirSync(path).sort()) {
        if (!isTaskDirId(name)) continue;
        const dir = join(path, name);
        if (!lstatSync(dir).isDirectory()) throw new Error("linked task directory");
        const record = readTaskRecordOnDisk(dir);
        if (!record) continue;
        const task = { taskId: record.taskId, dirId: name, createdAt: record.createdAt };
        verifyTask(path, task);
        found.push(task);
      }
      if (!found.length) throw new Error("no valid task records in selected root");
      if (new Set(found.map((item) => item.taskId)).size !== found.length) throw new Error("duplicate task identity in selected root");
      const defaultIds = new Set(listPersistedTasks(this.defaultRoot).map((item) => item.taskId));
      if (found.some((item) => defaultIds.has(item.taskId))) throw new Error("task ID conflicts with default root");
      const existing = doc.roots.find((entry) => entry.path === path);
      if (doc.roots.some((entry) => entry.path !== path && (entry.realPath === realPath || entry.tasks.some((task) => found.some((item) => task.taskId === item.taskId))))) throw new Error("task root or ID conflict");
      if (existing && (existing.realPath !== realPath || existing.tasks.some((task) => !found.some((item) => item.taskId === task.taskId && item.dirId === task.dirId && item.createdAt === task.createdAt)))) throw new Error("previously indexed task is missing or changed");
      if (existing) existing.tasks = found;
      else doc.roots.push({ path, realPath, tasks: found });
      return found.length;
    });
  }
  private scan(): { inventory: TaskInventory; locations: Map<string, ValidatedTask> } {
    let doc: IndexDocument;
    try { doc = this.load().value; }
    catch {
      return { inventory: { tasks: [], roots: [
        { label: "默认任务根", state: "error", message: "覆盖根索引不可读取，无法确认任务身份" },
        { label: "覆盖根索引", state: "error", message: "覆盖根索引不可读取，请检查本机数据后重试" },
      ] }, locations: new Map() };
    }
    const groups: RootGroup[] = [];
    const add = (label: string, read: () => ValidatedTask[]) => {
      try { groups.push({ label, rows: read() }); }
      catch (error) { groups.push({ label, rows: [], message: rootFailure(error) }); }
    };
    add("默认任务根", () => listPersistedTasks(this.defaultRoot).map((summary) => {
      const dir = createDiskTaskDirResolver(this.defaultRoot)(summary.taskId);
      const record = dir && readTaskRecordOnDisk(dir);
      if (!dir || !record || dirname(dir) !== this.defaultRoot) throw new Error("task record identity changed");
      const identity = { taskId: summary.taskId, dirId: record.dirId, createdAt: record.createdAt };
      if (!sameSummary(verifyTask(this.defaultRoot, identity), summary)) throw new Error("task record identity changed");
      return { summary, root: this.defaultRoot, realPath: verifiedRoot(this.defaultRoot), identity };
    }));
    doc.roots.forEach((entry, index) => add(`已登记任务根 ${index + 1}`, () => {
      verifiedRoot(entry.path, entry.realPath);
      const scanned = listPersistedTasks(entry.path);
      if (scanned.length !== entry.tasks.length) throw new Error("unindexed tasks in registered root");
      return entry.tasks.map((identity) => ({ summary: verifyTask(entry.path, identity), root: entry.path, realPath: entry.realPath, identity }));
    }));
    // A failed root still owns every persisted ID. Never let a new default-root
    // record with that ID be displayed or routed as a different task.
    const indexedIds = new Map(doc.roots.flatMap((root, index) => root.tasks.map((task) => [task.taskId, index + 1] as const)));
    for (const row of groups[0]!.rows) {
      const owner = indexedIds.get(row.summary.taskId);
      if (owner !== undefined) {
        groups[0]!.message = "任务身份与另一任务根冲突，请检查后重试";
        groups[owner]!.message = "任务身份与另一任务根冲突，请检查后重试";
      }
    }
    const seen = new Map<string, number>();
    for (const [index, group] of groups.entries()) {
      for (const row of group.rows) {
        const other = seen.get(row.summary.taskId);
        if (other !== undefined) {
          groups[other]!.message = "任务身份与另一任务根冲突，请检查后重试";
          group.message = "任务身份与另一任务根冲突，请检查后重试";
        } else seen.set(row.summary.taskId, index);
      }
    }
    const healthy = groups.filter((group) => !group.message);
    const visible = healthy.flatMap((group) => group.rows);
    return {
      inventory: {
        tasks: visible.map((row) => row.summary),
        roots: groups.map((group) => group.message ? { label: group.label, state: "error", message: group.message } : { label: group.label, state: "ready" }),
      },
      locations: new Map(visible.map((row) => [row.summary.taskId, row])),
    };
  }
  inventory(): TaskInventory { return this.scan().inventory; }
  verifiedIdentity(taskId: string): VerifiedTaskIdentity | null {
    if (!isSafeTaskChildName(taskId)) return null;
    const row = this.scan().locations.get(taskId);
    if (!row) return null;
    try {
      if (verifiedRoot(row.root, row.realPath) !== row.realPath) return null;
      const dir = join(row.root, row.identity.dirId);
      const before = lstatSync(dir, { bigint: true });
      // Filesystems without usable stable identifiers cannot anchor a claim.
      if (!before.isDirectory() || before.dev <= 0n || before.ino <= 0n ||
          !sameSummary(verifyTask(row.root, row.identity), row.summary)) return null;
      const after = lstatSync(dir, { bigint: true });
      if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) return null;
      return { taskId, createdAt: row.identity.createdAt, root: row.root,
        dirId: row.identity.dirId, realRoot: row.realPath,
        directoryDevice: after.dev.toString(), directoryInode: after.ino.toString() };
    } catch { return null; }
  }
  resolve(taskId: string): string | null {
    if (!isSafeTaskChildName(taskId)) return null;
    const row = this.scan().locations.get(taskId);
    if (!row) return null;
    try {
      verifiedRoot(row.root, row.realPath);
      if (!sameSummary(verifyTask(row.root, row.identity), row.summary)) return null;
      return join(row.root, row.identity.dirId);
    } catch { return null; }
  }
}
