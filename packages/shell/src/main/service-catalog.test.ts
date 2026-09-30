import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ServiceCatalog, resolvePrivateServiceRefs, serviceCatalogAuthority, type ServiceCatalogAuthority } from "./service-catalog.js";
import { ProjectRegistry } from "./project-registry.js";
import { TaskRootIndex } from "./task-root-index.js";
import type { VerifiedTaskIdentity } from "./task-root-index.js";

const projectId = randomUUID();
const otherProjectId = randomUUID();
const taskId = "task-catalog-a";
const identity: VerifiedTaskIdentity = {
  taskId, createdAt: "2026-01-01T00:00:00.000Z", root: join(tmpdir(), "catalog-tasks"),
  dirId: "task-12345678", realRoot: join(tmpdir(), "catalog-tasks"),
  directoryDevice: "10", directoryInode: "20",
};
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pidock-service-catalog-"));
  directories.push(dir);
  let current: VerifiedTaskIdentity | null = { ...identity };
  let assigned = projectId;
  let roots = ["repo-a"];
  const authority: ServiceCatalogAuthority = {
    projectExists: (id) => id === projectId || id === otherProjectId,
    task: (id) => current && id === taskId ? { identity: { ...current }, projectId: assigned, rootIds: [...roots] } : null,
  };
  const catalog = new ServiceCatalog(dir, authority);
  const descriptor = { name: "API", program: "node", args: ["server.js"], ports: [3000], runType: "long-lived" as const };
  const save = () => catalog.saveTemplate({ projectId, descriptor, shared: [{ key: "PORT", value: "3000", secret: false }] });
  const bind = (serviceId: string, templateVersion = 1) => catalog.bindTask({ taskId, serviceId, templateVersion,
    rootId: "repo-a", subdir: "src/api", programPath: process.execPath,
    privateRefs: [{ key: "API_TOKEN", envRef: "LOCAL_API_TOKEN" }] });
  return { dir, catalog, descriptor, save, bind,
    replaceIdentity: (next: VerifiedTaskIdentity | null) => { current = next; },
    assign: (id: string) => { assigned = id; },
    setRoots: (next: string[]) => { roots = next; }, authority };
}

