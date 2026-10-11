import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { lstatSync, realpathSync } from "node:fs";
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

describe("trusted service owner catalog snapshots", () => {
  it("never treats absent trusted task identity callback as an empty catalog", () => {
    const f = fixture();
    expect(() => f.catalog.ownerSnapshot(taskId, "workspace-a", {})).toThrow("service-owner-catalog-unavailable");
  });
  it("binds ordered argv, canonical program/cwd, task identity and private environment revisions without exposing values", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-owner-catalog-"))); directories.push(home);
    const taskDir = join(home, "task-12345678"); mkdirSync(join(taskDir, "repo-a"), { recursive: true });
    const stat = lstatSync(taskDir, { bigint: true });
    const trusted = { ...identity, root: home, realRoot: home, directoryDevice: stat.dev.toString(), directoryInode: stat.ino.toString() };
    const authority: ServiceCatalogAuthority = {
      projectExists: (id) => id === projectId,
      task: () => ({ identity: trusted, projectId, rootIds: ["repo-a"] }),
      verifiedTask: () => ({ identity: trusted, projectId, rootIds: ["repo-a"] }),
    };
    const catalog = new ServiceCatalog(join(home, "profile"), authority);
    const first = catalog.saveTemplate({ projectId, descriptor: { name: "API", program: "node", args: ["second", "first"], ports: [], runType: "long-lived" }, shared: [] });
    catalog.bindTask({ taskId, serviceId: first.serviceId, templateVersion: 1, rootId: "repo-a", subdir: "", programPath: process.execPath,
      privateRefs: [{ key: "API_TOKEN", envRef: "LOCAL_API_TOKEN" }] });
    const snapshot = catalog.ownerSnapshot(taskId, "workspace-a", { LOCAL_API_TOKEN: "synthetic-private-value" });
    expect(snapshot.entries[0]).toMatchObject({ serviceId: first.serviceId, args: ["second", "first"], cwd: join(taskDir, "repo-a"), templateVersion: 1 });
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-private-value");
    expect(catalog.ownerSnapshot(taskId, "workspace-a", { LOCAL_API_TOKEN: "changed-private-value" }).catalogRevision).not.toBe(snapshot.catalogRevision);
    expect(() => catalog.ownerSnapshot("foreign-task", "workspace-a", {})).toThrow("service-owner-catalog-unavailable");
  });
});

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

  it("reviews a shared-template edit before writing it, then writes one new version without touching pinned bindings", () => {
    const f = fixture();
    const first = f.save();
    f.bind(first.serviceId);
    const next = { ...f.descriptor, workdir: "apps/api", healthCheck: { kind: "http" as const } };
    const review = f.catalog.reviewTemplateUpdate({ projectId, serviceId: first.serviceId, expectedVersion: 1, descriptor: next,
      shared: [{ key: "PORT", value: "4000", secret: false }, { key: "API_URL", value: "http://localhost", secret: false }] });
    expect(review).toMatchObject({ projectId, serviceId: first.serviceId, version: 2, versionLabel: "v2", saved: false, descriptorChanged: true,
      diff: { added: ["API_URL"], changed: [{ key: "PORT", before: "3000", after: "4000" }], removed: [] },
      restartNeeded: [{ taskId, serviceId: first.serviceId, name: "API", from: 1, to: 2 }] });
    // A review never writes and never restarts anything.
    expect(f.catalog.listTemplates(projectId)[0]).toMatchObject({ version: 1, descriptor: f.descriptor });
    expect(f.catalog.listTask(taskId)[0]).toMatchObject({ binding: { templateVersion: 1 }, template: { version: 1 } });
    const written = f.catalog.saveTemplate({ projectId, serviceId: first.serviceId, expectedVersion: 1, descriptor: next,
      shared: [{ key: "PORT", value: "4000", secret: false }, { key: "API_URL", value: "http://localhost", secret: false }] });
    expect(written).toMatchObject({ version: 2, descriptor: { workdir: "apps/api", healthCheck: { kind: "http" } } });
    const restarted = new ServiceCatalog(f.dir, f.authority);
    expect(restarted.listTemplates(projectId)[0]).toMatchObject({ version: 2, shared: [{ key: "PORT", value: "4000" }, { key: "API_URL", value: "http://localhost" }] });
    expect(restarted.listTask(taskId)[0]).toMatchObject({ binding: { templateVersion: 1 }, template: { version: 1 } });
  });

  it("reports no restart-needed item for a save that changes no launch material, and names them for a real change", () => {
    const f = fixture();
    const first = f.save();
    f.bind(first.serviceId);
    // Byte-identical content: the save still mints a revision, but it invalidates
    // nothing, so listing every binding that pins the older number would be a lie.
    const unchanged = f.catalog.reviewTemplateUpdate({ projectId, serviceId: first.serviceId, expectedVersion: 1,
      descriptor: f.descriptor, shared: [{ key: "PORT", value: "3000", secret: false }] });
    expect(unchanged).toMatchObject({ version: 2, saved: false, descriptorChanged: false, contentChanged: false,
      diff: { added: [], changed: [], removed: [] }, restartNeeded: [] });
    // One real field change (here a shared value) must name the pinned binding.
    const changed = f.catalog.reviewTemplateUpdate({ projectId, serviceId: first.serviceId, expectedVersion: 1,
      descriptor: f.descriptor, shared: [{ key: "PORT", value: "4000", secret: false }] });
    expect(changed).toMatchObject({ contentChanged: true, descriptorChanged: false,
      diff: { added: [], changed: [{ key: "PORT", before: "3000", after: "4000" }], removed: [] },
      restartNeeded: [{ taskId, serviceId: first.serviceId, name: "API", from: 1, to: 2 }] });
    // Neither review wrote anything: the pin and the revision store are untouched.
    expect(f.catalog.listTask(taskId)[0]).toMatchObject({ binding: { templateVersion: 1 }, template: { version: 1 } });
    expect(f.catalog.listTemplates(projectId)).toMatchObject([{ version: 1 }]);
  });

  it("refuses a review of a stale or foreign revision and rejects machine paths in the shared workdir", () => {
    const f = fixture();
    const first = f.save();
    expect(() => f.catalog.reviewTemplateUpdate({ projectId, serviceId: first.serviceId, expectedVersion: 2,
      descriptor: f.descriptor, shared: [] })).toThrow("template version conflict");
    expect(() => f.catalog.reviewTemplateUpdate({ projectId, serviceId: "s-524639ce-90ac-4dc5-8a52-c3628386ca36", expectedVersion: 1,
      descriptor: f.descriptor, shared: [] })).toThrow("template version conflict");
    for (const workdir of ["/srv/app", "~/app", "../outside", "apps/api-token", "apps\\api"]) {
      expect(() => f.catalog.reviewTemplateUpdate({ projectId, serviceId: first.serviceId, expectedVersion: 1,
        descriptor: { ...f.descriptor, workdir }, shared: [] })).toThrow("invalid shared working directory");
      expect(() => f.catalog.saveTemplate({ projectId, serviceId: first.serviceId, expectedVersion: 1,
        descriptor: { ...f.descriptor, workdir }, shared: [] })).toThrow("invalid shared working directory");
    }
    expect(() => f.catalog.reviewTemplateUpdate({ projectId, serviceId: first.serviceId, expectedVersion: 1,
      descriptor: { ...f.descriptor, workdir: "apps/../etc" }, shared: [] })).toThrow("invalid shared working directory");
    expect(f.catalog.listTemplates(projectId)[0]).toMatchObject({ version: 1 });
  });

  it("refuses a machine path or credential in the shared health target or a shared value", () => {
    const f = fixture();
    const port = [{ key: "PORT", value: "3000", secret: false }];
    for (const target of ["/Users/name/private/app.sock", "file:///Users/name/private/app.sock",
      "http://127.0.0.1:3000/health?api_key=SECRET", "http://127.0.0.1:3000/health?apikey=SECRET",
      "http://127.0.0.1:3000/health?x-key=SECRET"]) {
      const descriptor = { ...f.descriptor, healthCheck: { kind: "http" as const, target } };
      expect(() => f.catalog.saveTemplate({ projectId, descriptor, shared: port })).toThrow("private health target is not shared");
    }
    for (const value of ["apikey=SECRET", "https://user:pass@example.test"]) {
      expect(() => f.catalog.saveTemplate({ projectId, descriptor: f.descriptor,
        shared: [{ key: "API_URL", value, secret: false }] })).toThrow("invalid shared value");
    }
    // The `update` write and its read-only review run the same parser on both steps.
    const first = f.save();
    const secret = [{ key: "API_TOKEN", value: "credential-value", secret: false }];
    for (const write of [
      () => f.catalog.reviewTemplateUpdate({ projectId, serviceId: first.serviceId, expectedVersion: 1, descriptor: first.descriptor, shared: secret }),
      () => f.catalog.saveTemplate({ projectId, serviceId: first.serviceId, expectedVersion: 1, descriptor: first.descriptor, shared: secret }),
      () => f.catalog.saveTemplate({ projectId, serviceId: first.serviceId, expectedVersion: 1,
        descriptor: { ...first.descriptor, args: ["--prefix=/srv/app"] }, shared: [] }),
    ]) expect(write).toThrow();
    expect(f.catalog.saveTemplate({ projectId, descriptor: { ...f.descriptor, healthCheck: { kind: "http", target: "http://127.0.0.1:3000/health" } },
      shared: [{ key: "API_URL", value: "http://localhost:4100", secret: false }] }).descriptor.healthCheck)
      .toEqual({ kind: "http", target: "http://127.0.0.1:3000/health" });
  });

  it("stores a portable shared workdir trimmed and never a padded one", () => {
    const f = fixture();
    const saved = f.catalog.saveTemplate({ projectId, descriptor: { ...f.descriptor, workdir: " apps/api " }, shared: [] });
    expect(saved.descriptor.workdir).toBe("apps/api");
    expect(new ServiceCatalog(f.dir, f.authority).listTemplates(projectId)[0]?.descriptor.workdir).toBe("apps/api");
  });

  it("re-pins one existing binding to an existing revision without touching the other binding or the append-only revisions", () => {
    const f = fixture();
    const api = f.save();
    const worker = f.catalog.saveTemplate({ projectId,
      descriptor: { ...f.descriptor, name: "Worker", args: ["worker.js"] }, shared: [] });
    f.bind(api.serviceId, 1);
    f.bind(worker.serviceId, 1);
    const second = f.catalog.saveTemplate({ projectId, serviceId: api.serviceId, expectedVersion: 1,
      descriptor: { ...f.descriptor, args: ["server-v2.js"] }, shared: [{ key: "PORT", value: "4000", secret: false }] });
    const revisionsBefore = readFileSync(join(f.dir, "service-templates.json"), "utf8");
    const review = f.catalog.reviewTaskBindingAdoption({ projectId, taskId, serviceId: api.serviceId, templateVersion: 2 });
    expect(review).toEqual({ taskId, serviceId: api.serviceId, from: 1, to: 2, adopted: false,
      restartNeeded: [{ taskId, serviceId: api.serviceId, name: "API", from: 1, to: 2 }] });
    // A review writes nothing: the pin, the machine file and the revision file stay as they were.
    expect(f.catalog.listTask(taskId).find((row) => row.binding.serviceId === api.serviceId)?.binding.templateVersion).toBe(1);
    expect(readFileSync(join(f.dir, "service-templates.json"), "utf8")).toBe(revisionsBefore);
    expect(f.catalog.adoptTaskBinding({ projectId, taskId, serviceId: api.serviceId, templateVersion: second.version }))
      .toEqual({ ...review, adopted: true });
    const rows = new ServiceCatalog(f.dir, f.authority).listTask(taskId);
    expect(rows.find((row) => row.binding.serviceId === api.serviceId)).toMatchObject({
      binding: { templateVersion: 2, rootId: "repo-a", subdir: "src/api", programPath: process.execPath,
        privateRefs: [{ key: "API_TOKEN", envRef: "LOCAL_API_TOKEN" }] },
      template: { version: 2, descriptor: { args: ["server-v2.js"] }, shared: [{ key: "PORT", value: "4000", secret: false }] },
    });
    // The sibling binding of the same task keeps its pin, and the revision store is untouched and still append-only.
    expect(rows.find((row) => row.binding.serviceId === worker.serviceId)).toMatchObject({ binding: { templateVersion: 1 }, template: { version: 1 } });
    expect(readFileSync(join(f.dir, "service-templates.json"), "utf8")).toBe(revisionsBefore);
    expect(f.catalog.template(projectId, api.serviceId, 1)).toEqual(api);
    expect(JSON.parse(readFileSync(join(f.dir, "service-templates.json"), "utf8")).revisions).toHaveLength(3);
  });

  it("covers every binding of the service in the restart-needed consequence and allows re-pinning an older existing revision", () => {
    const dir = mkdtempSync(join(tmpdir(), "pidock-service-adopt-"));
    directories.push(dir);
    const secondTask = "task-catalog-b";
    const owners: Record<string, VerifiedTaskIdentity> = { [taskId]: { ...identity }, [secondTask]: { ...identity, taskId: secondTask } };
    const authority: ServiceCatalogAuthority = {
      projectExists: (id) => id === projectId,
      task: (id) => owners[id] ? { identity: owners[id]!, projectId, rootIds: ["repo-a"] } : null,
    };
    const catalog = new ServiceCatalog(dir, authority);
    const descriptor = { name: "API", program: "node", args: ["server.js"], ports: [3000], runType: "long-lived" as const };
    const api = catalog.saveTemplate({ projectId, descriptor, shared: [] });
    const bindFor = (owner: string) => catalog.bindTask({ taskId: owner, serviceId: api.serviceId, templateVersion: 1, rootId: "repo-a",
      subdir: "", programPath: process.execPath, privateRefs: [] });
    bindFor(taskId);
    bindFor(secondTask);
    catalog.saveTemplate({ projectId, serviceId: api.serviceId, expectedVersion: 1, descriptor: { ...descriptor, args: ["server-v2.js"] }, shared: [] });
    expect(catalog.adoptTaskBinding({ projectId, taskId, serviceId: api.serviceId, templateVersion: 2 })).toEqual({
      taskId, serviceId: api.serviceId, from: 1, to: 2, adopted: true,
      restartNeeded: [{ taskId, serviceId: api.serviceId, name: "API", from: 1, to: 2 },
        { taskId: secondTask, serviceId: api.serviceId, name: "API", from: 1, to: 2 }],
    });
    // Adopting one binding changes no other task's pin and starts, stops or restarts nothing.
    const reopened = new ServiceCatalog(dir, authority);
    expect(reopened.listTask(secondTask)[0]?.binding.templateVersion).toBe(1);
    expect(reopened.listTask(taskId)[0]?.binding.templateVersion).toBe(2);
    // An older revision that still exists can be adopted back; only the same version is refused.
    expect(catalog.adoptTaskBinding({ projectId, taskId, serviceId: api.serviceId, templateVersion: 1 }))
      .toMatchObject({ from: 2, to: 1, adopted: true });
    expect(() => catalog.adoptTaskBinding({ projectId, taskId, serviceId: api.serviceId, templateVersion: 1 })).toThrow("already pinned");
  });

  it("refuses an unknown revision, a foreign project, an unbound service and a stale stored identity without writing", () => {
    const f = fixture();
    const api = f.save();
    const unbound = f.catalog.saveTemplate({ projectId, descriptor: { ...f.descriptor, name: "Worker" }, shared: [] });
    f.bind(api.serviceId);
    const machineBefore = readFileSync(join(f.dir, "service-machine.json"), "utf8");
    for (const adopt of [
      () => f.catalog.reviewTaskBindingAdoption({ projectId, taskId, serviceId: api.serviceId, templateVersion: 2 }),
      () => f.catalog.adoptTaskBinding({ projectId, taskId, serviceId: api.serviceId, templateVersion: 2 }),
      () => f.catalog.reviewTaskBindingAdoption({ projectId, taskId, serviceId: api.serviceId, templateVersion: 1 }),
      () => f.catalog.adoptTaskBinding({ projectId, taskId, serviceId: api.serviceId, templateVersion: 1 }),
      () => f.catalog.adoptTaskBinding({ projectId: otherProjectId, taskId, serviceId: api.serviceId, templateVersion: 1 }),
      () => f.catalog.adoptTaskBinding({ projectId, taskId, serviceId: unbound.serviceId, templateVersion: 1 }),
    ]) expect(adopt).toThrow();
    expect(readFileSync(join(f.dir, "service-machine.json"), "utf8")).toBe(machineBefore);
    // A stored identity that no longer matches the live task is refused instead of re-pinned.
    f.replaceIdentity({ ...identity, directoryInode: "99" });
    expect(() => f.catalog.reviewTaskBindingAdoption({ projectId, taskId, serviceId: api.serviceId, templateVersion: 2 })).toThrow("stored service task identity changed");
    f.replaceIdentity({ ...identity });
    f.setRoots([]);
    expect(() => f.catalog.adoptTaskBinding({ projectId, taskId, serviceId: api.serviceId, templateVersion: 2 })).toThrow("stored service task identity changed");
    expect(readFileSync(join(f.dir, "service-machine.json"), "utf8")).toBe(machineBefore);
  });

  it("never carries a machine path or a secret into a shared revision through an adoption", () => {
    const f = fixture();
    const api = f.save();
    f.catalog.bindTask({ taskId, serviceId: api.serviceId, templateVersion: 1, rootId: "repo-a", subdir: "src/api",
      programPath: process.execPath, privateRefs: [{ key: "API_TOKEN", envRef: "LOCAL_API_TOKEN" }] });
    f.catalog.saveTemplate({ projectId, serviceId: api.serviceId, expectedVersion: 1, descriptor: { ...f.descriptor, args: ["server-v2.js"] }, shared: [] });
    const revisionsBefore = readFileSync(join(f.dir, "service-templates.json"), "utf8");
    f.catalog.adoptTaskBinding({ projectId, taskId, serviceId: api.serviceId, templateVersion: 2 });
    const revisions = readFileSync(join(f.dir, "service-templates.json"), "utf8");
    expect(revisions).toBe(revisionsBefore);
    expect(revisions).not.toContain(process.execPath);
    expect(revisions).not.toContain("LOCAL_API_TOKEN");
    // Only the pinned version moved; the local identity stays in the machine file.
    expect(f.catalog.listTask(taskId)[0]?.binding).toMatchObject({ templateVersion: 2, rootId: "repo-a", subdir: "src/api",
      programPath: process.execPath, privateRefs: [{ key: "API_TOKEN", envRef: "LOCAL_API_TOKEN" }] });
    // A shared revision that carries either is still refused at the source, so an adoption can never smuggle one in.
    expect(() => f.catalog.saveTemplate({ projectId, serviceId: api.serviceId, expectedVersion: 2,
      descriptor: { ...f.descriptor, args: ["--prefix=/Users/name/app"] }, shared: [] })).toThrow("private shared argument");
    expect(() => f.catalog.saveTemplate({ projectId, serviceId: api.serviceId, expectedVersion: 2,
      descriptor: f.descriptor, shared: [{ key: "API_TOKEN", value: "credential-value", secret: false }] })).toThrow("private key");
    expect(readFileSync(join(f.dir, "service-templates.json"), "utf8")).toBe(revisionsBefore);
  });

  it("persists a portable shared workdir and never a local path", () => {
    const f = fixture();
    const saved = f.catalog.saveTemplate({ projectId, descriptor: { ...f.descriptor, workdir: "apps/api" },
      shared: [{ key: "PORT", value: "3000", secret: false }] });
    expect(saved.descriptor.workdir).toBe("apps/api");
    const body = readFileSync(join(f.dir, "service-templates.json"), "utf8");
    expect(body).toContain("apps/api");
    expect(body).not.toContain(process.env["HOME"] ?? "/Users/");
    expect(new ServiceCatalog(f.dir, f.authority).listTemplates(projectId)[0]?.descriptor.workdir).toBe("apps/api");
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
