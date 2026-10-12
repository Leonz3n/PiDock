import { describe, expect, it, vi } from "vitest";
import { parseServiceOwnerRebindRequest, parseServiceRunGroupRequest, parseServiceRunRequest, performServiceBindingOperation, performServiceCatalogOperation, performServiceConfigPreview } from "./service-catalog-ipc.js";
import type { ServiceBindingAdoption, ServiceCatalog, ServiceTemplate, ServiceTemplateUpdateReview } from "./service-catalog.js";

const template: ServiceTemplate = {
  projectId: "b36323d3-ff33-4e34-a873-536a9775788a",
  serviceId: "s-b36323d3-ff33-4e34-a873-536a9775788a",
  version: 1,
  descriptor: { name: "API", program: "node", args: ["server.js"], ports: [3000], runType: "long-lived" },
  shared: [{ key: "PORT", value: "3000", secret: false }],
};
function store(saved: ServiceTemplate = template) {
  const review: ServiceTemplateUpdateReview = { projectId: saved.projectId, serviceId: saved.serviceId, version: saved.version,
    versionLabel: `v${String(saved.version)}`, saved: false, descriptorChanged: true, contentChanged: true,
    diff: { added: [], changed: [], removed: [] }, restartNeeded: [] };
  const adoption: ServiceBindingAdoption = { taskId: "task-1", serviceId: saved.serviceId, from: 1, to: 2, adopted: false,
    restartNeeded: [{ taskId: "task-1", serviceId: saved.serviceId, name: "API", from: 1, to: 2 }] };
  return { listTemplates: vi.fn(() => [template]), saveTemplate: vi.fn(() => saved),
    reviewTemplateUpdate: vi.fn(() => review), review,
    reviewTaskBindingAdoption: vi.fn(() => adoption), adoptTaskBinding: vi.fn(() => ({ ...adoption, adopted: true })), adoption } satisfies
    Pick<ServiceCatalog, "listTemplates" | "saveTemplate" | "reviewTemplateUpdate" | "reviewTaskBindingAdoption" | "adoptTaskBinding">;
}

