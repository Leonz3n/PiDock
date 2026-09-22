import { createHash } from "node:crypto";

const MAX_SLUG_LENGTH = 32;

function taskSlug(taskId: string): string {
  const slug = taskId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH);
  return slug.length > 0 ? slug : "task";
}

/**
 * Stable Electron persistent partition for a task. The hash keeps long or
 * non-Latin task ids distinct while the slug keeps evidence readable.
 */
export function taskPartitionName(taskId: string, workspaceId = "default"): string {
  if (taskId.trim().length === 0 || workspaceId.trim().length === 0) {
    throw new Error("taskId must be a non-empty string");
  }
  const digest = createHash("sha256").update(workspaceId + "\0" + taskId).digest("hex").slice(0, 12);
  return `persist:pidock-task-${taskSlug(taskId)}-${digest}`;
}
