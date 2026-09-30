import { describe, expect, it, vi } from "vitest";
import { performServiceBindingOperation, performServiceCatalogOperation } from "./service-catalog-ipc.js";
import type { ServiceCatalog, ServiceTemplate } from "./service-catalog.js";

const template: ServiceTemplate = {
  projectId: "b36323d3-ff33-4e34-a873-536a9775788a",
  serviceId: "s-b36323d3-ff33-4e34-a873-536a9775788a",
  version: 1,
  descriptor: { name: "API", program: "node", args: ["server.js"], ports: [3000], runType: "long-lived" },
  shared: [{ key: "PORT", value: "3000", secret: false }],
};
function store() {
  return { listTemplates: vi.fn(() => [template]), saveTemplate: vi.fn(() => template) } satisfies Pick<ServiceCatalog, "listTemplates" | "saveTemplate">;
}

describe("shell service catalog request boundary", () => {
  it("lists project templates and creates only a fresh manually submitted template", () => {
    const catalog = store();
    const publicRow = { projectId: template.projectId, serviceId: template.serviceId, version: template.version,
    descriptor: template.descriptor, sharedKeys: ["PORT"] };
  expect(performServiceCatalogOperation(catalog, { op: "list", projectId: template.projectId })).toEqual([publicRow]);
    expect(catalog.listTemplates).toHaveBeenCalledWith(template.projectId);
    const input = { op: "create", projectId: template.projectId, descriptor: template.descriptor, shared: template.shared };
    expect(performServiceCatalogOperation(catalog, input)).toEqual(publicRow);
    expect(catalog.saveTemplate).toHaveBeenCalledWith({ projectId: template.projectId, descriptor: template.descriptor, shared: template.shared });
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
