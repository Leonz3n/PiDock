import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProtocolPanel } from "../components/ToolPanels";
import { protocolBindingFromHost, type ProtocolBindingView } from "../data/protocolBinding";
import { renderApp } from "./helpers";

/**
 * [PiDock 08] (#14) protocol panel: box 1 (protocol repo / generation steps /
 * consumer bindings + prepare state + actual generated version), boxes 3-6
 * (Go workspace binding, TS managed link, resolution + staleness marks) and
 * box 8 (platform toolchain with the Windows ARM64 gap explicit). The panel
 * only shows what the view carries.
 */
const LOCAL_VIEW: ProtocolBindingView = {
  taskId: "task-a1f92c3d",
  mode: "local",
  simulated: false,
  protocol: { repoDir: "/data/tasks/task-a1f92c3d/apis", goGenDir: "/data/tasks/task-a1f92c3d/apis/gen/go", tsGenDir: "/data/tasks/task-a1f92c3d/apis/gen/ts" },
  runsGeneration: true,
  generationSteps: [
    { kind: "generate", program: "make", args: ["generate"], cwd: "/data/tasks/task-a1f92c3d/apis", note: "生成" },
    { kind: "postprocess", program: "pnpm", args: ["--filter", "@shipber/proto", "build"], cwd: "/data/tasks/task-a1f92c3d/apis", note: "后处理" },
  ],
  generationReason: "本地联调：在本任务生成目录执行完整生成与后处理",
  generatedVersion: "gen-4",
  generatedAt: "2026-09-22T12:00:00.000Z",
  consumers: [
    {
      consumerId: "invoice",
      name: "invoice-service",
      language: "go",
      repoDir: "/data/tasks/task-a1f92c3d/invoice-service",
      releaseDependency: "github.com/shipber/apis v0.0.69",
      binding: {
        kind: "go-workspace",
        path: "/data/tasks/task-a1f92c3d/protocol/go-work/invoice/go.work",
        useDirectories: ["/data/tasks/task-a1f92c3d/invoice-service", "/data/tasks/task-a1f92c3d/apis/gen/go"],
        excludedConsumers: ["shipment"],
        releaseManifestsUntouched: ["/data/tasks/task-a1f92c3d/invoice-service/go.mod"],
      },
      state: "needs-compile",
      stateDetail: "绑定的是 gen-3，当前产物是 gen-4；需要重新生成并编译",
      resolution: { ok: false, message: "「invoice-service」解析到 /data/go/pkg/mod/...，不在本任务生成目录内" },
    },
    {
      consumerId: "bff",
      name: "saas-bff",
      language: "ts",
      repoDir: "/data/tasks/task-a1f92c3d/front-monorepo",
      releaseDependency: "@shipber/proto 0.0.108",
      binding: {
        kind: "ts-link",
        linkPath: "/data/tasks/task-a1f92c3d/front-monorepo/node_modules/@shipber/proto",
        artifact: "/data/tasks/task-a1f92c3d/apis/gen/ts",
        marker: "pidock-local-protocol:task-a1f92c3d:bff:/data/tasks/task-a1f92c3d/apis/gen/ts",
        restore: { program: "pnpm", args: ["run", "proto:link-local", "--app", "saas-bff"] },
      },
      state: "ready",
      stateDetail: "已使用本任务产物 gen-4",
    },
  ],
  prepare: [
    { state: "code-ready", label: "代码就绪", ok: true, detail: "协议仓库与生成目录已配置" },
    { state: "toolchain-ready", label: "工具链就绪", ok: false, detail: "win32-arm64：Windows ARM64 不是首版发布架构" },
    { state: "deps-installed", label: "依赖已安装", ok: true, detail: "所选消费者依赖已安装" },
    { state: "generated", label: "生成物已更新", ok: true, detail: "实际生成版本：gen-4" },
    { state: "binding-valid", label: "本地绑定有效", ok: false, detail: "绑定缺失或未验证：invoice-service" },
    { state: "runtime-reachable", label: "运行环境可达", ok: false, detail: "运行环境可达性未检查（不等同于生成成功）" },
  ],
  toolchain: {
    platform: "win32-arm64",
    ok: false,
    note: "Windows ARM64 不是首版发布架构；桌面可启动不能推断生成支持",
    desktopLaunchImpliesGeneration: false,
    entries: [{ toolId: "buf", label: "buf", status: "unsupported-platform", detail: "安装脚本不支持 Windows ARM64" }],
  },
  blockers: [{ consumerId: "shipment", code: "cross-version-unverified", message: "不能假定同一本地产物全部兼容，请逐个确认解析路径" }],
  diagnostics: [{ code: "not-generated", message: "本地联调还没有生成产物版本" }],
};

