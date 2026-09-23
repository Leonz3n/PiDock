/**
 * Host-side remote access for [PiDock 19] (#21).
 *
 * Wraps the pure rules of `main/remote-rules.ts` with the three things the Host
 * owes and the rules must not know about:
 *
 * - **persistence**: `<taskDir>/remote-devices.json` (via `TaskStore`) — the
 *   entry mode, the Gateway the Host dials, every device with its credential
 *   generation, the pairing history and the redacted audit trail. The
 *   short-lived pairing *secret* is deliberately **not** persisted: a restarted
 *   Host invalidates a live QR code instead of keeping a bearer value on disk.
 * - **identity**: `device-<n>` / `pair-<n>` / `audit-<n>` ids re-seeded from the
 *   restored record, so a restarted Host never re-mints an id an earlier process
 *   used.
 * - **the desktop boundary**: minting the QR code, confirming or rejecting a
 *   pending device, rotating and revoking a credential are *desktop* actions
 *   (the caller passes the trusted `origin` attestation); a device can only
 *   reach the declared op allow-list, and only after the desktop confirmed it.
 *
 * The Host never opens a socket here: the Gateway is an outbound WSS main
 * maintains, so `gatewayEvent` is how main reports what the connection did and
 * a restarted Host reports `offline` until main dials again.
 */

import {
  authorizeRemoteGateway,
  authorizeRemoteOp,
  confirmDevice,
  deviceOnline,
  exchangePairingCredential,
  GATEWAY_RATE_LIMIT,
  highestSequence,
  mintPairingCredential,
  invalidatePairingCredential,
  pairingCredentialVerdict,
  pairingUrl,
  planReconnectDelivery,
  rateLimitVerdict,
  rejectDevice,
  remoteAuditEvent,
  remoteEntryDefinition,
  remoteEntryPlan,
  remoteEntryWarning,
  revokeRemoteDevice,
  rotateDeviceCredential,
  REMOTE_AUDIT_HISTORY_LIMIT,
  REMOTE_PAIRING_HISTORY_LIMIT,
  type GatewayState,
  type GatewayStatus,
  type PairingCredential,
  type PairingCredentialDiskRecord,
  type RemoteAuditEvent,
  type RemoteAuditKind,
  type RemoteDeviceDiskRecord,
  type RemoteDeviceRecord,
  type RemoteEntryMode,
  type RemotePendingRequest,
  type RemoteRequestVerdict,
} from "../main/remote-rules.js";

/** The persistence slice this manager needs (satisfied by `TaskStore`). */
export interface RemoteDeviceStore {
  readRemoteDevices(taskDir: string): RemoteDeviceDiskRecord;
  writeRemoteDevices(taskDir: string, record: RemoteDeviceDiskRecord): void;
}

export interface RemoteDevicePorts {
  now(): string;
  /** High-entropy secret minting (main owns entropy; the Host never invents one). */
  mintSecret(kind: "pairing" | "device"): string;
}

/** What the desktop QR modal shows. */
export interface PairingPresentation {
  credentialId: string;
  /** Shown to the phone through the QR code only; never persisted. */
  secret: string;
  url: string;
  issuedAt: string;
  expiresAt: string;
}

/** A device as the UI sees it: the record plus the live online reading. */
export interface RemoteDeviceView extends RemoteDeviceRecord {
  online: boolean;
}

export interface RemoteState {
  entry: { mode: RemoteEntryMode; label: string; support: string; hint: string; warning?: string; listener: string; dialOut: boolean; baseUrl: string };
  gateway: GatewayState;
  devices: RemoteDeviceView[];
}

export type RemoteOpResult<T> = { ok: true; payload: T } | { ok: false; code: string; message: string };

export class TaskRemoteDevices {
  private recordState: RemoteDeviceDiskRecord;
  private deviceSequence: number;
  private pairingSequence: number;
  private auditSequence: number;
  /**
   * Live pairing secrets, memory only. Persisting one would keep a bearer value
   * on disk for a code the desktop believes is short-lived; a restart instead
   * cancels the pending credential below.
   */
  private readonly secrets = new Map<string, string>();
  /** Live connection state (this process only); a reopen starts offline. */
  private connection: { status: GatewayStatus; connectedAt?: string; lastError?: string } = { status: "offline" };
  /** Recent request timestamps per device, for the Gateway rate limit. */
  private readonly attempts = new Map<string, string[]>();

