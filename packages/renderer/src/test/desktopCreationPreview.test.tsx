/**
 * [Pencil T13] #148b — the S02 create form's pre-creation preview.
 *
 * The form must show, per repository, the EXACT local branch and push target
 * main will create, read from the SAVED convention/remote (main's own read) and
 * not from a page-side guess. An unset/invalid convention or remote is named
 * and blocks creation; 仅普通目录 shows 无 Git 交付 instead of a fake branch. The
 * same rows must follow a saved settings change.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopTaskCreation } from "../components/DesktopTaskCreation";
import type { DesktopProject } from "../data/desktopProjects";
import type { PidockBridge } from "../data/shellBridge";

const project: DesktopProject = {
  id: "bcedc870-22bd-474e-ac55-78d30a9d763d", name: "Core", description: "",
  repositories: [
    { id: "dad5fcb4-c91f-4ab0-bc33-fbb82053f871", name: "Web", path: "/local/web" },
    { id: "e6f9b7b0-2e55-4acb-b655-0a1e3f7bbf0c", name: "API", path: "/local/api" },
  ],
  directories: [{ id: "e2eb192a-108b-4f9b-89a4-cd1fd8fb1fd0", name: "Documents", path: "/local/documents" }],
  environment: [],
  branchTemplate: "feature/{task-name}",
};
const TASK_ID = "task-1a2b3c4d";
const BRANCH = `ticket/${TASK_ID}-refactor-auth`;
const settings = { branchTemplate: "ticket/{taskId}-{slug}", remote: "origin", savedAt: "2026-11-04T00:00:00.000Z" };

type Row = {
  repoId: string; name: string; repoPath: string; localBranch: string; remote: string;
  pushTarget: string; remoteUrl: string | null; currentBranch: string;
  problem: { code: string; message: string } | null;
};
function row(overrides: Partial<Row> & { repoId: string; name: string; repoPath: string }): Row {
  return {
    localBranch: BRANCH, remote: "origin", pushTarget: `origin ${BRANCH}`, remoteUrl: `git@github.com:acme/${overrides.name}.git`,
    currentBranch: "", problem: null, ...overrides,
  };
}
function plan(overrides: Record<string, unknown> = {}) {
  return {
    taskId: TASK_ID, taskTitle: "Refactor Auth", workspaceMode: "worktree",
    branchTemplate: settings.branchTemplate, remote: "origin", gitDelivery: "branch",
    ready: true,
    rows: [row({ repoId: project.repositories[0]!.id, name: "Web", repoPath: "/local/web" })],
    problem: null,
    message: `将为 1 个仓库创建本地分支 ${BRANCH}，推送目标 origin ${BRANCH}`,
    ...overrides,
  };
}

type Call = { op: string; input?: { repositories?: { sourceId: string }[] }; branchTemplate?: string; remote?: string };
function bridge(operation: (request: Call) => Promise<{ ok: boolean; payload?: unknown; error?: string }>): PidockBridge {
  return { createTask: operation as NonNullable<PidockBridge["createTask"]> };
}
const ok = (payload: unknown) => ({ ok: true as const, payload });

afterEach(cleanup);

/** Fill the minimum the form needs to submit a worktree creation for both repos. */
function selectBothRepos() {
  fireEvent.click(screen.getByRole("button", { name: "任务" }));
  fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "Refactor Auth" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Web" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "API" }));
  const remoteInputs = screen.getAllByLabelText("远程名称");
  remoteInputs.forEach((input) => fireEvent.change(input, { target: { value: "origin" } }));
  screen.getAllByLabelText("远程分支").forEach((input) => fireEvent.change(input, { target: { value: "main" } }));
}

