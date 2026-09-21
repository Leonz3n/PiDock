import { Badge, Button, Panel } from "../components/ui";
import { useHostStore } from "../stores/host";
import { useUiStore } from "../stores/ui";

export function RemotePage() {
  const workspace = useHostStore((state) => state.workspace);
  const devices = workspace?.devices ?? [];
  const revokeDevice = useHostStore((state) => state.revokeDevice);
  const openModal = useUiStore((state) => state.openModal);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-base font-medium text-ink">远程访问</h1>
          <p className="mt-1 text-xs text-muted">
            主机主动连接远程访问入口，远程设备不直接连接本机监听端口；每台设备拥有可单独撤销的身份与权限。
          </p>
        </div>
        <Button size="sm" variant="primary" onClick={() => openModal({ type: "pair-device" })}>
          配对设备
        </Button>
      </header>

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
        <Panel title="入口方式">
          <ul className="flex list-disc flex-col gap-1.5 pl-4 text-xs text-muted">
            <li>首选 Tailscale 私有访问；保留自建 PiDock Gateway，主机主动连接。</li>
            <li>Funnel 仅作为实验性公网入口，不默认开启。</li>
            <li>入口不放宽本机权限；不直接暴露 Pi RPC 或本机端口。</li>
          </ul>
        </Panel>
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
