import { useCallback, useEffect, useState, type FormEvent } from "react";

const button = "inline-flex min-h-8 items-center justify-center gap-1.5 border border-line bg-paper px-2.5 py-1 text-xs hover:bg-bg disabled:cursor-not-allowed disabled:opacity-50";
const field = "min-w-0 border border-line bg-bg px-2 py-1 text-xs";

type ProviderView = { id: string; name: string; baseUrl: string; modelId: string; contextWindow: number; maxTokens: number; authRef: string; generation: number; credentialAvailable: boolean };
type ProviderState = "configured" | "not-configured" | "pending" | "credential-missing" | "binding-stale" | "install-failed";
type ProviderStatus = { state: ProviderState; profileId: string | null; generation: number | null; profiles: ProviderView[] };
type Draft = { id?: string; name: string; baseUrl: string; modelId: string; contextWindow: string; maxTokens: string; authRef: string };

const empty: Draft = { name: "", baseUrl: "", modelId: "", contextWindow: "128000", maxTokens: "8192", authRef: "PIDOCK_PROVIDER_" };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 2048): string => typeof value === "string" && value.length <= max ? value : "";

/** Renderer-side validation of main's status payload; a surprise keeps the panel locked. */
function parseStatus(value: unknown): ProviderStatus {
  if (!object(value) || !["configured", "not-configured", "pending", "credential-missing", "binding-stale", "install-failed"].includes(String(value.state)) ||
      !(value.profileId === null || typeof value.profileId === "string") || !(value.generation === null || Number.isSafeInteger(value.generation)) ||
      !Array.isArray(value.profiles) || value.profiles.length > 50) throw new Error("Provider 状态返回异常");
  const profiles = value.profiles.map((item: unknown) => {
    if (!object(item) || typeof item.id !== "string" || !/^p-[0-9a-f-]{36}$/.test(item.id) || typeof item.credentialAvailable !== "boolean" ||
        !["name", "baseUrl", "modelId", "authRef"].every((key) => typeof item[key] === "string" && (item[key] as string).length <= 2048) ||
        !["contextWindow", "maxTokens", "generation"].every((key) => Number.isSafeInteger(item[key]) && (item[key] as number) >= 1)) throw new Error("Provider 配置返回异常");
    return item as ProviderView;
  });
  return { state: value.state as ProviderStatus["state"], profileId: value.profileId as string | null, generation: value.generation as number | null, profiles };
}

const STATE_TEXT: Record<ProviderStatus["state"], string> = {
  configured: "已配置 · 该任务的模型请求通过本机凭据引用发出",
  "not-configured": "未配置 · SDK 会话不会发出模型请求（不会回退到本机其它凭据）",
  pending: "已保存但尚未安装 · 该任务有进行中的请求或上下文未就绪，未安装",
  "credential-missing": "凭据缺失 · 已保存的引用在该环境变量中没有取值，未安装",
  "binding-stale": "会话绑定失效 · 该任务的 SDK 会话记录绑定的是另一份配置身份，已拒绝继续发送；重新选用同一份配置也无法恢复（重建会话尚未实现）",
  "install-failed": "安装失败 · 隔离上下文拒绝了这份配置，未安装",
};

/**
 * [PiDock 02m] (#46) Provider 配置面板。
 *
 * 只提交元数据与凭据引用名；取值由 main 从该引用解析并只交给任务隔离上下文，
 * 因此这里既没有输入密钥的字段，也不会显示任何密钥内容。
 */
