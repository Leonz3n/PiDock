import type { ProjectTaskCreation, CreationRequest } from "./project-task-creation.js";
import { TrustDomainViolation } from "./trust-domain.js";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).sort().join() !== [...fields].sort().join()) throw new TrustDomainViolation("invalid-payload", "invalid creation operation");
}
function input(value: unknown): CreationRequest {
  if (!object(value)) throw new TrustDomainViolation("invalid-payload", "invalid creation input");
  exact(value, ["projectId", "name", "repositories", "directoryIds", "sharedWriteConfirmed", "override"]);
  if (typeof value.projectId !== "string" || typeof value.name !== "string" ||
      typeof value.override !== "boolean" || typeof value.sharedWriteConfirmed !== "boolean" ||
      !Array.isArray(value.repositories) || !Array.isArray(value.directoryIds) ||
      value.repositories.length > 30 || value.directoryIds.length > 30 ||
      !value.directoryIds.every((id) => typeof id === "string") ||
      !value.repositories.every((entry) => {
        if (!object(entry)) return false;
        return Object.keys(entry).sort().join() === "remote,remoteBranch,sourceId" &&
          typeof entry.sourceId === "string" && typeof entry.remote === "string" && typeof entry.remoteBranch === "string";
      })) throw new TrustDomainViolation("invalid-payload", "invalid creation input");
  return value as unknown as CreationRequest;
}

/** No renderer-supplied root or source path is accepted. */
export async function performCreationOperation(
  service: ProjectTaskCreation, request: unknown, pickRoot: () => Promise<string | null>,
  reattest: () => void,
): Promise<unknown> {
  if (!object(request) || typeof request.op !== "string") throw new TrustDomainViolation("invalid-payload", "invalid creation operation");
  switch (request.op) {
    case "current": exact(request, ["op"]); return service.current();
    case "prepare": {
      exact(request, ["op", "input"]);
      const selected = input(request.input);
      const root = selected.override ? await pickRoot() : undefined;
      reattest();
      if (root === null) return { canceled: true };
      return { canceled: false, intent: await service.prepare(selected, root) };
    }
    case "commit": {
      exact(request, ["op", "id"]);
      if (typeof request.id !== "string" || !/^[0-9a-f-]{36}$/i.test(request.id)) throw new TrustDomainViolation("invalid-payload", "invalid creation ID");
      return service.commit(request.id);
    }
    default: throw new TrustDomainViolation("invalid-payload", "unknown creation operation");
  }
}
