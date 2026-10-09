import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskPrepareRecovery } from "../components/TaskPrepareRecovery";
import { shellTaskPrepareResume, type ShellTaskOpResult } from "../data/shellBridge";

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

it("hands only the unfinished repos to the injected resume and surfaces the real resumed payload", async () => {
  const load = vi.fn(async () => ok(prepared));
  // The REAL Host resume payload carries the call-time classification, the
  // retried set and `resumed: true`; it never returns `canResume` (the view
  // derives it from `retry`).
  const resumeResponse = {
    outcomes: prepared.outcomes,
    retry: ["invoice", "shipment"],
    hold: [],
    created: ["frontend"],
    pending: ["invoice", "shipment"],
    failed: [],
    resumed: true,
  };
  const resume = vi.fn(async (_input: { repoDirs: string[] }) => ok(resumeResponse));
  render(<TaskPrepareRecovery load={load} resume={resume} />);
  fireEvent.click(screen.getByRole("button", { name: "检查准备状态" }));
  await screen.findByTestId("prepare-status-rows");

  fireEvent.click(screen.getByRole("button", { name: "继续准备未完成的仓库" }));
  expect(resume).toHaveBeenCalledTimes(1);
  // `frontend` is created: it must not enter the retry set.
  expect(resume.mock.calls[0]![0]).toEqual({ repoDirs: ["invoice", "shipment"] });
  // The planned-but-not-yet-executed state is visible (a real resume is not
  // silently indistinguishable from "nothing happened").
  expect(await screen.findByTestId("prepare-resume-planned")).toHaveTextContent("已规划");
  expect(screen.getByTestId("prepare-resume-planned")).toHaveTextContent("invoice、shipment");
  expect(screen.getByTestId("prepare-status-rows")).toHaveTextContent("invoice · 待准备");
  expect(screen.getByRole("button", { name: "继续准备未完成的仓库" })).toBeInTheDocument();

  // A later status read after the caller executed the plan: nothing is
  // unfinished, so the affordance and the planned notice disappear.
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
  expect(screen.queryByTestId("prepare-resume-planned")).toBeNull();
  expect(screen.getByTestId("prepare-status-rows")).toHaveTextContent("frontend · 已创建");
});

it("renders the resume control disabled with the real reason when the caller cannot supply the scan", async () => {
  const load = vi.fn(async () => ok(prepared));
  // No scan-capable resume is injected (the sandboxed renderer cannot scan),
  // so the control must be disabled and name the reason — never a call the
  // Host is guaranteed to refuse.
  render(<TaskPrepareRecovery load={load} resumeUnavailableReason="需要主进程扫描后才能继续准备" />);
  fireEvent.click(screen.getByRole("button", { name: "检查准备状态" }));
  await screen.findByTestId("prepare-status-rows");
  expect(screen.getByRole("button", { name: "继续准备未完成的仓库" })).toBeDisabled();
  expect(screen.getByTestId("prepare-resume-unavailable")).toHaveTextContent("需要主进程扫描后才能继续准备");
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

it("drops a superseded status response so the latest request wins", async () => {
  // Stale-response epoch guard (same convention as the sibling async panels):
  // a response only applies when its request is still the latest.
  let resolveResume: ((value: ShellTaskOpResult) => void) | undefined;
  const pendingResume = new Promise<ShellTaskOpResult>((resolve) => {
    resolveResume = resolve;
  });
  let resolveSecondInspect: ((value: ShellTaskOpResult) => void) | undefined;
  const pendingSecondInspect = new Promise<ShellTaskOpResult>((resolve) => {
    resolveSecondInspect = resolve;
  });
  const latest = {
    outcomes: [{ repoDir: "latest", status: "created" }],
    retry: [],
    hold: [],
  };
  const staleResume = {
    outcomes: [{ repoDir: "stale", status: "pending" }],
    retry: ["stale"],
    hold: [],
    resumed: true,
  };
  const load = vi.fn().mockResolvedValueOnce(ok(prepared)).mockReturnValueOnce(pendingSecondInspect);
  const resume = vi.fn(() => pendingResume);
  render(<TaskPrepareRecovery load={load} resume={resume} />);
  fireEvent.click(screen.getByRole("button", { name: "检查准备状态" }));
  await screen.findByTestId("prepare-status-rows");

  // Start a resume, then a newer inspect in the SAME React batch so both
  // requests are in flight and the second one supersedes the first.
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "继续准备未完成的仓库" }));
    fireEvent.click(screen.getByRole("button", { name: "检查准备状态" }));
  });
  expect(resume).toHaveBeenCalledTimes(1);

  resolveSecondInspect?.(ok(latest));
  await waitFor(() => expect(screen.getByTestId("prepare-status-rows")).toHaveTextContent("latest · 已创建"));
  // The superseded resume response arriving last must NOT overwrite the
  // newer state.
  resolveResume?.(ok(staleResume));
  await waitFor(() => expect(screen.getByTestId("prepare-status-rows")).toHaveTextContent("latest · 已创建"));
  expect(screen.getByTestId("prepare-status-rows")).not.toHaveTextContent("stale");
  expect(screen.queryByTestId("prepare-resume-planned")).toBeNull();
});


