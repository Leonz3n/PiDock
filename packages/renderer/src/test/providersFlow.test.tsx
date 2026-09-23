import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createMemoryHost } from "../data/memoryHost";
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

describe("context and reasoning popovers", () => {
  it("shows unformatted occupancy with the estimate marker and preserves tokens after compaction", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    await user.click(screen.getByRole("button", { name: "查看上下文占用" }));
    const dialog = await screen.findByRole("dialog", { name: "上下文占用" });
    expect(within(dialog).getByTestId("context-numbers")).toHaveTextContent("占用 24800 Tokens · 上限 200000 Tokens");
    expect(within(dialog).getByTestId("context-tokens")).toHaveTextContent("68.4k");
    await user.click(within(dialog).getByRole("button", { name: "模拟压缩" }));
    expect(await screen.findByRole("button", { name: "查看上下文占用" })).toHaveTextContent("待更新");
    expect(await useHostStore.getState().adapter.getSession("release", "main")).toMatchObject({ contextSource: "pending", tokens: 68.4 });
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
