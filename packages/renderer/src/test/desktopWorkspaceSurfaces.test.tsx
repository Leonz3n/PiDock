import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "../App";
import type { PidockBridge } from "../data/shellBridge";

/**
 * #136 A + bullet 4 — the S07 workspace page as reached from the shell's own
 * navigation, the real per-source verification it shows, and the registry
 * corruption recovery the error page offers.
 */

const PROJECT_ID = "bcedc870-22bd-474e-ac55-78d30a9d763d";
const REPO_ID = "dad5fcb4-c91f-4ab0-bc33-fbb82053f871";
const DIR_ID = "039b8a52-e7c9-4b28-af70-3cee22b19a89";
const TASK_ID = "real-1";
const tasks = [{ taskId: TASK_ID, name: "真实任务", branch: "task/main", repoCount: 1, updatedAt: "2026-09-22" }];
const roots = [{ label: "默认任务根", state: "ready" as const }];
const project = {
  id: PROJECT_ID,
  name: "真实项目",
  description: "系统 A",
  repositories: [{ id: REPO_ID, name: "Web", path: "/private/work/web" }],
  directories: [{ id: DIR_ID, name: "Docs", path: "/private/docs" }],
  environment: [],
  branchTemplate: "feature/{task-name}",
};
const other = { ...project, id: "6fd712ce-a43b-4614-a459-de81d78a16aa", name: "另一个工作空间", repositories: [], directories: [] };

function bridge(projectOp: PidockBridge["projectOp"]): PidockBridge {
  return {
    listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })),
    importTaskRoot: vi.fn(async () => ({ ok: true, payload: { canceled: false, count: 1 } })),
    taskOp: vi.fn(async (taskId: string, op: string) => op === "task/lifecycleState"
      ? { ok: true, payload: { lifecycle: { taskId, archived: false, archivedAt: null } } }
      : { ok: true, payload: { op } }),
    projectOp,
  } as unknown as PidockBridge;
}

afterEach(() => { cleanup(); delete window.pidock; vi.restoreAllMocks(); });

