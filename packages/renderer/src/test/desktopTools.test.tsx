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
  it("shows the Host task directory and selected worktree baseline without shortening their identities", async () => {
    const taskDir = "/tmp/" + "long-task-path/".repeat(20) + "task-1";
    const worktreePath = `${taskDir}/worktrees/primary`;
    const baseCommit = "0123456789abcdef0123456789abcdef01234567";
    bridge(async (_taskId, op) => op === "task/fileRoots" ? {
      ok: true, payload: { taskDir, roots: [{ id: "root-1", kind: "worktree", label: "primary", path: worktreePath, branch: "release/v2", baseCommit }] },
    } : { ok: true, payload: { tree: { attribution, path: "", entries: [], truncated: false } } });
    render(<DesktopToolDock taskId="task-1" tool="files" onClose={() => {}} />);
    expect(await screen.findByText(taskDir)).toBeInTheDocument();
    expect(screen.getByText(worktreePath)).toBeInTheDocument();
    expect(screen.getByText(baseCommit)).toBeInTheDocument();
    expect(screen.getByText("远程基线分支").nextElementSibling).toHaveTextContent("release/v2");
  });

  it("keeps metadata aligned with the selected root and does not invent shared-directory Git fields", async () => {
    const baseCommit = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
    bridge(async (_taskId, op, payload) => op === "task/fileRoots" ? {
      ok: true, payload: { taskDir: "/tmp/task-1", roots: [
        { id: "root-1", kind: "worktree", label: "primary", path: "/tmp/task-1/primary", branch: "release/v2", baseCommit },
        { id: "shared", kind: "shared-dir", label: "assets", path: "/tmp/task-1/assets", sourcePath: "/tmp/shared-assets" },
        { id: "root-2", kind: "worktree", label: "secondary", path: "/tmp/task-1/secondary" },
      ] },
    } : { ok: true, payload: { tree: { attribution: { ...attribution, rootId: payload["rootId"] }, path: "", entries: [], truncated: false } } });
    render(<DesktopToolDock taskId="task-1" tool="files" onClose={() => {}} />);
    expect(await screen.findByText(baseCommit)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /assets/ }));
    expect(screen.getByText("/tmp/task-1/assets")).toBeInTheDocument();
    expect(screen.queryByText("创建提交")).not.toBeInTheDocument();
    expect(screen.queryByText("远程基线分支")).not.toBeInTheDocument();
    expect(screen.queryByText(baseCommit)).not.toBeInTheDocument();
    expect(screen.queryByText("/tmp/task-1/primary")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "secondary" }));
    expect(screen.getByText("/tmp/task-1/secondary")).toBeInTheDocument();
    expect(screen.getByText("创建提交").nextElementSibling).toHaveTextContent("Host 未提供");
    expect(screen.getByText("远程基线分支").nextElementSibling).toHaveTextContent("Host 未提供");
    expect(screen.queryByText(baseCommit)).not.toBeInTheDocument();
    await screen.findByText("目录为空");
  });

  it("clears previous-task metadata while the next task is loading or refused", async () => {
    let resolveNext!: (value: unknown) => void;
    bridge(async (taskId, op) => {
      if (taskId === "task-2" && op === "task/fileRoots") return new Promise((resolve) => { resolveNext = resolve; });
      if (op === "task/fileRoots") return { ok: true, payload: { taskDir: "/tmp/task-1", roots: [{ id: "root-1", kind: "worktree", label: "primary", path: "/tmp/task-1/primary", baseCommit: "old-commit" }] } };
      return { ok: true, payload: { tree: { attribution, path: "", entries: [], truncated: false } } };
    });
    const { rerender } = render(<DesktopToolDock taskId="task-1" tool="files" onClose={() => {}} />);
    expect(await screen.findByText("old-commit")).toBeInTheDocument();
    rerender(<DesktopToolDock taskId="task-2" tool="files" onClose={() => {}} />);
    expect(screen.queryByText("/tmp/task-1")).not.toBeInTheDocument();
    expect(screen.queryByText("old-commit")).not.toBeInTheDocument();
    expect(screen.getByText("正在读取任务文件根…")).toBeInTheDocument();
    resolveNext({ ok: false, error: "new task refused" });
    expect(await screen.findByText("new task refused")).toBeInTheDocument();
    expect(screen.queryByText("任务目录")).not.toBeInTheDocument();
    expect(screen.queryByText("old-commit")).not.toBeInTheDocument();
  });

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

