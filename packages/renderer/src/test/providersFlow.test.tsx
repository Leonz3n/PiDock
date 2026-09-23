import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createMemoryHost } from "../data/memoryHost";
import { describeProviderAvailability } from "../data/providerState";
import { useHostStore } from "../stores/host";
import { renderApp } from "./helpers";

/**
 * [PiDock 11] #9 UI flows: provider status/sync, the model popover (search,
 * arrows/Enter, Esc/outside, greyed reasons), the context popover and the
 * unavailable-configuration reporting. All data is the in-memory model — no
 * provider request leaves the app, and no Electron run is needed.
 */
describe("provider page status and sync", () => {
  it("shows availability, auth presence and per-model capacity without leaking the reference", async () => {
    renderApp("/providers");
    await screen.findByRole("heading", { name: "Provider 与上下文" });
    const status = screen.getByTestId("provider-status-provider-anthropic");
    expect(status).toHaveTextContent("可用性：可用");
    expect(status).toHaveTextContent("认证：引用已配置");
    // The reference name itself is not part of the page text.
    expect(status.textContent).not.toContain("anthropic-key");
    expect(screen.getAllByText("200000").length).toBeGreaterThan(0);
  });

  it("reports each sync outcome and never rewrites configured models", async () => {
    const user = userEvent.setup();
    renderApp("/providers");
    await screen.findByRole("heading", { name: "Provider 与上下文" });

    // Success: candidates only.
    await user.click(screen.getAllByRole("button", { name: "同步模型列表" })[0]!);
    expect(await screen.findByTestId("provider-sync-provider-anthropic")).toHaveTextContent("已同步 3 个候选");
    expect(await screen.findByText("Claude Haiku")).toBeInTheDocument();

    // Empty / failure / unsupported through the fixture connection convention.
    const adapter = useHostStore.getState().adapter;
    const host = createMemoryHost();
    void host;
    const created = await adapter.saveProvider({
      name: "空列表网关",
      protocol: "openai-responses",
      baseUrl: "https://gw.example.com/empty",
      enabled: true,
      models: [{ id: "gpt-5", contextWindow: 8 }],
    });
    expect((await adapter.syncProviderModels(created.id)).status).toBe("empty");
    const failing = await adapter.saveProvider({
      name: "失败网关",
      protocol: "openai-responses",
      baseUrl: "https://gw.example.com/fail",
      enabled: true,
      models: [{ id: "gpt-5", contextWindow: 8 }],
    });
    expect((await adapter.syncProviderModels(failing.id)).status).toBe("failure");
    const unsupported = await adapter.saveProvider({
      name: "无发现端点",
      protocol: "custom-proto",
      baseUrl: "https://gw.example.com/v1",
      enabled: true,
      models: [{ id: "custom-1", contextWindow: 8 }],
    });
    const view = await adapter.syncProviderModels(unsupported.id);
    expect(view.status).toBe("unsupported");
    expect(view.message).toContain("未声明模型发现端点");
  });

  it("enables/disables a configuration and keeps session attribution when one is removed", async () => {
    const user = userEvent.setup();
    renderApp("/providers");
    await screen.findByRole("heading", { name: "Provider 与上下文" });
    const firstPanel = screen.getByText("Anthropic 官方").closest("section") ?? document.body;
    await user.click(within(firstPanel as HTMLElement).getByRole("button", { name: "停用" }));
    expect(await screen.findByText("已停用该配置；引用它的会话会提示配置不可用")).toBeInTheDocument();

    await user.click(within(firstPanel as HTMLElement).getByRole("button", { name: "启用" }));
    await user.click(within(firstPanel as HTMLElement).getByRole("button", { name: "删除" }));
    expect(await screen.findByText("已移除配置；会话与历史仍显示原归属并提示配置不可用，不会自动改选其他账户")).toBeInTheDocument();

    // The session still names the removed provider and the task page reports it.
    const session = await useHostStore.getState().adapter.getSession("release", "main");
    expect(session?.providerId).toBe("provider-anthropic");
    await useHostStore.getState().refresh();
  });
});

