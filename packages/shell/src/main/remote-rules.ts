/**
 * Pure remote-access rules for [PiDock 19] (#21), covering stories 61–64.
 *
 * The module is pure (no fs, no process, no clock, no socket): the Host owns
 * persistence, the actual dial-out and the real credentials, and passes the
 * timestamps in, so every rule below is unit-testable and the renderer can
 * mirror it without a Node dependency.
 *
 * - 入口方式 (盒子 3): Tailscale Serve, self-hosted Gateway and Funnel are
 *   described by one definition each. The Host only ever listens on loopback,
 *   the Gateway is an *outbound* WSS the Host dials, and no mode proxies raw
 *   TCP or exposes the `pi` JSONL RPC. Funnel's public reachability never
 *   counts as authentication.
 * - 二维码配对 (盒子 1): a high-entropy, short-lived, single-use credential —
 *   carried in the URL *fragment* so it never reaches a request line or a proxy
 *   log — exchanged exactly once for a device, and only after the desktop
 *   confirms the device name and permissions.
 * - 设备授权 (盒子 1/5): every device has its own credential that can be
 *   rotated or revoked; revocation and rotation invalidate the old value, and a
 *   device that is not confirmed, is revoked, or lacks the permission is
 *   refused (网络可达 ≠ 授权成功).
 * - 远程不新增控制面 (盒子 2/4/5): the remotely callable op set is an explicit
 *   allow-list, sensitive surfaces ask again per action, files/terminal stay
 *   off by default, a remote session can only ever *narrow* the desktop session
 *   permission, and an uncertain delivery is never replayed blindly.
 * - Gateway 运维 (盒子 3): TLS, login, routing, rate-limit and audit are part of
 *   the connection verdict and of every recorded event; error details are
 *   redacted before they are written down.
 */

import type { PiPermission } from "./pi-session.js";

// ---------------------------------------------------------------------------
// 入口方式 (盒子 3, story 62)
// ---------------------------------------------------------------------------

export type RemoteEntryMode = "tailscale" | "gateway" | "funnel";

export const REMOTE_ENTRY_MODES: readonly RemoteEntryMode[] = ["tailscale", "gateway", "funnel"];

export type RemoteEntrySupport = "supported" | "experimental";

export interface RemoteEntryDefinition {
  mode: RemoteEntryMode;
  label: string;
  support: RemoteEntrySupport;
  /** How traffic reaches the Host. Never a public inbound port on this machine. */
  transport: "loopback-listener" | "outbound-wss";
  /** Whether the address is reachable from the public internet. */
  publiclyReachable: boolean;
  /** The phone needs a peer client (Tailscale) instead of only a browser. */
  requiresPeerClient: boolean;
  hint: string;
}

export const REMOTE_ENTRY_DEFINITIONS: readonly RemoteEntryDefinition[] = [
  {
    mode: "tailscale",
    label: "Tailscale 私有访问",
    support: "supported",
    transport: "loopback-listener",
    publiclyReachable: false,
    requiresPeerClient: true,
    hint: "PiDock Host 只监听 127.0.0.1，由 Tailscale Serve 在 tailnet 内提供 HTTPS；手机必须加入同一 tailnet。",
  },
  {
    mode: "gateway",
    label: "自建 PiDock Gateway",
    support: "supported",
    transport: "outbound-wss",
    publiclyReachable: true,
    requiresPeerClient: false,
    hint: "主机主动建立并维持出站 WSS，不需要开放本机入站端口；手机只访问 Gateway 暴露的 PiDock Web／API。",
  },
  {
    mode: "funnel",
    label: "Funnel 公网入口",
    support: "experimental",
    transport: "loopback-listener",
    publiclyReachable: true,
    requiresPeerClient: true,
    hint: "实验性入口：地址对互联网公开，必须沿用完整的 PiDock 登录、设备授权、限流与审计。",
  },
];

export function remoteEntryDefinition(mode: RemoteEntryMode): RemoteEntryDefinition {
  const definition = REMOTE_ENTRY_DEFINITIONS.find((item) => item.mode === mode);
  if (definition === undefined) throw new Error(`invalid-payload: 未定义的远程入口 ${String(mode)}`);
  return { ...definition };
}

