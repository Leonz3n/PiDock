import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesktopTaskCreation } from "../components/DesktopTaskCreation";
import { currentCreation, prepareCreation } from "../data/desktopCreation";
import type { DesktopProject } from "../data/desktopProjects";
import type { PidockBridge } from "../data/shellBridge";

const project: DesktopProject = { id: "bcedc870-22bd-474e-ac55-78d30a9d763d", name: "Real", description: "", repositories: [
  { id: "dad5fcb4-c91f-4ab0-bc33-fbb82053f871", name: "Web", path: "/local/web" },
], directories: [{ id: "e2eb192a-108b-4f9b-89a4-cd1fd8fb1fd0", name: "Documents", path: "/local/documents" }],
  environment: [], branchTemplate: "feature/{task-name}" };
const intent = { id: "a01fe61e-d112-487e-a7e8-113943b91072", taskId: "task-abc", name: "Work", projectId: project.id,
  root: "/local/tasks", taskDir: "/local/tasks/task-abc", branch: "task/abc", state: "pending", sharedWriteConfirmed: true,
  repos: [{ id: project.repositories[0]!.id, name: "Web", remote: "origin", remoteBranch: "main", commit: "a".repeat(40), repoDir: "repo-web" }],
  directories: [{ id: project.directories[0]!.id, name: "Documents", path: "/local/documents", linkName: "dir-documents" }] };
function bridge(operation: NonNullable<PidockBridge["createTask"]>): PidockBridge { return { createTask: operation }; }
afterEach(cleanup);

