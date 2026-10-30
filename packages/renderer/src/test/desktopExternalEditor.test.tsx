import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopToolDock } from "../components/DesktopToolDock";

// Seam: [PiDock 10] (#15 box 28) the renderer side of 从任务打开外部编辑器.
// The page names a task and one of that task's roots; the program comes from
// main's own user settings. These tests pin the two things the UI must not do:
// route the launch through the generic `taskOp` op set (where a page could name
// a program), and present anything other than the Host's own receipt/refusal.

const attribution = {
  taskId: "task-1",
  rootId: "repo-1",
  rootKind: "worktree" as const,
  rootLabel: "repo-1",
  piWorkDir: "/tmp/task-1",
};

const ROOTS_PAYLOAD = {
  taskDir: "/tmp/task-1",
  roots: [{ id: "repo-1", kind: "worktree", label: "repo-1", path: "/tmp/task-1/repo-1", baselineBranch: "task/task-1" }],
};

const launch = {
  rootId: "repo-1",
  rootKind: "worktree" as const,
  program: "/usr/local/bin/fake-editor",
  args: ["--new-window", "/tmp/task-1/repo-1"],
  cwd: "/tmp/task-1/repo-1",
  openedPath: "/tmp/task-1/repo-1",
  attribution,
  disclosure: "外部编辑器在任务工作副本打开：/tmp/task-1/repo-1（仓库 repo-1，分支 task/task-1）",
  note: "未读取、未写入也未复制任何编辑器配置（不生成 .vscode、launch.json、settings 或 tasks 文件）；编辑器自身窗口状态不在本工作台观察范围内；编辑器对文件的写入不受 PiDock 写协调约束，PiDock 不会因为它开着而暂停自己的写入",
  actor: "human" as const,
  label: "外部编辑器 repo-1（用户显式操作）",
  started: true as const,
  windowObserved: false as const,
  pid: 4711,
};

function bridge(handlers: {
  openTaskEditor?: ReturnType<typeof vi.fn>;
  taskOp?: (taskId: string, op: string, payload: Record<string, unknown>) => Promise<unknown>;
}) {
  window.pidock = {
    taskOp:
      handlers.taskOp ??
      (async (_taskId: string, op: string) =>
        op === "task/fileRoots"
          ? { ok: true, payload: ROOTS_PAYLOAD }
          : { ok: true, payload: { tree: { attribution, path: "", entries: [], truncated: false } } }),
    openTaskEditor: handlers.openTaskEditor,
  } as unknown as typeof window.pidock;
}

afterEach(() => {
  cleanup();
  delete (window as { pidock?: unknown }).pidock;
});

