import type { Capability, CapabilityFailureCode, CapabilitySourceKind, McpConnectionState, Permission } from "./types";

/**
 * [PiDock 16] (#18) renderer mirror of the shell capability rules
 * (`packages/shell/src/main/capability-registry.ts`). The renderer must not
 * import the shell package (that would hand the sandbox Node access), so the
 * effective-capability list, the invalid reason, the install-entry role, the
 * MCP bridge/connection rules and the permission floor are mirrored here and
 * locked by `test/capabilityRules.test.ts`.
 *
 * The mirror covers what the capability pages need: which sources a
 * capability comes from, two same-named capabilities staying two rows, why a
 * resource is unusable, that only a package is an install entry, the MCP
 * connect/retry state, and that a capability never gets more permission than
 * the session it runs in.
 */

export function capabilityKindLabel(kind: Capability["kind"]): string {
  return { skill: "Pi Skill", extension: "Extension", package: "Package", mcp: "MCP Server（bridge）" }[kind];
}

export function sourceKindLabel(kind: CapabilitySourceKind): string {
  return { global: "全局", project: "项目", "task-repo": "任务仓库", extra: "额外来源" }[kind];
}

const PERMISSION_RANK: Record<Permission, number> = { read: 0, default: 1, auto: 2 };

/** The permission a capability gets: never wider than its session tier (box 3). */
export function effectivePermission(sessionTier: Permission, requested?: Permission): Permission {
  if (requested === undefined) return sessionTier;
  return PERMISSION_RANK[requested] < PERMISSION_RANK[sessionTier] ? requested : sessionTier;
}

/**
 * Why a capability is not usable, or `null`. `sourceKind` is absent when the
 * capability predates the source split, so the check falls through to the
 * presentation fields instead of inventing a failure.
 */
export function capabilityInvalidReason(capability: Capability): { code: CapabilityFailureCode; message: string } | null {
  if (capability.present === false) {
    return { code: "resource-missing", message: `来源 ${capability.source} 中未找到该资源，请核对路径` };
  }
  if (capability.failure !== undefined) return { code: capability.failure.code, message: capability.failure.message };
  if (capability.connection?.state === "failed") {
    return { code: "connect-failed", message: capability.connection.message ?? "MCP 连接失败，可重试" };
  }
  return null;
}

/** Only a package row may install/update; runtime resources never do (box 2). */
export function isInstallEntry(capability: Capability): boolean {
  return capability.kind === "package";
}

/** Package version state: not installed is a real state, not a zero version. */
export function packageVersionState(capability: Capability): "not-installed" | "up-to-date" | "update-available" {
  if (capability.kind !== "package") return "up-to-date";
  if (capability.installedVersion === undefined || capability.installedVersion.length === 0) return "not-installed";
  if (capability.availableVersion !== undefined && capability.availableVersion !== capability.installedVersion) return "update-available";
  return "up-to-date";
}

export type CapabilityRow = {
  capability: Capability;
  sourceLabel: string;
  sourceKind: CapabilitySourceKind;
  /** Two or more capabilities share this name across sources. */
  ambiguous: boolean;
  installEntry: boolean;
  invalid: { code: CapabilityFailureCode; message: string } | null;
  /** Verified by a probe, or merely declared (never presented as SDK support). */
  provenance: "verified" | "declared";
  permission: Permission;
};

const SOURCE_ORDER: Record<CapabilitySourceKind, number> = { global: 0, project: 1, "task-repo": 2, extra: 3 };

function sourceKindOf(capability: Capability): CapabilitySourceKind {
  if (capability.sourceKind !== undefined) return capability.sourceKind;
  const source = capability.source;
  if (source.startsWith("全局")) return "global";
  if (source.startsWith("项目")) return "project";
  if (source.startsWith("任务")) return "task-repo";
  return "extra";
}

/** The effective capability list, source-distinguished and reason-carrying. */
export function capabilityRows(capabilities: readonly Capability[], sessionTier: Permission): CapabilityRow[] {
  const nameCounts = new Map<string, number>();
  for (const capability of capabilities) nameCounts.set(capability.name, (nameCounts.get(capability.name) ?? 0) + 1);
  return capabilities
    .map((capability) => ({
      capability,
      sourceLabel: capability.source,
      sourceKind: sourceKindOf(capability),
      ambiguous: (nameCounts.get(capability.name) ?? 0) > 1,
      installEntry: isInstallEntry(capability),
      invalid: capabilityInvalidReason(capability),
      provenance: capability.verified === true ? ("verified" as const) : ("declared" as const),
      permission: effectivePermission(sessionTier, capability.requestedPermission),
    }))
    .sort(
      (left, right) =>
        SOURCE_ORDER[left.sourceKind] - SOURCE_ORDER[right.sourceKind] ||
        left.capability.name.localeCompare(right.capability.name) ||
        left.sourceLabel.localeCompare(right.sourceLabel),
    );
}

