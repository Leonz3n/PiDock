type Mode = "tailscale" | "gateway" | "funnel";
type Permission = "overview" | "chat" | "manage" | "files" | "terminal";
type Device = { id: string; name: string; status: "pending-confirmation" | "active" | "revoked"; online: boolean; permissions: Permission[]; lastSeenAt?: string };
export type RemoteView = { mode: Mode; label: string; hint: string; warning?: string; baseUrl: string; gateway: { status: "offline" | "connecting" | "online"; endpoint: string; lastError?: string }; devices: Device[] };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const mode = (value: unknown): value is Mode => value === "tailscale" || value === "gateway" || value === "funnel";
const permission = (value: unknown): value is Permission => value === "overview" || value === "chat" || value === "manage" || value === "files" || value === "terminal";

/** Whitelist display fields: credential metadata and secrets never enter this view. */
export function remoteStateFromHost(payload: unknown): RemoteView | null {
  if (!object(payload) || !object(payload.entry) || !object(payload.gateway) || !Array.isArray(payload.devices)) return null;
  const { entry, gateway } = payload;
  if (!mode(entry.mode) || typeof entry.label !== "string" || typeof entry.hint !== "string" || typeof entry.baseUrl !== "string" ||
      (entry.warning !== undefined && typeof entry.warning !== "string") || gateway.entryMode !== entry.mode ||
      (gateway.status !== "offline" && gateway.status !== "connecting" && gateway.status !== "online") ||
      typeof gateway.endpoint !== "string" || (gateway.lastError !== undefined && typeof gateway.lastError !== "string")) return null;
  const devices: Device[] = [];
  for (const value of payload.devices) {
    if (!object(value) || typeof value.deviceId !== "string" || !value.deviceId || typeof value.name !== "string" ||
        (value.status !== "pending-confirmation" && value.status !== "active" && value.status !== "revoked") ||
        typeof value.online !== "boolean" || !Array.isArray(value.permissions) || !value.permissions.every(permission) ||
        (value.lastSeenAt !== undefined && typeof value.lastSeenAt !== "string")) return null;
    devices.push({ id: value.deviceId, name: value.name, status: value.status, online: value.online, permissions: value.permissions, ...(typeof value.lastSeenAt === "string" ? { lastSeenAt: value.lastSeenAt } : {}) });
  }
  return { mode: entry.mode, label: entry.label, hint: entry.hint, baseUrl: entry.baseUrl,
    ...(typeof entry.warning === "string" ? { warning: entry.warning } : {}),
    gateway: { status: gateway.status, endpoint: gateway.endpoint, ...(typeof gateway.lastError === "string" ? { lastError: gateway.lastError } : {}) }, devices };
}
