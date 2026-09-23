import type { RemoteDevice, RemoteDevicePermission, RemoteEntryMode, RemotePairing, RemotePairingState } from "./types";

/**
 * [PiDock 19] (#21) renderer mirror of the shell's remote-access rules.
 *
 * Node-free and read-only: it never mints a credential, never authorizes a
 * request and never decides a permission — the Host owns all three (the device
 * record, the pairing states and the op allow-list below are the same
 * vocabulary the shell uses). The page only presents what the Host reported and
 * disables an action the Host would refuse anyway.
 */

export interface RemoteEntryRow {
  mode: RemoteEntryMode;
  label: string;
  hint: string;
  experimental: boolean;
  publiclyReachable: boolean;
  requiresPeerClient: boolean;
}

export const REMOTE_ENTRY_ROWS: readonly RemoteEntryRow[] = [
  { mode: "tailscale", label: "Tailscale 私有访问", hint: "PiDock Host 只监听 127.0.0.1，由 Tailscale Serve 在 tailnet 内提供 HTTPS。", experimental: false, publiclyReachable: false, requiresPeerClient: true },
  { mode: "gateway", label: "自建 PiDock Gateway", hint: "主机主动建立并维持出站 WSS，不开放本机入站端口。", experimental: false, publiclyReachable: true, requiresPeerClient: false },
  { mode: "funnel", label: "Funnel 公网入口", hint: "实验性：URL 对互联网公开，必须沿用完整的登录、设备授权与限流。", experimental: true, publiclyReachable: true, requiresPeerClient: true },
];

export function remoteEntryRow(mode: RemoteEntryMode): RemoteEntryRow {
  return REMOTE_ENTRY_ROWS.find((row) => row.mode === mode) ?? REMOTE_ENTRY_ROWS[0]!;
}

/** The standing warning a mode must show; Funnel is public by design. */
export function remoteEntryWarningText(mode: RemoteEntryMode): string | undefined {
  return mode === "funnel" ? "实验性入口：URL 对互联网公开，网络可达不等于通过认证。" : undefined;
}

export interface RemotePermissionRow {
  permission: RemoteDevicePermission;
  label: string;
  detail: string;
  defaultOn: boolean;
  perActionConfirmation: boolean;
}

export const REMOTE_PERMISSION_ROWS: readonly RemotePermissionRow[] = [
  { permission: "overview", label: "查看项目、任务和运行状态", detail: "只读", defaultOn: true, perActionConfirmation: false },
  { permission: "chat", label: "查看会话并对话", detail: "消息进入原会话；待确认展示同一真实内容", defaultOn: true, perActionConfirmation: false },
  { permission: "manage", label: "暂停、归档与启停服务", detail: "每次敏感操作再次确认", defaultOn: false, perActionConfirmation: true },
  { permission: "files", label: "查看文件和差异", detail: "默认关闭", defaultOn: false, perActionConfirmation: true },
  { permission: "terminal", label: "远程终端", detail: "高风险 · 默认关闭", defaultOn: false, perActionConfirmation: true },
];

export function isRemotePermission(value: unknown): value is RemoteDevicePermission {
  return typeof value === "string" && REMOTE_PERMISSION_ROWS.some((row) => row.permission === value);
}

/** Dedupe + canonical order, exactly like the shell rule. */
export function normalizeRemotePermissions(requested: readonly unknown[]): RemoteDevicePermission[] {
  return REMOTE_PERMISSION_ROWS.filter((row) => requested.includes(row.permission)).map((row) => row.permission);
}

export function remotePermissionLabel(permission: RemoteDevicePermission): string {
  return REMOTE_PERMISSION_ROWS.find((row) => row.permission === permission)?.label ?? permission;
}