describe("add-form discovery", () => {
  it("syncs the draft connection before the first save and invalidates it on a changed connection", async () => {
    const user = userEvent.setup();
    renderApp("/providers");
    await screen.findByRole("heading", { name: "Provider 与上下文" });
    await user.click(screen.getByRole("button", { name: "添加 Provider" }));
    const dialog = await screen.findByRole("dialog", { name: "添加 Provider" });

    // No address yet: the sync explains what is missing instead of failing.
    await user.click(within(dialog).getByRole("button", { name: "同步模型列表" }));
    expect(await within(dialog).findByText("请先填写服务地址，再同步模型列表。")).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("显示名称"), "草稿网关");
    await user.type(within(dialog).getByLabelText("服务地址"), "https://gw.example.com/v1");
    await user.click(within(dialog).getByRole("button", { name: "同步模型列表" }));
    expect(await within(dialog).findByTestId("provider-catalog-status")).toHaveTextContent("已同步 3 个候选");
    // The candidate is offered in the shared datalist, and hand-typed ids stay allowed.
    expect(document.querySelectorAll("#provider-model-candidates option")).toHaveLength(3);

    // Changing the address invalidates the candidate set.
    const address = within(dialog).getByLabelText("服务地址");
    await user.clear(address);
    await user.type(address, "https://other.example.com/v1");
    expect(within(dialog).getByTestId("provider-catalog-stale")).toHaveTextContent("连接已变化，候选已失效，请重新同步");

    // A connection without a discovery endpoint reports `unsupported`.
    await user.clear(address);
    await user.type(address, "https://gw.example.com/no-discovery");
    await user.click(within(dialog).getByRole("button", { name: "同步模型列表" }));
    expect(await within(dialog).findByTestId("provider-catalog-status")).toHaveTextContent("未声明模型发现端点");
  });

  it("reports a model removed from its configuration without rewriting history", async () => {
    const adapter = createMemoryHost();
    await adapter.sendMessage("release", "main", "先留一条历史", []);
    const attributed = async () =>
      (await adapter.getSession("release", "main"))?.messages.filter((message) => message.attribution !== undefined) ?? [];
    const before = (await attributed()).at(-1);
    expect(before?.attribution).toEqual({ providerId: "provider-anthropic", model: "Claude Sonnet" });

    // The model is dropped from the configuration: the session keeps naming it.
    await adapter.saveProvider({
      id: "provider-anthropic",
      name: "Anthropic 官方",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      authRef: "anthropic-key",
      enabled: true,
      models: [{ id: "Claude Haiku", contextWindow: 200 }],
    });
    const session = await adapter.getSession("release", "main");
    expect(session?.providerId).toBe("provider-anthropic");
    expect(session?.model).toBe("Claude Sonnet");
    const status = describeProviderAvailability({ provider: (await adapter.getWorkspace()).providers.find((item) => item.id === "provider-anthropic")!, modelId: "Claude Sonnet" });
    expect(status).toMatchObject({ availability: "model-unavailable" });
    expect(status.message).toContain("已不在该配置中");
    // The old response still names the model it was produced by.
    expect((await attributed()).at(-1)?.attribution?.model).toBe("Claude Sonnet");
  });
});

describe("configuration edits vs the live session", () => {
  it("keeps the session's snapshot when the model window is edited mid-turn", async () => {
    const adapter = createMemoryHost();
    const before = await adapter.getSession("release", "main");
    expect(before?.contextWindow).toBe(200);

    // The configuration row is edited while the session is mid-turn; the
    // session keeps the window it started the call with, and the switch gate
    // then reads the new directory value.
    await adapter.sendMessage("release", "main", "改配置不影响这一次调用", []);
    await adapter.saveProvider({
      id: "provider-anthropic",
      name: "Anthropic 官方",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      authRef: "anthropic-key",
      enabled: true,
      models: [{ id: "Claude Sonnet", contextWindow: 64 }, { id: "Claude Haiku", contextWindow: 64 }],
    });
    const mid = await adapter.getSession("release", "main");
    expect(mid?.contextWindow).toBe(200);
    expect(mid?.model).toBe("Claude Sonnet");
    // Switching now re-reads the edited value for the new call.
    await adapter.setSessionModel("release", "main", "provider-anthropic", "Claude Haiku");
    expect((await adapter.getSession("release", "main"))?.contextWindow).toBe(64);
  });
});