describe("Desktop task creation", () => {
  it("requires explicit remote, branch and shared writable directory confirmation before preview; commits fixed intent only once", async () => {
    const createTask = vi.fn(async (request: { op: string; input?: unknown; id?: string }) => {
      if (request.op === "current") return { ok: true, payload: null };
      if (request.op === "prepare") return { ok: true, payload: { canceled: false, intent } };
      return { ok: true, payload: { taskId: intent.taskId, projectId: project.id } };
    });
    const onCreated = vi.fn(async () => {});
    render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={onCreated} />);
    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "Work" } });
    const web = screen.getByRole("checkbox", { name: "Web" });
    fireEvent.click(web);
    fireEvent.change(screen.getByLabelText("远程名称"), { target: { value: "origin" } });
    fireEvent.change(screen.getByLabelText("远程分支"), { target: { value: "main" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Documents/ }));
    expect(screen.getByText(/共享可写链接接入任务/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /我确认普通目录/ }));
    fireEvent.click(screen.getByRole("button", { name: "固定基线并预览路径" }));
    await waitFor(() => expect(createTask).toHaveBeenCalledWith({ op: "prepare", input: { projectId: project.id, name: "Work",
      repositories: [{ sourceId: project.repositories[0]!.id, remote: "origin", remoteBranch: "main" }], directoryIds: [project.directories[0]!.id], sharedWriteConfirmed: true, override: false, workspaceMode: "worktree" } }));
    expect(await screen.findByText(intent.taskDir)).toBeInTheDocument();
    expect(screen.getByText(/a{40}/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认创建 / 恢复" }));
    await waitFor(() => expect(createTask).toHaveBeenCalledWith({ op: "commit", id: intent.id }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(project.id, intent.taskId));
    expect(createTask.mock.calls.filter(([request]) => request.op === "commit")).toHaveLength(1);
  });
  it("shows the persisted per-repository failure, adopts only on request, and abandons with an explicit cleanup scope", async () => {
    const baseCommit = "b".repeat(40);
    const createTask = vi.fn(async (request: { op: string; id?: string; cleanup?: string; adoptOrphanBranches?: boolean }) => {
      if (request.op === "current") return { ok: true, payload: null };
      if (request.op === "prepare") return { ok: true, payload: { canceled: false, intent } };
      if (request.op === "commit") return { ok: false, error: "部分仓库创建失败：repo-web 已创建（保留）；repo-docs 失败：WORKTREE_BRANCH_ORPHANED" };
      if (request.op === "status") return { ok: true, payload: {
        intent: { id: intent.id, taskId: intent.taskId, name: intent.name, taskDir: intent.taskDir, root: intent.root,
          branch: intent.branch, state: "pending", workspaceMode: "worktree" },
        repos: [
          { repoDir: "repo-web", phase: "created", label: "已创建", branch: "task/abc", baseCommit, worktreePath: `${intent.taskDir}/repo-web`,
            managed: true, createdByPidock: true },
          { repoDir: "repo-docs", phase: "failed", label: "失败", branch: "task/abc", baseCommit, worktreePath: `${intent.taskDir}/repo-docs`,
            managed: true, createdByPidock: true, orphan: { commit: baseCommit, adoptable: true },
            failure: { code: "WORKTREE_BRANCH_ORPHANED", detail: "任务分支已存在但工作树不在原位置" },
            previousFailure: { code: "WORKTREE_FETCH_FAILED", detail: "远程分支不存在或已删除" } },
        ],
        directories: [], canRetry: true, canAdoptOrphans: true, createdRepos: 1,
        message: "部分仓库创建失败：repo-web 已创建（保留）；repo-docs 失败",
      } };
      if (request.op === "retry") return { ok: true, payload: { taskId: intent.taskId, projectId: project.id, retried: ["repo-docs"] } };
      return { ok: true, payload: { taskId: intent.taskId, projectId: project.id, abandoned: true, message: "本次创建已放弃。" } };
    });
    render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={async () => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "Work" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Web" }));
    fireEvent.change(screen.getByLabelText("远程名称"), { target: { value: "origin" } });
    fireEvent.change(screen.getByLabelText("远程分支"), { target: { value: "main" } });
    fireEvent.click(screen.getByRole("button", { name: "固定基线并预览路径" }));
    await screen.findByText(intent.taskDir);
    fireEvent.click(screen.getByRole("button", { name: "确认创建 / 恢复" }));
    // The refusal is shown verbatim and the real state is read back with the
    // exact-key `status` operation.
    expect((await screen.findAllByText(/部分仓库创建失败/)).length).toBeGreaterThan(0);
    await waitFor(() => expect(createTask).toHaveBeenCalledWith({ op: "status" }));
    const states = await screen.findByRole("region", { name: "仓库准备状态" });
    expect(states).toHaveTextContent("repo-web · 已创建");
    expect(states).toHaveTextContent("repo-docs · 失败");
    expect(states).toHaveTextContent("WORKTREE_BRANCH_ORPHANED");
    expect(states).toHaveTextContent("上一次 WORKTREE_FETCH_FAILED");
    expect(states).toHaveTextContent("可显式接管");
    expect(states).toHaveTextContent("已创建 1/2");
    // The adopt choice is explicit: retry carries it only when checked.
    fireEvent.click(screen.getByRole("button", { name: "只重试失败仓库" }));
    await waitFor(() => expect(createTask).toHaveBeenCalledWith({ op: "retry", id: intent.id, adoptOrphanBranches: false }));
  });

  it("names a blank field in the path preview instead of printing an empty path segment", async () => {
    // `parse` in `desktopCreation.ts` requires the intent's own `name` to be
    // non-empty and type-checks (only) a repo's `commit`/`repoDir`/`name` and a
    // directory's `name`/`path`/`linkName`, so those blanks ARE reachable; the
    // preview used to print them as a bare `/` or a dangling `·`.
    const blank = { ...intent, state: "pending", repos: [{ ...intent.repos[0]!, name: "", remote: "", remoteBranch: "", commit: "", repoDir: "" }],
      directories: [{ ...intent.directories[0]!, name: "", path: "", linkName: "" }] };
    const createTask = vi.fn(async () => ({ ok: true, payload: blank }));
    render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={async () => {}} />);
    const preview = await screen.findByRole("region", { name: "创建任务" });
    // The intent's own name is validated non-empty by the reader, so it still
    // renders verbatim.
    expect(preview).toHaveTextContent(`任务路径预览 · ${intent.name}`);
    expect(preview).toHaveTextContent("Host 未上报仓库名称 · 原检出 Host 未上报原检出路径 · Host 未上报远程名/Host 未上报远程分支 · 固定基线 Host 未上报提交");
    expect(preview).toHaveTextContent("Host 未上报目录名");
    expect(preview).toHaveTextContent("Host 未上报目录名称 · Host 未上报目录路径 → " + blank.taskDir + "/Host 未上报链接名（共享可写）");
  });

  it("names a blank project source in the source list instead of an empty label or a bare separator", async () => {
    // `source()` (`data/desktopProjects.ts:38`) type-checks a source's `name` and
    // `path`, so this `DesktopProject` (the same reader DesktopInventory and
    // append surface read) can carry blanks; the picker used to render an empty
    // repo label and a ` · `-shaped directory label.
    const blankProject: DesktopProject = {
      ...project,
      repositories: [{ ...project.repositories[0]!, name: "", path: "" }],
      directories: [{ ...project.directories[0]!, name: "", path: "" }],
    };
    render(<DesktopTaskCreation project={blankProject} bridge={bridge(vi.fn(async () => ({ ok: true, payload: null })))} onCreated={async () => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    const [repo, dir] = screen.getAllByRole("checkbox");
    expect(repo!.closest("label")).toHaveTextContent("Host 未上报来源名称");
    expect(repo!.closest("div")!.querySelector("span")).toHaveTextContent("Host 未上报来源路径");
    expect(dir!.closest("label")).toHaveTextContent("Host 未上报来源名称 · Host 未上报来源路径");
  });

  it.each(["cancel", "error"] as const)("retains selected inputs after picker/prepare %s and previews the same request on retry", async (outcome) => {
    let attempts = 0;
    const createTask = vi.fn(async (request: { op: string; input?: unknown; id?: string }) => {
      if (request.op === "current") return { ok: true, payload: null };
      if (request.op === "prepare" && attempts++ === 0) return outcome === "cancel"
        ? { ok: true, payload: { canceled: true } }
        : { ok: false, error: "remote branch unavailable" };
      if (request.op === "prepare") return { ok: true, payload: { canceled: false, intent } };
      throw new Error("must not commit before confirmation");
    });
    const onCreated = vi.fn(async () => {});
    render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={onCreated} />);
    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    const name = screen.getByLabelText("任务名称");
    fireEvent.change(name, { target: { value: "Retained draft" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Web" }));
    fireEvent.change(screen.getByLabelText("远程名称"), { target: { value: "origin" } });
    fireEvent.change(screen.getByLabelText("远程分支"), { target: { value: "main" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Documents/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /我确认普通目录/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /单次选择其他任务根/ }));
    fireEvent.click(screen.getByRole("button", { name: "固定基线并预览路径" }));
    await waitFor(() => expect(createTask.mock.calls.filter(([request]) => request.op === "prepare")).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "固定基线并预览路径" })).toBeEnabled());
    expect(screen.getByLabelText("任务名称")).toBe(name);
    expect(name).toHaveValue("Retained draft");
    expect(screen.getByLabelText("远程名称")).toHaveValue("origin");
    expect(screen.getByLabelText("远程分支")).toHaveValue("main");
    for (const label of ["Web", /Documents/, /我确认普通目录/, /单次选择其他任务根/]) {
      expect(screen.getByRole("checkbox", { name: label })).toBeChecked();
    }
    expect(screen.queryByText(intent.taskDir)).not.toBeInTheDocument();
    expect(createTask.mock.calls.some(([request]) => request.op === "commit")).toBe(false);
    expect(onCreated).not.toHaveBeenCalled();
    if (outcome === "error") expect(screen.getByRole("alert")).toHaveTextContent("remote branch unavailable");
    else expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "固定基线并预览路径" }));
    expect(await screen.findByText(intent.taskDir)).toBeInTheDocument();
    const expected = { op: "prepare", input: { projectId: project.id, name: "Retained draft",
      repositories: [{ sourceId: project.repositories[0]!.id, remote: "origin", remoteBranch: "main" }],
      directoryIds: [project.directories[0]!.id], sharedWriteConfirmed: true, override: true, workspaceMode: "worktree" } };
    expect(createTask.mock.calls.filter(([request]) => request.op === "prepare").map(([request]) => request)).toEqual([expected, expected]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
  });
  it("recovers a pending creation after remount, reports failed commit, and retries unchanged ID", async () => {
    let failures = 1;
    const createTask = vi.fn(async (request: { op: string; id?: string }) => {
      if (request.op === "current") return { ok: true, payload: intent };
      if (request.op === "commit" && failures--) return { ok: false, error: "fetch failed" };
      return { ok: true, payload: { taskId: intent.taskId, projectId: project.id } };
    });
    render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={vi.fn(async () => {})} />);
    expect(await screen.findByText(intent.taskDir)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认创建 / 恢复" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("fetch failed");
    expect(screen.getByText(intent.taskDir)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认创建 / 恢复" }));
    await waitFor(() => expect(createTask.mock.calls.filter(([request]) => request.op === "commit")).toHaveLength(2));
    expect(createTask.mock.calls.filter(([request]) => request.op === "commit").map(([request]) => request.id)).toEqual([intent.id, intent.id]);
  });
  it("explicitly abandons a pending intent without deleting anything and permits a new form", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    // #88: main only abandons on explicit confirmation and answers with what it did
    // NOT delete; the page has to show that sentence, so the fake returns it too.
    const createTask = vi.fn(async (request: { op: string; id?: string }) => request.op === "current"
      ? { ok: true, payload: intent }
      : { ok: true, payload: { taskId: intent.taskId, abandoned: true,
        message: "本次创建已放弃。已产生的任务目录、工作区、链接与会话均已保留；如任务记录已存在，该任务现为未归属任务。" } });
    render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={vi.fn(async () => {})} />);
    expect(await screen.findByText(intent.taskDir)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "放弃并重新创建" }));
    await waitFor(() => expect(createTask).toHaveBeenCalledWith({ op: "abandon", id: intent.id, confirmed: true }));
    expect(confirm).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByText(intent.taskDir)).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("已产生的任务目录、工作区、链接与会话均已保留");
    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    expect(screen.getByLabelText("任务名称")).toHaveValue("");
    confirm.mockRestore();
  });
  it("reports a refusal to abandon without dropping the pending intent or the disk statement", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const createTask = vi.fn(async (request: { op: string }) => request.op === "current"
      ? { ok: true, payload: intent }
      : { ok: false, error: "该任务已关联到项目 abc，放弃本次创建不会替你解除关联；请先在「项目管理」里解绑该任务，再放弃本次创建" });
    render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={vi.fn(async () => {})} />);
    expect(await screen.findByText(intent.taskDir)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "放弃并重新创建" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请先在「项目管理」里解绑该任务");
    expect(screen.getByText(intent.taskDir)).toBeInTheDocument();
    confirm.mockRestore();
  });
  it("refuses to submit stale source IDs when Project selection changes", async () => {
    const createTask = vi.fn(async (_request: { op: string }) => ({ ok: true, payload: null }));
    const view = render(<DesktopTaskCreation project={project} bridge={bridge(createTask)} onCreated={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "Draft" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Web" }));
    view.rerender(<DesktopTaskCreation project={{ ...project, id: "f988454a-659d-41d7-b454-c738791a2324", repositories: [] }} bridge={bridge(createTask)} onCreated={vi.fn(async () => {})} />);
    expect(screen.getByText(/项目选择已变化/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "固定基线并预览路径" })).toBeDisabled();
    expect(createTask.mock.calls.filter(([request]) => request.op === "prepare")).toHaveLength(0);
  });
  it("creates a PURE-directory task: zero repositories, one directory, no Git baseline required", async () => {
    const noRepoProject: DesktopProject = {
      id: "c1de0000-0000-4000-8000-000000000001", name: "Docs only", description: "",
      repositories: [], directories: [{ id: "e2eb192a-108b-4f9b-89a4-cd1fd8fb1fd0", name: "Documents", path: "/local/documents" }],
      environment: [], branchTemplate: "feature/{task-name}",
    };
    const pureIntent = { id: "b01fe61e-d112-487e-a7e8-113943b91072", taskId: "task-pure", name: "Docs work", projectId: noRepoProject.id,
      root: "/local/tasks", taskDir: "/local/tasks/task-pure", branch: "task/pure", state: "pending", sharedWriteConfirmed: true,
      repos: [], directories: [{ id: noRepoProject.directories[0]!.id, name: "Documents", path: "/local/documents", linkName: "dir-e2eb192a" }] };
    const createTask = vi.fn(async (request: { op: string; input?: unknown; id?: string }) => {
      if (request.op === "current") return { ok: true, payload: null };
      if (request.op === "prepare") return { ok: true, payload: { canceled: false, intent: pureIntent } };
      return { ok: true, payload: { taskId: pureIntent.taskId, projectId: noRepoProject.id } };
    });
    const onCreated = vi.fn(async () => {});
    render(<DesktopTaskCreation project={noRepoProject} bridge={bridge(createTask)} onCreated={onCreated} />);
    // No Git repository in the project, but the create entry is still available.
    const open = screen.getByRole("button", { name: "任务" });
    expect(open).toBeEnabled();
    fireEvent.click(open);
    fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "Docs work" } });
    const submit = screen.getByRole("button", { name: "预览路径" });
    // Selecting only a directory is not enough until the shared write is confirmed.
    fireEvent.click(screen.getByRole("checkbox", { name: /Documents/ }));
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /我确认普通目录/ }));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(createTask).toHaveBeenCalledWith({ op: "prepare", input: { projectId: noRepoProject.id, name: "Docs work",
      repositories: [], directoryIds: [noRepoProject.directories[0]!.id], sharedWriteConfirmed: true, override: false, workspaceMode: "plain-dirs" } }));
    expect(await screen.findByText(pureIntent.taskDir)).toBeInTheDocument();
    expect(screen.getByText(/dir-e2eb192a/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认创建 / 恢复" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(noRepoProject.id, pureIntent.taskId));
  });
});

