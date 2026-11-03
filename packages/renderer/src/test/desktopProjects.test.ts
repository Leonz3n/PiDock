import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BRANCH_TEMPLATE, loadDesktopProjects, parseDesktopProject, projectDeleteBlockers, projectDraft,
  projectOperation, projectRegistryHealth, recoverProjectRegistry, verifyProjectSources } from "../data/desktopProjects";
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
  it("surfaces the parsed registry initialization state instead of defaulting it", async () => {
    const bridge = fixture();
    bridge.projectOp = vi.fn(async (request) => ({ ok: true, payload: request.op === "list"
      ? { initialized: false, projects: [] }
      : { roots, tasks: [{ taskId: "task-real", projectId: null, state: "unassigned" }] } }));
    await expect(loadDesktopProjects(bridge)).resolves.toMatchObject({ projectsInitialized: false });
    await expect(loadDesktopProjects(fixture())).resolves.toMatchObject({ projectsInitialized: true });
  });
});

describe("workspace settings and registry health at the trust boundary", () => {
  const project = (extra: Record<string, unknown> = {}) => ({ id: "bcedc870-22bd-474e-ac55-78d30a9d763d", name: "PiDock",
    description: "", repositories: [{ id: "dad5fcb4-c91f-4ab0-bc33-fbb82053f871", name: "web", path: "/w/web" }], directories: [], ...extra });
  const shell = (payloads: Record<string, unknown>): PidockBridge => ({ projectOp: vi.fn(async (request) => ({ ok: true, payload: payloads[request.op] })) });

  it("reads environment variables and the branch template, and marks a Host that omits them as unreported", () => {
    const withSettings = parseDesktopProject(project({ environment: [{ key: "NODE_ENV", value: "development" }], branchTemplate: "feature/{task-name}" }));
    expect(withSettings.environment).toEqual([{ key: "NODE_ENV", value: "development" }]);
    expect(withSettings.branchTemplate).toBe("feature/{task-name}");
    const bare = parseDesktopProject(project());
    expect(bare.environment).toBeNull();
    expect(bare.branchTemplate).toBeNull();
    expect(() => parseDesktopProject(project({ environment: [{ key: "A", value: "b", extra: 1 }] }))).toThrow("项目记录返回异常");
    expect(() => parseDesktopProject(project({ branchTemplate: 4 }))).toThrow("项目记录返回异常");
    expect(() => parseDesktopProject(project({ unknown: true }))).toThrow("项目记录返回异常");
  });

  it("edits start from the Host's settings while a new workspace starts with none", () => {
    expect(projectDraft()).toMatchObject({ name: "", description: "", repositories: [], directories: [], environment: [], branchTemplate: DEFAULT_BRANCH_TEMPLATE });
    const stored = parseDesktopProject(project({ environment: [{ key: "A", value: "1" }], branchTemplate: "pi/{task-name}" }));
    expect(projectDraft(stored)).toEqual({ name: "PiDock", description: "",
      repositories: [{ id: "dad5fcb4-c91f-4ab0-bc33-fbb82053f871", name: "web", path: "/w/web" }], directories: [],
      environment: [{ key: "A", value: "1" }], branchTemplate: "pi/{task-name}" });
  });

  it("parses per-source verification and refuses a status it does not know", async () => {
    const bridge = shell({ verifySources: { projectId: project().id, sources: [
      { id: "a", kind: "repository", status: "ok" },
      { id: "b", kind: "directory", status: "missing", error: "EACCES" }] } });
    const report = await verifyProjectSources(bridge, project().id);
    expect(report.sources).toEqual([{ id: "a", kind: "repository", status: "ok" }, { id: "b", kind: "directory", status: "missing", error: "EACCES" }]);
    expect(bridge.projectOp).toHaveBeenCalledWith({ op: "verifySources", projectId: project().id });
    await expect(verifyProjectSources(shell({ verifySources: { projectId: project().id, sources: [{ id: "a", kind: "repository", status: "gone" }] } }), project().id))
      .rejects.toThrow("来源状态返回异常");
  });

  it("parses registry health and requests recovery only with explicit confirmation", async () => {
    const health = { initialized: false, primary: "invalid", backup: "ok", recoverable: true };
    await expect(projectRegistryHealth(shell({ status: health }))).resolves.toEqual(health);
    await expect(projectRegistryHealth(shell({ status: { initialized: false, primary: "broken", backup: "ok", recoverable: true } })))
      .rejects.toThrow("项目注册表状态返回异常");
    const bridge = shell({ recover: { initialized: true, projects: [] } });
    await recoverProjectRegistry(bridge);
    expect(bridge.projectOp).toHaveBeenCalledWith({ op: "recover", confirmed: true });
  });

  it("lists delete blockers with their association state", async () => {
    const bridge = shell({ blockers: { projectId: project().id, tasks: [{ taskId: "task-real", state: "assigned" }] } });
    await expect(projectDeleteBlockers(bridge, project().id)).resolves.toEqual({ projectId: project().id, tasks: [{ taskId: "task-real", state: "assigned" }] });
    expect(bridge.projectOp).toHaveBeenCalledWith({ op: "blockers", projectId: project().id });
    await expect(projectDeleteBlockers(shell({ blockers: { projectId: project().id, tasks: [{ taskId: "task-real", state: "unknown" }] } }), project().id))
      .rejects.toThrow("任务归属返回异常");
  });
});
