import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "../App";
import { memoryHost } from "../data/memoryHost";
import { desktopSummarySegments } from "../data/desktopShellSummary";
import { DesktopShell } from "../components/DesktopShell";
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
    taskOp: vi.fn(async (taskId: string, op: string) => op === "task/lifecycleState"
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
  fireEvent.click(await screen.findByRole("button", { name: project.name }));
  fireEvent.click(await screen.findByRole("button", { name: "进入工作区" }));
  await screen.findByTestId("desktop-conversation");
}

const strip = () => screen.getByTestId("desktop-summary");

afterEach(() => {
  cleanup();
  delete window.pidock;
  vi.restoreAllMocks();
});

describe("[UI 对齐 S8a] production bottom summary bar", () => {
  it("reads the current task, the verified task count and the real task roots on the desktop route", async () => {
    window.pidock = bridge(verifiedLifecycle);
    render(<StrictMode><App /></StrictMode>);
    await openRealTask();

    // The bar is on the production shell, not the demo `Shell`.
    expect(screen.getByTestId("desktop-shell")).toBeInTheDocument();
    expect(screen.queryByTestId("shell-sidebar")).toBeNull();
    expect(within(strip()).getByText("真实任务")).toBeInTheDocument();
    await waitFor(() => expect(within(strip()).getByText("进行中的任务 1")).toBeInTheDocument());
    expect(within(strip()).getByText("任务根 1/1 就绪")).toBeInTheDocument();
  });

  it("renders no segment for a readout the shell does not have — no fabricated 0 服务", async () => {
    window.pidock = bridge(verifiedLifecycle);
    render(<StrictMode><App /></StrictMode>);
    await openRealTask();

    // Prototype A's other two state elements are unreadable from the shell: the
    // task's services live in its own tool dock (`task/serviceRunRecords`), the
    // browser owner in the page main owns. Neither may be replaced by a value.
    const text = strip().textContent ?? "";
    expect(text).not.toMatch(/服务/);
    expect(text).not.toMatch(/浏览器|未打开|接管/);
    expect(text).not.toMatch(/\d+\s*服务/);
    expect(text).not.toContain("—");
    // The one count the shell does read is a verified number, not a zero-filler.
    await waitFor(() => expect(text).toContain("进行中的任务 1"));
  });

  it("reads an unverified lifecycle as 未核验 instead of a zero count", async () => {
    window.pidock = bridge(() => ({ ok: false, error: "任务归档状态读取失败" }));
    render(<StrictMode><App /></StrictMode>);
    await screen.findByTestId("desktop-project-overview");

    await waitFor(() => expect(within(strip()).getByText("进行中的任务 · 未核验")).toBeInTheDocument());
    expect(within(strip()).queryByText(/进行中的任务 0/)).toBeNull();
    // The sidebar states the same condition; a disagreement here is a defect.
    await waitFor(() => expect(within(screen.getByTestId("desktop-sidebar")).getByText("未核验")).toBeInTheDocument());
  });

  it("renders the bar on the real route without touching the demo fixture", async () => {
    const demoRead = vi.spyOn(memoryHost, "getWorkspace");
    const demoCreate = vi.spyOn(memoryHost, "createTask");
    const demoSend = vi.spyOn(memoryHost, "sendMessage");
    window.pidock = bridge(verifiedLifecycle);
    render(<StrictMode><App /></StrictMode>);
    await openRealTask();
    await waitFor(() => expect(within(strip()).getByText("进行中的任务 1")).toBeInTheDocument());

    expect(demoRead).not.toHaveBeenCalled();
    expect(demoCreate).not.toHaveBeenCalled();
    expect(demoSend).not.toHaveBeenCalled();
    expect(strip().textContent).not.toMatch(/Atlas|演示/);
  });

  it("keeps the strip's own sources out of the demo fixture graph", () => {
    // The demo bar reads `stores/host`; the production strip must not reach it,
    // directly or through the shell it renders in.
    const files = ["data/desktopShellSummary.ts", "components/DesktopShell.tsx"];
    const offenders = files.flatMap((file) => {
      const source = readFileSync(join(RENDERER_SRC, file), "utf8");
      return [/from\s+["'`][^"'`]*stores\/host["'`]/, /from\s+["'`][^"'`]*data\/memoryHost["'`]/, /from\s+["'`][^"'`]*ShellSummaryBar["'`]/]
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${file}: ${pattern}`);
    });
    expect(offenders).toEqual([]);
  });

  it("hides the state segments at the mid tier and lets the name truncate instead of widening the column", () => {
    render(
      <DesktopShell
        view={{ view: "task", taskId: TASK_ID }}
        onNavigate={vi.fn()}
        projects={[{ id: project.id, name: project.name, description: project.description }]}
        tasks={tasks.map((task) => ({ ...task, projectId: project.id }))}
        allTaskCount={tasks.length}
        lifecyclePending={false}
        lifecycleErrors={[]}
        roots={roots}
        rootRetry={{ busy: false, pending: false, error: null, run: vi.fn() }}
        breadcrumb={{ project: project.name, task: "对账单详情·任务A" }}
      >
        <p>内容</p>
      </DesktopShell>,
    );

    const bar = strip();
    const tiers = (className: string) => className.split(/\s+/);
    // The prototype drops its whole state line at 960 (`style.css`:
    // `.switcher .state{display:none}`); jsdom has no layout engine, so the
    // contract that produced that tier is asserted here and the geometry itself
    // stays a named boundary (real-Electron capture).
    expect(tiers(within(bar).getByText("真实任务").className)).toEqual(expect.arrayContaining(["min-w-0", "truncate"]));
    for (const label of ["进行中的任务 1", "任务根 1/1 就绪"]) {
      expect(tiers(within(bar).getByText(label).className)).toContain("below-mid:hidden");
    }
    // A long name must not widen the strip past its column, and the strip must
    // not hold a fixed width (`shrink-0`) while its column shrinks.
    expect(tiers(bar.className)).toEqual(expect.arrayContaining(["min-w-0", "max-w-full", "overflow-hidden", "whitespace-nowrap"]));
    expect(tiers(bar.className)).not.toContain("shrink-0");
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
