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

const SERVICE_ID = "s-11111111-1111-1111-1111-111111111111";
const OTHER_SERVICE_ID = "s-22222222-2222-2222-2222-222222222222";

type PanelBridgeOptions = {
  association?: unknown;
  templates?: unknown;
  bindings?: unknown;
  statuses?: (serviceId: string) => unknown;
  logs?: (serviceId: string) => unknown;
  browser?: (request: Record<string, unknown>) => unknown;
};

function panelBridge(options: PanelBridgeOptions = {}) {
  const taskOp = vi.fn(async (_taskId: string, op: string, payload: Record<string, unknown>) => {
    if (op === "task/serviceStatus") return options.statuses ? options.statuses(String(payload["serviceId"])) : { ok: false, error: "unexpected task/serviceStatus" };
    if (op === "task/serviceLog") return options.logs ? options.logs(String(payload["serviceId"])) : { ok: false, error: "unexpected task/serviceLog" };
    if (op === "task/browserAction") {
      const request = payload as Record<string, unknown>;
      if (!options.browser) return { ok: false, error: "unexpected task/browserAction" };
      return options.browser(request);
    }
    return { ok: false, error: `unexpected ${op}` };
  });
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => {
    if (request["op"] === "taskBindings") return { ok: true, payload: options.bindings ?? [{
      taskId: "task-1", serviceId: SERVICE_ID, templateVersion: 2, rootId: "invoice-service", subdir: "apps/svc", privateKeys: ["API_TOKEN"],
    }] };
    if (request["op"] === "list") return { ok: true, payload: options.templates ?? [{
      projectId: "project-1", serviceId: SERVICE_ID, version: 2, sharedKeys: ["PORT"],
      descriptor: { name: "invoice-local", program: "node", args: ["server.js"], ports: [4100], runType: "long-lived" },
    }] };
    return { ok: false, error: `unexpected serviceCatalogOp ${String(request["op"])}` };
  });
  const projectOp = vi.fn(async () => ({ ok: true, payload: options.association ?? { roots: [], tasks: [{ taskId: "task-1", projectId: "project-1", state: "assigned" }] } }));
  const pidge = { taskOp, serviceCatalogOp, projectOp } as unknown as typeof window.pidock;
  window.pidock = pidge;
  return { taskOp, serviceCatalogOp, projectOp };
}