/**
 * Whether a row is switched on from the user's point of view: an installed
 * capability with a pending update still runs, so it reads as enabled and its
 * button is 停用 — the toggle, the row label and the MCP bridge rule must all
 * use this one predicate or they drift apart (box 3/5).
 */
export function isCapabilityEnabled(capability: Capability): boolean {
  return capability.status === "enabled" || capability.status === "update-available";
}

/**
 * Whether a re-check changed a row's usability: `present`, the recorded
 * failure and the connection state are the fields a re-check repairs, so they
 * decide the "N 项能力已刷新" count (a row that only gained `verified` was
 * already usable and is not a repair).
 */
export function capabilityRepairChanged(previous: Capability, next: Capability): boolean {
  return (
    previous.present !== next.present ||
    previous.failure?.code !== next.failure?.code ||
    previous.failure?.message !== next.failure?.message ||
    previous.connection?.state !== next.connection?.state
  );
}

/** MCP is only reachable through an enabled bridge Extension (box 3). */
export function mcpBridgeStatus(
  capabilities: readonly Capability[],
  capability: Capability,
): { ok: true; bridge: { extensionId: string; command: string } } | { ok: false; code: "bridge-missing"; message: string } {
  const bridgeId = capability.bridge?.extensionId;
  if (bridgeId === undefined) {
    return { ok: false, code: "bridge-missing", message: "MCP Server 需要 bridge Extension 接入，请先启用对应 Extension" };
  }
  const bridge = capabilities.find((item) => item.id === bridgeId && item.kind === "extension" && isCapabilityEnabled(item));
  if (bridge === undefined) {
    return { ok: false, code: "bridge-missing", message: `bridge Extension ${bridgeId} 未启用，MCP Server 无法连接` };
  }
  const reason = capabilityInvalidReason(bridge);
  if (reason !== null) return { ok: false, code: "bridge-missing", message: `bridge Extension ${bridge.name} 不可用：${reason.message}` };
  return { ok: true, bridge: capability.bridge as { extensionId: string; command: string } };
}

export type McpConnectionEvent = { kind: "connect" } | { kind: "connected" } | { kind: "error"; message: string } | { kind: "disconnect" };

/** Connect → connecting, success → connected, error → failed, retry keeps attempts. */
export function reduceMcpConnection(
  previous: { state: McpConnectionState; message?: string; attempts?: number } | undefined,
  event: McpConnectionEvent,
): { state: McpConnectionState; message?: string; attempts: number } {
  const attempts = previous?.attempts ?? 0;
  switch (event.kind) {
    case "connect":
      return { state: "connecting", attempts: attempts + 1 };
    case "connected":
      return { state: "connected", attempts };
    case "error":
      return { state: "failed", message: event.message, attempts };
    case "disconnect":
      return { state: "disconnected", attempts };
  }
}

export function mcpConnectionLabel(state: McpConnectionState): string {
  return { connected: "已连接", connecting: "连接中", failed: "连接失败", disconnected: "未连接" }[state];
}

/**
 * A credential reference is what gets stored: a name, never the secret value.
 * A literal secret (inline URL credentials, `KEY=value`, a provider prefix or
 * a long opaque token) is refused so it never reaches a shared template or log.
 */
export function assertCredentialRef(ref: string): { ok: true; ref: string } | { ok: false; code: "literal-secret"; message: string } {
  const value = ref.trim();
  const looksLikeSecret =
    value.length === 0 ||
    /:\/\/[^/]*:[^/@]+@/.test(value) ||
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(value) ||
    /^(sk|ghp|xox[baprs])[-_]/i.test(value) ||
    (value.length >= 32 && /^[A-Za-z0-9+/=_-]+$/.test(value));
  if (looksLikeSecret) {
    return { ok: false, code: "literal-secret", message: "此处只保存凭据引用名称，不保存密钥明文；请在本机私有配置中保存密钥" };
  }
  return { ok: true, ref: value };
}

/** The state a change is in: already applied, or waiting for the safe boundary. */
export function capabilityChangeLabel(capability: Capability): string | null {
  const pending = capability.pendingChange;
  if (pending === undefined) return null;
  const what = pending.kind === "enable" ? "启用" : pending.kind === "disable" ? "停用" : `切换到版本 ${pending.version ?? "未知"}`;
  return `已记录${what}，将在当前回合结束后生效；进行中的调用仍使用 ${capability.activeVersion ?? capability.version ?? "原版本"}`;
}
