import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  EMPTY_MCP_DRAFT,
  MCP_EXPOSURES,
  MCP_EXPOSURE_TEXT,
  MCP_STATE_TEXT,
  MCP_TRANSPORTS,
  MCP_TRANSPORT_TEXT,
  draftFromView,
  draftRequest,
  mcpCall,
  parseMcpSaved,
  parseMcpStatus,
  parseMcpTest,
  type McpDraft,
  type McpServerView,
  type McpStatus,
  type McpTestResult,
} from "../data/mcpServers";

/**
 * [Pencil T15] issue 150 — 能力管理 · MCP (S09).
 *
 * The list is Pi's own native `mcp.json`, read through main's exact-key
 * `shell/mcpOp`: enabled/disabled/error is each entry's real stored state, and a
 * credential is shown only as a reference NAME (`$TOKEN`) because main never
 * reads its value back. A hand-written server is visible but read-only; only a
 * `pidock-mcp-<uuid>` row can be edited, toggled or removed.
 *
 * Every write states the same boundary: it edits the file, applies to the next
 * session, and does not mutate a session that is already open. Nothing here
 * reloads a running conversation, and no row is invented when the list fails.
 */

const field = "min-w-0 w-full border border-line bg-bg px-2 py-1.5 text-xs text-ink";
const label = "block text-[11px] font-medium text-muted";
const mono = "font-mono text-[10px] break-all";

const stateVariant = (state: McpServerView["state"]) => state === "error" ? "default" : state === "disabled" ? "outline" : "accent";

function transportText(view: McpServerView): string {
  if (view.transport === "invalid") return "传输无效";
  return view.transport === "http" ? "HTTP" : "stdio";
}

function refCount(view: McpServerView): number {
  return view.credentialRefs.env.length + view.credentialRefs.headers.length;
}