it("creates a dedicated scheduled task: the form sends kind=scheduled with its definition", async () => {
  const dirProject: DesktopProject = { id: "c0ffee00-0000-4000-8000-000000000001", name: "Docs", description: "",
    repositories: [], directories: [{ id: "e2eb192a-108b-4f9b-89a4-cd1fd8fb1fd0", name: "Documents", path: "/local/documents" }],
    environment: [], branchTemplate: "feature/{task-name}" };
  const createTask = vi.fn(async (request: { op: string; input?: unknown }) => {
    if (request.op === "current") return { ok: true, payload: null };
    return { ok: true, payload: { canceled: false, intent: { ...intent, projectId: dirProject.id, kind: "scheduled" } } };
  });
  const providerOp = vi.fn(async () => ({ ok: true, payload: { state: "configured", profileId: null, generation: null, profiles: [{
    id: "p-11111111-2222-3333-4444-555555555555", name: "Loopback", baseUrl: "https://127.0.0.1:8443", modelId: "model-x", contextWindow: 128000, maxTokens: 8192,
    authRef: "PIDOCK_PROVIDER_TEST", generation: 1, credentialAvailable: true,
    models: [{ id: "model-x", name: "Model X", contextWindow: 128000, maxTokens: 8192, reasoning: false, reasoningLevels: ["off"], cost: null }],
  }] } }));
  window.pidock = { createTask, providerOp } as never;
  render(<DesktopTaskCreation project={dirProject} bridge={bridge(createTask)} onCreated={async () => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "任务" }));
  fireEvent.click(screen.getByRole("radio", { name: "定时任务" }));
  fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "每日巡检" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /Documents/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: /我确认普通目录/ }));
  fireEvent.change(await screen.findByLabelText("定时任务规则"), { target: { value: "每日 09:15" } });
  fireEvent.change(screen.getByLabelText("定时任务时区"), { target: { value: "Asia/Shanghai" } });
  fireEvent.change(await screen.findByLabelText("定时任务提示词"), { target: { value: "检查风险" } });
  await waitFor(() => expect(screen.getByLabelText("定时任务模型").querySelectorAll("option").length).toBeGreaterThan(1));
  fireEvent.change(screen.getByLabelText("定时任务模型"), { target: { value: "p-11111111-2222-3333-4444-555555555555\u0000model-x" } });
  fireEvent.click(screen.getByRole("button", { name: "预览路径" }));
  await waitFor(() => expect(createTask).toHaveBeenCalledWith({ op: "prepare", input: expect.objectContaining({
    projectId: dirProject.id, name: "每日巡检", workspaceMode: "plain-dirs",
    kind: "scheduled",
    schedule: expect.objectContaining({ ruleText: "每日 09:15", timezone: "Asia/Shanghai", prompt: "检查风险", providerId: "p-11111111-2222-3333-4444-555555555555", model: "model-x", permission: "default", enabled: true }),
  }) }));
  delete window.pidock;
});

