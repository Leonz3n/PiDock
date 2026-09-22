import { useState } from "react";
import { Badge, Button, Panel, Segmented } from "../components/ui";
import { useHostStore } from "../stores/host";
import { useUiStore } from "../stores/ui";

const REMOTE_MODES = {
  tailscale: { label: "Tailscale 私有访问", hint: "手机需安装并连接 Tailscale；PiDock Host 仅监听 127.0.0.1。", recommended: true },
  gateway: { label: "自建 Gateway", hint: "主机主动建立出站 WSS；不开放本机入站端口。", recommended: false },
  funnel: { label: "Funnel 公网入口", hint: "实验性：URL 对互联网公开，不默认开启。", recommended: false },
} as const;

const REMOTE_PERMISSIONS = [
  { key: "overview", title: "查看项目、任务和运行状态", detail: "只读", defaultOn: true },
  { key: "chat", title: "查看对话并发送消息", detail: "消息会进入原会话", defaultOn: true },
  { key: "manage", title: "暂停任务、归档与启停服务", detail: "每次敏感操作再次确认", defaultOn: false },
  { key: "files", title: "查看文件和差异", detail: "默认关闭", defaultOn: false },
  { key: "terminal", title: "远程终端", detail: "高风险 · 默认关闭", defaultOn: false },
] as const;

export function RemotePage() {
  const workspace = useHostStore((state) => state.workspace);
  const devices = workspace?.devices ?? [];
  const revokeDevice = useHostStore((state) => state.revokeDevice);
  const openModal = useUiStore((state) => state.openModal);
  const pushToast = useUiStore((state) => state.pushToast);
  // The prototype keeps the selected entry mode and device permissions in page
  // memory only; no connection is attempted.
  const [mode, setMode] = useState<keyof typeof REMOTE_MODES>("tailscale");
  const [permissions, setPermissions] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(REMOTE_PERMISSIONS.map((item) => [item.key, item.defaultOn])),
  );

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-base font-medium text-ink">远程访问</h1>
          <p className="mt-1 text-xs text-muted">
            主机主动连接远程访问入口，远程设备不直接连接本机监听端口；每台设备拥有可单独撤销的身份与权限。
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => openModal({ type: "remote-preview" })}>
            手机视图
          </Button>
          <Button size="sm" variant="primary" onClick={() => openModal({ type: "pair-device" })}>
            配对设备
          </Button>
        </div>
      </header>

      <Panel title="入口方式">
        <Segmented
          ariaLabel="远程入口方式"
          value={mode}
          onChange={(value) => setMode(value as keyof typeof REMOTE_MODES)}
          options={Object.entries(REMOTE_MODES).map(([value, item]) => ({ value, label: item.label }))}
        />
        <p className="mt-2 text-xs text-muted">
          {REMOTE_MODES[mode].hint}
          {REMOTE_MODES[mode].recommended ? " 首版推荐方案。" : ""}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => pushToast(`已重新检测「${REMOTE_MODES[mode].label}」（内存模拟）；未执行真实命令`)}
          >
            重新检测
          </Button>
          <code className="rounded bg-soft px-2 py-1 text-[11px]">
            {mode === "tailscale" ? "tailscale serve --bg 127.0.0.1:4318" : mode === "funnel" ? "tailscale funnel --bg 127.0.0.1:4318" : "wss://gateway.example.com"}
          </code>
        </div>
        <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-4 text-xs text-muted">
          <li>入口不放宽本机权限；不直接暴露 Pi RPC 或本机端口。</li>
          <li>Funnel 仅作为实验性公网入口，不默认开启。</li>
        </ul>
      </Panel>

      <Panel title="移动端允许的操作" actions={<Badge>设备级授权 · 内存模拟</Badge>}>
        <ul className="flex flex-col gap-2">
          {REMOTE_PERMISSIONS.map((item) => (
            <li key={item.key}>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  aria-label={item.title}
                  checked={Boolean(permissions[item.key])}
                  onChange={(event) => setPermissions((items) => ({ ...items, [item.key]: event.target.checked }))}
                />
                <span>
                  <strong className="block text-ink">{item.title}</strong>
                  <small className="text-muted">{item.detail}</small>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-muted">
          会话权限、任务执行权、共享模板确认和浏览器接管规则不因远程访问放宽。
        </p>
      </Panel>

      <Panel title="已配对设备">
        <ul className="flex flex-col gap-2">
          {devices.map((device) => (
            <li key={device.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2.5 text-xs">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-ink">{device.name}</span>
                  <Badge tone={device.status === "active" ? "accent" : "neutral"}>{device.status === "active" ? "有效" : "已撤销"}</Badge>
                </div>
                <p className="mt-1 text-muted">
                  配对 {device.pairedAt.slice(0, 16).replace("T", " ")} · 最近在线 {device.lastSeen.slice(0, 16).replace("T", " ")} · 权限 {device.permissions.join(" / ")}
                </p>
              </div>
              <Button size="sm" disabled={device.status === "revoked"} onClick={() => void revokeDevice(device.id)}>
                撤销设备
              </Button>
            </li>
          ))}
        </ul>
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="移动端范围">
          <ul className="flex list-disc flex-col gap-1.5 pl-4 text-xs text-muted">
            <li>可查看项目、任务、会话与运行状态，并进行受限对话与轻量管理。</li>
            <li>移动端复用领域类型与适用组件，不携带桌面桥接与本机文件 API。</li>
            <li>移动布局按手机工作流设计，不直接缩小桌面工具区。</li>
          </ul>
        </Panel>
      </div>

      <p className="text-[11px] text-muted">
        配对凭据为一次性短时证明，成功配对后换取独立设备凭据；二维码不编码长期令牌或本机敏感状态。真实配对协议在 19 中实现。
      </p>
    </div>
  );
}
