import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopToolDock } from "../components/DesktopToolDock";

const attribution = {
  taskId: "task-1",
  rootId: "root-1",
  rootKind: "worktree" as const,
  rootLabel: "primary",
  piWorkDir: "/tmp/task-1",
};

const bridge = (taskOp: (taskId: string, op: string, payload: Record<string, unknown>) => Promise<unknown>) => {
  window.pidock = { taskOp } as unknown as typeof window.pidock;
};

afterEach(() => {
  cleanup();
  delete (window as { pidock?: unknown }).pidock;
});

describe("[UI 对齐] S8d production tool dock", () => {
  it("renders real roots and a real tree, and opens a real preview", async () => {
    const calls: string[] = [];
    const taskOp = vi.fn(async (_taskId: string, op: string, payload: Record<string, unknown>) => {
      calls.push(op);
      if (op === "task/fileRoots") {
        return {
          ok: true,
          payload: {
            taskDir: "/tmp/task-1",
            roots: [{ id: "root-1", kind: "worktree", label: "primary", path: "/tmp/task-1/worktrees/primary", branch: "main" }],
          },
        };
      }
      if (op === "task/fileTree") {
        return {
          ok: true,
          payload: {
            tree: {
              attribution,
              path: typeof payload["relative"] === "string" ? payload["relative"] : "",
              entries: [{ name: "README.md", path: "README.md", kind: "file", size: 12 }],
              truncated: false,
            },
          },
        };
      }
      if (op === "task/filePreview") {
        return { ok: true, payload: { preview: { attribution, path: "README.md", language: "markdown", source: "# 真实内容", truncated: false, lineCount: 1 } } };
      }
      return { ok: false, error: `unexpected ${op}` };
    });
    bridge(taskOp);
    render(<DesktopToolDock taskId="task-1" tool="files" onClose={() => {}} />);
    expect(await screen.findByText("primary")).toBeInTheDocument();
    fireEvent.click(await screen.findByText("README.md"));
    expect(await screen.findByText("# 真实内容")).toBeInTheDocument();
    expect(calls).toEqual(["task/fileRoots", "task/fileTree", "task/filePreview"]);
  });

  it("shows the Host refusal instead of sample rows when an op fails", async () => {
    bridge(async () => ({ ok: false, error: "文件根不可用：任务未绑定工作树" }));
    render(<DesktopToolDock taskId="task-1" tool="files" onClose={() => {}} />);
    expect(await screen.findByText("文件根不可用：任务未绑定工作树")).toBeInTheDocument();
    expect(screen.queryByText("README.md")).not.toBeInTheDocument();
  });

  it("treats a malformed Host payload as an error, never as empty success", async () => {
    bridge(async (_taskId, op) => (op === "task/fileRoots" ? { ok: true, payload: { roots: [{ id: "root-1" }] } } : { ok: true, payload: {} }));
    render(<DesktopToolDock taskId="task-1" tool="files" onClose={() => {}} />);
    expect(await screen.findByText("Host 文件根响应无法解析")).toBeInTheDocument();
  });

  it("states that the Host owns no real pty yet and still shows the real plan", async () => {
    const taskOp = vi.fn(async (_taskId: string, op: string) => {
      if (op === "task/terminalState") return { ok: true, payload: { spawnImplemented: false, instances: [] } };
      if (op === "task/fileRoots") return { ok: true, payload: { taskDir: "/tmp/task-1", roots: [{ id: "root-1", kind: "worktree", label: "primary", path: "/tmp/task-1" }] } };
      if (op === "task/planTerminal") {
        return {
          ok: true,
          payload: {
            plan: {
              instanceId: "term-task-1-1",
              rootId: "root-1",
              attribution,
              program: "bash",
              args: ["-l"],
              cwd: "/tmp/task-1/worktrees/primary",
              cols: 80,
              rows: 24,
              resolved: [{ key: "PATH", value: "/usr/bin", source: "base", secret: false }],
              historyLimit: 200,
              owner: { taskId: "task-1", sessionId: null, label: "human" },
            },
          },
        };
      }
      return { ok: false, error: `unexpected ${op}` };
    });
    bridge(taskOp);
    render(<DesktopToolDock taskId="task-1" tool="terminal" onClose={() => {}} />);
    expect(await screen.findByTestId("dock-terminal-plan-only")).toBeInTheDocument();
    fireEvent.click(await screen.findByText("primary"));
    expect(await screen.findByTestId("dock-terminal-plan")).toBeInTheDocument();
    expect(screen.getByText("bash -l")).toBeInTheDocument();
  });

  it("surfaces a failed terminal plan and keeps 未接线 tools out of the Host path", async () => {
    const taskOp = vi.fn(async (_taskId: string, op: string) => {
      if (op === "task/terminalState") return { ok: true, payload: { spawnImplemented: false, instances: [] } };
      if (op === "task/fileRoots") return { ok: true, payload: { taskDir: "/tmp/task-1", roots: [{ id: "root-1", kind: "worktree", label: "primary", path: "/tmp/task-1" }] } };
      return { ok: false, error: "read-only-session: 只读会话不能申请终端" };
    });
    bridge(taskOp);
    render(<DesktopToolDock taskId="task-1" tool="terminal" onClose={() => {}} />);
    fireEvent.click(await screen.findByText("primary"));
    await waitFor(() => expect(screen.getByText("read-only-session: 只读会话不能申请终端")).toBeInTheDocument());
    expect(screen.queryByTestId("dock-terminal-plan")).not.toBeInTheDocument();
  });
});

describe("[UI 对齐] S8d Host envelope unwrapping", () => {
  it("unwraps the Host envelope main relays inside its own payload", async () => {
    const taskOp = vi.fn(async () => ({
      ok: true,
      payload: { workspaceId: "ws", taskId: "task-1", op: "task/fileRoots", payload: { taskDir: "/tmp/task-1", roots: [{ id: "root-1", kind: "worktree", label: "primary", path: "/tmp/task-1" }] } },
    }));
    bridge(taskOp);
    render(<DesktopToolDock taskId="task-1" tool="files" onClose={() => {}} />);
    expect(await screen.findByText("primary")).toBeInTheDocument();
  });

  it("keeps a plain payload that happens to carry no Host envelope", async () => {
    const taskOp = vi.fn(async () => ({ ok: true, payload: { taskDir: "/tmp/task-1", roots: [] } }));
    bridge(taskOp);
    render(<DesktopToolDock taskId="task-1" tool="files" onClose={() => {}} />);
    expect(await screen.findByText("本任务没有可读取的文件根")).toBeInTheDocument();
  });
});