describe("machine-private service catalog", () => {
  it("persists separate shared revisions and private references while pinning old task versions", () => {
    const f = fixture();
    const first = f.save();
    expect(first).toMatchObject({ projectId, version: 1, descriptor: f.descriptor });
    expect(first.serviceId).toMatch(/^s-/);
    f.bind(first.serviceId);
    const second = f.catalog.saveTemplate({ projectId, serviceId: first.serviceId, expectedVersion: 1,
      descriptor: { ...f.descriptor, args: ["new-server.js"] }, shared: [{ key: "PORT", value: "4000", secret: false }] });
    expect(second.version).toBe(2);
    const restarted = new ServiceCatalog(f.dir, f.authority);
    expect(restarted.listTask(taskId)[0]).toMatchObject({
      binding: { templateVersion: 1, rootId: "repo-a", privateRefs: [{ key: "API_TOKEN", envRef: "LOCAL_API_TOKEN" }] },
      template: { version: 1, descriptor: f.descriptor, shared: [{ key: "PORT", value: "3000", secret: false }] },
    });
    expect(restarted.template(projectId, first.serviceId, 2)?.descriptor.args).toEqual(["new-server.js"]);
    expect(readFileSync(join(f.dir, "service-templates.json"), "utf8")).not.toContain(process.execPath);
    expect(readFileSync(join(f.dir, "service-templates.json"), "utf8")).not.toContain("LOCAL_API_TOKEN");
    expect(readFileSync(join(f.dir, "service-machine.json"), "utf8")).not.toContain("credential-value");
    if (process.platform !== "win32") {
      expect(statSync(join(f.dir, "service-machine.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects stale template edits and values or command flags that look private", () => {
    const f = fixture();
    const first = f.save();
    expect(() => f.catalog.saveTemplate({ projectId, serviceId: first.serviceId, expectedVersion: 0,
      descriptor: f.descriptor, shared: [] })).toThrow("template version conflict");
    expect(() => f.catalog.saveTemplate({ projectId, descriptor: f.descriptor,
      shared: [{ key: "API_TOKEN", value: "credential-value", secret: false }] })).toThrow("private key");
    expect(() => f.catalog.saveTemplate({ projectId, descriptor: { ...f.descriptor, args: ["--token", "credential-value"] },
      shared: [] })).toThrow("private shared argument");
    expect(() => f.catalog.saveTemplate({ projectId, descriptor: { ...f.descriptor, program: "/usr/bin/node" },
      shared: [] })).toThrow("portable name");
    expect(() => f.catalog.saveTemplate({ projectId, descriptor: f.descriptor,
      shared: [{ key: "API_URL", value: "https://user:pass@example.test", secret: false }] })).toThrow("invalid shared value");
    expect(f.catalog.template(projectId, first.serviceId, 2)).toBeNull();
  });

  it("requires an assigned live task, registered root, and exact pinned template", () => {
    const f = fixture();
    const first = f.save();
    f.replaceIdentity(null);
    expect(() => f.bind(first.serviceId)).toThrow("task identity unavailable");
    f.replaceIdentity({ ...identity });
    f.setRoots([]);
    expect(() => f.bind(first.serviceId)).toThrow("service root is not registered");
    f.setRoots(["repo-a"]);
    expect(() => f.bind(first.serviceId, 2)).toThrow("template version unavailable");
    f.assign(randomUUID());
    expect(() => f.bind(first.serviceId)).toThrow("task identity unavailable");
    expect(() => f.catalog.listTask(taskId)).toThrow("task identity unavailable");
    f.assign(projectId);
    expect(f.catalog.listTask(taskId)).toEqual([]);
  });

  it("refuses identity replacement, project reassignment and removed roots on read or overwrite", () => {
    const f = fixture();
    const first = f.save();
    f.bind(first.serviceId);
    f.replaceIdentity({ ...identity, directoryInode: "21" });
    expect(() => f.catalog.listTask(taskId)).toThrow("stored service task identity changed");
    expect(() => f.bind(first.serviceId)).toThrow("stored service task identity changed");
    f.replaceIdentity({ ...identity });
    f.assign(otherProjectId);
    expect(() => f.catalog.listTask(taskId)).toThrow("stored service task identity changed");
    expect(() => f.bind(first.serviceId)).toThrow("stored service task identity changed");
    f.assign(projectId);
    f.setRoots([]);
    expect(() => f.catalog.listTask(taskId)).toThrow("stored service task identity changed");
  });

  it("fails closed on corrupt or missing primaries rather than inventing empty state", () => {
    const f = fixture();
    const first = f.save();
    f.bind(first.serviceId);
    const privateFile = join(f.dir, "service-machine.json");
    writeFileSync(privateFile, "{broken");
    expect(() => f.catalog.listTask(taskId)).toThrow();
    rmSync(privateFile);
    expect(() => f.catalog.listTask(taskId)).toThrow("recovery required");
    if (process.platform === "win32") return;
    const templates = join(f.dir, "service-templates.json");
    rmSync(templates);
    symlinkSync(join(f.dir, "service-templates.json.bak"), templates);
    expect(() => f.catalog.template(projectId, first.serviceId, 1)).toThrow("unreadable");
  });

  it("resolves private references only at use time without persisting values", () => {
    const f = fixture();
    const first = f.save();
    f.bind(first.serviceId);
    const refs = f.catalog.listTask(taskId)[0]!.binding.privateRefs;
    expect(resolvePrivateServiceRefs(refs, { LOCAL_API_TOKEN: "credential-value" })).toEqual([
      { key: "API_TOKEN", value: "credential-value", secret: true },
    ]);
    expect(() => resolvePrivateServiceRefs(refs, {})).toThrow("missing or invalid private reference");
    expect(() => resolvePrivateServiceRefs(refs, { LOCAL_API_TOKEN: "" })).toThrow("missing or invalid private reference");
    expect(() => resolvePrivateServiceRefs(refs, { LOCAL_API_TOKEN: "x".repeat(4097) })).toThrow("missing or invalid private reference");
    expect(readFileSync(join(f.dir, "service-machine.json"), "utf8")).not.toContain("credential-value");
  });

  it.skipIf(process.platform === "win32")("refuses world-readable private metadata", () => {
    const f = fixture();
    const first = f.save();
    f.bind(first.serviceId);
    chmodSync(join(f.dir, "service-machine.json"), 0o644);
    expect(() => f.catalog.listTask(taskId)).toThrow("service catalog unreadable");
  });

  it("uses persisted task/project authority, refusing changed records and project transfers", async () => {
    const home = mkdtempSync(join(tmpdir(), "pidock-catalog-authority-"));
    directories.push(home);
    const root = join(home, "tasks");
    const userData = join(home, "userData");
    const dir = join(root, "task-12345678");
    mkdirSync(join(dir, "repo-a"), { recursive: true });
    const record = { taskId, name: "Real", dirId: "task-12345678", root, taskDir: dir,
      branch: "task/main", remoteBranch: "main", baseCommit: "abc123", repos: ["repo-a"],
      createdAt: identity.createdAt, updatedAt: identity.createdAt };
    writeFileSync(join(dir, "task.json"), JSON.stringify(record));
    const roots = new TaskRootIndex(userData, root);
    const projects = new ProjectRegistry(userData);
    const firstProject = await projects.create({ name: "First", description: "", repositories: [], directories: [] });
    const secondProject = await projects.create({ name: "Second", description: "", repositories: [], directories: [] });
    await projects.claim(taskId, firstProject.id, roots);
    const catalog = new ServiceCatalog(userData, serviceCatalogAuthority(roots, projects));
    const saved = catalog.saveTemplate({ projectId: firstProject.id,
      descriptor: { name: "API", program: "node", args: ["server.js"], ports: [], runType: "long-lived" }, shared: [] });
    catalog.bindTask({ taskId, serviceId: saved.serviceId, templateVersion: 1, rootId: "repo-a", subdir: "", programPath: process.execPath, privateRefs: [] });
    expect(new ServiceCatalog(userData, serviceCatalogAuthority(roots, projects)).listTask(taskId)[0]?.template).toEqual(saved);
    await projects.transfer(taskId, firstProject.id, secondProject.id, roots);
    expect(() => catalog.listTask(taskId)).toThrow("stored service task identity changed");
    await projects.transfer(taskId, secondProject.id, firstProject.id, roots);
    writeFileSync(join(dir, "task.json"), JSON.stringify({ ...record, taskId: "other-task" }));
    expect(() => catalog.listTask(taskId)).toThrow("task identity unavailable");
  });

  it("previews only pinned saved layers, masks private values and reports missing refs without partial rows", () => {
    const f = fixture();
    const saved = f.catalog.saveTemplate({ projectId, descriptor: f.descriptor, shared: [
      { key: "PORT", value: "3000", secret: false }, { key: "PUBLIC", value: "safe", secret: false },
      { key: "COINCIDENTAL", value: "prefix-credential-value", secret: false },
    ] });
    f.catalog.bindTask({ taskId, serviceId: saved.serviceId, templateVersion: 1, rootId: "repo-a", subdir: "", programPath: process.execPath,
      privateRefs: [{ key: "PORT", envRef: "LOCAL_PORT" }, { key: "API_TOKEN", envRef: "LOCAL_TOKEN" }] });
    const env = { LOCAL_PORT: "4200", LOCAL_TOKEN: "credential-value" };
    const preview = f.catalog.previewSavedConfig(projectId, taskId, saved.serviceId, env);
    expect(preview).toMatchObject({ state: "ready", scope: "saved-config", templateVersion: 1 });
    expect(preview.rows.find((row) => row.key === "PORT")).toMatchObject({ source: "本机私有配置", masked: true });
    expect(preview.rows.find((row) => row.key === "PUBLIC")).toMatchObject({ source: "共享模板", value: "safe", masked: false });
    expect(preview.rows.find((row) => row.key === "COINCIDENTAL")?.masked).toBe(true);
    expect(JSON.stringify(preview)).not.toMatch(/credential-value|4200|LOCAL_TOKEN|programPath/);
    expect(f.catalog.previewSavedConfig(projectId, taskId, saved.serviceId, {})).toMatchObject({ state: "blocked", error: "private-reference-unavailable", rows: [] });
    f.catalog.saveTemplate({ projectId, serviceId: saved.serviceId, expectedVersion: 1, descriptor: f.descriptor, shared: [] });
    expect(f.catalog.previewSavedConfig(projectId, taskId, saved.serviceId, env).templateVersion).toBe(1);
    f.replaceIdentity(null);
    expect(() => f.catalog.previewSavedConfig(projectId, taskId, saved.serviceId, env)).toThrow("task identity unavailable");
  });

  it("masks shared literals matching an interpolated private value", () => {
    const f = fixture();
    const saved = f.catalog.saveTemplate({ projectId, descriptor: f.descriptor, shared: [
      { key: "PORT", value: "3000", secret: false }, { key: "COINCIDENTAL", value: "3000credential", secret: false },
    ] });
    f.bind(saved.serviceId);
    const preview = f.catalog.previewSavedConfig(projectId, taskId, saved.serviceId, { LOCAL_API_TOKEN: "${PORT}credential" });
    expect(preview.state).toBe("ready");
    expect(preview.rows.find((row) => row.key === "COINCIDENTAL")?.masked).toBe(true);
    expect(JSON.stringify(preview)).not.toContain("3000credential");
  });

  it("does not pretend unresolved shared references are valid configuration", () => {
    const f = fixture();
    const saved = f.catalog.saveTemplate({ projectId, descriptor: f.descriptor, shared: [{ key: "ADDRESS", value: "${MISSING}", secret: false }] });
    f.bind(saved.serviceId);
    expect(f.catalog.previewSavedConfig(projectId, taskId, saved.serviceId, { LOCAL_API_TOKEN: "secret" })).toMatchObject({
      state: "blocked", error: "environment-resolution-failed", rows: [],
    });
  });

  it("pins identity across native selection and refuses replacement or duplicate commits", () => {
    const f = fixture();
    const saved = f.save();
    const input = { taskId, serviceId: saved.serviceId, templateVersion: 1, rootId: "repo-a", subdir: "", privateRefs: [] };
    const prepared = f.catalog.prepareTaskBinding(projectId, input);
    f.replaceIdentity({ ...identity, directoryInode: "99" });
    expect(() => f.catalog.commitTaskBinding(prepared, process.execPath)).toThrow("identity changed during selection");
    f.replaceIdentity({ ...identity });
    f.assign(otherProjectId);
    expect(() => f.catalog.commitTaskBinding(prepared, process.execPath)).toThrow("identity changed during selection");
    f.assign(projectId);
    expect(f.catalog.commitTaskBinding(prepared, process.execPath).templateVersion).toBe(1);
    expect(() => f.catalog.commitTaskBinding(prepared, process.execPath)).toThrow("already bound");
    expect(() => f.catalog.taskBindings(otherProjectId, taskId)).toThrow("task project changed");
    expect(() => f.catalog.prepareTaskBinding(projectId, input)).toThrow("already bound");
  });

  it("rejects raw private values, provider credential references, and invalid local subdirectories", () => {
    const f = fixture();
    const first = f.save();
    const basic = { taskId, serviceId: first.serviceId, templateVersion: 1, rootId: "repo-a", subdir: "", programPath: process.execPath };
    expect(() => f.catalog.bindTask({ ...basic, privateRefs: [{ key: "API_TOKEN", envRef: "PIDOCK_PROVIDER_KEY" }] })).toThrow("invalid private reference");
    expect(() => f.catalog.bindTask({ ...basic, privateRefs: [{ key: "API_TOKEN", envRef: "pidock_provider_key" }] })).toThrow("invalid private reference");
    expect(() => f.catalog.bindTask({ ...basic, privateRefs: [{ key: "API_TOKEN", envRef: "secret-value!" }] })).toThrow("invalid private reference");
    expect(() => f.catalog.bindTask({ ...basic, subdir: "../other-task", privateRefs: [] })).toThrow("invalid service subdirectory");
    expect(() => f.catalog.bindTask({ ...basic, subdir: "CON", privateRefs: [] })).toThrow("invalid service subdirectory");
    expect(f.catalog.listTask(taskId)).toEqual([]);
  });
});
