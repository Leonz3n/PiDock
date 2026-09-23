import { describe, expect, it } from "vitest";
import type { Capability } from "../data/types";
import {
  assertCredentialRef,
  capabilityChangeLabel,
  capabilityInvalidReason,
  capabilityKindLabel,
  capabilityRows,
  effectivePermission,
  isInstallEntry,
  mcpBridgeStatus,
  mcpConnectionLabel,
  packageVersionState,
  reduceMcpConnection,
  sourceKindLabel,
} from "../data/capabilityRules";

/**
 * [PiDock 16] (#18) renderer mirror of the shell capability rules
 * (`packages/shell/src/main/capability-registry.ts`). The renderer cannot
 * import the shell module (Node access), so this locks the same contract:
 * source-distinguished rows, invalid reasons, package-only install entries,
 * MCP bridge/connection, the permission floor and the safe-boundary change.
 */

const bridge: Capability = { id: "cap-bridge", kind: "extension", name: "mcp-bridge", source: "项目 · .pi/extensions", sourceKind: "project", scope: "本任务工作区", status: "enabled" };

function capability(overrides: Partial<Capability> & Pick<Capability, "id" | "kind" | "name" | "source">): Capability {
  return { sourceKind: "project", scope: "本任务工作区", status: "enabled", ...overrides };
}

describe("capability mirror rules", () => {
  it("labels kinds, source kinds and connection states", () => {
    expect(capabilityKindLabel("mcp")).toBe("MCP Server（bridge）");
    expect(sourceKindLabel("task-repo")).toBe("任务仓库");
    expect(mcpConnectionLabel("failed")).toBe("连接失败");
  });

  it("never widens the session tier", () => {
    expect(effectivePermission("read", "auto")).toBe("read");
    expect(effectivePermission("default", "auto")).toBe("default");
    expect(effectivePermission("default")).toBe("default");
  });

  it("keeps two same-named capabilities as source-distinguished rows", () => {
    const rows = capabilityRows(
      [
        capability({ id: "sk-1", kind: "skill", name: "code-review", source: "全局 pi/skills", sourceKind: "global" }),
        capability({ id: "sk-2", kind: "skill", name: "code-review", source: "项目 · .pi/skills" }),
      ],
      "default",
    );
    expect(rows.map((row) => row.capability.id)).toEqual(["sk-1", "sk-2"]);
    expect(rows.every((row) => row.ambiguous)).toBe(true);
  });

  it("reports the invalid reason instead of hiding the row", () => {
    expect(capabilityInvalidReason(capability({ id: "x", kind: "skill", name: "x", source: "额外来源 ~/.agents/skills", sourceKind: "extra", present: false }))?.code).toBe("resource-missing");
    expect(capabilityInvalidReason(capability({ id: "y", kind: "skill", name: "y", source: "项目", failure: { code: "load-failed", message: "语法错误" } }))).toEqual({ code: "load-failed", message: "语法错误" });
    expect(
      capabilityInvalidReason(capability({ id: "m", kind: "mcp", name: "m", source: "项目", connection: { state: "failed", message: "超时", attempts: 2 } })),
    ).toEqual({ code: "connect-failed", message: "超时" });
    expect(capabilityInvalidReason(capability({ id: "ok", kind: "skill", name: "ok", source: "项目" }))).toBeNull();
  });

  it("treats only a package as an install entry with real version states", () => {
    expect(isInstallEntry(capability({ id: "p", kind: "package", name: "p", source: "全局" }))).toBe(true);
    expect(isInstallEntry(capability({ id: "s", kind: "skill", name: "s", source: "全局" }))).toBe(false);
    expect(packageVersionState(capability({ id: "p1", kind: "package", name: "p1", source: "全局" }))).toBe("not-installed");
    expect(packageVersionState(capability({ id: "p2", kind: "package", name: "p2", source: "全局", installedVersion: "1.0.0", availableVersion: "1.1.0" }))).toBe("update-available");
    expect(packageVersionState(capability({ id: "p3", kind: "package", name: "p3", source: "全局", installedVersion: "1.0.0", availableVersion: "1.0.0" }))).toBe("up-to-date");
  });

  it("requires an enabled bridge Extension for MCP", () => {
    const mcp = capability({ id: "mcp", kind: "mcp", name: "figma", source: "项目", bridge: { extensionId: "cap-bridge", command: "npx x" } });
    expect(mcpBridgeStatus([bridge, mcp], mcp)).toMatchObject({ ok: true });
    expect(mcpBridgeStatus([{ ...bridge, status: "disabled" }, mcp], mcp)).toMatchObject({ ok: false, code: "bridge-missing" });
    const direct = capability({ id: "mcp2", kind: "mcp", name: "direct", source: "项目" });
    expect(mcpBridgeStatus([bridge, direct], direct)).toMatchObject({ ok: false, code: "bridge-missing" });
  });

  it("tracks connect, failure, retry and disconnect", () => {
    const connecting = reduceMcpConnection(undefined, { kind: "connect" });
    expect(connecting).toEqual({ state: "connecting", attempts: 1 });
    const failed = reduceMcpConnection(connecting, { kind: "error", message: "超时" });
    expect(failed).toMatchObject({ state: "failed", attempts: 1 });
    const retry = reduceMcpConnection(failed, { kind: "connect" });
    expect(retry.attempts).toBe(2);
    expect(reduceMcpConnection(retry, { kind: "connected" })).toMatchObject({ state: "connected", attempts: 2 });
    expect(reduceMcpConnection(retry, { kind: "disconnect" })).toMatchObject({ state: "disconnected" });
  });

  it("stores only a credential reference", () => {
    expect(assertCredentialRef("figma-token")).toEqual({ ok: true, ref: "figma-token" });
    expect(assertCredentialRef("https://user:pass@example.com")).toMatchObject({ ok: false, code: "literal-secret" });
    expect(assertCredentialRef("ghp_abcdefghijklmnop")).toMatchObject({ ok: false, code: "literal-secret" });
  });

  it("describes a change waiting for the safe boundary", () => {
    const deferred = capability({
      id: "sk",
      kind: "skill",
      name: "review",
      source: "项目",
      version: "2.0.0",
      activeVersion: "1.0.0",
      pendingChange: { kind: "set-version", version: "2.0.0", applyAt: "idle" },
    });
    expect(capabilityChangeLabel(deferred)).toContain("当前回合结束后生效");
    expect(capabilityChangeLabel(deferred)).toContain("1.0.0");
    expect(capabilityChangeLabel(capability({ id: "sk2", kind: "skill", name: "n", source: "项目" }))).toBeNull();
  });
});
