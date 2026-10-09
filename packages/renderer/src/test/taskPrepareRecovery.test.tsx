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
  const resume = vi.fn(async (_input: { repoDirs: string[] }) => ok({ ...prepared, retry: [], canResume: false }));
  render(<TaskPrepareRecovery load={load} resume={resume} />);
  fireEvent.click(screen.getByRole("button", { name: "检查准备状态" }));
  await screen.findByTestId("prepare-status-rows");

  fireEvent.click(screen.getByRole("button", { name: "继续准备未完成的仓库" }));
  expect(resume).toHaveBeenCalledTimes(1);
  // `frontend` is created: it must not enter the retry set.
  expect(resume.mock.calls[0]![0]).toEqual({ repoDirs: ["invoice", "shipment"] });
  // Once nothing is unfinished there is no resume affordance.
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

it("rejects a malformed status payload instead of showing a fabricated ready view", async () => {
  const load = vi.fn(async () => ok({ outcomes: [{ repoDir: "x", status: "ready" }], retry: [], hold: [] }));
  render(<TaskPrepareRecovery load={load} resume={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "检查准备状态" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("准备状态返回异常");
  expect(screen.queryByTestId("prepare-status-rows")).toBeNull();
});
