import { useState } from "react";
import { Badge, Button, Panel, Segmented } from "../components/ui";
import {
  REMOTE_ENTRY_ROWS,
  REMOTE_PERMISSION_ROWS,
  REMOTE_GATEWAY_STATUS_LABELS,
  canConfirmDevice,
  canRejectDevice,
  canRotateDevice,
  canRevokeDevice,
  remoteDeviceCredentialText,
  remoteDevicePermissionText,
  remoteDeviceSeenText,
  remoteDeviceStatusLabel,
  remoteDeviceStatusTone,
  remoteEntryRow,
  remoteEntryWarningText,
  remotePairingExpiryText,
  remotePairingIsLive,
} from "../data/remoteRules";
import type { RemoteDevice, RemoteDevicePermission, RemoteEntryMode } from "../data/types";
import { useHostStore } from "../stores/host";
import { useUiStore } from "../stores/ui";

export function RemotePage() {
  const workspace = useHostStore((state) => state.workspace);
  const devices = workspace?.devices ?? [];
  const entry = workspace?.remoteEntry;
  const pairing = workspace?.remotePairing ?? null;
  const audits = workspace?.remoteAudits ?? [];
  const setRemoteEntryMode = useHostStore((state) => state.setRemoteEntryMode);
  const mintRemotePairing = useHostStore((state) => state.mintRemotePairing);
  const cancelRemotePairing = useHostStore((state) => state.cancelRemotePairing);
  const confirmRemoteDevice = useHostStore((state) => state.confirmRemoteDevice);
  const rejectRemoteDevice = useHostStore((state) => state.rejectRemoteDevice);
  const rotateRemoteDevice = useHostStore((state) => state.rotateRemoteDevice);
  const revokeDevice = useHostStore((state) => state.revokeDevice);
  const openModal = useUiStore((state) => state.openModal);
  const pushToast = useUiStore((state) => state.pushToast);
  const [now] = useState(() => new Date().toISOString());

  const mode = entry?.mode ?? "tailscale";
  const row = remoteEntryRow(mode);
  const warning = remoteEntryWarningText(mode);
  const live = remotePairingIsLive(pairing, now);

  async function switchMode(next: RemoteEntryMode) {
    await setRemoteEntryMode(next);
    pushToast(`已切换到「${remoteEntryRow(next).label}」；旧连接不再复用`);
  }

  async function mintPairing() {
    const minted = await mintRemotePairing();
    pushToast(`已生成一次性配对凭据（${minted.credentialId}），10 分钟内有效`);
  }

  async function approveDevice(device: RemoteDevice) {
    // Requested permissions are shown first; 文件／终端请求默认不授予（默认关闭）.
    const narrowed = device.permissions.filter((permission) => permission !== "files" && permission !== "terminal");
    await confirmRemoteDevice(device.id, narrowed);
    pushToast(`已确认设备「${device.name}」，权限 ${narrowed.length === 0 ? "无" : narrowed.join(" / ")}`);
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-base font-medium text-ink">远程访问</h1>
          <p className="mt-1 text-xs text-muted">
            主机主动连接远程访问入口，远程设备不直接连接本机监听端口；每台设备单独确认、轮换与撤销，远程不新增绕过桌面的控制面。
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

      <Panel title="入口方式" actions={<Badge tone={row.experimental ? "warn" : "neutral"}>{row.experimental ? "实验入口" : "正式入口"}</Badge>}>
        <Segmented
          ariaLabel="远程入口方式"
          value={mode}
          onChange={(value) => void switchMode(value as RemoteEntryMode)}
          options={REMOTE_ENTRY_ROWS.map((item) => ({ value: item.mode, label: item.label }))}
        />
        <p className="mt-2 text-xs text-muted">{row.hint}</p>
        {warning === undefined ? null : <p className="mt-1 text-xs text-warn">{warning}</p>}
        <dl className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-muted">Host 监听</dt>
            <dd className="text-ink">{entry?.listener ?? "127.0.0.1:4318"}</dd>
          </div>
          <div>
            <dt className="text-muted">入口地址</dt>
            <dd className="text-ink">{entry?.baseUrl ?? "未配置"}</dd>
          </div>
          <div>
            <dt className="text-muted">Gateway</dt>
            <dd className="text-ink">
              {entry?.gateway.endpoint || "未使用"} · {REMOTE_GATEWAY_STATUS_LABELS[entry?.gateway.status ?? "offline"]}
            </dd>
          </div>
          <div>
            <dt className="text-muted">主机身份</dt>
            <dd className="text-ink">{entry?.gateway.hostId || "未配置"}</dd>
          </div>
        </dl>
        <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-4 text-xs text-muted">
          <li>Host 只监听回环地址；不直接暴露 Pi RPC，也不代理任意 TCP。</li>
          <li>网络可达不等于授权成功：每台设备仍需桌面确认并持有对应权限。</li>
        </ul>
      </Panel>

      {pairing !== null && pairing.state === "pending" ? (
        <Panel
          title="配对二维码"
          actions={<Badge tone={live ? "accent" : "neutral"}>{live ? "有效" : "已失效"}</Badge>}
        >
          <p className="text-xs text-muted">
            凭据一次性、短时（10 分钟），只放在链接的 fragment 中；不编码长期令牌、项目名称或本机路径。手机扫码后仍需在本机确认设备名称与权限。
          </p>
          <code className="mt-2 block break-all rounded bg-soft px-2 py-1.5 text-[11px] text-ink">{pairing.url}</code>
          <p className="mt-2 text-xs text-muted">
            凭据 {pairing.credentialId} · {remotePairingExpiryText(pairing, now)}
          </p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={() => void mintPairing()}>
              重新生成（旧码立即失效）
            </Button>
            <Button
              size="sm"
              onClick={() => {
                void cancelRemotePairing();
              }}
            >
              关闭并作废
            </Button>
          </div>
        </Panel>
      ) : null}

      <Panel title="移动端允许的操作" actions={<Badge>设备级授权 · 由 Host 裁决</Badge>}>
        <ul className="flex flex-col gap-2">
          {REMOTE_PERMISSION_ROWS.map((item) => (
            <li key={item.permission} className="text-xs">
              <strong className="block text-ink">{item.label}</strong>
              <small className="text-muted">
                {item.detail} · {item.defaultOn ? "默认开启" : "默认关闭"}
                {item.perActionConfirmation ? " · 每次操作再次确认" : ""}
              </small>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-muted">
          会话权限、任务写锁、共享模板确认和浏览器接管规则不因远程访问放宽；远程会话权限只会更窄。
        </p>
      </Panel>

      <Panel title="已配对设备" actions={<Badge>{`${devices.filter((device) => device.status === "active").length} / ${devices.length} 有效`}</Badge>}>
        <ul className="flex flex-col gap-2">
          {devices.map((device) => (
            <li key={device.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2.5 text-xs">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-ink">{device.name}</span>
                  <Badge tone={remoteDeviceStatusTone(device)}>{remoteDeviceStatusLabel(device)}</Badge>
                </div>
                <p className="mt-1 text-muted">
                  权限 {remoteDevicePermissionText(device)} · {remoteDeviceCredentialText(device)} · {remoteDeviceSeenText(device)}
                </p>
                {device.status === "pending-confirmation" ? (
                  <p className="mt-1 text-warn">请求权限后等待本机确认；确认前不能查看或操作任何任务。</p>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                {canConfirmDevice(device) ? (
                  <Button size="sm" variant="primary" onClick={() => void approveDevice(device)}>
                    确认并收窄权限
                  </Button>
                ) : null}
                {canRejectDevice(device) ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      void rejectRemoteDevice(device.id);
                      pushToast(`已拒绝设备「${device.name}」`);
                    }}
                  >
                    拒绝
                  </Button>
                ) : null}
                {canRotateDevice(device) ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      void rotateRemoteDevice(device.id);
                      pushToast(`已轮换「${device.name}」的设备凭据，旧凭据立即失效`);
                    }}
                  >
                    轮换凭据
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  disabled={!canRevokeDevice(device)}
                  onClick={() => {
                    void revokeDevice(device.id);
                    pushToast(`已撤销「${device.name}」，现有连接与后续请求均失效`);
                  }}
                >
                  撤销设备
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="安全审计">
        {audits.length === 0 ? (
          <p className="text-xs text-muted">还没有远程访问事件。</p>
        ) : (
          <ul className="flex flex-col gap-1.5 text-xs">
            {[...audits].reverse().map((audit) => (
              <li key={audit.id} className="flex flex-wrap gap-2">
                <span className="text-muted">{audit.at.slice(0, 16).replace("T", " ")}</span>
                <span className="text-ink">{audit.detail}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[11px] text-muted">审计记录已脱敏：不含令牌、本机路径或原始载荷。</p>
      </Panel>

      <p className="text-[11px] text-muted">
        手机端只调用已声明的 Host 操作；配对凭据与设备凭据分开签发，撤销或轮换后旧值立即失效。真实 TLS、Tailscale Serve、Gateway 与手机浏览器未在本机运行。
      </p>
    </div>
  );
}

/** Exported for the pair-device modal: the permission rows it lists. */
export function remoteRequestedPermissionLabels(permissions: RemoteDevicePermission[]): string[] {
  return permissions.map((permission) => REMOTE_PERMISSION_ROWS.find((row) => row.permission === permission)?.label ?? permission);
}
