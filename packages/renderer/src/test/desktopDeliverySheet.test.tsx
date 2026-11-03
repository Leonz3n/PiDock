import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesktopDeliverySheet } from "../components/DesktopDeliverySheet";
import { summarizeOutcomes, emptyStateText, outcomeLabel, prLine, type RepoOutcomeView } from "../data/gitDelivery";
import type { PidockBridge, ShellTaskOpResult } from "../data/shellBridge";

// Seam: [Pencil T13] #148. The sheet drives the real Host ops
// (deliverySettings / deliveryPlan / deliveryCommit / deliveryPush) and renders
// their per-repository answers. Nothing here fabricates a success, a branch or
// a PR: a fake bridge answers exactly like the Host's envelope.

const taskId = "task-148";

const plan = {
  branchTemplate: "ticket/{taskId}-{slug}",
  remote: "origin",
  slug: "git",
  ready: true,
  problem: null,
  rows: [
    {
      repoId: "repo-11111111",
      name: "frontend",
      repoPath: "/tasks/148/frontend",
      branch: "ticket/148-git",
      remote: "origin",
      pushTarget: "origin ticket/148-git",
      remoteUrl: "git@github.com:acme/frontend.git",
      problem: null,
    },
    {
      repoId: "repo-22222222",
      name: "api",
      repoPath: "/tasks/148/api",
      branch: "ticket/148-git",
      remote: "origin",
      pushTarget: "origin ticket/148-git",
      remoteUrl: "https://gitlab.com/acme/api.git",
      problem: null,
    },
  ],
};

function outcome(overrides: Partial<RepoOutcomeView> = {}): RepoOutcomeView {
  return {
    repoId: "repo-11111111",
    repoPath: "/tasks/148/frontend",
    branch: "ticket/148-git",
    remote: "origin",
    status: "success",
    summary: "已提交 2 个文件",
    files: ["src/a.ts", "src/b.ts"],
    commit: "abc123",
    pushedTo: null,
    ...overrides,
  };
}

type TaskOp = (taskId: string, op: string, payload?: Record<string, unknown>) => Promise<ShellTaskOpResult>;

function bridge(taskOp: TaskOp): PidockBridge {
  window.pidock = { taskOp: vi.fn(taskOp) };
  return window.pidock;
}

function hostAnswer(payload: Record<string, unknown>): ShellTaskOpResult {
  return { ok: true, payload };
}

afterEach(() => {
  cleanup();
  delete window.pidock;
});