/**
 * A Host `task/protocolState` payload with every string field left blank, as the
 * Host sends it. The panel's blank case below runs this through the SHIPPED
 * parser (`protocolBindingFromHost`) instead of hand-building a view, so the
 * fixture proves its own claim that `String(x ?? "")` keeps `""` for each of
 * these fields — a hand-built view can drift from the parser and hide one
 * (`generatedVersion` was exactly that).
 */
const BLANK_PAYLOAD = {
  state: {
    taskId: "task-blank",
    mode: "local",
    protocol: { repoDir: "", goGenDir: "", tsGenDir: "" },
    generatedVersion: "",
    consumers: [
      {
        consumerId: "blank-go", name: "", language: "go", repoDir: "", releaseDependency: "",
        staleness: { state: "needs-binding", detail: "" },
        resolution: { ok: false, message: "" },
        binding: { kind: "go-workspace", path: "", useDirectories: [], excludedConsumers: [], releaseManifestsUntouched: [] },
      },
      {
        consumerId: "blank-ts", name: "ts-consumer", language: "ts", repoDir: "", releaseDependency: "",
        staleness: { state: "ready", detail: "已使用本任务产物 gen-4" },
        binding: { kind: "ts-link", linkPath: "", artifact: "", marker: "", restore: { program: "", args: [] } },
      },
      {
        consumerId: "blank-release", name: "release-consumer", language: "go", repoDir: "", releaseDependency: "",
        staleness: { state: "ready", detail: "已使用本任务产物 gen-4" },
        binding: { kind: "release", dependency: "" },
      },
    ],
    generation: { reason: "", runsGeneration: true, steps: [{ kind: "generate", program: "", args: [], cwd: "", note: "" }] },
    prepare: [{ state: "code-ready", label: "", ok: false, detail: "" }],
    toolchain: { platform: "", ok: false, note: "", entries: [{ toolId: "blank-tool", label: "", status: "unverified", detail: "" }] },
    switchAssessment: { blockers: [{ consumerId: "blank-go", code: "", message: "" }] },
    diagnostics: [{ code: "", message: "" }],
  },
};

const blankView = (overrides: Record<string, unknown> = {}): ProtocolBindingView => {
  const view = protocolBindingFromHost("task-blank", { state: { ...BLANK_PAYLOAD.state, ...overrides } });
  if (view === undefined) throw new Error("blank payload must parse");
  return view;
};

const BLANK_VIEW = blankView();

