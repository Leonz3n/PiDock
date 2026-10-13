import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "../App";
import type { PidockBridge } from "../data/shellBridge";

/**
 * [PiDock 03] (#6 box 12) 项目与来源的空名字.
 *
 * `parseDesktopProject` reads `name` and `description` with a type check only
 * (`typeof === "string"`, non-empty required for `id` alone), and `source()`
 * does the same for a repository/directory `name` and `path`. A blank one is
 * therefore a reachable Host payload, and it used to reach the DOM as an empty
 * heading, an empty sidebar button and an empty 仓库 row — an unnamed state
 * rendered as a name. Each site below must name its own absence instead, and a
 * real non-empty name must still render as itself.
 */

const PROJECT_ID = "bcedc870-22bd-474e-ac55-78d30a9d763d";
const TASK_ID = "real-1";
const tasks = [{ taskId: TASK_ID, name: "真实任务", branch: "task/main", repoCount: 1, updatedAt: "2026-09-22" }];
const roots = [{ label: "默认任务根", state: "ready" as const }];

function projectWith(name: string, description: string, source: { name: string; path: string }) {
  return {
    id: PROJECT_ID,
    name,
    description,
    repositories: [{ id: "dad5fcb4-c91f-4ab0-bc33-fbb82053f871", ...source }],
    directories: [],
  };
}

function bridge(project: ReturnType<typeof projectWith>, taskRows = tasks): PidockBridge {
  return {
    listTasks: vi.fn(async () => ({ ok: true, payload: { tasks: taskRows, roots } })),
    taskOp: vi.fn(async (taskId: string, op: string) => op === "task/lifecycleState"
      ? { ok: true, payload: { lifecycle: { taskId, archived: false, archivedAt: null } } }
      : { ok: true, payload: { op, root: `/tasks/${taskId}` } }),
    projectOp: vi.fn(async (request: { op: string }) => request.op === "list"
      ? { ok: true, payload: { initialized: true, projects: [project] } }
      : { ok: true, payload: { roots, tasks: [{ taskId: TASK_ID, projectId: project.id, state: "assigned" }] } }),
  } as unknown as PidockBridge;
}

afterEach(() => {
  cleanup();
  delete window.pidock;
  vi.restoreAllMocks();
});

