/**
 * [Pencil T07] #142: after a successful creation the user lands on the task's
 * first conversation entry — the existing single `main` session — not only on
 * the S08 facts. The facts stay visible above it, the `main` entry is openable,
 * and a Host with no Provider/model configured is asked to configure one
 * instead of the page choosing a model or calling one by itself.
 *
 * The route below is the shipped one: `DesktopInventory` → S02 form
 * (`DesktopTaskCreation`) → real create IPC → post-create re-read → task
 * workspace (S08 facts + `DesktopConversation`). No fixture task is injected
 * into the open task view; only the create/reload answers are stubbed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesktopInventory } from "../components/DesktopInventory";
import type { PidockBridge } from "../data/shellBridge";

const PROJECT_ID = "bcedc870-22bd-474e-ac55-78d30a9d763d";
const REPO_ID = "dad5fcb4-c91f-4ab0-bc33-fbb82053f871";
const TASK_ID = "task-abc12345";
const BRANCH = "task/task-abc12345";
const BASE = "b".repeat(40);
const roots = [{ label: "默认任务根", state: "ready" as const }];
const project = {
  id: PROJECT_ID, name: "真实工作空间", description: "",
  repositories: [{ id: REPO_ID, name: "Web", path: "/private/work/web" }],
  directories: [], environment: [], branchTemplate: "feature/{task-name}",
};
const intent = {
  id: "a01fe61e-d112-487e-a7e8-113943b91072", taskId: TASK_ID, name: "重构认证", projectId: PROJECT_ID,
  root: "/tasks", taskDir: `/tasks/${TASK_ID}`, branch: BRANCH, state: "pending" as const,
  workspaceMode: "worktree" as const,
  repos: [{ id: REPO_ID, name: "Web", remote: "origin", remoteBranch: "main", commit: BASE, repoDir: "repo-1", path: "/private/work/web" }],
  directories: [],
};
const facts = {
  taskDir: `/tasks/${TASK_ID}`, workspaceMode: "worktree",
  roots: [{
    id: "repo-1", kind: "worktree", label: "repo-1", path: `/tasks/${TASK_ID}/repo-1`,
    baselineBranch: "main", expectedBranch: BRANCH, baseCommit: BASE, sourceRealPath: "/private/work/web",
    workingBranch: { state: "observed", value: BRANCH }, dirty: { state: "observed", value: false },
    verification: { state: "ready", reason: "已核验：来源身份与记录一致" },
  }],
};

function bridge() {
  let created = false;
  // [#139] The Host's session index for this task: one migrated session, `main`.
  const session = { id: "main", name: "主会话", createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z", archived: false, permission: "default", binding: null };
  const taskOp = vi.fn(async (taskId: string, op: string) => {
    if (op === "task/lifecycleState") return { ok: true as const, payload: { lifecycle: { taskId, archived: false, archivedAt: null } } };
    if (op === "task/fileRoots") return { ok: true as const, payload: facts };
    if (op === "task/sessionList") return { ok: true as const, payload: { activeSessionId: "main", sessions: [session], provider: null } };
    if (op === "task/sessionReadout") return { ok: true as const, payload: { session, active: true, model: null, reasoningLevels: [], context: { used: null, window: null, source: "unknown" }, usage: null, turns: 0, transcriptModel: null, pending: false, interrupted: false } };
    return { ok: true as const, payload: { op } };
  });
  const host = {
    listTasks: vi.fn(async () => ({ ok: true as const, payload: {
      tasks: created ? [{ taskId: TASK_ID, name: "重构认证", branch: BRANCH, repoCount: 1, updatedAt: "2026-10-20" }] : [],
      roots,
    } })),
    projectOp: vi.fn(async (request: { op: string }) => request.op === "list"
      ? { ok: true as const, payload: { initialized: true, projects: [project] } }
      : { ok: true as const, payload: { roots, tasks: created ? [{ taskId: TASK_ID, projectId: PROJECT_ID, state: "assigned" }] : [] } }),
    taskOp,
    createTask: vi.fn(async (request: { op: string }) => {
      if (request.op === "current") return { ok: true as const, payload: null };
      if (request.op === "prepare") return { ok: true as const, payload: { canceled: false, intent } };
      created = true;
      return { ok: true as const, payload: { taskId: TASK_ID, projectId: PROJECT_ID } };
    }),
    providerOp: vi.fn(async () => ({ ok: true as const, payload: { state: "not-configured", profileId: null, generation: null, profiles: [] } })),
    sdkTurn: vi.fn(async (request: { action: string }) => ({ ok: true as const, payload: request.action === "subscribe"
      ? { taskId: TASK_ID, sessionId: "main", snapshot: { source: "sdk-jsonl", sessionId: "main", messages: [], pending: false, interrupted: false }, turn: null }
      : { unsubscribed: true } })),
    onSdkTurnEvent: vi.fn(() => vi.fn()),
  };
  return { host: host as unknown as PidockBridge, taskOp, sdkTurn: host.sdkTurn };
}

afterEach(() => { cleanup(); delete (window as { pidock?: unknown }).pidock; vi.restoreAllMocks(); });

describe("[Pencil T07] #142 post-create landing", () => {
  it("lands on the task's facts and its open `main` conversation entry, requiring Provider configuration instead of calling a model", async () => {
    const { host, taskOp, sdkTurn } = bridge();
    window.pidock = host;
    render(<DesktopInventory />);

    await screen.findByTestId("desktop-project-overview");
    fireEvent.click(screen.getByRole("button", { name: "项目管理" }));
    fireEvent.click(await screen.findByRole("button", { name: "任务" }));
    fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "重构认证" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Web" }));
    fireEvent.change(screen.getByLabelText("远程名称"), { target: { value: "origin" } });
    fireEvent.change(screen.getByLabelText("远程分支"), { target: { value: "main" } });
    fireEvent.click(screen.getByRole("button", { name: "固定基线并预览路径" }));
    // The S02 preview names the mode, the branch and the per-repo facts.
    expect(await screen.findByText(/任务工作区模式：/)).toHaveTextContent("独立 Worktree（默认）");
    fireEvent.click(screen.getByRole("button", { name: "确认创建 / 恢复" }));

    // Landing: only S08; the real session is opened explicitly.
    expect(await screen.findByTestId("desktop-task-facts")).toBeInTheDocument();
    expect(screen.queryByTestId("desktop-conversation")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("task-facts-mode")).toHaveTextContent("独立 Worktree"));
    fireEvent.click(await screen.findByRole("button", { name: "进入对话 · 主会话" }));
    expect(await screen.findByTestId("desktop-conversation")).toBeInTheDocument();
    // The Host's own session entry is shown by NAME, and its id is what is subscribed.
    expect(await screen.findByRole("tab", { name: "主会话" })).toBeInTheDocument();
    expect(sdkTurn).toHaveBeenCalledWith(expect.objectContaining({ action: "subscribe", taskId: TASK_ID, sessionId: "main" }));
    expect(taskOp.mock.calls.some(([, op]) => op === "task/fileRoots")).toBe(true);
    // No Provider is configured: the entry asks for configuration and routes to
    // 能力管理 → Providers; nothing selected a model and nothing was sent.
    const requirement = await screen.findByTestId("provider-requirement");
    expect(requirement).toHaveTextContent(/未配置/);
    expect(requirement).toHaveTextContent(/不会自动选择或调用模型/);
    expect(requirement).toHaveTextContent(/能力管理 → Providers/);
    expect(sdkTurn.mock.calls.some(([request]) => (request as { action?: string }).action === "start")).toBe(false);
  });
});
