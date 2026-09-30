import { describe, expect, it, vi } from "vitest";
import { performServiceCatalogOperation } from "./service-catalog-ipc.js";
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
