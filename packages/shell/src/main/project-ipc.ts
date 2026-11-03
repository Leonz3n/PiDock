import type { ProjectRegistry, ProjectCreateInput, ProjectUpdateInput } from "./project-registry.js";
import type { TaskRootIndex } from "./task-root-index.js";
import { verifyProjectSources } from "./project-sources.js";
import { TrustDomainViolation } from "./trust-domain.js";

type ProjectOperation = "list" | "get" | "create" | "update" | "rename" | "delete" | "association" | "associations"
  | "claim" | "unlink" | "transfer" | "status" | "recover" | "verifySources" | "blockers";

/**
 * Named registry failures. The UI has to tell "missing, restore from backup",
 * "corrupt" and "someone rewrote the audit trail" apart, so an unnamed
 * catch-all string would leave the recovery path unreachable (#136).
 */
export function projectFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("backup requires explicit recovery")) return "项目注册表缺失，可从备份恢复";
  if (message.includes("no valid backup")) return "项目注册表缺失，且备份不可用";
  if (message.includes("audit integrity")) return "项目注册表审计摘要不一致，可能被外部改动";
  if (message.includes("unsupported project registry version")) return "项目注册表版本不受支持";
  if (message.includes("invalid project registry") || message.includes("too large") || message.includes("invalid project")) {
    return "项目注册表内容损坏";
  }
  return "项目注册表操作失败，请检查本机项目数据后重试";
}
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

function taskId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new TrustDomainViolation("invalid-payload", "invalid task ID");
  }
  return value;
}

/** Renderer selects an operation and ID, never a registry file or membership. */
export async function performProjectOperation(store: ProjectRegistry, request: unknown, roots?: TaskRootIndex): Promise<unknown> {
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
    case "status": { shape(request, "status", []); return store.status(); }
    case "recover": {
      const args = shape(request, "recover", ["confirmed"]);
      // Recovery installs the backup over the primary: it is never implicit.
      if (args["confirmed"] !== true) throw new TrustDomainViolation("invalid-payload", "recovery requires explicit confirmation");
      return store.recover();
    }
    case "verifySources": {
      const target = projectId(shape(request, "verifySources", ["projectId"])["projectId"]);
      const project = store.get(target);
      if (!project) throw new TrustDomainViolation("invalid-payload", "unknown project");
      return verifyProjectSources(project);
    }
    case "blockers": {
      const target = projectId(shape(request, "blockers", ["projectId"])["projectId"]);
      if (!roots) throw new TrustDomainViolation("invalid-payload", "task root index unavailable");
      return store.blockers(target, roots);
    }
    case "association": {
      const args = shape(request, "association", ["taskId"]);
      if (!roots) throw new TrustDomainViolation("invalid-payload", "task root index unavailable");
      return store.association(taskId(args["taskId"]), roots);
    }
    case "associations": {
      shape(request, "associations", []);
      if (!roots) throw new TrustDomainViolation("invalid-payload", "task root index unavailable");
      const assigned = store.associations(roots);
      const known = new Set(assigned.map((row) => row.taskId));
      return { tasks: [...assigned, ...roots.inventory().tasks.filter((row) => !known.has(row.taskId))
        .map((row) => store.association(row.taskId, roots))], roots: roots.inventory().roots };
    }
    case "claim": {
      const args = shape(request, "claim", ["taskId", "projectId"]);
      if (!roots) throw new TrustDomainViolation("invalid-payload", "task root index unavailable");
      return store.claim(taskId(args["taskId"]), projectId(args["projectId"]), roots);
    }
    case "unlink": {
      const args = shape(request, "unlink", ["taskId", "expectedProjectId"]);
      return store.unlink(taskId(args["taskId"]), projectId(args["expectedProjectId"]));
    }
    case "transfer": {
      const args = shape(request, "transfer", ["taskId", "fromProjectId", "toProjectId"]);
      if (!roots) throw new TrustDomainViolation("invalid-payload", "task root index unavailable");
      return store.transfer(taskId(args["taskId"]), projectId(args["fromProjectId"]), projectId(args["toProjectId"]), roots);
    }
    default: throw new TrustDomainViolation("invalid-payload", "unknown project operation");
  }
}
