import { describe, expect, it } from "vitest";
import {
  applyPendingCapabilityChanges,
  assertCredentialRef,
  capabilityRows,
  clearCapabilityFailure,
  effectiveCapabilitySources,
  effectivePermission,
  isInstallEntry,
  mcpBridgeStatus,
  packageVersionState,
  planCapabilityChange,
  recordCapabilityFailure,
  reduceMcpConnection,
  sharedCapabilityProjection,
  sourceKindLabel,
  type CapabilityRecord,
  type CapabilitySource,
} from "./capability-registry.js";

const sources: CapabilitySource[] = [
  { id: "src-global", kind: "global", label: "全局 pi/skills", enabled: true },
  { id: "src-project", kind: "project", label: "项目 atlas · .pi/skills", enabled: true },
  { id: "src-task", kind: "task-repo", label: "任务仓库 front-monorepo · .pi/extensions", enabled: true },
  { id: "src-off", kind: "project", label: "项目 atlas · 已停用来源", enabled: false },
];

const bridge: CapabilityRecord = { id: "cap-bridge", kind: "extension", name: "mcp-bridge", sourceId: "src-task", enabled: true };

function record(overrides: Partial<CapabilityRecord> & Pick<CapabilityRecord, "id" | "kind" | "name" | "sourceId">): CapabilityRecord {
  return { enabled: true, ...overrides };
}

describe("capability sources and effective list", () => {
  it("orders enabled sources global → project → task repo → extra", () => {
    expect(effectiveCapabilitySources(sources).map((source) => source.id)).toEqual(["src-global", "src-project", "src-task"]);
    expect(effectiveCapabilitySources([...sources, { id: "src-extra", kind: "extra", label: "~/.agents/skills", enabled: true }]).at(-1)?.id).toBe("src-extra");
    expect(sourceKindLabel("task-repo")).toBe("任务仓库");
  });

  it("keeps two same-named capabilities as two source-distinguished rows (同名消歧)", () => {
    const rows = capabilityRows(
      {
        sources,
        capabilities: [
          record({ id: "sk-global", kind: "skill", name: "code-review", sourceId: "src-global" }),
          record({ id: "sk-project", kind: "skill", name: "code-review", sourceId: "src-project" }),
        ],
      },
      "default",
    );
    expect(rows.map((row) => [row.record.id, row.ambiguous])).toEqual([
      ["sk-global", true],
      ["sk-project", true],
    ]);
    // The source label distinguishes them; neither silently replaces the other.
    expect(new Set(rows.map((row) => row.sourceLabel)).size).toBe(2);
  });

  it("reports why a capability is not usable instead of hiding it", () => {
    const rows = capabilityRows(
      {
        sources,
        capabilities: [
          record({ id: "sk-off", kind: "skill", name: "hidden", sourceId: "src-off" }),
          record({ id: "sk-gone", kind: "skill", name: "gone", sourceId: "src-global", present: false }),
          record({ id: "sk-broken", kind: "skill", name: "broken", sourceId: "src-global", failure: { code: "load-failed", message: "扩展加载失败：语法错误" } }),
          record({ id: "sk-missing-source", kind: "skill", name: "orphan", sourceId: "src-none" }),
          record({ id: "sk-ok", kind: "skill", name: "ok", sourceId: "src-global" }),
        ],
      },
      "default",
    );
    const byId = new Map(rows.map((row) => [row.record.id, row.invalid]));
    expect(byId.get("sk-off")?.code).toBe("source-disabled");
    expect(byId.get("sk-gone")?.code).toBe("resource-missing");
    expect(byId.get("sk-broken")?.message).toContain("语法错误");
    expect(byId.get("sk-missing-source")?.code).toBe("source-missing");
    expect(byId.get("sk-ok")).toBeNull();
  });

  it("marks declared examples apart from probe-verified capabilities (box 5)", () => {
    const rows = capabilityRows(
      {
        sources,
        capabilities: [
          record({ id: "sk-verified", kind: "skill", name: "verified-skill", sourceId: "src-global", verified: true }),
          record({ id: "sk-example", kind: "skill", name: "example-skill", sourceId: "src-global" }),
        ],
      },
      "default",
    );
    expect(rows.find((row) => row.record.id === "sk-verified")?.provenance).toBe("verified");
    expect(rows.find((row) => row.record.id === "sk-example")?.provenance).toBe("declared");
  });
});

