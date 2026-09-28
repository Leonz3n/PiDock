import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, posix, win32 } from "node:path";
import type { TaskRootIndex, VerifiedTaskIdentity } from "./task-root-index.js";
import { isSafeTaskChildName, isTaskDirId } from "./task-provision.js";

export interface ProjectSource { id: string; name: string; path: string }
export interface LocalProject {
  id: string;
  name: string;
  description: string;
  repositories: ProjectSource[];
  directories: ProjectSource[];
}
export interface ProjectMembership {
  taskId: string;
  projectId: string;
  createdAt: string;
  root: string;
  dirId: string;
  realRoot?: string;
  directoryDevice?: string;
  directoryInode?: string;
}
export interface TaskAssociationReceipt {
  id: string;
  at: string;
  action: "claim" | "unlink" | "transfer";
  taskId: string;
  createdAt: string;
  root: string;
  dirId: string;
  realRoot?: string;
  directoryDevice?: string;
  directoryInode?: string;
  fromProjectId: string | null;
  toProjectId: string | null;
}
export interface ProjectDeletionReceipt { id: string; at: string; action: "delete"; projectId: string }
export type AssociationReceipt = TaskAssociationReceipt | ProjectDeletionReceipt;
interface Document { version: 1 | 2; projects: LocalProject[]; memberships: ProjectMembership[]; receipts?: AssociationReceipt[]; auditDigest?: string }
export type SourceInput = { id?: string; name: string; path: string };
export type ProjectCreateInput = { name: string; description: string; repositories: SourceInput[]; directories: SourceInput[] };
export type ProjectUpdateInput = { description: string; repositories: SourceInput[]; directories: SourceInput[] };