export function DesktopProviderPanel({ taskId }: { taskId: string }) {
  const bridge = window.pidock;
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const call = useCallback(async (request: Record<string, unknown>) => {
    if (!bridge?.providerOp) throw new Error("桌面壳 Provider 接口不可用");
    const result = await bridge.providerOp({ taskId, ...request } as never);
    if (!result || result.ok !== true) throw new Error(result?.error || "Provider 配置不可用");
    return result.payload;
  }, [bridge, taskId]);
  const run = useCallback(async (request: Record<string, unknown>) => {
    try { setStatus(parseStatus(await call(request))); setError(""); }
    catch (caught) { setStatus(null); setError(caught instanceof Error ? caught.message : "Provider 配置不可用"); }
  }, [call]);
  useEffect(() => { void run({ op: "list" }); }, [run]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const input = {
      ...(draft.id === undefined ? {} : { id: draft.id }),
      name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim(),
      modelId: draft.modelId.trim(),
      contextWindow: Number(draft.contextWindow),
      maxTokens: Number(draft.maxTokens),
      authRef: draft.authRef.trim(),
    };
    void (async () => {
      try {
        const saved = await call({ op: "save", profile: input });
        const savedId = object(saved) && object(saved.profile) ? text(saved.profile.id, 64) : "";
        if (!/^p-[0-9a-f-]{36}$/.test(savedId)) throw new Error("Provider 保存返回异常");
        const selected = parseStatus(await call({ op: "select", profileId: savedId }));
        setStatus(selected); setError(""); setDraft(empty);
      } catch (caught) { await run({ op: "list" }); setError(caught instanceof Error ? caught.message : "Provider 保存失败"); }
      finally { setBusy(false); }
    })();
  };
  const edit = (profile: ProviderView) => {
    setOpen(true);
    setDraft({ id: profile.id, name: profile.name, baseUrl: profile.baseUrl, modelId: profile.modelId, contextWindow: String(profile.contextWindow), maxTokens: String(profile.maxTokens), authRef: profile.authRef });
  };
  const pending = status?.state !== "configured";
  return <section aria-label="Provider 配置" data-testid="provider-panel" className="border-b border-line bg-paper px-3 py-2">
    <div className="mx-auto flex max-w-[820px] min-w-0 flex-wrap items-center gap-2 text-xs">
      <span className="font-semibold">Provider</span>
      <span role="status" className="min-w-0 flex-1 break-words text-muted" data-testid="provider-state">{status ? STATE_TEXT[status.state] : "正在读取 Provider 配置"}</span>
      <button type="button" className={button} onClick={() => setOpen((value) => !value)} aria-expanded={open}>{open ? "收起" : "配置"}</button>
      {status?.state === "configured" && <button type="button" className={button} disabled={busy} onClick={() => { setBusy(true); void (async () => { try { setStatus(parseStatus(await call({ op: "clear" }))); setError(""); } catch (caught) { setError(caught instanceof Error ? caught.message : "Provider 解除失败"); } finally { setBusy(false); } })(); }}>解除</button>}
    </div>
    {error && <p role="alert" className="mx-auto mt-1 max-w-[820px] break-words text-xs text-[#ad4545]">{error}</p>}
    {open && <div className="mx-auto mt-2 max-w-[820px] min-w-0 space-y-2">
      {status && status.profiles.length > 0 && <ul className="space-y-1 text-xs">{status.profiles.map((profile) => <li key={profile.id} className="flex min-w-0 flex-wrap items-center gap-2 border border-line px-2 py-1">
        <span className="min-w-0 flex-1 truncate">{profile.name} · {profile.modelId} · 第 {profile.generation} 代{profile.credentialAvailable ? "" : " · 凭据缺失"}</span>
        <button type="button" className={button} disabled={busy || (status.profileId === profile.id && status.state === "configured")} onClick={() => { setBusy(true); void (async () => { try { setStatus(parseStatus(await call({ op: "select", profileId: profile.id }))); setError(""); } catch (caught) { await run({ op: "list" }); setError(caught instanceof Error ? caught.message : "Provider 选择失败"); } finally { setBusy(false); } })(); }}>选用</button>
        <button type="button" className={button} onClick={() => edit(profile)}>编辑</button>
        <button type="button" className={button} disabled={busy} onClick={() => { setBusy(true); void (async () => { try { setStatus(parseStatus(await call({ op: "remove", profileId: profile.id }))); setError(""); } catch (caught) { setError(caught instanceof Error ? caught.message : "Provider 删除失败"); } finally { setBusy(false); } })(); }}>删除</button>
      </li>)}</ul>}
      <form onSubmit={submit} className="grid min-w-0 grid-cols-2 gap-2 text-xs">
        <label className="min-w-0 col-span-2">名称<input className={`${field} w-full`} value={draft.name} maxLength={128} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="min-w-0 col-span-2">接口地址（https，或本机 127.0.0.1 / [::1]）<input className={`${field} w-full`} value={draft.baseUrl} maxLength={2048} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://models.example.test/v1" /></label>
        <label className="min-w-0">模型<input className={`${field} w-full`} value={draft.modelId} maxLength={100} onChange={(event) => setDraft({ ...draft, modelId: event.target.value })} /></label>
        <label className="min-w-0">凭据引用名<input className={`${field} w-full`} value={draft.authRef} maxLength={100} onChange={(event) => setDraft({ ...draft, authRef: event.target.value })} placeholder="PIDOCK_PROVIDER_MAIN" /></label>
        <label className="min-w-0">上下文窗口<input className={`${field} w-full`} inputMode="numeric" value={draft.contextWindow} onChange={(event) => setDraft({ ...draft, contextWindow: event.target.value })} /></label>
        <label className="min-w-0">最大输出<input className={`${field} w-full`} inputMode="numeric" value={draft.maxTokens} onChange={(event) => setDraft({ ...draft, maxTokens: event.target.value })} /></label>
        <p className="col-span-2 text-muted">此处只保存引用名，不保存密钥；密钥由本机环境变量提供，只有 main 会读取它。</p>
        <div className="col-span-2 flex gap-2">
          <button type="submit" className={button} disabled={busy || !draft.name.trim() || !draft.baseUrl.trim() || !draft.modelId.trim() || !/^PIDOCK_PROVIDER_[A-Z0-9_]{1,64}$/.test(draft.authRef.trim())}>保存并选用</button>
          {draft.id !== undefined && <button type="button" className={button} onClick={() => setDraft(empty)}>新建一份</button>}
        </div>
      </form>
      {pending && status?.state === "not-configured" && <p className="text-xs text-muted">未配置时发送消息会失败并说明原因，不会改用其它模型。</p>}
    </div>}
  </section>;
}
