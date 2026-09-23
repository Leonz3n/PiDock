import { describe, expect, it } from "vitest";
import {
  authorizeRemoteGateway,
  authorizeRemoteOp,
  confirmDevice,
  DEVICE_ONLINE_WINDOW_MS,
  deviceOnline,
  deviceStatusLabel,
  effectiveRemoteSessionPermission,
  exchangePairingCredential,
  GATEWAY_RATE_LIMIT,
  isHighEntropySecret,
  invalidatePairingCredential,
  mintPairingCredential,
  mobileSurfaceForOp,
  normalizeRemotePermissions,
  PAIRING_CREDENTIAL_TTL_MS,
  pairingCredentialVerdict,
  pairingUrl,
  pairingUrlVerdict,
  planReconnectDelivery,
  rateLimitVerdict,
  redactRemoteDetail,
  rejectDevice,
  remoteApprovalView,
  remoteAuditEvent,
  remoteEntryDefinition,
  remoteEntryPlan,
  remoteEntryWarning,
  revokeRemoteDevice,
  rotateDeviceCredential,
  type RemoteDeviceRecord,
  type RemotePendingRequest,
} from "./remote-rules.js";

const SECRET = "pair7Kd93mQxT2vLpR8sN4wZbY6cH1jF5gA";
const AT = "2026-09-23T01:20:00.000Z";
const LATER = "2026-09-23T01:31:00.000Z";

function activeDevice(overrides: Partial<RemoteDeviceRecord> = {}): RemoteDeviceRecord {
  return {
    deviceId: "device-1",
    name: "iPhone 16 Pro",
    status: "active",
    permissions: ["overview", "chat"],
    requestedAt: AT,
    confirmedAt: AT,
    pairedAt: AT,
    lastSeenAt: AT,
    credential: { credentialId: "device-cred-1", generation: 1, issuedAt: AT },
    ...overrides,
  };
}

describe("[PiDock 19] remote entry modes", () => {
  it("keeps the Host on loopback and never proxies raw TCP or pi RPC", () => {
    for (const mode of ["tailscale", "gateway", "funnel"] as const) {
      const plan = remoteEntryPlan(mode);
      expect(plan.listener).toBe("127.0.0.1:4318");
      expect(plan.rawTcp).toBe(false);
      expect(plan.piRpcExposed).toBe(false);
      expect(plan.requiresPiDockAuthorization).toBe(true);
      expect(plan.rateLimitRequired).toBe(true);
      expect(plan.auditRequired).toBe(true);
    }
    // The Gateway is the only mode the Host dials out to; nothing accepts a
    // public inbound connection on this machine.
    expect(remoteEntryPlan("gateway").dialOut).toBe(true);
    expect(remoteEntryPlan("tailscale").dialOut).toBe(false);
    expect(remoteEntryDefinition("tailscale").transport).toBe("loopback-listener");
  });

  it("marks only Funnel as experimental, public and risky", () => {
    expect(remoteEntryDefinition("funnel")).toMatchObject({ support: "experimental", publiclyReachable: true });
    expect(remoteEntryDefinition("tailscale")).toMatchObject({ support: "supported", publiclyReachable: false, requiresPeerClient: true });
    expect(remoteEntryDefinition("gateway")).toMatchObject({ support: "supported", requiresPeerClient: false });
    expect(remoteEntryWarning("funnel")).toContain("可达不等于通过认证");
    expect(remoteEntryWarning("tailscale")).toBeUndefined();
    expect(remoteEntryWarning("gateway")).toBeUndefined();
  });
});