/** The Host-side plan one entry mode implies. */
export interface RemoteEntryPlan {
  mode: RemoteEntryMode;
  /** Where the Host listens. Always a loopback address. */
  listener: string;
  /** The Host initiates the connection (Gateway) instead of accepting one. */
  dialOut: boolean;
  tls: "tailscale-serve" | "gateway-tls" | "funnel-tls";
  /** PiDock's own login/device authorization is required on every mode. */
  requiresPiDockAuthorization: true;
  /** Rate limiting and auditing are part of the entry, not of the caller. */
  rateLimitRequired: true;
  auditRequired: true;
  /** Never: the entry forwards PiDock requests only. */
  rawTcp: false;
  /** Never: `pi` stdin/stdout JSONL is not exposed. */
  piRpcExposed: false;
}

export function remoteEntryPlan(mode: RemoteEntryMode): RemoteEntryPlan {
  const definition = remoteEntryDefinition(mode);
  return {
    mode: definition.mode,
    listener: "127.0.0.1:4318",
    dialOut: definition.transport === "outbound-wss",
    tls: mode === "tailscale" ? "tailscale-serve" : mode === "gateway" ? "gateway-tls" : "funnel-tls",
    requiresPiDockAuthorization: true,
    rateLimitRequired: true,
    auditRequired: true,
    rawTcp: false,
    piRpcExposed: false,
  };
}

/**
 * The warning one mode must show. Funnel is the only entry whose reachability
 * is public, so it is the only one that carries a standing risk label; every
 * mode still needs a successful PiDock authorization (盒子 3「不将可达性视为
 * 身份认证」).
 */
export function remoteEntryWarning(mode: RemoteEntryMode): string | undefined {
  return remoteEntryDefinition(mode).publiclyReachable && mode === "funnel"
    ? "实验性入口：URL 对互联网公开，网络可达不等于通过认证。"
    : undefined;
}

// ---------------------------------------------------------------------------
// 设备权限与远程可调用面 (盒子 2/4/5, stories 61/64)
// ---------------------------------------------------------------------------

export type RemoteDevicePermission = "overview" | "chat" | "manage" | "files" | "terminal";

export const REMOTE_DEVICE_PERMISSIONS: readonly RemoteDevicePermission[] = ["overview", "chat", "manage", "files", "terminal"];

/** A freshly paired device may only look and talk (文件／终端默认关闭). */
export const DEFAULT_REMOTE_PERMISSIONS: readonly RemoteDevicePermission[] = ["overview", "chat"];

export interface RemotePermissionDefinition {
  permission: RemoteDevicePermission;
  label: string;
  detail: string;
  defaultOn: boolean;
  /** Sensitive permissions ask again for every action, even when granted. */
  perActionConfirmation: boolean;
}

export const REMOTE_PERMISSION_DEFINITIONS: readonly RemotePermissionDefinition[] = [
  { permission: "overview", label: "查看项目、任务和运行状态", detail: "只读", defaultOn: true, perActionConfirmation: false },
  { permission: "chat", label: "查看会话并对话", detail: "消息进入原会话，审批展示同一真实内容", defaultOn: true, perActionConfirmation: false },
  { permission: "manage", label: "暂停、归档与启停服务", detail: "每次敏感操作再次确认", defaultOn: false, perActionConfirmation: true },
  { permission: "files", label: "查看文件和差异", detail: "默认关闭", defaultOn: false, perActionConfirmation: true },
  { permission: "terminal", label: "远程终端", detail: "高风险 · 默认关闭", defaultOn: false, perActionConfirmation: true },
];

export function isRemoteDevicePermission(value: unknown): value is RemoteDevicePermission {
  return typeof value === "string" && (REMOTE_DEVICE_PERMISSIONS as readonly string[]).includes(value);
}

/** Dedupe + canonical order; an unknown permission is refused, never dropped. */
export function normalizeRemotePermissions(requested: readonly unknown[]): RemoteDevicePermission[] | null {
  for (const item of requested) if (!isRemoteDevicePermission(item)) return null;
  return REMOTE_DEVICE_PERMISSIONS.filter((permission) => requested.includes(permission));
}

export function remotePermissionLabel(permission: RemoteDevicePermission): string {
  const definition = REMOTE_PERMISSION_DEFINITIONS.find((item) => item.permission === permission);
  if (definition === undefined) throw new Error(`invalid-payload: 未定义的设备权限 ${String(permission)}`);
  return definition.label;
}

/** One remote surface and the device permission it needs. */
export type MobileSurface = "overview" | "chat" | "approvals" | "sessions" | "archive" | "recovery" | "manage" | "files" | "terminal";

