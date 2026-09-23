/**
 * Pure capability rules for [PiDock 16] (#18): which Skills, Extensions,
 * Packages and MCP Servers are effective in a task, where each one comes
 * from, why one is not usable, and how a configuration change reaches a
 * session without widening its permission.
 *
 * The module never touches the disk, a process or the pi SDK. It receives the
 * sources a discovery pass already identified plus the records it produced:
 *
 * - a capability keeps its source (`global` / `project` / `task-repo` /
 *   `extra`), so two sources declaring the same name stay two rows and the
 *   user picks the source instead of getting whichever loaded first
 * - an unusable capability reports its reason (source removed, resource
 *   gone, load/connect failure) instead of disappearing silently
 * - only a `package` row is an install/update entry; a runtime resource page
 *   (skill / extension / MCP) never pretends to be an install entry
 * - an MCP server is reached through a bridge Extension, its credential stays
 *   a reference (`authRef`), and its connect/retry state is a value the UI can
 *   render; a capability never widens the task's write permission
 * - a change applies at a safe (idle) boundary: while a turn runs it waits,
 *   an existing call keeps the version it was actually started with, and a
 *   failed load keeps the previously working configuration
 */

export type CapabilityKind = "skill" | "extension" | "package" | "mcp";

export type CapabilitySourceKind = "global" | "project" | "task-repo" | "extra";

/** Session write tier; `read` is the narrowest, `auto` the widest. */
export type PermissionTier = "read" | "default" | "auto";

export type McpConnectionState = "connected" | "connecting" | "failed" | "disconnected";

export type CapabilityFailureCode =
  | "source-disabled"
  | "source-missing"
  | "resource-missing"
  | "load-failed"
  | "bridge-missing"
  | "connect-failed"
  | "not-installed";

export type CapabilitySource = {
  id: string;
  kind: CapabilitySourceKind;
  /** What the row shows, e.g. `全局 pi/skills` or `项目 atlas · .pi/extensions`. */
  label: string;
  /** Location the source resolves to; absent when discovery has none. */
  location?: string;
  enabled: boolean;
};

export type CapabilityRecord = {
  id: string;
  kind: CapabilityKind;
  name: string;
  /** Optional summary; a skill's description is searchable like its name. */
  description?: string;
  sourceId: string;
  /** Resource relative path inside its source root (skills / extension entry). */
  resourcePath?: string;
  /** Version the user last asked for; equals `activeVersion` once applied. */
  version?: string;
  /**
   * Version actually serving calls right now. An in-flight call keeps this
   * value even when `version` already points at a newer one.
   */
  activeVersion?: string;
  /** Package: version installed locally; absent means not installed. */
  installedVersion?: string;
  /** Package: version the source offers. */
  availableVersion?: string;
  enabled: boolean;
  /** MCP: the bridge Extension that hosts this server. */
  bridge?: { extensionId: string; command: string };
  /** MCP: private credential reference; the literal secret never lands here. */
  authRef?: string;
  /** MCP: last observed connection state. */
  connection?: { state: McpConnectionState; message?: string; attempts?: number };
  /** Highest tier the capability would like; never widens the session tier. */
  requestedPermission?: PermissionTier;
  /**
   * Whether a probe actually confirmed the capability in this environment.
   * `false`/absent marks a declared example that must not be presented as an
   * interface the SDK supports.
   */
  verified?: boolean;
  /** False when discovery could not find the declared resource. */
  present?: boolean;
  /** Failure recorded by the last load/connect attempt. */
  failure?: { code: CapabilityFailureCode; message: string };
  /** A change waiting for the safe (idle) boundary. */
  pendingChange?: { kind: "enable" | "disable" | "set-version"; version?: string; applyAt: "idle" };
};

export type CapabilityRegistry = {
  sources: readonly CapabilitySource[];
  capabilities: readonly CapabilityRecord[];
};

const SOURCE_KIND_ORDER: Record<CapabilitySourceKind, number> = { global: 0, project: 1, "task-repo": 2, extra: 3 };

const PERMISSION_RANK: Record<PermissionTier, number> = { read: 0, default: 1, auto: 2 };

export function sourceKindLabel(kind: CapabilitySourceKind): string {
  return { global: "全局", project: "项目", "task-repo": "任务仓库", extra: "额外来源" }[kind];
}

export function capabilityKindLabel(kind: CapabilityKind): string {
  return { skill: "Skill", extension: "Extension", package: "Package", mcp: "MCP Server" }[kind];
}

/** Enabled sources in discovery order (global → project → task repo → extra). */
export function effectiveCapabilitySources(sources: readonly CapabilitySource[]): CapabilitySource[] {
  return sources
    .filter((source) => source.enabled)
    .slice()
    .sort((left, right) => SOURCE_KIND_ORDER[left.kind] - SOURCE_KIND_ORDER[right.kind] || left.label.localeCompare(right.label));
}

