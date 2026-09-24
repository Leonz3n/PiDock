import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { RunState } from "../data/types";
import { sessionKeyOf } from "../data/sessionKey";
import { useEventsStore } from "../stores/events";
import { useHostStore } from "../stores/host";
import { useUiStore } from "../stores/ui";
import { actStore, renderApp } from "./helpers";

/**
 * [UI 对齐 05] (#29) 会话执行状态卡。
 *
 * 原型 `executionPanel()`（`prototypes/pidock-ui/closure.js`）按状态给一套入口：
 * 执行中→停止执行，等待确认→批准本次操作/拒绝，失败→检查并重试，确认已过期→
 * 标记已处理，其余状态没有入口。状态卡读 Host 数据（会话 runState + 实时运行记录 +
 * 待确认请求），渲染层不估算进度。
 */
async function openTask(session: string) {
  const user = userEvent.setup();
  renderApp(`/projects/atlas/tasks/release?session=${session}`);
  await screen.findByRole("heading", { name: "发布前检查" });
  return user;
}

/** Seed a live run record; `stores/events.ts` seeds the same shape from Host events. */
function seedRun(taskId: string, sessionId: string, state: RunState, extra: Partial<Record<"summary" | "failedScope", string>> = {}) {
  act(() => {
    useEventsStore.setState({
      runs: {
        ...useEventsStore.getState().runs,
        [sessionKeyOf(taskId, sessionId)]: {
          id: `run-${state}`,
          taskId,
          sessionId,
          state,
          startedAt: "2026-09-22T08:00:00.000Z",
          summary: "",
          steps: [],
          ...extra,
        },
      },
    });
  });
}

function sessionState(sessionId: string) {
  return useHostStore
    .getState()
    .workspace?.tasks.find((task) => task.id === "release")
    ?.sessions.find((session) => session.id === sessionId)?.runState;
}

function approvalState(approvalId: string) {
  const approval = useHostStore.getState().approvals.find((item) => item.id === approvalId);
  return { status: approval?.status, executed: approval?.executed };
}

afterEach(cleanup);