it("reads the Host's real scheduled plain-dirs intent: an empty branch is truthful, not a broken answer", async () => {
  // [Pencil T17] #152 real Electron evidence: a scheduled task on 仅普通目录 was
  // prepared by main (intent written, `branch: ""` because that mode creates no
  // branch), but the renderer's reader required `branch` non-empty and threw
  // `本机任务创建意图返回异常`, so the preview and `current()` stayed empty. This is
  // the exact payload shape the real IPC answers with, including the schedule.
  const dirProject: DesktopProject = { id: "c0ffee00-0000-4000-8000-000000000002", name: "Docs", description: "",
    repositories: [], directories: [{ id: "e2eb192a-108b-4f9b-89a4-cd1fd8fb1fd0", name: "Documents", path: "/local/documents" }],
    environment: [], branchTemplate: "" };
  const scheduledIntent = {
    id: "b71e61e1-d112-487e-a7e8-113943b91073", taskId: "task-sched", name: "每日巡检", projectId: dirProject.id,
    root: "/local/tasks", taskDir: "/local/tasks/task-sched", branch: "", state: "pending", sharedWriteConfirmed: true,
    workspaceMode: "plain-dirs", kind: "scheduled",
    repos: [], directories: [{ id: dirProject.directories[0]!.id, name: "Documents", path: "/local/documents", linkName: "dir-e2eb192a" }],
    schedule: { name: "每日巡检", ruleText: "每日 09:15", timezone: "Asia/Shanghai", prompt: "检查风险",
      providerId: "p-11111111-2222-3333-4444-555555555555", model: "model-x", permission: "default" as const, enabled: true },
  };
  const createTask = vi.fn(async (request: { op: string }) => request.op === "current"
    ? { ok: true, payload: scheduledIntent }
    : { ok: true, payload: { canceled: false, intent: scheduledIntent } });
  const testBridge = bridge(createTask);
  await expect(currentCreation(testBridge)).resolves.toMatchObject({ kind: "scheduled", branch: "", workspaceMode: "plain-dirs", schedule: scheduledIntent.schedule });
  await expect(prepareCreation(testBridge, { projectId: dirProject.id, name: "每日巡检",
    repositories: [], directoryIds: [dirProject.directories[0]!.id], sharedWriteConfirmed: true, override: false,
    workspaceMode: "plain-dirs", kind: "scheduled", schedule: scheduledIntent.schedule }))
    .resolves.toMatchObject({ kind: "scheduled", taskId: "task-sched", taskDir: scheduledIntent.taskDir, branch: "", schedule: scheduledIntent.schedule });
  // The page resumes the pending creation from `current()` and renders the path
  // preview instead of the generic refusal.
  render(<DesktopTaskCreation project={dirProject} bridge={testBridge} onCreated={async () => {}} />);
  expect(await screen.findByText(scheduledIntent.taskDir)).toBeInTheDocument();
  expect(screen.queryByText("本机任务创建意图返回异常")).toBeNull();
});
