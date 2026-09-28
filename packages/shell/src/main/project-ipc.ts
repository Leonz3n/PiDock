import type { ProjectRegistry, ProjectCreateInput, ProjectUpdateInput } from "./project-registry.js";
import { TrustDomainViolation } from "./trust-domain.js";

type ProjectOperation = "list" | "get" | "create" | "update" | "rename" | "delete";
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function shape(value: unknown, op: ProjectOperation, fields: string[]): Record<string, unknown> {
  if (!object(value) || value["op"] !== op || Object.keys(value).sort().join(",") !== ["op", ...fields].sort().join(",")) {
    throw new TrustDomainViolation("invalid-payload", `invalid project ${op} payload`);
  }
  return value;
}
function projectId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)) {
    throw new TrustDomainViolation("invalid-payload", "invalid project ID");
  }
  return value;
}

/** Renderer selects an operation and ID, never a registry file or membership. */
export async function performProjectOperation(store: ProjectRegistry, request: unknown): Promise<unknown> {
  if (!object(request) || typeof request["op"] !== "string") throw new TrustDomainViolation("invalid-payload", "invalid project operation");
  switch (request["op"]) {
    case "list": shape(request, "list", []); return store.list();
    case "get": return store.get(projectId(shape(request, "get", ["projectId"])["projectId"])) ?? null;
    case "create": return store.create(shape(request, "create", ["input"])["input"] as ProjectCreateInput);
    case "update": {
      const args = shape(request, "update", ["projectId", "input"]);
      return store.update(projectId(args["projectId"]), args["input"] as ProjectUpdateInput);
    }
    case "rename": {
      const args = shape(request, "rename", ["projectId", "name"]);
      if (typeof args["name"] !== "string") throw new TrustDomainViolation("invalid-payload", "invalid project name");
      return store.rename(projectId(args["projectId"]), args["name"]);
    }
    case "delete": return store.delete(projectId(shape(request, "delete", ["projectId"])["projectId"]));
    default: throw new TrustDomainViolation("invalid-payload", "unknown project operation");
  }
}