describe("package version management", () => {
  it("separates not-installed from up-to-date and update-available (box 2)", () => {
    expect(packageVersionState(record({ id: "p1", kind: "package", name: "tool", sourceId: "src-global" }))).toBe("not-installed");
    expect(packageVersionState(record({ id: "p2", kind: "package", name: "tool", sourceId: "src-global", installedVersion: "1.8.2", availableVersion: "1.8.2" }))).toBe("up-to-date");
    expect(packageVersionState(record({ id: "p3", kind: "package", name: "tool", sourceId: "src-global", installedVersion: "1.8.2", availableVersion: "1.9.0" }))).toBe("update-available");
  });

  it("only makes a package row an install entry", () => {
    expect(isInstallEntry(record({ id: "p", kind: "package", name: "tool", sourceId: "src-global" }))).toBe(true);
    expect(isInstallEntry(record({ id: "s", kind: "skill", name: "tool", sourceId: "src-global" }))).toBe(false);
    expect(isInstallEntry(record({ id: "m", kind: "mcp", name: "tool", sourceId: "src-global" }))).toBe(false);
  });
});

describe("MCP bridge, connection and permission", () => {
  it("requires an enabled bridge Extension", () => {
    const mcp = record({ id: "mcp-1", kind: "mcp", name: "figma-context", sourceId: "src-project", bridge: { extensionId: "cap-bridge", command: "npx @example/mcp" } });
    expect(mcpBridgeStatus({ sources, capabilities: [bridge, mcp] }, mcp)).toMatchObject({ ok: true });
    expect(mcpBridgeStatus({ sources, capabilities: [{ ...bridge, enabled: false }, mcp] }, mcp)).toMatchObject({ ok: false, code: "bridge-missing" });
    const noBridge = record({ id: "mcp-2", kind: "mcp", name: "direct", sourceId: "src-project" });
    expect(mcpBridgeStatus({ sources, capabilities: [bridge, noBridge] }, noBridge)).toMatchObject({ ok: false, code: "bridge-missing" });
  });

  it("tracks connect, failure, retry attempts and disconnect", () => {
    const connecting = reduceMcpConnection(undefined, { kind: "connect" });
    expect(connecting).toEqual({ state: "connecting", attempts: 1 });
    const failed = reduceMcpConnection(connecting, { kind: "error", message: "连接超时" });
    expect(failed).toMatchObject({ state: "failed", message: "连接超时", attempts: 1 });
    const retry = reduceMcpConnection(failed, { kind: "connect" });
    expect(retry).toMatchObject({ state: "connecting", attempts: 2 });
    expect(reduceMcpConnection(retry, { kind: "connected" })).toMatchObject({ state: "connected", attempts: 2 });
    expect(reduceMcpConnection(retry, { kind: "disconnect" })).toMatchObject({ state: "disconnected" });
  });

  it("reports a failed connection as the invalid reason so 重试 is actionable (box 1/3)", () => {
    const mcp = record({
      id: "mcp-failed",
      kind: "mcp",
      name: "figma-context",
      sourceId: "src-project",
      bridge: { extensionId: "cap-bridge", command: "npx @example/mcp" },
      connection: { state: "failed", message: "连接超时", attempts: 2 },
    });
    expect(capabilityRows({ sources, capabilities: [mcp] }, "default")[0]?.invalid).toEqual({ code: "connect-failed", message: "连接超时" });
  });

  it("never widens the session tier, whatever the capability asks for", () => {
    expect(effectivePermission("read", "auto")).toBe("read");
    expect(effectivePermission("default", "auto")).toBe("default");
    expect(effectivePermission("default", "read")).toBe("read");
    expect(effectivePermission("default")).toBe("default");
    const rows = capabilityRows(
      { sources, capabilities: [record({ id: "mcp-3", kind: "mcp", name: "server", sourceId: "src-project", requestedPermission: "auto" })] },
      "default",
    );
    expect(rows[0]?.permission).toBe("default");
  });

  it("stores only a credential reference and keeps it out of the shared projection", () => {
    expect(assertCredentialRef("figma-token")).toEqual({ ok: true, ref: "figma-token" });
    expect(assertCredentialRef("https://user:pass@example.com/mcp")).toMatchObject({ ok: false, code: "literal-secret" });
    expect(assertCredentialRef("sk-live-abcdefghijklmnopqrstuvwxyz012345")).toMatchObject({ ok: false, code: "literal-secret" });
    expect(assertCredentialRef("TOKEN=abc")).toMatchObject({ ok: false, code: "literal-secret" });

    const mcp = record({
      id: "mcp-4",
      kind: "mcp",
      name: "figma-context",
      sourceId: "src-project",
      authRef: "figma-token",
      connection: { state: "connected", attempts: 1 },
    });
    const shared = sharedCapabilityProjection(mcp);
    expect("authRef" in shared).toBe(false);
    expect("connection" in shared).toBe(false);
    expect(shared).toMatchObject({ name: "figma-context" });
  });
});