describe("[PiDock 19] pairing credential", () => {
  it("mints a short-lived high-entropy credential and refuses reuse or expiry", () => {
    const credential = mintPairingCredential({ credentialId: "pair-1", secret: SECRET, at: AT });
    expect(credential).toMatchObject({ state: "pending", issuedAt: AT, expiresAt: new Date(Date.parse(AT) + PAIRING_CREDENTIAL_TTL_MS).toISOString() });
    expect(pairingCredentialVerdict(credential, LATER)).toMatchObject({ ok: false, code: "credential-expired" });
    expect(pairingCredentialVerdict(credential, AT)).toEqual({ ok: true });
    expect(() => mintPairingCredential({ credentialId: "pair-2", secret: "short", at: AT })).toThrow(/高熵/);
    expect(isHighEntropySecret(SECRET)).toBe(true);
    expect(isHighEntropySecret("/Users/adber/token=abcdefghijklmnopqrstuvwxyz012345")).toBe(false);
  });

  it("exchanges once and produces a pending device that still needs the desktop", () => {
    const credential = mintPairingCredential({ credentialId: "pair-1", secret: SECRET, at: AT });
    const exchange = exchangePairingCredential({
      credential,
      at: AT,
      deviceId: "device-3",
      deviceName: "Pixel 9",
      requestedPermissions: ["overview", "terminal", "overview", "unknown-permission"],
    });
    expect(exchange).toMatchObject({ ok: false, code: "invalid-permissions" });
    const good = exchangePairingCredential({ credential, at: AT, deviceId: "device-3", deviceName: "Pixel 9", requestedPermissions: ["terminal", "overview", "overview"] });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    // Canonical order, single use, and no authorization before the desktop confirms.
    expect(good.device).toMatchObject({ status: "pending-confirmation", permissions: ["overview", "terminal"], name: "Pixel 9" });
    expect(good.credential).toMatchObject({ state: "used", usedAt: AT });
    expect(exchangePairingCredential({ credential: good.credential, at: AT, deviceId: "device-4", deviceName: "Pixel 9", requestedPermissions: [] })).toMatchObject({
      ok: false,
      code: "credential-used",
    });
    expect(authorizeRemoteOp({ device: good.device, op: "task/sessionStates", now: AT })).toMatchObject({ decision: "deny", code: "awaiting-desktop-confirmation" });
  });

  it("invalidates the old code when the desktop refreshes the QR", () => {
    const first = mintPairingCredential({ credentialId: "pair-1", secret: SECRET, at: AT });
    const refreshed = invalidatePairingCredential(first, "refreshed");
    expect(refreshed).toMatchObject({ credentialId: "pair-1", state: "refreshed" });
    expect(pairingCredentialVerdict(refreshed, AT)).toMatchObject({ ok: false, code: "credential-refreshed" });
    // Only a live credential can be invalidated: a spent or already-refused one
    // keeps its own state instead of being rewritten.
    expect(() => invalidatePairingCredential(refreshed, "cancelled")).toThrow(/只有待使用/);
    expect(pairingCredentialVerdict(invalidatePairingCredential(first, "cancelled"), AT)).toMatchObject({ ok: false, code: "credential-cancelled" });
  });

  it("keeps the QR payload in the fragment and out of paths or long tokens", () => {
    const url = pairingUrl({ baseUrl: "https://host.tailnet.ts.net/", credentialId: "pair-1" });
    expect(url).toBe("https://host.tailnet.ts.net/#pairing=pair-1");
    expect(pairingUrlVerdict(url)).toEqual({ ok: true });
    expect(pairingUrlVerdict("https://h/#pairing=1?token=abc")).toMatchObject({ ok: false, code: "query-not-fragment" });
    expect(pairingUrlVerdict("https://h?pairing=1")).toMatchObject({ ok: false, code: "query-not-fragment" });
    expect(pairingUrlVerdict("https://h/#pairing=/Users/adber/project")).toMatchObject({ ok: false, code: "local-path" });
    expect(pairingUrlVerdict("https://h/#pairing=apikey=abcdef")).toMatchObject({ ok: false, code: "secret-like-value" });
    expect(pairingUrlVerdict("https://h/")).toMatchObject({ ok: false, code: "not-fragment" });
  });
});

describe("[PiDock 19] device credentials", () => {
  it("issues the credential only on desktop confirmation and can narrow permissions", () => {
    const pending: RemoteDeviceRecord = { deviceId: "device-3", name: "Pixel 9", status: "pending-confirmation", permissions: ["overview", "chat", "manage"], requestedAt: AT };
    expect(confirmDevice({ device: pending, at: AT, credentialId: "c1", confirmedPermissions: ["overview", "nope"] })).toMatchObject({ ok: false, code: "invalid-permissions" });
    const confirmed = confirmDevice({ device: pending, at: AT, credentialId: "c1", confirmedPermissions: ["chat", "overview"] });
    expect(confirmed).toMatchObject({ ok: true });
    if (!confirmed.ok) return;
    expect(confirmed.device).toMatchObject({ status: "active", permissions: ["overview", "chat"], credential: { credentialId: "c1", generation: 1 } });
    expect(confirmDevice({ device: confirmed.device, at: AT, credentialId: "c2" })).toMatchObject({ ok: false, code: "not-pending" });
    expect(rejectDevice({ device: pending, at: AT })).toMatchObject({ status: "revoked", permissions: [] });
  });

  it("rotates to a new generation and revokes every grant", () => {
    const device = activeDevice();
    const rotated = rotateDeviceCredential({ device, at: LATER, credentialId: "c2" });
    expect(rotated).toMatchObject({ ok: true, device: { credential: { credentialId: "c2", generation: 2, rotatedAt: LATER, revokedAt: AT } } });
    if (!rotated.ok) return;
    // The previous generation is gone: nothing keeps the old value usable.
    expect(rotated.device.credential?.credentialId).not.toBe("device-cred-1");
    expect(rotateDeviceCredential({ device: { ...device, status: "revoked" }, at: LATER, credentialId: "c3" })).toMatchObject({ ok: false, code: "not-active" });
    const revoked = revokeRemoteDevice({ device: rotated.device, at: LATER });
    expect(revoked).toMatchObject({ status: "revoked", permissions: [], credential: { revokedAt: LATER } });
    expect(authorizeRemoteOp({ device: revoked, op: "task/sessionStates", now: LATER })).toMatchObject({ decision: "deny", code: "device-revoked" });
  });
});

