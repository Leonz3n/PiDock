import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  EMPTY_PROVIDER_DRAFT,
  PROVIDER_STATE_TEXT,
  parseProviderStatus,
  providerCall,
  savedProviderId,
  type ProviderDraft,
  type ProviderStatus,
  type ProviderView,
} from "../data/providerProfile";

const field = "min-w-0 w-full border border-line bg-bg px-2 py-1 text-xs";

/**
 * [UI 对齐 S8e] #47 `模型与 Provider` 页面，结构照 `prototypes/pidock-ui/app.js`
 * 的 `providersPage()`：view-label `MODELS` + 标题 + 添加 Provider，一句说明，
 * 三列 Provider 卡片（协议 / 端点 / 模型 chip / 凭据可用性 / 编辑 · 选择模型），
 * 末尾一张「切换只影响当前会话」说明卡。
 *
 * 与原型不同、且必须不同的两处，因为这里是真实 Host：
 *
 * - 卡片上的「已启用 / 已停用」改成真实的安装状态（`PROVIDER_STATE_TEXT`），
 *   没有任务上下文时不会伪造「已启用」；
 * - 「凭据已设置」改成 main 解析引用后的真实可用性（`credentialAvailable`），
 *   界面仍然只处理引用名，永远不会渲染密钥内容。
 */
