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
function bridge(replies: Record<string, Reply> = {}) {
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
  (window as unknown as { pidock?: unknown }).pidock = { providerOp };
  return { calls, providerOp };
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
    expect(calls[0]).toEqual({ op: "list" });
    await waitFor(() => expect(screen.getByTestId("native-path")).toHaveTextContent("/Users/test/.pi/agent/models.json"));
  });

  it("keeps MCP and Skills honest instead of showing counts or sample rows", async () => {
    bridge();
    page();
    await screen.findByTestId("providers-panel");
    await userEvent.click(screen.getByRole("button", { name: /^MCP/ }));
    expect(await screen.findByTestId("capabilities-mcp")).toHaveTextContent("Host 还没有 MCP Servers 的真实清单");
    expect(screen.getByTestId("capabilities-mcp")).toHaveTextContent("后续工单 150");
    await userEvent.click(screen.getByRole("button", { name: /^Skills/ }));
    expect(await screen.findByTestId("capabilities-skills")).toHaveTextContent("后续工单 151");
    // No MCP/Skills row count is invented: the nav marks them 未接线 instead.
    const nav = screen.getByRole("navigation", { name: "能力管理" });
    expect(within(nav).getAllByText("未接线")).toHaveLength(2);
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
    expect(within(form).getByRole("heading", { name: /编辑供应商：Local gateway/ })).toBeInTheDocument();
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
    const { calls } = bridge({
      discover: (request: Record<string, unknown>) => request.protocol === "anthropic-messages"
        ? { status: "unsupported", candidates: [], message: "该端点未提供模型列表接口（HTTP 404）" }
        : request.baseUrl === "https://empty.test/v1"
          ? { status: "empty", candidates: [], message: "端点返回了空的模型列表" }
          : { status: "ok", candidates: ["discovered-a", "discovered-b"], message: "发现 2 个候选模型" },
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

  it("only offers reasoning levels the model declares, and never shows 'off' as a toggle", async () => {
    bridge();
    const user = userEvent.setup();
    page();
    await screen.findByTestId("providers-panel");
    await user.click(screen.getByRole("button", { name: /添加供应商/ }));
    const form = await screen.findByTestId("provider-form");
    expect(within(form).queryByLabelText("低档位 1")).toBeNull();
    await user.click(within(form).getByLabelText("思维链推理 1"));
    for (const level of ["低档位 1", "中档位 1", "高档位 1", "极高档位 1"]) expect(within(form).getByLabelText(level)).toBeInTheDocument();
    expect(within(form).queryByLabelText("关闭档位 1")).toBeNull();
    expect(within(form).getByLabelText("低档位 1")).toBeChecked();
    expect(within(form).getByLabelText("极高档位 1")).not.toBeChecked();
    await user.click(within(form).getByLabelText("极高档位 1"));
    expect(within(form).getByLabelText("极高档位 1")).toBeChecked();
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
    expect(calls.find((call) => call.op === "select")).toEqual({ op: "select", taskId: "task-1", profileId: PROFILE.id, modelId: "gpt-5" });
    await waitFor(() => expect(screen.getByTestId("providers-state")).toHaveTextContent("已配置"));
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