export interface MobileSurfaceDefinition {
  surface: MobileSurface;
  label: string;
  permission: RemoteDevicePermission;
  /** The surface asks for a fresh confirmation per action (盒子 4). */
  perActionConfirmation: boolean;
}

export const MOBILE_SURFACES: readonly MobileSurfaceDefinition[] = [
  { surface: "overview", label: "项目／任务／运行状态", permission: "overview", perActionConfirmation: false },
  { surface: "chat", label: "会话与对话", permission: "chat", perActionConfirmation: false },
  { surface: "approvals", label: "待确认操作", permission: "chat", perActionConfirmation: false },
  { surface: "sessions", label: "会话选择", permission: "chat", perActionConfirmation: false },
  { surface: "archive", label: "归档历史", permission: "manage", perActionConfirmation: true },
  { surface: "recovery", label: "失败恢复", permission: "manage", perActionConfirmation: true },
  { surface: "manage", label: "轻量管理（启停服务／暂停）", permission: "manage", perActionConfirmation: true },
  { surface: "files", label: "文件与差异", permission: "files", perActionConfirmation: true },
  { surface: "terminal", label: "远程终端", permission: "terminal", perActionConfirmation: true },
];

export function mobileSurfaceDefinition(surface: MobileSurface): MobileSurfaceDefinition {
  const definition = MOBILE_SURFACES.find((item) => item.surface === surface);
  if (definition === undefined) throw new Error(`invalid-payload: 未定义的移动端界面 ${String(surface)}`);
  return { ...definition };
}

/**
 * The only Host ops a remote caller may reach, and the surface each belongs to.
 * Anything absent from this map is `not-available-remotely`: remote access reuses
 * the declared task ops instead of opening a second control plane (盒子 2/5).
 */
const MOBILE_OP_SURFACES: Readonly<Record<string, MobileSurface>> = {
  "task/sessionStates": "overview",
  "task/executionState": "overview",
  "task/attention": "overview",
  "task/markAttentionRead": "overview",
  "task/serviceStatus": "overview",
  "task/usageRecords": "overview",
  "task/scheduleList": "overview",
  "task/scheduleRuns": "overview",
  "task/sendMessage": "chat",
  "task/cancel": "chat",
  "task/saveDraft": "chat",
  "task/clearDraft": "chat",
  "task/listApprovals": "approvals",
  "task/getApproval": "approvals",
  "task/approve": "approvals",
  "task/reject": "approvals",
  "task/sessionContext": "sessions",
  "task/archive": "archive",
  "task/restore": "archive",
  "task/lifecycleState": "archive",
  "task/cleanupPreview": "archive",
  "task/fileRoots": "files",
  "task/fileTree": "files",
  "task/filePreview": "files",
  "task/fileDiff": "files",
  "task/terminalState": "terminal",
  "task/terminalHistory": "terminal",
  "task/terminalControl": "terminal",
  "task/controlService": "manage",
  "task/planServiceStart": "manage",
  "task/serviceRunRecords": "overview",
};

export function mobileSurfaceForOp(op: string): MobileSurface | null {
  return MOBILE_OP_SURFACES[op] ?? null;
}

// ---------------------------------------------------------------------------
// 设备记录、配对凭据与设备凭据 (盒子 1/5, stories 63/64)
// ---------------------------------------------------------------------------

/** Recommended pairing-credential lifetime (spec: 建议有效期 10 分钟). */
export const PAIRING_CREDENTIAL_TTL_MS = 10 * 60 * 1000;

export type PairingCredentialState = "pending" | "used" | "expired" | "refreshed" | "cancelled";

export interface PairingCredential {
  credentialId: string;
  /** Short opaque value the phone proves it scanned. Never a long-term token. */
  secret: string;
  issuedAt: string;
  expiresAt: string;
  state: PairingCredentialState;
  usedAt?: string;
}

/** A rejected pairing exchange says which invalidation applies (旧码失效). */
export type PairingRefusalCode = "credential-used" | "credential-expired" | "credential-refreshed" | "credential-cancelled" | "credential-mismatch";

export type PairingCredentialVerdict = { ok: true } | { ok: false; code: PairingRefusalCode; message: string };

const PAIRING_REFUSAL_MESSAGES: Readonly<Record<PairingRefusalCode, string>> = {
  "credential-used": "配对凭据已使用，不能再次配对",
  "credential-expired": "配对凭据已过期，请在桌面重新生成",
  "credential-refreshed": "配对凭据已被新的二维码替换，旧码失效",
  "credential-cancelled": "配对凭据已取消",
  // The credential id travels in the QR URL, so the exchange must prove it also
  // holds the secret: an id alone never pairs a device.
  "credential-mismatch": "配对凭据不匹配，请重新扫码",
};

