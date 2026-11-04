import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "../App";
import { memoryHost } from "../data/memoryHost";
import { desktopSummarySegments } from "../data/desktopShellSummary";
import type { PidockBridge } from "../data/shellBridge";

/**
 * [UI 对齐 S8a] #47: the production bottom summary bar.
 *
 * Prototype A's strip reads `<当前任务> · <运行中的服务数> · <浏览器控制者>`,
 * and the demo path renders all three. This slice adds the bar to the REAL
 * desktop route (`desktopMode()` → `DesktopInventory` → `DesktopShell`) with
 * the segments the shell can source for real, and nothing else: a `0 服务`
 * computed from "no read was made" is the fabrication the slice exists to stop.
 * The assertions below therefore pin the strip's own DOM text on that route,
 * not a testid's existence and not a demo render.
 */

const RENDERER_SRC = join(__dirname, "..");
const TASK_ID = "real-1";
const tasks = [{ taskId: TASK_ID, name: "真实任务", branch: "task/main", repoCount: 1, updatedAt: "2026-09-22" }];
const roots = [{ label: "默认任务根", state: "ready" as const }];
const project = {
  id: "bcedc870-22bd-474e-ac55-78d30a9d763d",
  name: "真实项目",
  description: "系统 A",
  repositories: [{ id: "dad5fcb4-c91f-4ab0-bc33-fbb82053f871", name: "Web", path: "/private/work/web" }],
  directories: [],
};

/** The production bridge the desktop route needs, with the lifecycle read named per case. */
function bridge(lifecycle: (taskId: string) => { ok: true; payload: unknown } | { ok: false; error: string }): PidockBridge {
  return {
    listTasks: vi.fn(async () => ({ ok: true, payload: { tasks, roots } })),
    importTaskRoot: vi.fn(async () => ({ ok: true, payload: { canceled: false, count: 1 } })),
    taskOp: vi.fn(async (taskId: string, op: string) => op === "task/sessionList" ? { ok: true, payload: { activeSessionId: "main", sessions: [{ id: "main", name: "主会话", archived: false, createdAt: "2026-01-01", updatedAt: "2026-01-01", permission: "default", binding: null }], provider: null } } : op === "task/lifecycleState"
      ? lifecycle(taskId)
      : { ok: true, payload: { lifecycle: { taskId, archived: false, archivedAt: null }, op } }),
    projectOp: vi.fn(async (request: { op: string }) => request.op === "list"
      ? { ok: true, payload: { initialized: true, projects: [project] } }
      : { ok: true, payload: { roots, tasks: [{ taskId: TASK_ID, projectId: project.id, state: "assigned" }] } }),
    sdkTurn: vi.fn(async (request: Record<string, unknown>) => ({ ok: true, payload: request.action === "subscribe"
      ? { taskId: TASK_ID, sessionId: "main", snapshot: { source: "sdk-jsonl", sessionId: "main", messages: [], pending: false, interrupted: false }, turn: null }
      : { unsubscribed: true } })),
    onSdkTurnEvent: vi.fn(() => vi.fn()),
  } as unknown as PidockBridge;
}

const verifiedLifecycle = (taskId: string) => ({ ok: true as const, payload: { lifecycle: { taskId, archived: false, archivedAt: null } } });

/** Open the first real task through 项目管理 → 进入工作区, the shipped production route. */
async function openRealTask() {
  await screen.findByTestId("desktop-project-overview");
  fireEvent.click(screen.getByRole("button", { name: "项目管理" }));
  fireEvent.click(await within(screen.getByRole("navigation", { name: "项目导航" })).findByRole("button", { name: project.name }));
  fireEvent.click(await screen.findByRole("button", { name: "进入工作区" }));
  fireEvent.click(await screen.findByRole("button", { name: "进入对话 · 主会话" }));
  await screen.findByTestId("desktop-conversation");
}


afterEach(() => {
  cleanup();
  delete window.pidock;
  vi.restoreAllMocks();
});

describe("Pencil workspace chrome", () => {
  it("removes the obsolete summary and workspace card while retaining the real task and no demo reads", async () => {
    const demoRead = vi.spyOn(memoryHost, "getWorkspace");
    window.pidock = bridge(verifiedLifecycle);
    render(<StrictMode><App /></StrictMode>);
    await openRealTask();
    expect(screen.queryByTestId("desktop-summary")).toBeNull();
    expect(screen.queryByTestId("desktop-workspace-card")).toBeNull();
    expect(await within(screen.getByTestId("desktop-sidebar")).findByRole("button", { name: "真实任务" })).toBeVisible();
    expect(demoRead).not.toHaveBeenCalled();
  });
});

describe("desktopSummarySegments", () => {
  it("names only what it was given, and never invents a count for an unverified lifecycle", () => {
    expect(desktopSummarySegments({ activeTaskCount: null, roots })).toEqual([
      { key: "tasks", label: "进行中的任务 · 未核验", title: "任务归档状态尚未核验完整，此处不给出计数" },
      { key: "roots", label: "任务根 1/1 就绪", title: "已读取全部 1 个任务根" },
    ]);
  });

  it("names a task or Project scope by its real reported name", () => {
    const [scope] = desktopSummarySegments({ scope: { kind: "task", name: "对账单详情" }, activeTaskCount: 2, roots });
    expect(scope).toEqual({ key: "scope", label: "对账单详情", title: "当前任务 · 对账单详情" });
  });

  it("produces no root segment when no root was read, instead of a 0/0 reassurance", () => {
    expect(desktopSummarySegments({ scope: { kind: "project", name: "Adder" }, activeTaskCount: 0, roots: [] })).toEqual([
      { key: "scope", label: "Adder", title: "当前项目 · Adder" },
      { key: "tasks", label: "进行中的任务 0", title: "已核验为未归档的任务 · 0" },
    ]);
  });

  it("names the readable roots it checked when one of them failed", () => {
    const segments = desktopSummarySegments({
      activeTaskCount: 1,
      roots: [{ state: "ready" }, { state: "error" }, { state: "error" }],
    });
    expect(segments[1]).toEqual({ key: "roots", label: "2 个任务根不可用", title: "2 个任务根读取失败，可在页头重试" });
  });
});

describe("production renderer graph (#47 carried dependency fix)", () => {
  /** Relative-import closure of one renderer entry, resolved on disk. */
  function importClosure(entry: string): string[] {
    const seen = new Set<string>();
    const queue = [join(RENDERER_SRC, entry)];
    while (queue.length > 0) {
      const file = queue.pop()!;
      const key = relative(RENDERER_SRC, file);
      if (seen.has(key)) continue;
      seen.add(key);
      const source = readFileSync(file, "utf8");
      for (const [, specifier] of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        if (!specifier.startsWith(".")) continue;
        const base = join(dirname(file), specifier);
        for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
          try {
            readFileSync(candidate);
            queue.push(candidate);
            break;
          } catch {
            // Not this extension; try the next candidate.
          }
        }
      }
    }
    return [...seen];
  }

  it("reaches no fixture module from the production tool dock", () => {
    const closure = importClosure("components/DesktopToolDock.tsx");
    // Sanity: the walk really resolved a graph, so an empty result cannot pass.
    expect(closure.length).toBeGreaterThan(10);
    expect(closure.filter((file) => file === "data/memoryHost.ts" || file === "stores/host.ts")).toEqual([]);
  });
});
