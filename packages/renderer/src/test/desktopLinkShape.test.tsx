/**
 * [PiDock 03] (#6 box 12) the link-shape report on the REAL desktop route.
 *
 * These tests render the production desktop entry (`App` → `DesktopInventory` →
 * `DesktopProjectOverview` → `SharedRepoIsolation`) with only the preload bridge
 * stubbed, and assert the shape readout is reachable from there — a readout
 * wired into the demo/`memoryHost` path only would show nothing here. The bridge
 * stub answers with the payload the Host really produces: the platform rows are
 * built by the shipped `linkCapabilityRows`, so the assertions below pin the
 * shipped record and not a fixture that could drift from it.
 *
 * The 真实 pi clause stays a NAMED boundary: this report is a Host observation
 * (`task/probeLink` → `lstat`/`readlink`), and Windows link behaviour is named
 * as unverified rather than asserted.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { App } from "../App";
import type { PidockBridge } from "../data/shellBridge";
import { workspaceLinkTargetFromHost } from "../data/workspaceFiles";
import { hostPlatformLabel } from "../../../shell/src/main/service-config.js";
import { LINK_MODEL_VERIFICATION_BOUNDARY, linkCapabilityRows } from "../../../shell/src/main/multi-repo-provision.js";

const TASK_ID = "real-1";
const LINK_ROOT = "dir-3f2a11bb";
const SOURCE_PATH = "/work/invoice-docs";

const project = { id: "bcedc870-22bd-474e-ac55-78d30a9d763d", name: "真实项目", description: "系统 A", repositories: [], directories: [] };
const tasks = [{ taskId: TASK_ID, name: "真实任务", branch: "task/main", repoCount: 0, updatedAt: "2026-09-22" }];
const roots = [{ label: "默认任务根", state: "ready" as const }];

/** The `task/probeLink` payload, with the shipped platform record and boundary. */
function probePayload(shape: string, detail: string) {
  return {
    shape,
    detail,
    lexical: "ok",
    linkTarget: null,
    linkTargetInTask: false,
    platforms: linkCapabilityRows(hostPlatformLabel()),
    modelBoundary: LINK_MODEL_VERIFICATION_BOUNDARY,
  };
}

function bridge(probe: () => Promise<unknown>): { bridge: PidockBridge; taskOp: ReturnType<typeof vi.fn> } {
  const taskOp = vi.fn(async (taskId: string, op: string) => {
    if (op === "task/fileRoots") {
      return { ok: true, payload: { taskDir: `/tasks/${taskId}`, roots: [
        { id: LINK_ROOT, kind: "shared-dir", label: "invoice-docs", path: `/tasks/${taskId}/${LINK_ROOT}`, sourcePath: SOURCE_PATH },
      ] } };
    }
    if (op === "task/probeLink") return probe();
    if (op === "task/fileDiff") return { ok: false, error: "plain-dir-no-diff: invoice-docs 是普通目录链接，修改影响原文件，不提供 Git 差异" };
    return { ok: true, payload: { lifecycle: { taskId, archived: false, archivedAt: null } } };
  });
  return {
    taskOp,
    bridge: {
      listTasks: async () => ({ ok: true, payload: { tasks, roots } }),
      taskOp,
      projectOp: async (request: { op: string }) => ({ ok: true, payload: request.op === "list"
        ? { initialized: true, projects: [project] }
        : { roots, tasks: [{ taskId: TASK_ID, projectId: project.id, state: "assigned" }] } }),
    } as unknown as PidockBridge,
  };
}

afterEach(() => { cleanup(); delete window.pidock; vi.restoreAllMocks(); });

