import { shellTaskOp } from "./shellBridge";
import { SDK_SESSION_ID } from "./sdkSession";
import type { Reference } from "./types";

/**
 * [#117 第 7 项 / 业主定 A] The desktop draft is Host state, not browser state.
 *
 * Before this module the composer kept its draft in `localStorage` (text only),
 * so it survived a reload of the same browser profile and nothing else: no
 * references, no task-folder identity, and a draft that said nothing about which
 * Host it belonged to. The Host already stores drafts inside the session
 * snapshot (`task/saveDraft`, references included) and can read them back
 * (`task/readDraft`), so the renderer's job is exactly two things:
 *
 * - read the Host's record into a `Reference[]` the composer can render,
 * - write the composer's current text + references back, verbatim.
 *
 * Nothing here composes a prompt, reorders references or repairs a value: an
 * unreadable answer is reported by name and an over-long text is refused
 * instead of being truncated into the composer.
 */

/** The SDK turn's message cap; a draft above it could never be sent. */
export const MAX_DRAFT_BYTES = 16_384;

export const DRAFT_REFERENCE_KINDS = new Set(["file", "directory", "snippet", "attachment", "skill"]);

export type HostDraft = { text: string; references: Reference[] };

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const bytes = (text: string) => new TextEncoder().encode(text).length;

/** A reference the Host stored and this build can render; anything else is skipped. */
function asReference(value: unknown): Reference | null {
  if (!object(value)) return null;
  if (!nonEmpty(value["id"]) || !nonEmpty(value["label"]) || !nonEmpty(value["detail"])) return null;
  const kind = value["kind"];
  if (typeof kind !== "string" || !DRAFT_REFERENCE_KINDS.has(kind)) return null;
  if (value["sourceKind"] !== undefined && value["sourceKind"] !== "worktree" && value["sourceKind"] !== "plain-dir") return null;
  return value as unknown as Reference;
}

/**
 * Read one `task/readDraft` payload. `skipped` is returned rather than folded
 * into an error, because a draft with two unreadable references still has text
 * the user typed: the composer shows the text AND says what it dropped.
 */
export function draftFromHost(payload: unknown): { draft: HostDraft | null; skipped: number; error: string | null } {
  if (!object(payload) || !("draft" in payload)) {
    return { draft: null, skipped: 0, error: "草稿读取失败：Host 未上报草稿；仍可编辑和发送，请单独核验草稿记录" };
  }
  const raw = payload["draft"];
  if (raw === null) return { draft: null, skipped: 0, error: null };
  if (!object(raw) || typeof raw["text"] !== "string") {
    return { draft: null, skipped: 0, error: "草稿读取失败：Host 上报的草稿不可读取；仍可编辑和发送，请单独核验草稿记录" };
  }
  const text = raw["text"];
  if (bytes(text) > MAX_DRAFT_BYTES) {
    return { draft: { text: "", references: [] }, skipped: 0,
      error: "草稿读取失败：Host 上的草稿文字超过 16 KiB，未放入输入区；仍可编辑和发送" };
  }
  const stored = raw["references"];
  const references: Reference[] = [];
  let skipped = 0;
  if (stored !== undefined) {
    if (!Array.isArray(stored)) {
      return { draft: { text, references: [] }, skipped: 0,
        error: "草稿读取失败：Host 上报的引用不是列表，已忽略引用；仍可编辑和发送" };
    }
    for (const entry of stored) {
      const reference = asReference(entry);
      if (reference) references.push(reference);
      else skipped += 1;
    }
  }
  return { draft: { text, references }, skipped, error: skipped > 0 ? `已跳过 ${skipped} 项无法读取的引用；草稿文字已恢复` : null };
}

export async function readHostDraft(taskId: string): Promise<{ draft: HostDraft | null; error: string | null }> {
  try {
    const result = await shellTaskOp(taskId, "task/readDraft", { sessionId: SDK_SESSION_ID });
    if (!result.ok) {
      return { draft: null, error: `草稿读取失败：${result.error}；仍可编辑和发送，请单独核验草稿记录` };
    }
    const read = draftFromHost(result.payload);
    return { draft: read.draft, error: read.error };
  } catch (error) {
    return { draft: null, error: `草稿读取失败：${error instanceof Error ? error.message : String(error)}；仍可编辑和发送，请单独核验草稿记录` };
  }
}

/** `null` means the Host confirmed the save; any string is a named refusal. */
export async function saveHostDraft(taskId: string, draft: HostDraft): Promise<string | null> {
  if (bytes(draft.text) > MAX_DRAFT_BYTES) {
    return "草稿未保存：文字超过 16 KiB；原记录保留，仍可编辑，发送遵循 SDK 消息上限";
  }
  try {
    const result = await shellTaskOp(taskId, "task/saveDraft", {
      sessionId: SDK_SESSION_ID,
      text: draft.text,
      ...(draft.references.length > 0 ? { references: draft.references } : {}),
    });
    if (!result.ok) return `草稿未保存：${result.error}；原记录保留，仍可编辑和发送`;
    return null;
  } catch (error) {
    return `草稿未保存：${error instanceof Error ? error.message : String(error)}；原记录保留，仍可编辑和发送`;
  }
}