describe("[UI 对齐] S8 production protocol dock", () => {
  const state = (taskId: string) => ({
    state: {
      taskId, mode: "release", protocol: { repoDir: "", goGenDir: "", tsGenDir: "" },
      generatedVersion: null, generation: { runsGeneration: false, reason: "协议未改动：保留发布依赖", steps: [] },
      consumers: [], prepare: [{ state: "code-ready", label: "代码就绪", ok: false, detail: "尚未配置协议仓库" }],
      toolchain: { platform: "", ok: false, note: "未探测", entries: [] },
      switchAssessment: { blockers: [] }, diagnostics: [],
    },
  });

  it("shows only the selected task's real unplanned Host state, without planning a write", async () => {
    const taskOp = vi.fn(async (taskId: string, _op: string) => ({ ok: true, payload: state(taskId) }));
    bridge(taskOp);
    const { rerender } = render(<DesktopToolDock taskId="task-1" tool="protocol" onClose={() => {}} />);
    expect(await screen.findByText("实际生成版本：尚未生成")).toBeInTheDocument();
    expect(screen.getByText("协议仓库 未配置")).toBeInTheDocument();
    rerender(<DesktopToolDock taskId="task-2" tool="protocol" onClose={() => {}} />);
    expect(screen.queryByText("实际生成版本：尚未生成")).not.toBeInTheDocument();
    await waitFor(() => expect(taskOp).toHaveBeenCalledWith("task-2", "task/protocolState", {}));
    expect(taskOp.mock.calls.map((call) => call[1])).toEqual(["task/protocolState", "task/protocolState"]);
  });

  it("renders Host-reported consumer state without inventing a generated version", async () => {
    const base = state("task-1");
    const payload = { state: { ...base.state, protocol: { ...base.state.protocol, repoDir: "/tmp/task-1/apis" }, consumers: [{
      consumerId: "invoice", name: "invoice-service", language: "go", repoDir: "/tmp/task-1/invoice",
      releaseDependency: "github.com/example/apis v1", binding: { kind: "release", dependency: "github.com/example/apis v1" },
      staleness: { state: "ready", detail: "使用发布依赖" },
    }] } };
    bridge(async () => ({ ok: true, payload }));
    render(<DesktopToolDock taskId="task-1" tool="protocol" onClose={() => {}} />);
    expect(await screen.findByText(/invoice-service · Go · 就绪/)).toBeInTheDocument();
    expect(screen.getByText("实际生成版本：尚未生成")).toBeInTheDocument();
    expect(screen.getByText("使用发布依赖")).toBeInTheDocument();
  });

  it("shows Host refusal and malformed or foreign-task payloads as errors", async () => {
    const taskOp = vi.fn(async (): Promise<unknown> => ({ ok: false, error: "protocol read refused" }));
    bridge(taskOp);
    const { rerender } = render(<DesktopToolDock taskId="task-1" tool="protocol" onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("protocol read refused");
    taskOp.mockImplementation(async () => ({ ok: true, payload: state("another-task") }));
    rerender(<DesktopToolDock taskId="task-2" tool="protocol" onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Host 协议状态响应无法解析");
    expect(screen.queryByText("实际生成版本：尚未生成")).not.toBeInTheDocument();
    taskOp.mockImplementation(async () => ({ ok: true, payload: { state: { taskId: "task-3", mode: "release" } } }));
    rerender(<DesktopToolDock taskId="task-3" tool="protocol" onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Host 协议状态响应无法解析");
  });

  it("rejects a malformed local binding instead of presenting it as a release dependency", async () => {
    const base = state("task-1");
    const payload = { state: { ...base.state, mode: "local", consumers: [{
      consumerId: "invoice", name: "invoice-service", language: "go", repoDir: "/tmp/task-1/invoice",
      releaseDependency: "github.com/example/apis v1", binding: {},
      staleness: { state: "needs-binding", detail: "尚未绑定" },
    }] } };
    bridge(async () => ({ ok: true, payload }));
    render(<DesktopToolDock taskId="task-1" tool="protocol" onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Host 协议状态响应无法解析");
    expect(screen.queryByText(/发布依赖：github.com\/example/)).not.toBeInTheDocument();
  });

  it.each([
    { kind: "go-workspace", path: "/tmp/go.work", useDirectories: [], excludedConsumers: [], releaseManifestsUntouched: [] },
    { kind: "ts-link", linkPath: "/tmp/link", artifact: "/tmp/artifact", marker: "managed", restore: { program: "npm", args: [] } },
  ])("rejects local binding missing its nested Host fields ($kind)", async (binding) => {
    const base = state("task-1");
    const payload = { state: { ...base.state, mode: "local", consumers: [{
      consumerId: "invoice", name: "invoice-service", language: "go", repoDir: "/tmp/task-1/invoice",
      releaseDependency: "github.com/example/apis v1", binding,
      staleness: { state: "needs-binding", detail: "尚未绑定" },
    }] } };
    bridge(async () => ({ ok: true, payload }));
    render(<DesktopToolDock taskId="task-1" tool="protocol" onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Host 协议状态响应无法解析");
  });

  it("ignores an old task's late protocol response", async () => {
    let resolveOld!: (value: unknown) => void;
    const taskOp = vi.fn((taskId: string) => taskId === "task-1" ? new Promise<unknown>((resolve) => { resolveOld = resolve; }) : Promise.resolve({ ok: true, payload: state("task-2") }));
    bridge(taskOp);
    const { rerender } = render(<DesktopToolDock taskId="task-1" tool="protocol" onClose={() => {}} />);
    rerender(<DesktopToolDock taskId="task-2" tool="protocol" onClose={() => {}} />);
    expect(await screen.findByText("实际生成版本：尚未生成")).toBeInTheDocument();
    resolveOld({ ok: false, error: "old task failure" });
    await waitFor(() => expect(screen.queryByText("old task failure")).not.toBeInTheDocument());
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