/**
 * Why a capability is not usable, or `null` when it is. The order is the one
 * the user needs: a disabled/missing source explains everything below it, a
 * missing resource comes before a load failure, and the failure recorded by
 * the last attempt is reported verbatim instead of a generic message.
 */
export function capabilityInvalidReason(
  record: CapabilityRecord,
  sources: readonly CapabilitySource[],
): { code: CapabilityFailureCode; message: string } | null {
  const source = sources.find((item) => item.id === record.sourceId);
  if (source === undefined) {
    return { code: "source-missing", message: `来源 ${record.sourceId} 已移除，请重新选择来源` };
  }
  if (!source.enabled) {
    return { code: "source-disabled", message: `来源 ${source.label} 已停用，启用来源后此能力才可用` };
  }
  if (record.present === false) {
    return { code: "resource-missing", message: `${sourceKindLabel(source.kind)}来源 ${source.label} 中未找到该资源，请核对路径` };
  }
  if (record.failure !== undefined) return { code: record.failure.code, message: record.failure.message };
  if (record.connection?.state === "failed") {
    return { code: "connect-failed", message: record.connection.message ?? "MCP 连接失败，可重试" };
  }
  return null;
}

export type CapabilityRow = {
  record: CapabilityRecord;
  sourceLabel: string;
  sourceKind: CapabilitySourceKind;
  /** Two or more enabled capabilities share this name across sources. */
  ambiguous: boolean;
  /** Only a package row may install/update; runtime resources never do. */
  installEntry: boolean;
  invalid: { code: CapabilityFailureCode; message: string } | null;
  /** Provenance: verified by a probe, or merely declared (example). */
  provenance: "verified" | "declared";
  permission: PermissionTier;
};

/**
 * The effective capability list: one row per record (a same-named pair stays
 * two rows), each carrying its source, disambiguation flag, install-entry
 * role, invalid reason, provenance and the permission it actually gets.
 */
export function capabilityRows(registry: CapabilityRegistry, sessionTier: PermissionTier): CapabilityRow[] {
  const nameCounts = new Map<string, number>();
  for (const record of registry.capabilities) {
    nameCounts.set(record.name, (nameCounts.get(record.name) ?? 0) + 1);
  }
  return registry.capabilities
    .map((record) => {
      const source = registry.sources.find((item) => item.id === record.sourceId);
      return {
        record,
        sourceLabel: source?.label ?? record.sourceId,
        sourceKind: source?.kind ?? "extra",
        ambiguous: (nameCounts.get(record.name) ?? 0) > 1,
        installEntry: record.kind === "package",
        invalid: capabilityInvalidReason(record, registry.sources),
        provenance: record.verified === true ? ("verified" as const) : ("declared" as const),
        permission: effectivePermission(sessionTier, record.requestedPermission),
      };
    })
    .sort(
      (left, right) =>
        SOURCE_KIND_ORDER[left.sourceKind] - SOURCE_KIND_ORDER[right.sourceKind] ||
        left.record.name.localeCompare(right.record.name) ||
        left.sourceLabel.localeCompare(right.sourceLabel),
    );
}

/**
 * Package version state. `not-installed` is a real state, not a zero version:
 * the runtime pages must not offer to install a package that is not installed,
 * and the package page must not claim an install that never ran.
 */
export function packageVersionState(record: CapabilityRecord): "not-installed" | "up-to-date" | "update-available" {
  if (record.kind !== "package") return "up-to-date";
  if (record.installedVersion === undefined || record.installedVersion.length === 0) return "not-installed";
  if (record.availableVersion !== undefined && record.availableVersion !== record.installedVersion) return "update-available";
  return "up-to-date";
}

/** Only a package row is an install entry (box 2). */
export function isInstallEntry(record: CapabilityRecord): boolean {
  return record.kind === "package";
}

/**
 * The permission a capability gets: never wider than the session tier it runs
 * under (box 3). A capability cannot grant itself tools it did not have.
 */
export function effectivePermission(sessionTier: PermissionTier, requested?: PermissionTier): PermissionTier {
  if (requested === undefined) return sessionTier;
  return PERMISSION_RANK[requested] < PERMISSION_RANK[sessionTier] ? requested : sessionTier;
}

/**
 * MCP is only reachable through a bridge Extension (box 3). Without the
 * extension the server reports `bridge-missing` and no connect is planned.
 */