describe("#15 box 28 external editor from the file panel", () => {
  it("asks main for the configured editor with the task and root only, and shows the real receipt", async () => {
    const openTaskEditor = vi.fn(async () => ({
      ok: true,
      payload: { workspaceId: "w", taskId: "task-1", op: "task/openEditor", payload: { launch } },
    }));
    const taskOp = vi.fn(async (_taskId: string, op: string) =>
      op === "task/fileRoots"
        ? { ok: true, payload: ROOTS_PAYLOAD }
        : { ok: true, payload: { tree: { attribution, path: "", entries: [], truncated: false } } },
    );
    bridge({ openTaskEditor, taskOp });
    render(<DesktopToolDock taskId="task-1" tool="files" onClose={() => {}} />);

    // [#117 第 6 项 / #108] The boundary is on screen BEFORE the launch, not only
    // in the receipt: the editor's writes are not coordinated by PiDock.
    expect(await screen.findByTestId("dock-editor-coordination"))
      .toHaveTextContent("外部编辑器对文件的写入不受 PiDock 写协调约束；它开着期间 PiDock 不会暂停自己的写入");

    fireEvent.click(await screen.findByRole("button", { name: "用外部编辑器打开" }));

    await waitFor(() => expect(openTaskEditor).toHaveBeenCalledTimes(1));
    // The page can name the task and the root, and nothing else: no program,
    // no args, no path ever crosses this bridge.
    expect(openTaskEditor).toHaveBeenCalledWith({ taskId: "task-1", rootId: "repo-1" });
    // The launch never travels on the renderer's generic task-op route, which
    // is where a page could name a program.
    expect(taskOp.mock.calls.map((call) => call[1])).not.toContain("task/openEditor");

    expect(await screen.findByText("外部编辑器已启动（用户显式操作）")).toBeInTheDocument();
    expect(screen.getByText("/usr/local/bin/fake-editor")).toBeInTheDocument();
    expect(screen.getAllByText("/tmp/task-1/repo-1").length).toBeGreaterThan(0);
    expect(screen.getByText("4711")).toBeInTheDocument();
    expect(screen.getByText(launch.disclosure)).toBeInTheDocument();
    expect(screen.getByText(launch.note)).toBeInTheDocument();
  });

  it("shows the launch's own progress instead of the file-reading label while the launch is in flight", async () => {
    let release: (value: { ok: true; payload: unknown }) => void = () => {};
    const pending = new Promise<{ ok: true; payload: unknown }>((resolve) => {
      release = resolve;
    });
    bridge({ openTaskEditor: vi.fn(() => pending) });
    render(<DesktopToolDock taskId="task-1" tool="files" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "用外部编辑器打开" }));

    // A program launch is not a file read: the shared reading label must not
    // stand in for it.
    expect(await screen.findByText("正在启动外部编辑器…")).toBeInTheDocument();
    expect(screen.queryByText("读取中…")).not.toBeInTheDocument();

    release({ ok: true, payload: { workspaceId: "w", taskId: "task-1", op: "task/openEditor", payload: { launch } } });
    expect(await screen.findByText("外部编辑器已启动（用户显式操作）")).toBeInTheDocument();
    expect(screen.queryByText("正在启动外部编辑器…")).not.toBeInTheDocument();
  });

  it("shows the Host's named refusal instead of a launch", async () => {
    bridge({
      openTaskEditor: vi.fn(async () => ({
        ok: false,
        error: "editor-not-configured: 尚未配置外部编辑器程序，未启动任何程序；请在 /tmp/userData/external-editor.json 写入 {\"program\": \"/绝对路径/编辑器\"} 后重试",
      })),
    });
    render(<DesktopToolDock taskId="task-1" tool="files" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "用外部编辑器打开" }));
    expect(await screen.findByText(/editor-not-configured/)).toBeInTheDocument();
    expect(screen.getByText(/external-editor\.json/)).toBeInTheDocument();
    expect(screen.queryByText("外部编辑器已启动（用户显式操作）")).not.toBeInTheDocument();
  });

  it("treats a malformed launch receipt as an error, never as a successful launch", async () => {
    bridge({ openTaskEditor: vi.fn(async () => ({ ok: true, payload: { launch: { rootId: "repo-1" } } })) });
    render(<DesktopToolDock taskId="task-1" tool="files" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "用外部编辑器打开" }));
    expect(await screen.findByText("Host 外部编辑器响应无法解析")).toBeInTheDocument();
    expect(screen.queryByText("外部编辑器已启动（用户显式操作）")).not.toBeInTheDocument();
  });

  it("states that no editor configuration is written without a bridge entry (outside the desktop shell)", async () => {
    window.pidock = {
      taskOp: async (_taskId: string, op: string) =>
        op === "task/fileRoots"
          ? { ok: true, payload: ROOTS_PAYLOAD }
          : { ok: true, payload: { tree: { attribution, path: "", entries: [], truncated: false } } },
    } as unknown as typeof window.pidock;
    render(<DesktopToolDock taskId="task-1" tool="files" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "用外部编辑器打开" }));
    expect(await screen.findByText("当前不在桌面壳内，无法打开外部编辑器")).toBeInTheDocument();
  });
});