describe("shell service catalog request boundary", () => {
  it("lists project templates and creates only a fresh manually submitted template", () => {
    const catalog = store();
    const publicRow = { projectId: template.projectId, serviceId: template.serviceId, version: template.version,
    descriptor: template.descriptor, shared: [{ key: "PORT", value: "3000" }] };
  expect(performServiceCatalogOperation(catalog, { op: "list", projectId: template.projectId })).toEqual([publicRow]);
    expect(catalog.listTemplates).toHaveBeenCalledWith(template.projectId);
    const input = { op: "create", projectId: template.projectId, descriptor: template.descriptor, shared: template.shared };
    expect(performServiceCatalogOperation(catalog, input)).toEqual(publicRow);
    expect(catalog.saveTemplate).toHaveBeenCalledWith({ projectId: template.projectId, descriptor: template.descriptor, shared: template.shared });
  });

  it("reviews one existing template edit without writing and confirms it into exactly one new version", () => {
    const catalog = store({ ...template, version: 2 });
    const edit = { projectId: template.projectId, serviceId: template.serviceId, expectedVersion: 1,
      descriptor: { ...template.descriptor, workdir: "apps/api" }, shared: [{ key: "PORT", value: "4000", secret: false }] };
    expect(performServiceCatalogOperation(catalog, { op: "update", ...edit, confirm: false })).toEqual(catalog.review);
    expect(catalog.reviewTemplateUpdate).toHaveBeenCalledWith({ projectId: template.projectId, serviceId: template.serviceId,
      expectedVersion: 1, descriptor: edit.descriptor, shared: edit.shared });
    expect(catalog.saveTemplate).not.toHaveBeenCalled();
    expect(performServiceCatalogOperation(catalog, { op: "update", ...edit, confirm: true }))
      .toEqual({ ...catalog.review, saved: true });
    expect(catalog.saveTemplate).toHaveBeenCalledWith({ projectId: template.projectId, serviceId: template.serviceId,
      expectedVersion: 1, descriptor: edit.descriptor, shared: edit.shared });
  });

  it("keeps the update request key-exact and fails closed when the write is not the reviewed revision", () => {
    const catalog = store({ ...template, version: 2 });
    const edit = { op: "update", projectId: template.projectId, serviceId: template.serviceId, expectedVersion: 1,
      descriptor: template.descriptor, shared: template.shared, confirm: true };
    for (const request of [
      { ...edit, programPath: "/tmp/executable" },
      { ...edit, commit: true },
      { ...edit, confirm: undefined },
      { ...edit, confirm: "yes" },
      { ...edit, expectedVersion: 0 },
      { ...edit, expectedVersion: 1.5 },
      { ...edit, shared: { PORT: "3000" } },
    ]) expect(() => performServiceCatalogOperation(catalog, request)).toThrow();
    expect(catalog.reviewTemplateUpdate).not.toHaveBeenCalled();
    expect(catalog.saveTemplate).not.toHaveBeenCalled();
    // A store that reports a different version than the review must not be read as a confirmed save.
    const drifted = store({ ...template, version: 2 });
    drifted.saveTemplate.mockReturnValue({ ...template, serviceId: "s-524639ce-90ac-4dc5-8a52-c3628386ca36", version: 9 });
    expect(() => performServiceCatalogOperation(drifted, edit)).toThrow();
    expect(drifted.reviewTemplateUpdate).toHaveBeenCalledOnce();
  });

  it("reviews one binding adoption without writing and confirms it into exactly one re-pin", () => {
    const catalog = store();
    const adoption = { projectId: template.projectId, taskId: "task-1", serviceId: template.serviceId, templateVersion: 2 };
    expect(performServiceCatalogOperation(catalog, { op: "adoptBinding", ...adoption, confirm: false })).toEqual(catalog.adoption);
    expect(catalog.reviewTaskBindingAdoption).toHaveBeenCalledWith(adoption);
    expect(catalog.adoptTaskBinding).not.toHaveBeenCalled();
    expect(performServiceCatalogOperation(catalog, { op: "adoptBinding", ...adoption, confirm: true }))
      .toEqual({ ...catalog.adoption, adopted: true });
    expect(catalog.adoptTaskBinding).toHaveBeenCalledWith(adoption);
  });

  it("keeps the adoption request key-exact and fails closed when the write is not the reviewed re-pin", () => {
    const catalog = store();
    const request = { op: "adoptBinding", projectId: template.projectId, taskId: "task-1", serviceId: template.serviceId,
      templateVersion: 2, confirm: true };
    for (const invalid of [
      { ...request, rootId: "repo-a" },
      { ...request, subdir: "src/api" },
      { ...request, programPath: "/tmp/executable" },
      { ...request, privateRefs: [{ key: "API_TOKEN", envRef: "LOCAL_API_TOKEN" }] },
      { ...request, shared: [] },
      { ...request, descriptor: template.descriptor },
      { ...request, to: 3 },
      { ...request, confirm: "yes" },
      { ...request, confirm: undefined },
      { ...request, templateVersion: 0 },
      { ...request, templateVersion: 1.5 },
      { ...request, taskId: 7 },
      { ...request, op: "adopt" },
    ]) expect(() => performServiceCatalogOperation(catalog, invalid)).toThrow();
    expect(catalog.reviewTaskBindingAdoption).not.toHaveBeenCalled();
    expect(catalog.adoptTaskBinding).not.toHaveBeenCalled();
    // A store that reports a different re-pin than the review must not be read as an adopted binding.
    const drifted = store();
    drifted.adoptTaskBinding.mockReturnValue({ ...drifted.adoption, adopted: true, to: 9 });
    expect(() => performServiceCatalogOperation(drifted, request)).toThrow();
    expect(drifted.reviewTaskBindingAdoption).toHaveBeenCalledOnce();
  });

  it("rejects an oversized adoption request before reviewing or writing", () => {
    const catalog = store();
    const request = { op: "adoptBinding", projectId: template.projectId, taskId: "task-1", serviceId: template.serviceId,
      templateVersion: 2, confirm: true };
    expect(() => performServiceCatalogOperation(catalog, { ...request, taskId: "t".repeat(20_000) })).toThrow();
    expect(catalog.reviewTaskBindingAdoption).not.toHaveBeenCalled();
    expect(catalog.adoptTaskBinding).not.toHaveBeenCalled();
  });

  it("accepts only preview identities, never page-supplied environment values", () => {
    const catalog = { previewSavedConfig: vi.fn(() => ({ taskId: "task-1", serviceId: template.serviceId, templateVersion: 1,
      scope: "saved-config" as const, state: "ready" as const, rows: [] })) };
    const request = { op: "previewConfig", projectId: template.projectId, taskId: "task-1", serviceId: template.serviceId };
    const env = { LOCAL: "trusted-value" };
    expect(performServiceConfigPreview(catalog, request, env).state).toBe("ready");
    expect(catalog.previewSavedConfig).toHaveBeenCalledWith(template.projectId, "task-1", template.serviceId, env);
    catalog.previewSavedConfig.mockClear();
    expect(() => performServiceConfigPreview(catalog, { ...request, env: { LOCAL: "page-value" } }, env)).toThrow();
    expect(catalog.previewSavedConfig).not.toHaveBeenCalled();
  });

  it("requires the native picker and live sender, projects only private keys", async () => {
    const bound = { taskId: "task-1", projectId: template.projectId, serviceId: template.serviceId, templateVersion: 1,
      rootId: "repo", subdir: "", programPath: "/private/program", privateRefs: [{ key: "API_TOKEN", envRef: "PRIVATE_REF" }],
      identity: { taskId: "task-1", createdAt: "now", root: "/private/root", realRoot: "/private/root", dirId: "task-12345678", directoryDevice: "1", directoryInode: "2" } };
    const catalog = { prepareTaskBinding: vi.fn(() => bound), commitTaskBinding: vi.fn(() => bound),
      taskBindings: vi.fn(() => [{ binding: bound, template }]) };
    const request = { op: "bind", projectId: template.projectId, taskId: "task-1", serviceId: template.serviceId,
      templateVersion: 1, rootId: "repo", subdir: "", privateRefs: bound.privateRefs };
    const pick = vi.fn(async () => "/native/program");
    const requireLive = vi.fn();
    const result = await performServiceBindingOperation(catalog, request, pick, requireLive);
    expect(pick).toHaveBeenCalledOnce();
    expect(requireLive).toHaveBeenCalledTimes(2);
    expect(catalog.commitTaskBinding).toHaveBeenCalledWith(bound, "/native/program");
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_REF|private\/program|private\/root|identity/);
    expect(result).toMatchObject({ cancelled: false, binding: { privateKeys: ["API_TOKEN"] } });
    catalog.commitTaskBinding.mockClear();
    expect(await performServiceBindingOperation(catalog, request, async () => null, requireLive)).toEqual({ cancelled: true });
    expect(catalog.commitTaskBinding).not.toHaveBeenCalled();
    await expect(performServiceBindingOperation(catalog, { ...request, programPath: "/page/path" }, pick, requireLive)).rejects.toThrow();
    const revoked = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw Error("navigated"); });
    await expect(performServiceBindingOperation(catalog, request, pick, revoked)).rejects.toThrow("navigated");
    expect(catalog.commitTaskBinding).not.toHaveBeenCalled();
  });

  it("rejects extra fields, task binding attempts, and oversized requests before touching disk", () => {
    const catalog = store();
    for (const request of [
      { op: "create", projectId: template.projectId, descriptor: template.descriptor, shared: [], privateRefs: [{ key: "API_TOKEN", value: "private-value" }] },
      { op: "create", projectId: template.projectId, descriptor: template.descriptor, shared: [], programPath: "/tmp/executable" },
      { op: "bindTask", taskId: "task-1", serviceId: template.serviceId },
      { op: "create", projectId: template.projectId, descriptor: { ...template.descriptor, args: ["x".repeat(20_000)] }, shared: [] },
      { op: "list", projectId: template.projectId, taskId: "other-task" },
    ]) expect(() => performServiceCatalogOperation(catalog, request)).toThrow();
    expect(catalog.listTemplates).not.toHaveBeenCalled();
    expect(catalog.saveTemplate).not.toHaveBeenCalled();
  });
});