export function DesktopMcpPanel({ onCount }: { onCount?: (count: number | null) => void }) {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string>("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<McpDraft | null>(null);
  const [draftError, setDraftError] = useState("");
  const [tested, setTested] = useState<{ key: string; result: McpTestResult } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = parseMcpStatus(await mcpCall(window.pidock, { op: "list" }));
      setStatus(next);
      setError("");
      onCount?.(next.servers.length);
    } catch (caught) {
      setStatus(null);
      onCount?.(null);
      setError(caught instanceof Error ? caught.message : "MCP 清单不可用");
    }
  }, [onCount]);
  useEffect(() => { void reload(); }, [reload]);

  const act = async (key: string, request: Record<string, unknown>, done: string) => {
    setBusy(key);
    setNotice("");
    try {
      await mcpCall(window.pidock, request);
      setTested(null);
      setConfirming(null);
      setNotice(done);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "MCP 操作失败");
    } finally {
      setBusy("");
    }
  };

  const testSaved = async (view: McpServerView) => {
    setBusy(`test:${view.name}`);
    setTested(null);
    try {
      const result = parseMcpTest(await mcpCall(window.pidock, { op: "test", name: view.name }));
      setTested({ key: view.name, result });
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "连接测试失败");
    } finally {
      setBusy("");
    }
  };

  const testDraft = async () => {
    if (!draft) return;
    setBusy("test:draft");
    setTested(null);
    setDraftError("");
    try {
      const request = draftRequest(draft);
      const result = parseMcpTest(await mcpCall(window.pidock, { op: "test", input: request.input }));
      setTested({ key: "draft", result });
    } catch (caught) {
      setDraftError(caught instanceof Error ? caught.message : "连接测试失败");
    } finally {
      setBusy("");
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setDraftError("");
    setBusy("save");
    try {
      const request = draftRequest(draft);
      const saved = parseMcpSaved(await mcpCall(window.pidock, { op: "save", ...request }));
      setDraft(null);
      setTested(null);
      setNotice(draft.name === null ? `已新增 ${saved.name}；新会话启动时生效` : `已保存 ${saved.name}；新会话启动时生效`);
      await reload();
    } catch (caught) {
      setDraftError(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setBusy("");
    }
  };

  if (draft) {
    return <McpForm draft={draft} setDraft={setDraft} draftError={draftError} tested={tested?.key === "draft" ? tested.result : null}
      busy={busy} onTest={() => void testDraft()} onSave={save} onCancel={() => { setDraft(null); setDraftError(""); setTested(null); }} />;
  }

  return <section data-testid="capabilities-mcp" className="min-w-0">
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
      <div><p className="text-[10px] uppercase tracking-[1.8px] text-[#95979c]">Agent Capabilities</p>
        <h1 className="mt-1.5 text-[24px] font-semibold text-ink">MCP Servers</h1>
        <p className="mt-1 text-[11px] text-muted">Pi 原生 <span className="font-mono">mcp.json</span> · stdio 与 Streamable HTTP · 工具按暴露模式加载</p></div>
      <div className="flex items-center gap-2">
        <Badge variant="soft">{status === null ? "—" : `${status.servers.length} 个 Server`}</Badge>
        <Button type="button" size="sm" disabled={busy !== ""} onClick={() => { setDraft({ ...EMPTY_MCP_DRAFT }); setDraftError(""); setTested(null); setError(""); }}>新增 Server</Button>
      </div>
    </header>

    {error && <p role="alert" data-testid="mcp-error" className="mt-3 border border-line bg-soft px-3 py-2 text-xs text-[#ad4545]">{error}</p>}
    {notice && !error && <p role="status" className="mt-3 border border-line bg-soft px-3 py-2 text-xs text-muted">{notice}</p>}

    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border border-line bg-soft px-3 py-2">
      <p className="text-[11px] leading-5 text-muted"><span className="font-medium text-ink">会话边界：</span>{status?.sessionBoundary.note ?? "保存只修改 mcp.json，已打开的会话保持不变。"}</p>
      <Badge variant="outline">{status?.sessionBoundary.openSessionsMutated === false ? "不改动运行中的会话" : "边界未知"}</Badge>
    </div>

    <div className="mt-3 border border-line">
      <div className="grid grid-cols-[minmax(0,1fr)_90px_86px_70px_auto] items-center gap-2 border-b border-line bg-soft px-3 py-1.5 text-[10px] uppercase tracking-[1px] text-muted">
        <span>Server</span><span>传输</span><span>状态</span><span>工具暴露</span><span className="text-right">操作</span>
      </div>
      {status === null && !error && <p className="px-3 py-6 text-center text-xs text-muted">读取中…</p>}
      {status !== null && status.servers.length === 0 && <div data-testid="mcp-empty" className="px-3 py-6 text-center text-xs leading-5 text-muted">
        还没有 MCP Server。新增后写入 Pi 的原生 mcp.json；已打开的会话不会改变，新会话启动时才会连接。
      </div>}
      {status?.servers.map((view) => <div key={view.name} data-testid="mcp-row" data-state={view.state} className="border-b border-line px-3 py-2 last:border-b-0">
        <div className="grid grid-cols-[minmax(0,1fr)_90px_86px_70px_auto] items-center gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-1.5">
              <span className="break-all text-xs font-medium text-ink">{view.label ?? view.name}</span>
              {view.label && <span className={`${mono} text-muted`}>{view.name}</span>}
              {!view.managed && <Badge variant="outline">Pi 直接管理 · 只读</Badge>}
            </div>
            <p className={`${mono} mt-0.5 text-muted`}>
              {view.transport === "http" ? (view.url ?? "URL 缺失") : [view.command ?? "command 缺失", ...view.args].join(" ")}
            </p>
            <p className="mt-0.5 text-[10px] text-muted">
              凭据引用 {refCount(view) === 0 ? "无" : <span className="font-mono">{[...view.credentialRefs.env, ...view.credentialRefs.headers].join("、")}</span>}
              {refCount(view) > 0 ? "（只回显名称）" : ""}
              {view.timeout === null ? "" : ` · 超时 ${view.timeout}s`}
              {view.managed ? "" : " · 文件中的值原样保留"}
            </p>
            {view.error && <p role="alert" className="mt-0.5 text-[10px] text-[#ad4545]">{view.error.code}：{view.error.message}</p>}
          </div>
          <span className="text-[11px] text-muted">{transportText(view)}</span>
          <Badge variant={stateVariant(view.state)}>{MCP_STATE_TEXT[view.state]}</Badge>
          <span className="text-[10px] text-muted">{view.exposure}</span>
          <div className="flex flex-wrap justify-end gap-1">
            <Button type="button" size="sm" variant="outline" disabled={busy !== ""} onClick={() => void testSaved(view)}>{busy === `test:${view.name}` ? "测试中…" : "测试"}</Button>
            {view.managed && <>
              <Button type="button" size="sm" variant="ghost" disabled={busy !== ""} onClick={() => { setDraft(draftFromView(view)); setDraftError(""); setTested(null); setError(""); }}>编辑</Button>
              <Button type="button" size="sm" variant="ghost" disabled={busy !== ""} onClick={() => void act(`toggle:${view.name}`, { op: view.enabled ? "disable" : "enable", name: view.name }, view.enabled ? `已停用 ${view.name}；新会话不再加载它` : `已启用 ${view.name}；新会话启动时加载`)}>{view.enabled ? "停用" : "启用"}</Button>
              {confirming === view.name
                ? <span className="flex items-center gap-1"><Badge variant="default">确认删除 {view.name}？</Badge>
                  <Button type="button" size="sm" variant="destructive" disabled={busy !== ""} onClick={() => void act(`remove:${view.name}`, { op: "remove", name: view.name }, `已删除 ${view.name}`)}>确认</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(null)}>取消</Button></span>
                : <Button type="button" size="sm" variant="destructive" disabled={busy !== ""} onClick={() => setConfirming(view.name)}>删除</Button>}
            </>}
          </div>
        </div>
        {tested?.key === view.name && <TestResult result={tested.result} />}
      </div>)}
    </div>

    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted">
      <p className="break-all">真实文件：<span className="font-mono">{status?.path ?? "未知（main 未提供）"}</span></p>
      <p>不支持 legacy SSE；Extensions 页不在本版本范围。</p>
    </div>
  </section>;
}

