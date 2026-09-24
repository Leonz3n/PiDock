import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "./helpers";
import { useEventsStore } from "../stores/events";
import { useHostStore } from "../stores/host";
import { sessionKeyOf } from "../data/sessionKey";
import type { RunRecord } from "../data/types";

/**
 * [UI 对齐 07] (#31) conversation alignment with prototype A. jsdom has no
 * layout, so every height lives in
 * `docs/evidence/ui-alignment-s6/capture-conversation.mjs`; asserted here are
 * the class contracts and the behaviour — the day label comes from the session's
 * own time, the run-result card only renders what the Host reported, and the
 * child-agent band sits outside the log so it cannot take the log's height.
 */

const TASK_PATH = "/projects/atlas/tasks/release?session=main";

function currentKeys() {
  const workspace = useHostStore.getState().workspace;
  const task = workspace?.tasks.find((item) => item.name === "发布前检查");
  if (!task) throw new Error("seed task missing");
  const taskId = task.id;
  const sessionId = useHostStore.getState().session(taskId, "main")?.id ?? "main";
  return { taskId, sessionId };
}

function record(state: RunRecord["state"], patch: Partial<RunRecord> = {}): RunRecord {
  const { taskId, sessionId } = currentKeys();
  return {
    id: `run-${state}`,
    taskId,
    sessionId,
    state,
    startedAt: "2026-09-22T09:30:00+08:00",
    summary: "正在执行",
    steps: [
      { label: "读取任务上下文", state: "done" },
      { label: "运行工具", state: "pending" },
    ],
    ...patch,
  };
}