describe("[PiDock 03] (#6 box 12) link-shape report on the desktop project page", () => {
  it("shows the Host's observed shape, the per-platform record and the named boundary from the real desktop route", async () => {
    const wired = bridge(async () => ({ ok: true, payload: probePayload("dangling", "链接目标不存在（跟随 1 跳后缺 /work/missing）") }));
    window.pidock = wired.bridge;
    render(<App />);

    // The production desktop page, not the demo shell.
    const overview = await screen.findByTestId("desktop-project-overview");
    expect(screen.queryByTestId("shell-sidebar")).not.toBeInTheDocument();
    const row = await within(overview).findByTestId("shared-dir-row");
    expect(within(row).getByTestId(`row-link-isolation-${TASK_ID}`)).toHaveTextContent("共享原目录，文件未隔离");
    expect(within(row).getByTestId(`row-link-isolation-${TASK_ID}`)).toHaveTextContent("不是独立副本");

    // The reader really travelled the production op, naming the Host's own source.
    expect(wired.taskOp).toHaveBeenCalledWith(TASK_ID, "task/probeLink", { sourcePath: SOURCE_PATH });

    // 失效 is its OWN named state, with the Host's reading shown verbatim.
    const shape = within(row).getByTestId(`row-link-shape-${TASK_ID}`);
    expect(shape).toHaveAttribute("data-shape", "dangling");
    expect(shape).toHaveTextContent("失效：链接目标已不存在");
    expect(shape).toHaveTextContent("/work/missing");
    expect(shape).not.toHaveTextContent("真实目录");

    // The platform record: this machine's platform exercised, win32 unverified by name.
    const platforms = within(row).getByTestId(`row-link-platforms-${TASK_ID}`);
    const here = platforms.querySelector(`li[data-platform="${hostPlatformLabel()}"]`);
    expect(here).toHaveAttribute("data-exercised", "true");
    expect(here).toHaveTextContent("已实测");
    const windows = platforms.querySelector('li[data-platform="win32-x64"]');
    expect(windows).toHaveAttribute("data-exercised", "false");
    expect(windows).toHaveTextContent("未实测");
    expect(windows).toHaveTextContent("win32 链接方式未验证");

    // The 真实 pi clause is stated as a boundary, never as a pass.
    expect(within(row).getByTestId(`row-link-model-boundary-${TASK_ID}`)).toHaveTextContent("不是真实 pi/模型运行");
    expect(within(row).getByTestId(`row-link-model-boundary-${TASK_ID}`)).toHaveTextContent("仍未完成");
  });

  it("names an unreadable probe as 未确定 and keeps the demo shell out of the picture", async () => {
    const wired = bridge(async () => ({ ok: false, error: "path-out-of-scope: 只探测本任务记录的普通目录来源" }));
    window.pidock = wired.bridge;
    render(<App />);
    const overview = await screen.findByTestId("desktop-project-overview");
    const row = await within(overview).findByTestId("shared-dir-row");
    const shape = within(row).getByTestId(`row-link-shape-${TASK_ID}`);
    expect(shape).toHaveAttribute("data-shape", "unread");
    expect(shape).toHaveTextContent("未确定");
    expect(shape).toHaveTextContent("path-out-of-scope");
    expect(shape).not.toHaveTextContent("真实目录");
    expect(within(row).getByTestId(`row-link-platforms-${TASK_ID}`)).toHaveTextContent("未取得 Host 链接探测记录");
    expect(within(row).queryByTestId(`row-link-model-boundary-${TASK_ID}`)).not.toBeInTheDocument();
    // The demo adapter never answered this page: no shape can come from fixtures.
    expect(wired.taskOp).toHaveBeenCalledWith(TASK_ID, "task/probeLink", { sourcePath: SOURCE_PATH });
  });
});

describe("[PiDock 03] (#6 box 12) link probe payload parsing", () => {
  it("drops a payload whose shape is not one the Host observes, instead of reading it as a directory", () => {
    expect(workspaceLinkTargetFromHost(probePayload("directory", "来源是真实目录: /work/invoice-docs"))).toMatchObject({ shape: "directory" });
    expect(workspaceLinkTargetFromHost(probePayload("ok", "来源可用"))).toBeUndefined();
    expect(workspaceLinkTargetFromHost(probePayload("dead", "普通目录来源不存在"))).toBeUndefined();
    expect(workspaceLinkTargetFromHost({ ...probePayload("directory", "来源是真实目录"), platforms: [] })).toBeUndefined();
    const withoutNote = probePayload("directory", "来源是真实目录");
    expect(workspaceLinkTargetFromHost({ ...withoutNote, platforms: [{ platform: "darwin-arm64", exercised: true }] })).toBeUndefined();
    expect(workspaceLinkTargetFromHost({ ...withoutNote, modelBoundary: undefined })).toBeUndefined();
  });
});
