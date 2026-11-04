import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopCapabilitiesPage } from "../components/DesktopCapabilitiesPage";

/**
 * [Pencil T15] #150 S09 — 能力管理 · MCP.
 *
 * Every assertion is against a real `shell/mcpOp` reply shape; the page has no
 * fixture fallback. The list shows Pi's own state (`enabled`/`disabled`/`error`),
 * the form sends only the exact `input` keys main validates, and a credential is
 * visible only as a reference name. A hand-written server is read-only.
 */

const MANAGED = "pidock-mcp-11111111-2222-3333-4444-555555555555";
const BOUNDARY = { appliesTo: "new-session", openSessionsMutated: false, note: "保存、启用或停用只修改 mcp.json；已打开的会话保留启动时加载的 Server 与工具，新会话才读取新配置。" };
const MANAGED_ROW = {
  name: MANAGED, managed: true, label: "本地文档", transport: "stdio", enabled: true, state: "enabled", error: null,
  command: "node", args: ["server.mjs"], url: null, timeout: 60, exposure: "direct", credentialRefs: { env: ["MCP_TOKEN"], headers: [] },
};
const UNMANAGED_ROW = {
  name: "docs", managed: false, label: null, transport: "http", enabled: true, state: "error",
  error: { code: "mcp-config-invalid", message: "headers.Authorization: environment variable DOCS_TOKEN is not set" },
  command: null, args: [], url: "https://example.com/mcp", timeout: null, exposure: "codemode", credentialRefs: { env: [], headers: ["Authorization"] },
};
const STATUS = { servers: [MANAGED_ROW, UNMANAGED_ROW], path: "/Users/test/.pi/agent/mcp.json", sessionBoundary: BOUNDARY };
const EMPTY_STATUS = { servers: [], path: "/Users/test/.pi/agent/mcp.json", sessionBoundary: BOUNDARY };

function bridge(options: { list?: unknown; listError?: string; test?: unknown; save?: unknown } = {}) {
  const calls: Record<string, unknown>[] = [];
  const mcpOp = vi.fn(async (request: Record<string, unknown>) => {
    calls.push(request);
    if (request.op === "list") return options.listError ? { ok: false, error: options.listError } : { ok: true, payload: options.list ?? EMPTY_STATUS };
    if (request.op === "test") return { ok: true, payload: options.test ?? { state: "connected", tools: [{ name: "echo", description: "Echo text", readOnly: true }], credentialRefs: [], error: null, durationMs: 12 } };
    if (request.op === "save") return { ok: true, payload: options.save ?? { name: MANAGED, path: "/Users/test/.pi/agent/mcp.json", server: MANAGED_ROW } };
    if (request.op === "remove") return { ok: true, payload: { removed: request.name, path: "/Users/test/.pi/agent/mcp.json" } };
    if (request.op === "enable" || request.op === "disable") return { ok: true, payload: { server: { ...MANAGED_ROW, enabled: request.op === "enable" } } };
    return { ok: false, error: "unexpected" };
  });
  (window as unknown as { pidock?: unknown }).pidock = {
    mcpOp,
    providerOp: vi.fn(async () => ({ ok: true, payload: { state: "not-configured", profileId: null, modelId: null, thinkingLevel: null, generation: null, profiles: [], nativePath: "/Users/test/.pi/agent/models.json", secretsAvailable: true } })),
  };
  return { calls, mcpOp };
}

