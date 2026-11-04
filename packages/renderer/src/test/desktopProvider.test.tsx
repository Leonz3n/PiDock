import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopCapabilitiesPage } from "../components/DesktopCapabilitiesPage";

/**
 * [PiDock T03] #138 S03 / S03B — the Provider list and its full-area form.
 *
 * Every assertion is against a real `shell/providerOp` reply the test supplies;
 * `DesktopCapabilitiesPage` has no fixture fallback, so an empty list really
 * renders as empty and a failed read really shows the failure. The API key is
 * only ever an input the user types: the page has no read path for it, and the
 * save payload is checked for exactly one copy of it.
 */

const KEY = "sk-live-0123456789-abcdefghijklmnop";
const PROFILE = {
  id: "p-11111111-2222-3333-4444-555555555555",
  name: "Local gateway",
  notes: "本机回环",
  protocol: "openai-completions",
  baseUrl: "https://models.example.test/v1",
  models: [
    { id: "gpt-5-mini", name: "gpt-5-mini", contextWindow: 128000, maxTokens: 8192, reasoning: false, reasoningLevels: ["off"], cost: null },
    { id: "gpt-5", name: "GPT-5", contextWindow: 400000, maxTokens: 128000, reasoning: true, reasoningLevels: ["off", "low", "medium", "high"], cost: { input: 1.25, output: 10, cacheRead: 0, cacheWrite: 0 } },
  ],
  modelId: "gpt-5-mini",
  thinkingLevel: "off",
  contextWindow: 128000,
  maxTokens: 8192,
  credentialSource: "store",
  credentialAvailable: true,
  authRef: "p-11111111-2222-3333-4444-555555555555",
  generation: 1,
  native: { providerId: "pidock-p-11111111-2222-3333-4444-555555555555", state: "synced" },
};

const EMPTY_STATUS = { state: "not-configured", profileId: null, modelId: null, thinkingLevel: null, generation: null,
  profiles: [], nativePath: "/Users/test/.pi/agent/models.json", secretsAvailable: true };

type Reply = unknown | ((request: Record<string, unknown>) => unknown);
const EMPTY_MCP = { servers: [], path: "/Users/test/.pi/agent/mcp.json", sessionBoundary: { appliesTo: "new-session", openSessionsMutated: false, note: "保存、启用或停用只修改 mcp.json；已打开的会话保留启动时加载的 Server 与工具，新会话才读取新配置。" } };
function bridge(replies: Record<string, Reply> = {}, mcpReplies: Record<string, Reply> = { list: EMPTY_MCP }) {
  const calls: Record<string, unknown>[] = [];
  const providerOp = vi.fn(async (request: Record<string, unknown>) => {
    calls.push(request);
    const reply = replies[String(request.op)];
    try {
      return { ok: true, payload: typeof reply === "function" ? (reply as (r: Record<string, unknown>) => unknown)(request) : reply ?? EMPTY_STATUS };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "failed" };
    }
  });
  const mcpCalls: Record<string, unknown>[] = [];
  const mcpOp = vi.fn(async (request: Record<string, unknown>) => {
    mcpCalls.push(request);
    const reply = mcpReplies[String(request.op)];
    try {
      return { ok: true, payload: typeof reply === "function" ? (reply as (r: Record<string, unknown>) => unknown)(request) : reply };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "failed" };
    }
  });
  (window as unknown as { pidock?: unknown }).pidock = { providerOp, mcpOp };
  return { calls, providerOp, mcpCalls, mcpOp };
}

