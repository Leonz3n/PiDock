import { TrustDomainViolation } from "./trust-domain.js";
import type { AppendReposRequest, ProjectTaskAppend } from "./task-append.js";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).sort().join() !== [...fields].sort().join()) {
    throw new TrustDomainViolation("invalid-payload", "invalid append operation");
  }
}
function request(value: unknown): AppendReposRequest {
  if (!object(value)) throw new TrustDomainViolation("invalid-payload", "invalid append input");
  exact(value, ["taskId", "repositories"]);
  const repositories = value["repositories"];
  if (typeof value["taskId"] !== "string" || value["taskId"].length === 0 || value["taskId"].length > 128 ||
      !Array.isArray(repositories) || repositories.length === 0 || repositories.length > 30 ||
      !repositories.every((entry) => {
        if (!object(entry)) return false;
        return Object.keys(entry).sort().join() === "remote,remoteBranch,sourceId" &&
          typeof entry["sourceId"] === "string" && typeof entry["remote"] === "string" &&
          typeof entry["remoteBranch"] === "string";
      })) {
    throw new TrustDomainViolation("invalid-payload", "invalid append input");
  }
  // No renderer-supplied root, checkout or repo folder name is accepted: the
  // page names project repository ids, remote names and branches only.
  return value as unknown as AppendReposRequest;
}

/**
 * Route one renderer append through main's production append. The page
 * supplies project repository ids, remote names and baseline branches; the
 * source checkouts, the repo folder names and the conflict scan are all
 * resolved and derived by main, and `reattest` re-proves the attested shell
 * sender right before the plan creates real resources.
 */
export async function performAppendOperation(
  service: ProjectTaskAppend,
  payload: unknown,
  reattest: () => void,
): Promise<unknown> {
  return service.append(request(payload), reattest);
}