describe("[UI 对齐] S8d 运行 panel (real Host bindings and status)", () => {
  it("renders the task's real bound service, its template descriptor and the Host's own state", async () => {
    const fixture = panelBridge({ statuses: () => ({ ok: true, payload: { service: {
      serviceId: SERVICE_ID, state: "running", ownerSessionId: null, busy: false, closing: false, retainedRights: null, executionAvailable: false,
    } } }) });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    expect(await screen.findByText("invoice-local")).toBeInTheDocument();
    expect(screen.getByText("运行中 · Host 未接管进程")).toBeInTheDocument();
    expect(screen.getByText(/127\.0\.0\.1:4100/)).toBeInTheDocument();
    expect(screen.getByText(/绑定 v2 · invoice-service\/apps\/svc/)).toBeInTheDocument();
    expect(screen.getByText(/私有引用 1 项/)).toBeInTheDocument();
    expect(screen.getByText("本任务服务 · 1")).toBeInTheDocument();
    expect(fixture.serviceCatalogOp).toHaveBeenCalledWith({ op: "taskBindings", projectId: "project-1", taskId: "task-1" });
  });

  it("keeps service start/stop, local/remote, remote dependencies and routing explicitly 未接线", async () => {
    panelBridge({ statuses: () => ({ ok: true, payload: { service: {
      serviceId: SERVICE_ID, state: "running", ownerSessionId: null, busy: false, closing: false, retainedRights: null, executionAvailable: false,
    } } }) });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    await screen.findByText("invoice-local");
    const control = screen.getByTestId("desktop-tool-dock").querySelector('[data-unwired="service-control"]')!;
    expect(control).toHaveTextContent("未接线");
    expect(control.querySelector("button")).toBeDisabled();
    expect(screen.getByTestId("desktop-tool-dock").querySelector('[data-unwired="service-mode"]')).toHaveTextContent("未接线");
    expect(screen.getByTestId("desktop-tool-dock").querySelector('[data-unwired="remote-deps"]')).toHaveTextContent("未接线");
    expect(screen.getByTestId("desktop-tool-dock").querySelector('[data-unwired="routing"]')).toHaveTextContent("未接线");
    expect(screen.queryByRole("button", { name: /启动/ })).toBeDisabled();
  });

  it("shows the Host refusal for a status read instead of a fabricated stopped state", async () => {
    panelBridge({ statuses: () => ({ ok: false, error: "unknown-service: not registered on this task" }) });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    expect(await screen.findByText("unknown-service: not registered on this task")).toBeInTheDocument();
    expect(screen.queryByText("已停止")).not.toBeInTheDocument();
  });

  it("states that an unassigned task has no project-scoped binding instead of listing zero services", async () => {
    const fixture = panelBridge({ association: { roots: [], tasks: [{ taskId: "task-1", projectId: null, state: "unassigned" }] } });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    expect(await screen.findByTestId("dock-runtime-unassigned")).toHaveTextContent("尚未由用户确认归属项目");
    expect(screen.queryByTestId("dock-service-rows")).not.toBeInTheDocument();
    expect(fixture.taskOp).not.toHaveBeenCalled();
  });

  it("renders an unavailable association as its own state instead of calling the task unassigned", async () => {
    panelBridge({ association: { roots: [], tasks: [{ taskId: "task-1", projectId: null, state: "unavailable" }] } });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    const note = await screen.findByTestId("dock-runtime-unavailable");
    expect(note).toHaveAttribute("data-association-state", "unavailable");
    expect(note).toHaveTextContent("归属状态暂不可用");
    expect(note).not.toHaveTextContent("尚未由用户确认归属项目");
    expect(screen.queryByTestId("dock-runtime-unassigned")).not.toBeInTheDocument();
  });

  it("labels the recipe-declared port as 配方声明端口 instead of a runtime address", async () => {
    panelBridge({ statuses: () => ({ ok: true, payload: { service: {
      serviceId: SERVICE_ID, state: "running", ownerSessionId: null, busy: false, closing: false, retainedRights: null, executionAvailable: false,
    } } }) });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    expect(await screen.findByText("配方声明端口")).toBeInTheDocument();
    expect(screen.getByText("127.0.0.1:4100")).toBeInTheDocument();
    expect(screen.getByText("配方声明端口").closest("p")).toHaveTextContent(/配方声明端口 · 127\.0\.0\.1:4100/);
  });

  it("keeps the prototype's 配置 entry and 代码工作副本 list as explicit 未接线, not dropped", async () => {
    panelBridge({ statuses: () => ({ ok: true, payload: { service: {
      serviceId: SERVICE_ID, state: "running", ownerSessionId: null, busy: false, closing: false, retainedRights: null, executionAvailable: false,
    } } }) });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    await screen.findByText("invoice-local");
    const dock = screen.getByTestId("desktop-tool-dock");
    const config = dock.querySelector('[data-unwired="runtime-config"]')!;
    expect(config).toHaveTextContent("未接线");
    expect(config.querySelector("button")).toBeDisabled();
    expect(dock.querySelector('[data-unwired="runtime-worktrees"]')).toHaveTextContent("未接线");
  });

  it("treats malformed binding and status payloads as unreadable, never as an empty service list", async () => {
    panelBridge({ bindings: [{ taskId: "task-1", serviceId: "not-a-service-id" }] });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Host 任务服务绑定响应无法解析");
    expect(screen.queryByText("本任务还没有绑定服务。绑定属于项目服务配方，不在此处新建。")).not.toBeInTheDocument();
    cleanup();
    panelBridge({ statuses: () => ({ ok: true, payload: { service: { serviceId: SERVICE_ID, state: "teleporting" } } }) });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    expect(await screen.findByText("Host 服务状态响应无法解析")).toBeInTheDocument();
  });
});