const page = (props: { taskId?: string | null; taskName?: string | null } = {}) =>
  render(<DesktopCapabilitiesPage taskId={props.taskId === undefined ? "task-1" : props.taskId} taskName={props.taskName ?? "对账单详情"} onBack={vi.fn()} />);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("S03 capability nav", () => {
  it("has exactly Providers / MCP / Skills and names the file Pi reads", async () => {
    const { calls } = bridge();
    page();
    const nav = screen.getByRole("navigation", { name: "能力管理" });
    for (const label of ["Providers", "MCP", "Skills"]) expect(within(nav).getByRole("button", { name: new RegExp(label) })).toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: /Extensions|Packages/ })).toBeNull();
    expect(calls[0]).toEqual({ op: "list", taskId: "task-1" });
    await waitFor(() => expect(screen.getByTestId("native-path")).toHaveTextContent("/Users/test/.pi/agent/models.json"));
  });

  it("filters configured providers by name or model without changing the native list", async () => {
    const { calls } = bridge({ list: { ...EMPTY_STATUS, profiles: [PROFILE] } });
    page();
    await screen.findByTestId(`provider-card-${PROFILE.id}`);
    const search = screen.getByRole("searchbox", { name: "搜索供应商 / 模型名称" });
    await userEvent.type(search, "missing-model");
    expect(screen.queryByTestId(`provider-card-${PROFILE.id}`)).toBeNull();
    expect(screen.getByText("没有匹配的供应商")).toBeInTheDocument();
    await userEvent.clear(search);
    await userEvent.type(search, "GPT-5");
    expect(screen.getByTestId(`provider-card-${PROFILE.id}`)).toBeInTheDocument();
    expect(calls).toEqual([{ op: "list", taskId: "task-1" }]);
  });

  it("distinguishes an unreadable provider list from zero configured profiles", async () => {
    bridge({ list: () => { throw new Error("models.json unreadable"); } });
    page();
    expect(await screen.findByRole("alert")).toHaveTextContent("models.json unreadable");
    expect(screen.getByRole("heading", { name: "已添加 · —" })).toBeInTheDocument();
    expect(screen.queryByText("正在读取本机 Provider 配置…")).toBeNull();
  });

  it("renders the real MCP list and keeps Skills honest instead of showing counts or sample rows", async () => {
    const { mcpCalls } = bridge();
    page();
    await screen.findByTestId("providers-panel");
    await userEvent.click(screen.getByRole("button", { name: /^MCP/ }));
    expect(await screen.findByTestId("capabilities-mcp")).toHaveTextContent("MCP Servers");
    expect(screen.getByTestId("mcp-empty")).toHaveTextContent("还没有 MCP Server");
    expect(mcpCalls[0]).toEqual({ op: "list" });
    await userEvent.click(screen.getByRole("button", { name: /^Skills/ }));
    // [#154] S09 Skills is the real local-source pane the desktop shell now mounts,
    // not a placeholder: with no `skillsOp` bridge in this fixture it names the
    // unwired shell state instead of inventing rows.
    expect(await screen.findByTestId("skills-pane")).toHaveTextContent("Skills 来源尚未接线");
    const nav = screen.getByRole("navigation", { name: "能力管理" });
    expect(within(nav).queryByText("未接线")).toBeNull();
  });

  it("renders the real list, and an empty list stays empty", async () => {
    bridge({ list: { ...EMPTY_STATUS, profiles: [PROFILE] } });
    page();
    await waitFor(() => expect(screen.getByTestId(`provider-card-${PROFILE.id}`)).toHaveTextContent("Local gateway"));
    const card = screen.getByTestId(`provider-card-${PROFILE.id}`);
    expect(card).toHaveTextContent("OpenAI Chat Completions");
    expect(card).toHaveTextContent("本机加密存储");
    expect(card).toHaveTextContent("密钥可用");
    expect(card).toHaveTextContent("已写入 models.json");
    expect(card).toHaveTextContent("gpt-5 · 推理 · 已声明价格");
    // The second model has no declared cost: nothing renders a 0 price for it.
    expect(card).not.toHaveTextContent("gpt-5-mini · 已声明价格");
    cleanup();
    bridge({ list: EMPTY_STATUS });
    page();
    await waitFor(() => expect(screen.getByTestId("providers-empty")).toHaveTextContent("还没有 Provider"));
    expect(screen.queryAllByTestId(/provider-card-/)).toHaveLength(0);
  });

  it("shows a failed read as a bounded error, never as an empty list", async () => {
    bridge({ list: () => { throw new Error("Provider 配置不可用"); } });
    page();
    expect(await screen.findByRole("alert")).toHaveTextContent("Provider 配置不可用");
    expect(screen.queryByTestId("providers-empty")).toBeNull();
  });
});