describe("configuration changes at the safe session boundary", () => {
  it("waits for an idle boundary while a turn runs, keeping the serving version", () => {
    const skill = record({ id: "sk-1", kind: "skill", name: "review", sourceId: "src-global", version: "1.0.0", activeVersion: "1.0.0" });
    const deferred = planCapabilityChange(skill, { kind: "set-version", version: "2.0.0" }, { busy: true });
    expect(deferred.applied).toBe("idle");
    expect(deferred.record.version).toBe("1.0.0");
    expect(deferred.record.activeVersion).toBe("1.0.0");
    expect(deferred.record.pendingChange).toEqual({ kind: "set-version", version: "2.0.0", applyAt: "idle" });

    const flushed = applyPendingCapabilityChanges([deferred.record], { busy: true });
    expect(flushed.applied).toEqual([]);
    const idleFlush = applyPendingCapabilityChanges([deferred.record], { busy: false });
    expect(idleFlush.applied).toEqual(["sk-1"]);
    expect(idleFlush.records[0]).toMatchObject({ version: "2.0.0", activeVersion: "2.0.0" });
    expect(idleFlush.records[0]?.pendingChange).toBeUndefined();
  });

  it("applies immediately when the session is idle and defers only enable/disable while busy", () => {
    const skill = record({ id: "sk-2", kind: "skill", name: "review", sourceId: "src-global", enabled: false });
    expect(planCapabilityChange(skill, { kind: "enable" }, { busy: false })).toMatchObject({ applied: "now", record: { enabled: true } });
    const busy = planCapabilityChange(skill, { kind: "enable" }, { busy: true });
    expect(busy.record.enabled).toBe(false);
    expect(busy.record.pendingChange).toEqual({ kind: "enable", applyAt: "idle" });
  });

  it("keeps the previously working configuration after a failed load (box 4)", () => {
    const skill = record({ id: "sk-3", kind: "skill", name: "review", sourceId: "src-global", version: "2.0.0", activeVersion: "1.0.0", enabled: false });
    const failed = recordCapabilityFailure(skill, { code: "load-failed", message: "新版本加载失败" });
    expect(failed.version).toBe("1.0.0");
    expect(failed.failure).toEqual({ code: "load-failed", message: "新版本加载失败" });
    // The reason is reported, not silently swallowed.
    expect(capabilityRows({ sources, capabilities: [failed] }, "default")[0]?.invalid?.code).toBe("load-failed");
    const fixed = clearCapabilityFailure(failed);
    expect(fixed.failure).toBeUndefined();
    expect(capabilityRows({ sources, capabilities: [fixed] }, "default")[0]?.invalid).toBeNull();
  });
});