describe("S02 create form previews the branch and push target BEFORE creation", () => {
  it("shows main's exact local branch and push target for one repository", async () => {
    const createTask = vi.fn(async (request: Call) => {
      if (request.op === "current") return ok(null);
      if (request.op === "deliverySettings") return ok({ settings });
      if (request.op === "deliveryPreview") return ok(plan());
      return ok({ canceled: false, intent: null });
    });
    render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "Refactor Auth" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Web" }));
    fireEvent.change(screen.getByLabelText("远程名称"), { target: { value: "origin" } });
    fireEvent.change(screen.getByLabelText("远程分支"), { target: { value: "main" } });

    const region = screen.getByRole("region", { name: "创建前分支与推送目标预览" });
    expect(await within(region).findByText(BRANCH)).toBeInTheDocument();
    expect(within(region).getByText(`origin ${BRANCH}`)).toBeInTheDocument();
    expect(within(region).getByText(`任务 ${TASK_ID}`)).toBeInTheDocument();
    // The preview came from main's read with the SAME input the form submits.
    const previewCall = createTask.mock.calls.map(([request]) => request).find((request) => request.op === "deliveryPreview");
    expect(previewCall?.input?.repositories?.map((entry) => entry.sourceId)).toEqual([project.repositories[0]!.id]);
    // The saved convention/remote are shown as main read them (not the project's
    // legacy `{task-name}` template).
    expect(screen.getByLabelText("分支规范")).toHaveValue("ticket/{taskId}-{slug}");
    expect(screen.getByLabelText("推送目标远程")).toHaveValue("origin");
  });

  it("shows one branch/push-target row per repository for two repositories", async () => {
    const createTask = vi.fn(async (request: Call) => {
      if (request.op === "current") return ok(null);
      if (request.op === "deliverySettings") return ok({ settings });
      if (request.op === "deliveryPreview") return ok(plan({ rows: [
        row({ repoId: project.repositories[0]!.id, name: "Web", repoPath: "/local/web" }),
        row({ repoId: project.repositories[1]!.id, name: "API", repoPath: "/local/api" }),
      ] }));
      return ok({ canceled: false, intent: null });
    });
    render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={vi.fn(async () => {})} />);
    selectBothRepos();
    const region = screen.getByRole("region", { name: "创建前分支与推送目标预览" });
    await waitFor(() => expect(within(region).getAllByText(BRANCH)).toHaveLength(2));
    expect(within(region).getAllByText(`origin ${BRANCH}`)).toHaveLength(2);
    expect(within(region).getByText("Web")).toBeInTheDocument();
    expect(within(region).getByText("API")).toBeInTheDocument();
    expect(within(region).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("names an unset convention and blocks creation instead of guessing a branch", async () => {
    const unset = { code: "branch-template-unset", message: "工作空间未保存分支规范：请在设置里填写分支模板（如 ticket/{taskId}-{slug}）" };
    const createTask = vi.fn(async (request: Call) => {
      if (request.op === "current") return ok(null);
      if (request.op === "deliverySettings") return ok({ settings: { branchTemplate: "", remote: "origin", savedAt: null } });
      if (request.op === "deliveryPreview") return ok(plan({
        branchTemplate: "", ready: false, problem: unset,
        rows: [row({ repoId: project.repositories[0]!.id, name: "Web", repoPath: "/local/web", localBranch: "", remote: "", pushTarget: "", problem: unset })],
        message: `无法预览：${unset.message}`,
      }));
      return ok({ canceled: false, intent: null });
    });
    render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "Refactor Auth" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Web" }));
    fireEvent.change(screen.getByLabelText("远程名称"), { target: { value: "origin" } });
    fireEvent.change(screen.getByLabelText("远程分支"), { target: { value: "main" } });

    const region = screen.getByRole("region", { name: "创建前分支与推送目标预览" });
    // The row names the code AND the plan restates it; both come from main.
    expect((await within(region).findAllByText(/branch-template-unset/)).length).toBeGreaterThan(0);
    expect(within(region).getByRole("alert")).toHaveTextContent("创建已阻止");
    expect(within(region).getByRole("alert")).toHaveTextContent("不会用默认分支名代替");
    const submit = screen.getByRole("button", { name: "固定基线并预览路径" });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    await waitFor(() => expect(createTask.mock.calls.filter(([request]) => request.op === "prepare")).toHaveLength(0));
  });

  it("names an invalid remote (the checkout does not have it) and blocks creation", async () => {
    const bad = { code: "remote-invalid", message: "仓库 Web 没有名为 upstream 的远程（git remote get-url 无结果），推送目标不可用" };
    const createTask = vi.fn(async (request: Call) => {
      if (request.op === "current") return ok(null);
      if (request.op === "deliverySettings") return ok({ settings: { branchTemplate: settings.branchTemplate, remote: "upstream", savedAt: null } });
      if (request.op === "deliveryPreview") return ok(plan({
        remote: "upstream", ready: false, rows: [row({ repoId: project.repositories[0]!.id, name: "Web", repoPath: "/local/web", localBranch: "", remote: "", pushTarget: "", problem: bad })],
        message: `无法预览：${bad.message}`,
      }));
      return ok({ canceled: false, intent: null });
    });
    render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "Refactor Auth" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Web" }));
    fireEvent.change(screen.getByLabelText("远程名称"), { target: { value: "origin" } });
    fireEvent.change(screen.getByLabelText("远程分支"), { target: { value: "main" } });
    const region = screen.getByRole("region", { name: "创建前分支与推送目标预览" });
    expect((await within(region).findAllByText(/remote-invalid：/)).length).toBeGreaterThan(0);
    expect(within(region).getAllByText(/upstream/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "固定基线并预览路径" })).toBeDisabled();
  });

  it("shows 无 Git 交付 for 仅普通目录 instead of a fake branch", async () => {
    const createTask = vi.fn(async (request: Call) => {
      if (request.op === "current") return ok(null);
      if (request.op === "deliverySettings") return ok({ settings });
      if (request.op === "deliveryPreview") return ok(plan({
        workspaceMode: "plain-dirs", gitDelivery: "none", rows: [], remote: "",
        message: "仅普通目录：无 Git 交付（不创建分支、没有推送目标；写入直接落在原目录）",
      }));
      return ok({ canceled: false, intent: null });
    });
    render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    fireEvent.click(screen.getByRole("radio", { name: "仅普通目录" }));
    const region = screen.getByRole("region", { name: "创建前分支与推送目标预览" });
    expect(within(region).getAllByText(/无 Git 交付/).length).toBeGreaterThan(0);
    expect(within(region).queryByText(BRANCH)).not.toBeInTheDocument();
    expect(within(region).queryByText(/task\//)).not.toBeInTheDocument();
    // A plain-directory creation is not blocked by the (unused) convention.
    await waitFor(() => expect(within(region).queryByRole("alert")).not.toBeInTheDocument());
  });

  it("re-reads the preview when the saved convention changes and follows it", async () => {
    let saved = { ...settings };
    const createTask = vi.fn(async (request: Call) => {
      if (request.op === "current") return ok(null);
      if (request.op === "deliverySettings") return ok({ settings: saved });
      if (request.op === "saveDeliverySettings") {
        saved = { branchTemplate: String(request.branchTemplate), remote: String(request.remote), savedAt: "2026-11-05T00:00:00.000Z" };
        return ok({ settings: saved });
      }
      if (request.op === "deliveryPreview") {
        const branch = saved.branchTemplate === "ticket/{taskId}-{slug}" ? BRANCH : `feature/${TASK_ID}-refactor-auth`;
        return ok(plan({ branchTemplate: saved.branchTemplate, remote: saved.remote, rows: [
          row({ repoId: project.repositories[0]!.id, name: "Web", repoPath: "/local/web", localBranch: branch, pushTarget: `${saved.remote} ${branch}` }),
        ] }));
      }
      return ok({ canceled: false, intent: null });
    });
    render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "Refactor Auth" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Web" }));
    fireEvent.change(screen.getByLabelText("远程名称"), { target: { value: "origin" } });
    fireEvent.change(screen.getByLabelText("远程分支"), { target: { value: "main" } });
    const region = screen.getByRole("region", { name: "创建前分支与推送目标预览" });
    expect(await within(region).findByText(BRANCH)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("分支规范"), { target: { value: "feature/{taskId}-{slug}" } });
    fireEvent.click(screen.getByRole("button", { name: "保存交付设置" }));
    expect(await screen.findByText(/已保存分支规范与推送目标/)).toBeInTheDocument();
    // The preview re-read the SAVED values: the old branch is gone, the new one
    // is what the row now shows.
    expect(await within(region).findByText(`feature/${TASK_ID}-refactor-auth`)).toBeInTheDocument();
    expect(within(region).queryByText(BRANCH)).not.toBeInTheDocument();
    expect(within(region).getByText(`origin feature/${TASK_ID}-refactor-auth`)).toBeInTheDocument();
  });

  it("keeps every preview row dense enough for 720×560 (no nested scroll container)", async () => {
    const createTask = vi.fn(async (request: Call) => {
      if (request.op === "current") return ok(null);
      if (request.op === "deliverySettings") return ok({ settings });
      if (request.op === "deliveryPreview") return ok(plan({ rows: [
        row({ repoId: project.repositories[0]!.id, name: "Web", repoPath: "/local/web" }),
        row({ repoId: project.repositories[1]!.id, name: "API", repoPath: "/local/api" }),
      ] }));
      return ok({ canceled: false, intent: null });
    });
    render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={vi.fn(async () => {})} />);
    selectBothRepos();
    const region = screen.getByRole("region", { name: "创建前分支与推送目标预览" });
    await waitFor(() => expect(within(region).getAllByText(BRANCH)).toHaveLength(2));
    // One row per repository, each on its own line, in the existing dialog: the
    // block adds no navigation and no scroll region of its own.
    expect(region.querySelectorAll("li")).toHaveLength(2);
    expect(region.className).not.toContain("overflow-y-auto");
    expect(region.className).not.toContain("max-h-");
  });
});
