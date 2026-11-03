/**
 * [Pencil T10] #145 引用来源在发送前的重检。
 *
 * 组合器里的引用芯片是页面状态，而真正到达模型的是 Host 拼出的身份清单。发送前
 * 必须按任务重新核对一遍：跨任务的引用、越界路径、没有记录来源身份的旧芯片、
 * 以及 Host 已经不认识的根目录都要按名字提示「重新选择」，绝不静默改为源仓库
 * 或另一个任务里的同名文件，也不把不可读的引用当作已发送。
 *
 * 两条判据分开是为了可测：
 *
 * - `referenceIssue` 只看芯片自身携带的身份（taskId / relativePath / sourceId），
 *   不读任何宿主；恢复草稿时就能立刻标出明显失效的芯片。
 * - `rootReferenceIssue` 拿 Host 真实读到的 `task/fileRoots` 结果再核对根目录，
 *   由调用方在发送前执行；Host 没报告根目录时按名字拒绝，而不是假定存在。
 */

import type { Reference } from "./types";

export const REFERENCE_KIND_TEXT: Record<Reference["kind"], string> = {
  file: "文件",
  directory: "目录",
  snippet: "片段",
  attachment: "附件",
  skill: "技能",
};

export type ReferenceIssue = {
  id: string;
  label: string;
  /** The named reason, shown verbatim on the chip and in the send refusal. */
  message: string;
};

const isInsideSource = (relativePath: string): boolean =>
  !relativePath.startsWith("/") &&
  !/^[A-Za-z]:[\\/]/.test(relativePath) &&
  !relativePath.split(/[\\/]/).includes("..");

/**
 * One chip's own identity, checked against the task it is being sent in.
 * Attachments and skills are machine-local/explicit inputs: they have no
 * task-relative path to resolve, so only their owning task is compared.
 */
export function referenceIssue(reference: Reference, taskId: string): string | null {
  if (reference.taskId !== undefined && reference.taskId !== taskId) {
    return "引用属于另一个任务，请重新选择来源";
  }
  if (reference.kind === "attachment" || reference.kind === "skill") return null;
  const relativePath = reference.relativePath;
  if (relativePath === undefined || relativePath.trim().length === 0) {
    return "引用未记录来源路径，请重新选择来源（不回退到主检出目录）";
  }
  if (!isInsideSource(relativePath)) return "引用路径越界，请重新选择来源";
  if (reference.sourceId === undefined || reference.sourceKind === undefined) {
    return "引用未记录来源身份（仓库或目录链接），请重新选择来源";
  }
  return null;
}

export function referenceIssues(references: readonly Reference[], taskId: string): ReferenceIssue[] {
  const issues: ReferenceIssue[] = [];
  for (const reference of references) {
    const message = referenceIssue(reference, taskId);
    if (message !== null) issues.push({ id: reference.id, label: reference.label, message });
  }
  return issues;
}

/** The one Host fact a re-check needs from a `task/fileRoots` read. */
export type ReferenceRootFact = { id: string; kind: "worktree" | "shared-dir" | "existing-git" };

/**
 * Re-checks a chip against the roots the Host really reported. A root the Host
 * no longer lists is a stale source; a chip whose recorded kind no longer
 * matches the root is a different source wearing the same name. Neither is
 * repaired here.
 */
export function rootReferenceIssue(reference: Reference, roots: readonly ReferenceRootFact[]): string | null {
  if (reference.kind === "attachment" || reference.kind === "skill") return null;
  if (reference.sourceId === undefined) return null; // already named by `referenceIssue`
  const root = roots.find((entry) => entry.id === reference.sourceId);
  if (root === undefined) return "来源已失效（仓库或目录链接已移除），请重新选择来源";
  const expected = reference.sourceKind === "plain-dir" ? "shared-dir" : "worktree";
  if (root.kind !== expected && !(reference.sourceKind === "worktree" && root.kind === "existing-git")) {
    return "来源类型与引用记录不一致，请重新选择来源";
  }
  return null;
}

/** `task/fileRoots` payload → the facts above, or a named failure. */
export function referenceRootFacts(payload: unknown): { roots: ReferenceRootFact[]; error: string | null } {
  if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { roots?: unknown }).roots)) {
    return { roots: [], error: "来源重检失败：Host 未上报任务根目录；请重新选择引用" };
  }
  const roots: ReferenceRootFact[] = [];
  for (const entry of (payload as { roots: unknown[] }).roots) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = record["id"];
    const kind = record["kind"];
    if (typeof id !== "string" || id.length === 0) continue;
    if (kind !== "worktree" && kind !== "shared-dir" && kind !== "existing-git") continue;
    roots.push({ id, kind });
  }
  return { roots, error: null };
}

/** The single line a refused send shows; empty list → `null`. */
export function referenceSendRefusal(issues: readonly ReferenceIssue[]): string | null {
  if (issues.length === 0) return null;
  const named = issues.map((issue) => `${issue.label}：${issue.message}`).join("；");
  return `引用需先修正：${named}。草稿与引用都保留在本会话，未发送任何内容。`;
}
