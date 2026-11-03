import type { ProjectTaskCreation, CreationRequest } from "./project-task-creation.js";
import { TrustDomainViolation } from "./trust-domain.js";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).sort().join() !== [...fields].sort().join()) throw new TrustDomainViolation("invalid-payload", "invalid creation operation");
}
function exactOptional(value: Record<string, unknown>, required: string[], optional: string[]): void {
  const keys = Object.keys(value);
  if (keys.some((key) => !required.includes(key) && !optional.includes(key)) ||
      required.some((key) => !keys.includes(key))) throw new TrustDomainViolation("invalid-payload", "invalid creation operation");
}
function input(value: unknown): CreationRequest {
  if (!object(value)) throw new TrustDomainViolation("invalid-payload", "invalid creation input");
  // [Pencil T02] #137: `workspaceMode` is optional so a legacy caller keeps the
  // previous auto-worktree behaviour; when present it must be one of the three
  // real modes (a renderer-only string is refused here, before main).
  exactOptional(value, ["projectId", "name", "repositories", "directoryIds", "sharedWriteConfirmed", "override"],
    ["workspaceMode", "kind", "schedule"]);
  if (value.workspaceMode !== undefined &&
      value.workspaceMode !== "worktree" && value.workspaceMode !== "existing-git" && value.workspaceMode !== "plain-dirs") {
    throw new TrustDomainViolation("invalid-payload", "invalid workspace mode");
  }
  // [Pencil T17] #152: kind + definition are the ONLY creation-time schedule
  // surface. A scheduled creation must carry both; a normal one neither. The
  // Host validates every definition field on save, so this only fixes the shape.
  if (value.kind !== undefined && value.kind !== "normal" && value.kind !== "scheduled") {
    throw new TrustDomainViolation("invalid-payload", "invalid task kind");
  }
  if (value.schedule !== undefined) {
    if (!object(value.schedule) || value.kind !== "scheduled") {
      throw new TrustDomainViolation("invalid-payload", "schedule requires a scheduled task kind");
    }
    const schedule = value.schedule;
    if (Object.keys(schedule).some((key) => !["name", "ruleText", "timezone", "prompt", "providerId", "model", "permission", "enabled"].includes(key)) ||
        !["name", "ruleText", "timezone", "prompt", "providerId", "model"].every((key) => typeof schedule[key] === "string") ||
        (schedule.permission !== "read" && schedule.permission !== "default" && schedule.permission !== "auto") ||
        (schedule.enabled !== undefined && typeof schedule.enabled !== "boolean")) {
      throw new TrustDomainViolation("invalid-payload", "invalid schedule definition");
    }
  } else if (value.kind === "scheduled") {
    throw new TrustDomainViolation("invalid-payload", "scheduled task requires a schedule definition");
  }
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
    // [Pencil T13] #148 the SAVED branch convention + push remote, readable
    // WITHOUT a task: the create-task form reads them before anything exists
    // (the delivery sheet's `task/deliverySettings` needs a created task).
    case "deliverySettings": {
      exact(request, ["op"]);
      return { settings: service.deliverySettings() };
    }
    case "saveDeliverySettings": {
      exact(request, ["op", "branchTemplate", "remote"]);
      if (typeof request.branchTemplate !== "string" || typeof request.remote !== "string") {
        throw new TrustDomainViolation("invalid-payload", "invalid delivery settings payload");
      }
      // Both values are validated by main (`git-delivery.ts`); an unset or
      // invalid pair is NAMED back to the page, never replaced by a default.
      return { settings: service.saveDeliverySettings({ branchTemplate: request.branchTemplate, remote: request.remote }) };
    }
    // [Pencil T13] #148 the pre-creation preview: per-repository local branch
    // and push target computed by main from the saved settings and the real
    // checkouts. Read-only: no fetch, no worktree, no branch, no write.
    case "deliveryPreview": {
      exact(request, ["op", "input"]);
      return await service.previewDelivery(input(request.input));
    }
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
    case "abandon": {
      // [Pencil T08] #143: `cleanup` is optional so a caller that predates it
      // keeps the old keep-everything behaviour; `owned` is the explicit choice
      // that removes only identity-confirmed resources of this creation.
      exactOptional(request, ["op", "id", "confirmed"], ["cleanup"]);
      if (typeof request.id !== "string" || !/^[0-9a-f-]{36}$/i.test(request.id)) throw new TrustDomainViolation("invalid-payload", "invalid creation ID");
      if (request.confirmed !== true) throw new TrustDomainViolation("invalid-payload", "abandon requires explicit confirmation");
      if (request.cleanup !== undefined && request.cleanup !== "keep" && request.cleanup !== "owned") {
        throw new TrustDomainViolation("invalid-payload", "invalid abandon cleanup scope");
      }
      return service.abandon(request.id, true, request.cleanup === "owned" ? "owned" : "keep");
    }
    case "status": {
      // Read-only per-repository recovery state (no root pick, no attestation).
      exact(request, ["op"]);
      return service.status();
    }
    case "retry": {
      // Retry ONLY the failing repositories; `adoptOrphanBranches` is the
      // explicit adopt choice for a task branch that exists without a worktree.
      exactOptional(request, ["op", "id"], ["adoptOrphanBranches"]);
      if (typeof request.id !== "string" || !/^[0-9a-f-]{36}$/i.test(request.id)) throw new TrustDomainViolation("invalid-payload", "invalid creation ID");
      if (request.adoptOrphanBranches !== undefined && typeof request.adoptOrphanBranches !== "boolean") {
        throw new TrustDomainViolation("invalid-payload", "invalid orphan adoption flag");
      }
      reattest();
      return service.retry(request.id, request.adoptOrphanBranches === true);
    }
    default: throw new TrustDomainViolation("invalid-payload", "unknown creation operation");
  }
}