export function mintPairingCredential(input: { credentialId: string; secret: string; at: string; ttlMs?: number }): PairingCredential {
  if (input.credentialId.trim().length === 0) throw new Error("invalid-payload: credentialId must be non-empty");
  if (!isHighEntropySecret(input.secret)) throw new Error("invalid-payload: 配对凭据必须是高熵随机值");
  const ttlMs = input.ttlMs ?? PAIRING_CREDENTIAL_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("invalid-payload: 配对凭据有效期必须为正");
  return {
    credentialId: input.credentialId,
    secret: input.secret,
    issuedAt: input.at,
    expiresAt: new Date(Date.parse(input.at) + ttlMs).toISOString(),
    state: "pending",
  };
}

/**
 * Invalidate a live credential: refreshing the desktop QR code and closing the
 * pairing dialog both end here, so the old code cannot be scanned afterwards.
 * Only a `pending` credential can be invalidated — a used or expired one already
 * has its own state and must not be rewritten into a different refusal.
 */
export function invalidatePairingCredential(credential: PairingCredential, reason: "refreshed" | "cancelled"): PairingCredential {
  if (credential.state !== "pending") throw new Error(`invalid-payload: 只有待使用的配对凭据可以失效（当前 ${credential.state}）`);
  return { ...credential, state: reason };
}

/** Single-use, short-lived: all four invalidations are refusals on exchange. */
export function pairingCredentialVerdict(credential: PairingCredential, at: string): PairingCredentialVerdict {
  if (credential.state !== "pending") {
    return { ok: false, code: `credential-${credential.state}` as PairingRefusalCode, message: PAIRING_REFUSAL_MESSAGES[`credential-${credential.state}` as PairingRefusalCode] };
  }
  if (Date.parse(at) >= Date.parse(credential.expiresAt)) {
    return { ok: false, code: "credential-expired", message: PAIRING_REFUSAL_MESSAGES["credential-expired"] };
  }
  return { ok: true };
}

/** What one successful exchange produced: the spent credential and the device. */
export type PairingExchangeResult =
  | { ok: true; credential: PairingCredential; device: RemoteDeviceRecord }
  | { ok: false; code: PairingRefusalCode | "invalid-permissions"; message: string };

/**
 * Exchange the scanned code for a *pending* device (盒子 1). The device is not
 * usable yet: `confirmDevice` — a desktop action — is what authorizes it.
 */
export function exchangePairingCredential(input: {
  credential: PairingCredential;
  at: string;
  deviceId: string;
  deviceName: string;
  requestedPermissions: readonly unknown[];
}): PairingExchangeResult {
  const verdict = pairingCredentialVerdict(input.credential, input.at);
  if (!verdict.ok) return verdict;
  if (input.deviceName.trim().length === 0) return { ok: false, code: "invalid-permissions", message: "设备名称不能为空" };
  const permissions = normalizeRemotePermissions(input.requestedPermissions);
  if (permissions === null) return { ok: false, code: "invalid-permissions", message: "请求了未知的设备权限" };
  return {
    ok: true,
    credential: { ...input.credential, state: "used", usedAt: input.at },
    device: {
      deviceId: input.deviceId,
      name: input.deviceName.trim(),
      status: "pending-confirmation",
      permissions,
      requestedAt: input.at,
    },
  };
}