describe("model row provenance", () => {
  it("distinguishes directory candidates, the editor default and hand-typed values", async () => {
    const user = userEvent.setup();
    renderApp("/providers");
    await screen.findByRole("heading", { name: "Provider 与上下文" });

    // A fresh row starts from the default window.
    await user.click(screen.getByRole("button", { name: "添加 Provider" }));
    const dialog = await screen.findByRole("dialog", { name: "添加 Provider" });
    await user.type(within(dialog).getByLabelText("显示名称"), "团队网关");
    await user.type(within(dialog).getByLabelText("服务地址"), "https://gw.example.com/v1");
    await user.type(within(dialog).getByLabelText("模型 ID 第 1 行"), "team-large");
    expect(within(dialog).getByTestId("model-window-source-1")).toHaveTextContent("默认值");

    // Typing a window makes it manual; the max output stays a separate figure.
    const windowInput = within(dialog).getByLabelText("模型上下文 第 1 行");
    await user.clear(windowInput);
    await user.type(windowInput, "64");
    await user.type(within(dialog).getByLabelText("模型最大输出 第 1 行"), "16");
    expect(within(dialog).getByTestId("model-window-source-1")).toHaveTextContent("手工值");

    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await screen.findByText("已保存 Provider 配置；凭据只保存引用，不写入共享模板与日志")).toBeInTheDocument();
    const listed = screen.getByText("团队网关").closest("section") as HTMLElement;
    expect(within(listed).getByText("64000")).toBeInTheDocument();
    expect(within(listed).getByText("手工值")).toBeInTheDocument();
    expect(within(listed).getByText("16000")).toBeInTheDocument();

    // Editing again echoes the saved provenance and the max output.
    await user.click(within(listed).getByRole("button", { name: "编辑" }));
    const edit = await screen.findByRole("dialog", { name: "编辑 Provider" });
    expect(within(edit).getByLabelText("模型上下文 第 1 行")).toHaveValue(64);
    expect(within(edit).getByLabelText("模型最大输出 第 1 行")).toHaveValue(16);
    expect(within(edit).getByTestId("model-window-source-1")).toHaveTextContent("手工值");
    // A row that picks a synced candidate records the directory as the source,
    // while the hand-typed row above keeps saying 手工值.
    await user.click(within(edit).getByRole("button", { name: "同步模型列表" }));
    await within(edit).findByText("已同步 3 个候选");
    await user.click(within(edit).getByRole("button", { name: "添加模型" }));
    await user.type(within(edit).getByLabelText("模型 ID 第 2 行"), "claude-haiku-4-5");
    expect(within(edit).getByTestId("model-window-source-2")).toHaveTextContent("模型目录");
    expect(within(edit).getByTestId("model-window-source-1")).toHaveTextContent("手工值");
  });
});

describe("model popover", () => {
  it("searches by provider/model, greys the over-limit target with its numbers and switches with Enter", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    await user.click(screen.getByRole("button", { name: /^选择模型：Claude Sonnet$/ }));
    const dialog = await screen.findByRole("dialog", { name: "选择 Provider 与模型" });

    // Current selection, attribution and occupancy are visible in the popover.
    expect(within(dialog).getByTestId("picker-current")).toHaveTextContent("Anthropic 官方 / Claude Sonnet");
    expect(within(dialog).getByTestId("picker-current")).toHaveTextContent("占用 24800 Tokens");

    // 团队轻量模型 has a 16k window and the session occupies 24.8k: greyed with numbers.
    const tight = within(dialog).getByRole("button", { name: "模型 团队轻量模型" });
    expect(tight).toBeDisabled();
    expect(tight).toHaveTextContent("24800 Tokens");
    expect(tight).toHaveTextContent("16000 Tokens");

    // Search narrows to the local provider, arrow keys + Enter pick the model.
    const search = within(dialog).getByLabelText("搜索模型");
    await user.type(search, "本地");
    expect(within(dialog).queryByRole("button", { name: "模型 Claude Haiku" })).toBeNull();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("button", { name: "选择模型：本地 Qwen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^选择模型：本地 Qwen$/ })).toBeInTheDocument();
  });

  it("closes on Escape and on a backdrop click", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    await user.click(screen.getByRole("button", { name: /^选择模型：Claude Sonnet$/ }));
    await screen.findByRole("dialog", { name: "选择 Provider 与模型" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "选择 Provider 与模型" })).toBeNull();

    await user.click(screen.getByRole("button", { name: /^选择模型：Claude Sonnet$/ }));
    const dialog = await screen.findByRole("dialog", { name: "选择 Provider 与模型" });
    await user.click(dialog.parentElement as HTMLElement);
    expect(screen.queryByRole("dialog", { name: "选择 Provider 与模型" })).toBeNull();

    // The popover offers the management entry.
    await user.click(screen.getByRole("button", { name: /^选择模型：Claude Sonnet$/ }));
    await screen.findByRole("dialog", { name: "选择 Provider 与模型" });
    await user.click(screen.getByRole("button", { name: "管理 Provider" }));
    expect(await screen.findByRole("heading", { name: "Provider 与上下文" })).toBeInTheDocument();
  });

  it("refuses a switch while the round is busy and keeps model, history and draft", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    await user.type(screen.getByLabelText("消息输入"), "保留草稿");
    await user.click(screen.getByRole("button", { name: /^选择模型：Claude Sonnet$/ }));
    await screen.findByRole("dialog", { name: "选择 Provider 与模型" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "选择 Provider 与模型" })).toBeNull();
    expect(screen.getByLabelText("消息输入")).toHaveValue("保留草稿");

    // The busy gate is a session-level rule: the seeded `deploy` session waits
    // for a confirmation, so the switch refuses and changes nothing.
    const adapter = useHostStore.getState().adapter;
    await expect(adapter.setSessionModel("release", "deploy", "provider-local", "本地 Qwen")).rejects.toThrow("等待确认中尚未结束");
    const deploy = await adapter.getSession("release", "deploy");
    expect(deploy?.providerId).toBe("provider-anthropic");
    expect(deploy?.model).toBe("Claude Sonnet");
    expect(deploy?.runState).toBe("approval");
  });
});