describe("#136 S07 workspace navigation, source verification and recovery", () => {
  it("reaches 未归属任务 and a workspace from the shell's own nav, without leaving the production route", async () => {
    const projectOp = vi.fn(async (request: { op: string }) => {
      if (request.op === "list") return { ok: true, payload: { initialized: true, projects: [project, other] } };
      if (request.op === "associations") return { ok: true, payload: { roots, tasks: [{ taskId: TASK_ID, projectId: null, state: "unassigned" }] } };
      return { ok: true, payload: { projectId: PROJECT_ID, sources: [] } };
    });
    window.pidock = bridge(projectOp);
    render(<App />);
    await screen.findByTestId("desktop-project-overview");

    const sidebar = within(screen.getByTestId("desktop-sidebar"));
    // Bullet 3: 未归属任务 is its own entry, not a guessed workspace.
    fireEvent.click(sidebar.getByRole("button", { name: "未归属任务" }));
    expect(await screen.findByTestId("desktop-unassigned")).toBeInTheDocument();
    expect(within(screen.getByTestId("desktop-breadcrumb")).getByText("未归属任务")).toBeInTheDocument();

    fireEvent.click(sidebar.getByRole("button", { name: "另一个工作空间" }));
    expect(await screen.findByTestId("desktop-project-overview")).toHaveTextContent("另一个工作空间");
  });

  it("shows main's real per-source status in S07 and repairs a missing path through the edit dialog", async () => {
    const projectOp = vi.fn(async (request: { op: string }) => {
      if (request.op === "list") return { ok: true, payload: { initialized: true, projects: [project] } };
      if (request.op === "associations") return { ok: true, payload: { roots, tasks: [{ taskId: TASK_ID, projectId: null, state: "unassigned" }] } };
      if (request.op === "verifySources") return { ok: true, payload: { projectId: PROJECT_ID, sources: [
        { id: REPO_ID, kind: "repository", status: "ok" },
        { id: DIR_ID, kind: "directory", status: "missing", error: "ENOENT" },
      ] } };
      return { ok: true, payload: {} };
    });
    window.pidock = bridge(projectOp);
    render(<App />);
    const overview = await screen.findByTestId("desktop-project-overview");
    // Bullet 4: the moved directory is a named per-source fact, not a broken card.
    expect(await within(overview).findByText("来源缺失")).toBeInTheDocument();
    expect(within(overview).getByText("路径可用")).toBeInTheDocument();
    expect(within(overview).getByText(/ENOENT/)).toBeInTheDocument();

    fireEvent.click(within(overview).getAllByRole("button", { name: "修复路径" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "编辑工作空间" });
    // The repair affordance opens the same S10 dialog on that exact row.
    expect(within(dialog).getByLabelText("目录路径 1")).toHaveFocus();
    expect(within(dialog).getByLabelText("目录路径 1")).toHaveValue("/private/docs");
  });

  it("keeps the S07 task table header aligned with its cells by sharing one column template", async () => {
    const projectOp = vi.fn(async (request: { op: string }) => {
      if (request.op === "list") return { ok: true, payload: { initialized: true, projects: [project] } };
      if (request.op === "associations") return { ok: true, payload: { roots, tasks: [{ taskId: TASK_ID, projectId: PROJECT_ID, state: "assigned" }] } };
      return { ok: true, payload: { projectId: PROJECT_ID, sources: [] } };
    });
    window.pidock = bridge(projectOp);
    render(<App />);
    const overview = await screen.findByTestId("desktop-project-overview");
    const header = await within(overview).findByRole("row");
    const row = (await within(overview).findByText("真实任务")).closest("li")!.querySelector("div")!;
    // Bullet 5: the header and the cells measure the same track list.
    const template = (element: Element) => element.className.split(/\s+/).filter((name) => name.startsWith("grid-cols-"));
    expect(template(header)).toEqual(template(row));
    expect(template(header)).toHaveLength(1);
  });

  it("names registry corruption and restores only from a valid backup after explicit confirmation", async () => {
    let healthy = false;
    const projectOp = vi.fn(async (request: { op: string }) => {
      if (request.op === "status") return { ok: true, payload: { initialized: true, primary: healthy ? "ok" : "missing", backup: "ok", recoverable: !healthy } };
      if (request.op === "recover") { healthy = true; return { ok: true, payload: { initialized: true, projects: [project] } }; }
      if (request.op === "list") return healthy
        ? { ok: true, payload: { initialized: true, projects: [project] } }
        : { ok: false, error: "项目注册表缺失，可从备份恢复" };
      return { ok: true, payload: { roots, tasks: [{ taskId: TASK_ID, projectId: PROJECT_ID, state: "assigned" }] } };
    });
    window.pidock = bridge(projectOp);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("项目注册表缺失，可从备份恢复");
    expect(await screen.findByTestId("registry-health")).toHaveTextContent("主文件 缺失 · 备份 可用；可显式从备份恢复");
    fireEvent.click(screen.getByRole("button", { name: "从备份恢复" }));
    // Explicit confirmation, then the named op with `confirmed: true` (main refuses it otherwise).
    expect(confirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(projectOp).toHaveBeenCalledWith({ op: "recover", confirmed: true }));
    expect(await screen.findByTestId("desktop-project-overview")).toBeInTheDocument();
  });

  it("fails closed when no backup can restore the registry", async () => {
    const projectOp = vi.fn(async (request: { op: string }) => {
      if (request.op === "status") return { ok: true, payload: { initialized: true, primary: "invalid", backup: "missing", recoverable: false } };
      if (request.op === "list") return { ok: false, error: "项目注册表内容损坏" };
      return { ok: true, payload: { roots, tasks: [] } };
    });
    window.pidock = bridge(projectOp);
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("项目注册表内容损坏");
    expect(await screen.findByTestId("registry-health")).toHaveTextContent("没有可用的恢复来源");
    expect(screen.queryByRole("button", { name: "从备份恢复" })).toBeNull();
  });
});