describe("delivery sheet", () => {
  it("previews the local branch and push target per repository before anything runs", async () => {
    const taskOp = vi.fn(async (_taskId: string, op: string) => {
      if (op === "task/deliverySettings") {
        return hostAnswer({ settings: { branchTemplate: "ticket/{taskId}-{slug}", remote: "origin", savedAt: "2026-11-04T00:00:00.000Z" } });
      }
      if (op === "task/deliveryPlan") return hostAnswer({ plan });
      return { ok: false, error: "unexpected" };
    });
    bridge(taskOp);
    render(<DesktopDeliverySheet taskId={taskId} />);
    await waitFor(() => expect(screen.getByTestId("delivery-row-repo-11111111-branch")).toBeTruthy());
    expect(screen.getByTestId("delivery-row-repo-11111111-branch").textContent).toContain("ticket/148-git");
    expect(screen.getByTestId("delivery-row-repo-11111111-target").textContent).toContain("origin ticket/148-git");
    expect(screen.getByTestId("delivery-row-repo-22222222-remote").textContent).toContain("https://gitlab.com/acme/api.git");
    // The preview is a READ: no commit/push op may have been sent.
    expect(taskOp.mock.calls.map((call) => call[1])).toEqual(["task/deliverySettings", "task/deliveryPlan"]);
  });

  it("commits only on an explicit click and lists the real per-repo result", async () => {
    const taskOp = vi.fn(async (_taskId: string, op: string) => {
      if (op === "task/deliverySettings") return hostAnswer({ settings: { branchTemplate: "ticket/{taskId}-{slug}", remote: "origin", savedAt: null } });
      if (op === "task/deliveryPlan") return hostAnswer({ plan });
      if (op === "task/deliveryCommit") {
        return hostAnswer({
          outcomes: [
            outcome(),
            outcome({ repoId: "repo-22222222", summary: "hook declined", status: "failed", files: [] }),
          ],
          partial: true,
          overall: "partial-failure",
        });
      }
      return { ok: false, error: "unexpected" };
    });
    bridge(taskOp);
    render(<DesktopDeliverySheet taskId={taskId} />);
    await waitFor(() => expect(screen.getByTestId("delivery-commit")).toBeTruthy());
    // No commit before the explicit action.
    expect(taskOp.mock.calls.some((call) => call[1] === "task/deliveryCommit")).toBe(false);
    fireEvent.change(screen.getByTestId("delivery-commit-message"), { target: { value: "feat: 交付 (ref #148)" } });
    fireEvent.click(screen.getByTestId("delivery-commit"));
    await waitFor(() => expect(screen.getByTestId("delivery-overall")).toBeTruthy());
    const commitCall = taskOp.mock.calls.find((call) => call[1] === "task/deliveryCommit");
    expect(commitCall?.[2]).toMatchObject({ branch: "ticket/148-git", commitMessage: "feat: 交付 (ref #148)", repoIds: ["repo-11111111", "repo-22222222"] });
    expect(screen.getByTestId("delivery-overall").textContent).toContain("部分失败");
    expect(screen.getByTestId("delivery-outcome-repo-11111111-status").textContent).toContain("成功");
    expect(screen.getByTestId("delivery-outcome-repo-22222222-status").textContent).toContain("失败");
    expect(screen.getByTestId("delivery-outcome-repo-11111111-summary").textContent).toContain("已提交 2 个文件");
  });

  it("shows push outcomes with a copyable PR instruction and never claims a PR exists", async () => {
    const taskOp = vi.fn(async (_taskId: string, op: string) => {
      if (op === "task/deliverySettings") return hostAnswer({ settings: { branchTemplate: "ticket/{taskId}-{slug}", remote: "origin", savedAt: null } });
      if (op === "task/deliveryPlan") return hostAnswer({ plan });
      if (op === "task/deliveryPush") {
        return hostAnswer({
          outcomes: [
            outcome({ summary: "已推送到 origin/ticket/148-git", pushedTo: "origin/ticket/148-git" }),
            outcome({ repoId: "repo-22222222", summary: "不再有可推送的提交", status: "no-changes", pushedTo: "origin/ticket/148-git" }),
          ],
          partial: false,
          overall: "partial-failure",
          pr: [
            { repoId: "repo-11111111", supported: true, host: "github.com", url: "https://github.com/acme/frontend/compare/main...ticket%2F148-git?expand=1", text: "打开创建 PR" },
            { repoId: "repo-22222222", supported: true, host: "gitlab.com", url: "https://gitlab.com/acme/api/-/compare/main...ticket%2F148-git", text: "打开创建 PR" },
          ],
        });
      }
      return { ok: false, error: "unexpected" };
    });
    bridge(taskOp);
    render(<DesktopDeliverySheet taskId={taskId} />);
    await waitFor(() => expect(screen.getByTestId("delivery-push")).toBeTruthy());
    fireEvent.click(screen.getByTestId("delivery-push"));
    await waitFor(() => expect(screen.getByTestId("delivery-outcome-repo-11111111-pr")).toBeTruthy());
    const prCell = screen.getByTestId("delivery-outcome-repo-11111111-pr");
    expect(prCell.textContent).toContain("打开创建 PR");
    expect(prCell.querySelector("a")?.getAttribute("href")).toContain("github.com/acme/frontend/compare/");
    expect(document.body.textContent).not.toContain("PR 已创建");
    expect(screen.getByTestId("delivery-outcome-repo-22222222-status").textContent).toContain("无变更");
    expect(screen.getByTestId("delivery-patch-boundary").textContent).toContain("不代表已提交");
  });

  it("names an unset convention per repository and offers no submit action", async () => {
    const taskOp = vi.fn(async (_taskId: string, op: string) => {
      if (op === "task/deliverySettings") return hostAnswer({ settings: { branchTemplate: "", remote: "origin", savedAt: null } });
      if (op === "task/deliveryPlan") {
        return hostAnswer({
          plan: {
            ...plan,
            ready: false,
            problem: { code: "branch-template-unset", message: "工作空间未保存分支规范：请在设置里填写分支模板" },
            rows: plan.rows.map((row) => ({ ...row, branch: "", pushTarget: "", problem: { code: "branch-template-unset", message: "工作空间未保存分支规范" } })),
          },
        });
      }
      return { ok: false, error: "unexpected" };
    });
    bridge(taskOp);
    render(<DesktopDeliverySheet taskId={taskId} />);
    await waitFor(() => expect(screen.getByTestId("delivery-row-repo-11111111-problem")).toBeTruthy());
    expect(screen.getByTestId("delivery-row-repo-11111111-problem").textContent).toContain("branch-template-unset");
    expect(screen.queryByTestId("delivery-commit")).toBeNull();
    expect(screen.queryByTestId("delivery-push")).toBeNull();
  });

  it("keeps a named save refusal visible instead of pretending the settings saved", async () => {
    const taskOp = vi.fn(async (_taskId: string, op: string) => {
      if (op === "task/deliverySettings") return hostAnswer({ settings: { branchTemplate: "", remote: "", savedAt: null } });
      if (op === "task/deliveryPlan") return hostAnswer({ plan: { ...plan, ready: false, rows: [] } });
      if (op === "task/saveDeliverySettings") return { ok: false, error: "branch-template-invalid: 分支规范必须包含 {taskId}" };
      return { ok: false, error: "unexpected" };
    });
    bridge(taskOp);
    render(<DesktopDeliverySheet taskId={taskId} />);
    await waitFor(() => expect(screen.getByTestId("delivery-save-settings")).toBeTruthy());
    fireEvent.change(screen.getByTestId("delivery-branch-template"), { target: { value: "ticket/fixed" } });
    fireEvent.click(screen.getByTestId("delivery-save-settings"));
    await waitFor(() => expect(screen.getByTestId("delivery-error")).toBeTruthy());
    expect(screen.getByTestId("delivery-error").textContent).toContain("branch-template-invalid");
    expect(screen.getByTestId("delivery-saved-at").textContent).toContain("尚未保存");
  });
});