/** The QR payload: fragment only, no query string, no secret in the path. */
export function pairingUrl(input: { baseUrl: string; credentialId: string }): string {
  if (input.credentialId.trim().length === 0) throw new Error("invalid-payload: credentialId must be non-empty");
  const base = input.baseUrl.replace(/#.*$/, "").replace(/\/+$/, "");
  return `${base}/#pairing=${input.credentialId}`;
}

export type PairingUrlRefusalCode = "query-not-fragment" | "secret-like-value" | "local-path" | "not-fragment";

export type PairingUrlVerdict = { ok: true } | { ok: false; code: PairingUrlRefusalCode; message: string };

const SECRET_LIKE = /(token|secret|password|apikey|api_key|authorization)=/i;
const LOCAL_PATH = /(\/Users\/|\/home\/|[A-Za-z]:\\|\.\.\/)/;

/**
 * The QR payload must not carry a long-term token, a project name or a local
 * path (spec: 凭据放在 URL fragment，不编码长期令牌／项目名／本机路径).
 */
export function pairingUrlVerdict(url: string): PairingUrlVerdict {
  if (url.includes("?") || /#/.test(url) === false) {
    return { ok: false, code: url.includes("?") ? "query-not-fragment" : "not-fragment", message: "配对凭据只能放在 URL fragment 中" };
  }
  if (SECRET_LIKE.test(url)) return { ok: false, code: "secret-like-value", message: "配对链接不能携带长期凭据" };
  if (LOCAL_PATH.test(url)) return { ok: false, code: "local-path", message: "配对链接不能携带本机路径" };
  return { ok: true };
}

/** A high-entropy opaque value: long, mixed, and not a word or a path. */
export function isHighEntropySecret(value: string): boolean {
  if (value.length < 32) return false;
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;
  if (LOCAL_PATH.test(value) || SECRET_LIKE.test(value)) return false;
  return /^[A-Za-z0-9_-]+$/.test(value);
}

/** One device credential generation; rotating or revoking replaces it. */
export interface DeviceCredential {
  credentialId: string;
  generation: number;
  issuedAt: string;
  rotatedAt?: string;
  revokedAt?: string;
}

export type RemoteDeviceStatus = "pending-confirmation" | "active" | "revoked";

export interface RemoteDeviceRecord {
  deviceId: string;
  name: string;
  status: RemoteDeviceStatus;
  /** Permissions requested at pairing time; the desktop confirms or narrows them. */
  permissions: RemoteDevicePermission[];
  requestedAt: string;
  /** Desktop confirmation of the name + permissions (盒子 1). */
  confirmedAt?: string;
  pairedAt?: string;
  lastSeenAt?: string;
  /** Signed at confirmation; absent until the desktop confirmed the device. */
  credential?: DeviceCredential;
  /** The pairing credential this device came from (audit trail only). */
  pairingCredentialId?: string;
}

/** Confirming narrows/accepts the requested permissions and issues the credential. */
export function confirmDevice(input: {
  device: RemoteDeviceRecord;
  at: string;
  credentialId: string;
  confirmedPermissions?: readonly unknown[];
}): { ok: true; device: RemoteDeviceRecord } | { ok: false; code: string; message: string } {
  if (input.device.status !== "pending-confirmation") {
    return { ok: false, code: "not-pending", message: `设备 ${input.device.deviceId} 不是待确认状态` };
  }
  const permissions = input.confirmedPermissions === undefined ? input.device.permissions : normalizeRemotePermissions(input.confirmedPermissions);
  if (permissions === null) return { ok: false, code: "invalid-permissions", message: "确认了未知的设备权限" };
  if (input.credentialId.trim().length === 0) return { ok: false, code: "invalid-credential", message: "设备凭据不能为空" };
  return {
    ok: true,
    device: {
      ...input.device,
      status: "active",
      permissions,
      confirmedAt: input.at,
      pairedAt: input.at,
      lastSeenAt: input.at,
      credential: { credentialId: input.credentialId, generation: 1, issuedAt: input.at },
    },
  };
}

/** Rejecting a pairing request leaves nothing behind but the record's refusal. */
export function rejectDevice(input: { device: RemoteDeviceRecord; at: string }): RemoteDeviceRecord {
  return { ...input.device, status: "revoked", permissions: [] };
}

/** Rotation invalidates the previous generation and issues a new one. */
export function rotateDeviceCredential(input: { device: RemoteDeviceRecord; at: string; credentialId: string }): { ok: true; device: RemoteDeviceRecord } | { ok: false; code: string; message: string } {
  if (input.device.status !== "active") return { ok: false, code: "not-active", message: `设备 ${input.device.deviceId} 不是有效状态，不能轮换凭据` };
  const previous = input.device.credential;
  if (previous === undefined) return { ok: false, code: "no-credential", message: `设备 ${input.device.deviceId} 还没有设备凭据` };
  if (input.credentialId.trim().length === 0) return { ok: false, code: "invalid-credential", message: "新设备凭据不能为空" };
  return {
    ok: true,
    device: {
      ...input.device,
      credential: { credentialId: input.credentialId, generation: previous.generation + 1, issuedAt: input.at, rotatedAt: input.at, revokedAt: previous.issuedAt },
    },
  };
}

/** Revoking keeps the record (and its history) but ends every grant. */
export function revokeRemoteDevice(input: { device: RemoteDeviceRecord; at: string }): RemoteDeviceRecord {
  const credential = input.device.credential;
  return {
    ...input.device,
    status: "revoked",
    permissions: [],
    ...(credential === undefined ? {} : { credential: { ...credential, revokedAt: input.at } }),
  };
}

// ---------------------------------------------------------------------------
// 请求裁决 (盒子 2/4/5)
// ---------------------------------------------------------------------------

export type RemoteDenyCode =
  | "device-unknown"
  | "device-revoked"
  | "awaiting-desktop-confirmation"
  | "permission-not-granted"
  | "not-available-remotely"
  | "rate-limited"
  | "host-offline"
  | "host-mismatch"
  | "session-permission-floor";

export type RemoteRequestVerdict =
  | { decision: "allow"; surface: MobileSurface; requiresConfirmation: boolean }
  | { decision: "deny"; code: RemoteDenyCode; message: string };

/**
 * Whether one declared Host op may be called by this device. Reachability is
 * never enough: the device must be confirmed, not revoked, hold the surface's
 * permission — and ops outside the allow-list stay unavailable to every device,
 * whatever its permissions.
 */
export function authorizeRemoteOp(input: { device: RemoteDeviceRecord; op: string; now: string }): RemoteRequestVerdict {
  const device = input.device;
  const surface = mobileSurfaceForOp(input.op);
  if (surface === null) return { decision: "deny", code: "not-available-remotely", message: `操作 ${input.op} 不提供远程入口` };
  const definition = mobileSurfaceDefinition(surface);
  if (device.status === "revoked") return { decision: "deny", code: "device-revoked", message: "设备已撤销，现有连接与后续请求均失效" };
  if (device.status !== "active" || device.confirmedAt === undefined) {
    return { decision: "deny", code: "awaiting-desktop-confirmation", message: "设备尚未在本机确认，网络可达不等于授权成功" };
  }
  if (!device.permissions.includes(definition.permission)) {
    return { decision: "deny", code: "permission-not-granted", message: `设备没有「${remotePermissionLabel(definition.permission)}」权限` };
  }
  return { decision: "allow", surface, requiresConfirmation: definition.perActionConfirmation };
}

/** A remote request must be refused while the Gateway reports the host offline. */
export function authorizeRemoteGateway(input: { state: GatewayState; hostId: string }): RemoteRequestVerdict {
  if (input.state.hostId !== input.hostId) return { decision: "deny", code: "host-mismatch", message: "请求的主机与当前连接不一致" };
  if (input.state.status !== "online") return { decision: "deny", code: "host-offline", message: "主机当前离线，不重放请求" };
  return { decision: "allow", surface: "overview", requiresConfirmation: false };
}

const PERMISSION_ORDER: readonly PiPermission[] = ["read", "default", "auto"];

/**
 * What a device can at most run inside a session: a view-only device reads, a
 * talking device at most asks. Remote access never *widens* the desktop session
 * permission (盒子 2「不扩大桌面会话权限」) — the narrower of the two wins.
 */
export function effectiveRemoteSessionPermission(input: { device: RemoteDeviceRecord; sessionPermission: PiPermission }): PiPermission {
  const ceiling: PiPermission = input.device.permissions.includes("chat") ? "default" : "read";
  return PERMISSION_ORDER[Math.min(PERMISSION_ORDER.indexOf(ceiling), PERMISSION_ORDER.indexOf(input.sessionPermission))] as PiPermission;
}

/** What the phone shows for one confirmation: the desktop card's real fields. */
export interface RemoteApprovalView {
  approvalId: string;
  title: string;
  target: string;
  payloadVersion: string;
  impact: string;
  scope?: string;
  expiresAt?: string;
  actions: readonly ("approve" | "reject")[];
}

/**
 * The remote view is projected from the *same* approval record the desktop
 * renders — never a summary, never an extra action (盒子 2). A settled
 * confirmation has no actions left, and a device without chat rights sees none.
 */
export function remoteApprovalView(input: {
  approval: { id: string; title: string; target: string; contentVersion: string; scope?: string; expiresAt?: string; status: string };
  device: RemoteDeviceRecord;
}): RemoteApprovalView {
  const canAct = input.device.status === "active" && input.device.permissions.includes("chat") && input.approval.status === "pending";
  return {
    approvalId: input.approval.id,
    title: input.approval.title,
    target: input.approval.target,
    payloadVersion: input.approval.contentVersion,
    impact: `将执行 ${input.approval.title}（${input.approval.target}）`,
    ...(input.approval.scope === undefined ? {} : { scope: input.approval.scope }),
    ...(input.approval.expiresAt === undefined ? {} : { expiresAt: input.approval.expiresAt }),
    actions: canAct ? ["approve", "reject"] : [],
  };
}

// ---------------------------------------------------------------------------
// Gateway 状态、限流与在线显示 (盒子 3/4)
// ---------------------------------------------------------------------------

export type GatewayStatus = "offline" | "connecting" | "online";

export interface GatewayState {
  entryMode: RemoteEntryMode;
  /** The Gateway the Host dialed (or the configured one while offline). */
  endpoint: string;
  /** The desktop host identity the Gateway routes to. */
  hostId: string;
  status: GatewayStatus;
  connectedAt?: string;
  lastError?: string;
}

export const GATEWAY_RATE_LIMIT: RemoteRateLimit = { windowMs: 60_000, maxRequests: 60 };

export interface RemoteRateLimit {
  windowMs: number;
  maxRequests: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Requests still allowed in the current window. */
  remaining: number;
  retryAfterMs: number;
}

/** Sliding window over the request timestamps this device already made. */
export function rateLimitVerdict(input: { attempts: readonly string[]; at: string; rule?: RemoteRateLimit }): RateLimitVerdict {
  const rule = input.rule ?? GATEWAY_RATE_LIMIT;
  const now = Date.parse(input.at);
  const inWindow = input.attempts.map((attempt) => Date.parse(attempt)).filter((time) => Number.isFinite(time) && now - time < rule.windowMs && time <= now).sort((a, b) => a - b);
  if (inWindow.length >= rule.maxRequests) {
    const oldest = inWindow[inWindow.length - rule.maxRequests] as number;
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, rule.windowMs - (now - oldest)) };
  }
  return { allowed: true, remaining: rule.maxRequests - inWindow.length - 1, retryAfterMs: 0 };
}