  constructor(
    private readonly taskDir: string,
    private readonly store: RemoteDeviceStore,
    private readonly ports: RemoteDevicePorts,
  ) {
    const restored = store.readRemoteDevices(taskDir);
    this.deviceSequence = highestSequence(restored.devices.map((device) => device.deviceId), "device");
    this.pairingSequence = highestSequence(restored.pairing.map((pairing) => pairing.credentialId), "pair");
    this.auditSequence = highestSequence(restored.audits.map((audit) => audit.eventId), "audit");
    // A pending code from a previous process has no surviving secret, so it is
    // cancelled rather than left looking usable.
    const pairing = restored.pairing.map((item) => (item.state === "pending" ? { ...item, state: "cancelled" as const } : item));
    this.recordState = { ...restored, pairing };
    if (pairing.some((item, index) => item.state !== restored.pairing[index]?.state)) this.persist();
  }

  /** The persisted record (read-only copy). */
  get record(): RemoteDeviceDiskRecord {
    return {
      ...this.recordState,
      devices: this.recordState.devices.map((device) => cloneDevice(device)),
      pairing: this.recordState.pairing.map((item) => ({ ...item })),
      audits: this.recordState.audits.map((item) => ({ ...item })),
    };
  }

  /** Entry mode, live Gateway state and every device with its online reading. */
  state(): RemoteState {
    const definition = remoteEntryDefinition(this.recordState.entryMode);
    const plan = remoteEntryPlan(this.recordState.entryMode);
    const now = this.ports.now();
    const warning = remoteEntryWarning(this.recordState.entryMode);
    return {
      entry: {
        mode: definition.mode,
        label: definition.label,
        support: definition.support,
        hint: definition.hint,
        ...(warning === undefined ? {} : { warning }),
        listener: plan.listener,
        dialOut: plan.dialOut,
        baseUrl: this.recordState.entryBaseUrl,
      },
      gateway: this.gatewayState(),
      devices: this.recordState.devices.map((device) => ({ ...cloneDevice(device), online: deviceOnline({ device, at: now }) })),
    };
  }

  gatewayState(): GatewayState {
    return {
      entryMode: this.recordState.entryMode,
      endpoint: this.recordState.gateway.endpoint,
      hostId: this.recordState.gateway.hostId,
      status: this.connection.status,
      ...(this.connection.connectedAt === undefined ? {} : { connectedAt: this.connection.connectedAt }),
      ...(this.connection.lastError === undefined ? {} : { lastError: this.connection.lastError }),
    };
  }

  devices(): RemoteDeviceRecord[] {
    return this.recordState.devices.map(cloneDevice);
  }

  audits(): RemoteAuditEvent[] {
    return this.recordState.audits.map((item) => ({ ...item }));
  }

  /** 入口方式切换: same devices, same audit trail; only the route changes. */
  setEntryMode(mode: RemoteEntryMode, input: { endpoint?: string; hostId?: string; baseUrl?: string } = {}): RemoteState {
    remoteEntryDefinition(mode);
    this.recordState = {
      ...this.recordState,
      entryMode: mode,
      entryBaseUrl: input.baseUrl ?? this.recordState.entryBaseUrl,
      gateway: {
        endpoint: input.endpoint ?? this.recordState.gateway.endpoint,
        hostId: input.hostId ?? this.recordState.gateway.hostId,
      },
    };
    // A different route is a different connection: the old one is not reused.
    this.connection = { status: "offline" };
    this.audit("gateway-disconnected", `切换到 ${mode}`, { entryMode: mode });
    this.persist();
    return this.state();
  }

