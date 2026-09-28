import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
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
}
interface Document { version: 1; projects: LocalProject[]; memberships: ProjectMembership[] }
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
export function sourcePath(value: unknown): string {
  const path = text(value, "source path", false, 4096);
  const windows = process.platform === "win32";
  const parser = windows ? win32 : posix;
  if (path.includes("?") || path.includes("#") || (windows ? !/^[a-zA-Z]:\\/.test(path) || path.includes("/") : !path.startsWith("/") || path.includes("\\")) ||
      !parser.isAbsolute(path) || parser.normalize(path) !== path || path === parser.parse(path).root ||
      path.split(windows ? "\\" : "/").some((part) => part === "." || part === "..")) {
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
function document(value: unknown): Document {
  if (!record(value)) throw new Error("invalid project registry");
  keys(value, ["version", "projects", "memberships"]);
  if (value["version"] !== 1) throw new Error("unsupported project registry version");
  if (!Array.isArray(value["projects"]) || !Array.isArray(value["memberships"])) throw new Error("invalid project registry rows");
  const projects = value["projects"].map(project);
  if (new Set(projects.map((row) => row.id)).size !== projects.length ||
      new Set(projects.map((row) => row.name.toLocaleLowerCase())).size !== projects.length) throw new Error("duplicate project ID or name");
  const memberships = value["memberships"].map((item: unknown): ProjectMembership => {
    if (!record(item)) throw new Error("invalid membership");
    keys(item, ["taskId", "projectId", "createdAt", "root", "dirId"]);
    const taskId = text(item["taskId"], "task ID");
    const dirId = text(item["dirId"], "dirId");
    if (!isSafeTaskChildName(taskId) || !isTaskDirId(dirId)) throw new Error("invalid membership task identity");
    return { taskId, projectId: id(item["projectId"]),
      createdAt: text(item["createdAt"], "createdAt"), root: sourcePath(item["root"]), dirId };
  });
  if (new Set(memberships.map((row) => row.taskId)).size !== memberships.length ||
      memberships.some((row) => !projects.some((entry) => entry.id === row.projectId))) throw new Error("invalid membership identity");
  return { version: 1, projects, memberships };
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

/** Only main owns this store; a single instance serializes every local write. */
export class ProjectRegistry {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly userData: string, private readonly hooks: { beforeCommit?: () => void } = {}) {}

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
      if (previous) {
        if (safeFile(`${file}.bak`)) document(JSON.parse(readFileSync(`${file}.bak`, "utf8")));
        const prior = readFileSync(file, "utf8");
        document(JSON.parse(prior));
        writeTemp(backupTmp, prior);
        renameSync(backupTmp, `${file}.bak`);
      }
      renameSync(tmp, file);
    } finally {
      rmSync(tmp, { force: true });
      rmSync(backupTmp, { force: true });
    }
  }
  private mutate<T>(fn: (value: Document) => T): Promise<T> {
    const operation = this.pending.then(() => {
      const { initialized, value } = this.load();
      const result = fn(value);
      this.save(value, initialized);
      return result;
    });
    this.pending = operation.catch(() => undefined);
    return operation;
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
  delete(projectId: string): Promise<void> {
    return this.mutate((value) => {
      const selected = id(projectId);
      const index = value.projects.findIndex((item) => item.id === selected);
      if (index < 0) throw new Error("unknown project");
      if (value.memberships.some((item) => item.projectId === selected)) throw new Error("project has associated tasks");
      value.projects.splice(index, 1);
    });
  }
}
