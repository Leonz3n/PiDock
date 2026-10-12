/**
 * [PiDock 05] (#10 box 6) the PRODUCTION 运行 panel reads the Host's real run
 * record.
 *
 * The run record only reaches the shipped dock if the dock itself reads
 * `task/serviceRunRecords`; the earlier slice rendered it in the demo
 * `RuntimePanel` (`ToolPanels.tsx`), which the packaged app never mounts. The
 * "real payload" below is projected by the Host's OWN `TaskServiceTopology`
 * (`recordRun` + `runs()`, the exact object `host.ts` serves), not a
 * hand-written literal, so a rename of a real field fails here instead of
 * silently degrading to the 尚无记录 state.
 *
 * Honesty rules pinned here:
 *  - a DECLARED port never reads as 实测监听 (the Host owns no port probe);
 *  - a service with no run record says so BY NAME;
 *  - a malformed payload yields the named refusal, never a fixture value.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopToolDock } from "../components/DesktopToolDock";
import { runRecordsFromHost, RUN_RECORD_KEYS } from "../data/taskServices";
import { TaskServiceTopology } from "../../../shell/src/host/service-topology.js";

const SERVICE_ID = "s-11111111-1111-1111-1111-111111111111";
const STARTED_AT = "2026-10-08T00:00:00.000Z";

/**
 * The REAL Host emit for `task/serviceRunRecords`: `TaskServiceTopology.recordRun`
 * is the projector `host.ts:recordServiceRun` calls after a gated start, and
 * `runs()` is the list the op returns. `portsSource` and `exitReason` are the
 * caller's own observations, so a declared port is declared here too.
 */
function realRunRecordsPayload(input: { portsSource: "declared" | "observed"; exitReason?: string }) {
  const topology = new TaskServiceTopology("task-1", "/tmp/task-1", () => STARTED_AT);
  topology.recordRun({
    serviceId: SERVICE_ID,
    templateVersion: "2",
    ports: [4100],
    portsSource: input.portsSource,
    pid: 4242,
    owner: "human",
    startedAt: STARTED_AT,
  });
  if (input.exitReason !== undefined) topology.exitRun("run-1", input.exitReason);
  return { records: topology.runs(), registered: topology.registeredIdentities() };
}

/** One bound service in project-1, with the run-record op stubbed to `answer`. */
function bridgeWithRunRecords(answer: unknown) {
  const taskOp = vi.fn(async (_taskId: string, op: string) => {
    if (op === "task/serviceRunRecords") return answer;
    if (op === "task/serviceStatus") {
      return { ok: true, payload: { service: { serviceId: SERVICE_ID, lifecycle: "running", templateVersion: "2", health: "not-probed", launchSource: "catalog", resolved: [] } } };
    }
    return { ok: false, error: `unexpected ${op}` };
  });
  const serviceCatalogOp = vi.fn(async (request: Record<string, unknown>) => {
    if (request["op"] === "taskBindings") return { ok: true, payload: [{ taskId: "task-1", serviceId: SERVICE_ID, templateVersion: 2, rootId: "invoice-service", subdir: "", privateKeys: [] }] };
    if (request["op"] === "list") return { ok: true, payload: [{ projectId: "project-1", serviceId: SERVICE_ID, version: 2, shared: [], descriptor: { name: "invoice-local", program: "node", args: ["server.js"], ports: [4100], runType: "long-lived" } }] };
    return { ok: false, error: `unexpected ${request["op"]}` };
  });
  const projectOp = vi.fn(async () => ({ ok: true, payload: { roots: [], tasks: [{ taskId: "task-1", projectId: "project-1", state: "assigned" }] } }));
  window.pidock = { taskOp, serviceCatalogOp, projectOp } as unknown as typeof window.pidock;
  return { taskOp, serviceCatalogOp, projectOp };
}

afterEach(() => {
  cleanup();
  delete (window as { pidock?: unknown }).pidock;
});

