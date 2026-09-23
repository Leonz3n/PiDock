import { describe, expect, it } from "vitest";
import {
  REMOTE_ENTRY_ROWS,
  REMOTE_GATEWAY_STATUS_LABELS,
  REMOTE_PERMISSION_ROWS,
  canConfirmDevice,
  canRejectDevice,
  canRevokeDevice,
  canRotateDevice,
  isRemotePermission,
  normalizeRemotePermissions,
  remoteDeviceCredentialText,
  remoteDevicePermissionText,
  remoteDeviceSeenText,
  remoteDeviceStatusLabel,
  remoteDeviceStatusTone,
  remoteEntryRow,
  remoteEntryWarningText,
  remotePairingExpiryText,
  remotePairingIsLive,
  remotePairingStateLabel,
  remotePairingUrlIsSafe,
  remotePermissionLabel,
  remoteSurfacesFor,
} from "../data/remoteRules";
import type { RemoteDevice } from "../data/types";

function device(overrides: Partial<RemoteDevice> = {}): RemoteDevice {
  return {
    id: "device-1",
    name: "iPhone 16 Pro",
    status: "active",
    permissions: ["overview", "chat"],
    confirmedAt: "2026-09-15T20:00:00+08:00",
    lastSeen: "2026-09-22T08:12:00+08:00",
    credentialGeneration: 1,
    ...overrides,
  };
}

describe("remote mirror rules", () => {
  it("describes the three entry routes and marks only Funnel as experimental", () => {
    expect(REMOTE_ENTRY_ROWS.map((row) => row.mode)).toEqual(["tailscale", "gateway", "funnel"]);
    expect(remoteEntryRow("funnel")).toMatchObject({ experimental: true, publiclyReachable: true });
    expect(remoteEntryRow("gateway")).toMatchObject({ experimental: false, requiresPeerClient: false });
    expect(remoteEntryWarningText("funnel")).toContain("可达不等于通过认证");
    expect(remoteEntryWarningText("tailscale")).toBeUndefined();
    expect(REMOTE_GATEWAY_STATUS_LABELS.offline).toContain("不重放");
  });

  it("keeps files and terminal off by default and normalises permissions canonically", () => {
    expect(REMOTE_PERMISSION_ROWS.filter((row) => row.defaultOn).map((row) => row.permission)).toEqual(["overview", "chat"]);
    expect(REMOTE_PERMISSION_ROWS.filter((row) => row.perActionConfirmation).map((row) => row.permission)).toEqual(["manage", "files", "terminal"]);
    expect(normalizeRemotePermissions(["terminal", "overview", "overview", "nope"])).toEqual(["overview", "terminal"]);
    expect(isRemotePermission("chat")).toBe(true);
    expect(isRemotePermission("root")).toBe(false);
    expect(remotePermissionLabel("files")).toMatch(/文件和差异/);
  });

  it("labels the device state, permissions, credential and last-seen honestly", () => {
    expect(remoteDeviceStatusLabel(device())).toBe("有效");
    expect(remoteDeviceStatusLabel(device({ status: "pending-confirmation" }))).toBe("等待本机确认");
    expect(remoteDeviceStatusLabel(device({ status: "revoked" }))).toBe("已撤销");
    expect(remoteDeviceStatusTone(device({ status: "pending-confirmation" }))).toBe("warn");
    expect(remoteDevicePermissionText(device())).toBe("查看项目、任务和运行状态 / 查看会话并对话");
    expect(remoteDevicePermissionText(device({ status: "revoked", permissions: [] }))).toContain("已撤销");
    expect(remoteDeviceCredentialText(device())).toBe("设备凭据第 1 代");
    expect(remoteDeviceCredentialText(device({ status: "pending-confirmation", credentialGeneration: undefined }))).toBe("尚未签发设备凭据");
    expect(remoteDeviceSeenText(device())).toContain("最近在线 2026-09-22 08:12");
    expect(remoteDeviceSeenText(device({ lastSeen: undefined }))).toBe("从未在线");
  });

  it("offers confirming/rotating/revoking only where the Host would accept it", () => {
    expect(canConfirmDevice(device({ status: "pending-confirmation" }))).toBe(true);
    expect(canConfirmDevice(device())).toBe(false);
    expect(canRejectDevice(device({ status: "pending-confirmation" }))).toBe(true);
    expect(canRotateDevice(device())).toBe(true);
    expect(canRotateDevice(device({ status: "pending-confirmation" }))).toBe(false);
    expect(canRotateDevice(device({ status: "revoked" }))).toBe(false);
    expect(canRevokeDevice(device())).toBe(true);
    expect(canRevokeDevice(device({ status: "revoked" }))).toBe(false);
  });

  it("marks which remote surfaces a device may use, and never for a pending device", () => {
    const rows = remoteSurfacesFor(device());
    // View + chat surfaces are available; management, files and terminal are not.
    expect(rows.find((row) => row.label === "查看项目／任务／运行状态")?.available).toBe(true);
    expect(rows.find((row) => row.label === "处理待确认操作")?.available).toBe(true);
    expect(rows.find((row) => row.label === "归档历史")?.available).toBe(false);
    expect(rows.find((row) => row.label === "查看文件与差异")?.available).toBe(false);
    expect(rows.find((row) => row.label === "远程终端")?.available).toBe(false);
    // Sensitive surfaces stay per-action even when granted.
    expect(rows.find((row) => row.label === "远程终端")?.perActionConfirmation).toBe(true);
    const pending = remoteSurfacesFor(device({ status: "pending-confirmation", permissions: ["overview", "chat", "terminal"] }));
    expect(pending.every((row) => row.available === false)).toBe(true);
  });

  it("counts the pairing code down and refuses to imply a dead code is usable", () => {
    const at = "2026-09-22T08:00:00.000Z";
    const live = { credentialId: "pair-1", url: "https://host/#pairing=pair-1", issuedAt: at, expiresAt: "2026-09-22T08:10:00.000Z", state: "pending" as const };
    expect(remotePairingIsLive(live, at)).toBe(true);
    expect(remotePairingExpiryText(live, at)).toBe("剩余 10:00");
    expect(remotePairingExpiryText(live, "2026-09-22T08:09:30.000Z")).toBe("剩余 0:30");
    expect(remotePairingExpiryText(live, "2026-09-22T08:11:00.000Z")).toBe("已过期，请重新生成");
    expect(remotePairingIsLive({ ...live, state: "refreshed" }, at)).toBe(false);
    expect(remotePairingExpiryText({ ...live, state: "refreshed" }, at)).toBe("已被新二维码替换");
    expect(remotePairingStateLabel("cancelled")).toBe("已取消");
    expect(remotePairingIsLive(null, at)).toBe(false);
    // The QR payload is fragment-only and never carries a local path.
    expect(remotePairingUrlIsSafe("https://host.tailnet.ts.net/#pairing=pair-1")).toBe(true);
    expect(remotePairingUrlIsSafe("https://host/#pairing=1?token=x")).toBe(false);
    expect(remotePairingUrlIsSafe("https://host/#pairing=/Users/adber/x")).toBe(false);
  });
});