describe("[UI 对齐] S8d 日志 panel (real task/serviceLog)", () => {
  const bindings = [
    { taskId: "task-1", serviceId: SERVICE_ID, templateVersion: 2, rootId: "invoice-service", subdir: "", privateKeys: [] },
    { taskId: "task-1", serviceId: OTHER_SERVICE_ID, templateVersion: 1, rootId: "invoice-service", subdir: "", privateKeys: [] },
  ];
  const templates = [
    { projectId: "project-1", serviceId: SERVICE_ID, version: 2, sharedKeys: [], descriptor: { name: "invoice-local", program: "node", args: [], ports: [4100], runType: "long-lived" } },
    { projectId: "project-1", serviceId: OTHER_SERVICE_ID, version: 1, sharedKeys: [], descriptor: { name: "shipment-local", program: "node", args: [], ports: [4200], runType: "long-lived" } },
  ];

  it("reads the Host's real log tail and re-reads it for the other bound service", async () => {
    const fixture = panelBridge({
      bindings, templates,
      logs: (serviceId) => serviceId === SERVICE_ID
        ? { ok: true, payload: { log: [{ at: "2026-10-08T00:00:01.000Z", line: "listening at :4100" }] } }
        : { ok: true, payload: { log: [{ at: "2026-10-08T00:00:02.000Z", line: "shipment ready" }] } },
    });
    render(<DesktopToolDock taskId="task-1" tool="logs" onClose={() => {}} />);
    expect(await screen.findByText(/listening at :4100/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "shipment-local" }));
    expect(await screen.findByText(/shipment ready/)).toBeInTheDocument();
    expect(fixture.taskOp.mock.calls.filter((call) => call[1] === "task/serviceLog").map((call) => call[2]["serviceId"])).toEqual([SERVICE_ID, OTHER_SERVICE_ID]);
  });

  it("shows the Host refusal and an explicit 未接线 note when no log stream exists", async () => {
    panelBridge({ logs: () => ({ ok: false, error: "unknown-service: invoice-local is not registered on this task" }) });
    render(<DesktopToolDock taskId="task-1" tool="logs" onClose={() => {}} />);
    expect(await screen.findByTestId("dock-log-error")).toHaveTextContent("unknown-service: invoice-local is not registered on this task");
    expect(screen.getByTestId("desktop-tool-dock").querySelector('[data-unwired="log-stream"]')).toHaveTextContent("未接线");
    expect(screen.queryByTestId("dock-log-lines")).not.toBeInTheDocument();
  });

  it("reports a real empty tail as zero lines rather than an error", async () => {
    panelBridge({ logs: () => ({ ok: true, payload: { log: [] } }) });
    render(<DesktopToolDock taskId="task-1" tool="logs" onClose={() => {}} />);
    expect(await screen.findByTestId("dock-log-empty")).toHaveTextContent("Host 返回 0 行日志");
  });
});

describe("[UI 对齐] S8d 浏览器 panel (real task/browserAction)", () => {
  it("opens a real page through the Host and reads its real state, evidence and takeover", async () => {
    const actions: string[] = [];
    panelBridge({
      browser: (request) => {
        actions.push(String(request["action"]));
        if (request["action"] === "page/open") return { ok: true, payload: { pageId: "page-1", webContentsId: 42, url: "http://127.0.0.1:5173/" } };
        if (request["action"] === "page/state") return { ok: true, payload: { state: { epoch: 3, viewport: { width: 1440, height: 900 }, title: "对账单详情", url: "http://127.0.0.1:5173/invoice" }, pageId: "page-1" } };
        if (request["action"] === "evidence") return { ok: true, payload: { evidence: { consoleErrors: [{ kind: "console", text: "Uncaught TypeError" }], failedRequests: [{ requestId: "1", url: "http://127.0.0.1:5173/api", errorText: "net::ERR_FAILED", resourceType: "xhr", canceled: false }] } } };
        if (request["action"] === "takeover/pause") return { ok: true, payload: { takeover: { paused: true, reason: "用户接管浏览器" } } };
        return { ok: false, error: `unexpected ${String(request["action"])}` };
      },
    });
    render(<DesktopToolDock taskId="task-1" tool="browser" onClose={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "任务页面地址" }), { target: { value: "http://127.0.0.1:5173/" } });
    fireEvent.click(screen.getByRole("button", { name: "打开任务页面" }));
    expect(await screen.findByTestId("dock-browser-page")).toHaveTextContent("page-1");
    fireEvent.click(screen.getByRole("button", { name: "读取状态" }));
    expect(await screen.findByTestId("dock-browser-state")).toHaveTextContent("epoch 3 · 对账单详情");
    fireEvent.click(screen.getByRole("button", { name: "读取证据" }));
    expect(await screen.findByTestId("dock-browser-evidence")).toHaveTextContent("控制台错误 1 · 失败请求 1");
    fireEvent.click(screen.getByRole("button", { name: "接管浏览器" }));
    expect(await screen.findByRole("button", { name: "交还 Agent" })).toBeInTheDocument();
    expect(actions).toEqual(["page/open", "page/state", "evidence", "takeover/pause"]);
  });

  it("shows the Host's navigation refusal and keeps page discovery/embedding 未接线", async () => {
    panelBridge({ browser: () => ({ ok: false, error: "navigation-denied: 该任务没有配置前端地址" }) });
    render(<DesktopToolDock taskId="task-1" tool="browser" onClose={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "任务页面地址" }), { target: { value: "https://example.com/" } });
    fireEvent.click(screen.getByRole("button", { name: "打开任务页面" }));
    expect(await screen.findByTestId("dock-browser-notice")).toHaveTextContent("navigation-denied: 该任务没有配置前端地址");
    expect(screen.queryByTestId("dock-browser-page")).not.toBeInTheDocument();
    expect(screen.getByTestId("desktop-tool-dock").querySelector('[data-unwired="browser-pages"]')).toHaveTextContent("未接线");
    expect(screen.getByTestId("desktop-tool-dock").querySelector('[data-unwired="browser-embed"]')).toHaveTextContent("未接线");
    expect(screen.getByTestId("desktop-tool-dock").querySelector('[data-unwired="browser-marks"]')).toHaveTextContent("未接线");
  });

  it("keeps the prototype's page-nav controls and 持有者 row as explicit 未接线, not dropped", async () => {
    panelBridge();
    render(<DesktopToolDock taskId="task-1" tool="browser" onClose={() => {}} />);
    const dock = screen.getByTestId("desktop-tool-dock");
    const nav = dock.querySelector('[data-unwired="browser-nav"]')!;
    expect(nav).toHaveTextContent("未接线");
    expect(nav.querySelector("button")).toBeDisabled();
    expect(dock.querySelector('[data-unwired="browser-owner"]')).toHaveTextContent("未接线");
  });

  it("treats a malformed page payload as unreadable instead of using it as a handle", async () => {
    panelBridge({ browser: () => ({ ok: true, payload: { pageId: "", url: 7 } }) });
    render(<DesktopToolDock taskId="task-1" tool="browser" onClose={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "任务页面地址" }), { target: { value: "http://127.0.0.1:5173/" } });
    fireEvent.click(screen.getByRole("button", { name: "打开任务页面" }));
    expect(await screen.findByTestId("dock-browser-notice")).toHaveTextContent("Host 页面响应无法解析");
    expect(screen.queryByTestId("dock-browser-page")).not.toBeInTheDocument();
  });
});

