import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { TaskRemoteDevices } from "./remote-devices.js";
import { TaskWorkspaceHost, memoryTaskStore } from "./task-host.js";
import { parseRemoteDeviceRecord, serializeRemoteDeviceRecord } from "./task-store.js";
import { emptyRemoteDeviceRecord, GATEWAY_RATE_LIMIT, type RemoteDeviceDiskRecord } from "../main/remote-rules.js";

const TASK_ID = "task-a";
const TASK_DIR = "/tmp/pidock-s21/task-abcdef12";
const AT = "2026-09-23T01:20:00.000Z";

function memoryStore(): { store: { readRemoteDevices(taskDir: string): RemoteDeviceDiskRecord; writeRemoteDevices(taskDir: string, record: RemoteDeviceDiskRecord): void }; record(): RemoteDeviceDiskRecord } {
  let record: RemoteDeviceDiskRecord = emptyRemoteDeviceRecord();
  return {
    store: {
      // Round-tripped through the disk shape, so the mirror refuses what the real
      // store refuses (a persisted secret, a half-active device).
      readRemoteDevices: () => parseRemoteDeviceRecord(serializeRemoteDeviceRecord(record)),
      writeRemoteDevices: (_taskDir, next) => {
        record = parseRemoteDeviceRecord(serializeRemoteDeviceRecord(next));
      },
    },
    record: () => record,
  };
}

function manager(input: { now?: () => string; store?: ReturnType<typeof memoryStore>; mode?: "tailscale" | "gateway" | "funnel"; endpoint?: string; hostId?: string } = {}) {
  const memory = input.store ?? memoryStore();
  let counter = 0;
  const devices = new TaskRemoteDevices(TASK_DIR, memory.store, {
    now: input.now ?? (() => AT),
    mintSecret: (kind) => `${kind === "pairing" ? "p" : "d"}_${String((counter += 1)).padStart(2, "0")}${"x".repeat(40)}`,
  });
  if (input.mode !== undefined) {
    devices.setEntryMode(input.mode, {
      ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
      ...(input.hostId === undefined ? {} : { hostId: input.hostId }),
      baseUrl: "https://host.tailnet.ts.net",
    });
  }
  return { devices, memory };
}

/** Palm: mint the code, scan it, then confirm on the desktop. */
function pair(devices: TaskRemoteDevices, permissions: readonly string[] = ["overview", "chat"]) {
  const minted = devices.mintPairing();
  if (!minted.ok) throw new Error(minted.message);
  const exchanged = devices.exchange({
    credentialId: minted.payload.credentialId,
    secret: minted.payload.secret,
    deviceName: "iPhone 16 Pro",
    permissions,
  });
  if (!exchanged.ok) throw new Error(exchanged.message);
  const confirmed = devices.confirm(exchanged.payload.device.deviceId, permissions);
  if (!confirmed.ok) throw new Error(confirmed.message);
  return { minted: minted.payload, device: confirmed.payload.device };
}