describe("[UI 对齐] S8d production 运行 panel reads the Host run record", () => {
  it("renders the real Host run record in the production dock", async () => {
    const payload = realRunRecordsPayload({ portsSource: "declared", exitReason: "user-request" });
    // The seam: the REAL projector's payload is accepted by the REAL parser, and
    // every key it emits is in the parser's allowlist.
    const emitted = Object.keys(payload.records[0] as unknown as Record<string, unknown>);
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.every((key) => (RUN_RECORD_KEYS as readonly string[]).includes(key))).toBe(true);
    expect(runRecordsFromHost(payload)?.get(SERVICE_ID)).toMatchObject({ runId: "run-1", portsSource: "declared" });

    bridgeWithRunRecords({ ok: true, payload });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);

    // THE FAILING ASSERTION when the production dock stops reading
    // `task/serviceRunRecords`: without the read the row renders the
    // 尚无本任务实测启动记录 state and this `dock-run-record` never appears.
    const record = await screen.findByTestId("dock-run-record");
    expect(record).toHaveTextContent("运行标识");
    expect(record).toHaveTextContent("run-1");
    expect(record).toHaveTextContent("模板版本");
    expect(record).toHaveTextContent("代码状态");
    expect(record).toHaveTextContent("缺少提交信息");
    expect(record).toHaveTextContent("构建状态");
    expect(record).toHaveTextContent("无法判断构建状态");
    expect(record).toHaveTextContent("端口");
    expect(record).toHaveTextContent("127.0.0.1:4100（配方声明端口 · 未实测监听）");
    expect(record).toHaveTextContent("进程标识");
    expect(record).toHaveTextContent("用户操作 · pid 4242 · 2026-10-08T00:00:00.000Z");
    expect(record).toHaveTextContent("日志入口");
    expect(record).toHaveTextContent(`/tmp/task-1/services/${SERVICE_ID}/run-run-1.log`);
    expect(record).toHaveTextContent("结束原因");
    expect(record).toHaveTextContent("user-request");
    // No argv / raw environment ever reaches the renderer.
    expect(record).not.toHaveTextContent("server.js");
  });

  it("never renders a DECLARED port as 实测监听", async () => {
    bridgeWithRunRecords({ ok: true, payload: realRunRecordsPayload({ portsSource: "declared" }) });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    const record = await screen.findByTestId("dock-run-record");
    expect(record).toHaveTextContent("127.0.0.1:4100（配方声明端口 · 未实测监听）");
    // The Host owns no port probe, so the observed token must never appear for a
    // declared list. Turning the declared branch into 实测监听 reddens this line.
    expect(record).not.toHaveTextContent("（实测监听）");
  });

  it("names the observed origin only when the record really observed the socket", async () => {
    bridgeWithRunRecords({ ok: true, payload: realRunRecordsPayload({ portsSource: "observed" }) });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    expect(await screen.findByTestId("dock-run-record")).toHaveTextContent("127.0.0.1:4100（实测监听）");
  });

  it("names the absent state for a service with no run record instead of implying a run", async () => {
    bridgeWithRunRecords({ ok: true, payload: { records: [], registered: [] } });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    const absent = await screen.findByTestId("dock-run-record-absent");
    expect(absent).toHaveTextContent("尚无本任务实测启动记录");
    expect(screen.queryByTestId("dock-run-record")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dock-run-record-error")).not.toBeInTheDocument();
  });

  it("fails closed on a malformed run-record payload instead of falling back to a fixture", async () => {
    // A pid of -1 makes the whole row unreadable; its `observed` port is exactly
    // the value that must NOT leak through as a real observation.
    bridgeWithRunRecords({ ok: true, payload: { records: [{
      runId: "run-1", taskId: "task-1", serviceId: SERVICE_ID, instanceId: `task-1/${SERVICE_ID}@4100`,
      templateVersion: "2",
      codeState: { kind: "unknown", note: "缺少提交信息，无法判断代码状态" }, buildFreshness: "unknown",
      ports: [4100], portsSource: "observed",
      processIdentity: { owner: "human", pid: -1, startedAt: STARTED_AT },
      logRef: "/tmp/task-1/run.log", startedAt: STARTED_AT, verifications: [],
    }], registered: [] } });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    const error = await screen.findByTestId("dock-run-record-error");
    expect(error).toHaveTextContent("Host 运行记录响应无法解析");
    expect(screen.queryByTestId("dock-run-record")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dock-run-record-absent")).not.toBeInTheDocument();
    expect(screen.queryByText(/（实测监听）/)).not.toBeInTheDocument();
  });

  it("shows the Host's own refusal when the run-record read is refused", async () => {
    bridgeWithRunRecords({ ok: false, error: "unknown-domain: 该任务尚未建立运行记录" });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    expect(await screen.findByTestId("dock-run-record-error")).toHaveTextContent("unknown-domain: 该任务尚未建立运行记录");
    expect(screen.queryByTestId("dock-run-record-absent")).not.toBeInTheDocument();
  });
});
