import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, realpathSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, type BigIntStats } from "node:fs";
import type { ServiceOwnerCatalogSnapshot } from "../rpc/service-host-binding.js";
import { isAbsolute, join, normalize } from "node:path";
import { readTaskRecordOnDisk } from "../host/task-store.js";
import { SERVICE_KEY_PATTERN, isServiceSecretKey, maskServiceValue, resolveServiceEnv, validateNoSecretsInShared, validateServiceDescriptor,
  type ServiceConfigEntry, type ServiceConfigSource, type ServiceDescriptor } from "./service-config.js";
import { isSafeTaskChildName } from "./task-provision.js";
import type { ProjectRegistry } from "./project-registry.js";
import type { TaskRootIndex, VerifiedTaskIdentity } from "./task-root-index.js";

/** Main-only storage. Shared revisions exclude local program paths and private reference values; arbitrary literals still require human review. */
export interface ServiceTemplate {
  projectId: string;
  serviceId: string;
  version: number;
  descriptor: Pick<ServiceDescriptor, "name" | "program" | "args" | "ports" | "healthCheck" | "runType">;
  shared: ServiceConfigEntry[];
}
export interface ServiceTaskBinding {
  taskId: string;
  projectId: string;
  identity: VerifiedTaskIdentity;
  serviceId: string;
  templateVersion: number;
  rootId: string;
  subdir: string;
  programPath: string;
  privateRefs: { key: string; envRef: string }[];
}
export interface SavedServiceConfigPreview {
  taskId: string;
  serviceId: string;
  templateVersion: number;
  scope: "saved-config";
  state: "ready" | "blocked";
  error?: "private-reference-unavailable" | "environment-resolution-failed";
  rows: { key: string; value: string; masked: boolean; source: ServiceConfigSource }[];
}

/**
 * Trusted launch material for one task-bound service ([PiDock 04] #7).
 * Main-only: it carries the local program path and the resolved private
 * values, so it is never a projection sent to a page and never a page
 * payload. The Host receives it as an executable *registration*, not as a
 * launch plan it can be told to run by name.
 */
export interface ServiceLaunch {
  serviceId: string;
  templateVersion: number;
  descriptor: ServiceDescriptor;
  layers: {
    repoDefaults: ServiceConfigEntry[];
    shared: ServiceConfigEntry[];
    privateEntries: ServiceConfigEntry[];
    task: ServiceConfigEntry[];
  };
}

export interface ServiceCatalogAuthority {
  projectExists(projectId: string): boolean;
  task(taskId: string): { identity: VerifiedTaskIdentity; projectId: string; rootIds: string[] } | null;
  verifiedTask?(taskId: string): { identity: VerifiedTaskIdentity; projectId: string | null; rootIds: string[] } | null;
}

/** Resolves authority from the persisted task index and project association, not page-supplied paths. */
export function serviceCatalogAuthority(roots: TaskRootIndex, projects: ProjectRegistry): ServiceCatalogAuthority {
  const verifiedTask: NonNullable<ServiceCatalogAuthority["verifiedTask"]> = (taskId) => {
    const identity = roots.verifiedIdentity(taskId);
    if (!identity) return null;
    const association = projects.association(taskId, roots);
    if (association.state !== "assigned" && association.state !== "unassigned") return null;
    const record = readTaskRecordOnDisk(join(identity.root, identity.dirId));
    if (!record || record.taskId !== taskId || record.createdAt !== identity.createdAt) return null;
    return { identity, projectId: association.projectId, rootIds: record.repos };
  };
  return {
    projectExists: (projectId) => projects.get(projectId) !== undefined,
    verifiedTask,
    task: (taskId) => {
      const owner = verifiedTask(taskId);
      return owner?.projectId ? { ...owner, projectId: owner.projectId } : null;
    },
  };
}

