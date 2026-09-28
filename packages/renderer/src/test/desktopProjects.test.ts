import { describe, expect, it, vi } from "vitest";
import { loadDesktopProjects, projectOperation } from "../data/desktopProjects";
import type { PidockBridge } from "../data/shellBridge";

const roots = [{ label: "默认任务根", state: "ready" }];
const task = { taskId: "task-real", name: "Persistent", branch: "main", repoCount: 0, updatedAt: "2026-09-22" };
function fixture(association = { taskId: "task-real", projectId: null as string | null, state: "unassigned" }) {
  return { listTasks: vi.fn(async () => ({ ok: true, payload: { roots, tasks: [task] } })), projectOp: vi.fn(async (request) => ({ ok: true, payload: request.op === "list" ? { initialized: true, projects: [] } : { roots, tasks: [association] } })) } satisfies PidockBridge;
}

describe("Desktop Project trust boundary", () => {
  it("requires all main-backed reads; empty registry does not synthesize a project", async () => {
    const bridge = fixture();
    await expect(loadDesktopProjects(bridge)).resolves.toMatchObject({ projects: [], associations: [{ state: "unassigned" }] });
    expect(bridge.projectOp).toHaveBeenCalledWith({ op: "list" });
    expect(bridge.projectOp).toHaveBeenCalledWith({ op: "associations" });
    await expect(loadDesktopProjects({ listTasks: bridge.listTasks })).rejects.toThrow("项目接口不可用");
  });
  it("rejects malformed or inconsistent associations, including unknown project IDs", async () => {
    await expect(loadDesktopProjects(fixture({ taskId: "task-real", projectId: "81dccaa0-4da7-41a5-bdcc-1a750614b53b", state: "assigned" }))).rejects.toThrow("清单不一致");
    await expect(loadDesktopProjects(fixture({ taskId: "other", projectId: null, state: "unassigned" }))).rejects.toThrow("清单不一致");
    const bridge = fixture();
    bridge.projectOp = vi.fn(async () => ({ ok: true, payload: { initialized: true, projects: [] } }));
    await expect(loadDesktopProjects(bridge)).rejects.toThrow("返回异常");
  });
  it("keeps bridge errors and denied writes visible", async () => {
    await expect(projectOperation({}, { op: "create", input: {} })).rejects.toThrow("项目接口不可用");
    await expect(projectOperation({ projectOp: vi.fn(async () => ({ ok: false, error: "project has associated tasks" })) }, { op: "delete", projectId: "81334064-ffea-4415-b03c-c2784b16a749" })).rejects.toThrow("project has associated tasks");
    await expect(loadDesktopProjects({ listTasks: vi.fn(async () => ({ ok: false, error: "任务根损坏" })) })).rejects.toThrow("任务根损坏");
  });
});