/** A remote surface and the permission it needs (mirror of the op allow-list). */
const REMOTE_OPS_BY_PERMISSION: Readonly<Record<RemoteDevicePermission, readonly string[]>> = {
  overview: ["查看项目／任务／运行状态", "查看用量与调度记录"],
  chat: ["查看会话并对话", "选择会话", "处理待确认操作"],
  manage: ["归档历史", "失败恢复", "暂停／启停服务"],
  files: ["查看文件与差异"],
  terminal: ["远程终端"],
};

export function remoteSurfacesFor(device: RemoteDevice): { label: string; available: boolean; perActionConfirmation: boolean }[] {
  const rows: { label: string; available: boolean; perActionConfirmation: boolean }[] = [];
  for (const permission of REMOTE_PERMISSION_ROWS) {
    const available = device.status === "active" && device.permissions.includes(permission.permission);
    for (const label of REMOTE_OPS_BY_PERMISSION[permission.permission]) {
      rows.push({ label, available, perActionConfirmation: permission.perActionConfirmation });
    }
  }
  return rows;
}

export function remoteDeviceStatusLabel(device: RemoteDevice): string {
  if (device.status === "revoked") return "已撤销";
  if (device.status === "pending-confirmation") return "等待本机确认";
  return "有效";
}

export function remoteDeviceStatusTone(device: RemoteDevice): "accent" | "warn" | "neutral" {
  if (device.status === "revoked") return "neutral";
  if (device.status === "pending-confirmation") return "warn";
  return "accent";
}

/** Confirming, rejecting, rotating and revoking are desktop-only actions. */
export function canConfirmDevice(device: RemoteDevice): boolean {
  return device.status === "pending-confirmation";
}

export function canRejectDevice(device: RemoteDevice): boolean {
  return device.status === "pending-confirmation";
}

export function canRotateDevice(device: RemoteDevice): boolean {
  return device.status === "active";
}

export function canRevokeDevice(device: RemoteDevice): boolean {
  return device.status !== "revoked";
}

/** 断线显示离线: an old 最近在线 is shown as a time, never as "已连接". */
export function remoteDeviceSeenText(device: RemoteDevice): string {
  return device.lastSeen === undefined
    ? "从未在线"
    : `最近在线 ${device.lastSeen.slice(0, 16).replace("T", " ")}`;
}

export function remoteDevicePermissionText(device: RemoteDevice): string {
  if (device.status === "revoked") return "无（已撤销）";
  if (device.permissions.length === 0) return "无";
  return device.permissions.map(remotePermissionLabel).join(" / ");
}

export function remoteDeviceCredentialText(device: RemoteDevice): string {
  if (device.credentialGeneration === undefined) return "尚未签发设备凭据";
  return `设备凭据第 ${device.credentialGeneration} 代`;
}

export function remotePairingStateLabel(state: RemotePairingState): string {
  switch (state) {
    case "pending":
      return "待扫描";
    case "used":
      return "已使用";
    case "expired":
      return "已过期";
    case "refreshed":
      return "已被新二维码替换";
    case "cancelled":
      return "已取消";
  }
}

/**
 * Remaining lifetime of one pairing code. A code the Host cancelled or spent
 * never counts down to a usable state — the text says so instead.
 */
export function remotePairingExpiryText(pairing: RemotePairing, now: string): string {
  if (pairing.state !== "pending") return remotePairingStateLabel(pairing.state);
  const remainingMs = Date.parse(pairing.expiresAt) - Date.parse(now);
  if (remainingMs <= 0) return "已过期，请重新生成";
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `剩余 ${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function remotePairingIsLive(pairing: RemotePairing | null, now: string): boolean {
  return pairing !== null && pairing.state === "pending" && Date.parse(pairing.expiresAt) > Date.parse(now);
}

/** The QR payload only ever points at the entry with the credential in its fragment. */
export function remotePairingUrlIsSafe(url: string): boolean {
  return url.includes("#") && !url.includes("?") && !/\/Users\/|\/home\/|[A-Za-z]:\\/.test(url);
}

export const REMOTE_GATEWAY_STATUS_LABELS = {
  offline: "离线（不重放请求）",
  connecting: "连接中",
  online: "在线",
} as const;
