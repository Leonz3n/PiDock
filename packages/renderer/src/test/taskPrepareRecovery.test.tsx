import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskPrepareRecovery } from "../components/TaskPrepareRecovery";
import type { ShellTaskOpResult } from "../data/shellBridge";

// Seam: #6 partial-prepare recovery UI. The panel shows the Host's real
// per-repo status and triggers an explicit resume; it never runs on mount and
// keeps the form + shows the real reason on a failure.

afterEach(cleanup);

const prepared = {
  outcomes: [
    { repoDir: "frontend", status: "created" },
    { repoDir: "invoice", status: "pending" },
    {
      repoDir: "shipment",
      status: "failed",
      error: { code: "fetch-failed", repoDir: "shipment", message: "仓库 shipment 获取远程基线失败" },
    },
  ],
  retry: ["invoice", "shipment"],
  hold: [],
  canResume: true,
};

const ok = (payload: unknown): ShellTaskOpResult => ({ ok: true, payload });

it("does not read or resume on mount; an explicit check renders the real statuses and reasons", async () => {
  const load = vi.fn(async () => ok(prepared));
  const resume = vi.fn(async () => ok(prepared));
  render(<TaskPrepareRecovery load={load} resume={resume} />);
  expect(load).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
  expect(screen.queryByTestId("prepare-status-rows")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "检查准备状态" }));
  expect(await screen.findByTestId("prepare-status-rows")).toHaveTextContent("frontend · 已创建");
  expect(screen.getByTestId("prepare-status-rows")).toHaveTextContent("invoice · 待准备");
  expect(screen.getByTestId("prepare-status-rows")).toHaveTextContent(
    "shipment · 失败 · 仓库 shipment 获取远程基线失败",
  );
  // A created worktree never gets a resume affordance of its own; the single
  // resume button is for the unfinished set.
  expect(screen.getByRole("button", { name: "继续准备未完成的仓库" })).toBeInTheDocument();
});

it("resumes only the unfinished repos and never re-creates the created one", async () => {
  const load = vi.fn(async () => ok(prepared));
  // The Host answers a resume with the plan + the classification taken when
  // it was called: the retried repos are still unfinished (the caller runs
  // the plan afterwards), so the response keeps the resume affordance.
  const resume = vi.fn(async (_input: { repoDirs: string[] }) => ok(prepared));
  render(<TaskPrepareRecovery load={load} resume={resume} />);
  fireEvent.click(screen.getByRole("button", { name: "检查准备状态" }));
  await screen.findByTestId("prepare-status-rows");

  fireEvent.click(screen.getByRole("button", { name: "继续准备未完成的仓库" }));
  expect(resume).toHaveBeenCalledTimes(1);
  // `frontend` is created: it must not enter the retry set.
  expect(resume.mock.calls[0]![0]).toEqual({ repoDirs: ["invoice", "shipment"] });
  await waitFor(() => expect(screen.getByTestId("prepare-status-rows")).toHaveTextContent("invoice · 待准备"));
  expect(screen.getByRole("button", { name: "继续准备未完成的仓库" })).toBeInTheDocument();

  // A later read after the caller executed the plan: nothing is unfinished,
  // so the affordance disappears.
  load.mockResolvedValueOnce(
    ok({
      outcomes: [
        { repoDir: "frontend", status: "created" },
        { repoDir: "invoice", status: "created" },
        { repoDir: "shipment", status: "created" },
      ],
      retry: [],
      hold: [],
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "检查准备状态" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "继续准备未完成的仓库" })).toBeNull(),
  );
  expect(screen.getByTestId("prepare-status-rows")).toHaveTextContent("frontend · 已创建");
});

it("keeps the form and shows the Host's real reason when a resume is refused", async () => {
  const load = vi.fn(async () => ok(prepared));
  const resume = vi.fn(async () => ({
    ok: false,
    error: "invalid-payload: task/resumeAppend requires caller-scanned takenPaths + branchesInUse",
  }));
  render(<TaskPrepareRecovery load={load} resume={resume} />);
  fireEvent.click(screen.getByRole("button", { name: "检查准备状态" }));
  await screen.findByTestId("prepare-status-rows");

  fireEvent.click(screen.getByRole("button", { name: "继续准备未完成的仓库" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "task/resumeAppend requires caller-scanned takenPaths + branchesInUse",
  );
  // The rows (the form state) are kept.
  expect(screen.getByTestId("prepare-status-rows")).toHaveTextContent("invoice · 待准备");
  expect(screen.getByRole("button", { name: "继续准备未完成的仓库" })).toBeInTheDocument();
});

it("keeps the last known rows and shows the reason when the status read fails", async () => {
  const load = vi.fn(async (): Promise<ShellTaskOpResult> => ({ ok: false, error: "unknown task: no task record" }));
  render(<TaskPrepareRecovery load={load} resume={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "检查准备状态" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("unknown task: no task record");
  expect(screen.queryByTestId("prepare-status-rows")).toBeNull();
});

it("names a held repo as needing human handling instead of claiming it is not ours", async () => {
  // A diverged-but-intact task worktree: the Host holds it and reports the
  // real divergence. The panel must not replace that with "不是本任务的工作副本".
  const diverged = {
    outcomes: [
      { repoDir: "frontend", status: "created" },
      {
        repoDir: "invoice",
        status: "failed",
        error: {
          code: "repo-unusable",
          repoDir: "invoice",
          message: "工作副本 HEAD 不在任务分支 task-abcdef12（实际 main）",
        },
      },
    ],
    retry: [],
    hold: ["invoice"],
    canResume: false,
  };
  const load = vi.fn(async () => ok(diverged));
  render(<TaskPrepareRecovery load={load} resume={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "检查准备状态" }));
  await screen.findByTestId("prepare-status-rows");
  const notice = screen.getByRole("status");
  expect(notice).toHaveTextContent("invoice");
  expect(notice).toHaveTextContent("需要人工处理");
  expect(notice).not.toHaveTextContent("不是本任务的工作副本");
  // The Host's real reason rides the row, so the specific divergence shows.
  expect(screen.getByTestId("prepare-status-rows")).toHaveTextContent(
    "工作副本 HEAD 不在任务分支 task-abcdef12（实际 main）",
  );
  // Nothing is resumable, so there is no resume affordance.
  expect(screen.queryByRole("button", { name: "继续准备未完成的仓库" })).toBeNull();
});

it("rejects a malformed status payload instead of showing a fabricated ready view", async () => {
  const load = vi.fn(async () => ok({ outcomes: [{ repoDir: "x", status: "ready" }], retry: [], hold: [] }));
  render(<TaskPrepareRecovery load={load} resume={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "检查准备状态" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("准备状态返回异常");
  expect(screen.queryByTestId("prepare-status-rows")).toBeNull();
});