function TestResult({ result }: { result: McpTestResult }) {
  return <div data-testid="mcp-test-result" data-state={result.state} className="mt-2 border border-line bg-soft px-2 py-1.5 text-[11px] leading-5">
    <p className="text-ink">
      {result.state === "connected" ? `连接成功 · ${result.tools.length} 个工具` : result.state === "disabled" ? "Server 已停用：未连接" : `连接失败 · ${result.error?.code ?? "unknown"}`}
      {typeof result.durationMs === "number" ? ` · ${result.durationMs}ms` : ""}
    </p>
    {result.error && <p className="text-[#ad4545]">{result.error.message}</p>}
    {result.tools.length > 0 && <ul className="mt-1 space-y-0.5">{result.tools.map((tool) => <li key={tool.name} className="break-all">
      <span className="font-mono text-ink">{tool.name}</span>{tool.readOnly ? <Badge variant="outline" className="ml-1">只读</Badge> : <Badge variant="soft" className="ml-1">需审批</Badge>}
      <span className="text-muted"> · {tool.description}</span>
    </li>)}</ul>}
    {Array.isArray(result.credentialRefs) && result.credentialRefs.length > 0 && <p className="text-muted">引用：{result.credentialRefs.join("、")}（仅名称）</p>}
  </div>;
}

