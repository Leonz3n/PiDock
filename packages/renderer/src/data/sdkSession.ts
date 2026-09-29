/**
 * 生产 SDK 会话的渲染层契约（[PiDock 02m] #44/#45，页面化于 [UI 对齐] #47 S8e）。
 *
 * 会话视图与 Token 用量页读取的是同一份真实证据：任务私有的 SDK JSONL 投影。
 * 因此解析只在这里写一份——两处对「什么算合法历史」的判断不可能漂移。
 */
export const SDK_SESSION_ID = "main";

export type SdkUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type SdkMessage = { role: "user" | "assistant"; text: string; usage: SdkUsage | null };
export type SdkSnapshot = { source: "sdk-jsonl"; sessionId: string; messages: SdkMessage[]; pending: boolean; interrupted: boolean };

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function parseSdkSnapshot(value: unknown): SdkSnapshot {
  if (!object(value) || value.source !== "sdk-jsonl" || value.sessionId !== SDK_SESSION_ID || !Array.isArray(value.messages) ||
      value.messages.length > 80 || typeof value.pending !== "boolean" || typeof value.interrupted !== "boolean") {
    throw new Error("SDK 历史返回异常");
  }
  const messages = value.messages.map((item: unknown) => {
    if (!object(item) || !["user", "assistant"].includes(String(item.role)) || typeof item.text !== "string" ||
        !(item.usage === null || (object(item.usage) && ["input", "output", "cacheRead", "cacheWrite"].every((key) => Number.isSafeInteger((item.usage as Record<string, unknown>)[key]) && Number((item.usage as Record<string, unknown>)[key]) >= 0)))) {
      throw new Error("SDK 消息返回异常");
    }
    return item as unknown as SdkMessage;
  });
  return { source: "sdk-jsonl", sessionId: SDK_SESSION_ID, messages, pending: value.pending, interrupted: value.interrupted };
}

/** Totals over a snapshot; a message without usage record contributes nothing. */
export function sumSdkUsage(messages: readonly SdkMessage[]): SdkUsage & { turns: number } {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    totals.turns += 1;
    if (!message.usage) continue;
    totals.input += message.usage.input;
    totals.output += message.usage.output;
    totals.cacheRead += message.usage.cacheRead;
    totals.cacheWrite += message.usage.cacheWrite;
  }
  return totals;
}

/** `sdkTurn subscribe/unsubscribe` through the production bridge. */
export async function sdkSnapshot(bridge: { sdkTurn?: (request: never) => Promise<{ ok: boolean; payload?: unknown; error?: string }> } | undefined, taskId: string): Promise<SdkSnapshot> {
  if (typeof bridge?.sdkTurn !== "function") throw new Error("桌面壳 SDK 接口不可用");
  const result = await bridge.sdkTurn({ action: "subscribe", taskId, sessionId: SDK_SESSION_ID } as never);
  if (!result || result.ok !== true) throw new Error(result?.error || "SDK 会话读取失败");
  const payload = result.payload as { snapshot?: unknown } | undefined;
  try {
    return parseSdkSnapshot(payload?.snapshot);
  } catch (error) {
    // A successful subscribe has installed a listener even if its payload is
    // malformed. Release it before surfacing the parse failure.
    await bridge.sdkTurn({ action: "unsubscribe", taskId, sessionId: SDK_SESSION_ID } as never).catch(() => undefined);
    throw error;
  }
}
