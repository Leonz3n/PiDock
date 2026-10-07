import { SDK_SESSION_ID } from "./sdkSession";

type SdkDraft = { schema: 1; taskId: string; sessionId: "main"; text: string };
const key = (taskId: string) => `pidock-sdk-draft-v1:${encodeURIComponent(taskId)}:${SDK_SESSION_ID}`;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const validText = (text: string) => new TextEncoder().encode(text).length <= 16384;

/** UI text only, in the shell origin's local storage; never SDK history or a request receipt. */
export function readSdkDraft(taskId: string): { text: string | null; error: string | null } {
  try {
    const raw = localStorage.getItem(key(taskId));
    if (raw === null) return { text: null, error: null };
    if (raw.length > 131072) throw new Error("invalid size");
    const value: unknown = JSON.parse(raw);
    if (!object(value) || Object.keys(value).sort().join(",") !== "schema,sessionId,taskId,text" ||
        value.schema !== 1 || value.taskId !== taskId || value.sessionId !== SDK_SESSION_ID ||
        typeof value.text !== "string" || !validText(value.text)) throw new Error("invalid draft");
    return { text: value.text, error: null };
  } catch { return { text: null, error: "本机草稿不可读取；原记录保留，编辑的草稿不会保存。仍可编辑和发送，请单独核验本机草稿记录" }; }
}

export function saveSdkDraft(taskId: string, text: string): string | null {
  const saved = readSdkDraft(taskId);
  if (saved.error) return saved.error;
  if (!validText(text)) return "草稿未保存：文字超过 16 KiB；原记录保留，仍可编辑，发送遵循 SDK 消息上限";
  try {
    const value: SdkDraft = { schema: 1, taskId, sessionId: SDK_SESSION_ID, text };
    const raw = JSON.stringify(value);
    if (raw.length > 131072) return "草稿未保存：记录超过存储上限；原记录保留，仍可编辑和发送";
    // An empty record distinguishes a cleared composer from a legacy receipt-only draft.
    localStorage.setItem(key(taskId), raw);
    if (localStorage.getItem(key(taskId)) !== raw) throw new Error("unconfirmed storage");
    return null;
  } catch { return "草稿未保存：本机存储不可用；仍可编辑和发送"; }
}