function McpForm({ draft, setDraft, draftError, tested, busy, onTest, onSave, onCancel }: {
  draft: McpDraft;
  setDraft: (draft: McpDraft) => void;
  draftError: string;
  tested: McpTestResult | null;
  busy: string;
  onTest: () => void;
  onSave: (event: FormEvent) => void;
  onCancel: () => void;
}) {
  const update = (patch: Partial<McpDraft>) => setDraft({ ...draft, ...patch });
  return <section data-testid="capabilities-mcp-form" className="min-w-0">
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-3">
      <div><p className="text-[10px] uppercase tracking-[1.8px] text-[#95979c]">MCP Server</p>
        <h1 className="mt-1 text-[22px] font-semibold text-ink">{draft.name === null ? "新增 Server" : "编辑 Server"}</h1>
        <p className="mt-0.5 text-[11px] text-muted">{draft.name === null ? "由 PiDock 生成 pidock-mcp-&lt;uuid&gt; 名称并写入 mcp.json" : `PiDock 管理的 Server：${draft.name}`}</p></div>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>返回列表</Button>
    </header>
    <form onSubmit={onSave} className="mt-3 grid max-w-[760px] grid-cols-2 gap-x-3 gap-y-2.5 below-narrow:grid-cols-1">
      <div className="col-span-2"><label className={label} htmlFor="mcp-label">名称标签</label>
        <input id="mcp-label" className={field} value={draft.description} maxLength={200} placeholder="例如：本地文档工具（只用于列表显示）" onChange={(event) => update({ description: event.target.value })} /></div>
      <div><label className={label} htmlFor="mcp-transport">传输</label>
        <select id="mcp-transport" className={field} value={draft.transport} onChange={(event) => update({ transport: event.target.value === "http" ? "http" : "stdio" })}>
          {MCP_TRANSPORTS.map((transport) => <option key={transport} value={transport}>{MCP_TRANSPORT_TEXT[transport]}</option>)}
        </select></div>
      <div><label className={label} htmlFor="mcp-exposure">工具暴露</label>
        <select id="mcp-exposure" className={field} value={draft.exposure} onChange={(event) => update({ exposure: event.target.value as McpDraft["exposure"] })}>
          {MCP_EXPOSURES.map((exposure) => <option key={exposure} value={exposure}>{MCP_EXPOSURE_TEXT[exposure]}</option>)}
        </select>
        <p className="mt-1 text-[10px] leading-4 text-muted">direct 会把工具直接声明给模型；hidden 只注册。codemode / deferred 依赖 Pi 的 codemode / tool_search 扩展，本会话不加载。</p></div>

      {draft.transport === "stdio" ? <>
        <div className="col-span-2"><label className={label} htmlFor="mcp-command">command（单个可执行程序）</label>
          <input id="mcp-command" className={field} value={draft.command} placeholder="node" onChange={(event) => update({ command: event.target.value })} /></div>
        <div><label className={label} htmlFor="mcp-args">args（每行一个）</label>
          <textarea id="mcp-args" className={`${field} h-[64px] font-mono`} value={draft.argsText} onChange={(event) => update({ argsText: event.target.value })} /></div>
        <div><label className={label} htmlFor="mcp-cwd">cwd（可选，相对会话目录）</label>
          <input id="mcp-cwd" className={field} value={draft.cwd} placeholder="." onChange={(event) => update({ cwd: event.target.value })} /></div>
        <div className="col-span-2"><label className={label} htmlFor="mcp-env">环境变量引用（每行 NAME=$VAR，也支持大括号写法）</label>
          <textarea id="mcp-env" className={`${field} h-[64px] font-mono`} value={draft.envText} placeholder="TOKEN=$MCP_TOKEN" onChange={(event) => update({ envText: event.target.value })} />
          <p className="mt-1 text-[10px] text-muted">只保存引用，不保存明文；编辑时留空表示保持原引用。</p></div>
      </> : <>
        <div className="col-span-2"><label className={label} htmlFor="mcp-url">URL（http / https）</label>
          <input id="mcp-url" className={field} value={draft.url} placeholder="https://example.com/mcp" onChange={(event) => update({ url: event.target.value })} /></div>
        <div className="col-span-2"><label className={label} htmlFor="mcp-headers">Header 引用（每行 Name: 值）</label>
          <textarea id="mcp-headers" className={`${field} h-[64px] font-mono`} value={draft.headersText} placeholder="Authorization: Bearer ${MCP_TOKEN}" onChange={(event) => update({ headersText: event.target.value })} />
          <p className="mt-1 text-[10px] text-muted">明文字面值会被拒绝；编辑时留空表示保持原引用。</p></div>
      </>}

      <div><label className={label} htmlFor="mcp-timeout">超时（秒，1–600）</label>
        <input id="mcp-timeout" className={field} value={draft.timeout} inputMode="numeric" onChange={(event) => update({ timeout: event.target.value })} /></div>
      <div className="flex items-end gap-2">
        <Button type="button" variant="outline" disabled={busy !== ""} onClick={onTest}>{busy === "test:draft" ? "测试中…" : "测试连接"}</Button>
        <Button type="submit" disabled={busy !== ""}>{busy === "save" ? "保存中…" : "保存"}</Button>
      </div>
      {draftError && <p role="alert" className="col-span-2 border border-line bg-soft px-2 py-1.5 text-[11px] text-[#ad4545]">{draftError}</p>}
      {tested && <div className="col-span-2">{<TestResult result={tested} />}</div>}
      <p className="col-span-2 text-[10px] leading-5 text-muted">保存只写文件，不会重连或改动任何已打开的会话；新会话启动时读取这份配置。名称与目录由 main 决定，本表单不能指定文件路径。</p>
    </form>
  </section>;
}