describe("execution card", () => {
  it("renders the eight states with only the entries each one allows", async () => {
    const matrix: Array<[Exclude<RunState, "idle">, string, string[]]> = [
      ["running", "执行中", ["停止执行"]],
      ["approval", "等待确认", ["批准本次操作", "拒绝"]],
      ["failed", "失败", ["检查并重试"]],
      ["completed", "已完成", []],
      ["stopped", "已停止", []],
      ["rejected", "已拒绝", []],
      ["expired", "确认已过期", ["标记已处理"]],
    ];
    for (const [state, label, entries] of matrix) {
      renderApp("/projects/atlas/tasks/latency?session=main");
      await screen.findByRole("heading", { name: "排查延迟峰值" });
      // The task has no pending approval, so the live record decides the state.
      seedRun("latency", "main", state);
      // The card is `section[aria-label="会话执行状态"]`, so it is reachable by
      // role; the events store update above is what the Host emits.
      const card = await screen.findByRole("region", { name: "会话执行状态" });
      expect(within(card).getByTestId("execution-card-state")).toHaveTextContent(label);
      for (const action of ["停止执行", "批准本次操作", "拒绝", "检查并重试", "标记已处理"]) {
        const found = within(card).queryByRole("button", { name: action }) !== null;
        expect(`${label}:${action}:${found ? "present" : "absent"}`).toBe(`${label}:${action}:${entries.includes(action) ? "present" : "absent"}`);
      }
      cleanup();
    }
  });

  it("renders the payload review only inside the execution card", async () => {
    await openTask("deploy");
    // 原型 `executionPanel()` 只有一个审批面；输入框上方不再有第二份审阅面板，
    // 否则等待确认页的消息区会被两份面板压到 26px（[UI 对齐 05] #29 review P1-1）。
    const previews = await screen.findAllByTestId("execution-approval-preview");
    expect(previews).toHaveLength(1);
    const card = screen.getByRole("region", { name: "会话执行状态" });
    expect(card).toContainElement(previews[0]!);
    const composer = screen.getByTestId("task-composer");
    expect(composer).not.toHaveTextContent("载荷版本");
    expect(composer).not.toHaveTextContent("待批准：");
  });

  it("keeps the waiting card's payload review and one-shot approval semantics", async () => {
    const user = await openTask("deploy");
    const card = await screen.findByRole("region", { name: "会话执行状态" });
    expect(within(card).getByTestId("execution-card-state")).toHaveTextContent("等待确认");

    // The preview carries the prototype's 目标/影响/有效期 plus the reason an
    // approval is one-shot; all of it comes from the pending Host approval.
    const preview = await within(card).findByTestId("execution-approval-preview");
    expect(preview).toHaveTextContent("待批准：部署到 Staging");
    expect(preview).toHaveTextContent("目标：bun run deploy:staging · /workspace/atlas-web");
    expect(preview).toHaveTextContent("影响：更新 staging.atlas.example.com，预计 2 分钟");
    expect(preview).toHaveTextContent(/有效期：\d{4}\/\d{1,2}\/\d{1,2}/);
    expect(preview).toHaveTextContent("批准仅授权这一次操作，不自动授权未来执行。");
    // This session has a second pending request; it is named, not hidden.
    expect(preview).toHaveTextContent("另有 1 个待确认请求");

    await user.click(within(card).getByRole("button", { name: "批准本次操作" }));
    // One-shot: the approved request stops being pending, so the same entry can
    // never fire twice — the card moves on to the remaining request.
    await waitFor(() => expect(approvalState("approval-deploy")).toEqual({ status: "approved", executed: true }));
    await waitFor(() => expect(screen.getByTestId("execution-approval-preview")).toHaveTextContent("待批准：执行数据库迁移"));
    expect(await screen.findByText(/已批准本次操作；仅授权这一次/)).toBeInTheDocument();
  });

  it("leaves no approve entry once the Host stops listing the request as pending", async () => {
    // 一次性语义的权威在 Host：`packages/shell/src/host/service-control.ts` 的
    // `consumeApproval` 经 `packages/shell/src/main/execution-ledger.ts` 的
    // `consumeExecutionApproval` 落 `consumedAt`，第二次尝试得到 `already-consumed`
    // （`execution-ledger.test.ts:131-133` 与 `:166-169`）。渲染层只负责在请求不再是
    // pending 后不再给出入口，所以这里断言的是“该请求不再 pending”与“入口随之消失”。
    const user = await openTask("deploy");
    const card = await screen.findByRole("region", { name: "会话执行状态" });
    expect(within(card).getByRole("button", { name: "批准本次操作" })).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "批准本次操作" }));
    await waitFor(() => expect(approvalState("approval-deploy")).toEqual({ status: "approved", executed: true }));
    expect(screen.queryByTestId("execution-approval-preview")).not.toHaveTextContent("待批准：部署到 Staging");
    expect(
      useHostStore
        .getState()
        .approvals.filter((item) => item.sessionId === "deploy" && item.status === "pending")
        .map((item) => item.id),
    ).toEqual(["approval-migrate"]);
  });

  it("keeps the outcome line on the request the state came from", async () => {
    // 拒绝第一条请求、批准第二条后的「执行中」：结果行必须说那条正在执行的请求。
    // 原来取「第一条非待确认」，于是「执行中」旁边写着另一条早已被拒绝的请求（P2-A）。
    const user = await openTask("deploy");
    const card = await screen.findByRole("region", { name: "会话执行状态" });
    await user.click(within(card).getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(approvalState("approval-deploy")).toEqual({ status: "rejected", executed: false }));
    await user.click(await within(screen.getByRole("region", { name: "会话执行状态" })).findByRole("button", { name: "批准本次操作" }));
    await waitFor(() => expect(sessionState("deploy")).toBe("running"));

    const outcome = await screen.findByTestId("execution-approval-outcome");
    expect(outcome).toHaveTextContent("执行数据库迁移 · 正在执行 bun run db:migrate");
    expect(outcome).not.toHaveTextContent("部署到 Staging");
  });

  it("stops a running session through the existing Host entry", async () => {
    const user = await openTask("deploy");
    // Clear the second pending request first so the card can follow the approved
    // turn into 执行中.
    await actStore(() => useHostStore.getState().resolveApproval("approval-migrate", "rejected"));
    await user.click(await screen.findByRole("button", { name: "批准本次操作" }));
    await waitFor(() => expect(screen.getByTestId("execution-card-state")).toHaveTextContent("执行中"));

    await user.click(screen.getByRole("button", { name: "停止执行" }));
    await waitFor(() => expect(sessionState("deploy")).toBe("stopped"));
    expect(await screen.findByText("已停止执行；历史、已完成步骤和输入草稿保留")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("execution-card-state")).toHaveTextContent("已停止"));
    expect(screen.queryByRole("button", { name: "停止执行" })).toBeNull();
    // 已停止不由任何一条确认结果解释，所以结果行也不借用上一条请求的结论。
    expect(screen.queryByTestId("execution-approval-outcome")).toBeNull();
  });

  it("routes the failed entry into the existing retry dialog", async () => {
    const user = await openTask("failed");
    const input = await screen.findByLabelText("消息输入");
    await user.type(input, "修复构建并重试");
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    // The failure is the end of a scripted turn, so wait for the failure entry.
    const retry = await screen.findByRole("button", { name: "检查并重试" }, { timeout: 4000 });
    const card = screen.getByRole("region", { name: "会话执行状态" });
    expect(screen.getByTestId("execution-card-state")).toHaveTextContent("失败");
    // The failure scope and the step list come from the Host record; the step
    // list stays collapsed so a long run cannot grow the card.
    expect(within(card).getByText(/失败范围：构建步骤：front-monorepo web 包编译失败/)).toBeInTheDocument();
    const steps = within(card).getByTestId("execution-steps");
    expect(steps).toHaveTextContent("完成 2 / 共 4");
    expect(within(steps).getByText("运行冒烟检查")).toBeInTheDocument();

    await user.click(retry);
    expect(await screen.findByRole("dialog", { name: "检查重试范围" })).toBeInTheDocument();
  });

  it("dismisses an expired record without deleting it", async () => {
    const user = await openTask("deploy");
    // 执行状态卡是唯一审批面，所以「标记过期」就在它所审阅的那条请求上：种子会话有两条
    // 待确认请求，第二条会让状态停在「等待确认」，先把第二条拒绝掉才能观察到过期态。
    await actStore(() => useHostStore.getState().resolveApproval("approval-migrate", "rejected"));
    // 标记过期 moves the pending confirmation past its validity window: the
    // session lands on 确认已过期 and the card offers exactly one entry.
    const card0 = await screen.findByRole("region", { name: "会话执行状态" });
    await user.click(await within(card0).findByRole("button", { name: "标记过期" }));
    await waitFor(() => expect(sessionState("deploy")).toBe("expired"));
    const card = await screen.findByRole("region", { name: "会话执行状态" });
    expect(within(card).getByTestId("execution-card-state")).toHaveTextContent("确认已过期");
    // 该状态由这条过期记录解释，所以结果行说它——而不是会话里另一条请求（P2-A）。
    expect(within(card).getByTestId("execution-approval-outcome")).toHaveTextContent(
      "部署到 Staging · 确认已过期，未执行。",
    );

    await user.click(within(card).getByRole("button", { name: "标记已处理" }));
    // 只是本会话隐藏卡片：Host 侧没有 ack 入口，`需要处理` 仍会重新列出过期记录。
    expect(await screen.findByText("已在本会话隐藏该状态卡；执行记录保留")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("region", { name: "会话执行状态" })).toBeNull());
    // 执行记录保留: dismissing the card never touches the Host record.
    expect(approvalState("approval-deploy")).toEqual({ status: "expired", executed: false });
    expect(sessionState("deploy")).toBe("expired");
  });

  it("shows no card without a run record and points at another busy session", async () => {
    await openTask("main");
    // The seeded deploy session holds a pending confirmation, so the idle
    // session's card carries the cross-session hint (原型 other>=0 分支).
    const card = await screen.findByRole("region", { name: "会话执行状态" });
    expect(within(card).getByTestId("execution-card-state")).toHaveTextContent("空闲");
    expect(card).toHaveTextContent("「部署审查」正在执行或等待确认；本会话可编辑草稿，待其结束后再执行。");
    expect(within(card).queryAllByRole("button")).toHaveLength(0);

    // Resolve the other session's confirmations and stop it: the idle card — and
    // with it the hint — disappears, because there is no run record at all.
    await actStore(() => useHostStore.getState().resolveApproval("approval-deploy", "rejected"));
    await actStore(() => useHostStore.getState().resolveApproval("approval-migrate", "rejected"));
    await actStore(() => useHostStore.getState().stopRun("release", "deploy"));
    await waitFor(() => expect(screen.queryByRole("region", { name: "会话执行状态" })).toBeNull());
  });

  it("disables the entries and explains why in a read-only session", async () => {
    renderApp("/projects/atlas/tasks/release?session=archived-1");
    await screen.findByRole("heading", { name: "发布前检查" });
    // The read-only session has no run of its own: give it live records so the
    // card renders, then check the permission rule on every entry it can show.
    seedRun("release", "archived-1", "failed", { summary: "只读会话的历史执行记录" });
    let card = await screen.findByRole("region", { name: "会话执行状态" });
    const retry = within(card).getByRole("button", { name: "检查并重试" });
    expect(retry).toBeDisabled();
    expect(retry).toHaveAttribute("title", "当前是只读会话，请先调整会话权限");
    // A disabled button never shows its `title`, so the rule is also stated in
    // the card itself.
    expect(within(card).getByTestId("execution-readonly-hint")).toHaveTextContent(
      "当前是只读会话，请先调整会话权限；只读会话可以阅读和分析，不能执行这些操作。",
    );

    seedRun("release", "archived-1", "running");
    card = await screen.findByRole("region", { name: "会话执行状态" });
    expect(within(card).getByRole("button", { name: "停止执行" })).toBeDisabled();
    seedRun("release", "archived-1", "expired");
    card = await screen.findByRole("region", { name: "会话执行状态" });
    expect(within(card).getByRole("button", { name: "标记已处理" })).toBeDisabled();
    // A state without entries carries no hint: the line explains why the
    // entries are missing, and there are none to explain.
    seedRun("release", "archived-1", "completed");
    card = await screen.findByRole("region", { name: "会话执行状态" });
    expect(within(card).queryByTestId("execution-readonly-hint")).toBeNull();
    // The dismissal never happens while the entry is disabled.
    expect(useUiStore.getState().dismissedExecutions["release:archived-1"]).toBeUndefined();
  });
});