describe("S03B provider form", () => {
  it("fills from a preset, keeps the protocol explicit, and saves exactly one key copy", async () => {
    const { calls } = bridge({
      save: () => ({ profile: { ...PROFILE, name: "DeepSeek" }, written: true, conflict: null }),
    });
    const user = userEvent.setup();
    page();
    await screen.findByTestId("providers-panel");
    await user.click(within(screen.getByRole("region", { name: "可添加" })).getAllByRole("button", { name: "激活" })[0]!);
    const form = await screen.findByTestId("provider-form");
    expect(within(form).getByLabelText("名称")).toHaveValue("DeepSeek");
    expect(within(form).getByLabelText("接口格式")).toHaveValue("openai-completions");
    expect(within(form).getByLabelText("Base URL")).toHaveValue("https://api.deepseek.com/v1");
    // The protocol select carries all three SDK ids; the preset never re-derives one.
    expect(within(form).getAllByRole("option").map((option) => (option as HTMLOptionElement).value))
      .toEqual(expect.arrayContaining(["openai-completions", "openai-responses", "anthropic-messages"]));

    await user.click(within(form).getByRole("button", { name: "保存并写入 models.json" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请填写 API Key");

    // The key field is masked, has an explicit eye toggle, and is the only place
    // the value exists in the DOM before the save.
    const key = within(form).getByLabelText("API Key");
    expect(key).toHaveAttribute("type", "password");
    await user.type(key, KEY);
    expect(key).toHaveValue(KEY);
    await user.click(within(form).getByRole("button", { name: "显示密钥" }));
    expect(key).toHaveAttribute("type", "text");
    await user.click(within(form).getByRole("button", { name: "隐藏密钥" }));
    expect(key).toHaveAttribute("type", "password");

    await user.click(within(form).getByRole("button", { name: "保存并写入 models.json" }));
    await waitFor(() => expect(calls.some((call) => call.op === "save")).toBe(true));
    const save = calls.find((call) => call.op === "save")!;
    expect(save).toMatchObject({ apiKey: KEY, profile: { name: "DeepSeek", protocol: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1", credential: { kind: "store" }, modelId: "deepseek-chat" } });
    expect(save.profile).not.toHaveProperty("reconcile");
    // One copy of the key in the request; nothing in the list/status reply path.
    expect(JSON.stringify(save).split(KEY)).toHaveLength(2);
    expect(JSON.stringify({ ...save, apiKey: undefined })).not.toContain(KEY);
    expect(await screen.findByTestId("providers-panel")).toBeInTheDocument();
  });

  it("sends no key when editing a profile that already has one, and shows a saved marker", async () => {
    const { calls } = bridge({ list: { ...EMPTY_STATUS, profiles: [PROFILE] }, save: { profile: PROFILE, written: true, conflict: null } });
    const user = userEvent.setup();
    page();
    await waitFor(() => expect(screen.getByTestId(`provider-card-${PROFILE.id}`)).toBeInTheDocument());
    await user.click(within(screen.getByTestId(`provider-card-${PROFILE.id}`)).getByRole("button", { name: "编辑" }));
    const form = await screen.findByTestId("provider-form");
    expect(screen.getByRole("heading", { name: /编辑供应商：Local gateway/ })).toBeInTheDocument();
    const key = within(form).getByLabelText("API Key");
    expect(key).toHaveValue("");
    expect(key).toHaveAttribute("placeholder", "已保存的密钥不会显示；留空保留");
    expect(within(form).getByText(/已保存一份密钥：留空表示继续使用它/)).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "保存并写入 models.json" }));
    await waitFor(() => expect(calls.some((call) => call.op === "save")).toBe(true));
    expect(calls.find((call) => call.op === "save")).not.toHaveProperty("apiKey");
    expect(JSON.stringify(calls.find((call) => call.op === "save"))).not.toContain(KEY);
  });

  it("adds discovered models without rewriting the rows, and reports empty/unsupported truthfully", async () => {
    // [#138] The fixtures are main's own `DiscoveryOutcome` statuses now
    // (`success|empty|failure|unsupported`); a renderer-side near-synonym is
    // exactly the defect this case locks out.
    const { calls } = bridge({
      discover: (request: Record<string, unknown>) => request.protocol === "anthropic-messages"
        ? { status: "unsupported", candidates: [], message: "该端点未提供模型列表接口（HTTP 404）" }
        : request.baseUrl === "https://empty.test/v1"
          ? { status: "empty", candidates: [], message: "端点返回了空的模型列表" }
          : { status: "success", candidates: ["discovered-a", "discovered-b"], message: "已同步 2 个候选" },
    });
    const user = userEvent.setup();
    page();
    await screen.findByTestId("providers-panel");
    await user.click(screen.getByRole("button", { name: /添加供应商/ }));
    const form = await screen.findByTestId("provider-form");
    await user.type(within(form).getByLabelText("名称"), "Discovery");
    await user.type(within(form).getByLabelText("Base URL"), "https://models.example.test/v1");
    await user.type(within(form).getByLabelText(/^模型 ID 1/), "manual-model");
    await user.selectOptions(within(form).getByLabelText("默认模型"), "manual-model");
    await user.type(within(form).getByLabelText("API Key"), KEY);

    await user.click(within(form).getByRole("button", { name: "获取模型列表" }));
    expect(await screen.findByRole("list", { name: "可选模型" })).toBeInTheDocument();
    expect(calls.find((call) => call.op === "discover")).toMatchObject({ protocol: "openai-completions", apiKey: KEY });
    await user.click(within(form).getByRole("button", { name: "＋ discovered-b" }));
    // Discovery only ADDS: the manual row is still there with its own values.
    expect(within(form).getByLabelText(/^模型 ID 1/)).toHaveValue("manual-model");
    expect(within(form).getByLabelText(/^模型 ID 2/)).toHaveValue("discovered-b");

    await user.clear(within(form).getByLabelText("Base URL"));
    await user.type(within(form).getByLabelText("Base URL"), "https://empty.test/v1");
    await user.click(within(form).getByRole("button", { name: "获取模型列表" }));
    await waitFor(() => expect(screen.getByText("端点返回了空的模型列表")).toBeInTheDocument());
    expect(screen.queryByRole("list", { name: "可选模型" })).toBeNull();

    await user.selectOptions(within(form).getByLabelText("接口格式"), "anthropic-messages");
    await user.click(within(form).getByRole("button", { name: "获取模型列表" }));
    await waitFor(() => expect(screen.getByText("该端点未提供模型列表接口（HTTP 404）")).toBeInTheDocument());
    expect(calls.filter((call) => call.op === "discover").map((call) => call.protocol))
      .toEqual(["openai-completions", "openai-completions", "anthropic-messages"]);
  });

  it("Escape from a form button returns to the list before leaving management", async () => {
    bridge();
    const onBack = vi.fn();
    render(<DesktopCapabilitiesPage taskId="task-1" onBack={onBack} />);
    await userEvent.click(screen.getByRole("button", { name: /添加供应商/ }));
    const cancel = screen.getByRole("button", { name: "取消" });
    cancel.focus();
    await userEvent.keyboard("{Escape}");
    expect(await screen.findByTestId("providers-panel")).toBeInTheDocument();
    expect(onBack).not.toHaveBeenCalled();
  });

  it("offers discovered IDs per model while preserving manual input through loading and failure", async () => {
    let complete!: (reply: unknown) => void;
    const providerOp = vi.fn(async (request: Record<string, unknown>) => request.op === "discover"
      ? await new Promise((resolve) => { complete = resolve; })
      : { ok: true, payload: EMPTY_STATUS });
    (window as unknown as { pidock: unknown }).pidock = { providerOp };
    page();
    await userEvent.click(screen.getByRole("button", { name: /添加供应商/ }));
    await userEvent.type(screen.getByLabelText("Base URL"), "https://models.example.test/v1");
    const id = screen.getByLabelText("模型 ID 1");
    await userEvent.type(id, "manual-model");
    expect(screen.queryByRole("combobox", { name: "已发现模型 1" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
    expect(screen.getByRole("status")).toHaveTextContent("正在获取模型列表");
    expect(id).toHaveValue("manual-model");
    complete({ ok: true, payload: { status: "success", candidates: ["discovered-a"], message: "已同步 1 个候选" } });
    const discovered = await screen.findByRole("combobox", { name: "已发现模型 1" });
    await userEvent.selectOptions(discovered, "discovered-a");
    expect(id).toHaveValue("discovered-a");
    await userEvent.clear(id);
    await userEvent.type(id, "my-custom-id");
    await userEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
    complete({ ok: false, error: "端点暂时不可用" });
    expect(await screen.findByText("端点暂时不可用")).toBeInTheDocument();
    expect(id).toHaveValue("my-custom-id");
  });

  it("renders the candidates of a successful discovery and quotes main's failure reason verbatim", async () => {
    // [#138] The real-Electron capture: a successful discovery rendered zero
    // candidates and a network failure lost `无法连接端点`, because the renderer
    // accepted a different status dialect than main sends. Both halves are
    // asserted here with main's own payloads.
    const { calls } = bridge({
      discover: (request: Record<string, unknown>) => request.baseUrl === "https://down.test/v1"
        ? { status: "failure", candidates: [], message: "模型发现失败：无法连接端点；已保留表单与已配置模型" }
        : { status: "success", candidates: ["loopback-chat-7b", "loopback-fast"], message: "已同步 2 个候选" },
    });
    const user = userEvent.setup();
    page();
    await screen.findByTestId("providers-panel");
    await user.click(screen.getByRole("button", { name: /添加供应商/ }));
    const form = await screen.findByTestId("provider-form");
    await user.type(within(form).getByLabelText("名称"), "Loopback");
    await user.type(within(form).getByLabelText("Base URL"), "https://models.example.test/v1");
    await user.type(within(form).getByLabelText(/^模型 ID 1/), "manual-model");
    await user.type(within(form).getByLabelText("API Key"), KEY);

    await user.click(within(form).getByRole("button", { name: "获取模型列表" }));
    const list = await screen.findByRole("list", { name: "可选模型" });
    expect(within(list).getAllByRole("button").map((button) => button.textContent))
      .toEqual(["＋ loopback-chat-7b", "＋ loopback-fast"]);
    expect(screen.getByText("已同步 2 个候选")).toBeInTheDocument();
    // The manual id is only noted, never turned into an error.
    expect(screen.getByTestId("discovery-misses")).toHaveTextContent("manual-model");
    expect(within(form).getByRole("button", { name: "保存并写入 models.json" })).not.toBeDisabled();
    expect(screen.queryByText(/模型列表返回异常/)).toBeNull();

    await user.clear(within(form).getByLabelText("Base URL"));
    await user.type(within(form).getByLabelText("Base URL"), "https://down.test/v1");
    await user.click(within(form).getByRole("button", { name: "获取模型列表" }));
    // main's own sentence, character for character; no renderer-side rewrite.
    expect(await screen.findByText("模型发现失败：无法连接端点；已保留表单与已配置模型")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "可选模型" })).toBeNull();
    expect(screen.queryByTestId("discovery-misses")).toBeNull();
    expect(screen.queryByText(/模型列表返回异常/)).toBeNull();
    // The typed row survives the failure and nothing was written.
    expect(within(form).getByLabelText(/^模型 ID 1/)).toHaveValue("manual-model");
    expect(calls.some((call) => call.op === "save")).toBe(false);
  });

  it("only offers reasoning levels the model declares, and never shows 'off' as a toggle", async () => {
    bridge();
    const user = userEvent.setup();
    page();
    await screen.findByTestId("providers-panel");
    await user.click(screen.getByRole("button", { name: /添加供应商/ }));
    const form = await screen.findByTestId("provider-form");
    expect(within(form).queryByLabelText("低档位 1")).toBeNull();
    await user.click(within(form).getByLabelText("思维链推理 1"));
    for (const level of ["关闭档位 1", "低档位 1", "中档位 1", "高档位 1", "极高档位 1"]) expect(within(form).getByLabelText(level)).toBeInTheDocument();
    // Enabling reasoning declares only 关闭 (= no thinking) until the user ticks
    // the levels the endpoint documents — nothing is pre-ticked as supported.
    expect(within(form).getByLabelText("关闭档位 1")).toBeChecked();
    expect(within(form).getByLabelText("低档位 1")).not.toBeChecked();
    expect(within(form).getByLabelText("极高档位 1")).not.toBeChecked();
    await user.click(within(form).getByLabelText("低档位 1"));
    await user.click(within(form).getByLabelText("极高档位 1"));
    expect(within(form).getByLabelText("极高档位 1")).toBeChecked();
    expect(within(form).getByLabelText("低档位 1")).toBeChecked();
    // Unchecking the capability removes the level controls entirely.
    await user.click(within(form).getByLabelText("思维链推理 1"));
    expect(within(form).queryByLabelText("低档位 1")).toBeNull();
    expect(within(form).getByText("仅关闭")).toBeInTheDocument();
  });

  it("validates in place and reports the bounded connectivity failure", async () => {
    const { calls } = bridge({ probe: { ok: false, code: "provider-auth-rejected", message: "认证被拒绝（HTTP 401）", status: 401, latencyMs: 42 } });
    const user = userEvent.setup();
    page();
    await screen.findByTestId("providers-panel");
    await user.click(screen.getByRole("button", { name: /添加供应商/ }));
    const form = await screen.findByTestId("provider-form");
    await user.type(within(form).getByLabelText("名称"), "Broken");
    await user.type(within(form).getByLabelText("Base URL"), "ftp://models.example.test");
    await user.type(within(form).getByLabelText(/^模型 ID 1/), "m");
    await user.selectOptions(within(form).getByLabelText("默认模型"), "m");
    await user.type(within(form).getByLabelText("API Key"), KEY);
    await user.clear(within(form).getByLabelText(/^上下文窗口 1/));
    await user.type(within(form).getByLabelText(/^上下文窗口 1/), "0");
    await user.click(within(form).getByRole("button", { name: "保存并写入 models.json" }));
    expect(within(form).getByText("Base URL 需要是 http(s) 地址")).toBeInTheDocument();
    expect(within(form).getByText("上下文窗口需要是正整数")).toBeInTheDocument();
    expect(calls.some((call) => call.op === "save")).toBe(false);

    await user.click(within(form).getByRole("button", { name: "测试连通性" }));
    expect(await screen.findByTestId("probe-result")).toHaveTextContent("认证被拒绝（HTTP 401）");
    expect(calls.find((call) => call.op === "probe")).toMatchObject({ modelId: "m", protocol: "openai-completions", apiKey: KEY });
    expect(screen.getByTestId("probe-result")).toHaveTextContent("HTTP 401");
  });

  it("names an external models.json edit and only overwrites on an explicit reconcile", async () => {
    const save = vi.fn()
      .mockResolvedValueOnce({ profile: PROFILE, written: false, conflict: "modified" })
      .mockResolvedValueOnce({ profile: PROFILE, written: true, conflict: null });
    const { calls } = bridge({ list: { ...EMPTY_STATUS, profiles: [PROFILE] }, save: (request: Record<string, unknown>) => save(request) });
    const user = userEvent.setup();
    page();
    await waitFor(() => expect(screen.getByTestId(`provider-card-${PROFILE.id}`)).toBeInTheDocument());
    await user.click(within(screen.getByTestId(`provider-card-${PROFILE.id}`)).getByRole("button", { name: "编辑" }));
    await screen.findByTestId("provider-form");
    await user.click(within(screen.getByTestId("provider-form")).getByRole("button", { name: "保存并写入 models.json" }));
    const conflict = await screen.findByText(/已被外部改动（外部修改），PiDock 没有覆盖它/);
    expect(conflict).toBeInTheDocument();
    expect(calls.filter((call) => call.op === "save")).toHaveLength(1);
    expect(calls.find((call) => call.op === "save")).not.toHaveProperty("reconcile");
    await user.click(screen.getByRole("button", { name: "用这份表单覆盖外部修改" }));
    await waitFor(() => expect(calls.filter((call) => call.op === "save")).toHaveLength(2));
    expect(calls.filter((call) => call.op === "save")[1]).toMatchObject({ reconcile: true, profile: { id: PROFILE.id } });
  });

  it("closes on Esc and saves on ⌘↵ without a second click", async () => {
    const { calls } = bridge({ save: { profile: PROFILE, written: true, conflict: null } });
    const user = userEvent.setup();
    page();
    await screen.findByTestId("providers-panel");
    await user.click(screen.getByRole("button", { name: /添加供应商/ }));
    await screen.findByTestId("provider-form");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("provider-form")).toBeNull());
    expect(screen.getByTestId("providers-panel")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /添加供应商/ }));
    const again = await screen.findByTestId("provider-form");
    await user.type(within(again).getByLabelText("名称"), "Keyboard");
    await user.type(within(again).getByLabelText("Base URL"), "https://models.example.test/v1");
    await user.type(within(again).getByLabelText(/^模型 ID 1/), "m");
    await user.selectOptions(within(again).getByLabelText("默认模型"), "m");
    await user.type(within(again).getByLabelText("API Key"), KEY);
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(calls.some((call) => call.op === "save")).toBe(true));
    expect(screen.queryByTestId("provider-form")).toBeNull();
    // W3: the window shortcut and the form's own ⌘↵ handler both fire for one
    // key press; without a synchronous guard that is two saves.
    expect(calls.filter((call) => call.op === "save")).toHaveLength(1);
  });

  it("says a task is required for 选用 and never pretends to select without one", async () => {
    const { providerOp } = bridge({ list: { ...EMPTY_STATUS, profiles: [PROFILE] } });
    render(<DesktopCapabilitiesPage taskId={null} taskName={null} />);
    expect(await screen.findByTestId("providers-task-required")).toHaveTextContent("尚未打开任务");
    expect(within(screen.getByTestId(`provider-card-${PROFILE.id}`)).getByRole("button", { name: "选用" })).toBeDisabled();
    expect(providerOp).toHaveBeenCalledTimes(1);
  });

  it("selects the chosen model of a multi-model profile for the current task", async () => {
    // The list re-read after a write is authoritative, so the mock answers it
    // with the configured status the way main does.
    let selected = false;
    const configured = { ...EMPTY_STATUS, state: "configured", profileId: PROFILE.id, modelId: "gpt-5", thinkingLevel: "high", generation: 1, profiles: [PROFILE] };
    const { calls } = bridge({ list: () => (selected ? configured : { ...EMPTY_STATUS, profiles: [PROFILE] }),
      select: () => { selected = true; return configured; } });
    const user = userEvent.setup();
    page();
    await waitFor(() => expect(screen.getByTestId(`provider-card-${PROFILE.id}`)).toBeInTheDocument());
    const card = screen.getByTestId(`provider-card-${PROFILE.id}`);
    await user.selectOptions(within(card).getByLabelText("选用模型（Local gateway）"), "gpt-5");
    await user.click(within(card).getByRole("button", { name: "选用" }));
    await waitFor(() => expect(calls.some((call) => call.op === "select")).toBe(true));
    // W9: the chosen level travels with the selection (main would otherwise
    // resolve the model's own default) and the card shows what was chosen.
    expect(calls.find((call) => call.op === "select")).toEqual({
      op: "select", taskId: "task-1", profileId: PROFILE.id, modelId: "gpt-5", thinkingLevel: "high",
    });
    await waitFor(() => expect(screen.getByTestId("providers-state")).toHaveTextContent("已配置"));
    expect(screen.getByTestId(`provider-current-${PROFILE.id}`)).toHaveTextContent("当前任务已选用 · gpt-5 · 推理 高");
  });

  it("lets the user pick the level a 选用 carries, and defaults to high", async () => {
    const { calls } = bridge({ list: { ...EMPTY_STATUS, profiles: [PROFILE] }, select: EMPTY_STATUS });
    const user = userEvent.setup();
    page();
    await waitFor(() => expect(screen.getByTestId(`provider-card-${PROFILE.id}`)).toBeInTheDocument());
    const card = screen.getByTestId(`provider-card-${PROFILE.id}`);
    await user.selectOptions(within(card).getByLabelText("选用模型（Local gateway）"), "gpt-5");
    // `high` is declared, so it is the default — never the weakest tier.
    expect(within(card).getByLabelText("推理档位（Local gateway）")).toHaveValue("high");
    await user.selectOptions(within(card).getByLabelText("推理档位（Local gateway）"), "low");
    await user.click(within(card).getByRole("button", { name: "选用" }));
    await waitFor(() => expect(calls.some((call) => call.op === "select")).toBe(true));
    expect(calls.find((call) => call.op === "select")).toMatchObject({ modelId: "gpt-5", thinkingLevel: "low" });
  });

  it("removes a profile only after a second, explicit confirmation", async () => {
    const { calls } = bridge({ list: { ...EMPTY_STATUS, profiles: [PROFILE] }, remove: EMPTY_STATUS });
    const user = userEvent.setup();
    page();
    await waitFor(() => expect(screen.getByTestId(`provider-card-${PROFILE.id}`)).toBeInTheDocument());
    await user.click(within(screen.getByTestId(`provider-card-${PROFILE.id}`)).getByRole("button", { name: "删除" }));
    expect(calls.some((call) => call.op === "remove")).toBe(false);
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(calls.some((call) => call.op === "remove")).toBe(true));
    expect(calls.find((call) => call.op === "remove")).toEqual({ op: "remove", profileId: PROFILE.id, taskId: "task-1" });
  });
});