const FILE = "projects.json";
const MAX_BYTES = 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error("invalid project registry fields");
  }
}
function text(value: unknown, label: string, allowEmpty = false, maxLength = 256): string {
  if (typeof value !== "string" || value.trim() !== value || (!allowEmpty && !value) || value.length > maxLength || value.includes("\0")) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw new Error("invalid project ID");
  return value;
}
// Metadata only: no stat/realpath/Git probe here. A trusted Host rechecks at use time.
export function sourcePath(value: unknown, platform: "posix" | "win32" = process.platform === "win32" ? "win32" : "posix"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0")) {
    throw new Error("invalid source path");
  }
  const path = value;
  const windows = platform === "win32";
  const parser = windows ? win32 : posix;
  const components = path.split(windows ? "\\" : "/");
  if ((windows && (!/^[a-zA-Z]:\\/.test(path) || path.includes("/") ||
        components.slice(1).some((part) => /[<>:"|?*]/.test(part) || [...part].some((char) => char.charCodeAt(0) < 32) ||
          /[. ]$/.test(part) || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(part)))) ||
      !parser.isAbsolute(path) || parser.normalize(path) !== path || path === parser.parse(path).root ||
      components.some((part) => part === "." || part === "..")) {
    throw new Error("invalid absolute source path");
  }
  return path;
}
function source(value: unknown, allowGenerated: boolean): ProjectSource {
  if (!record(value)) throw new Error("invalid project source");
  keys(value, ["name", "path"], ["id"]);
  return { id: value["id"] === undefined && allowGenerated ? randomUUID() : id(value["id"]),
    name: text(value["name"], "source name"), path: sourcePath(value["path"]) };
}
function sources(value: unknown, allowGenerated: boolean): ProjectSource[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("invalid project sources");
  const rows = value.map((item) => source(item, allowGenerated));
  if (new Set(rows.map((row) => row.id)).size !== rows.length || new Set(rows.map((row) => row.path)).size !== rows.length) throw new Error("duplicate source");
  return rows;
}
function project(value: unknown): LocalProject {
  if (!record(value)) throw new Error("invalid project");
  keys(value, ["id", "name", "description", "repositories", "directories"]);
  const repositories = sources(value["repositories"], false);
  const directories = sources(value["directories"], false);
  if (new Set([...repositories, ...directories].map((row) => row.id)).size !== repositories.length + directories.length) throw new Error("duplicate source ID");
  return { id: id(value["id"]), name: text(value["name"], "project name"),
    description: text(value["description"], "description", true), repositories, directories };
}
function taskRoot(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || value.includes("\0") || !isAbsolute(value) || normalize(value) !== value) {
    throw new Error("invalid membership root");
  }
  return value;
}
function directoryIdentity(value: Record<string, unknown>): { directoryDevice?: string; directoryInode?: string } {
  const device = value["directoryDevice"];
  const inode = value["directoryInode"];
  if (device === undefined && inode === undefined) return {};
  if (typeof device !== "string" || typeof inode !== "string" ||
      !/^[1-9][0-9]*$/.test(device) || !/^[1-9][0-9]*$/.test(inode)) {
    throw new Error("invalid task directory identity");
  }
  return { directoryDevice: device, directoryInode: inode };
}
function membership(value: unknown): ProjectMembership {
  if (!record(value)) throw new Error("invalid membership");
  keys(value, ["taskId", "projectId", "createdAt", "root", "dirId"], ["realRoot", "directoryDevice", "directoryInode"]);
  const taskId = text(value["taskId"], "task ID");
  const dirId = text(value["dirId"], "dirId");
  if (!isSafeTaskChildName(taskId) || !isTaskDirId(dirId)) throw new Error("invalid membership task identity");
  return { taskId, projectId: id(value["projectId"]), createdAt: text(value["createdAt"], "createdAt"),
    root: taskRoot(value["root"]), dirId,
    ...(value["realRoot"] === undefined ? {} : { realRoot: taskRoot(value["realRoot"]) }),
    ...directoryIdentity(value) };
}
function receipt(value: unknown): AssociationReceipt {
  if (!record(value)) throw new Error("invalid association receipt");
  if (value["action"] === "delete") {
    keys(value, ["id", "at", "action", "projectId"]);
    return { id: id(value["id"]), at: text(value["at"], "receipt time"), action: "delete", projectId: id(value["projectId"]) };
  }
  keys(value, ["id", "at", "action", "taskId", "createdAt", "root", "dirId", "fromProjectId", "toProjectId"],
    ["realRoot", "directoryDevice", "directoryInode"]);
  const action = value["action"];
  if (action !== "claim" && action !== "unlink" && action !== "transfer") throw new Error("invalid association action");
  const taskId = text(value["taskId"], "task ID");
  const dirId = text(value["dirId"], "dirId");
  if (!isSafeTaskChildName(taskId) || !isTaskDirId(dirId)) throw new Error("invalid receipt task identity");
  const from = value["fromProjectId"] === null ? null : id(value["fromProjectId"]);
  const to = value["toProjectId"] === null ? null : id(value["toProjectId"]);
  if ((action === "claim" && (from !== null || to === null)) ||
      (action === "unlink" && (from === null || to !== null)) ||
      (action === "transfer" && (from === null || to === null || from === to))) throw new Error("invalid receipt transition");
  return { id: id(value["id"]), at: text(value["at"], "receipt time"), action, taskId,
    createdAt: text(value["createdAt"], "createdAt"), root: taskRoot(value["root"]), dirId,
    ...(value["realRoot"] === undefined ? {} : { realRoot: taskRoot(value["realRoot"]) }),
    ...directoryIdentity(value), fromProjectId: from, toProjectId: to };
}
function auditDigest(projects: LocalProject[], memberships: ProjectMembership[], receipts: AssociationReceipt[]): string {
  // Detect accidental loss/rewrite of history or current identities; this is not an authenticated signature.
  return createHash("sha256").update(JSON.stringify({ projectIds: projects.map((row) => row.id),
    memberships: memberships.map((row) => ({ taskId: row.taskId, projectId: row.projectId,
      createdAt: row.createdAt, root: row.root, dirId: row.dirId, realRoot: row.realRoot,
      directoryDevice: row.directoryDevice, directoryInode: row.directoryInode })), receipts })).digest("hex");
}
function document(value: unknown): Document {
  if (!record(value)) throw new Error("invalid project registry");
  if (value["version"] !== 1 && value["version"] !== 2) throw new Error("unsupported project registry version");
  keys(value, ["version", "projects", "memberships", ...(value["version"] === 2 ? ["receipts", "auditDigest"] : [])]);
  if (!Array.isArray(value["projects"]) || !Array.isArray(value["memberships"])) throw new Error("invalid project registry rows");
  const projects = value["projects"].map(project);
  if (new Set(projects.map((row) => row.id)).size !== projects.length ||
      new Set(projects.map((row) => row.name.toLocaleLowerCase())).size !== projects.length) throw new Error("duplicate project ID or name");
  const memberships = value["memberships"].map(membership);
  if (new Set(memberships.map((row) => row.taskId)).size !== memberships.length ||
      memberships.some((row) => !projects.some((entry) => entry.id === row.projectId))) throw new Error("invalid membership identity");
  if (value["version"] === 1) return { version: 1, projects, memberships };
  if (!Array.isArray(value["receipts"]) || value["receipts"].length > 1000) throw new Error("invalid association receipts");
  const receipts = value["receipts"].map(receipt);
  if (new Set(receipts.map((row) => row.id)).size !== receipts.length) throw new Error("duplicate association receipt");
  const digest = auditDigest(projects, memberships, receipts);
  if (value["auditDigest"] !== digest) throw new Error("project registry audit integrity mismatch");
  return { version: 2, projects, memberships, receipts, auditDigest: digest };
}