export function mcpBridgeStatus(
  registry: CapabilityRegistry,
  record: CapabilityRecord,
): { ok: true; bridge: { extensionId: string; command: string } } | { ok: false; code: "bridge-missing"; message: string } {
  const bridgeId = record.bridge?.extensionId;
  if (bridgeId === undefined) {
    return { ok: false, code: "bridge-missing", message: "MCP Server 需要 bridge Extension 接入，请先启用对应 Extension" };
  }
  const bridge = registry.capabilities.find((item) => item.id === bridgeId && item.kind === "extension" && item.enabled);
  if (bridge === undefined) {
    return { ok: false, code: "bridge-missing", message: `bridge Extension ${bridgeId} 未启用，MCP Server 无法连接` };
  }
  const reason = capabilityInvalidReason(bridge, registry.sources);
  if (reason !== null) {
    return { ok: false, code: "bridge-missing", message: `bridge Extension ${bridge.name} 不可用：${reason.message}` };
  }
  return { ok: true, bridge: record.bridge as { extensionId: string; command: string } };
}

export type McpConnectionEvent = { kind: "connect" } | { kind: "connected" } | { kind: "error"; message: string } | { kind: "disconnect" };

/**
 * Connection state machine: connect → connecting, success → connected, error
 * → failed with the attempt count kept so `重试` is meaningful.
 */
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

/**
 * A credential reference is what gets stored: a name like `figma-token`,
 * never the secret value. Anything that looks like a literal secret (URL with
 * inline credentials, a long opaque token, a `KEY=value` pair) is refused so
 * it never reaches the shared template or a log.
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

/**
 * The projection safe to write into a shared project template: it drops the
 * credential reference and the observed connection state, so a shared file
 * never carries private auth or another machine's runtime status.
 */
export function sharedCapabilityProjection(record: CapabilityRecord): Omit<CapabilityRecord, "authRef" | "connection"> {
  const shared: CapabilityRecord = { ...record };
  // Dropped, not blanked: a shared file never carries the reference name or
  // another machine's runtime connection state.
  delete shared.authRef;
  delete shared.connection;
  return shared;
}

export type CapabilityChange = { kind: "enable" } | { kind: "disable" } | { kind: "set-version"; version: string };

export type CapabilityChangeResult = {
  record: CapabilityRecord;
  /** `now` applied inside this call, `idle` waits for the safe boundary. */
  applied: "now" | "idle";
};

/**
 * A configuration change takes effect at a safe boundary (box 4): while a
 * turn is running the record keeps serving the version it has and the change
 * waits as `pendingChange`; an idle session applies it immediately. Applying
 * a version moves `activeVersion` with it, so the version shown as "in use"
 * is the one a new call would get.
 */
export function planCapabilityChange(record: CapabilityRecord, change: CapabilityChange, context: { busy: boolean }): CapabilityChangeResult {
  if (context.busy) {
    const pending: NonNullable<CapabilityRecord["pendingChange"]> = { kind: change.kind, applyAt: "idle" };
    if (change.kind === "set-version") pending.version = change.version;
    return { record: { ...record, pendingChange: pending }, applied: "idle" };
  }
  return { record: applyCapabilityChange(record, change), applied: "now" };
}

function applyCapabilityChange(record: CapabilityRecord, change: CapabilityChange): CapabilityRecord {
  const next: CapabilityRecord = { ...record };
  delete next.pendingChange;
  if (change.kind === "enable") return { ...next, enabled: true };
  if (change.kind === "disable") return { ...next, enabled: false };
  return { ...next, version: change.version, activeVersion: change.version };
}

/**
 * Apply every pending change once the boundary is free. Callers pass the
 * records they own plus the current busy state; a still-busy session returns
 * them untouched with an empty `applied` list.
 */
export function applyPendingCapabilityChanges(
  records: readonly CapabilityRecord[],
  context: { busy: boolean },
): { records: CapabilityRecord[]; applied: string[] } {
  if (context.busy) return { records: records.map((record) => ({ ...record })), applied: [] };
  const applied: string[] = [];
  const next = records.map((record) => {
    const pending = record.pendingChange;
    if (pending === undefined) return { ...record };
    if (pending.kind === "set-version" && pending.version === undefined) return { ...record };
    applied.push(record.id);
    return applyCapabilityChange(record, pending.kind === "set-version" ? { kind: "set-version", version: pending.version as string } : { kind: pending.kind });
  });
  return { records: next, applied };
}

/**
 * Record a failed load/connect. The previously working configuration stays
 * in force: `version` falls back to `activeVersion` (when there was one) and
 * the failure is kept for the resource page's "失效原因" (box 4).
 */
export function recordCapabilityFailure(record: CapabilityRecord, failure: { code: CapabilityFailureCode; message: string }): CapabilityRecord {
  const next: CapabilityRecord = { ...record };
  delete next.pendingChange;
  if (record.activeVersion !== undefined && record.version !== record.activeVersion) next.version = record.activeVersion;
  return { ...next, failure };
}

/** Clear a recorded failure after the resource works again (box 4: 修复). */
export function clearCapabilityFailure(record: CapabilityRecord): CapabilityRecord {
  const next: CapabilityRecord = { ...record };
  delete next.failure;
  return next;
}