describe("[UI 对齐] S8d panel read inventory", () => {
  it("only ever reads from the Host and does nothing without a user-opened panel", async () => {
    const fixture = panelBridge({
      statuses: () => ({ ok: true, payload: { service: { serviceId: SERVICE_ID, state: "stopped", ownerSessionId: null, busy: false, closing: false, retainedRights: null, executionAvailable: false } } }),
      logs: () => ({ ok: true, payload: { log: [] } }),
      browser: () => ({ ok: true, payload: { pageId: "page-1", webContentsId: 1, url: "http://127.0.0.1:5173/" } }),
    });
    render(<DesktopToolDock taskId="task-1" tool={null} onClose={() => {}} />);
    expect(screen.queryByTestId("desktop-tool-dock")).not.toBeInTheDocument();
    expect(fixture.taskOp).not.toHaveBeenCalled();
    expect(fixture.serviceCatalogOp).not.toHaveBeenCalled();
    expect(fixture.projectOp).not.toHaveBeenCalled();
    for (const tool of ["runtime", "browser", "files", "terminal", "logs", "protocol"] as const) {
      cleanup();
      fixture.taskOp.mockClear(); fixture.serviceCatalogOp.mockClear(); fixture.projectOp.mockClear();
      render(<DesktopToolDock taskId="task-1" tool={tool} onClose={() => {}} />);
      expect(await screen.findByTestId("desktop-tool-dock")).toBeInTheDocument();
      // The 浏览器 panel is on-demand only: it reads nothing until the user opens
      // or reads a page, so an untouched panel proves panel-open is not a write path.
      if (tool === "browser") {
        expect(fixture.taskOp).not.toHaveBeenCalled();
        expect(fixture.serviceCatalogOp).not.toHaveBeenCalled();
      } else {
        await waitFor(() => expect(fixture.taskOp.mock.calls.length + fixture.serviceCatalogOp.mock.calls.length).toBeGreaterThan(0));
      }
      const writes = fixture.taskOp.mock.calls
        .map((call) => call[1])
        .filter((op) => ["task/controlService", "task/quit", "task/archive", "task/restore", "task/terminalControl", "task/runCleanup", "task/registerService"].includes(op));
      expect(writes).toEqual([]);
    }
  });
});