function sameIdentity(stored: ProjectMembership, actual: VerifiedTaskIdentity): boolean {
  return stored.taskId === actual.taskId && stored.createdAt === actual.createdAt &&
    stored.root === actual.root && stored.dirId === actual.dirId && stored.realRoot === actual.realRoot &&
    stored.directoryDevice === actual.directoryDevice && stored.directoryInode === actual.directoryInode;
}
function appendReceipt(doc: Document, entry: AssociationReceipt): void {
  const receipts = doc.receipts ?? [];
  if (receipts.length >= 1000) throw new Error("association receipt capacity exceeded");
  doc.version = 2;
  doc.receipts = [...receipts, entry];
}
function recordAction(doc: Document, action: TaskAssociationReceipt["action"], identity: Omit<ProjectMembership, "projectId">,
  fromProjectId: string | null, toProjectId: string | null): TaskAssociationReceipt {
  const entry: TaskAssociationReceipt = { id: randomUUID(), at: new Date().toISOString(), action,
    taskId: identity.taskId, createdAt: identity.createdAt, root: identity.root, dirId: identity.dirId,
    ...(identity.realRoot === undefined ? {} : { realRoot: identity.realRoot }),
    ...(identity.directoryDevice === undefined ? {} : { directoryDevice: identity.directoryDevice, directoryInode: identity.directoryInode }),
    fromProjectId, toProjectId };
  appendReceipt(doc, entry);
  return entry;
}