describe("[PiDock 19] remote request surface", () => {
  it("exposes only the declared ops and requires the surface permission", () => {
    expect(mobileSurfaceForOp("task/sessionStates")).toBe("overview");
    expect(mobileSurfaceForOp("task/approve")).toBe("approvals");
    expect(mobileSurfaceForOp("task/provision")).toBeNull();
    expect(mobileSurfaceForOp("task/setPermission")).toBeNull();
    expect(mobileSurfaceForOp("task/terminalControl")).toBe("terminal");
    const device = activeDevice();
    // A view+chat device may chat and approve, but not touch files or terminal.
    expect(authorizeRemoteOp({ device, op: "task/sendMessage", now: AT })).toMatchObject({ decision: "allow", requiresConfirmation: false });
    expect(authorizeRemoteOp({ device, op: "task/approve", now: AT })).toMatchObject({ decision: "allow" });
    expect(authorizeRemoteOp({ device, op: "task/fileTree", now: AT })).toMatchObject({ decision: "deny", code: "permission-not-granted" });
    expect(authorizeRemoteOp({ device, op: "task/terminalControl", now: AT })).toMatchObject({ decision: "deny", code: "permission-not-granted" });
    expect(authorizeRemoteOp({ device, op: "task/archive", now: AT })).toMatchObject({ decision: "deny", code: "permission-not-granted" });
    // Every op outside the allow-list is unavailable whatever the device holds.
    const everything = activeDevice({ permissions: ["overview", "chat", "manage", "files", "terminal"] });
    expect(authorizeRemoteOp({ device: everything, op: "task/setPermission", now: AT })).toMatchObject({ decision: "deny", code: "not-available-remotely" });
    // Sensitive surfaces ask again for every action.
    expect(authorizeRemoteOp({ device: everything, op: "task/filePreview", now: AT })).toMatchObject({ decision: "allow", requiresConfirmation: true });
    expect(authorizeRemoteOp({ device: everything, op: "task/archive", now: AT })).toMatchObject({ decision: "allow", requiresConfirmation: true });
    expect(normalizeRemotePermissions(["terminal", "overview", "overview"])).toEqual(["overview", "terminal"]);
    expect(normalizeRemotePermissions(["nope"])).toBeNull();
  });

  it("never widens the desktop session permission", () => {
    const viewOnly = activeDevice({ permissions: ["overview"] });
    const chatty = activeDevice();
    expect(effectiveRemoteSessionPermission({ device: viewOnly, sessionPermission: "auto" })).toBe("read");
    expect(effectiveRemoteSessionPermission({ device: chatty, sessionPermission: "auto" })).toBe("default");
    expect(effectiveRemoteSessionPermission({ device: chatty, sessionPermission: "default" })).toBe("default");
    expect(effectiveRemoteSessionPermission({ device: chatty, sessionPermission: "read" })).toBe("read");
  });

  it("refuses while the gateway says the host is offline or a different host", () => {
    const state = { entryMode: "gateway" as const, endpoint: "wss://gw.example.com", hostId: "host-1", status: "online" as const };
    expect(authorizeRemoteGateway({ state, hostId: "host-1" })).toMatchObject({ decision: "allow" });
    expect(authorizeRemoteGateway({ state, hostId: "host-2" })).toMatchObject({ decision: "deny", code: "host-mismatch" });
    expect(authorizeRemoteGateway({ state: { ...state, status: "offline" }, hostId: "host-1" })).toMatchObject({ decision: "deny", code: "host-offline" });
  });

  it("shows the desktop approval's real fields and drops the actions when settled", () => {
    const approval = { id: "approval-1", title: "部署到 Staging", target: "deploy.sh staging", contentVersion: "v3", scope: "service-control", status: "pending" };
    const view = remoteApprovalView({ approval, device: activeDevice() });
    expect(view).toMatchObject({ approvalId: "approval-1", title: "部署到 Staging", target: "deploy.sh staging", payloadVersion: "v3", scope: "service-control" });
    expect(view.impact).toContain("deploy.sh staging");
    expect(view.actions).toEqual(["approve", "reject"]);
    expect(remoteApprovalView({ approval: { ...approval, status: "expired" }, device: activeDevice() }).actions).toEqual([]);
    expect(remoteApprovalView({ approval, device: activeDevice({ permissions: ["overview"] }) }).actions).toEqual([]);
    expect(remoteApprovalView({ approval, device: activeDevice({ status: "revoked", permissions: [] }) }).actions).toEqual([]);
  });
});