describe("[PiDock 03] (#6 box 12) blank Project and source names", () => {
  it("names a blank name, description and source on the project overview instead of an empty heading", async () => {
    window.pidock = bridge(projectWith("", "", { name: "", path: "" }));
    render(<App />);
    const overview = await screen.findByTestId("desktop-project-overview");
    expect(within(overview).getByRole("heading", { name: "Host 未上报项目名称", level: 1 })).toBeInTheDocument();
    // The page's own intro is fixed copy; this Project's description is rendered
    // by the inventory's detail panel, covered below.
    expect(overview).not.toHaveTextContent("系统 A");
    // The source row: an empty name used to render as a nameless `▸` line.
    expect(overview).toHaveTextContent("Host 未上报来源名称");
    expect(overview).toHaveTextContent("Host 未上报来源路径");
  });

  it("names a blank name on the inventory's project button and 仓库 row", async () => {
    window.pidock = bridge(projectWith("", "", { name: "", path: "" }));
    render(<App />);
    await screen.findByTestId("desktop-project-overview");
    fireEvent.click(screen.getByRole("button", { name: "项目管理" }));
    const inventory = within(await screen.findByTestId("desktop-inventory"));
    // Sidebar button + detail heading: the blank name is named, never empty.
    fireEvent.click(inventory.getByRole("button", { name: "Host 未上报项目名称" }));
    expect(inventory.getAllByText("Host 未上报项目名称").length).toBeGreaterThanOrEqual(1);
    expect(inventory.getByText("Host 未上报项目说明")).toBeInTheDocument();
    expect(inventory.getByText("Host 未上报来源名称")).toBeInTheDocument();
    expect(inventory.getByText("Host 未上报来源路径")).toBeInTheDocument();
  });

  it("names a blank task branch and update time instead of a dangling separator", async () => {
    // `desktopInventory.ts:33` requires `taskId` and `name` to be non-empty but
    // type-checks (only) `branch` and `updatedAt`, so a blank one IS reachable.
    window.pidock = bridge(projectWith("真实项目", "系统 A", { name: "Web", path: "/private/work/web" }),
      [{ taskId: TASK_ID, name: "真实任务", branch: "", repoCount: 1, updatedAt: "" }]);
    render(<App />);
    const overview = await screen.findByTestId("desktop-project-overview");
    const card = await waitFor(() => {
      const element = overview.querySelector(`[data-overview-task="${TASK_ID}"]`);
      if (!element) throw new Error("任务行尚未渲染");
      return element as HTMLElement;
    });
    const branchLine = card.querySelectorAll("p")[0] as HTMLElement;
    // The exact line, so a trailing bare `· ` cannot hide behind the guard text.
    expect(branchLine.textContent).toBe("1 仓库 · Host 未上报分支");
    expect(card).toHaveTextContent("Host 未上报更新时间");
  });

  it("names a blank project name in the delete confirmation instead of an empty 「」 pair", async () => {
    window.pidock = bridge(projectWith("", "", { name: "Web", path: "/private/work/web" }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<App />);
    await screen.findByTestId("desktop-project-overview");
    fireEvent.click(screen.getByRole("button", { name: "项目管理" }));
    const inventory = within(await screen.findByTestId("desktop-inventory"));
    fireEvent.click(inventory.getByRole("button", { name: "Host 未上报项目名称" }));
    fireEvent.click(inventory.getByRole("button", { name: "删除" }));
    // The confirmation names the project it deletes; `project.name` alone is a
    // blank, so guessing which project is being removed was the reader's job.
    expect(confirm).toHaveBeenCalledWith("删除项目「Host 未上报项目名称」？关联任务必须先解绑或转移。");
  });

  it("names the blank project a reassignment list offers instead of an empty choice", async () => {
    const named = projectWith("真实项目", "系统 A", { name: "Web", path: "/private/work/web" });
    const blank = { ...projectWith("", "", { name: "Web", path: "/private/work/web" }), id: "3f8e1c02-77aa-4d1e-8b60-2a9c9d0f1b23" };
    window.pidock = {
      ...bridge(named),
      projectOp: vi.fn(async (request: { op: string }) => request.op === "list"
        ? { ok: true, payload: { initialized: true, projects: [named, blank] } }
        : { ok: true, payload: { roots, tasks: [{ taskId: TASK_ID, projectId: named.id, state: "assigned" }] } }),
    } as unknown as PidockBridge;
    render(<App />);
    await screen.findByTestId("desktop-project-overview");
    fireEvent.click(screen.getByRole("button", { name: "项目管理" }));
    const inventory = within(await screen.findByTestId("desktop-inventory"));
    fireEvent.click(inventory.getByRole("button", { name: "真实项目" }));
    // The task row's 目标项目 list offers the OTHER project; a blank name used to
    // be an empty, unreadable choice in that list.
    expect(await inventory.findByRole("option", { name: "Host 未上报项目名称" })).toBeInTheDocument();
  });

  it("still renders the real project and source names this payload carried", async () => {
    window.pidock = bridge(projectWith("真实项目", "系统 A", { name: "Web", path: "/private/work/web" }));
    render(<App />);
    const overview = await screen.findByTestId("desktop-project-overview");
    expect(within(overview).getByRole("heading", { name: "真实项目", level: 1 })).toBeInTheDocument();
    expect(overview).toHaveTextContent("Web");
    expect(overview).toHaveTextContent("/private/work/web");
    expect(overview).not.toHaveTextContent("Host 未上报");
  });
});