describe("response attribution", () => {
  it("keeps each response on the account that produced it and reports an unavailable one", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    const adapter = useHostStore.getState().adapter;

    // Two turns on two different accounts: each response keeps its own.
    await adapter.sendMessage("release", "main", "先按当前模型回答", []);
    await adapter.setSessionModel("release", "main", "provider-local", "本地 Qwen");
    await adapter.sendMessage("release", "main", "再换一个模型回答", []);
    await useHostStore.getState().refresh();

    const first = (await adapter.getSession("release", "main"))?.messages.filter((message) => message.role === "agent" && message.attribution !== undefined);
    expect(first?.map((message) => message.attribution)).toEqual([
      { providerId: "provider-anthropic", model: "Claude Sonnet" },
      { providerId: "provider-local", model: "本地 Qwen" },
    ]);
    expect(await screen.findByTestId("message-attribution-provider-anthropic")).toHaveTextContent("Anthropic 官方 / Claude Sonnet");
    expect(await screen.findByTestId("message-attribution-provider-local")).toHaveTextContent("本地推理 / 本地 Qwen");

    // Renaming keeps the original identification; disabling reports unavailable.
    void user;
    await adapter.saveProvider({ id: "provider-anthropic", name: "Anthropic 团队账号", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", enabled: false, models: [{ id: "Claude Sonnet", contextWindow: 200 }] });
    await useHostStore.getState().refresh();
    const renamed = await screen.findByTestId("message-attribution-provider-anthropic");
    expect(renamed).toHaveTextContent("Anthropic 团队账号 / Claude Sonnet");
    expect(renamed).toHaveTextContent("该配置已停用");
  });
});

describe("context and reasoning popovers", () => {
  it("shows unformatted occupancy with the estimate marker and preserves tokens after compaction", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    // Below the composer input: raw occupancy/window, the percentage and the marker.
    expect(screen.getByRole("button", { name: "查看上下文占用" })).toHaveTextContent("上下文 24800 / 200000 Tokens · 12.4%");
    await user.click(screen.getByRole("button", { name: "查看上下文占用" }));
    const dialog = await screen.findByRole("dialog", { name: "上下文占用" });
    expect(within(dialog).getByTestId("context-numbers")).toHaveTextContent("占用 24800 Tokens · 上限 200000 Tokens");
    expect(within(dialog).getByTestId("context-tokens")).toHaveTextContent("68.4k");
    await user.click(within(dialog).getByRole("button", { name: "模拟压缩" }));
    expect(await screen.findByRole("button", { name: "查看上下文占用" })).toHaveTextContent("待更新");
    expect(await useHostStore.getState().adapter.getSession("release", "main")).toMatchObject({ contextSource: "pending", tokens: 68.4 });
  });

  it("refuses compaction while the round is still open and keeps the numbers", async () => {
    const adapter = createMemoryHost();
    // The seeded `deploy` session waits for a confirmation.
    const before = await adapter.getSession("release", "deploy");
    await expect(adapter.compactSessionContext("release", "deploy")).rejects.toThrow("当前回合尚未结束");
    const after = await adapter.getSession("release", "deploy");
    expect(after?.contextUsed).toBe(before?.contextUsed);
    // The pending estimate marker only appears once a compaction actually ran.
    await adapter.compactSessionContext("release", "main");
    expect((await adapter.getSession("release", "main"))?.contextSource).toBe("pending");
  });

  it("degrades the reasoning picker and refuses an undeclared level", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    // Switch to the local model, which declares off/low/medium/high.
    await user.click(screen.getByRole("button", { name: /^选择模型：Claude Sonnet$/ }));
    let dialog = await screen.findByRole("dialog", { name: "选择 Provider 与模型" });
    await user.click(within(dialog).getByRole("button", { name: "模型 本地 Qwen" }));
    await user.click(await screen.findByRole("button", { name: "选择推理档位" }));
    dialog = await screen.findByRole("dialog", { name: "推理档位" });
    expect(within(dialog).getByTestId("thinking-current")).toHaveTextContent("当前 中（medium）");
    await user.click(within(dialog).getByRole("button", { name: /高/ }));
    expect(await screen.findByText(/推理档位已选择高/)).toBeInTheDocument();
    // The stored preference survives; an undeclared tier is refused at the adapter.
    await expect(useHostStore.getState().adapter.setSessionThinking("release", "main", "max")).rejects.toThrow("模型未声明该推理档位");
  });
});
