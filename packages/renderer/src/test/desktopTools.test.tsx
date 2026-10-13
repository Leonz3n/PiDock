import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopToolDock } from "../components/DesktopToolDock";
import { workspaceRootsFromHost } from "../data/workspaceFiles";
// The SHIPPED Host rules build this suite's stub payloads, so the assertions
// pin the Host's own words/shapes instead of a hand-copied fixture
// (`main/workspace-files.ts` is pure: no fs, no git, no Electron).
import { deliveryTarget, workspaceAttribution, workspaceRoots } from "../../../shell/src/main/workspace-files.js";

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
      ok: true, payload: { taskDir, roots: [{ id: "root-1", kind: "worktree", label: "primary", path: worktreePath, baselineBranch: "release/v2", baseCommit }] },
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
        { id: "root-1", kind: "worktree", label: "primary", path: "/tmp/task-1/primary", baselineBranch: "release/v2", baseCommit },
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
            roots: [{ id: "root-1", kind: "worktree", label: "primary", path: "/tmp/task-1/worktrees/primary", baselineBranch: "main" }],
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
      if (op === "task/deliveryInfo") {
        return { ok: true, payload: { target: { attribution, repo: "repo-primary", branch: "main", autoCommit: false, autoPush: false, autoMerge: false } } };
      }
      return { ok: false, error: `unexpected ${op}` };
    });
    bridge(taskOp);
    render(<DesktopToolDock taskId="task-1" tool="files" onClose={() => {}} />);
    expect(await screen.findByText("primary")).toBeInTheDocument();
    fireEvent.click(await screen.findByText("README.md"));
    expect(await screen.findByText("# 真实内容")).toBeInTheDocument();
    expect(calls).toEqual(["task/fileRoots", "task/fileTree", "task/deliveryInfo", "task/filePreview"]);
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

  it("names an empty Host value in the plan-only terminal instead of a bare separator", async () => {
    // `str()` keeps `""` for every field below (`workspaceFiles.ts:228`), so an
    // empty root label reaches the plan line's `·`-joined sentence and would
    // render a leading bare `· ` - the same parser boundary and the same shape
    // the root chip was fixed at (`:363`).
    const blankAttribution = { taskId: "", rootId: "", rootKind: "worktree" as const, rootLabel: "", piWorkDir: "" };
    const taskOp = vi.fn(async (_taskId: string, op: string) => {
      if (op === "task/terminalState") {
        return {
          ok: true,
          payload: {
            spawnImplemented: false,
            instances: [{
              instanceId: "", rootId: "", attribution: blankAttribution, program: "", args: [], cwd: "",
              owner: { taskId: "", sessionId: null, label: "" }, cols: 80, rows: 24, envKeys: [],
              lifecycle: "exited", processKnown: false, startedAt: "2026-10-10T00:00:00.000Z", exitReason: "",
            }],
          },
        };
      }
      if (op === "task/fileRoots") {
        return { ok: true, payload: { taskDir: "", roots: [{ id: "", kind: "worktree", label: "", path: "", repo: "" }] } };
      }
      if (op === "task/planTerminal") {
        return {
          ok: true,
          payload: {
            plan: {
              instanceId: "", rootId: "", attribution: blankAttribution, program: "", args: ["-l"], cwd: "",
              cols: 80, rows: 24, resolved: [], historyLimit: 200,
              owner: { taskId: "", sessionId: null, label: "" },
            },
          },
        };
      }
      return { ok: false, error: `unexpected ${op}` };
    });
    bridge(taskOp);
    render(<DesktopToolDock taskId="task-1" tool="terminal" onClose={() => {}} />);
    fireEvent.click(await screen.findByText("Host 未上报根名称"));

    const plan = await screen.findByTestId("dock-terminal-plan");
    expect(plan).toHaveTextContent("Host 未上报根名称 · 0 项环境变量（密钥已打码）· 历史上限 200");
    expect(plan).toHaveTextContent("Host 未上报终端程序");
    expect(plan).toHaveTextContent("Host 未上报终端工作目录");

    const instances = screen.getByTestId("dock-terminal-instances");
    expect(instances).toHaveTextContent("Host 未上报实例标识");
    expect(instances).toHaveTextContent("Host 未上报终端工作目录");
    // An empty exit reason is not a reason: the row omits the segment by name
    // instead of printing `退出：` with nothing behind it (already guarded here).
    expect(instances).not.toHaveTextContent("退出：");
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

  it("drives a real terminal from the dock once the Host can spawn one", async () => {
    // The dock is the terminal tool a packaged app renders, so it must be the
    // human takeover surface - not a plan-only read - or the panel is dead code
    // in the shipped build.
    const instance = {
      instanceId: "term-task-1-1",
      rootId: "root-1",
      attribution,
      program: "bash",
      args: ["-l"],
      cwd: "/tmp/task-1",
      owner: { taskId: "task-1", sessionId: null, label: "终端面板（用户显式操作）" },
      cols: 80,
      rows: 24,
      envKeys: ["PATH"],
      lifecycle: "running",
      processKnown: true,
      processId: 4321,
      startedAt: "2026-10-10T00:00:00.000Z",
    };
    const calls: { op: string; payload: Record<string, unknown> }[] = [];
    let started = false;
    const taskOp = vi.fn(async (_taskId: string, op: string, payload: Record<string, unknown> = {}) => {
      calls.push({ op, payload });
      if (op === "task/terminalState") return { ok: true, payload: { spawnImplemented: true, instances: started ? [instance] : [] } };
      if (op === "task/fileRoots") return { ok: true, payload: { taskDir: "/tmp/task-1", roots: [{ id: "root-1", kind: "worktree", label: "primary", path: "/tmp/task-1" }] } };
      if (op === "task/planTerminal") return { ok: true, payload: { plan: { ...instance, resolved: [{ key: "PATH", value: "/usr/bin", source: "base", secret: false }], historyLimit: 200, owner: { taskId: "task-1", sessionId: null, label: payload["label"] ?? "用户显式操作" } } } };
      if (op === "task/terminalControl") {
        if (payload["action"] === "start") started = true;
        return { ok: true, payload: { instanceId: "term-task-1-1", action: payload["action"], actor: "human" } };
      }
      if (op === "task/terminalHistory") return { ok: true, payload: { history: [{ at: "t1", line: "host-line" }] } };
      return { ok: true, payload: {} };
    });
    bridge(taskOp);
    render(<DesktopToolDock taskId="task-1" tool="terminal" onClose={() => {}} />);

    // The takeover surface, not the read-only plan view.
    expect(await screen.findByTestId("terminal-output")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "按计划启动终端" }));
    await waitFor(() => expect(calls.some((call) => call.payload["action"] === "start")).toBe(true));
    const start = calls.find((call) => call.payload["action"] === "start");
    expect(start?.op).toBe("task/terminalControl");
    expect(start?.payload["label"]).toBe("终端面板（用户显式操作）");
    // The started instance comes back from the Host's own state read.
    expect(await screen.findByTestId("terminal-instance")).toHaveTextContent("term-task-1-1");
    expect(await screen.findByText("host-line")).toBeInTheDocument();
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
const ENVIRONMENT_ID = "e-11111111-1111-1111-1111-111111111111";

type PanelBridgeOptions = {
  association?: unknown;
  templates?: unknown;
  bindings?: unknown;
  statuses?: (serviceId: string) => unknown;
  logs?: (serviceId: string) => unknown;
  browser?: (request: Record<string, unknown>) => unknown;
  run?: (request: Record<string, unknown>) => unknown;
  rebind?: (request: Record<string, unknown>) => unknown;
  runRecords?: () => unknown;
  /** The trusted 依赖去向 read ([PiDock 05] #10 box 1); default = one local unit, no declaration, no destination. */
  dependencyRouting?: () => unknown;
};

function panelBridge(options: PanelBridgeOptions = {}) {
  const taskOp = vi.fn(async (_taskId: string, op: string, payload: Record<string, unknown>) => {
    if (op === "task/serviceStatus") return options.statuses ? options.statuses(String(payload["serviceId"])) : { ok: false, error: "unexpected task/serviceStatus" };
    if (op === "task/serviceLog") return options.logs ? options.logs(String(payload["serviceId"])) : { ok: false, error: "unexpected task/serviceLog" };
    // Default: the Host answered and holds no run record, so a row says so by
    // name rather than reading as a silent success.
    if (op === "task/serviceRunRecords") return options.runRecords ? options.runRecords() : { ok: true, payload: { records: [], registered: [] } };
    if (op === "task/browserAction") {
      const request = payload as Record<string, unknown>;
      if (!options.browser) return { ok: false, error: "unexpected task/browserAction" };
      return options.browser(request);
    }
    return { ok: false, error: `unexpected ${op}` };
  });
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => {
    if (request["op"] === "runTaskService") return options.run ? options.run(request) : { ok: true, payload: { serviceId: request["serviceId"], action: request["action"], actor: "human" } };
    if (request["op"] === "rebindServiceOwner") return options.rebind ? options.rebind(request) : { ok: false, error: "unexpected rebindServiceOwner" };
    if (request["op"] === "taskDependencyRouting") return options.dependencyRouting ? options.dependencyRouting() : { ok: true, payload: {
      taskId: "task-1",
      units: [{ unitId: `invoice-service/${SERVICE_ID}`, serviceId: SERVICE_ID, name: "invoice-local", repoDir: "invoice-service", subdir: "apps/svc",
        templateVersion: 2, environment: "本地开发", location: "local", declaredPorts: [4100] }],
      repoGroups: [{ repoDir: "invoice-service", unitIds: [`invoice-service/${SERVICE_ID}`] }],
      destinations: [],
      linkage: { state: "no-declaration", edges: [] },
      diagnostics: [],
    } };
    if (request["op"] === "taskBindings") return { ok: true, payload: options.bindings ?? [{
      taskId: "task-1", serviceId: SERVICE_ID, environmentId: ENVIRONMENT_ID, environmentName: "本地开发",
      templateVersion: 2, rootId: "invoice-service", subdir: "apps/svc", privateKeys: ["API_TOKEN"],
    }] };
    if (request["op"] === "list") return { ok: true, payload: options.templates ?? [{
      projectId: "project-1", environmentId: request["environmentId"], serviceId: SERVICE_ID, version: 2, shared: [{ key: "PORT", value: "3000" }],
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
    // The template list is scoped to the environment main reported for the binding.
    expect(fixture.serviceCatalogOp).toHaveBeenCalledWith({ op: "list", projectId: "project-1", environmentId: ENVIRONMENT_ID });
  });

  it("drives the real bound-service start/stop through runTaskService and keeps the rest 未接线", async () => {
    const fixture = panelBridge({ statuses: () => ({ ok: true, payload: { service: {
      serviceId: SERVICE_ID, state: "running", ownerSessionId: null, busy: false, closing: false, retainedRights: null, executionAvailable: false,
    } } }) });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    await screen.findByText("invoice-local");
    // Service start/stop is real now: no 未接线 badge, and the trigger names
    // only the project/task/service - never a program, cwd or env value.
    expect(screen.getByTestId("desktop-tool-dock").querySelector('[data-unwired="service-control"]')).toBeNull();
    const control = screen.getByTestId("desktop-tool-dock").querySelector(`[data-service-control="${SERVICE_ID}"]`)!;
    const stop = within(control as HTMLElement).getByRole("button", { name: "停止" });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    await waitFor(() => expect(fixture.serviceCatalogOp).toHaveBeenCalledWith({
      op: "runTaskService", projectId: "project-1", taskId: "task-1", serviceId: SERVICE_ID, action: "stop",
    }));
    const request = fixture.serviceCatalogOp.mock.calls.find(([entry]) => entry["op"] === "runTaskService")?.[0] as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(["action", "op", "projectId", "serviceId", "taskId"]);
    expect(request["sessionId"]).toBeUndefined();
    expect(request["approvalId"]).toBeUndefined();
    // The page never reaches the Host's control op itself for this action.
    expect(fixture.taskOp.mock.calls.map(([, op]) => op)).not.toContain("task/controlService");
    // (#10 box 1) 本地/远程位置, 远程依赖 and 请求去向 are WIRED now: their rows
    // render main's trusted derivation, so no 未接线 badge (and no stale
    // 「Host 无…读取 op」 reason) may remain for them.
    for (const id of ["service-mode", "remote-deps", "routing"]) {
      expect(screen.getByTestId("desktop-tool-dock").querySelector(`[data-unwired="${id}"]`)).toBeNull();
    }
    expect(screen.getByTestId("desktop-tool-dock").querySelector(`[data-testid="dock-service-location-${SERVICE_ID}"]`)).toHaveTextContent("位置：本机实例 · 本任务自有（未启动不代表运行中）");
    expect(screen.getByTestId("dock-linkage-none")).toHaveTextContent("无依赖边（未做互验）");
  });

  it("shows the Host's runTaskService refusal instead of falling back to fixture data", async () => {
    const fixture = panelBridge({
      statuses: () => ({ ok: true, payload: { service: { serviceId: SERVICE_ID, lifecycle: "stopped", templateVersion: "2", health: "not-probed", launchSource: "catalog", resolved: [] } } }),
      run: () => ({ ok: false, error: "unsupported-platform: 服务启动身份核验与终止仅在 POSIX（darwin/linux）实现" }),
    });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "启动" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("unsupported-platform");
    // The status row keeps the Host's own answer (process liveness + an
    // un-probed health note), and the refusal is never replaced by a green row.
    expect(screen.getByText(/健康未探测/)).toBeInTheDocument();
    expect(fixture.serviceCatalogOp.mock.calls.filter(([entry]) => entry["op"] === "runTaskService")).toHaveLength(1);
    // Only the named owner fence has a wired way back: this refusal offers none.
    expect(screen.queryByTestId("service-owner-rebind")).toBeNull();
  });

  it("surfaces the named owner fence with the explicit re-bind as the way back, and writes only on the confirmed click", async () => {
    const view = (over: Record<string, unknown>) => ({ taskId: "task-1", projectId: "project-1", state: "fenced", confirmed: false, rebound: false,
      changes: [{ serviceId: SERVICE_ID, name: "invoice-local", was: 1, now: 2, configChanged: true }], stopsProcesses: false, restartsProcesses: false, ...over });
    const fixture = panelBridge({
      statuses: () => ({ ok: true, payload: { service: { serviceId: SERVICE_ID, lifecycle: "stopped", templateVersion: "2", health: "not-probed", launchSource: "catalog", resolved: [] } } }),
      run: () => ({ ok: false, error: "service-execution-uncertain: service-owner-inventory-unconfirmed" }),
      rebind: (request) => ({ ok: true, payload: view(request["confirm"] === true ? { state: "current", confirmed: true, rebound: true } : {}) }),
    });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "启动" }));
    // The Host's named refusal is shown verbatim and the panel offers the
    // privileged re-bind instead of a copy that claims a rebuild the page cannot do.
    expect(await screen.findByRole("alert")).toHaveTextContent("service-owner-inventory-unconfirmed");
    expect(screen.getByTestId("service-owner-rebind")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "核对重新绑定" }));
    expect(await screen.findByText(/待重新绑定/)).toBeInTheDocument();
    expect(screen.getByText(/本次重新绑定影响 invoice-local：绑定 v1 → v2/)).toBeInTheDocument();
    expect(screen.getByText(/重新绑定不停止、不重启任何进程/)).toBeInTheDocument();
    expect(fixture.serviceCatalogOp).toHaveBeenCalledWith({ op: "rebindServiceOwner", projectId: "project-1", taskId: "task-1", confirm: false });
    expect(fixture.serviceCatalogOp.mock.calls.filter(([entry]) => entry["op"] === "runTaskService")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "确认重新绑定" }));
    expect(await screen.findByText(/已重新绑定该任务的服务所有者/)).toBeInTheDocument();
    expect(fixture.serviceCatalogOp).toHaveBeenCalledWith({ op: "rebindServiceOwner", projectId: "project-1", taskId: "task-1", confirm: true });
    const rebinds = fixture.serviceCatalogOp.mock.calls.map(([entry]) => entry).filter((entry) => entry["op"] === "rebindServiceOwner");
    expect(rebinds).toEqual([{ op: "rebindServiceOwner", projectId: "project-1", taskId: "task-1", confirm: false },
      { op: "rebindServiceOwner", projectId: "project-1", taskId: "task-1", confirm: true }]);
    // The receipt stays until the user closes it, and the stale revocation claim
    // is gone: the panel no longer says this task's control is revoked.
    expect(screen.getByTestId("service-owner-rebind")).not.toHaveTextContent("该任务的启停通道已被撤销");
    // The re-bind replaced ownership only: it never asks main to start or stop
    // a process, and the panel re-reads the Host's own status instead.
    expect(fixture.serviceCatalogOp.mock.calls.filter(([entry]) => entry["op"] === "runTaskService")).toHaveLength(1);
    expect(fixture.taskOp.mock.calls.filter(([, op]) => op === "task/serviceStatus").length).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByTestId("service-owner-rebind")).toBeNull();
  });

  it("shows the observed 健康检查 of the row, and a failed probe never reads as a dead process", async () => {
    const target = "http://127.0.0.1:4100/health";
    let health = "healthy";
    let healthDetail: unknown = { kind: "http", target, statusCode: 200, elapsedMs: 12, boundMs: 1500 };
    // One bridge whose answer is replaced between the two renders below.
    panelBridge({ statuses: () => ({ ok: true, payload: { service: { serviceId: SERVICE_ID, lifecycle: "running", templateVersion: "2",
      launchSource: "catalog", resolved: [], health, healthDetail } } }) });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    const row = (await screen.findByText("invoice-local")).closest("li")!;
    // A REAL pass, as the Host observed it: the row carries the same named state
    // the Agent's status text does, with the real code and the real elapsed ms.
    expect(row).toHaveAttribute("data-service-health", "healthy");
    expect(row).toHaveTextContent("运行中");
    expect(row).toHaveTextContent("健康正常（HTTP 200，12ms）");

    // The declared target really failed while the process really runs: the row
    // names the failure AND keeps the live process - "unhealthy" is never shown
    // as healthy and never as a dead service.
    cleanup();
    health = "unhealthy";
    healthDetail = { kind: "http", target, elapsedMs: 3, boundMs: 1500, reason: "连接被拒" };
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    const failed = (await screen.findByText("invoice-local")).closest("li")!;
    expect(failed).toHaveAttribute("data-service-health", "unhealthy");
    expect(failed).toHaveTextContent("运行中 · 配方 v2");
    expect(failed).toHaveTextContent("健康异常（HTTP，3ms，连接被拒）");
    expect(failed).not.toHaveTextContent("健康正常");
    expect(failed).not.toHaveTextContent("已停止");
  });

  it("states 未声明 health check for a revision that declares none, and never a pass", async () => {
    panelBridge({ statuses: () => ({ ok: true, payload: { service: { serviceId: SERVICE_ID, lifecycle: "running", templateVersion: "2",
      launchSource: "catalog", resolved: [], health: "undeclared" } } }) });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    const row = (await screen.findByText("invoice-local")).closest("li")!;
    expect(row).toHaveAttribute("data-service-health", "undeclared");
    expect(row).toHaveTextContent("运行中 · 配方 v2");
    expect(row).toHaveTextContent("未声明健康检查");
    expect(row).not.toHaveTextContent("健康正常");
    expect(row).not.toHaveTextContent("健康未探测");
  });

  it("says a Host reported no health field instead of implying a pass", async () => {
    panelBridge({ statuses: () => ({ ok: true, payload: { service: { serviceId: SERVICE_ID, lifecycle: "running", templateVersion: "2",
      launchSource: "catalog", resolved: [] } } }) });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    const row = (await screen.findByText("invoice-local")).closest("li")!;
    expect(row).toHaveAttribute("data-service-health", "unreported");
    expect(row).toHaveTextContent("健康未读取（Host 未报告健康字段）");
  });

  it("shows the Host refusal for a status read instead of a fabricated stopped state", async () => {
    panelBridge({ statuses: () => ({ ok: false, error: "unknown-service: not registered on this task" }) });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    expect(await screen.findByText("unknown-service: not registered on this task")).toBeInTheDocument();
    expect(screen.queryByText("已停止")).not.toBeInTheDocument();
  });

  it("shows who last started or stopped a service and never presents an Agent action as the user's own click", async () => {
    let lastControl: unknown = { action: "start", actor: "agent", label: "main" };
    panelBridge({ statuses: () => ({ ok: true, payload: { service: { serviceId: SERVICE_ID, lifecycle: "running", templateVersion: "2",
      health: "not-probed", launchSource: "catalog", resolved: [], lastControl } } }) });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    // The Host's own labels are repeated verbatim: Agent control carries the
    // session, and the row never claims the user clicked it.
    expect(await screen.findByText(/最近启动：Agent 会话 main/)).toBeInTheDocument();
    expect(screen.queryByText(/最近启动：人工/)).not.toBeInTheDocument();

    // The explicit human action is a different row state, with main's own label.
    cleanup();
    lastControl = { action: "stop", actor: "human", label: "主进程服务目录入口" };
    panelBridge({ statuses: () => ({ ok: true, payload: { service: { serviceId: SERVICE_ID, lifecycle: "stopped", templateVersion: "2",
      health: "not-probed", launchSource: "catalog", resolved: [], lastControl } } }) });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    expect(await screen.findByText(/最近停止：人工（主进程服务目录入口）/)).toBeInTheDocument();
    expect(screen.queryByText(/最近停止：Agent/)).not.toBeInTheDocument();
  });

  it("shows which platform was really verified and names Windows as unverified", async () => {
    const here = `${process.platform}-${process.arch}`;
    panelBridge({ statuses: () => ({ ok: true, payload: { service: {
      serviceId: SERVICE_ID, lifecycle: "stopped", templateVersion: "2", health: "not-probed", launchSource: "catalog", resolved: [],
      launchVerification: { platform: here, rows: [
        { platform: here, verified: true, nodeVersion: "24.21.0", program: "node", startedAt: "2026-10-08T00:00:00.000Z", stopped: true, stoppedAt: "2026-10-08T00:01:00.000Z" },
        { platform: "win32-x64", verified: false, reason: "本机未运行该平台，未实测" },
      ] },
    } } }) });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    await screen.findByText("invoice-local");
    const line = await screen.findByTestId("dock-launch-verification");
    expect(line).toHaveAttribute("data-platform", here);
    // What was verified, on WHICH platform: a real start and a confirmed stop.
    expect(line.querySelector(`[data-platform-row="${here}"]`)).toHaveAttribute("data-verified", "true");
    expect(line.querySelector(`[data-platform-row="${here}"]`)).toHaveTextContent(`本机 ${here} 实测：已启动（node） · 已停止 · Node 24.21.0`);
    // Windows is named and NOT verified; nothing in the row reads as a pass.
    const windows = line.querySelector('[data-platform-row="win32-x64"]');
    expect(windows).toHaveAttribute("data-verified", "false");
    expect(windows).toHaveTextContent("win32-x64 未验证（本机未运行该平台，未实测）");
    expect(line.querySelectorAll('[data-verified="true"]')).toHaveLength(1);
  });

  it("says a Host provided no platform record instead of implying a verification", async () => {
    panelBridge({ statuses: () => ({ ok: true, payload: { service: {
      serviceId: SERVICE_ID, lifecycle: "stopped", templateVersion: "2", health: "not-probed", launchSource: "catalog", resolved: [],
    } } }) });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    await screen.findByText("invoice-local");
    const line = await screen.findByTestId("dock-launch-verification");
    expect(line).toHaveAttribute("data-platform", "unknown");
    expect(line).toHaveTextContent("该 Host 未提供平台实测记录（不表示已通过）");
    expect(line.querySelectorAll('[data-verified="true"]')).toHaveLength(0);
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
    { taskId: "task-1", serviceId: SERVICE_ID, environmentId: ENVIRONMENT_ID, environmentName: "本地开发", templateVersion: 2, rootId: "invoice-service", subdir: "", privateKeys: [] },
    { taskId: "task-1", serviceId: OTHER_SERVICE_ID, environmentId: ENVIRONMENT_ID, environmentName: "本地开发", templateVersion: 1, rootId: "invoice-service", subdir: "", privateKeys: [] },
  ];
  const templates = [
    { projectId: "project-1", environmentId: ENVIRONMENT_ID, serviceId: SERVICE_ID, version: 2, shared: [], descriptor: { name: "invoice-local", program: "node", args: [], ports: [4100], runType: "long-lived" } },
    { projectId: "project-1", environmentId: ENVIRONMENT_ID, serviceId: OTHER_SERVICE_ID, version: 1, shared: [], descriptor: { name: "shipment-local", program: "node", args: [], ports: [4200], runType: "long-lived" } },
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

/**
 * [PiDock 10] (#15 盒子 2/7/9) the SHIPPED `FilesTool` must read the delivery
 * target the Host already returns and render the per-view attribution it used
 * to discard.
 *
 * The bridge stub answers with payloads built by the SHIPPED Host rules
 * (`main/workspace-files.ts` `workspaceRoots` / `workspaceAttribution` /
 * `deliveryTarget`), so the assertions below pin the Host's own words and
 * shapes instead of a hand-copied fixture that could drift from them. The dock
 * is mounted directly (the production component), never the demo shell.
 */
describe("[PiDock 10] (#15 盒子 2/7/9) 交付目标与每视图归属 on the shipped dock", () => {
  const TASK_ID = "task-1";
  const TASK_DIR = "/tmp/task-1";
  const SHARED_LINK = "invoice-docs";
  const SHARED_SOURCE = "/work/invoice-docs";

  const readOnlyOps = ["task/fileRoots", "task/fileTree", "task/filePreview", "task/fileDiff", "task/deliveryInfo"];

  /** The roots payload the Host really produces for a two-repo task with one link. */
  const twoRepoRoots = () => workspaceRoots({
    taskId: TASK_ID,
    taskDir: TASK_DIR,
    repos: ["repo-a", "repo-b"],
    repoSources: [
      { repoDir: "repo-a", remoteBranch: "release/v2", baseCommit: "aaaa1111" },
      { repoDir: "repo-b", remoteBranch: "main", baseCommit: "bbbb2222" },
    ],
    dirLinks: [{ linkName: SHARED_LINK, directoryId: "dir-9f2a", sourcePath: SHARED_SOURCE }],
  });

  /** A task whose only root is the plain-directory link. */
  const sharedOnlyRoots = () => workspaceRoots({
    taskId: TASK_ID,
    taskDir: TASK_DIR,
    repos: [],
    dirLinks: [{ linkName: SHARED_LINK, directoryId: "dir-9f2a", sourcePath: SHARED_SOURCE }],
  });

  /**
   * The Host's answers for one set of roots: every read is scoped to the asked
   * `rootId` and every attribution comes from the shipped rule function. The
   * overrides let one test hand back a payload the shipped Host would not
   * produce (an empty string, a contradicting root) without a second stub.
   */
  const hostReads = (
    roots: ReturnType<typeof workspaceRoots>,
    override?: {
      delivery?: unknown;
      treeAttribution?: unknown;
      treeEntries?: unknown;
      preview?: { path: string; language: string };
      previewAttribution?: unknown;
    },
  ) =>
    async (_taskId: string, op: string, payload: Record<string, unknown>) => {
      const root = roots.find((entry) => entry.id === payload["rootId"]) ?? roots[0]!;
      const attribution = workspaceAttribution(root, TASK_ID, TASK_DIR);
      const identity = attribution.repo ?? attribution.directoryId ?? attribution.rootLabel;
      if (op === "task/fileRoots") return { ok: true, payload: { taskDir: TASK_DIR, roots } };
      if (op === "task/fileTree") {
        return { ok: true, payload: { tree: { attribution: override?.treeAttribution ?? attribution, path: "", entries: override?.treeEntries ?? [{ name: "a.md", path: "a.md", kind: "file", size: 3 }], truncated: false } } };
      }
      if (op === "task/filePreview") {
        const shape = override?.preview ?? { path: "a.md", language: "markdown" };
        return { ok: true, payload: { preview: { attribution: override?.previewAttribution ?? attribution, path: shape.path, language: shape.language, source: `# ${identity} 内容`, truncated: false, lineCount: 1 } } };
      }
      if (op === "task/fileDiff") {
        return { ok: true, payload: { attribution, path: "a.md", diff: `- ${identity} 旧行\n+ 新行`, truncated: false } };
      }
      if (op === "task/deliveryInfo") {
        if (override?.delivery !== undefined) return override.delivery as { ok: boolean; payload?: unknown; error?: string };
        const target = deliveryTarget({ root, taskId: TASK_ID, taskDir: TASK_DIR });
        return target.ok ? { ok: true, payload: { target: target.target } } : { ok: false, error: target.error };
      }
      return { ok: false, error: `unexpected ${op}` };
    };

  /**
   * The Host's launch receipt for one root, built through the same shipped
   * attribution rule as every other payload here.
   */
  const launchFor = (root: ReturnType<typeof workspaceRoots>[number]) => ({
    rootId: root.id,
    rootKind: root.kind,
    program: "/usr/local/bin/fake-editor",
    args: ["--new-window", root.path],
    cwd: root.path,
    openedPath: root.path,
    attribution: workspaceAttribution(root, TASK_ID, TASK_DIR),
    disclosure: `外部编辑器在任务工作副本打开：${root.path}`,
    note: "未读取、未写入也未复制任何编辑器配置",
    actor: "human" as const,
    label: `外部编辑器 ${root.label}（用户显式操作）`,
    started: true as const,
    windowObserved: false as const,
  });

  /** The editor launch is its own bridge entry, so a receipt is its own payload. */
  const editorBridge = (taskOp: unknown, openTaskEditor: unknown) => {
    window.pidock = { taskOp, openTaskEditor } as unknown as typeof window.pidock;
  };

  it("shows the Host's delivery repo, recorded branch and three false automation flags for a worktree root", async () => {
    const roots = twoRepoRoots();
    const taskOp = vi.fn(hostReads(roots));
    bridge(taskOp);
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    const readout = await screen.findByTestId("dock-delivery");
    // The three fields the sentence is built from — the Host's own values, not
    // a hard-coded claim.
    expect(readout).toHaveAttribute("data-auto-commit", "false");
    expect(readout).toHaveAttribute("data-auto-push", "false");
    expect(readout).toHaveAttribute("data-auto-merge", "false");
    expect(within(readout).getByTestId("dock-delivery-repo")).toHaveTextContent("repo-a");
    expect(within(readout).getByTestId("dock-delivery-branch")).toHaveTextContent("release/v2");
    expect(within(readout).getByTestId("dock-delivery-auto")).toHaveTextContent("不自动提交、不自动推送、不自动合并");

    // Every value traces to a real read on the real route: one read per fact,
    // all of them the #15 file ops, none of them a write.
    expect(taskOp.mock.calls.map((call) => call[1])).toEqual(["task/fileRoots", "task/fileTree", "task/deliveryInfo"]);
    expect(taskOp).toHaveBeenCalledWith(TASK_ID, "task/deliveryInfo", { rootId: "repo-a" });
    expect(taskOp.mock.calls.map((call) => call[1]).every((op) => readOnlyOps.includes(op))).toBe(true);
  });

  it("names an unrecorded delivery branch instead of inventing one", async () => {
    // No `repoSources` → the record has no baseline branch for this worktree.
    const roots = workspaceRoots({ taskId: TASK_ID, taskDir: TASK_DIR, repos: ["repo-a"] });
    bridge(hostReads(roots));
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    const readout = await screen.findByTestId("dock-delivery");
    expect(within(readout).getByTestId("dock-delivery-repo")).toHaveTextContent("repo-a");
    expect(within(readout).getByTestId("dock-delivery-branch")).toHaveTextContent("Host 未记录远程基线分支");
  });

  it("shows the Host's plain-directory refusal, the write-through note and the original target, with no Git affordance", async () => {
    const roots = sharedOnlyRoots();
    const refusal = deliveryTarget({ root: roots[0]!, taskId: TASK_ID, taskDir: TASK_DIR });
    expect(refusal.ok).toBe(false);
    const taskOp = vi.fn(hostReads(roots));
    bridge(taskOp);
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    // The Host's refusal, verbatim.
    expect(await screen.findByTestId("dock-delivery-notice")).toHaveTextContent(refusal.ok ? "" : refusal.error);
    expect(screen.getByTestId("dock-delivery-notice")).toHaveTextContent("plain-dir-no-delivery");
    expect(screen.queryByTestId("dock-delivery")).not.toBeInTheDocument();

    // The link's own attribution: the write-through warning and the original target.
    const tree = await screen.findByTestId("dock-tree-attribution");
    expect(tree).toHaveAttribute("data-root-kind", "shared-dir");
    expect(within(tree).getByTestId("dock-shared-note")).toHaveTextContent("修改影响原文件");
    expect(within(tree).getByTestId("dock-shared-source-path")).toHaveTextContent(SHARED_SOURCE);
    expect(within(tree).getByTestId("dock-shared-link-path")).toHaveTextContent(`${TASK_DIR}/${SHARED_LINK}`);
    expect(within(tree).getByTestId("dock-shared-pi-work-dir")).toHaveTextContent(TASK_DIR);
    // The DEMO panel's test ids (`ToolPanels.tsx` `shared-dir-note` /
    // `delivery-target`) are not the shipped surface: this render must never
    // show them, because that would mean the demo renderer was mounted here.
    expect(screen.queryByTestId("shared-dir-note")).not.toBeInTheDocument();
    expect(screen.queryByTestId("delivery-target")).not.toBeInTheDocument();

    // Opening a file shows the preview, but the Git diff affordance is not offered.
    fireEvent.click(await screen.findByText("a.md"));
    const preview = await screen.findByTestId("dock-preview-attribution");
    expect(preview).toHaveAttribute("data-root-kind", "shared-dir");
    expect(preview).toHaveTextContent("普通目录链接");
    expect(screen.queryByRole("button", { name: "改动" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("dock-diff")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dock-diff-attribution")).not.toBeInTheDocument();
  });

  it("repeats each view's own repo attribution, so a two-repo task shows two different repos", async () => {
    const roots = twoRepoRoots();
    bridge(hostReads(roots));
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    expect(within(await screen.findByTestId("dock-tree-attribution")).getByText(/仓库 repo-a/)).toBeInTheDocument();
    fireEvent.click(await screen.findByText("a.md"));
    expect(await screen.findByTestId("dock-preview-attribution")).toHaveTextContent("仓库 repo-a");
    expect(screen.getByText("# repo-a 内容")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "改动" }));
    expect(await screen.findByTestId("dock-diff-attribution")).toHaveTextContent("仓库 repo-a");
    expect(screen.getByTestId("dock-diff")).toHaveTextContent("repo-a 旧行");

    // Switch to the second repository: every view follows ITS payload.
    fireEvent.click(screen.getByRole("button", { name: "repo-b" }));
    fireEvent.click(await screen.findByText("a.md"));
    expect(await screen.findByTestId("dock-preview-attribution")).toHaveTextContent("仓库 repo-b");
    expect(screen.getByText("# repo-b 内容")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "改动" }));
    expect(await screen.findByTestId("dock-diff-attribution")).toHaveTextContent("仓库 repo-b");
    expect(screen.getByTestId("dock-diff")).toHaveTextContent("repo-b 旧行");
    expect(within(screen.getByTestId("dock-diff-attribution")).queryByText(/repo-a/)).not.toBeInTheDocument();
  });

  it("names a malformed delivery payload instead of falling back to a sample target", async () => {
    const roots = twoRepoRoots();
    // The Host answered `ok` with a shape the renderer cannot use: no
    // attribution and no automation flags. Nothing from it may be shown.
    bridge(hostReads(roots, { delivery: { ok: true, payload: { target: { repo: "sample-repo", branch: "sample-branch" } } } }));
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    expect(await screen.findByTestId("dock-delivery-notice")).toHaveTextContent("Host 交付目标响应无法解析");
    expect(screen.queryByTestId("dock-delivery")).not.toBeInTheDocument();
    expect(screen.queryByText(/sample-repo/)).not.toBeInTheDocument();
    expect(screen.queryByText(/sample-branch/)).not.toBeInTheDocument();
    // The panel is not blank: the tree still renders beside the named error.
    expect(screen.getByTestId("desktop-tool-dock")).toBeInTheDocument();
    await screen.findByTestId("dock-tree-attribution");
  });

  it("names an absent worktree repo identity instead of presenting the root label as a repository", async () => {
    const roots = twoRepoRoots();
    // A Host contract violation: a worktree attribution that carries no `repo`.
    // The root label is the ROOT's own identity; it must never stand in for a
    // repository identity, in the one place this panel used to default.
    const withoutRepo: Record<string, unknown> = { ...workspaceAttribution(roots[0]!, TASK_ID, TASK_DIR) };
    delete withoutRepo["repo"];
    bridge(hostReads(roots, { treeAttribution: withoutRepo }));
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    const tree = await screen.findByTestId("dock-tree-attribution");
    expect(tree).toHaveAttribute("data-root-kind", "worktree");
    // The absence is NAMED…
    expect(tree).toHaveTextContent("Host 未上报仓库身份");
    // …and the root label (`repo-a`) is not smuggled in as the repo identity.
    expect(tree).not.toHaveTextContent("仓库 repo-a");
  });

  it("refuses by name a delivery target that names a link root, instead of rendering a target that cannot exist", async () => {
    const roots = sharedOnlyRoots();
    const link = roots[0]!;
    // A Host contract violation: `deliveryTarget` refuses a link root
    // (`plain-dir-no-delivery`), so this target must not be rendered even
    // though it parses. The renderer keeps the invariant locally.
    bridge(hostReads(roots, { delivery: { ok: true, payload: { target: {
      attribution: workspaceAttribution(link, TASK_ID, TASK_DIR),
      repo: "sample-repo",
      branch: "sample-branch",
      autoCommit: false,
      autoPush: false,
      autoMerge: false,
    } } } }));
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    // The refusal is a NAMED state, not a blank and not a target.
    expect(await screen.findByTestId("dock-delivery-notice")).toHaveTextContent(
      "Host 交付目标与根类型不符：普通目录链接没有 Git 交付，本面板不显示",
    );
    expect(screen.queryByTestId("dock-delivery")).not.toBeInTheDocument();
    expect(screen.queryByText(/sample-repo/)).not.toBeInTheDocument();
    expect(screen.queryByText(/sample-branch/)).not.toBeInTheDocument();
    // Not blank: the link's own attribution renders beside the refusal.
    const tree = await screen.findByTestId("dock-tree-attribution");
    expect(tree).toHaveAttribute("data-root-kind", "shared-dir");
  });

  it("drops a late answer from the root the user already left, so one repo is never shown under another's chip", async () => {
    const roots = twoRepoRoots();
    const rootA = roots.find((root) => root.id === "repo-a")!;
    const rootB = roots.find((root) => root.id === "repo-b")!;
    const answers = hostReads(roots);
    // Root A's own tree and delivery answers are held back and released only
    // after root B is fully on screen (two quick chip clicks, reverse order).
    const held: Array<{ op: string; resolve: (value: unknown) => void }> = [];
    const taskOp = vi.fn((taskId: string, op: string, payload: Record<string, unknown>) => {
      if ((op === "task/fileTree" || op === "task/deliveryInfo") && payload["rootId"] === rootA.id) {
        return new Promise<unknown>((resolve) => { held.push({ op, resolve }); });
      }
      return answers(taskId, op, payload);
    });
    bridge(taskOp);
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: rootB.label }));
    const readout = await screen.findByTestId("dock-delivery");
    expect(within(readout).getByTestId("dock-delivery-repo")).toHaveTextContent("repo-b");
    expect(within(readout).getByTestId("dock-delivery-branch")).toHaveTextContent("main");
    expect(await screen.findByTestId("dock-tree-attribution")).toHaveTextContent("仓库 repo-b");
    // `selectRoot` awaits the tree before it asks for the delivery, so only A's
    // tree is outstanding at this point; A's delivery is not even requested yet.
    expect(held.map((entry) => entry.op)).toEqual(["task/fileTree"]);

    // Now root A's own answers arrive LAST — they belong to a root the user left.
    await act(async () => {
      const treeAnswer = held.shift()!;
      treeAnswer.resolve(await answers(TASK_ID, treeAnswer.op, { rootId: rootA.id }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Answering A's tree is what makes the panel ask for A's delivery, which
      // is held too and arrives even later.
      const deliveryAnswer = held.shift()!;
      expect(deliveryAnswer.op).toBe("task/deliveryInfo");
      deliveryAnswer.resolve(await answers(TASK_ID, deliveryAnswer.op, { rootId: rootA.id }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The panel still shows root B's identity and data, and none of root A's.
    const current = screen.getByTestId("dock-delivery");
    expect(within(current).getByTestId("dock-delivery-repo")).toHaveTextContent("repo-b");
    expect(within(current).getByTestId("dock-delivery-branch")).toHaveTextContent("main");
    expect(screen.getByTestId("dock-tree-attribution")).toHaveTextContent("仓库 repo-b");
    expect(screen.getByTestId("dock-tree-attribution")).not.toHaveTextContent("repo-a");
    expect(screen.queryByText(/release\/v2/)).not.toBeInTheDocument();
  });

  it("refuses by name a delivery target whose own rootKind contradicts the selected root", async () => {
    const roots = sharedOnlyRoots();
    const link = roots[0]!;
    // A payload that TALKS ITS WAY PAST the panel: it answers the link root's own
    // id (so the identity check passes) and claims to be a worktree's target. The
    // renderer's own knowledge of the selected root is the only authority left.
    bridge(hostReads(roots, { delivery: { ok: true, payload: { target: {
      attribution: { ...workspaceAttribution(link, TASK_ID, TASK_DIR), rootKind: "worktree", repo: "sample-repo" },
      repo: "sample-repo",
      branch: "sample-branch",
      autoCommit: false,
      autoPush: false,
      autoMerge: false,
    } } } }));
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    // No target, and a NAMED state that says which side the panel believes.
    expect(await screen.findByTestId("dock-delivery-notice")).toHaveTextContent(
      "Host 交付目标自述为工作树，与所选根（普通目录链接）不符：本面板只按所选根的类型判定，不显示 Git 交付目标",
    );
    expect(screen.queryByTestId("dock-delivery")).not.toBeInTheDocument();
    expect(screen.queryByText(/sample-repo/)).not.toBeInTheDocument();
    expect(screen.queryByText(/sample-branch/)).not.toBeInTheDocument();
    // Not a blank panel: the selected root's own tree attribution is beside it.
    expect(await screen.findByTestId("dock-tree-attribution")).toHaveAttribute("data-root-kind", "shared-dir");
  });

  it("names an absent delivery repo instead of leaving the delivery readout blank", async () => {
    const roots = twoRepoRoots();
    const root = roots.find((entry) => entry.id === "repo-a")!;
    // A Host contract violation the parser keeps (`str()` keeps `""`): a worktree
    // target with no repository identity. The sibling branch field is already
    // named; this one must be too.
    bridge(hostReads(roots, { delivery: { ok: true, payload: { target: {
      attribution: workspaceAttribution(root, TASK_ID, TASK_DIR),
      repo: "",
      branch: "release/v2",
      autoCommit: false,
      autoPush: false,
      autoMerge: false,
    } } } }));
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    const readout = await screen.findByTestId("dock-delivery");
    const repo = within(readout).getByTestId("dock-delivery-repo");
    expect(repo).toHaveTextContent("Host 未上报交付仓库身份");
    expect(repo.textContent).not.toBe("");
    expect(within(readout).getByTestId("dock-delivery-branch")).toHaveTextContent("release/v2");
  });

  it("names a dropped stale answer instead of leaving the tree area empty", async () => {
    const roots = twoRepoRoots();
    const rootA = roots.find((root) => root.id === "repo-a")!;
    const answers = hostReads(roots);
    const held: Array<{ op: string; resolve: (value: unknown) => void }> = [];
    const taskOp = vi.fn((taskId: string, op: string, payload: Record<string, unknown>) => {
      if ((op === "task/fileTree" || op === "task/deliveryInfo") && payload["rootId"] === rootA.id) {
        return new Promise<unknown>((resolve) => { held.push({ op, resolve }); });
      }
      return answers(taskId, op, payload);
    });
    bridge(taskOp);
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    // The user leaves root A for root B while A's own answers are still in flight.
    fireEvent.click(await screen.findByRole("button", { name: "repo-b" }));
    expect(await screen.findByTestId("dock-tree-attribution")).toHaveTextContent("仓库 repo-b");
    expect(held.map((entry) => entry.op)).toEqual(["task/fileTree"]);

    // A's tree answer lands last: it is dropped, and the DROP ITSELF is named.
    await act(async () => {
      held.shift()!.resolve(await answers(TASK_ID, "task/fileTree", { rootId: rootA.id }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByTestId("dock-stale-answer")).toHaveTextContent("已丢弃过期根 repo-a 的文件树响应 · 当前根 repo-b");
    // …and the tree area is not empty: root B's own tree is what is on screen.
    expect(screen.getByTestId("dock-tree-attribution")).toHaveTextContent("仓库 repo-b");

    // A's delivery answer lands even later: also dropped, also named.
    await act(async () => {
      const answer = held.shift()!;
      expect(answer.op).toBe("task/deliveryInfo");
      answer.resolve(await answers(TASK_ID, answer.op, { rootId: rootA.id }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByTestId("dock-stale-answer")).toHaveTextContent("已丢弃过期根 repo-a 的交付目标响应 · 当前根 repo-b");
    expect(within(screen.getByTestId("dock-delivery")).getByTestId("dock-delivery-repo")).toHaveTextContent("repo-b");
    expect(screen.queryByText(/release\/v2/)).not.toBeInTheDocument();
  });

  it("names a tree answer that describes another root instead of leaving an unnamed empty area", async () => {
    const roots = twoRepoRoots();
    const rootB = roots.find((root) => root.id === "repo-b")!;
    // The answer to root A's own read claims to belong to root B. It is dropped,
    // and the region it would have filled says so by name instead of going quiet.
    bridge(hostReads(roots, { treeAttribution: workspaceAttribution(rootB, TASK_ID, TASK_DIR) }));
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    expect(await screen.findByTestId("dock-stale-answer")).toHaveTextContent(
      "Host 文件树响应自述根 repo-b 与所请求的根 repo-a 不符：本面板不显示",
    );
    expect(screen.queryByTestId("dock-tree")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dock-tree-attribution")).not.toBeInTheDocument();
    // The panel is not blank: the selected root's own delivery readout is there.
    expect(within(await screen.findByTestId("dock-delivery")).getByTestId("dock-delivery-repo")).toHaveTextContent("repo-a");
  });

  it("names an empty root identity in a dropped answer instead of a blank one", async () => {
    // `str()` keeps an empty `attribution.rootId`, so the drop sentence - which
    // exists to say WHICH root answered - has to name that absence: a blank one
    // would read as a root the panel simply did not print.
    const roots = twoRepoRoots();
    bridge(hostReads(roots, { treeAttribution: { ...workspaceAttribution(roots[1]!, TASK_ID, TASK_DIR), rootId: "" } }));
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    expect(await screen.findByTestId("dock-stale-answer")).toHaveTextContent(
      "Host 文件树响应自述根 Host 未上报根标识 与所请求的根 repo-a 不符：本面板不显示",
    );
    expect(screen.queryByTestId("dock-tree")).not.toBeInTheDocument();
  });

  it("drops a preview answer from the root the user left, by name", async () => {
    const roots = twoRepoRoots();
    const rootA = roots.find((root) => root.id === "repo-a")!;
    const answers = hostReads(roots);
    let releasePreview: (value: unknown) => void = () => {};
    const taskOp = vi.fn((taskId: string, op: string, payload: Record<string, unknown>) => {
      if (op === "task/filePreview" && payload["rootId"] === rootA.id) {
        return new Promise<unknown>((resolve) => { releasePreview = resolve; });
      }
      return answers(taskId, op, payload);
    });
    bridge(taskOp);
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    fireEvent.click(await screen.findByText("a.md"));
    fireEvent.click(screen.getByRole("button", { name: "repo-b" }));
    expect(within(await screen.findByTestId("dock-delivery")).getByTestId("dock-delivery-repo")).toHaveTextContent("repo-b");

    await act(async () => {
      releasePreview(await answers(TASK_ID, "task/filePreview", { rootId: rootA.id }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByTestId("dock-stale-answer")).toHaveTextContent("已丢弃过期根 repo-a 的预览响应 · 当前根 repo-b");
    expect(screen.queryByTestId("dock-preview-attribution")).not.toBeInTheDocument();
    expect(screen.queryByText("# repo-a 内容")).not.toBeInTheDocument();
  });

  it("drops a diff answer from the root the user left, by name", async () => {
    const roots = twoRepoRoots();
    const rootA = roots.find((root) => root.id === "repo-a")!;
    const answers = hostReads(roots);
    let releaseDiff: (value: unknown) => void = () => {};
    const taskOp = vi.fn((taskId: string, op: string, payload: Record<string, unknown>) => {
      if (op === "task/fileDiff" && payload["rootId"] === rootA.id) {
        return new Promise<unknown>((resolve) => { releaseDiff = resolve; });
      }
      return answers(taskId, op, payload);
    });
    bridge(taskOp);
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    fireEvent.click(await screen.findByText("a.md"));
    expect(await screen.findByTestId("dock-preview-attribution")).toHaveTextContent("仓库 repo-a");
    fireEvent.click(screen.getByRole("button", { name: "改动" }));
    fireEvent.click(screen.getByRole("button", { name: "repo-b" }));
    expect(within(await screen.findByTestId("dock-delivery")).getByTestId("dock-delivery-repo")).toHaveTextContent("repo-b");

    await act(async () => {
      releaseDiff(await answers(TASK_ID, "task/fileDiff", { rootId: rootA.id }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByTestId("dock-stale-answer")).toHaveTextContent("已丢弃过期根 repo-a 的改动响应 · 当前根 repo-b");
    expect(screen.queryByTestId("dock-diff")).not.toBeInTheDocument();
    expect(screen.queryByText("repo-a 旧行")).not.toBeInTheDocument();
  });

  it("refuses by name an editor receipt from the root the user has left", async () => {
    const roots = twoRepoRoots();
    const rootA = roots.find((root) => root.id === "repo-a")!;
    const taskOp = vi.fn(hostReads(roots));
    let releaseLaunch: (value: unknown) => void = () => {};
    const openTaskEditor = vi.fn(() => new Promise<unknown>((resolve) => { releaseLaunch = resolve; }));
    editorBridge(taskOp, openTaskEditor);
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "用外部编辑器打开" }));
    expect(openTaskEditor).toHaveBeenCalledWith({ taskId: TASK_ID, rootId: rootA.id });
    fireEvent.click(screen.getByRole("button", { name: "repo-b" }));
    expect(within(await screen.findByTestId("dock-delivery")).getByTestId("dock-delivery-repo")).toHaveTextContent("repo-b");

    // The receipt of the root the user left must not stand in as root B's launch.
    await act(async () => {
      releaseLaunch({ ok: true, payload: { workspaceId: "w", taskId: TASK_ID, op: "task/openEditor", payload: { launch: launchFor(rootA) } } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByTestId("dock-stale-answer")).toHaveTextContent("已丢弃过期根 repo-a 的外部编辑器回执 · 当前根 repo-b");
    expect(screen.queryByText("外部编辑器已启动（用户显式操作）")).not.toBeInTheDocument();
    expect(screen.queryByText(launchFor(rootA).program)).not.toBeInTheDocument();
    expect(screen.queryByText(launchFor(rootA).openedPath)).not.toBeInTheDocument();
  });

  it("clears the previous root's tree while the next root's own tree is in flight", async () => {
    const roots = twoRepoRoots();
    const rootB = roots.find((root) => root.id === "repo-b")!;
    const answers = hostReads(roots);
    let releaseTree: (value: unknown) => void = () => {};
    const taskOp = vi.fn((taskId: string, op: string, payload: Record<string, unknown>) => {
      if (op === "task/fileTree" && payload["rootId"] === rootB.id) {
        return new Promise<unknown>((resolve) => { releaseTree = resolve; });
      }
      return answers(taskId, op, payload);
    });
    bridge(taskOp);
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    expect(within(await screen.findByTestId("dock-tree-attribution")).getByText(/仓库 repo-a/)).toBeInTheDocument();
    expect(await screen.findByText("a.md")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "repo-b" }));
    // Root A's entries must not stand in for root B's tree while it is in flight.
    await waitFor(() => expect(screen.queryByTestId("dock-tree")).not.toBeInTheDocument());
    expect(screen.getByText("读取中…")).toBeInTheDocument();
    expect(screen.queryByText("a.md")).not.toBeInTheDocument();

    await act(async () => {
      releaseTree(await answers(TASK_ID, "task/fileTree", { rootId: rootB.id }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(within(await screen.findByTestId("dock-tree-attribution")).getByText(/仓库 repo-b/)).toBeInTheDocument();
    expect(await screen.findByText("a.md")).toBeInTheDocument();
  });

  it("names an empty directory the Host answered as empty, and stays apart from a dropped answer", async () => {
    const roots = twoRepoRoots();
    bridge(hostReads(roots, { treeEntries: [] }));
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    // The Host's own answer: this directory IS empty. It is a NAMED state inside
    // the tree it answered for — which is how the user tells it apart from a
    // tree that never arrived (no `dock-tree`) and from a dropped answer.
    const tree = await screen.findByTestId("dock-tree");
    expect(within(tree).getByTestId("dock-tree-empty")).toHaveTextContent("目录为空");
    expect(screen.queryByTestId("dock-stale-answer")).not.toBeInTheDocument();
  });

  it("names every empty Host string it renders instead of leaving a blank", async () => {
    const roots = twoRepoRoots();
    // Parseable-but-empty strings (`str()` keeps `""`) reach the DOM in five
    // shapes: a tree entry's own name, the preview header, the two shared-dir
    // attribution fields that are not the identity line, and the root chip's own
    // label plus the OBSERVED branch value beside it.
    bridge(hostReads(roots, {
      treeEntries: [{ name: "", path: "blank.md", kind: "file", size: 0 }],
      preview: { path: "", language: "" },
    }));
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    const tree = await screen.findByTestId("dock-tree");
    expect(within(tree).getByText("Host 未上报条目名称")).toBeInTheDocument();
    expect(within(tree).queryByText("目录为空")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Host 未上报条目名称"));
    expect(await screen.findByTestId("dock-preview-attribution")).toBeInTheDocument();
    expect(screen.getByText("Host 未上报预览路径")).toBeInTheDocument();
    expect(screen.getByText("Host 未上报语言")).toBeInTheDocument();

    // The same rule on a link root's attribution: the task identity and the
    // unified pi working directory are never blank.
    const linkRoots = sharedOnlyRoots();
    bridge(hostReads(linkRoots, {
      treeAttribution: { ...workspaceAttribution(linkRoots[0]!, TASK_ID, TASK_DIR), taskId: "", piWorkDir: "" },
    }));
    cleanup();
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);
    const linkTree = await screen.findByTestId("dock-tree-attribution");
    expect(linkTree).toHaveTextContent("任务 Host 未上报任务身份");
    expect(within(linkTree).getByTestId("dock-shared-pi-work-dir")).toHaveTextContent("Host 未上报统一工作目录");

    // The same rule on the root chip itself, where the two values the Host can
    // leave empty are the chip's whole content: a blank chip label says nothing
    // about which root was selected, and a bare `· ` (an observed branch whose
    // value is empty) claims a branch exists whose name the Host never gave.
    // `str()` keeps `""` for the label and `observation()` keeps `""` as an
    // OBSERVED value, so the chip is the boundary that must not pass either on.
    const blankChipRoots = twoRepoRoots().map((root, index) =>
      index === 0 ? { ...root, label: "", workingBranch: { state: "observed" as const, value: "" } } : root,
    );
    // Reachability at the renderer's own boundary, not assumed: the shipped
    // parser keeps both values as-is (`str()` keeps `""`; `observation()` keeps
    // an OBSERVED `""`), so exactly this payload reaches the chip.
    expect(workspaceRootsFromHost({ taskDir: TASK_DIR, roots: [blankChipRoots[0]!] })?.roots[0]).toMatchObject({
      label: "",
      workingBranch: { state: "observed", value: "" },
    });
    bridge(hostReads(blankChipRoots));
    cleanup();
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);
    // The chip for the blanked root is the first one; the chip carries exactly
    // the label span and (for an observed branch) the branch span, nothing else.
    const chip = within(await screen.findByTestId("dock-roots")).getAllByRole("button")[0]!;
    expect(chip.querySelector("span")?.textContent).toBe("Host 未上报根名称");
    expect(chip.textContent).toBe("Host 未上报根名称· Host 未上报工作分支名");
    // The metadata row renders the SAME observed value, and the chip's witness
    // has to agree with it: an observed-but-empty branch is named there too.
    expect(await screen.findByTestId("dock-working-branch")).toHaveTextContent("Host 未上报工作分支名（实测）");
  });

  it("names a real root label and a real observed branch as themselves", async () => {
    // The unchanged direction of the rule above: naming an absence must never
    // subsume a value the Host really gave, in the chip or in the row beside it.
    const namedRoots = twoRepoRoots().map((root, index) =>
      index === 0 ? { ...root, workingBranch: { state: "observed" as const, value: "task/task-aaaaaaaa" } } : root,
    );
    bridge(hostReads(namedRoots));
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);
    const chip = within(await screen.findByTestId("dock-roots")).getAllByRole("button")[0]!;
    expect(chip.querySelector("span")?.textContent).toBe("repo-a");
    expect(chip.textContent).toBe("repo-a· task/task-aaaaaaaa");
    expect(await screen.findByTestId("dock-working-branch")).toHaveTextContent("task/task-aaaaaaaa（实测）");
  });

  it("names an unread branch and an unread uncommitted state whose reason the Host left empty", async () => {
    // `observation()` keeps a NAMED `unknown` whose `reason` is `""`; both rows
    // below go through `observedText`, so an unguarded reason would render
    // `未实测：` on its own and claim an unread fact while naming nothing.
    const roots = twoRepoRoots().map((root, index) =>
      index === 0 ? { ...root, workingBranch: { state: "unknown" as const, reason: "" }, dirty: { state: "unknown" as const, reason: "" } } : root,
    );
    bridge(hostReads(roots));
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);
    expect(await screen.findByTestId("dock-working-branch")).toHaveTextContent("未实测：Host 未给出未读原因");
    expect(await screen.findByTestId("dock-uncommitted")).toHaveTextContent("未实测：Host 未给出未读原因");
  });

  it("names an empty editor receipt field instead of leaving a blank", async () => {
    const roots = twoRepoRoots();
    const root = roots.find((entry) => entry.id === "repo-a")!;
    const openTaskEditor = vi.fn(async () => ({ ok: true, payload: { workspaceId: "w", taskId: TASK_ID, op: "task/openEditor", payload: {
      launch: { ...launchFor(root), program: "", openedPath: "", cwd: "", disclosure: "", note: "" },
    } } }));
    editorBridge(vi.fn(hostReads(roots)), openTaskEditor);
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "用外部编辑器打开" }));
    expect(await screen.findByText("外部编辑器已启动（用户显式操作）")).toBeInTheDocument();
    expect(screen.getByText("Host 未上报编辑器程序")).toBeInTheDocument();
    expect(screen.getByText("Host 未上报打开路径")).toBeInTheDocument();
    expect(screen.getByText("Host 未上报编辑器工作目录")).toBeInTheDocument();
    expect(screen.getByText("Host 未上报外部编辑器说明")).toBeInTheDocument();
    expect(screen.getByText("Host 未上报外部编辑器边界说明")).toBeInTheDocument();
  });

  it("refuses by name a delivery target that self-declares a link while the selected root is a worktree", async () => {
    const roots = twoRepoRoots();
    const worktree = roots.find((entry) => entry.id === "repo-a")!;
    // The mirror of the case above: the payload answers the worktree root's OWN
    // id (so the identity check passes) but declares itself a plain-directory
    // link. `deliveryTargetIsShown` is false either way, but the refusal text
    // must name the RENDERER's own kind — repeating the payload's self-
    // description back as the panel's conclusion is the very pattern this
    // slice exists to kill.
    bridge(hostReads(roots, { delivery: { ok: true, payload: { target: {
      attribution: { ...workspaceAttribution(worktree, TASK_ID, TASK_DIR), rootKind: "shared-dir" },
      repo: "sample-repo",
      branch: "sample-branch",
      autoCommit: false,
      autoPush: false,
      autoMerge: false,
    } } } }));
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    const notice = await screen.findByTestId("dock-delivery-notice");
    // The renderer's kind is named, not the payload's claim.
    expect(notice).toHaveTextContent(
      "Host 交付目标自述为普通目录链接，与所选根（工作树）不符：本面板只按所选根的类型判定，不显示 Git 交付目标",
    );
    // It must NOT assert the panel's own conclusion that the selected root is a
    // plain-directory link.
    expect(notice).not.toHaveTextContent("Host 交付目标与根类型不符：普通目录链接没有 Git 交付");
    expect(screen.queryByTestId("dock-delivery")).not.toBeInTheDocument();
    expect(screen.queryByText(/sample-repo/)).not.toBeInTheDocument();
    expect(screen.queryByText(/sample-branch/)).not.toBeInTheDocument();
    // The worktree-only metadata block is on the SAME screen as the refusal, so
    // the panel cannot be calling the selected root a plain-directory link.
    expect(await screen.findByTestId("dock-working-branch")).toBeInTheDocument();
  });

  it("does not offer the Git diff affordance on a link root whose own preview claims to be a worktree", async () => {
    const roots = sharedOnlyRoots();
    const link = roots[0]!;
    // The preview answers the link root's own id but self-declares a worktree.
    // The renderer's own knowledge of the selected root's kind is what keeps
    // the Git button off a plain-directory link.
    bridge(hostReads(roots, {
      previewAttribution: { ...workspaceAttribution(link, TASK_ID, TASK_DIR), rootKind: "worktree", repo: "sample-repo" },
    }));
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    fireEvent.click(await screen.findByText("a.md"));
    const preview = await screen.findByTestId("dock-preview-attribution");
    // The payload parsed and its own claim is rendered…
    expect(preview).toHaveAttribute("data-root-kind", "worktree");
    // …but no Git affordance is offered on the link root.
    expect(screen.queryByRole("button", { name: "改动" })).not.toBeInTheDocument();
  });

  it("keeps the newest directory's entries when two same-root tree answers land out of order", async () => {
    const roots = twoRepoRoots();
    const rootA = roots.find((entry) => entry.id === "repo-a")!;
    const answers = hostReads(roots, { treeEntries: [
      { name: "d1", path: "d1", kind: "dir" },
      { name: "d2", path: "d2", kind: "dir" },
    ] });
    const held: Array<{ relative: string; resolve: (value: unknown) => void }> = [];
    const taskOp = vi.fn((taskId: string, op: string, payload: Record<string, unknown>) => {
      // Only the two directory navigations (a `relative`) are held; the root
      // read is answered normally.
      if (op === "task/fileTree" && payload["relative"] !== undefined) {
        return new Promise<unknown>((resolve) => { held.push({ relative: String(payload["relative"]), resolve }); });
      }
      return answers(taskId, op, payload);
    });
    const treeFor = (relative: string, name: string) => ({
      ok: true,
      payload: { tree: {
        attribution: workspaceAttribution(rootA, TASK_ID, TASK_DIR),
        path: relative,
        entries: [{ name, path: `${relative}/${name}`, kind: "file", size: 1 }],
        truncated: false,
      } },
    });
    bridge(taskOp);
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    // Two directory clicks while the first answer is still in flight.
    fireEvent.click(await screen.findByText("d1"));
    fireEvent.click(screen.getByText("d2"));
    expect(held.map((entry) => entry.relative)).toEqual(["d1", "d2"]);
    const release = (relative: string, value: unknown) => {
      const index = held.findIndex((entry) => entry.relative === relative);
      held.splice(index, 1)[0]!.resolve(value);
    };

    // The NEWEST answer (d2) lands first…
    await act(async () => {
      release("d2", treeFor("d2", "second.md"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(await screen.findByText("second.md")).toBeInTheDocument();

    // …then the older one (d1) lands LAST: it belongs to a directory the user
    // has left, so it must not replace the newest directory's entries.
    await act(async () => {
      release("d1", treeFor("d1", "first.md"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByText("second.md")).toBeInTheDocument();
    expect(screen.queryByText("first.md")).not.toBeInTheDocument();
  });

  it("clears the drop notice once a fresh answer for the same region is accepted", async () => {
    const roots = twoRepoRoots();
    const rootA = roots.find((entry) => entry.id === "repo-a")!;
    const rootB = roots.find((entry) => entry.id === "repo-b")!;
    const answers = hostReads(roots);
    let previewCalls = 0;
    const taskOp = vi.fn((taskId: string, op: string, payload: Record<string, unknown>) => {
      if (op === "task/filePreview") {
        previewCalls += 1;
        // The FIRST preview answer is misattributed (names root B though it
        // answers root A's read); the second is the real one.
        return Promise.resolve({ ok: true, payload: { preview: {
          attribution: workspaceAttribution(previewCalls === 1 ? rootB : rootA, TASK_ID, TASK_DIR),
          path: "a.md", language: "markdown", source: "# x", truncated: false,
        } } });
      }
      return answers(taskId, op, payload);
    });
    bridge(taskOp);
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    fireEvent.click(await screen.findByText("a.md"));
    expect(await screen.findByTestId("dock-stale-answer")).toHaveTextContent(
      "Host 预览响应自述根 repo-b 与所请求的根 repo-a 不符：本面板不显示",
    );
    expect(screen.queryByTestId("dock-preview-attribution")).not.toBeInTheDocument();

    // A fresh, accepted answer for the SAME region: the notice has done its job.
    fireEvent.click(screen.getByText("a.md"));
    expect(await screen.findByTestId("dock-preview-attribution")).toHaveTextContent("仓库 repo-a");
    expect(screen.queryByTestId("dock-stale-answer")).not.toBeInTheDocument();
  });

  it("clears a drop notice for a region the new root does not re-read when another root is selected", async () => {
    const roots = twoRepoRoots();
    const rootA = roots.find((entry) => entry.id === "repo-a")!;
    const rootB = roots.find((entry) => entry.id === "repo-b")!;
    const answers = hostReads(roots);
    let previewCalls = 0;
    const taskOp = vi.fn((taskId: string, op: string, payload: Record<string, unknown>) => {
      if (op === "task/filePreview") {
        previewCalls += 1;
        return Promise.resolve({ ok: true, payload: { preview: {
          attribution: workspaceAttribution(previewCalls === 1 ? rootB : rootA, TASK_ID, TASK_DIR),
          path: "a.md", language: "markdown", source: "# x", truncated: false,
        } } });
      }
      return answers(taskId, op, payload);
    });
    bridge(taskOp);
    render(<DesktopToolDock taskId={TASK_ID} tool="files" onClose={() => {}} />);

    // A preview drop on root A lands and is named…
    fireEvent.click(await screen.findByText("a.md"));
    expect(await screen.findByTestId("dock-stale-answer")).toHaveTextContent(
      "Host 预览响应自述根 repo-b 与所请求的根 repo-a 不符：本面板不显示",
    );

    // …and selecting another root is the one event that can make its "当前根 …"
    // stale, so it is cleared. The 预览响应 region is NOT re-read by the chip
    // switch, so only the selectRoot clearing can remove it.
    fireEvent.click(screen.getByRole("button", { name: "repo-b" }));
    expect(await screen.findByTestId("dock-tree-attribution")).toHaveTextContent("仓库 repo-b");
    expect(screen.queryByTestId("dock-stale-answer")).not.toBeInTheDocument();
  });
});
