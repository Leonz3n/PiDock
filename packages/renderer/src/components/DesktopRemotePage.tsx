import { useEffect, useState } from "react";
import { remoteStateThroughShell } from "../data/shellBridge";
import { remoteStateFromHost, type RemoteView } from "../data/desktopRemote";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Icon } from "./Icon";

type Task = { taskId: string; name: string };
const modes: { id: RemoteView["mode"]; label: string; icon: "shield" | "server" | "globe" }[] = [
  { id: "tailscale", label: "Tailscale 私有访问", icon: "shield" },
  { id: "gateway", label: "自建 Gateway", icon: "server" },
  { id: "funnel", label: "Funnel", icon: "globe" },
];
const status = { "pending-confirmation": "待本机确认", active: "已授权", revoked: "已撤销" };

export function DesktopRemotePage({ tasks, lifecyclePending, lifecycleErrors }: {
  tasks: readonly Task[]; lifecyclePending: boolean; lifecycleErrors: readonly string[];
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<RemoteView | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const taskId = tasks.some((task) => task.taskId === chosen) ? chosen : tasks[0]?.taskId ?? null;
  const currentView = loadedFor === taskId ? view : null;
  useEffect(() => {
    if (lifecyclePending || !taskId) { setView(null); setLoadedFor(null); return; }
    let live = true;
    setView(null);
    setLoadedFor(null);
    setError("");
    void remoteStateThroughShell(taskId).then((result) => {
      if (!live) return;
      if (!result.ok) { setLoadedFor(taskId); setError(result.error ?? "远程状态读取失败"); return; }
      const parsed = remoteStateFromHost(result.payload);
      if (!parsed) { setLoadedFor(taskId); setError("Host 远程状态响应无法解析"); return; }
      setLoadedFor(taskId);
      setView(parsed);
    });
    return () => { live = false; };
  }, [taskId, lifecyclePending, revision]);
  return <div data-testid="desktop-remote-page" className="px-[34px] py-[30px] below-narrow:px-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[10px] uppercase tracking-[1.8px] text-[#95979c]">Remote access</p><h1 className="mt-1.5 text-[26px] font-semibold text-ink">远程访问</h1></div><div className="flex gap-2"><Badge variant="soft">任务级状态</Badge><Button type="button" size="sm" variant="outline" onClick={() => setRevision((value) => value + 1)}>刷新</Button></div></div>
    <p className="mt-1.5 text-xs text-muted">选择任务查看其远程入口与设备授权。此页只读；配对、撤销及入口切换尚未接线。</p>
    <div className="mt-5 flex items-center gap-2"><label htmlFor="desktop-remote-task" className="text-xs text-muted">任务</label><select id="desktop-remote-task" value={taskId ?? ""} disabled={lifecyclePending || !tasks.length} onChange={(event) => setChosen(event.target.value)} className="min-h-8 max-w-full rounded-[4px] border border-line bg-paper px-2 text-xs text-ink">{!tasks.length && <option value="">没有已核验的活动任务</option>}{tasks.map((task) => <option key={task.taskId} value={task.taskId}>{task.name}</option>)}</select></div>
    {lifecycleErrors.length > 0 && <p role="alert" className="mt-4 border border-[#e0b4b4] bg-[#fdf3f3] p-3 text-xs text-[#ad4545]">部分任务归档状态无法核验，任务列表可能不完整：{lifecycleErrors.join("；")}</p>}
    {lifecyclePending ? <p role="status" className="mt-5 text-xs text-muted">正在核验任务…</p> : !taskId ? <p className="mt-5 text-xs text-muted">没有已核验的活动任务；未读取远程状态。</p> : loadedFor === taskId && error ? <p role="alert" className="mt-5 border border-[#e0b4b4] bg-[#fdf3f3] p-3 text-xs text-[#ad4545]">{error}</p> : !currentView ? <p role="status" className="mt-5 text-xs text-muted">正在读取任务远程状态…</p> : <>
      <div className="mt-6 grid grid-cols-1 gap-2 below-narrow:grid-cols-1 min-[980px]:grid-cols-3">{modes.map((item) => <div key={item.id} className={`border p-3 ${currentView.mode === item.id ? "border-primary bg-paper" : "border-line bg-soft"}`}><div className="flex items-center gap-2 text-xs font-semibold"><Icon name={item.icon} />{item.label}</div><p className="mt-1 text-[11px] text-muted">{currentView.mode === item.id ? currentView.hint : "未选择 · 切换未接线"}</p>{currentView.mode === item.id && <Badge variant="soft" className="mt-2">当前任务入口</Badge>}</div>)}</div>
      {currentView.warning && <p className="mt-4 border border-[#dfc99f] bg-[#fff8e9] p-3 text-xs text-ink">{currentView.warning}</p>}
      <div className="mt-6 grid min-w-0 gap-7 min-[980px]:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <section className="min-w-0"><h2 className="text-sm font-semibold">{currentView.label}</h2><p className="mt-2 text-xs text-muted">{currentView.mode === "gateway" ? `Gateway：${currentView.gateway.status === "online" ? "在线" : currentView.gateway.status === "connecting" ? "连接中" : "离线"}` : "入口连接状态未接线；Gateway 状态不代表 Tailscale 或 Funnel 可用"}</p><p className="mt-3 break-all font-mono text-[11px] text-muted">{currentView.mode === "gateway" ? currentView.gateway.endpoint || "Gateway 地址未配置" : currentView.baseUrl || "入口地址未配置"}</p>{currentView.gateway.lastError && currentView.mode === "gateway" && <p role="alert" className="mt-2 text-xs text-[#ad4545]">{currentView.gateway.lastError}</p>}<Button type="button" disabled className="mt-4" title="启用与断开入口尚未接线">启用此入口</Button><h3 className="mt-8 text-xs font-semibold">移动端允许的操作</h3><p className="mt-2 text-xs text-muted">授权按设备保存；此页不提供全局权限开关。</p></section>
        <section className="min-w-0"><div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">设备与授权</h2><Button type="button" size="sm" variant="outline" disabled title="配对与本机确认流程未接线"><Icon name="plus" />扫码添加</Button></div><ul className="mt-3 border-t border-line">{currentView.devices.map((device) => <li key={device.id} data-remote-device={device.id} className="border-b border-line py-3 text-xs"><div className="flex items-center justify-between gap-2"><strong className="break-words">{device.name}</strong><Badge variant="soft">{status[device.status]}{device.online && device.status === "active" ? " · 在线" : ""}</Badge></div><p className="mt-1 break-words text-[11px] text-muted">{device.permissions.length ? device.permissions.join(" · ") : "无权限"}{device.lastSeenAt ? ` · 上次活动 ${device.lastSeenAt}` : ""}</p></li>)}{!currentView.devices.length && <li className="py-4 text-xs text-muted">该任务尚无已登记设备。</li>}</ul><p className="mt-5 text-xs text-muted">远程操作仍受本机约束；会话权限、任务执行权和浏览器接管规则不因远程访问放宽。</p></section>
      </div>
    </>}
  </div>;
}