export function projectRegistryPath(userData: string): string { return join(userData, FILE); }
function safeFile(file: string): boolean {
  try {
    if (!lstatSync(file).isFile()) throw new Error("invalid project registry file");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function writeTemp(file: string, content: string): void {
  const fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(dir: string): void {
  // Node cannot portably open Windows directories for fsync; rename remains atomic there.
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Only main owns this store; a single instance serializes every local write. */
export class ProjectRegistry {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly userData: string, private readonly hooks: { beforeCommit?: () => void; afterBackup?: () => void } = {}) {}

  private load(): { initialized: boolean; value: Document } {
    const file = projectRegistryPath(this.userData);
    if (!safeFile(file)) {
      if (safeFile(`${file}.bak`)) throw new Error("project registry missing; backup requires explicit recovery");
      return { initialized: false, value: { version: 1, projects: [], memberships: [] } };
    }
    const raw = readFileSync(file);
    if (raw.length > MAX_BYTES) throw new Error("project registry too large");
    return { initialized: true, value: document(JSON.parse(raw.toString("utf8"))) };
  }
  list(): { initialized: boolean; projects: LocalProject[] } {
    const { initialized, value } = this.load();
    return { initialized, projects: value.projects };
  }
  get(projectId: string): LocalProject | undefined { return this.load().value.projects.find((item) => item.id === id(projectId)); }

  private save(next: Document, previous: boolean): void {
    const file = projectRegistryPath(this.userData);
    const root = this.userData;
    try {
      const stat = lstatSync(root);
      if (!stat.isDirectory()) throw new Error("invalid project registry directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(root, { recursive: true, mode: 0o700 });
    }
    const serialized = JSON.stringify(document(next));
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error("project registry too large");
    const tmp = `${file}.${randomUUID()}.tmp`;
    const backupTmp = `${file}.${randomUUID()}.bak.tmp`;
    try {
      writeTemp(tmp, serialized);
      this.hooks.beforeCommit?.();
      if (previous && safeFile(`${file}.bak`)) document(JSON.parse(readFileSync(`${file}.bak`, "utf8")));
      const backup = previous ? readFileSync(file, "utf8") : serialized;
      if (previous) document(JSON.parse(backup));
      writeTemp(backupTmp, backup);
      renameSync(backupTmp, `${file}.bak`);
      syncDirectory(root);
      this.hooks.afterBackup?.();
      renameSync(tmp, file);
      syncDirectory(root);
    } finally {
      rmSync(tmp, { force: true });
      rmSync(backupTmp, { force: true });
    }
  }
  private mutate<T>(fn: (value: Document) => T): Promise<T> {
    const operation = this.pending.then(() => {
      const { initialized, value } = this.load();
      const result = fn(value);
      if (value.version === 2) value.auditDigest = auditDigest(value.projects, value.memberships, value.receipts ?? []);
      this.save(value, initialized);
      return result;
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
  association(taskId: string, roots: TaskRootIndex): { taskId: string; projectId: string | null; state: "assigned" | "unassigned" | "needs-repair" | "unavailable" } {
    if (!isSafeTaskChildName(taskId)) throw new Error("invalid task ID");
    const stored = this.load().value.memberships.find((row) => row.taskId === taskId);
    const identity = roots.verifiedIdentity(taskId);
    if (!stored) return { taskId, projectId: null, state: identity ? "unassigned" : "unavailable" };
    return { taskId, projectId: stored.projectId,
      state: identity && sameIdentity(stored, identity) ? "assigned" : "needs-repair" };
  }
  associations(roots: TaskRootIndex): ReturnType<ProjectRegistry["association"]>[] {
    return this.load().value.memberships.map((row) => this.association(row.taskId, roots));
  }
  claim(taskId: string, projectId: string, roots: TaskRootIndex): Promise<AssociationReceipt> {
    return this.mutate((doc) => {
      const target = id(projectId);
      if (!isSafeTaskChildName(taskId)) throw new Error("invalid task ID");
      if (!doc.projects.some((row) => row.id === target)) throw new Error("unknown project");
      if (doc.memberships.some((row) => row.taskId === taskId)) throw new Error("task already associated; explicit transfer required");
      const identity = roots.verifiedIdentity(taskId);
      if (!identity) throw new Error("task identity unavailable");
      doc.memberships.push({ ...identity, projectId: target });
      return recordAction(doc, "claim", identity, null, target);
    });
  }
  unlink(taskId: string, expectedProjectId: string): Promise<AssociationReceipt> {
    return this.mutate((doc) => {
      const expected = id(expectedProjectId);
      if (!isSafeTaskChildName(taskId)) throw new Error("invalid task ID");
      const index = doc.memberships.findIndex((row) => row.taskId === taskId && row.projectId === expected);
      if (index < 0) throw new Error("association changed or missing");
      const [previous] = doc.memberships.splice(index, 1);
      return recordAction(doc, "unlink", previous!, expected, null);
    });
  }
  transfer(taskId: string, fromProjectId: string, toProjectId: string, roots: TaskRootIndex): Promise<AssociationReceipt> {
    return this.mutate((doc) => {
      const from = id(fromProjectId);
      const to = id(toProjectId);
      if (from === to || !doc.projects.some((row) => row.id === to)) throw new Error("invalid transfer target");
      if (!isSafeTaskChildName(taskId)) throw new Error("invalid task ID");
      const stored = doc.memberships.find((row) => row.taskId === taskId && row.projectId === from);
      if (!stored) throw new Error("association changed or missing");
      const identity = roots.verifiedIdentity(taskId);
      if (!identity || !sameIdentity(stored, identity)) throw new Error("task identity needs repair");
      stored.projectId = to;
      return recordAction(doc, "transfer", identity, from, to);
    });
  }
  create(input: ProjectCreateInput): Promise<LocalProject> {
    return this.mutate((value) => {
      if (!record(input)) throw new Error("invalid project input");
      keys(input, ["name", "description", "repositories", "directories"]);
      const created = project({ id: randomUUID(), name: input.name, description: input.description,
        repositories: sources(input.repositories, true), directories: sources(input.directories, true) });
      if ([...input.repositories, ...input.directories].some((item) => record(item) && Object.hasOwn(item, "id"))) {
        throw new Error("source ID is generated by main");
      }
      if (value.projects.some((item) => item.name.toLocaleLowerCase() === created.name.toLocaleLowerCase())) throw new Error("duplicate project name");
      value.projects.push(created);
      return created;
    });
  }
  update(projectId: string, input: ProjectUpdateInput): Promise<LocalProject> {
    return this.mutate((value) => {
      const current = value.projects.find((row) => row.id === id(projectId));
      if (!current) throw new Error("unknown project");
      if (!record(input)) throw new Error("invalid project input");
      keys(input, ["description", "repositories", "directories"]);
      const next = project({ ...current, description: input.description,
        repositories: sources(input.repositories, true), directories: sources(input.directories, true) });
      const oldIds = new Set([...current.repositories, ...current.directories].map((row) => row.id));
      if ([...next.repositories, ...next.directories].some((row) =>
        !oldIds.has(row.id) && [...input.repositories, ...input.directories].some((given) => given.id === row.id))) {
        throw new Error("unknown source ID");
      }
      value.projects[value.projects.indexOf(current)] = next;
      return next;
    });
  }
  rename(projectId: string, name: string): Promise<LocalProject> {
    return this.mutate((value) => {
      const current = value.projects.find((row) => row.id === id(projectId));
      if (!current) throw new Error("unknown project");
      const nextName = text(name, "project name");
      if (value.projects.some((item) => item.id !== current.id && item.name.toLocaleLowerCase() === nextName.toLocaleLowerCase())) throw new Error("duplicate project name");
      current.name = nextName;
      return current;
    });
  }
  delete(projectId: string): Promise<ProjectDeletionReceipt> {
    return this.mutate((value) => {
      const selected = id(projectId);
      const index = value.projects.findIndex((item) => item.id === selected);
      if (index < 0) throw new Error("unknown project");
      if (value.memberships.some((item) => item.projectId === selected)) throw new Error("project has associated tasks");
      const entry: ProjectDeletionReceipt = { id: randomUUID(), at: new Date().toISOString(), action: "delete", projectId: selected };
      value.projects.splice(index, 1);
      appendReceipt(value, entry);
      return entry;
    });
  }
}