describe("protocol panel", () => {
  it("shows the protocol repository, the actual generated version and the generation steps", () => {
    render(<ProtocolPanel view={LOCAL_VIEW} />);
    expect(screen.getByTestId("protocol-summary")).toHaveTextContent("/data/tasks/task-a1f92c3d/apis");
    expect(screen.getByTestId("protocol-summary")).toHaveTextContent("本地联调（本任务产物）");
    expect(screen.getByTestId("protocol-generated-version")).toHaveTextContent("实际生成版本：gen-4");
    expect(screen.getByTestId("protocol-generated-version")).toHaveTextContent("2026-09-22T12:00:00.000Z");
    const steps = screen.getByTestId("protocol-steps");
    expect(steps).toHaveTextContent("生成 make generate");
    expect(steps).toHaveTextContent("后处理 pnpm --filter @shipber/proto build");
  });

  it("lists every prepare state with its own result", () => {
    render(<ProtocolPanel view={LOCAL_VIEW} />);
    const prepare = screen.getByTestId("protocol-prepare");
    for (const label of ["代码就绪", "工具链就绪", "依赖已安装", "生成物已更新", "本地绑定有效", "运行环境可达"]) {
      expect(prepare).toHaveTextContent(label);
    }
    expect(prepare).toHaveTextContent("✓ 生成物已更新：实际生成版本：gen-4");
    expect(prepare).toHaveTextContent("○ 运行环境可达：运行环境可达性未检查");
  });

  it("shows the task-scoped Go workspace without merging other consumers and the TS restore command", () => {
    render(<ProtocolPanel view={LOCAL_VIEW} />);
    const consumers = screen.getByTestId("protocol-consumers");
    expect(consumers).toHaveTextContent("任务工作区：/data/tasks/task-a1f92c3d/protocol/go-work/invoice/go.work");
    expect(consumers).toHaveTextContent("未并入（避免合并依赖选择）：shipment");
    expect(consumers).toHaveTextContent("不改写发布配置：/data/tasks/task-a1f92c3d/invoice-service/go.mod");
    expect(consumers).toHaveTextContent("受管链接：/data/tasks/task-a1f92c3d/front-monorepo/node_modules/@shipber/proto");
    expect(consumers).toHaveTextContent("恢复绑定：pnpm run proto:link-local --app saas-bff");
    // Box 5: the failing resolution is shown as未通过, not as a green check.
    expect(consumers).toHaveTextContent("解析路径：未通过");
    expect(consumers).toHaveTextContent("需重新编译");
  });

  it("shows the stop reason, the diagnostics and the platform toolchain gap", () => {
    render(<ProtocolPanel view={LOCAL_VIEW} />);
    expect(screen.getByTestId("protocol-diagnostics")).toHaveTextContent("cross-version-unverified");
    expect(screen.getByTestId("protocol-diagnostics")).toHaveTextContent("不能假定同一本地产物全部兼容");
    expect(screen.getByTestId("protocol-diagnostics")).toHaveTextContent("not-generated");
    const toolchain = screen.getByTestId("protocol-toolchain");
    expect(toolchain).toHaveTextContent("buf：平台不支持");
    expect(screen.getByText(/桌面可启动不等同于生成支持/)).toBeInTheDocument();
    expect(screen.getByTestId("protocol-stale-note")).toHaveTextContent("1 个消费者需要重新生成/编译/重启");
  });

  it("names every blank Host string it renders instead of leaving a blank", () => {
    // Reachability at the panel's own boundary: `protocolBindingFromHost` keeps
    // `""` for each of these fields, and `validProtocolState` accepts it too
    // (its own `text` is `typeof === "string"`), so a blank payload really does
    // arrive here. Every one of them has to name the absence rather than print
    // a bare `受管链接：` or `· [`.
    render(<ProtocolPanel view={BLANK_VIEW} />);
    expect(screen.getByTestId("protocol-generated-version")).toHaveTextContent("Host 未上报生成说明");
    // A blank version is a string the Host DID report (`protocolBindingFromHost`
    // keeps `""`), so it is named; only the absent `null` is 尚未生成.
    expect(screen.getByTestId("protocol-generated-version")).toHaveTextContent("实际生成版本：Host 未上报生成版本");
    expect(screen.getByTestId("protocol-steps")).toHaveTextContent("生成 Host 未上报步骤程序");
    expect(screen.getByTestId("protocol-prepare")).toHaveTextContent("Host 未上报准备项名称：Host 未上报准备项说明");
    const consumers = screen.getByTestId("protocol-consumers");
    expect(consumers).toHaveTextContent("Host 未上报消费者名称 · Go · 需绑定");
    expect(consumers).toHaveTextContent("任务工作区：Host 未上报工作区文件");
    expect(consumers).toHaveTextContent("受管链接：Host 未上报受管链接路径");
    expect(consumers).toHaveTextContent("发布依赖：Host 未上报发布依赖");
    expect(consumers).toHaveTextContent("恢复绑定：Host 未上报恢复程序");
    expect(consumers).toHaveTextContent("Host 未上报状态说明");
    expect(consumers).toHaveTextContent("解析路径：未通过 Host 未给出解析说明");
    const diagnostics = screen.getByTestId("protocol-diagnostics");
    expect(diagnostics).toHaveTextContent("[Host 未上报停止原因代码] Host 未上报停止原因");
    expect(diagnostics).toHaveTextContent("[Host 未上报诊断代码] Host 未上报诊断说明");
    expect(screen.getByTestId("protocol-toolchain")).toHaveTextContent("Host 未上报工具名称：未检查");

    // The toolchain note is the whole list only when there is no entry at all.
    cleanup();
    render(<ProtocolPanel view={{ ...BLANK_VIEW, toolchain: { ...BLANK_VIEW.toolchain, entries: [] } }} />);
    expect(screen.getByTestId("protocol-toolchain")).toHaveTextContent("Host 未上报工具链说明");

    // `null` is the Host's own "nothing generated yet" and keeps its own wording:
    // the two absences are not the same state.
    cleanup();
    render(<ProtocolPanel view={blankView({ generatedVersion: null })} />);
    expect(screen.getByTestId("protocol-generated-version")).toHaveTextContent("实际生成版本：尚未生成");
  });
});

describe("protocol panel in the task view", () => {
  it("opens from the task header and shows the memory projection honestly", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    await user.click(screen.getByRole("button", { name: "协议" }));
    const summary = await screen.findByTestId("protocol-summary");
    expect(summary).toHaveTextContent("发布依赖");
    expect(summary).toHaveTextContent("内存投影（非 Host 结果）");
    expect(screen.getByTestId("protocol-generated-version")).toHaveTextContent("实际生成版本：尚未生成");
    // No fabricated generation result: every prepare state stays unclaimed.
    expect(screen.getByTestId("protocol-prepare")).toHaveTextContent("生成物已更新");
    const consumers = screen.getByTestId("protocol-consumers");
    expect(consumers).toHaveTextContent("invoice-service");
    expect(consumers).toHaveTextContent("发布依赖：github.com/shipber/apis v0.0.69");
    expect(screen.getByTestId("protocol-toolchain")).toHaveTextContent("内存模式未探测生成工具");
  });
});
