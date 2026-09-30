import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceCatalog, serviceCatalogAuthority } from "./service-catalog.js";
import { ProjectRegistry } from "./project-registry.js";
import { TaskRootIndex } from "./task-root-index.js";
import { prepareServiceSupervisorExperiment, type ExperimentalSupervisorArtifact } from "./service-supervisor-preparation.js";
import { launchSupervisorExperiment } from "../host/service-supervisor-experiment.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-service-preparation-"))); dirs.push(home);
  const root = join(home, "tasks"), userData = join(home, "profile"), taskDir = join(root, "task-12345678");
  const cwd = join(taskDir, "repo-a", "app"); mkdirSync(cwd, { recursive: true });
  const taskId = "task-preparation";
  const record = { taskId, name: "Real", dirId: "task-12345678", root, taskDir, branch: "task/main", remoteBranch: "main",
    baseCommit: "abc123", repos: ["repo-a"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  writeFileSync(join(taskDir, "task.json"), JSON.stringify(record));
  const roots = new TaskRootIndex(userData, root), projects = new ProjectRegistry(userData);
  const project = await projects.create({ name: "First", description: "", repositories: [], directories: [] });
  await projects.claim(taskId, project.id, roots);
  const catalog = new ServiceCatalog(userData, serviceCatalogAuthority(roots, projects));
  const program = join(home, "service-program");
  writeFileSync(program, `#!${process.execPath}\nconsole.log(process.env.API_TOKEN);console.log(process.env.PORT);console.log(process.cwd());`);
  chmodSync(program, 0o700);
  const descriptor = { name: "API", program: "node", args: [], ports: [], runType: "one-shot" as const };
  const template = catalog.saveTemplate({ projectId: project.id, descriptor, shared: [{ key: "PORT", value: "3100", secret: false }] });
  catalog.bindTask({ taskId, serviceId: template.serviceId, templateVersion: 1, rootId: "repo-a", subdir: "app", programPath: program,
    privateRefs: [{ key: "API_TOKEN", envRef: "LOCAL_SECRET" }] });
  const binary = join(home, "supervisor"); writeFileSync(binary, "experimental-placeholder"); chmodSync(binary, 0o700);
  const artifact = (): ExperimentalSupervisorArtifact => ({ path: binary, sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"), platform: "darwin", arch: process.arch });
  const ids = { projectId: project.id, taskId, serviceId: template.serviceId };
  return { home, userData, taskDir, cwd, catalog, projects, roots, program, binary, artifact, ids, descriptor };
}

it("refuses unavailable artifact before reading task or private references", () => {
  const catalog = { taskBindings: vi.fn() };
  expect(() => prepareServiceSupervisorExperiment(catalog, { projectId: "unknown", taskId: "unknown", serviceId: "unknown" }, {})).toThrow("supervisor-artifact-unavailable");
  expect(catalog.taskBindings).not.toHaveBeenCalled();
});

describe.skipIf(process.platform !== "darwin")("trusted experimental launch preparation", () => {
  it("uses persisted pinned configuration, keeps values private and is one-shot", async () => {
    const f = await fixture(); const env = { LOCAL_SECRET: "private-preparation-value", UNRELATED: "not-inherited" };
    const prepared = prepareServiceSupervisorExperiment(f.catalog, f.ids, env, f.artifact());
    expect(JSON.stringify(prepared)).not.toMatch(/private-preparation-value|supervisor|service-program|LOCAL_SECRET/);
    f.catalog.saveTemplate({ projectId: f.ids.projectId, serviceId: f.ids.serviceId, expectedVersion: 1, descriptor: f.descriptor,
      shared: [{ key: "PORT", value: "9900", secret: false }] });
    env.LOCAL_SECRET = "changed-after-preparation";
    prepared.use((binary, request, redact) => {
      expect(binary).toBe(f.binary);
      expect(request).toMatchObject({ taskRoot: f.taskDir, cwd: f.cwd, program: f.program, args: [], env: { PORT: "3100", API_TOKEN: "private-preparation-value" } });
      expect(request.env["UNRELATED"]).toBeUndefined();
      expect(redact("private-preparation-value")).toBe("[redacted]");
    });
    expect(() => prepared.use(() => {})).toThrow("consumed");
    expect(readFileSync(join(f.userData, "service-machine.json"), "utf8")).not.toContain("private-preparation-value");
  });
  it("redacts both raw and interpolated references and refuses overlarge resolved values", async () => {
    const f = await fixture();
    const prepared = prepareServiceSupervisorExperiment(f.catalog, f.ids, { LOCAL_SECRET: "${PORT}private" }, f.artifact());
    prepared.use((_, request, redact) => {
      expect(request.env["API_TOKEN"]).toBe("3100private");
      expect(redact("${PORT}private / 3100private")).toBe("[redacted] / [redacted]");
    });
    f.catalog.saveTemplate({ projectId: f.ids.projectId, serviceId: f.ids.serviceId, expectedVersion: 1, descriptor: f.descriptor,
      shared: [{ key: "X", value: "x".repeat(2048), secret: false }] });
    f.catalog.bindTask({ taskId: f.ids.taskId, serviceId: f.ids.serviceId, templateVersion: 2, rootId: "repo-a", subdir: "app",
      programPath: f.program, privateRefs: [{ key: "API_TOKEN", envRef: "LOCAL_SECRET" }] });
    expect(() => prepareServiceSupervisorExperiment(f.catalog, f.ids, { LOCAL_SECRET: "${X}${X}${X}" }, f.artifact())).toThrow("environment-unavailable");
  });
  it("refuses wrong artifact, missing references and linked worktrees", async () => {
    const f = await fixture();
    expect(() => prepareServiceSupervisorExperiment(f.catalog, f.ids, {}, { ...f.artifact(), sha256: "0".repeat(64) })).toThrow("artifact-unavailable");
    expect(() => prepareServiceSupervisorExperiment(f.catalog, f.ids, {}, { ...f.artifact(), arch: "unsupported-architecture" })).toThrow("artifact-unavailable");
    const linked = join(f.home, "linked-supervisor"); symlinkSync(f.binary, linked);
    expect(() => prepareServiceSupervisorExperiment(f.catalog, f.ids, {}, { ...f.artifact(), path: linked })).toThrow("artifact-unavailable");
    const fifo = join(f.home, "artifact-fifo"); execFileSync("/usr/bin/mkfifo", [fifo]);
    expect(() => prepareServiceSupervisorExperiment(f.catalog, f.ids, {}, { ...f.artifact(), path: fifo })).toThrow("artifact-unavailable");
    expect(() => prepareServiceSupervisorExperiment(f.catalog, f.ids, {}, f.artifact())).toThrow("private reference");
    const repo = join(f.taskDir, "repo-a"); renameSync(repo, repo+"-old"); symlinkSync(repo+"-old", repo);
    expect(() => prepareServiceSupervisorExperiment(f.catalog, f.ids, { LOCAL_SECRET: "private" }, f.artifact())).toThrow("directory-unavailable");
  });
  it("rechecks artifact, program and cwd before consuming a request", async () => {
    for (const target of ["binary", "program", "cwd"] as const) {
      const f = await fixture(); const manifest = f.artifact();
      const prepared = prepareServiceSupervisorExperiment(f.catalog, f.ids, { LOCAL_SECRET: "private" }, manifest);
      const path = f[target]; renameSync(path, path+"-old");
      if (target === "cwd") mkdirSync(path);
      else { writeFileSync(path, "changed"); chmodSync(path, 0o700); }
      manifest.sha256 = createHash("sha256").update(readFileSync(f.binary)).digest("hex");
      const callback = vi.fn();
      expect(() => prepared.use(callback)).toThrow(); expect(callback).not.toHaveBeenCalled();
    }
  });
  it("rejects project transfers before supplying any launch request", async () => {
    const f = await fixture();
    const prepared = prepareServiceSupervisorExperiment(f.catalog, f.ids, { LOCAL_SECRET: "private" }, f.artifact());
    const other = await f.projects.create({ name: "Second", description: "", repositories: [], directories: [] });
    await f.projects.transfer(f.ids.taskId, f.ids.projectId, other.id, f.roots);
    const callback = vi.fn(); expect(() => prepared.use(callback)).toThrow("project changed"); expect(callback).not.toHaveBeenCalled();
  });
  it("sends captured identities and isolated config to a real supervisor", async () => {
    const f = await fixture();
    rmSync(f.binary);
    execFileSync("go", ["build", "-o", f.binary, "."], { cwd: resolve("native/service-supervisor"), timeout: 30000 });
    const prepared = prepareServiceSupervisorExperiment(f.catalog, f.ids, { LOCAL_SECRET: "private-preparation-value" }, f.artifact());
    const lines: string[] = [];
    const session = await prepared.use((binary, request, redact) => launchSupervisorExperiment(binary, request,
      { redact, onLine: (line) => lines.push(line) }));
    expect(await session.completion).toEqual({ event: "exit", code: 0 });
    expect(lines).toEqual(["[redacted]", "3100", f.cwd]);
    const stale = prepareServiceSupervisorExperiment(f.catalog, f.ids, { LOCAL_SECRET: "private-preparation-value" }, f.artifact());
    await expect(stale.use((binary, request, redact) => {
      // Replace after the main freshness check: the native identity comparison
      // must still refuse launch, without relying on a last path-only check.
      renameSync(f.cwd, f.cwd+"-old"); mkdirSync(f.cwd);
      return launchSupervisorExperiment(binary, request, { redact, onLine: () => {} });
    })).rejects.toThrow("supervisor-launch-unconfirmed");
  }, 30000);
});