  /** Desktop generates the QR code (盒子 1); the previous pending code dies. */
  mintPairing(input: { ttlMs?: number } = {}): RemoteOpResult<PairingPresentation> {
    const at = this.ports.now();
    const previous = this.recordState.pairing[this.recordState.pairing.length - 1];
    if (previous?.state === "pending") {
      // The rule invalidates the old credential and the live secret is dropped
      // with it, so a scan of the old QR code can neither match nor exchange.
      this.secrets.delete(previous.credentialId);
      const invalidated = invalidatePairingCredential({ ...previous, secret: "" }, "refreshed");
      this.recordState = {
        ...this.recordState,
        pairing: this.recordState.pairing.map((item) => (item.credentialId === previous.credentialId ? toDiskPairing(invalidated) : item)),
      };
      this.persist();
      this.audit("pairing-refreshed", `旧配对凭据 ${previous.credentialId} 失效`, {});
    }
    const credentialId = `pair-${(this.pairingSequence += 1)}`;
    const secret = this.ports.mintSecret("pairing");
    let credential: PairingCredential;
    try {
      credential = mintPairingCredential({ credentialId, secret, at, ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }) });
    } catch (error) {
      this.pairingSequence -= 1;
      return { ok: false, code: "mint-failed", message: error instanceof Error ? error.message : String(error) };
    }
    this.secrets.set(credentialId, secret);
    this.recordState = {
      ...this.recordState,
      pairing: [...this.recordState.pairing, toDiskPairing(credential)].slice(-REMOTE_PAIRING_HISTORY_LIMIT),
    };
    this.audit("pairing-minted", `生成配对凭据 ${credentialId}，有效期至 ${credential.expiresAt}`, {});
    this.persist();
    return {
      ok: true,
      payload: {
        credentialId,
        secret,
        url: pairingUrl({ baseUrl: this.recordState.entryBaseUrl, credentialId }),
        issuedAt: credential.issuedAt,
        expiresAt: credential.expiresAt,
      },
    };
  }

  /** The desktop closed the QR code without pairing: the code is dead. */
  cancelPairing(): RemoteOpResult<{ cancelled: boolean }> {
    const previous = this.recordState.pairing[this.recordState.pairing.length - 1];
    if (previous === undefined || previous.state !== "pending") return { ok: true, payload: { cancelled: false } };
    this.secrets.delete(previous.credentialId);
    const invalidated = invalidatePairingCredential({ ...previous, secret: "" }, "cancelled");
    this.recordState = {
      ...this.recordState,
      pairing: this.recordState.pairing.map((item) => (item.credentialId === previous.credentialId ? toDiskPairing(invalidated) : item)),
    };
    this.audit("pairing-refused", `取消配对凭据 ${previous.credentialId}`, {});
    this.persist();
    return { ok: true, payload: { cancelled: true } };
  }

  /**
   * The phone exchanges the scanned code (盒子 1). The result is a device that
   * still waits for the desktop: the exchange alone grants nothing.
   */
  exchange(input: { credentialId: string; secret: string; deviceName: string; permissions: readonly unknown[] }): RemoteOpResult<{ device: RemoteDeviceRecord }> {
    const at = this.ports.now();
    const stored = this.recordState.pairing.find((item) => item.credentialId === input.credentialId);
    const liveSecret = this.secrets.get(input.credentialId);
    if (stored === undefined) return this.refusePairing("credential-cancelled", "配对凭据不存在或已失效");
    // The refusal state comes first: a used, expired or refreshed code is refused
    // for that reason whatever secret the caller holds.
    const verdict = pairingCredentialVerdict({ ...stored, secret: "" }, at);
    if (!verdict.ok) return this.refusePairing(verdict.code, verdict.message);
    // The credential id alone is visible in the QR URL, so the exchange must also
    // prove it holds the secret the desktop minted.
    if (liveSecret === undefined || input.secret !== liveSecret) {
      return this.refusePairing("credential-mismatch", "配对凭据不匹配");
    }
    const credential: PairingCredential = { ...stored, secret: liveSecret };
    const exchanged = exchangePairingCredential({
      credential,
      at,
      deviceId: `device-${this.deviceSequence + 1}`,
      deviceName: input.deviceName,
      requestedPermissions: input.permissions,
    });
    if (!exchanged.ok) return this.refusePairing(exchanged.code, exchanged.message);
    this.deviceSequence += 1;
    // The live secret is spent with the credential: a second exchange fails on
    // the persisted `used` state even before the secret check.
    this.secrets.delete(input.credentialId);
    const device: RemoteDeviceRecord = { ...exchanged.device, pairingCredentialId: input.credentialId };
    this.recordState = {
      ...this.recordState,
      devices: [...this.recordState.devices, device],
      pairing: this.recordState.pairing.map((item) => (item.credentialId === input.credentialId ? toDiskPairing(exchanged.credential) : item)),
    };
    this.audit("pairing-used", `配对凭据 ${input.credentialId} 已使用，设备 ${device.deviceId} 等待本机确认`, { deviceId: device.deviceId });
    this.persist();
    return { ok: true, payload: { device: cloneDevice(device) } };
  }

  /** Desktop confirms the device name and permissions and issues its credential. */
  confirm(deviceId: string, confirmedPermissions?: readonly unknown[]): RemoteOpResult<{ device: RemoteDeviceRecord }> {
    const device = this.find(deviceId);
    if (device === undefined) return { ok: false, code: "unknown-device", message: `设备 ${deviceId} 不存在` };
    const result = confirmDevice({
      device,
      at: this.ports.now(),
      credentialId: this.ports.mintSecret("device"),
      ...(confirmedPermissions === undefined ? {} : { confirmedPermissions }),
    });
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    this.replace(result.device);
    this.audit("device-confirmed", `本机确认设备 ${deviceId}（${result.device.permissions.join("/")}）`, { deviceId });
    return { ok: true, payload: { device: cloneDevice(result.device) } };
  }

  reject(deviceId: string): RemoteOpResult<{ device: RemoteDeviceRecord }> {
    const device = this.find(deviceId);
    if (device === undefined) return { ok: false, code: "unknown-device", message: `设备 ${deviceId} 不存在` };
    const rejected = rejectDevice({ device, at: this.ports.now() });
    this.replace(rejected);
    this.audit("device-rejected", `本机拒绝设备 ${deviceId}`, { deviceId });
    return { ok: true, payload: { device: cloneDevice(rejected) } };
  }

  revoke(deviceId: string): RemoteOpResult<{ device: RemoteDeviceRecord }> {
    const device = this.find(deviceId);
    if (device === undefined) return { ok: false, code: "unknown-device", message: `设备 ${deviceId} 不存在` };
    const revoked = revokeRemoteDevice({ device, at: this.ports.now() });
    this.replace(revoked);
    this.attempts.delete(deviceId);
    this.audit("device-revoked", `撤销设备 ${deviceId}，现有连接与后续请求均失效`, { deviceId });
    return { ok: true, payload: { device: cloneDevice(revoked) } };
  }

  rotate(deviceId: string): RemoteOpResult<{ device: RemoteDeviceRecord }> {
    const device = this.find(deviceId);
    if (device === undefined) return { ok: false, code: "unknown-device", message: `设备 ${deviceId} 不存在` };
    const rotated = rotateDeviceCredential({ device, at: this.ports.now(), credentialId: this.ports.mintSecret("device") });
    if (!rotated.ok) return { ok: false, code: rotated.code, message: rotated.message };
    this.replace(rotated.device);
    this.audit("device-rotated", `轮换设备 ${deviceId} 凭据（第 ${rotated.device.credential?.generation ?? 0} 代）`, { deviceId });
    return { ok: true, payload: { device: cloneDevice(rotated.device) } };
  }

  /**
   * Decide one remote request (盒子 2/4/5). Reachability is never enough: the
   * entry plan requires PiDock authorization, the device must be confirmed and
   * hold the surface's permission, the op must be on the allow-list, the Gateway
   * must report this host online, and the device's request rate must be within
   * the window. Every decision is audited.
   */
  authorize(input: { deviceId: string; op: string }): RemoteOpResult<{ verdict: RemoteRequestVerdict; permission: string | null }> {
    const at = this.ports.now();
    const device = this.find(input.deviceId);
    if (device === undefined) {
      this.audit("request-denied", `未知设备 ${input.deviceId} 请求 ${input.op}`, { deviceId: input.deviceId });
      return { ok: false, code: "device-unknown", message: `设备 ${input.deviceId} 不存在` };
    }
    if (this.recordState.entryMode === "gateway") {
      const gateway = authorizeRemoteGateway({ state: this.gatewayState(), hostId: this.recordState.gateway.hostId });
      if (gateway.decision === "deny") {
        this.audit("request-denied", `Gateway 不可用：${gateway.message}`, { deviceId: input.deviceId });
        return { ok: false, code: gateway.code, message: gateway.message };
      }
    }
    const rate = rateLimitVerdict({ attempts: this.attempts.get(input.deviceId) ?? [], at });
    if (!rate.allowed) {
      this.audit("rate-limited", `设备 ${input.deviceId} 超过请求限流（${rate.retryAfterMs}ms 后重试）`, { deviceId: input.deviceId });
      return { ok: false, code: "rate-limited", message: `请求过于频繁，请在 ${Math.ceil(rate.retryAfterMs / 1000)} 秒后重试` };
    }
    const verdict = authorizeRemoteOp({ device, op: input.op, now: at });
    if (verdict.decision === "deny") {
      this.audit("request-denied", `拒绝设备 ${input.deviceId} 的 ${input.op}：${verdict.message}`, { deviceId: input.deviceId });
      return { ok: false, code: verdict.code, message: verdict.message };
    }
    // Keep only the live window: the rate limit needs the recent attempts, and a
    // long-lived Host must not grow one timestamp per allowed request forever.
    this.attempts.set(input.deviceId, [...(this.attempts.get(input.deviceId) ?? []), at].slice(-GATEWAY_RATE_LIMIT.maxRequests));
    this.replace({ ...device, lastSeenAt: at });
    this.audit("request-allowed", `允许设备 ${input.deviceId} 的 ${input.op}${verdict.requiresConfirmation ? "（需再次确认）" : ""}`, { deviceId: input.deviceId });
    return { ok: true, payload: { verdict, permission: device.permissions.join("/") } };
  }

  /** The reconnect plan for one device: uncertain requests are never replayed. */
  reconnectPlan(deviceId: string, pending: readonly RemotePendingRequest[], deliveredKeys: readonly string[]): RemoteOpResult<ReturnType<typeof planReconnectDelivery>> {
    const device = this.find(deviceId);
    if (device === undefined) return { ok: false, code: "unknown-device", message: `设备 ${deviceId} 不存在` };
    const plan = planReconnectDelivery({ pending, deliveredKeys, at: this.ports.now() });
    for (const item of plan.discard) this.audit("request-denied", `不重放设备 ${deviceId} 的 ${item.request.op}：${item.message}`, { deviceId });
    if (plan.discard.length > 0) this.persist();
    return { ok: true, payload: plan };
  }

  /** Main reports what the outbound Gateway connection did (盒子 3). */
  gatewayEvent(input: { action: "connected" | "disconnected"; error?: string }): RemoteOpResult<{ gateway: GatewayState }> {
    if (input.action === "connected") {
      this.connection = { status: "online", connectedAt: this.ports.now() };
      this.audit("gateway-connected", `主机 ${this.recordState.gateway.hostId || "(未配置)"} 已连接 Gateway`, { entryMode: this.recordState.entryMode });
    } else {
      this.connection = { status: "offline", ...(input.error === undefined ? {} : { lastError: input.error }) };
      this.audit("gateway-disconnected", `Gateway 连接断开${input.error === undefined ? "" : `：${input.error}`}`, { entryMode: this.recordState.entryMode });
    }
    this.persist();
    return { ok: true, payload: { gateway: this.gatewayState() } };
  }

  private refusePairing(code: string, message: string): RemoteOpResult<never> {
    this.audit("pairing-refused", `配对失败（${code}）：${message}`, {});
    this.persist();
    return { ok: false, code, message };
  }

  private find(deviceId: string): RemoteDeviceRecord | undefined {
    const device = this.recordState.devices.find((item) => item.deviceId === deviceId);
    return device === undefined ? undefined : cloneDevice(device);
  }

  private replace(device: RemoteDeviceRecord): void {
    this.recordState = {
      ...this.recordState,
      devices: this.recordState.devices.map((item) => (item.deviceId === device.deviceId ? cloneDevice(device) : item)),
    };
    this.persist();
  }

  private audit(kind: RemoteAuditKind, detail: string, options: { deviceId?: string; entryMode?: RemoteEntryMode }): void {
    const event = remoteAuditEvent({
      eventId: `audit-${(this.auditSequence += 1)}`,
      at: this.ports.now(),
      kind,
      detail,
      ...(options.deviceId === undefined ? {} : { deviceId: options.deviceId }),
      ...(options.entryMode === undefined ? {} : { entryMode: options.entryMode }),
    });
    this.recordState = { ...this.recordState, audits: [...this.recordState.audits, event].slice(-REMOTE_AUDIT_HISTORY_LIMIT) };
  }

  private persist(): void {
    this.store.writeRemoteDevices(this.taskDir, this.recordState);
  }
}

function toDiskPairing(credential: PairingCredential): PairingCredentialDiskRecord {
  return {
    credentialId: credential.credentialId,
    issuedAt: credential.issuedAt,
    expiresAt: credential.expiresAt,
    state: credential.state,
    ...(credential.usedAt === undefined ? {} : { usedAt: credential.usedAt }),
  };
}

function cloneDevice(device: RemoteDeviceRecord): RemoteDeviceRecord {
  return {
    ...device,
    permissions: [...device.permissions],
    ...(device.credential === undefined ? {} : { credential: { ...device.credential } }),
  };
}
