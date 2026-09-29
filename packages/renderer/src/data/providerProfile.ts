/**
 * Provider 配置的渲染层契约（[PiDock 02m] #46，页面化于 [UI 对齐] #47 S8e）。
 *
 * 与 `DesktopProvidersPage` 共用的严格解析：main 返回的任何意外形状都不会被
 * 当成「已配置」，而是抛出并让页面保持锁定。这里不出现任何密钥字段——界面
 * 只处理引用名（`authRef`）与可用性布尔值。
 */
export type ProviderView = {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  authRef: string;
  generation: number;
  credentialAvailable: boolean;
};
export type ProviderState = "configured" | "not-configured" | "pending" | "credential-missing" | "binding-stale" | "install-failed";
export type ProviderStatus = { state: ProviderState; profileId: string | null; generation: number | null; profiles: ProviderView[] };
export type ProviderDraft = { id?: string; name: string; baseUrl: string; modelId: string; contextWindow: string; maxTokens: string; authRef: string };

export const EMPTY_PROVIDER_DRAFT: ProviderDraft = { name: "", baseUrl: "", modelId: "", contextWindow: "128000", maxTokens: "8192", authRef: "PIDOCK_PROVIDER_" };

const STATES: ProviderState[] = ["configured", "not-configured", "pending", "credential-missing", "binding-stale", "install-failed"];

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Renderer-side validation of main's status payload; a surprise keeps the page locked. */
export function parseProviderStatus(value: unknown): ProviderStatus {
  if (!object(value) || !STATES.includes(String(value.state) as ProviderState) ||
      !(value.profileId === null || typeof value.profileId === "string") ||
      !(value.generation === null || Number.isSafeInteger(value.generation)) ||
      !Array.isArray(value.profiles) || value.profiles.length > 50) throw new Error("Provider 状态返回异常");
  const profiles = value.profiles.map((item: unknown) => {
    if (!object(item) || typeof item.id !== "string" || !/^p-[0-9a-f-]{36}$/.test(item.id) || typeof item.credentialAvailable !== "boolean" ||
        !["name", "baseUrl", "modelId", "authRef"].every((key) => typeof item[key] === "string" && (item[key] as string).length <= 2048) ||
        !["contextWindow", "maxTokens", "generation"].every((key) => Number.isSafeInteger(item[key]) && (item[key] as number) >= 1)) throw new Error("Provider 配置返回异常");
    return item as unknown as ProviderView;
  });
  return { state: value.state as ProviderState, profileId: value.profileId as string | null, generation: value.generation as number | null, profiles };
}

export const PROVIDER_STATE_TEXT: Record<ProviderState, string> = {
  configured: "已配置 · 该任务的模型请求通过本机凭据引用发出",
  "not-configured": "未配置 · SDK 会话不会发出模型请求（不会回退到本机其它凭据）",
  pending: "已保存但尚未安装 · 该任务有进行中的请求或上下文未就绪，未安装",
  "credential-missing": "凭据缺失 · 已保存的引用在该环境变量中没有取值，未安装",
  "binding-stale": "会话绑定失效 · 该任务的 SDK 会话记录绑定的是另一份配置身份，已拒绝继续发送；重新选用同一份配置也无法恢复（重建会话尚未实现）",
  "install-failed": "安装失败 · 隔离上下文拒绝了这份配置，未安装",
};

/** One `shell/providerOp` round trip; throws with main's own wording on refusal. */
export async function providerCall(taskId: string, request: Record<string, unknown>): Promise<unknown> {
  const bridge = window.pidock;
  if (!bridge?.providerOp) throw new Error("桌面壳 Provider 接口不可用");
  const result = await bridge.providerOp({ taskId, ...request } as never);
  if (!result || result.ok !== true) throw new Error(result?.error || "Provider 配置不可用");
  return result.payload;
}

/** `save` answers with the stored profile; the id is checked before it is selected. */
export function savedProviderId(payload: unknown): string {
  const profile = object(payload) ? payload["profile"] : undefined;
  const id = object(profile) ? profile["id"] : undefined;
  if (typeof id !== "string" || !/^p-[0-9a-f-]{36}$/.test(id)) throw new Error("Provider 保存返回异常");
  return id;
}
