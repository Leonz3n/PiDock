import type { ServiceCatalog, ServiceTaskBinding, ServiceTemplate } from "./service-catalog.js";
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

export interface ServiceBindingProjection {
  taskId: string;
  serviceId: string;
  templateVersion: number;
  rootId: string;
  subdir: string;
  privateKeys: string[];
}
function bindingProjection(row: ServiceTaskBinding): ServiceBindingProjection {
  return { taskId: row.taskId, serviceId: row.serviceId, templateVersion: row.templateVersion,
    rootId: row.rootId, subdir: row.subdir, privateKeys: row.privateRefs.map((ref) => ref.key) };
}

/** Picker-based binding is separate from synchronous template operations. */
export async function performServiceBindingOperation(
  store: Pick<ServiceCatalog, "taskBindings" | "prepareTaskBinding" | "commitTaskBinding">,
  request: unknown, pickProgram: () => Promise<string | null>, requireLiveSender: () => void,
): Promise<ServiceBindingProjection[] | { cancelled: boolean; binding?: ServiceBindingProjection }> {
  if (!record(request) || Buffer.byteLength(JSON.stringify(request)) > 16_384) {
    throw new TrustDomainViolation("invalid-payload", "invalid service binding request");
  }
  requireLiveSender();
  if (request["op"] === "taskBindings") {
    const input = shape(request, ["op", "projectId", "taskId"]);
    if (typeof input["projectId"] !== "string" || typeof input["taskId"] !== "string") throw new Error("invalid binding identity");
    return store.taskBindings(input["projectId"], input["taskId"]).map((row) => bindingProjection(row.binding));
  }
  const input = shape(request, ["op", "projectId", "taskId", "serviceId", "templateVersion", "rootId", "subdir", "privateRefs"]);
  if (input["op"] !== "bind" || typeof input["projectId"] !== "string" || typeof input["taskId"] !== "string" ||
      typeof input["serviceId"] !== "string" || typeof input["rootId"] !== "string" || typeof input["subdir"] !== "string" ||
      !Number.isSafeInteger(input["templateVersion"]) || !Array.isArray(input["privateRefs"])) throw new Error("invalid binding request");
  const prepared = store.prepareTaskBinding(input["projectId"], {
    taskId: input["taskId"], serviceId: input["serviceId"], templateVersion: input["templateVersion"] as number,
    rootId: input["rootId"], subdir: input["subdir"], privateRefs: input["privateRefs"],
  });
  const selected = await pickProgram();
  requireLiveSender();
  if (selected === null) return { cancelled: true };
  return { cancelled: false, binding: bindingProjection(store.commitTaskBinding(prepared, selected)) };
}

/** A shell-only, project-scoped human editing surface. No execution ops. */
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
