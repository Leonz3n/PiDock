import type { ServiceCatalog, ServiceTemplate } from "./service-catalog.js";
import { TrustDomainViolation } from "./trust-domain.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function shape(value: unknown, names: string[]): Record<string, unknown> {
  if (!record(value) || Object.keys(value).sort().join(",") !== names.sort().join(",")) {
    throw new TrustDomainViolation("invalid-payload", "invalid service catalog request");
  }
  return value;
}

export interface ServiceTemplateProjection {
  projectId: string;
  serviceId: string;
  version: number;
  descriptor: ServiceTemplate["descriptor"];
  sharedKeys: string[];
}
function projection(row: ServiceTemplate): ServiceTemplateProjection {
  return { projectId: row.projectId, serviceId: row.serviceId, version: row.version,
    descriptor: row.descriptor, sharedKeys: row.shared.map((entry) => entry.key) };
}

/** A shell-only, project-scoped human editing surface. No task binding or execution ops. */
export function performServiceCatalogOperation(
  store: Pick<ServiceCatalog, "listTemplates" | "saveTemplate">, request: unknown,
): ServiceTemplateProjection[] | ServiceTemplateProjection {
  if (!record(request) || typeof request["op"] !== "string") {
    throw new TrustDomainViolation("invalid-payload", "invalid service catalog request");
  }
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body) > 16_384) throw new TrustDomainViolation("invalid-payload", "service catalog request too large");
  if (request["op"] === "list") {
    const input = shape(request, ["op", "projectId"]);
    if (typeof input["projectId"] !== "string") throw new TrustDomainViolation("invalid-payload", "invalid project ID");
    return store.listTemplates(input["projectId"]).map(projection);
  }
  if (request["op"] === "create") {
    const input = shape(request, ["op", "projectId", "descriptor", "shared"]);
    if (typeof input["projectId"] !== "string" || !record(input["descriptor"]) || !Array.isArray(input["shared"])) {
      throw new TrustDomainViolation("invalid-payload", "invalid service template");
    }
    return projection(store.saveTemplate({ projectId: input["projectId"], descriptor: input["descriptor"] as unknown as ServiceTemplate["descriptor"],
      shared: input["shared"] }));
  }
  throw new TrustDomainViolation("invalid-payload", "unknown service catalog operation");
}