// The production renderer path (#6 boundary B): main derives the conflict
// scan, so the panel's explicit human resume reaches the Host through the real
// shell route with no renderer-supplied scan at all.
it("resumes through the production shell route without a renderer-supplied scan", async () => {
  const taskOp = vi.fn(async () => ({
    ok: true,
    payload: { outcomes: prepared.outcomes, retry: prepared.retry, hold: [], created: ["frontend"], resumed: true },
  }));
  const original = (window as { pidock?: unknown }).pidock;
  (window as { pidock?: unknown }).pidock = { taskOp };
  try {
    const load = vi.fn(async () => ok(prepared));
    render(<TaskPrepareRecovery load={load} resume={shellTaskPrepareResume("task-abcdef12")} />);
    // Explicit human action only: neither the read nor the resume runs on mount.
    expect(taskOp).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "检查准备状态" }));
    await screen.findByTestId("prepare-status-rows");
    expect(taskOp).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "继续准备未完成的仓库" }));
    await waitFor(() => expect(taskOp).toHaveBeenCalledTimes(1));
    // The page sends no `takenPaths`/`branchesInUse`/`mainCheckouts`: main
    // derives them for this task and the Host keeps requiring them.
    expect(taskOp).toHaveBeenCalledWith("task-abcdef12", "task/resumeAppend", {});
    expect(await screen.findByTestId("prepare-resume-planned")).toHaveTextContent("已规划");
  } finally {
    (window as { pidock?: unknown }).pidock = original;
  }
});

it("shows main's named refusal reason when the production resume is refused", async () => {
  const taskOp = vi.fn(async () => {
    throw new Error(
      "Error invoking remote method 'shell/taskOp': Error: branch-in-use: 分支已在其他 worktree 使用: task/task-abcdef12",
    );
  });
  const original = (window as { pidock?: unknown }).pidock;
  (window as { pidock?: unknown }).pidock = { taskOp };
  try {
    const load = vi.fn(async () => ok(prepared));
    render(<TaskPrepareRecovery load={load} resume={shellTaskPrepareResume("task-abcdef12")} />);
    fireEvent.click(screen.getByRole("button", { name: "检查准备状态" }));
    await screen.findByTestId("prepare-status-rows");
    fireEvent.click(screen.getByRole("button", { name: "继续准备未完成的仓库" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("branch-in-use: 分支已在其他 worktree 使用");
    // The read state is kept, and the resume stays available (no silent damage).
    expect(screen.getByTestId("prepare-status-rows")).toHaveTextContent("invoice · 待准备");
    expect(screen.getByRole("button", { name: "继续准备未完成的仓库" })).toBeInTheDocument();
  } finally {
    (window as { pidock?: unknown }).pidock = original;
  }
});