const TEMPLATES = "service-templates.json";
const PRIVATE = "service-machine.json";
const MAX_BYTES = 1024 * 1024;
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERVICE_ID = /^s-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type TemplateDocument = { version: 1; revisions: ServiceTemplate[] };
type PrivateDocument = { version: 1; bindings: ServiceTaskBinding[] };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid service catalog");
  return value as Record<string, unknown>;
}
function fields(row: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some((key) => !Object.hasOwn(row, key)) || Object.keys(row).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error("invalid service catalog fields");
  }
}
function text(value: unknown, length: number): string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > length || value.includes("\0")) {
    throw new Error("invalid service catalog text");
  }
  return value;
}
function projectId(value: unknown): string {
  const result = text(value, 36);
  if (!PROJECT_ID.test(result)) throw new Error("invalid project ID");
  return result;
}
function serviceId(value: unknown): string {
  const result = text(value, 38);
  if (!SERVICE_ID.test(result)) throw new Error("invalid service ID");
  return result;
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("invalid template version");
  return value as number;
}
function descriptor(value: unknown): ServiceTemplate["descriptor"] {
  const row = object(value);
  fields(row, ["name", "program", "args", "ports", "runType"], ["healthCheck"]);
  const name = text(row["name"], 128);
  const program = text(row["program"], 128);
  if (!/^[A-Za-z0-9_.+-]+$/.test(program)) throw new Error("shared program must be a portable name");
  if (!Array.isArray(row["args"]) || row["args"].length > 40 || row["args"].some((arg) => typeof arg !== "string" ||
      arg.length > 512 || /[\r\n\0]/.test(arg) || /(?:^|=)(?:\/|~\/|[A-Za-z]:[\\/])/.test(arg) ||
      /(?:password|token|secret|api[_-]?key)/i.test(arg) || /:\/\/[^/\s]+@/.test(arg))) {
    throw new Error("invalid or private shared argument");
  }
  if (!Array.isArray(row["ports"]) || row["ports"].length > 20 || new Set(row["ports"]).size !== row["ports"].length) {
    throw new Error("invalid service ports");
  }
  if (!["long-lived", "prepare", "one-shot"].includes(row["runType"] as string)) throw new Error("invalid run type");
  let healthCheck: ServiceDescriptor["healthCheck"];
  if (row["healthCheck"] !== undefined) {
    const health = object(row["healthCheck"]);
    fields(health, ["kind"], ["target"]);
    if (!["http", "tcp", "grpc"].includes(health["kind"] as string)) throw new Error("invalid health check");
    if (health["target"] !== undefined && (typeof health["target"] !== "string" || health["target"].length > 512 ||
        /[\r\n\0]/.test(health["target"]) || /:\/\/[^/\s]+@|[?&](?:token|key|secret|password)=/i.test(health["target"]))) {
      throw new Error("private health target is not shared");
    }
    healthCheck = { kind: health["kind"] as "http" | "tcp" | "grpc", ...(health["target"] === undefined ? {} : { target: health["target"] as string }) };
  }
  const result: ServiceTemplate["descriptor"] = { name, program, args: [...row["args"]] as string[],
    ports: [...row["ports"]] as number[], runType: row["runType"] as ServiceDescriptor["runType"],
    ...(healthCheck === undefined ? {} : { healthCheck }) };
  if (validateServiceDescriptor(result)) throw new Error("invalid service descriptor");
  return result;
}
function shared(value: unknown): ServiceConfigEntry[] {
  if (!Array.isArray(value) || value.length > 80) throw new Error("invalid shared entries");
  const entries = value.map((item) => {
    const row = object(item);
    fields(row, ["key", "value", "secret"]);
    const key = text(row["key"], 100);
    if (!SERVICE_KEY_PATTERN.test(key) || row["secret"] !== false || isServiceSecretKey(key)) throw new Error("private key in shared template");
    if (typeof row["value"] !== "string" || row["value"].length > 2048 || /[\0\r\n]/.test(row["value"]) ||
        /:\/\/[^/\s]+@|[?&](?:token|key|secret|password)=/i.test(row["value"])) throw new Error("invalid shared value");
    return { key, value: row["value"], secret: false };
  });
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length || validateNoSecretsInShared(entries)) {
    throw new Error("invalid shared entries");
  }
  return entries;
}
function template(value: unknown): ServiceTemplate {
  const row = object(value);
  fields(row, ["projectId", "serviceId", "version", "descriptor", "shared"]);
  return { projectId: projectId(row["projectId"]), serviceId: serviceId(row["serviceId"]),
    version: version(row["version"]), descriptor: descriptor(row["descriptor"]), shared: shared(row["shared"]) };
}
function identity(value: unknown): VerifiedTaskIdentity {
  const row = object(value);
  fields(row, ["taskId", "createdAt", "root", "dirId", "realRoot", "directoryDevice", "directoryInode"]);
  const taskId = text(row["taskId"], 128);
  if (!isSafeTaskChildName(taskId)) throw new Error("invalid task identity");
  const root = text(row["root"], 4096);
  const realRoot = text(row["realRoot"], 4096);
  if (!isAbsolute(root) || !isAbsolute(realRoot) || normalize(root) !== root || normalize(realRoot) !== realRoot) {
    throw new Error("invalid task root identity");
  }
  const device = text(row["directoryDevice"], 32);
  const inode = text(row["directoryInode"], 32);
  if (!/^[1-9][0-9]*$/.test(device) || !/^[1-9][0-9]*$/.test(inode)) throw new Error("invalid task directory identity");
  return { taskId, createdAt: text(row["createdAt"], 64), root, realRoot,
    dirId: text(row["dirId"], 80), directoryDevice: device, directoryInode: inode };
}
function binding(value: unknown): ServiceTaskBinding {
  const row = object(value);
  fields(row, ["taskId", "projectId", "identity", "serviceId", "templateVersion", "rootId", "subdir", "programPath", "privateRefs"]);
  const task = identity(row["identity"]);
  const taskId = text(row["taskId"], 128);
  if (task.taskId !== taskId) throw new Error("binding task identity mismatch");
  const rootId = text(row["rootId"], 128);
  if (!isSafeTaskChildName(rootId)) throw new Error("invalid service root");
  if (typeof row["subdir"] !== "string" || row["subdir"].length > 512 || row["subdir"].includes("\\") || row["subdir"].includes("\0") ||
      (row["subdir"] !== "" && row["subdir"].split("/").some((part) => !isSafeTaskChildName(part) || /[<>:"|?*]/.test(part) || /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) {
    throw new Error("invalid service subdirectory");
  }
  const programPath = text(row["programPath"], 4096);
  if (!isAbsolute(programPath) || normalize(programPath) !== programPath) throw new Error("invalid local program path");
  if (!Array.isArray(row["privateRefs"]) || row["privateRefs"].length > 80) throw new Error("invalid private references");
  const privateRefs = row["privateRefs"].map((entry) => {
    const ref = object(entry);
    fields(ref, ["key", "envRef"]);
    const key = text(ref["key"], 100);
    const envRef = text(ref["envRef"], 100);
    if (!SERVICE_KEY_PATTERN.test(key) || !SERVICE_KEY_PATTERN.test(envRef) || /^PIDOCK_PROVIDER_/i.test(envRef)) {
      throw new Error("invalid private reference");
    }
    return { key, envRef };
  });
  const names = privateRefs.map((ref) => process.platform === "win32" ? ref.key.toUpperCase() : ref.key);
  if (new Set(names).size !== names.length) throw new Error("duplicate private references");
  return { taskId, projectId: projectId(row["projectId"]), identity: task, serviceId: serviceId(row["serviceId"]),
    templateVersion: version(row["templateVersion"]), rootId, subdir: row["subdir"], programPath, privateRefs };
}
function templates(value: unknown): TemplateDocument {
  const row = object(value);
  fields(row, ["version", "revisions"]);
  if (row["version"] !== 1 || !Array.isArray(row["revisions"]) || row["revisions"].length > 500) throw new Error("invalid template document");
  const revisions = row["revisions"].map(template);
  const keys = revisions.map((entry) => `${entry.projectId}/${entry.serviceId}/${entry.version}`);
  if (new Set(keys).size !== keys.length) throw new Error("duplicate template revision");
  return { version: 1, revisions };
}
function machine(value: unknown): PrivateDocument {
  const row = object(value);
  fields(row, ["version", "bindings"]);
  if (row["version"] !== 1 || !Array.isArray(row["bindings"]) || row["bindings"].length > 500) throw new Error("invalid machine document");
  const bindings = row["bindings"].map(binding);
  if (new Set(bindings.map((entry) => `${entry.taskId}/${entry.serviceId}`)).size !== bindings.length) throw new Error("duplicate task service binding");
  return { version: 1, bindings };
}
function readDocument<T>(file: string, empty: T, parse: (value: unknown) => T): T {
  if (!existsSync(file)) {
    if (existsSync(`${file}.bak`)) throw new Error("service catalog primary missing; recovery required");
    return empty;
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_BYTES || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
    throw new Error("service catalog unreadable");
  }
  return parse(JSON.parse(readFileSync(file, "utf8")));
}
function writeDocument<T>(directory: string, file: string, value: T, parse: (value: unknown) => T): void {
  const body = JSON.stringify(parse(value));
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("service catalog too large");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new Error("invalid service catalog directory");
  const temp = `${file}.${randomUUID()}.tmp`;
  const backupTemp = `${file}.${randomUUID()}.bak.tmp`;
  const write = (path: string, data: string) => {
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  };
  try {
    write(temp, body);
    const prior = existsSync(file) ? readFileSync(file, "utf8") : body;
    parse(JSON.parse(prior));
    write(backupTemp, prior);
    renameSync(backupTemp, `${file}.bak`);
    renameSync(temp, file);
    if (process.platform !== "win32") {
      const fd = openSync(directory, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  } finally { rmSync(temp, { force: true }); rmSync(backupTemp, { force: true }); }
}

export function resolvePrivateServiceRefs(
  refs: ServiceTaskBinding["privateRefs"], env: Record<string, string | undefined>,
): ServiceConfigEntry[] {
  return refs.map(({ key, envRef }) => {
    if (!SERVICE_KEY_PATTERN.test(key) || !SERVICE_KEY_PATTERN.test(envRef) || /^PIDOCK_PROVIDER_/i.test(envRef)) {
      throw new Error("invalid private reference");
    }
    const value = env[envRef];
    if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0")) {
      throw new Error("missing or invalid private reference");
    }
    return { key, value, secret: true };
  });
}

function sameIdentity(a: VerifiedTaskIdentity, b: VerifiedTaskIdentity): boolean {
  return a.taskId === b.taskId && a.createdAt === b.createdAt && a.root === b.root && a.dirId === b.dirId &&
    a.realRoot === b.realRoot && a.directoryDevice === b.directoryDevice && a.directoryInode === b.directoryInode;
}

/** One main-process instance is the only writer; no renderer or Host can write these files. */
export class ServiceCatalog {
  constructor(private readonly directory: string, private readonly authority: ServiceCatalogAuthority) {}
  private templateFile(): string { return join(this.directory, TEMPLATES); }
  private machineFile(): string { return join(this.directory, PRIVATE); }
  private readTemplates(): TemplateDocument { return readDocument(this.templateFile(), { version: 1, revisions: [] }, templates); }
  private readMachine(): PrivateDocument { return readDocument(this.machineFile(), { version: 1, bindings: [] }, machine); }
  private requireTask(taskId: string) {
    const owner = this.authority.task(taskId);
    if (!owner || owner.identity.taskId !== taskId || !this.authority.projectExists(owner.projectId)) throw new Error("task identity unavailable");
    return owner;
  }
  /**
   * Verified physical launch paths of one binding: every component under the
   * task root must be a real directory (no symlinked level) and the program
   * must be an executable regular file. A snapshot, not an atomic open.
   */
  private verifiedLaunchPaths(binding: ServiceTaskBinding, taskRoot: string): { cwd: string; cwdStat: BigIntStats; program: string; programStat: BigIntStats } {
    const cwd = join(taskRoot, binding.rootId, binding.subdir);
    const parts = [binding.rootId, ...binding.subdir.split("/").filter(Boolean)];
    for (let index = 1; index <= parts.length; index++) {
      const path = join(taskRoot, ...parts.slice(0, index));
      if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) throw Error();
    }
    const cwdStat = lstatSync(cwd, { bigint: true });
    const program = realpathSync(binding.programPath), programStat = lstatSync(program, { bigint: true });
    if (!programStat.isFile()) throw Error();
    accessSync(program, constants.X_OK);
    return { cwd, cwdStat, program, programStat };
  }
  /** The trusted task-root directory of a verified identity, checked against its recorded device/inode. */
  private verifiedTaskRoot(owner: { identity: VerifiedTaskIdentity }): string {
    const taskRoot = join(owner.identity.realRoot, owner.identity.dirId);
    const root = lstatSync(taskRoot, { bigint: true });
    if (!root.isDirectory() || realpathSync(taskRoot) !== taskRoot ||
        root.dev.toString() !== owner.identity.directoryDevice || root.ino.toString() !== owner.identity.directoryInode) throw Error();
    return taskRoot;
  }
  /**
   * Trusted launch material for one task-bound service ([PiDock 04] #7): the
   * pinned template version, the verified absolute program/cwd and the
   * resolved env layers (shared literals plus this machine's private
   * reference values). Main alone resolves it from the persisted catalog -
   * the page names only project/task/service, never a program or a value.
   * Errors are a single fixed code so no private path or value escapes.
   */
  launchFor(taskId: string, project: string, id: string, privateEnv: Record<string, string | undefined>): ServiceLaunch {
    try {
      const owner = this.requireTask(taskId);
      const selected = this.taskBindings(project, taskId).find((row) => row.binding.serviceId === serviceId(id));
      if (!selected) throw Error();
      const taskRoot = this.verifiedTaskRoot(owner);
      const { cwd, program } = this.verifiedLaunchPaths(selected.binding, taskRoot);
      const privateEntries = resolvePrivateServiceRefs(selected.binding.privateRefs, privateEnv);
      const pinned = selected.template.descriptor;
      const descriptor: ServiceDescriptor = { id: selected.binding.serviceId, name: pinned.name, program,
        args: [...pinned.args], cwd, ports: [...pinned.ports],
        ...(pinned.healthCheck === undefined ? {} : { healthCheck: { ...pinned.healthCheck } }), runType: pinned.runType };
      if (validateServiceDescriptor(descriptor)) throw Error();
      const resolved = resolveServiceEnv({ repoDefaults: [], shared: selected.template.shared, privateEntries, task: [] });
      if (!resolved.ok) throw Error();
      return { serviceId: selected.binding.serviceId, templateVersion: selected.binding.templateVersion, descriptor,
        layers: { repoDefaults: [], shared: selected.template.shared.map((entry) => ({ ...entry })), privateEntries, task: [] } };
    } catch { throw Error("service-launch-unavailable"); }
  }
  /** Trusted main snapshot only. Saved metadata is a contract to review, never execution authority.
   * File identities/commitments are freshness snapshots, not atomic execution or same-UID isolation. */
  ownerSnapshot(taskId: string, workspaceId: string, privateEnv: Record<string, string | undefined>): ServiceOwnerCatalogSnapshot {
    try {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId) || !/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) throw Error();
      const owner = this.authority.verifiedTask?.(taskId);
      if (!owner || owner.identity.taskId !== taskId || owner.projectId !== null && !this.authority.projectExists(owner.projectId)) throw Error();
      const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
      const taskRoot = this.verifiedTaskRoot(owner);
      const bindings = this.readMachine().bindings.filter((row) => row.taskId === taskId);
      if (owner.projectId === null && bindings.length) throw Error();
      // Read both documents even for empty/unassigned tasks: corrupt catalogs never mean zero services.
      this.readTemplates();
      const selected = owner.projectId === null ? [] : this.listTask(taskId);
      const entries = selected.map(({ binding, template }) => {
        const { cwd, cwdStat, program, programStat } = this.verifiedLaunchPaths(binding, taskRoot);
        const privateEntries = resolvePrivateServiceRefs(binding.privateRefs, privateEnv);
        const env = resolveServiceEnv({ repoDefaults: [], shared: template.shared, privateEntries, task: [] });
        if (!env.ok || env.rows.some((row) => row.value.length > 4096 || row.value.includes("\0"))) throw Error();
        const envRevision = digest(env.rows.map((row) => [row.key, row.value]).sort(([a], [b]) => a.localeCompare(b)));
        return { serviceId: binding.serviceId, templateVersion: binding.templateVersion, configRevision: digest({ binding, template, envRevision }),
          program, args: [...template.descriptor.args], cwd, envRevision,
          programIdentity: digest([program, programStat.dev.toString(), programStat.ino.toString(), programStat.size.toString(), programStat.mtimeNs.toString()]),
          cwdIdentity: digest([cwd, cwdStat.dev.toString(), cwdStat.ino.toString()]) };
      }).sort((a, b) => a.serviceId.localeCompare(b.serviceId));
      const taskIdentity = digest(owner.identity);
      const snapshot = { workspaceId, taskId, projectId: owner.projectId, taskIdentity, entries };
      return { ...snapshot, catalogRevision: digest(snapshot) };
    } catch { throw Error("service-owner-catalog-unavailable"); }
  }
  saveTemplate(input: { projectId: string; serviceId?: string; expectedVersion?: number;
    descriptor: ServiceTemplate["descriptor"]; shared: ServiceConfigEntry[] }): ServiceTemplate {
    const project = projectId(input.projectId);
    if (!this.authority.projectExists(project)) throw new Error("project unavailable");
    const doc = this.readTemplates();
    const id = input.serviceId === undefined ? `s-${randomUUID()}` : serviceId(input.serviceId);
    const existing = doc.revisions.filter((entry) => entry.projectId === project && entry.serviceId === id);
    const latest = existing.reduce((max, entry) => Math.max(max, entry.version), 0);
    if ((input.expectedVersion ?? 0) !== latest) throw new Error("template version conflict");
    if (doc.revisions.some((entry) => entry.serviceId === id && entry.projectId !== project)) throw new Error("service belongs to another project");
    const next = template({ projectId: project, serviceId: id, version: latest + 1, descriptor: input.descriptor, shared: input.shared });
    writeDocument(this.directory, this.templateFile(), { version: 1, revisions: [...doc.revisions, next] }, templates);
    return next;
  }
  listTemplates(project: string): ServiceTemplate[] {
    if (!this.authority.projectExists(projectId(project))) throw new Error("project unavailable");
    const latest = new Map<string, ServiceTemplate>();
    for (const row of this.readTemplates().revisions) {
      if (row.projectId === project && (latest.get(row.serviceId)?.version ?? 0) < row.version) latest.set(row.serviceId, row);
    }
    return [...latest.values()].sort((a, b) => a.descriptor.name.localeCompare(b.descriptor.name));
  }
  template(project: string, id: string, selectedVersion: number): ServiceTemplate | null {
    if (!this.authority.projectExists(projectId(project))) throw new Error("project unavailable");
    return this.readTemplates().revisions.find((row) => row.projectId === project && row.serviceId === serviceId(id) && row.version === version(selectedVersion)) ?? null;
  }
  prepareTaskBinding(project: string, input: Omit<ServiceTaskBinding, "projectId" | "identity" | "programPath">): ServiceTaskBinding {
    const owner = this.requireTask(input.taskId);
    if (owner.projectId !== projectId(project)) throw new Error("task project changed");
    if (this.listTask(input.taskId).some((row) => row.binding.serviceId === input.serviceId)) throw new Error("service already bound");
    if (!owner.rootIds.includes(input.rootId)) throw new Error("service root is not registered on task");
    if (!this.template(project, input.serviceId, input.templateVersion)) throw new Error("template version unavailable");
    // Placeholder is only for schema validation; the native picker supplies the persisted path.
    return binding({ ...input, projectId: project, identity: owner.identity, programPath: process.execPath });
  }
  commitTaskBinding(prepared: ServiceTaskBinding, programPath: string): ServiceTaskBinding {
    const owner = this.requireTask(prepared.taskId);
    if (owner.projectId !== prepared.projectId || !sameIdentity(owner.identity, prepared.identity)) {
      throw new Error("task identity changed during selection");
    }
    if (this.listTask(prepared.taskId).some((row) => row.binding.serviceId === prepared.serviceId)) throw new Error("service already bound");
    const { taskId, serviceId, templateVersion, rootId, subdir, privateRefs } = prepared;
    return this.bindTask({ taskId, serviceId, templateVersion, rootId, subdir, privateRefs, programPath });
  }
  previewSavedConfig(project: string, taskId: string, id: string, env: Record<string, string | undefined>): SavedServiceConfigPreview {
    const selected = this.taskBindings(project, taskId).find((row) => row.binding.serviceId === serviceId(id));
    if (!selected) throw new Error("service binding unavailable");
    const base = { taskId, serviceId: id, templateVersion: selected.binding.templateVersion, scope: "saved-config" as const };
    let privateEntries: ServiceConfigEntry[];
    try { privateEntries = resolvePrivateServiceRefs(selected.binding.privateRefs, env); }
    catch { return { ...base, state: "blocked", error: "private-reference-unavailable", rows: [] }; }
    const resolved = resolveServiceEnv({ repoDefaults: [], shared: selected.template.shared, privateEntries, task: [] });
    if (!resolved.ok) return { ...base, state: "blocked", error: "environment-resolution-failed", rows: [] };
    const secrets = [...privateEntries.map((row) => row.value), ...resolved.rows.filter((row) => row.secret).map((row) => row.value)].filter(Boolean);
    return { ...base, state: "ready", rows: resolved.rows.map((row) => {
      // Also mask an unmarked shared literal that happens to include a private value.
      const masked = row.secret || isServiceSecretKey(row.key) || secrets.some((secret) => row.value.includes(secret));
      return { key: row.key, value: maskServiceValue({ ...row, secret: masked }), masked, source: row.source };
    }) };
  }
  taskBindings(project: string, taskId: string): { binding: ServiceTaskBinding; template: ServiceTemplate }[] {
    if (this.requireTask(taskId).projectId !== projectId(project)) throw new Error("task project changed");
    return this.listTask(taskId);
  }
  bindTask(input: Omit<ServiceTaskBinding, "projectId" | "identity">): ServiceTaskBinding {
    const owner = this.requireTask(input.taskId);
    if (!owner.rootIds.includes(input.rootId)) throw new Error("service root is not registered on task");
    const doc = this.readMachine();
    const previous = doc.bindings.find((entry) => entry.taskId === input.taskId && entry.serviceId === input.serviceId);
    if (previous && (previous.projectId !== owner.projectId || !sameIdentity(previous.identity, owner.identity))) {
      throw new Error("stored service task identity changed");
    }
    const selected = this.template(owner.projectId, input.serviceId, input.templateVersion);
    if (!selected) throw new Error("template version unavailable");
    const next = binding({ ...input, identity: owner.identity, projectId: owner.projectId });
    doc.bindings = [...doc.bindings.filter((entry) => entry.taskId !== input.taskId || entry.serviceId !== input.serviceId), next];
    writeDocument(this.directory, this.machineFile(), doc, machine);
    return next;
  }
  listTask(taskId: string): { binding: ServiceTaskBinding; template: ServiceTemplate }[] {
    const owner = this.requireTask(taskId);
    const doc = this.readMachine();
    return doc.bindings.filter((row) => row.taskId === taskId).map((row) => {
      if (row.projectId !== owner.projectId || !sameIdentity(row.identity, owner.identity) ||
          !owner.rootIds.includes(row.rootId)) throw new Error("stored service task identity changed");
      const selected = this.template(owner.projectId, row.serviceId, row.templateVersion);
      if (!selected) throw new Error("pinned template version missing");
      return { binding: row, template: selected };
    });
  }
}