// [PiDock 04] (#7 slice) the way back from a fenced task: identity plus a
// confirmation flag only. No program, cwd, value, session or label may ride it.
describe("shell service owner rebind request boundary", () => {
  const valid = { op: "rebindServiceOwner", projectId: template.projectId, taskId: "task-1", confirm: false };
  it("accepts exactly the project, the task and a boolean confirmation", () => {
    expect(parseServiceOwnerRebindRequest(valid)).toEqual({ projectId: template.projectId, taskId: "task-1", confirm: false });
    expect(parseServiceOwnerRebindRequest({ ...valid, confirm: true }).confirm).toBe(true);
  });
  it("rejects extra keys, another op and non-boolean confirmations before any main call", () => {
    for (const invalid of [
      { ...valid, programPath: "/tmp/executable" },
      { ...valid, rootId: "repo-a" },
      { ...valid, subdir: "src/api" },
      { ...valid, privateRefs: [{ key: "API_TOKEN", envRef: "LOCAL_API_TOKEN" }] },
      { ...valid, serviceId: template.serviceId },
      { ...valid, sessionId: "main" },
      { ...valid, label: "用户点击" },
      { ...valid, op: "adoptBinding" },
      { ...valid, confirm: "yes" },
      { ...valid, confirm: undefined },
      { ...valid, taskId: 7 },
      { ...valid, taskId: "" },
    ]) expect(() => parseServiceOwnerRebindRequest(invalid)).toThrow();
    expect(() => parseServiceOwnerRebindRequest(undefined)).toThrow();
    expect(() => parseServiceOwnerRebindRequest([valid])).toThrow();
    expect(() => parseServiceOwnerRebindRequest({ ...valid, taskId: "t".repeat(4096) })).toThrow();
  });
});