async function openMcp(options: Parameters<typeof bridge>[0] = {}) {
  const handle = bridge(options);
  render(<DesktopCapabilitiesPage taskId="task-1" taskName="对账单详情" onBack={vi.fn()} />);
  await screen.findByTestId("providers-panel");
  await userEvent.click(screen.getByRole("button", { name: /^MCP/ }));
  await screen.findByTestId("capabilities-mcp");
  return handle;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("S09 MCP pane", () => {
  it("lists real state, transport and reference names, and marks a hand-written server read-only", async () => {
    const { calls } = await openMcp({ list: STATUS });
    const rows = await screen.findAllByTestId("mcp-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-state", "enabled");
    expect(rows[0]).toHaveTextContent("本地文档");
    expect(rows[0]).toHaveTextContent("node server.mjs");
    // Only the reference NAME is visible; no value was ever returned.
    expect(rows[0]).toHaveTextContent("MCP_TOKEN");
    expect(rows[0]).toHaveTextContent("只回显名称");
    expect(rows[0]).not.toHaveTextContent("Bearer");
    // A hand-written HTTP server keeps its real error state and has no write path.
    expect(rows[1]).toHaveAttribute("data-state", "error");
    expect(rows[1]).toHaveTextContent("mcp-config-invalid");
    expect(rows[1]).toHaveTextContent("Pi 直接管理 · 只读");
    expect(within(rows[1]!).queryByRole("button", { name: "编辑" })).toBeNull();
    expect(within(rows[1]!).queryByRole("button", { name: "停用" })).toBeNull();
    expect(within(rows[1]!).queryByRole("button", { name: "删除" })).toBeNull();
    expect(within(rows[1]!).getByRole("button", { name: "测试" })).toBeInTheDocument();
    // The boundary is stated, never implied as a live reload.
    expect(screen.getByTestId("capabilities-mcp")).toHaveTextContent("会话边界");
    expect(screen.getByTestId("capabilities-mcp")).toHaveTextContent("不改动运行中的会话");
    expect(calls[0]).toEqual({ op: "list" });
    const nav = screen.getByRole("navigation", { name: "能力管理" });
    expect(within(nav).getByRole("button", { name: /^MCP/ })).toHaveTextContent("2");
  });

  it("shows a real authentication challenge without inventing an OAuth login state", async () => {
    await openMcp({ list: { ...STATUS, servers: [{ ...UNMANAGED_ROW, state: "enabled", error: null, oauth: { configured: true, clientRegistration: "cimd", explicitClientId: false } }] }, test: { state: "failed", tools: [], credentialRefs: [], error: { code: "mcp-auth-required", message: "server requires sign-in (HTTP 401)" } } });
    const row = (await screen.findAllByTestId("mcp-row"))[0]!;
    expect(row).toHaveTextContent("OAuth · cimd");
    expect(row).toHaveTextContent("认证状态未知");
    await userEvent.click(within(row).getByRole("button", { name: "测试" }));
    expect(await screen.findByTestId("mcp-test-result")).toHaveTextContent("需要认证");
    expect(screen.queryByRole("button", { name: /登录|授权/ })).toBeNull();
    expect(screen.queryByText("未登录")).toBeNull();
  });

  it("tests a saved server through the real op and shows the tools it returned", async () => {
    const { calls } = await openMcp({ list: STATUS });
    const row = (await screen.findAllByTestId("mcp-row"))[0]!;
    await userEvent.click(within(row).getByRole("button", { name: "测试" }));
    await waitFor(() => expect(calls).toContainEqual({ op: "test", name: MANAGED }));
    expect(await screen.findByTestId("mcp-test-result")).toHaveTextContent("连接成功 · 1 个工具");
    expect(screen.getByTestId("mcp-test-result")).toHaveTextContent("echo");
    expect(screen.getByTestId("mcp-test-result")).toHaveTextContent("只读");
  });

  it("saves a new stdio server by exact input only, with no file, path or credential value", async () => {
    const { calls } = await openMcp({ list: EMPTY_STATUS });
    await userEvent.click(screen.getByRole("button", { name: "新增 Server" }));
    expect(await screen.findByTestId("capabilities-mcp-form")).toHaveTextContent("新增 Server");
    await userEvent.type(screen.getByLabelText("名称标签"), "本地文档");
    await userEvent.type(screen.getByLabelText("command（单个可执行程序）"), "node");
    await userEvent.type(screen.getByLabelText("args（每行一个）"), "server.mjs");
    await userEvent.type(screen.getByLabelText("环境变量引用（每行 NAME=$VAR，也支持大括号写法）"), "MCP_TOKEN=$MCP_TOKEN");
    await userEvent.selectOptions(screen.getByLabelText("工具暴露"), "direct");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.some((call) => call.op === "save")).toBe(true));
    const save = calls.find((call) => call.op === "save")!;
    expect(save).toEqual({ op: "save", input: { transport: "stdio", exposure: "direct", description: "本地文档", timeout: 60, command: "node", args: ["server.mjs"], env: { MCP_TOKEN: "$MCP_TOKEN" } } });
    expect(JSON.stringify(save)).not.toMatch(/path|mcp\.json|agentDir/);
    expect(await screen.findByTestId("mcp-empty")).toBeInTheDocument();
  });

  it("tests an unsaved stdio draft and shows a real failure message", async () => {
    const { calls } = await openMcp({ list: EMPTY_STATUS, test: { state: "failed", tools: [], credentialRefs: ["MCP_TOKEN"], error: { code: "mcp-connect-failed", message: "spawn server ENOENT" } } });
    await userEvent.click(screen.getByRole("button", { name: "新增 Server" }));
    await userEvent.type(screen.getByLabelText("command（单个可执行程序）"), "missing-server");
    await userEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await waitFor(() => expect(calls).toContainEqual({ op: "test", input: { transport: "stdio", exposure: "direct", timeout: 60, command: "missing-server" } }));
    expect(await screen.findByTestId("mcp-test-result")).toHaveTextContent("连接失败 · mcp-connect-failed");
    expect(screen.getByTestId("mcp-test-result")).toHaveTextContent("spawn server ENOENT");
  });

  it("disables a managed server with the named-only request and states the new-session effect", async () => {
    const { calls } = await openMcp({ list: STATUS });
    const row = (await screen.findAllByTestId("mcp-row"))[0]!;
    await userEvent.click(within(row).getByRole("button", { name: "停用" }));
    await waitFor(() => expect(calls).toContainEqual({ op: "disable", name: MANAGED }));
    expect(await screen.findByRole("status")).toHaveTextContent(`已停用 ${MANAGED}`);
  });

  it("removes only after a confirmation that names the managed server and sends no other field", async () => {
    const { calls } = await openMcp({ list: STATUS });
    const row = (await screen.findAllByTestId("mcp-row"))[0]!;
    await userEvent.click(within(row).getByRole("button", { name: "删除" }));
    expect(within(row).getByText(`确认删除 ${MANAGED}？`)).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: "确认" }));
    await waitFor(() => expect(calls).toContainEqual({ op: "remove", name: MANAGED }));
    expect(calls.find((call) => call.op === "remove")).toEqual({ op: "remove", name: MANAGED });
  });

  it("turns a failed list into a named error and never invents zero or a sample row", async () => {
    await openMcp({ listError: "MCP 配置尚未接入" });
    expect(await screen.findByTestId("mcp-error")).toHaveTextContent("MCP 配置尚未接入");
    expect(screen.queryByTestId("mcp-row")).toBeNull();
    expect(screen.queryByTestId("mcp-empty")).toBeNull();
    const nav = screen.getByRole("navigation", { name: "能力管理" });
    expect(within(nav).getByRole("button", { name: /^MCP/ })).toHaveTextContent("—");
  });
});