describe("delivery view model", () => {
  it("names every real outcome and keeps the aggregate honest", () => {
    expect(outcomeLabel("auth-failure")).toBe("认证失败");
    expect(outcomeLabel("remote-reject")).toBe("远端拒绝");
    expect(outcomeLabel("no-changes")).toBe("无变更");
    expect(summarizeOutcomes([outcome(), outcome({ repoId: "r2", status: "no-changes" })]).overall).toBe("全部仓库成功（1）");
    const mixed = summarizeOutcomes([outcome(), outcome({ repoId: "r2", status: "auth-failure" })]);
    expect(mixed.overall).toContain("部分失败");
    expect(mixed.partial).toBe(true);
    expect(summarizeOutcomes([outcome({ status: "remote-reject" })]).overall).toContain("全部失败");
  });

  it("never turns PR guidance into a created claim", () => {
    expect(prLine({ repoId: "r", supported: true, host: "github.com", url: "https://x", text: "打开创建 PR" })).toBe("打开创建 PR：https://x");
    expect(prLine({ repoId: "r", supported: false, host: "git.example", url: null, text: "请在 git.example 手动打开创建 PR。" })).toContain("手动");
    expect(prLine(undefined)).toBeNull();
  });

  it("has an honest empty state with no repositories", () => {
    expect(emptyStateText({ branchTemplate: "t/{taskId}", remote: "origin", slug: "x", ready: false, rows: [], problem: null })).toContain("没有可交付的 Git worktree 仓库");
  });
});