// [PiDock 04] (#7) main's only execution entry: it names the identity only, so
// the request may not carry a program, cwd, value or any other key.
describe("shell service run request boundary", () => {
  const valid = { op: "runTaskService", taskId: "task-1", projectId: template.projectId, serviceId: template.serviceId, action: "start" };
  it("accepts exactly one identity plus an action", () => {
    expect(parseServiceRunRequest(valid)).toEqual({ taskId: "task-1", projectId: template.projectId, serviceId: template.serviceId, action: "start" });
    expect(parseServiceRunRequest({ ...valid, action: "stop" }).action).toBe("stop");
  });
  it("rejects extra keys, a foreign op and any non-start/stop action", () => {
    expect(() => parseServiceRunRequest({ ...valid, program: "/bin/sh" })).toThrow();
    expect(() => parseServiceRunRequest({ ...valid, env: { TOKEN: "page-value" } })).toThrow();
    expect(() => parseServiceRunRequest({ ...valid, op: "previewConfig" })).toThrow();
    expect(() => parseServiceRunRequest({ ...valid, action: "restart" })).toThrow();
    expect(() => parseServiceRunRequest({ ...valid, action: undefined })).toThrow();
    expect(() => parseServiceRunRequest({ ...valid, taskId: 7 })).toThrow();
    expect(() => parseServiceRunRequest([valid])).toThrow();
    expect(() => parseServiceRunRequest(undefined)).toThrow();
  });
  it("rejects an oversized request before any caller sees it", () => {
    expect(() => parseServiceRunRequest({ ...valid, taskId: "t".repeat(4096) })).toThrow();
  });
});

// [PiDock 05] (#10 box 4) 整组启动: main owns the group's membership, so the
// renderer may name the project and the task only - never a unit, a port or a
// plan. A payload carrying plan content is a NAMED refusal, not something the
// boundary quietly ignores.
describe("shell service group run request boundary", () => {
  const valid = { op: "runTaskServiceGroup", taskId: "task-1", projectId: template.projectId };
  it("accepts exactly the task identity and nothing else", () => {
    expect(parseServiceRunGroupRequest(valid)).toEqual({ taskId: "task-1", projectId: template.projectId });
    expect(Object.keys(parseServiceRunGroupRequest(valid)).sort()).toEqual(["projectId", "taskId"]);
  });
  it("refuses renderer-supplied plan content by name", () => {
    const unit = { unitId: "repo-a:svc", serviceId: template.serviceId, name: "svc", location: "local" };
    for (const extra of [
      { units: [unit] },
      { plan: { units: [unit] } },
      { dependencies: [{ from: "a", to: "b", kind: "call" }] },
      { requests: [{ unitId: "a", port: 4100 }] },
      { runTypes: { a: "long-lived" } },
      { rules: [{ key: "API_URL", unitId: "a", kind: "url" }] },
      { layers: { repoDefaults: [], shared: [], privateEntries: [], task: [] } },
      { reservations: [{ port: 4100, owner: "external" }] },
      { selectedRepoDirs: ["repo-a"] },
      { serviceId: template.serviceId },
      { action: "start" },
      { sessionId: "main" },
      { approvalId: "approval-1" },
      { program: "/bin/sh" },
      { cwd: "/tmp" },
      { group: true },
    ]) {
      expect(() => parseServiceRunGroupRequest({ ...valid, ...extra })).toThrow(/只接受 op\/projectId\/taskId/);
    }
  });
  it("rejects a foreign op, a non-string identity, an array and an oversized request", () => {
    expect(() => parseServiceRunGroupRequest({ ...valid, op: "runTaskService" })).toThrow();
    expect(() => parseServiceRunGroupRequest({ ...valid, taskId: 7 })).toThrow();
    expect(() => parseServiceRunGroupRequest({ ...valid, taskId: "" })).toThrow();
    expect(() => parseServiceRunGroupRequest({ ...valid, projectId: undefined })).toThrow();
    expect(() => parseServiceRunGroupRequest([valid])).toThrow();
    expect(() => parseServiceRunGroupRequest(undefined)).toThrow();
    expect(() => parseServiceRunGroupRequest({ ...valid, taskId: "t".repeat(4096) })).toThrow();
  });
});