describe("conversation alignment", () => {
  it("renders the prototype's message chrome for both speakers", async () => {
    renderApp(TASK_PATH);
    await screen.findByRole("heading", { name: "发布前检查" });

    const log = await screen.findByLabelText("会话消息");
    // Prototype `.messages{padding:26px 28px 10px}` with the 1180/960 tiers.
    expect(log.className).toContain("px-[28px]");
    expect(log.className).toContain("pt-[26px]");
    expect(log.className).toContain("pb-[10px]");
    expect(log.className).toContain("below-wide:p-5");
    expect(log.className).toContain("below-mid:p-4");

    const heads = log.querySelectorAll('[data-testid="message-head"]');
    expect(heads.length).toBeGreaterThan(1);
    // The user row: the local identity mark, 「你」 and the Host's own time.
    const userRow = [...log.querySelectorAll('[data-testid^="message-"]')].find((row) =>
      row.querySelector('[data-testid="message-avatar"]'),
    );
    expect(userRow).toBeDefined();
    expect(within(userRow as HTMLElement).getByText("你")).toBeInTheDocument();
    expect(within(userRow as HTMLElement).getByTestId("message-time").textContent).toMatch(/^\d{2}:\d{2}$/);
    // The agent row: brand mark, 「Pi」, the session mode and the right badge.
    const agentRow = [...log.querySelectorAll('[data-testid^="message-"]')].find((row) =>
      row.querySelector('[data-testid="message-brandmark"]'),
    );
    expect(agentRow).toBeDefined();
    const agent = agentRow as HTMLElement;
    expect(within(agent).getByText("Pi")).toBeInTheDocument();
    expect(within(agent).getByTestId("message-mode")).toHaveTextContent("实现与验证");
    expect(within(agent).getByTestId("message-state-badge")).toHaveTextContent("空闲");

    // Prototype `.message{margin-bottom:25px}` and the 31px indent, dropped ≤960.
    const rows = log.querySelectorAll<HTMLElement>("li[data-testid^='message-']");
    expect(rows[0]?.className).toContain("mb-[25px]");
    const body = (userRow as HTMLElement).querySelector<HTMLElement>('[data-testid="message-body"]');
    expect(body?.className).toContain("ml-[31px]");
    expect(body?.className).toContain("below-mid:ml-0");
    expect(body?.className).toContain("rounded-[2px_10px_10px_10px]");
    expect(body?.className).toContain("bg-[#f5f6f6]");
    expect(body?.className).toContain("px-4");
    expect(body?.className).toContain("py-[13px]");

    // Prototype `.date-label` is `<day> · <session>`, never a fixture string.
    const label = within(log).getByTestId("conversation-date-label");
    expect(label.textContent).toMatch(/^(今天|昨天|\d{4}年\d{1,2}月\d{1,2}日) · .+$/);
    expect(label.className).toContain("text-[10px]");
  });

  it("shows a reference as the prototype's chip, previews a sent image, and keeps the attribution", async () => {
    // jsdom has no `URL.createObjectURL`, and the image branch keys off it.
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:mock" });
    const user = userEvent.setup();
    renderApp(TASK_PATH);
    await screen.findByRole("heading", { name: "发布前检查" });

    await user.upload(screen.getByLabelText("附件选择") as HTMLInputElement, [
      new File(["hello"], "spec.md", { type: "text/markdown" }),
      new File(["png"], "shot.png", { type: "image/png" }),
    ]);
    await user.type(screen.getByLabelText("给 Agent 的消息"), "看下附件");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    // A send leaves the composer disabled until the Host answers; awaiting the
    // idle state both asserts that and keeps the promise chain from settling
    // after the test environment is torn down.
    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).not.toBeDisabled());

    const log = await screen.findByLabelText("会话消息");
    const chip = await within(log).findByText("@ spec.md");
    // Prototype `.refchip`: 10px, `padding:1px 5px`, radius 4px, `#edeff3`/`#dfe3eb`.
    for (const token of ["text-[10px]", "px-[5px]", "py-[1px]", "rounded-[4px]", "bg-[#edeff3]", "border-[#dfe3eb]"]) {
      expect(chip.className).toContain(token);
    }

    // Prototype `attachments.js messageAttachments()`: the thumbnail is a button
    // that opens the same lightbox the composer uses.
    const image = within(log).getByRole("button", { name: "预览 shot.png" });
    const thumbnail = image.querySelector("img");
    expect(thumbnail?.className).toContain("h-[125px]");
    expect(thumbnail?.className).toContain("w-[200px]");
    expect(thumbnail?.className).toContain("object-contain");
    await user.click(image);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("attachment-preview-image")).toBeInTheDocument();

    // Prototype `.message-footer`: `<provider> / <model>` from the display names.
    const agentMessage = [...log.querySelectorAll<HTMLElement>("li[data-testid^='message-']")].find((row) =>
      row.querySelector('[data-testid="message-footer"]'),
    );
    const footer = agentMessage?.querySelector('[data-testid="message-footer"]');
    expect(footer?.textContent).toContain("/");
    expect(footer?.textContent).toContain("Claude Sonnet");

    // The unavailable branch: the model is gone from the configuration, so the
    // footer says so instead of quietly showing a name that no longer applies.
    const workspace = useHostStore.getState().workspace;
    const session = useHostStore.getState().session(currentKeys().taskId, currentKeys().sessionId);
    if (!workspace || !session) throw new Error("workspace missing");
    act(() => {
      useHostStore.setState({
        workspace: {
          ...workspace,
          providers: workspace.providers.map((provider) =>
            provider.id === session.providerId
              ? { ...provider, models: provider.models.filter((model) => model.id !== session.model) }
              : provider,
          ),
        },
      });
    });
    expect(agentMessage?.querySelector('[data-testid="message-footer"]')?.textContent).toContain("已不在该配置中");
  });

  it("describes a real run record and opens the panels its card points at", async () => {
    const user = userEvent.setup();
    renderApp(TASK_PATH);
    await screen.findByRole("heading", { name: "发布前检查" });
    const { taskId, sessionId } = currentKeys();

    // Nothing to describe before the Host reports a run — the card is absent
    // rather than a card full of invented steps.
    expect(screen.queryByTestId("tool-result-card")).not.toBeInTheDocument();

    act(() => {
      useEventsStore.setState({ runs: { [sessionKeyOf(taskId, sessionId)]: record("running") } });
    });
    const card = await screen.findByTestId("tool-result-card");
    // Prototype `app.js:57`: inside the agent body the `.run-result` line and the
    // two `.btn.sm` actions are *siblings* of `.toolcard`, so the card keeps the
    // rows and steps and nothing else.
    const result = await screen.findByTestId("tool-result");
    const summary = screen.getByTestId("tool-result-summary");
    expect(result.contains(card)).toBe(true);
    expect(card.contains(summary)).toBe(false);
    expect(card.contains(screen.getByTestId("tool-result-actions"))).toBe(false);
    expect(within(card).getByTestId("tool-result-row-workspace").textContent).toContain("准备 4 个仓库工作副本");
    expect(within(card).getByTestId("tool-result-row-services").textContent).toMatch(/解析服务依赖与端口\s*\d+ 本地 · \d+ 远程/);

    const steps = within(card).getAllByTestId(/^tool-result-step-/);
    expect(steps).toHaveLength(2);
    // Prototype `.dot.live`: only the step the live turn is on carries the ring.
    expect(steps[0]?.querySelector("span")?.className).not.toContain("bg-accent");
    expect(steps[1]?.querySelector("span")?.className).toContain("bg-accent");
    expect(summary.textContent).toContain("执行中");

    await user.click(screen.getByTestId("tool-result-action-files"));
    expect(await screen.findByTestId("task-rail")).toBeInTheDocument();

    // A finished turn keeps the same pending step, without the live ring.
    act(() => {
      useEventsStore.setState({ runs: { [sessionKeyOf(taskId, sessionId)]: record("completed", { summary: "执行完成" }) } });
    });
    const settled = within(card).getAllByTestId(/^tool-result-step-/);
    expect(settled.every((step) => !(step.querySelector("span")?.className ?? "").includes("bg-accent"))).toBe(true);
    expect(screen.getByTestId("tool-result-summary").textContent).toContain("✓ 执行完成");
  });

  it("shows the empty state until the first message and reports the child-agent band", async () => {
    const user = userEvent.setup();
    renderApp(TASK_PATH);
    await screen.findByRole("heading", { name: "发布前检查" });

    const band = await screen.findByLabelText("当前会话启动的 Subagent");
    // The band is a sibling above the log, not a child of it: the log keeps its
    // own height (measured in the evidence script).
    const log = screen.getByLabelText("会话消息");
    expect(log.contains(band)).toBe(false);
    expect(within(band).getByText("Subagent")).toBeInTheDocument();
    expect(within(band).getByText("1 个运行中")).toBeInTheDocument();
    // Collapsed by default, so the band costs one row; the running count stays.
    expect(within(band).queryByTestId("subagent-cards")).not.toBeInTheDocument();

    await user.click(within(band).getByTestId("session-subagents-toggle"));
    const cards = within(band).getByTestId("subagent-cards");
    // Prototype `.subagent-cards{grid-template-columns:repeat(auto-fit,minmax(190px,1fr))}`:
    // the track count comes from `auto-fit`, so no breakpoint rule of ours may
    // force a column count (the evidence script compares against the prototype).
    expect(cards.className).toContain("grid-cols-[repeat(auto-fit,minmax(190px,1fr))]");
    expect(cards.className).not.toContain("grid-cols-1");
    const card = within(band).getByRole("button", { name: /^查看 查询链路分析，/ });
    expect(card).toHaveAttribute("aria-pressed", "false");
    await user.click(card);
    expect(within(band).getByRole("button", { name: /^查看 查询链路分析，/ })).toHaveAttribute("aria-pressed", "true");

    // The empty state is the new session's state, and it leaves with the first message.
    await user.click(screen.getByTestId("session-new"));
    const empty = await screen.findByTestId("conversation-empty");
    expect(within(empty).getByText("准备好开始了")).toBeInTheDocument();
    expect(within(empty).getByText("描述这个任务的目标，或用 @ 引用当前任务代码。")).toBeInTheDocument();
    expect(empty.querySelector('[data-testid="message-brandmark"]')?.textContent).toBe("π");

    await user.type(screen.getByLabelText("给 Agent 的消息"), "开始吧");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(screen.queryByTestId("conversation-empty")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).not.toBeDisabled());
  });
});