export function DesktopProvidersPage({
  taskId,
  taskName,
  onOpenTask,
  availableTasks,
}: {
  /** 当前打开的任务：选用是按任务记录的，没有任务时页面不假装能选用。 */
  taskId: string | null;
  taskName: string | null;
  /** 打开一个任务（从没有任务上下文的提示里进入）。 */
  onOpenTask: (taskId: string) => void;
  /** Real, already-loaded task list: the "no task context" state offers这些 instead of a fake selector. */
  availableTasks?: readonly { taskId: string; name: string }[];
}) {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [draft, setDraft] = useState<ProviderDraft>(EMPTY_PROVIDER_DRAFT);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const run = useCallback(async (request: Record<string, unknown>) => {
    if (!taskId) return;
    try {
      setStatus(parseProviderStatus(await providerCall(taskId, request)));
      setError("");
    } catch (caught) {
      setStatus(null);
      setError(caught instanceof Error ? caught.message : "Provider 配置不可用");
    }
  }, [taskId]);

  useEffect(() => {
    if (taskId) void run({ op: "list" });
  }, [taskId, run]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || !taskId) return;
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
        const savedId = savedProviderId(await providerCall(taskId, { op: "save", profile: input }));
        setStatus(parseProviderStatus(await providerCall(taskId, { op: "select", profileId: savedId })));
        setError("");
        setDraft(EMPTY_PROVIDER_DRAFT);
        setOpen(false);
      } catch (caught) {
        await run({ op: "list" });
        setError(caught instanceof Error ? caught.message : "Provider 保存失败");
      } finally {
        setBusy(false);
      }
    })();
  };

  const act = (request: Record<string, unknown>, failure: string) => {
    if (!taskId) return;
    setBusy(true);
    void (async () => {
      try {
        setStatus(parseProviderStatus(await providerCall(taskId, request)));
        setError("");
      } catch (caught) {
        await run({ op: "list" });
        setError(caught instanceof Error ? caught.message : failure);
      } finally {
        setBusy(false);
      }
    })();
  };

  const edit = (profile: ProviderView) => {
    setOpen(true);
    setDraft({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      modelId: profile.modelId,
      contextWindow: String(profile.contextWindow),
      maxTokens: String(profile.maxTokens),
      authRef: profile.authRef,
    });
  };

  const ready = draft.name.trim().length > 0 && draft.baseUrl.trim().length > 0 && draft.modelId.trim().length > 0;
  const valid = ready && /^PIDOCK_PROVIDER_[A-Z0-9_]{1,64}$/.test(draft.authRef.trim());

  return (
    <div className="px-[34px] py-[30px] below-narrow:px-5" data-testid="desktop-providers-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] tracking-[1.8px] text-[#95979c] uppercase">Models</p>
          <h1 className="mt-1.5 text-[26px] font-semibold tracking-[-0.6px] text-ink">模型与 Provider</h1>
        </div>
        <Button type="button" variant="default" disabled={!taskId} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          添加 Provider
        </Button>
      </div>
      <p className="mt-1.5 mb-6 text-xs text-muted">保存多个服务账号，在对话中按需切换。这里只保存凭据引用名，取值由本机环境变量提供。</p>

      {!taskId && (
        <section className="mb-5 border border-line bg-paper px-4 py-3" data-testid="providers-task-required">
          <p className="text-xs text-ink">选用 Provider 是按任务记录的：请先打开一个任务，再为它选择模型。</p>
          <p className="mt-1.5 text-[11px] text-muted">
            这是真实实现的范围——隔离上下文按任务创建，因此不存在「一次设置全局生效」。未打开任务时下面不会显示任何安装状态。
          </p>
          {availableTasks && availableTasks.length > 0 && (
            <p className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted">
              打开任务：
              {availableTasks.map((task) => (
                <Button key={task.taskId} type="button" size="sm" onClick={() => onOpenTask(task.taskId)}>
                  {task.name}
                </Button>
              ))}
            </p>
          )}
        </section>
      )}

      {taskId && (
        <p role="status" className="mb-4 break-words border border-line bg-paper px-3 py-2 text-xs text-ink" data-testid="providers-state">
          <span className="font-semibold">{taskName ?? taskId}</span>
          <span className="ml-2 text-muted">{status ? PROVIDER_STATE_TEXT[status.state] : "正在读取 Provider 配置"}</span>
        </p>
      )}
      {error && <p role="alert" className="mb-4 break-words border border-[#e0b4b4] bg-[#fdf3f3] px-3 py-2 text-xs text-[#ad4545]">{error}</p>}

      <div className="grid grid-cols-3 gap-4 below-wide:grid-cols-2 below-narrow:grid-cols-1">
        {(status?.profiles ?? []).map((profile) => {
          const selected = status?.profileId === profile.id && status.state === "configured";
          return (
            <article key={profile.id} className="min-w-0 rounded-[9px] border border-line bg-paper p-5" data-provider-card={profile.id}>
              <div className="flex items-start justify-between gap-2">
                <span aria-hidden className="grid h-8 w-8 place-items-center rounded-[7px] bg-soft text-sm text-[#61788d]">✳</span>
                <Badge variant={selected ? "accent" : "outline"}>{selected ? "当前任务已选用" : profile.credentialAvailable ? "可用" : "凭据缺失"}</Badge>
              </div>
              <h3 className="mt-3 text-[15px] font-semibold text-ink">{profile.name}</h3>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge>openai-chat-completions</Badge>
                <Badge>第 {profile.generation} 代</Badge>
              </div>
              <p className="mt-2.5 font-mono text-[11px] break-words text-muted" style={{ overflowWrap: "anywhere" }}>
                {profile.baseUrl}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge>{profile.modelId}</Badge>
                <Badge>{(profile.contextWindow / 1000).toFixed(0)}k 上下文</Badge>
                <Badge>最大输出 {profile.maxTokens}</Badge>
              </div>
              <p className="mt-2.5 text-[11px] text-muted">
                凭据引用 <span className="font-mono">{profile.authRef}</span> · {profile.credentialAvailable ? "该环境变量有取值" : "该环境变量没有取值"}
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <Button type="button" size="sm" onClick={() => edit(profile)}>
                  编辑
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={selected ? "secondary" : "default"}
                  disabled={busy || !taskId || selected}
                  onClick={() => act({ op: "select", profileId: profile.id }, "Provider 选择失败")}
                >
                  选择模型
                </Button>
              </div>
            </article>
          );
        })}
        {taskId && status && status.profiles.length === 0 && (
          <p className="text-xs text-muted" data-testid="providers-empty">
            还没有保存任何 Provider。添加后会在本机保存元数据，凭据仍只放在环境变量里。
          </p>
        )}
      </div>

      {taskId && status?.state === "configured" && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={busy} onClick={() => act({ op: "clear" }, "Provider 解除失败")}>
            解除当前任务的选用
          </Button>
          <span className="text-[11px] text-muted">解除后该任务的 SDK 回合会失败并说明原因，不会回退到本机其它凭据。</span>
        </div>
      )}

      {open && (
        <form onSubmit={submit} className="mt-6 min-w-0 rounded-[9px] border border-line bg-paper p-5" data-testid="provider-form">
          <h3 className="text-[13px] font-semibold text-ink">{draft.id === undefined ? "添加 Provider" : `编辑 ${draft.name}`}</h3>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs below-narrow:grid-cols-1">
            <label className="min-w-0 col-span-2 below-narrow:col-span-1">
              名称
              <input className={field} value={draft.name} maxLength={128} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </label>
            <label className="min-w-0 col-span-2 below-narrow:col-span-1">
              接口地址（https，或本机 127.0.0.1 / [::1]）
              <input className={field} value={draft.baseUrl} maxLength={2048} placeholder="https://models.example.test/v1" onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} />
            </label>
            <label className="min-w-0">
              模型
              <input className={field} value={draft.modelId} maxLength={100} onChange={(event) => setDraft({ ...draft, modelId: event.target.value })} />
            </label>
            <label className="min-w-0">
              凭据引用名
              <input className={field} value={draft.authRef} maxLength={100} placeholder="PIDOCK_PROVIDER_MAIN" onChange={(event) => setDraft({ ...draft, authRef: event.target.value })} />
            </label>
            <label className="min-w-0">
              上下文窗口
              <input className={field} inputMode="numeric" value={draft.contextWindow} onChange={(event) => setDraft({ ...draft, contextWindow: event.target.value })} />
            </label>
            <label className="min-w-0">
              最大输出
              <input className={field} inputMode="numeric" value={draft.maxTokens} onChange={(event) => setDraft({ ...draft, maxTokens: event.target.value })} />
            </label>
          </div>
          <p className="mt-2 text-[11px] text-muted">此处只保存引用名，不保存密钥；密钥由本机环境变量提供，只有 main 会读取它。</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="submit" variant="default" disabled={busy || !valid || !taskId}>
              保存并选用
            </Button>
            <Button type="button" onClick={() => { setOpen(false); setDraft(EMPTY_PROVIDER_DRAFT); }}>
              取消
            </Button>
            {draft.id !== undefined && (
              <Button type="button" onClick={() => setDraft(EMPTY_PROVIDER_DRAFT)}>
                新建一份
              </Button>
            )}
            {draft.id !== undefined && (
              <Button type="button" variant="destructive" disabled={busy || !taskId} onClick={() => act({ op: "remove", profileId: draft.id }, "Provider 删除失败")}>
                删除
              </Button>
            )}
          </div>
        </form>
      )}

      <section className="mt-4 rounded-[9px] border border-line bg-paper p-5">
        <h3 className="text-[13px] font-semibold text-ink">切换只影响当前会话</h3>
        <p className="mt-2 text-xs text-muted">
          保留对话历史与工具结果。执行中切换不会被接受；累计 Token 仍按实际调用的 Provider 记录。
        </p>
        <p className="mt-2 text-xs text-muted" data-testid="providers-rotation-limitation">
          已知限制：同一凭据引用名背后的取值轮换不会被检测——更换环境变量取值不改变已选端点或配置代际，也不会使既有会话绑定失效。
        </p>
      </section>
    </div>
  );
}