describe("[PiDock 19] gateway state, rate limit and online display", () => {
  it("limits the gateway request rate per window", () => {
    expect(GATEWAY_RATE_LIMIT).toMatchObject({ windowMs: 60_000, maxRequests: 60 });
    const attempts = Array.from({ length: 60 }, (_, index) => new Date(Date.parse(AT) - index * 1000).toISOString());
    expect(rateLimitVerdict({ attempts: attempts.slice(0, 59), at: AT })).toMatchObject({ allowed: true, remaining: 0, retryAfterMs: 0 });
    const denied = rateLimitVerdict({ attempts, at: AT });
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    // Attempts outside the window do not count and are never "replayed" later.
    expect(rateLimitVerdict({ attempts, at: new Date(Date.parse(AT) + 120_000).toISOString() })).toMatchObject({ allowed: true });
  });

  it("labels a device offline as soon as the last observation is stale", () => {
    const device = activeDevice();
    expect(deviceOnline({ device, at: LATER })).toBe(false);
    expect(deviceOnline({ device, at: new Date(Date.parse(AT) + DEVICE_ONLINE_WINDOW_MS - 1000).toISOString() })).toBe(true);
    expect(deviceOnline({ device: activeDevice({ lastSeenAt: undefined }), at: AT })).toBe(false);
    expect(deviceOnline({ device: activeDevice({ status: "revoked" }), at: AT })).toBe(false);
    expect(deviceStatusLabel(activeDevice())).toBe("有效");
    expect(deviceStatusLabel(activeDevice({ status: "pending-confirmation" }))).toBe("等待本机确认");
    expect(deviceStatusLabel(activeDevice({ status: "revoked" }))).toBe("已撤销");
  });
});

describe("[PiDock 19] reconnect delivery", () => {
  const SOON = new Date(Date.parse(AT) + 60_000).toISOString();

  function pending(overrides: Partial<RemotePendingRequest> = {}): RemotePendingRequest {
    return { idempotencyKey: "key-1", op: "task/sendMessage", state: "queued", queuedAt: AT, ...overrides };
  }

  it("never replays an uncertain or stale request and drops duplicates", () => {
    const plan = planReconnectDelivery({
      pending: [
        pending(),
        pending({ idempotencyKey: "key-2", state: "uncertain" }),
        pending({ idempotencyKey: "key-3", state: "delivered" }),
        pending({ idempotencyKey: "key-4", queuedAt: "2026-09-22T20:00:00.000Z" }),
      ],
      deliveredKeys: ["key-5"],
      at: SOON,
    });
    expect(plan.deliver.map((item) => item.idempotencyKey)).toEqual(["key-1"]);
    expect(plan.discard.map((item) => item.code)).toEqual(["unknown-external", "stale"]);
    expect(plan.duplicate.map((item) => item.idempotencyKey)).toEqual(["key-3"]);
    const duplicateOfDelivered = planReconnectDelivery({ pending: [pending({ idempotencyKey: "key-5" })], deliveredKeys: ["key-5"], at: SOON });
    expect(duplicateOfDelivered.deliver).toEqual([]);
    expect(duplicateOfDelivered.duplicate).toHaveLength(1);
    // The same key inside one batch is delivered once, not twice.
    const twice = planReconnectDelivery({ pending: [pending(), pending()], deliveredKeys: [], at: SOON });
    expect(twice.deliver).toHaveLength(1);
    expect(twice.duplicate).toHaveLength(1);
  });
});

describe("[PiDock 19] audit redaction", () => {
  it("redacts paths, secrets and long opaque values", () => {
    const detail = redactRemoteDetail(`拒绝 ${"/Users/adber/workspace/secret"}; token=abc123; opaque ${"A".repeat(40)}`);
    expect(detail).toContain("<path>");
    expect(detail).toContain("token=<redacted>");
    expect(detail).not.toContain("abc123");
    expect(detail).not.toContain("/Users/adber");
    expect(detail).not.toContain("A".repeat(40));
    const event = remoteAuditEvent({ eventId: "audit-1", at: AT, kind: "request-denied", detail: `secret=zzz ${"/home/x/y"}`, deviceId: "device-1", entryMode: "gateway" });
    expect(event).toMatchObject({ eventId: "audit-1", kind: "request-denied", deviceId: "device-1", entryMode: "gateway" });
    expect(event.detail).not.toContain("zzz");
    expect(() => remoteAuditEvent({ eventId: "", at: AT, kind: "request-denied", detail: "x" })).toThrow(/eventId/);
  });
});
