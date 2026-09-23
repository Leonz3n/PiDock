/**
 * Renderer mirror of the Host execution-ledger attention projection
 * ([PiDock 17] #19 box 5), kept Node-free: the page can group and read-clear the
 * list without a Host round trip, and the same rules are locked by
 * `test/attentionRules.test.ts` against `shell/main/execution-ledger.ts`.
 *
 * The Host owns the records; this module owns what the list *shows*: the label
 * of one item (project · task), which items are pending vs unread, and the one
 * rule that matters for reading — only the unread kind clears on read.
 */

import type { AttentionItem } from "./types";

export type AttentionKind = AttentionItem["kind"];

/** 盒子 5:待处理 (approval/failed/expired) vs 完成未读 (completed-unread). */
export const ATTENTION_KINDS: readonly AttentionKind[] = ["approval", "failed", "expired", "completed-unread"];

/** Reading clears unread only; pending items must be handled, not read away. */
export function attentionClearsOnRead(kind: AttentionKind): boolean {
  return kind === "completed-unread";
}

/** One item's label: the project name is added once it is known. */
export function attentionLabel(projectName: string | undefined, taskName: string): string {
  return projectName !== undefined && projectName.length > 0 ? `${projectName} · ${taskName}` : taskName;
}

/** Item the Host returns: task/session located, unread state included. */
export type HostAttentionItem = {
  id: string;
  kind: AttentionKind;
  executionId: string;
  taskId: string;
  sessionId: string;
  taskName: string;
  detail: string;
  at: string;
  read: boolean;
};

function asKind(value: unknown): AttentionKind | undefined {
  return typeof value === "string" && (ATTENTION_KINDS as readonly string[]).includes(value) ? (value as AttentionKind) : undefined;
}

export function asHostAttentionItem(value: unknown): HostAttentionItem | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const kind = asKind(record["kind"]);
  if (kind === undefined) return undefined;
  for (const key of ["id", "executionId", "taskId", "sessionId", "detail", "at"] as const) {
    if (typeof record[key] !== "string" || (record[key] as string).length === 0) return undefined;
  }
  const taskName = typeof record["taskName"] === "string" && record["taskName"].length > 0 ? record["taskName"] : (record["taskId"] as string);
  return {
    id: record["id"] as string,
    kind,
    executionId: record["executionId"] as string,
    taskId: record["taskId"] as string,
    sessionId: record["sessionId"] as string,
    taskName,
    detail: record["detail"] as string,
    at: record["at"] as string,
    read: record["read"] === true,
  };
}

/** Map one Host item to the renderer list item the page renders. */
export function attentionItemFromHost(item: HostAttentionItem, project: { id: string; name: string } | undefined): AttentionItem {
  return {
    id: item.id,
    kind: item.kind,
    projectId: project?.id ?? "",
    taskId: item.taskId,
    sessionId: item.sessionId,
    label: attentionLabel(project?.name, item.taskName),
    detail: item.detail,
    read: item.read,
  };
}

const KIND_ORDER: Record<AttentionKind, number> = { approval: 0, failed: 1, expired: 2, "completed-unread": 3 };

/**
 * Stable list order: pending kinds first (approval → failed → expired), then
 * unread completions; newest first inside a kind, id as the tie-break.
 */
export function groupAttentionItems(items: readonly AttentionItem[]): {
  pending: AttentionItem[];
  unread: AttentionItem[];
} {
  const sorted = [...items].sort((a, b) => {
    if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    const aAt = a.at ?? "";
    const bAt = b.at ?? "";
    if (aAt !== bAt) return aAt < bAt ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return {
    pending: sorted.filter((item) => item.kind !== "completed-unread"),
    unread: sorted.filter((item) => item.kind === "completed-unread" && item.read !== true),
  };
}

/**
 * Split what one read should clear from what still needs handling. The read
 * returns both halves so the page can say why an item did not disappear.
 */
export function splitAttentionRead(items: readonly AttentionItem[]): { clearable: string[]; handled: string[] } {
  const clearable: string[] = [];
  const handled: string[] = [];
  for (const item of items) {
    if (attentionClearsOnRead(item.kind)) clearable.push(item.id);
    else handled.push(item.id);
  }
  return { clearable, handled };
}