describe("S03B review fixes", () => {
  const fillManual = async (form: HTMLElement, id: string) => {
    const user = userEvent.setup();
    await user.type(within(form).getByLabelText("名称"), "Manual");
    await user.type(within(form).getByLabelText("Base URL"), "https://models.example.test/v1");
    await user.type(within(form).getByLabelText(/^模型 ID 1/), id);
    await user.selectOptions(within(form).getByLabelText("默认模型"), id);
    await user.type(within(form).getByLabelText("API Key"), KEY);
    return user;
  };

  it("saves a manually typed model id after a successful discovery", async () => {
    // C2: discovery only ADDS candidates, so a miss is a note — the save must
    // still go out with the manual id the user typed.
    const { calls } = bridge({
      discover: { status: "success", candidates: ["deepseek-chat"], message: "已同步 1 个候选" },
      save: { profile: PROFILE, written: true, conflict: null },
    });
    page();
    await screen.findByTestId("providers-panel");
    await userEvent.click(screen.getByRole("button", { name: /添加供应商/ }));
    const form = await screen.findByTestId("provider-form");
    const user = await fillManual(form, "manual-model");
    await user.click(within(form).getByRole("button", { name: "获取模型列表" }));
    expect(await screen.findByTestId("discovery-misses")).toHaveTextContent("manual-model");
    await user.click(within(form).getByRole("button", { name: "保存并写入 models.json" }));
    await waitFor(() => expect(calls.some((call) => call.op === "save")).toBe(true));
    expect(calls.find((call) => call.op === "save")).toMatchObject({ profile: { modelId: "manual-model" } });
  });

  it("writes a price only when all four fields are known", async () => {
    const { calls } = bridge({ save: { profile: PROFILE, written: true, conflict: null } });
    page();
    await screen.findByTestId("providers-panel");
    await userEvent.click(screen.getByRole("button", { name: /添加供应商/ }));
    const form = await screen.findByTestId("provider-form");
    const user = await fillManual(form, "gpt-5");
    await user.type(within(form).getByLabelText("输入价格 1"), "1.5");
    await user.click(within(form).getByRole("button", { name: "保存并写入 models.json" }));
    // W5: a half-declared price would have to invent 0 for the rest.
    expect(await within(form).findAllByText(/价格需要四项/)).not.toHaveLength(0);
    expect(calls.some((call) => call.op === "save")).toBe(false);

    await user.type(within(form).getByLabelText("输出价格 1"), "6");
    await user.type(within(form).getByLabelText("缓存读价格 1"), "0");
    await user.type(within(form).getByLabelText("缓存写价格 1"), "0");
    await user.click(within(form).getByRole("button", { name: "保存并写入 models.json" }));
    await waitFor(() => expect(calls.some((call) => call.op === "save")).toBe(true));
    expect((calls.find((call) => call.op === "save") as { profile: { models: { cost?: unknown }[] } }).profile.models[0]!.cost)
      .toEqual({ input: 1.5, output: 6, cacheRead: 0, cacheWrite: 0 });
  });

  it("shows 无可用档位 for a reasoning model with no usable tier", async () => {
    // W6: the row is readable, and 选用 does not pretend a level exists.
    const tierless = {
      ...PROFILE, modelId: "gpt-5", thinkingLevel: null,
      models: [{ id: "gpt-5", name: "GPT-5", contextWindow: 128000, maxTokens: 8192, reasoning: true, reasoningLevels: [], cost: null }],
    };
    const { calls } = bridge({ list: { ...EMPTY_STATUS, profiles: [tierless] } });
    page();
    await waitFor(() => expect(screen.getByTestId(`provider-card-${tierless.id}`)).toBeInTheDocument());
    const card = screen.getByTestId(`provider-card-${tierless.id}`);
    expect(card).toHaveTextContent("gpt-5 · 推理 · 无可用档位");
    expect(within(card).getByTestId(`provider-levels-missing-${tierless.id}`)).toHaveTextContent("无可用档位");
    expect(within(card).queryByLabelText("推理档位（Local gateway）")).toBeNull();
    expect(within(card).getByRole("button", { name: "选用" })).toBeDisabled();
    expect(calls.some((call) => call.op === "select")).toBe(false);
  });

  it("refuses to delete an externally modified entry until the user says so", async () => {
    // W7: main refuses the removal without `reconcile`; the UI names the
    // external version first and only then sends the explicit acknowledgement.
    const modified = { ...PROFILE, native: { providerId: PROFILE.native.providerId, state: "modified" } };
    const { calls } = bridge({ list: { ...EMPTY_STATUS, profiles: [modified] }, remove: EMPTY_STATUS });
    page();
    await waitFor(() => expect(screen.getByTestId(`provider-card-${modified.id}`)).toBeInTheDocument());
    const card = screen.getByTestId(`provider-card-${modified.id}`);
    await userEvent.click(within(card).getByRole("button", { name: "删除" }));
    expect(calls.some((call) => call.op === "remove")).toBe(false);
    expect(await within(card).findByText(/确认删除会连同外部版本一起移除/)).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "确认删除外部版本" }));
    await waitFor(() => expect(calls.some((call) => call.op === "remove")).toBe(true));
    expect(calls.find((call) => call.op === "remove")).toEqual({ op: "remove", profileId: modified.id, taskId: "task-1", reconcile: true });
  });
});