/** 断线显示离线: online is a recent observation, not a remembered one. */
export const DEVICE_ONLINE_WINDOW_MS = 2 * 60 * 1000;

export function deviceOnline(input: { device: RemoteDeviceRecord; at: string; windowMs?: number }): boolean {
  if (input.device.status !== "active" || input.device.lastSeenAt === undefined) return false;
  const windowMs = input.windowMs ?? DEVICE_ONLINE_WINDOW_MS;
  return Date.parse(input.at) - Date.parse(input.device.lastSeenAt) < windowMs;
}

export function deviceStatusLabel(device: RemoteDeviceRecord): string {
  if (device.status === "revoked") return "已撤销";
  if (device.status === "pending-confirmation") return "等待本机确认";
  return "有效";
}

// ---------------------------------------------------------------------------
// 断线重连：不盲目重放 (盒子 4)
// ---------------------------------------------------------------------------

export type RemoteDeliveryState = "queued" | "delivered" | "uncertain";

export interface RemotePendingRequest {
  /** Server-side dedupe key: a re-delivery of the same key is never applied twice. */
  idempotencyKey: string;
  op: string;
  state: RemoteDeliveryState;
  queuedAt: string;
}

export interface ReconnectPlan {
  /** Safe to (re)deliver exactly once. */
  deliver: RemotePendingRequest[];
  /** Duplicates dropped because the same key was already applied. */
  duplicate: RemotePendingRequest[];
  /** Never auto-replayed: the outside effect was never observed. */
  discard: { request: RemotePendingRequest; code: "unknown-external" | "stale" | "offline"; message: string }[];
}