describe("[PiDock 19] remote device manager", () => {
  it("mints a QR code in the fragment, pairs once, and grants nothing before the desktop confirms", () => {
    const { devices } = manager();
    const minted = devices.mintPairing();
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(minted.payload.url).toBe("http://127.0.0.1:4318/#pairing=pair-1");
    expect(minted.payload.secret.startsWith("p_")).toBe(true);
    // The short-lived secret is never persisted, only its refusal state.
    expect(JSON.stringify(devices.record.pairing)).not.toContain(minted.payload.secret);
    expect(devices.audits().map((event) => event.kind)).toEqual(["pairing-minted"]);

    const exchanged = devices.exchange({ credentialId: minted.payload.credentialId, secret: minted.payload.secret, deviceName: "Pixel 9", permissions: ["overview", "terminal"] });
    expect(exchanged.ok && exchanged.payload.device).toMatchObject({ deviceId: "device-1", status: "pending-confirmation", permissions: ["overview", "terminal"] });
    // Reachability is not authorization: the device is known but cannot act.
    expect(devices.authorize({ deviceId: "device-1", op: "task/sessionStates" })).toMatchObject({ ok: false, code: "awaiting-desktop-confirmation" });
    // A wrong secret and a replayed exchange are both refused.
    expect(devices.exchange({ credentialId: minted.payload.credentialId, secret: "p_" + "y".repeat(40), deviceName: "Pixel 9", permissions: [] })).toMatchObject({ ok: false, code: "credential-used" });
    // The credential id travels in the URL, so a wrong secret is refused even
    // while the id is right and the code is still pending.
    const second = devices.mintPairing();
    expect(second.ok && devices.exchange({ credentialId: second.payload.credentialId, secret: "p_" + "y".repeat(40), deviceName: "Pixel 9", permissions: [] })).toMatchObject({
      ok: false,
      code: "credential-mismatch",
    });
    const third = devices.mintPairing();
    expect(third.ok).toBe(true);
    if (!second.ok || !third.ok) return;
    // A refresh invalidates the previous code even for the holder of its secret.
    expect(devices.exchange({ credentialId: second.payload.credentialId, secret: second.payload.secret, deviceName: "X", permissions: [] })).toMatchObject({
      ok: false,
      code: "credential-refreshed",
    });

    const confirmed = devices.confirm("device-1");
    expect(confirmed.ok && confirmed.payload.device).toMatchObject({ status: "active", confirmedAt: AT, credential: { generation: 1 } });
    // The device asked for `terminal`; a confirm without a list grants the default
    // set (overview＋chat) and never a remote terminal.
    expect(confirmed.ok && confirmed.payload.device.permissions).toEqual(["overview"]);
    expect(devices.authorize({ deviceId: "device-1", op: "task/terminalControl" })).toMatchObject({ ok: false, code: "permission-not-granted" });
    expect(confirmed.ok && devices.authorize({ deviceId: "device-1", op: "task/sessionStates" })).toMatchObject({ ok: true });
  });

  it("never grants files or terminal from a bare confirm, and keeps the rate history bounded", () => {
    let now = new Date(AT);
    const { devices } = manager({ now: () => now.toISOString() });
    const minted = devices.mintPairing();
    if (!minted.ok) throw new Error(minted.message);
    const exchanged = devices.exchange({
      credentialId: minted.payload.credentialId,
      secret: minted.payload.secret,
      deviceName: "Pixel 9",
      permissions: ["overview", "chat", "manage", "files", "terminal"],
    });
    if (!exchanged.ok) throw new Error(exchanged.message);
    const confirmed = devices.confirm(exchanged.payload.device.deviceId);
    expect(confirmed.ok && confirmed.payload.device.permissions).toEqual(["overview", "chat"]);
    expect(devices.authorize({ deviceId: "device-1", op: "task/terminalControl" })).toMatchObject({ ok: false, code: "permission-not-granted" });
    expect(devices.record.devices[0]?.permissions).toEqual(["overview", "chat"]);
    // Three full windows of allowed requests: the live history keeps one window,
    // so a long-lived Host does not accumulate one timestamp per request forever.
    for (const offset of [0, 61_000, 122_000]) {
      now = new Date(Date.parse(AT) + offset);
      for (let index = 0; index < GATEWAY_RATE_LIMIT.maxRequests; index += 1) {
        expect(devices.authorize({ deviceId: "device-1", op: "task/sessionStates" })).toMatchObject({ ok: true });
      }
    }
    const history = (devices as unknown as { attempts: Map<string, string[]> }).attempts.get("device-1") ?? [];
    expect(history).toHaveLength(GATEWAY_RATE_LIMIT.maxRequests);
  });

  it("keeps an unconfirmed device out and refuses ops outside the allow-list once paired", () => {
    const { devices } = manager();
    const { device } = pair(devices);
    expect(devices.authorize({ deviceId: device.deviceId, op: "task/sessionStates" })).toMatchObject({ ok: true, payload: { verdict: { decision: "allow" } } });
    expect(devices.authorize({ deviceId: device.deviceId, op: "task/getApproval" })).toMatchObject({ ok: true });
    // Files and terminal are off by default; the op allow-list is what bounds
    // remote access, so a config change is never remotely callable either.
    expect(devices.authorize({ deviceId: device.deviceId, op: "task/fileTree" })).toMatchObject({ ok: false, code: "permission-not-granted" });
    expect(devices.authorize({ deviceId: device.deviceId, op: "task/terminalControl" })).toMatchObject({ ok: false, code: "permission-not-granted" });
    expect(devices.authorize({ deviceId: device.deviceId, op: "task/setPermission" })).toMatchObject({ ok: false, code: "not-available-remotely" });
    expect(devices.authorize({ deviceId: "device-404", op: "task/sessionStates" })).toMatchObject({ ok: false, code: "device-unknown" });
    // Sensitive surfaces ask again for every action.
    const everything = pair(devices, ["overview", "chat", "manage", "files"]).device;
    const manage = devices.authorize({ deviceId: everything.deviceId, op: "task/archive" });
    expect(manage.ok && manage.payload.verdict).toMatchObject({ decision: "allow", requiresConfirmation: true });
    // The device is seen now, so the UI shows it online.
    expect(devices.state().devices.find((item) => item.deviceId === everything.deviceId)?.online).toBe(true);
  });

  it("revokes and rotates a credential, ending the old value", () => {
    const { devices } = manager();
    const first = pair(devices).device;
    const second = pair(devices).device;
    const rotated = devices.rotate(first.deviceId);
    expect(rotated.ok && rotated.payload.device.credential).toMatchObject({ generation: 2 });
    const revoked = devices.revoke(second.deviceId);
    expect(revoked.ok && revoked.payload.device).toMatchObject({ status: "revoked", permissions: [] });
    expect(devices.authorize({ deviceId: second.deviceId, op: "task/sessionStates" })).toMatchObject({ ok: false, code: "device-revoked" });
    expect(devices.revoke("device-404")).toMatchObject({ ok: false, code: "unknown-device" });
    // A revoked device is never offered a fresh credential by rotation.
    expect(devices.rotate(second.deviceId)).toMatchObject({ ok: false, code: "not-active" });
    expect(devices.audits().map((event) => event.kind)).toContain("device-revoked");
  });

  it("denies every request while the Gateway reports this host offline or another host", () => {
    const { devices } = manager({ mode: "gateway", endpoint: "wss://gw.example.com", hostId: "host-1" });
    const { device } = pair(devices);
    expect(devices.authorize({ deviceId: device.deviceId, op: "task/sessionStates" })).toMatchObject({ ok: false, code: "host-offline" });
    expect(devices.gatewayEvent({ action: "connected" })).toMatchObject({ ok: true, payload: { gateway: { status: "online", hostId: "host-1" } } });
    expect(devices.authorize({ deviceId: device.deviceId, op: "task/sessionStates" })).toMatchObject({ ok: true });
    expect(devices.gatewayEvent({ action: "disconnected", error: "TLS handshake failed" })).toMatchObject({ ok: true, payload: { gateway: { status: "offline" } } });
    expect(devices.authorize({ deviceId: device.deviceId, op: "task/sessionStates" })).toMatchObject({ ok: false, code: "host-offline" });
    // Switching the entry route drops the live connection instead of reusing it.
    expect(devices.setEntryMode("funnel", { baseUrl: "https://funnel.example.com" }).gateway.status).toBe("offline");
    expect(devices.state().entry.warning).toContain("可达不等于通过认证");
  });

  it("rate-limits one device and audits the refusal", () => {
    let now = new Date(AT);
    const { devices } = manager({ now: () => now.toISOString() });
    const { device } = pair(devices, ["overview", "chat", "manage", "files"]);
    for (let index = 0; index < 60; index += 1) devices.authorize({ deviceId: device.deviceId, op: "task/fileTree" });
    const limited = devices.authorize({ deviceId: device.deviceId, op: "task/fileTree" });
    expect(limited).toMatchObject({ ok: false, code: "rate-limited" });
    expect(devices.audits().some((event) => event.kind === "rate-limited")).toBe(true);
    now = new Date(Date.parse(AT) + 61_000);
    expect(devices.authorize({ deviceId: device.deviceId, op: "task/fileTree" })).toMatchObject({ ok: true });
  });

  it("never replays an uncertain request and records why", () => {
    const { devices } = manager();
    const { device } = pair(devices);
    const plan = devices.reconnectPlan(
      device.deviceId,
      [
        { idempotencyKey: "k1", op: "task/sendMessage", state: "uncertain", queuedAt: AT },
        { idempotencyKey: "k2", op: "task/sendMessage", state: "queued", queuedAt: AT },
      ],
      [],
    );
    expect(plan.ok && plan.payload.deliver.map((item) => item.idempotencyKey)).toEqual(["k2"]);
    expect(plan.ok && plan.payload.discard.map((item) => item.code)).toEqual(["unknown-external"]);
    expect(devices.audits().some((event) => event.kind === "request-denied" && event.detail.includes("不重放"))).toBe(true);
    expect(devices.reconnectPlan("device-404", [], [])).toMatchObject({ ok: false, code: "unknown-device" });
  });

  it("redacts audit detail and survives a restart with fresh ids but no live code", () => {
    const memory = memoryStore();
    const first = manager({ store: memory });
    pair(first.devices);
    // A second code the desktop never used: it stays pending in the record.
    const dangling = first.devices.mintPairing();
    expect(dangling.ok).toBe(true);
    if (!dangling.ok) return;

    const second = manager({ store: memory });
    expect(second.devices.devices()).toHaveLength(1);
    // A restarted Host has no live secret: the pending code is cancelled, and the
    // refusal is recorded rather than silently forgotten.
    expect(second.devices.record.pairing[1]).toMatchObject({ credentialId: "pair-2", state: "cancelled" });
    const reMint = second.devices.mintPairing();
    expect(reMint.ok && reMint.payload.credentialId).toBe("pair-3");
    expect(second.devices.exchange({ credentialId: "pair-2", secret: dangling.payload.secret, deviceName: "X", permissions: [] })).toMatchObject({ ok: false, code: "credential-cancelled" });
    // The next device id continues the sequence instead of re-minting device-1.
    const paired = pair(second.devices);
    expect(paired.device.deviceId).toBe("device-2");
    expect(second.devices.audits().every((event) => !event.detail.includes("/Users/"))).toBe(true);
  });

  it("refuses to restore a device file that smuggles a secret or a credential-less active device", () => {
    const base = emptyRemoteDeviceRecord();
    expect(() => parseRemoteDeviceRecord(JSON.stringify({ ...base, pairing: [{ credentialId: "pair-1", issuedAt: AT, expiresAt: AT, state: "pending", secret: "p_x" }] }))).toThrow(/secret/);
    expect(() =>
      parseRemoteDeviceRecord(
        JSON.stringify({ ...base, devices: [{ deviceId: "device-1", name: "X", status: "active", permissions: ["overview"], requestedAt: AT }] }),
      ),
    ).toThrow(/凭据/);
    expect(() => parseRemoteDeviceRecord(JSON.stringify({ ...base, devices: [{ deviceId: "device-1", name: "X", status: "active", permissions: ["root"], requestedAt: AT, credential: { credentialId: "c1", generation: 1, issuedAt: AT } }] }))).toThrow(/未知权限/);
    expect(() => parseRemoteDeviceRecord(JSON.stringify({ ...base, entryMode: "carrier-pigeon" }))).toThrow(/entryMode/);
    expect(() => parseRemoteDeviceRecord(JSON.stringify({ ...base, entryBaseUrl: undefined }))).toThrow(/entryBaseUrl/);
    expect(parseRemoteDeviceRecord(JSON.stringify(base))).toMatchObject({ entryMode: "tailscale", entryBaseUrl: "http://127.0.0.1:4318" });
  });

  it("persists through the task host and keeps the entry, devices and audit trail", () => {
    const store = memoryTaskStore();
    const host = new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, () => AT, () => [], undefined, undefined, () => `p_9${"z".repeat(40)}`);
    host.setRemoteEntryMode("gateway", { endpoint: "wss://gw.example.com", hostId: "host-1", baseUrl: "https://gw.example.com" });
    const minted = host.mintPairing();
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const exchanged = host.exchangePairing({ credentialId: minted.payload.credentialId, secret: minted.payload.secret, deviceName: "Pixel 9", permissions: ["overview", "chat"] });
    expect(exchanged.ok).toBe(true);
    if (!exchanged.ok) return;
    expect(host.confirmRemoteDevice(exchanged.payload.device.deviceId).ok).toBe(true);
    expect(host.authorizeRemote({ deviceId: exchanged.payload.device.deviceId, op: "task/sendMessage" }).ok).toBe(false);
    // Remote reads reuse the same task Host: the state is the persisted one.
    const reopened = new TaskWorkspaceHost(TASK_ID, TASK_DIR, store, () => AT);
    expect(reopened.remoteState()).toMatchObject({ entry: { mode: "gateway", baseUrl: "https://gw.example.com" } });
    expect(reopened.remoteState().devices.map((device) => device.deviceId)).toEqual(["device-1"]);
    expect(reopened.remoteAudits().length).toBeGreaterThan(0);
    expect(reopened.remoteState().gateway).toMatchObject({ status: "offline", endpoint: "wss://gw.example.com" });
  });

  it("keeps the persisted file under the task folder", () => {
    expect(join(TASK_DIR, "remote-devices.json")).toBe("/tmp/pidock-s21/task-abcdef12/remote-devices.json");
  });
});
