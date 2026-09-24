import { useState } from "react";
import { Badge, Button, Panel } from "../components/ui";
import { Icon, type IconName } from "../components/Icon";
import { Card, PageIntro, PageTitle, ViewLabel } from "../components/Management";
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

/**
 * Prototype `remoteAccessPage()`'s mode glyphs
 * (`tailscale→shield`, `gateway→server`, `funnel→globe`).
 */
const MODE_ICON: Record<RemoteEntryMode, IconName> = { tailscale: "shield", gateway: "server", funnel: "globe" };

/**
 * Prototype `.remote-layout .card{border-radius:8px}`: the remote page's cards
 * are 8px, not the shared `.card` 10px. The `!` is load-bearing — `Card` ships
 * `rounded-panel` and which of the two declarations wins is decided by Tailwind's
 * property order, not by class order in the attribute ([UI 对齐 09] #33 P2-2,
 * the same trap S7a recorded for `bg-[#faf9f5]`).
 */
const REMOTE_CARD = "rounded-[8px]!";

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
  const refresh = useHostStore((state) => state.refresh);
  const [now] = useState(() => new Date().toISOString());

  const mode = entry?.mode ?? "tailscale";
  const row = remoteEntryRow(mode);
  const listener = entry?.listener ?? "127.0.0.1:4318";
  const warning = remoteEntryWarningText(mode);
  const live = remotePairingIsLive(pairing, now);
  // No real TLS/Gateway connection runs here, so the badge reads the state the
  // Host reported instead of claiming a live link.
  const connected = entry?.gateway.status === "online";

  async function switchMode(next: RemoteEntryMode) {
    await setRemoteEntryMode(next);
    pushToast(`已切换到「${remoteEntryRow(next).label}」；旧连接不再复用`);
  }

  async function mintPairing() {
    const minted = await mintRemotePairing();
    pushToast(`已生成一次性配对凭据（${minted.credentialId}），10 分钟内有效`);
  }

  /**
   * Prototype `remote…detect` re-reads the Host's reported entry instead of
   * probing the local machine (the prototype's own handler only admits it did
   * not detect anything). No new Host op: `refresh` already re-reads.\n   */
  async function redetect() {
    await refresh();
    const reported = useHostStore.getState().workspace?.remoteEntry;
    pushToast(`已重新读取 Host 上报：监听 ${reported?.listener ?? "未上报"} · ${reported?.gateway.status === "online" ? "远程入口已连接" : "尚未连接"}`);
  }

  async function approveDevice(device: RemoteDevice) {
    // Requested permissions are shown first; 文件／终端请求默认不授予（默认关闭）.
    const narrowed = device.permissions.filter((permission) => permission !== "files" && permission !== "terminal");
    await confirmRemoteDevice(device.id, narrowed);
    pushToast(`已确认设备「${device.name}」，权限 ${narrowed.length === 0 ? "无" : narrowed.join(" / ")}`);
  }

  return (
    <div className="flex flex-col gap-4" data-testid="remote-page">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <ViewLabel>REMOTE ACCESS</ViewLabel>
          <PageTitle>远程访问</PageTitle>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={connected ? "accent" : "neutral"}>{connected ? "远程入口已连接" : "尚未连接"}</Badge>
          <Button size="sm" onClick={() => openModal({ type: "remote-preview" })}>
            <Icon name="globe" />
            手机视图
          </Button>
        </div>
      </header>

      <PageIntro>选择私有网络、自建 Gateway 或实验性公网入口；三种模式共享同一套设备授权和 PiDock 领域权限。</PageIntro>

      <div
        role="tablist"
        aria-label="远程入口方式"
        className="remote-mode-picker grid grid-cols-3 gap-2.5 below-narrow:grid-cols-1"
        data-testid="remote-mode-picker"
      >
        {REMOTE_ENTRY_ROWS.map((item) => (
          <button
            key={item.mode}
            type="button"
            role="tab"
            aria-selected={mode === item.mode}
            aria-label={item.label}
            onClick={() => void switchMode(item.mode)}
            className={`relative grid grid-cols-[32px_minmax(0,1fr)] grid-rows-[auto_auto] items-center gap-x-2.5 rounded-[8px] border p-3 text-left ${
              mode === item.mode ? "border-[#9eabc8] bg-[#f7f8fc] shadow-[0_0_0_1px_#c9d0df]" : "border-line bg-paper"
            }`}
          >
            <span aria-hidden="true" className="row-span-2 grid h-8 w-8 place-items-center rounded-[7px] bg-[#f1f3f6] text-[#6a7892]">
              <Icon name={MODE_ICON[item.mode]} />
            </span>
            <strong className="text-[11px] text-ink">{item.label}</strong>
            <small className="text-[9px] text-muted">{item.hint}</small>
            {item.mode === "tailscale" ? <em className="absolute top-[7px] right-2 text-[8px] font-normal text-accent not-italic">推荐</em> : null}
            {item.experimental ? <em className="absolute top-[7px] right-2 text-[8px] font-normal text-warn not-italic">实验入口</em> : null}
          </button>
        ))}
      </div>

      <div className="remote-layout grid grid-cols-[minmax(0,1.55fr)_minmax(280px,0.75fr)] gap-[18px] below-mid:grid-cols-1">
        <section className="flex flex-col gap-[18px]">
          <Card className={`remote-connection ${REMOTE_CARD}`}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-[13px] font-[650] text-ink">{row.label}</h3>
                <small className="text-[11px] text-muted">{connected ? "最近心跳：刚刚" : "尚未建立连接，Host 未上报心跳"}</small>
              </div>
              <span aria-hidden="true" className={`status-orb h-3 w-3 rounded-full ${connected ? "bg-[#425a93] shadow-[0_0_0_5px_#eaedf3]" : "bg-[#b9bec6] shadow-[0_0_0_5px_#eef0f2]"}`} />
            </div>

            <div className="inline-notice remote-mode-note mt-3 flex flex-col gap-0.5 rounded-[7px] border border-[#e7e2d5] bg-[#fbf9f2] px-[13px] py-[10px] text-[11px] text-[#948257]">
              <strong className="text-[11px]">{row.requiresPeerClient ? "手机需安装并接入同一私有网络" : "手机用普通浏览器访问"}</strong>
              <span>{row.hint}</span>
            </div>
            {warning === undefined ? null : (
              <div className="remote-mode-note warn mt-2 flex flex-col gap-0.5 rounded-[7px] border border-[#ead7c1] bg-[#fcf6ee] px-[13px] py-[10px] text-[11px] text-[#946e41]">
                <strong className="text-[11px]">公网实验入口</strong>
                <span>{warning}</span>
              </div>
            )}

            <div className="connection-checks mt-3 overflow-hidden rounded-[7px] border border-line">
              <div className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-line px-3 py-2.5">
                <span className="dot inline-block h-[6px] w-[6px] shrink-0 rounded-full bg-[#9aa4ab]" />
                <span className="min-w-0">
                  <strong className="block text-[11px] text-ink">Host 监听</strong>
                  <small className="block text-[9px] text-muted [overflow-wrap:anywhere]">只监听回环地址，不暴露 Pi RPC，也不代理任意 TCP</small>
                </span>
                <span className="flex items-center gap-2">
                  <code className="mono font-mono text-[11px] text-ink">{listener}</code>
                  {/* Prototype `remoteConnectionPanel()` tailscale branch puts 重新检测
                      on this row. It re-reads what the Host reported — no Host op
                      probes the local Tailscale install. */}
                  {mode === "tailscale" ? (
                    <Button size="sm" onClick={() => void redetect()}>
                      重新检测
                    </Button>
                  ) : null}
                </span>
              </div>
              <div className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-line px-3 py-2.5">
                <span className="dot live inline-block h-[6px] w-[6px] shrink-0 rounded-full bg-[#425a93] shadow-[0_0_0_3px_#425a9312]" />
                <span className="min-w-0">
                  <strong className="block text-[11px] text-ink">入口地址</strong>
                  <small className="block text-[9px] text-muted [overflow-wrap:anywhere]">{row.publiclyReachable ? "对互联网公开，必须沿用完整登录与限流" : "仅在私有网络内可达"}</small>
                </span>
                <code className="mono font-mono text-[11px] text-ink">{entry?.baseUrl || "未配置"}</code>
              </div>
              <div className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-2.5">
                <span className="dot inline-block h-[6px] w-[6px] shrink-0 rounded-full bg-[#9aa4ab]" />
                <span className="min-w-0">
                  <strong className="block text-[11px] text-ink">Gateway</strong>
                  <small className="block text-[9px] text-muted [overflow-wrap:anywhere]">
                    {entry?.gateway.endpoint || "未使用"} · {REMOTE_GATEWAY_STATUS_LABELS[entry?.gateway.status ?? "offline"]}
                  </small>
                </span>
                <code className="mono font-mono text-[11px] text-ink">{entry?.gateway.hostId || "未配置"}</code>
              </div>
            </div>

            {/* Prototype `remoteConnectionPanel()`: tailscale and funnel print the
                local command with the listener the Host reports; gateway mode has
                no command and shows the request path instead. */}
            {mode === "gateway" ? (
              <>
                <div className="remote-flow mt-[18px] grid grid-cols-[1fr_18px_1fr_18px_1fr] items-center gap-[7px]">
                  <span className="rounded-[6px] border border-line bg-[#fafbfc] p-[9px] text-center text-[10px]">手机浏览器</span>
                  <Icon name="arrow" className="w-[13px] text-[#929aa7]" />
                  <span className="rounded-[6px] border border-line bg-[#fafbfc] p-[9px] text-center text-[10px]">自建 Gateway</span>
                  <Icon name="arrow" className="w-[13px] text-[#929aa7]" />
                  <span className="rounded-[6px] border border-line bg-[#fafbfc] p-[9px] text-center text-[10px]">本机 PiDock</span>
                </div>
                <div className="gateway-details mt-3 flex flex-wrap gap-2 text-[10px] text-muted">
                  <span className="rounded-[5px] border border-line bg-[#fafbfc] px-2 py-0.5">HTTPS / WSS</span>
                  <span className="rounded-[5px] border border-line bg-[#fafbfc] px-2 py-0.5">桌面主动连接</span>
                  <span className="rounded-[5px] border border-line bg-[#fafbfc] px-2 py-0.5">设备凭据可轮换</span>
                </div>
              </>
            ) : (
              <div className="command-preview mt-[18px]">
                <code className="mono block rounded-[6px] border border-[#e3e5eb] bg-[#fafbfc] px-[7px] py-[3px] font-mono text-[10px] text-[#425173]">
                  {mode === "tailscale" ? `tailscale serve --bg ${listener}` : `tailscale funnel --bg ${listener}`}
                </code>
              </div>
            )}

            <p className="note text-[10px] leading-[1.9] text-[#939c9f]">
              {mode === "gateway"
                ? "TLS · 出站 WSS · 不开放本机端口；网络可达不等于授权成功，每台设备仍需桌面确认并持有对应权限。"
                : mode === "tailscale"
                  ? "私有网络 HTTPS · 无需中继地址；Host 只监听回环，Serve/接入由本机网络配置提供。"
                  : "公网 HTTPS · 高风险操作仍需本机确认。"}
            </p>
          </Card>

          {pairing !== null && pairing.state === "pending" ? (
            <Card className={REMOTE_CARD}>
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-[13px] font-[650] text-ink">配对二维码</h3>
                <Badge tone={live ? "accent" : "neutral"}>{live ? "有效" : "已失效"}</Badge>
              </div>
              <p className="mt-1 text-[11px] text-muted">
                凭据一次性、短时（10 分钟），只放在链接的 fragment 中；不编码长期令牌、项目名称或本机路径。手机扫码后仍需在本机确认设备名称与权限。
              </p>
              <code className="mono mt-2 block break-all rounded bg-soft px-2 py-1.5 font-mono text-[11px] text-ink">{pairing.url}</code>
              <p className="mt-2 text-[11px] text-muted">
                凭据 {pairing.credentialId} · {remotePairingExpiryText(pairing, now)}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void mintPairing()}>
                  <Icon name="refresh" />
                  重新生成（旧码立即失效）
                </Button>
                <Button size="sm" onClick={() => void cancelRemotePairing()}>
                  关闭并作废
                </Button>
              </div>
            </Card>
          ) : null}

          <Card className={REMOTE_CARD}>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-[13px] font-[650] text-ink">移动端允许的操作</h3>
              <Badge>设备级授权 · 由 Host 裁决</Badge>
            </div>
            <div className="permission-list mt-3">
              {REMOTE_PERMISSION_ROWS.map((item) => (
                <label key={item.permission} className="flex items-center gap-[11px] border-b border-line py-2.5 last:border-b-0">
                  {/* Read-only: the grant happens per device at confirmation time,
                      and the desktop has no global switch (no write op exists). */}
                  <input
                    type="checkbox"
                    checked={item.defaultOn}
                    disabled
                    readOnly
                    className="h-[15px] w-[15px] accent-accent"
                    aria-label={`${item.label}（配对默认值）`}
                  />
                  <span>
                    <strong className="block text-[11px] text-ink">{item.label}</strong>
                    <small className="block text-[10px] text-muted">
                      {item.detail} · {item.defaultOn ? "默认开启" : "默认关闭"}
                      {item.perActionConfirmation ? " · 每次操作再次确认" : ""}
                    </small>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-muted">
              会话权限、任务写锁、共享模板确认和浏览器接管规则不因远程访问放宽；远程会话权限只会更窄。勾选反映配对时的默认值，真正的授予在每台设备确认时发生。
            </p>
          </Card>
        </section>

        <aside className="flex flex-col gap-[18px]">
          <Card className={REMOTE_CARD}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-[13px] font-[650] text-ink">已授权设备</h3>
              <Button size="sm" variant="primary" onClick={() => openModal({ type: "pair-device" })}>
                <Icon name="plus" />
                配对设备
              </Button>
            </div>
            <small className="text-[11px] text-muted">
              生成短时、单次使用的配对链接；扫码后仍需本机确认。{`${devices.filter((device) => device.status === "active").length} / ${devices.length} 有效。`}
            </small>
            <div className="device-list mt-2.5">
              {devices.map((device) => (
                <div key={device.id} className="device-row grid grid-cols-[32px_minmax(0,1fr)_auto] items-start gap-[9px] border-b border-line py-3 last:border-b-0">
                  <span aria-hidden="true" className="device-symbol grid h-[31px] w-[31px] place-items-center rounded-full bg-[#f0f2f5] text-[#68758d]">
                    <Icon name="globe" />
                  </span>
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <strong className="block text-[11px] text-ink">{device.name}</strong>
                      <Badge tone={remoteDeviceStatusTone(device)}>{remoteDeviceStatusLabel(device)}</Badge>
                    </span>
                    <small className="mt-0.5 block text-[9px] text-muted">
                      权限 {remoteDevicePermissionText(device)} · {remoteDeviceCredentialText(device)} · {remoteDeviceSeenText(device)}
                    </small>
                    {device.status === "pending-confirmation" ? (
                      <small className="mt-1 block text-[10px] text-warn">请求权限后等待本机确认；确认前不能查看或操作任何任务。</small>
                    ) : null}
                  </span>
                  {/* Prototype `.device-row` carries a single 撤销 button; this app's
                      Host exposes four ops, and four buttons on one line ate the
                      middle column at 1440 (the name broke to one glyph per line).
                      The tracks stay the prototype's — the button column stacks. */}
                  <div className="flex flex-col items-stretch gap-2">
                    {canConfirmDevice(device) ? (
                      <Button size="sm" variant="primary" onClick={() => void approveDevice(device)}>
                        <Icon name="check" />
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
                        <Icon name="refresh" />
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
                </div>
              ))}
            </div>
          </Card>

          <Card className={`remote-guard bg-[#faf9f5]! ${REMOTE_CARD}`}>
            <h3 className="text-[13px] font-[650] text-ink">远程操作仍受本机约束</h3>
            <p className="mt-2 text-[11px] leading-[1.8] text-[#7f7d76]">会话权限、任务执行权、共享模板确认和浏览器接管规则不因远程访问放宽。</p>
            <p className="mt-2 text-[11px] leading-[1.8] text-[#7f7d76]">配对码不含长期凭据；过期、使用或手动刷新后立即失效。</p>
          </Card>

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
        </aside>
      </div>

      <p className="note text-[10px] leading-[1.9] text-[#939c9f]">
        手机端只调用已声明的 Host 操作；配对凭据与设备凭据分开签发，撤销或轮换后旧值立即失效。真实 TLS、Tailscale Serve、Gateway 与手机浏览器未在本机运行。
      </p>
    </div>
  );
}

/** Exported for the pair-device modal: the permission rows it lists. */
export function remoteRequestedPermissionLabels(permissions: RemoteDevicePermission[]): string[] {
  return permissions.map((permission) => REMOTE_PERMISSION_ROWS.find((row) => row.permission === permission)?.label ?? permission);
}
