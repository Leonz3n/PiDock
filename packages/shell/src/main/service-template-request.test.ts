/**
 * The main half of the Host -> main shared-template pair ([PiDock 04] #7 box 6):
 * what main accepts, what it derives, and what it refuses by name.
 *
 * These tests drive `createServiceTemplateHandler` (the exact function
 * `runtime.ts` binds to each forked child) with real envelopes and a real
 * `ServiceCatalog`, and compare the template document BYTES: main is the only
 * writer of that file, so "nothing was written" is asserted on the file.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HostClient } from "../rpc/host-client.js";
import { isServiceTemplateRequest, ServiceTemplateRequestClient, type ServiceTemplateRequest } from "../rpc/service-template-request.js";
import { ServiceCatalog, type ServiceCatalogAuthority } from "./service-catalog.js";
import { createServiceTemplateHandler } from "./service-catalog-ipc.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const TASK_ID = "task-6d1f00a1";
const DESCRIPTOR = { name: "API a", program: "node", args: ["service.cjs"], ports: [], runType: "long-lived" };

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-template-main-")));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const profile = join(home, "profile");
  const root = join(home, "tasks");
  const taskDir = join(root, TASK_ID);
  mkdirSync(join(taskDir, "repo-a"), { recursive: true });
  mkdirSync(profile, { mode: 0o700 });
  const projectId = randomUUID();
  const stat = statSync(taskDir, { bigint: true });
  const owner = { identity: { taskId: TASK_ID, createdAt: "2026-01-01T00:00:00.000Z", root, realRoot: root, dirId: TASK_ID,
    directoryDevice: stat.dev.toString(), directoryInode: stat.ino.toString() }, projectId, rootIds: ["repo-a"] };
  const authority: ServiceCatalogAuthority = { projectExists: (id) => id === projectId, task: (id) => (id === TASK_ID ? owner : null), verifiedTask: (id) => (id === TASK_ID ? owner : null) };
  const catalog = new ServiceCatalog(profile, authority);
  const environmentId = catalog.createEnvironment({ projectId, name: "开发环境" }).environmentId;
  const template = catalog.saveTemplate({ projectId, environmentId, descriptor: DESCRIPTOR, shared: [{ key: "SERVICE_GREETING", value: "hello-a", secret: false }] });
  catalog.bindTask({ taskId: TASK_ID, serviceId: template.serviceId, environmentId, templateVersion: 1, rootId: "repo-a", subdir: "svc-a",
    programPath: realpathSync(process.execPath), privateRefs: [] });
  const documentPath = join(profile, "service-templates.json");
  const handler = createServiceTemplateHandler(catalog, TASK_ID);
  const envelope = (params: Partial<ServiceTemplateRequest["params"]> = {}, edit: Record<string, unknown> = {}): ServiceTemplateRequest => ({
    kind: "service-template-request", id: "template-1",
    params: { workspaceId: "workspace-a", taskId: TASK_ID, op: "review",
      edit: { serviceId: template.serviceId, descriptor: DESCRIPTOR, shared: [{ key: "SERVICE_GREETING", value: "hello-b", secret: false }], ...edit }, ...params },
  });
  return { profile, projectId, environmentId, serviceId: template.serviceId, catalog, handler, envelope, documentPath,
    document: () => readFileSync(documentPath, "utf8"),
    revisions: () => (JSON.parse(readFileSync(documentPath, "utf8")) as { revisions: unknown[] }).revisions,
    versions: () => ({ pinned: catalog.taskBindings(projectId, TASK_ID).find((row) => row.binding.serviceId === template.serviceId)!.binding.templateVersion,
      latest: catalog.listTemplates(projectId, environmentId).find((row) => row.serviceId === template.serviceId)!.version }) };
}

it("derives project, environment and expected version from the task's own binding pin, and writes only on apply", async () => {
  const f = fixture();
  const before = f.document();
  const review = await f.handler(f.envelope().params);
  expect(review.ok).toBe(true);
  if (!review.ok) return;
  // The diff is the REAL row change of the persisted revision, and the version
  // the save would mint - neither is a value the caller supplied.
  expect(review.payload).toMatchObject({ serviceId: f.serviceId, pinnedVersion: 1, version: 2, saved: false });
  expect(review.payload.diff).toEqual({ added: [], changed: [{ key: "SERVICE_GREETING", before: "hello-a", after: "hello-b" }], removed: [] });
  // A review writes nothing at all: the bytes are identical.
  expect(f.document()).toBe(before);

  const applied = await f.handler(f.envelope({ op: "apply" }).params);
  expect(applied).toMatchObject({ ok: true, payload: { saved: true, version: 2, pinnedVersion: 1 } });
  expect(f.document()).not.toBe(before);
  expect(f.revisions().at(-1)).toMatchObject({ serviceId: f.serviceId, environmentId: f.environmentId, version: 2 });
  // The write used the DERIVED project/environment/version: the revision landed
  // in this task's own environment, and this task keeps its pin.
  expect(f.versions()).toEqual({ pinned: 1, latest: 2 });
});

it("refuses a request that names another task, before any store call", async () => {
  const f = fixture();
  const before = f.document();
  const result = await f.handler(f.envelope({ taskId: "task-00000000-other" }).params);
  expect(result.ok).toBe(false);
  expect(result.ok ? "" : result.error).toContain("task-identity-mismatch");
  expect(f.document()).toBe(before);
});

it("refuses a service this task has not bound", async () => {
  const f = fixture();
  const before = f.document();
  const result = await f.handler(f.envelope({}, { serviceId: "s-11111111-1111-4111-8111-111111111111" }).params);
  expect(result.ok).toBe(false);
  expect(result.ok ? "" : result.error).toContain("unknown-service:");
  expect(f.document()).toBe(before);
});

it("fails closed by name when the pinned version is no longer the latest revision", async () => {
  const f = fixture();
  // The page's own edit path moves the revision first, so this task's pin is stale.
  f.catalog.saveTemplate({ projectId: f.projectId, environmentId: f.environmentId, serviceId: f.serviceId, expectedVersion: 1,
    descriptor: DESCRIPTOR, shared: [{ key: "SERVICE_GREETING", value: "hello-human", secret: false }] });
  const before = f.document();
  // Both operations derive the pin afresh, so neither the review nor the write
  // can act on a document this task is no longer pinned to.
  for (const op of ["review", "apply"] as const) {
    const result = await f.handler(f.envelope({ op }).params);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("template-version-conflict:");
  }
  expect(f.document()).toBe(before);
  expect(f.versions()).toEqual({ pinned: 1, latest: 2 });
});

it("refuses a smuggled project/environment/version/task/path in the envelope or the edit", async () => {
  const f = fixture();
  const before = f.document();
  // The guard is key-exact at every level: the caller names the service and the
  // edit content, never where it should land or which version it expects.
  for (const smuggled of [{ projectId: "p-other" }, { environmentId: "e-other" }, { expectedVersion: 3 }, { taskId: "task-other" },
    { path: "/etc/passwd" }, { program: "/bin/sh" }, { subdir: "../../../etc" }]) {
    const request = f.envelope({}, smuggled);
    expect(isServiceTemplateRequest(request)).toBe(false);
    expect(await f.handler(request.params)).toMatchObject({ ok: false, error: "invalid-payload: 共享模板编辑只能有 serviceId、descriptor、shared 与可选 dependencies" });
  }
  expect(f.document()).toBe(before);
  expect(f.versions()).toEqual({ pinned: 1, latest: 1 });
});

it("refuses an edit that is not the bounded shared-template shape", async () => {
  const f = fixture();
  const before = f.document();
  const cases: Record<string, unknown>[] = [
    { shared: ["SERVICE_GREETING=hello-b"] },
    { shared: Array.from({ length: 81 }, (_, index) => ({ key: `K${index}`, value: "v", secret: false })) },
    { dependencies: Array.from({ length: 41 }, (_, index) => ({ to: `s-${index}`, kind: "call" })) },
    { descriptor: "not-an-object" },
    { shared: [{ key: "K", value: "x".repeat(20_000), secret: false }] },
  ];
  for (const edit of cases) {
    const request = f.envelope({}, edit);
    expect(isServiceTemplateRequest(request)).toBe(false);
    expect(await f.handler(request.params)).toMatchObject({ ok: false, error: "invalid-payload: 共享模板编辑只能有 serviceId、descriptor、shared 与可选 dependencies" });
  }
  expect(f.document()).toBe(before);
});

it("refuses a value the store would not accept, naming the store's own reason and writing nothing", async () => {
  const f = fixture();
  const before = f.document();
  // A descriptor the store refuses (a program path is not portable) is the
  // store's named refusal carried back under the payload code; nothing lands.
  const request = f.envelope({ op: "apply" }, { descriptor: { ...DESCRIPTOR, program: "/bin/sh" } });
  expect(isServiceTemplateRequest(request)).toBe(true);
  const result = await f.handler(request.params);
  expect(result.ok).toBe(false);
  expect(result.ok ? "" : result.error).toMatch(/^invalid-payload: /);
  expect(f.document()).toBe(before);
});

it("answers a Host whose main bound no handler with a named failure, not a hang", async () => {
  // The main side of the pair with NO `onServiceTemplateRequest`: the Host's tool
  // call still gets an answer, because a parked promise would read as a hang.
  const hostSide = new EventEmitter() as EventEmitter & { postMessage(value: unknown): void };
  const mainSide = new EventEmitter() as EventEmitter & { postMessage(value: unknown): void };
  hostSide.postMessage = (message) => { mainSide.emit("message", message); };
  mainSide.postMessage = (message) => { hostSide.emit("message", message); };
  new HostClient(mainSide as never);
  const client = new ServiceTemplateRequestClient(hostSide, "workspace-a", TASK_ID, { timeoutMs: 500 });
  const result = await client.review({ serviceId: "s-11111111-1111-4111-8111-111111111111", descriptor: DESCRIPTOR, shared: [] });
  expect(result.ok ? "" : result.error).toContain("template-unavailable:");
});