/**
 * Reconnect plan (盒子 4「断线显示离线，不盲目重放消息或管理请求」): an
 * `uncertain` request may have reached the Host, so it is never re-sent — it is
 * discarded for manual verification. Duplicates of an already delivered key are
 * dropped, and queued requests older than `maxAgeMs` are not replayed either.
 */
export function planReconnectDelivery(input: {
  pending: readonly RemotePendingRequest[];
  deliveredKeys: readonly string[];
  at: string;
  maxAgeMs?: number;
}): ReconnectPlan {
  const maxAgeMs = input.maxAgeMs ?? 5 * 60 * 1000;
  const plan: ReconnectPlan = { deliver: [], duplicate: [], discard: [] };
  const seen = new Set(input.deliveredKeys);
  for (const request of input.pending) {
    if (request.state === "uncertain") {
      plan.discard.push({ request, code: "unknown-external", message: "上次结果未知，先核对再手动重发" });
      continue;
    }
    if (request.state === "delivered" || seen.has(request.idempotencyKey)) {
      plan.duplicate.push(request);
      continue;
    }
    if (Date.parse(input.at) - Date.parse(request.queuedAt) > maxAgeMs) {
      plan.discard.push({ request, code: "stale", message: "离线期间排队的请求已过期，不自动补发" });
      continue;
    }
    seen.add(request.idempotencyKey);
    plan.deliver.push(request);
  }
  return plan;
}

// ---------------------------------------------------------------------------
// 审计与脱敏 (盒子 3)
// ---------------------------------------------------------------------------

export type RemoteAuditKind =
  | "pairing-minted"
  | "pairing-refreshed"
  | "pairing-refused"
  | "pairing-used"
  | "device-confirmed"
  | "device-rejected"
  | "device-rotated"
  | "device-revoked"
  | "request-allowed"
  | "request-denied"
  | "gateway-connected"
  | "gateway-disconnected"
  | "rate-limited";

export interface RemoteAuditEvent {
  eventId: string;
  at: string;
  kind: RemoteAuditKind;
  deviceId?: string;
  entryMode?: RemoteEntryMode;
  /** Already redacted: no tokens, no local paths, no raw payloads. */
  detail: string;
}

/**
 * Audit detail must survive a report: paths and secret-looking values are
 * replaced before the line is stored (盒子 3「安全审计」+「错误脱敏」).
 */
export function redactRemoteDetail(detail: string): string {
  return detail
    .replace(/(token|secret|password|api[-_]?key|authorization)\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .replace(/\/Users\/[^\s"',)]*/g, "<path>")
    .replace(/\/home\/[^\s"',)]*/g, "<path>")
    .replace(/[A-Za-z]:\\\\?[^\s"',)]*/g, "<path>")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "<redacted>");
}

export function remoteAuditEvent(input: {
  eventId: string;
  at: string;
  kind: RemoteAuditKind;
  detail: string;
  deviceId?: string;
  entryMode?: RemoteEntryMode;
}): RemoteAuditEvent {
  if (input.eventId.trim().length === 0) throw new Error("invalid-payload: audit eventId must be non-empty");
  return {
    eventId: input.eventId,
    at: input.at,
    kind: input.kind,
    detail: redactRemoteDetail(input.detail),
    ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
    ...(input.entryMode === undefined ? {} : { entryMode: input.entryMode }),
  };
}

// ---------------------------------------------------------------------------
// 持久化形状（纯数据；解析与写入由 Host 侧的 TaskStore 负责）
// ---------------------------------------------------------------------------

/**
 * A persisted pairing credential: everything except the short-lived secret. The
 * secret lives in memory only, so a restarted Host invalidates a live QR code
 * instead of keeping a bearer value on disk.
 */
export interface PairingCredentialDiskRecord {
  credentialId: string;
  issuedAt: string;
  expiresAt: string;
  state: PairingCredentialState;
  usedAt?: string;
}

/** How many pairing credentials and audit lines one task keeps. */
export const REMOTE_PAIRING_HISTORY_LIMIT = 20;
export const REMOTE_AUDIT_HISTORY_LIMIT = 200;

export interface RemoteDeviceDiskRecord {
  version: number;
  entryMode: RemoteEntryMode;
  /** Gateway the Host dials: configuration, not a live connection. */
  gateway: { endpoint: string; hostId: string };
  /** Base address the QR code points at (the entry main told this Host about). */
  entryBaseUrl: string;
  devices: RemoteDeviceRecord[];
  /** Pairing history (newest last); never contains the secret. */
  pairing: PairingCredentialDiskRecord[];
  /** Redacted audit trail, newest last. */
  audits: RemoteAuditEvent[];
}

export function emptyRemoteDeviceRecord(): RemoteDeviceDiskRecord {
  return {
    version: 1,
    entryMode: "tailscale",
    gateway: { endpoint: "", hostId: "" },
    entryBaseUrl: "http://127.0.0.1:4318",
    devices: [],
    pairing: [],
    audits: [],
  };
}

/** Minted sequence (`device-<n>` / `pair-<n>` / `audit-<n>`) for restart-safe ids. */
export function highestSequence(ids: readonly string[], prefix: string): number {
  let highest = 0;
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  for (const id of ids) {
    const match = pattern.exec(id);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}
