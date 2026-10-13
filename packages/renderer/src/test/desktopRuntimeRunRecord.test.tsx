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
const ENVIRONMENT_ID = "e-11111111-1111-1111-1111-111111111111";
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

/**
 * The REAL Host emit for a run that was really observed: the same
 * `TaskServiceTopology` `host.ts` writes, with the group runner's own
 * observations attached through `verifyRun` (the existing verification shape).
 */
/**
 * A real Host emit of a run NOBODY observed: the unit is in the plan, so
 * `recordRun` adds no "not selected" note, and no verification was ever
 * attached. This is the payload that must read 未探测 by name.
 */
function unobservedRunRecordsPayload() {
  const topology = new TaskServiceTopology("task-1", "/tmp/task-1", () => STARTED_AT);
  topology.setPlan({
    units: [{ unitId: "repo:svc", serviceId: SERVICE_ID, name: "invoice-local", repoDir: "repo", location: "local", runType: "long-lived" }],
    selectedRepoDirs: ["repo"],
    requests: [{ unitId: "repo:svc", port: 4100 }],
  });
  topology.recordRun({
    serviceId: SERVICE_ID, templateVersion: "2", ports: [4100], portsSource: "declared", pid: 4242, owner: "human", startedAt: STARTED_AT,
  });
  return { records: topology.runs(), registered: topology.registeredIdentities() };
}

/**
 * A real Host emit for a run whose unit is NOT in the current selection: the
 * Host records a `selection-note` (a structural marker, NOT a probe result).
 * This is the payload that must read 未探测, never 未监听.
 */
function selectionNoteRunRecordsPayload() {
  const topology = new TaskServiceTopology("task-1", "/tmp/task-1", () => STARTED_AT);
  // No `setPlan`, so the recorded service has no selected unit.
  topology.recordRun({
    serviceId: SERVICE_ID, templateVersion: "2", ports: [4100], portsSource: "declared", pid: 4242, owner: "human", startedAt: STARTED_AT,
  });
  return { records: topology.runs(), registered: topology.registeredIdentities() };
}

function observedRunRecordsPayload() {
  const topology = new TaskServiceTopology("task-1", "/tmp/task-1", () => STARTED_AT);
  topology.recordRun({
    serviceId: SERVICE_ID, templateVersion: "2", ports: [4100], portsSource: "declared", pid: 4242, owner: "human", startedAt: STARTED_AT,
  });
  topology.verifyRun("run-1", { kind: "readiness", detail: "已监听 127.0.0.1:4100（真实连接成功）", ok: true });
  topology.verifyRun("run-1", { kind: "linkage", detail: "联通检查 invoice-local: 已互验：真实连接到达 127.0.0.1:4100", ok: true });
  return { records: topology.runs(), registered: topology.registeredIdentities() };
}

/**
 * The REAL Host emit for a run whose code state main really observed ([PiDock 05]
 * #10 box 6): the same `TaskServiceTopology.recordRun` projector `host.ts`
 * calls, with the observation `main/service-code-observation.ts` produced. No
 * build commit is passed, because nothing in the service model names one.
 */
function observedCodeRunRecordsPayload(code: { commit: string; dirty: boolean }) {
  const topology = new TaskServiceTopology("task-1", "/tmp/task-1", () => STARTED_AT);
  topology.recordRun({
    serviceId: SERVICE_ID, templateVersion: "2", ports: [4100], portsSource: "declared",
    code, pid: 4242, owner: "human", startedAt: STARTED_AT,
  });
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
    if (request["op"] === "taskBindings") return { ok: true, payload: [{ taskId: "task-1", serviceId: SERVICE_ID, environmentId: ENVIRONMENT_ID, environmentName: "本地开发", templateVersion: 2, rootId: "invoice-service", subdir: "", privateKeys: [] }] };
    if (request["op"] === "list") return { ok: true, payload: [{ projectId: "project-1", environmentId: ENVIRONMENT_ID, serviceId: SERVICE_ID, version: 2, shared: [], descriptor: { name: "invoice-local", program: "node", args: ["server.js"], ports: [4100], runType: "long-lived" } }] };
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
    expect(runRecordsFromHost(payload, "task-1")?.get(SERVICE_ID)).toMatchObject({ runId: "run-1", portsSource: "declared" });

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

  it("renders the code state main really observed, not a fixture value", async () => {
    const HEAD = "0123456789abcdef0123456789abcdef01234567";
    bridgeWithRunRecords({ ok: true, payload: observedCodeRunRecordsPayload({ commit: HEAD, dirty: false }) });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    const clean = await screen.findByTestId("dock-run-record");
    // The REAL value end to end: the observation the Host recorded, through the
    // real parser, into the shipped dock's own row.
    expect(clean).toHaveTextContent(`已提交且干净 · ${HEAD}`);
    // Nobody observed a build commit, so the build row says so instead of
    // inheriting the code commit as a build.
    expect(clean).toHaveTextContent("无法判断构建状态");
    expect(clean).not.toHaveTextContent("构建与当前提交一致");
    cleanup();

    bridgeWithRunRecords({ ok: true, payload: observedCodeRunRecordsPayload({ commit: HEAD, dirty: true }) });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    const dirty = await screen.findByTestId("dock-run-record");
    // Uncommitted code is distinguishable from a clean commit AND from a stale
    // build, and the dirty observation never reads as a fresh build.
    expect(dirty).toHaveTextContent(`有未提交修改 · ${HEAD}`);
    expect(dirty).toHaveTextContent("工作副本有未提交修改，构建不含这些改动");
    expect(dirty).not.toHaveTextContent("构建与当前提交一致");
  });

  it("keeps rendering 未知 for a run whose code state nobody observed", async () => {
    bridgeWithRunRecords({ ok: true, payload: unobservedRunRecordsPayload() });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    const record = await screen.findByTestId("dock-run-record");
    // The legitimate `unknown`: no observation was made, so the row must not show
    // a commit, a clean tree or a fresh build.
    expect(record).toHaveTextContent("缺少提交信息");
    expect(record).toHaveTextContent("无法判断构建状态");
    expect(record).not.toHaveTextContent("已提交且干净");
    expect(record).not.toHaveTextContent("有未提交修改");
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

  it("labels the run's REAL observations 已监听 / 已互验, never conflating them with 已启动", async () => {
    bridgeWithRunRecords({ ok: true, payload: observedRunRecordsPayload() });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    await screen.findByTestId("dock-run-record");
    const observed = await screen.findByTestId("dock-run-verification");
    // The two distinct facts the group runner really observed.
    expect(observed).toHaveTextContent("联通核验：已监听 · 已监听 127.0.0.1:4100（真实连接成功）");
    expect(observed).toHaveTextContent("联通核验：已互验 · 联通检查 invoice-local: 已互验：真实连接到达 127.0.0.1:4100");
    // 已启动 stays the run's own pid row; nothing here invents a listening or a
    // verified state from the process having started.
    expect(await screen.findByTestId("dock-run-record")).toHaveTextContent("进程标识");
  });

  it("names 未探测 when the run record carries no observation at all", async () => {
    bridgeWithRunRecords({ ok: true, payload: unobservedRunRecordsPayload() });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    const absent = await screen.findByTestId("dock-run-verification");
    expect(absent).toHaveTextContent("联通核验：未探测（运行记录没有实测监听/联通结果）");
    expect(absent).not.toHaveTextContent("已互验");
    expect(absent).not.toHaveTextContent("已监听");
  });

  it("reads a unit-not-in-selection note as 未探测, never as a failed probe (未监听)", async () => {
    bridgeWithRunRecords({ ok: true, payload: selectionNoteRunRecordsPayload() });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    const note = await screen.findByTestId("dock-run-verification");
    // The Host recorded a structural note, not a probe: nobody observed this
    // address, so it must read 未探测 instead of a failed listening probe.
    expect(note).toHaveTextContent("未探测");
    expect(note).not.toHaveTextContent("未监听");
    expect(note).not.toHaveTextContent("已监听");
  });

  it("names a blank 模板版本 and a blank 核验细节 instead of an empty cell or a bare separator", async () => {
    // `runRecordFromHost` reads `templateVersion` with a length CAP only
    // (`typeof === "string" && length > 200`) and a verification `detail` with
    // `typeof === "string"`, so both can be `""`; the row then read
    // `模板版本 ` and `联通核验：已监听 · `.
    const payload = realRunRecordsPayload({ portsSource: "declared" });
    bridgeWithRunRecords({ ok: true, payload: { ...payload, records: [{
      ...(payload.records[0] as unknown as Record<string, unknown>),
      templateVersion: "",
      verifications: [{ kind: "readiness", detail: "", ok: true, at: STARTED_AT }],
    }] } });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    expect(await screen.findByTestId("dock-run-record")).toHaveTextContent("Host 未上报模板版本");
    expect(await screen.findByTestId("dock-run-verification")).toHaveTextContent("联通核验：已监听 · Host 未上报核验细节");
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

  it("refuses a foreign-task run even when its service ID matches the binding", async () => {
    const payload = realRunRecordsPayload({ portsSource: "observed" });
    const foreign = { ...payload.records[0]!, taskId: "task-2", instanceId: `task-2/${SERVICE_ID}@4100` };
    bridgeWithRunRecords({ ok: true, payload: { ...payload, records: [foreign] } });
    render(<DesktopToolDock taskId="task-1" tool="runtime" onClose={() => {}} />);
    expect(await screen.findByTestId("dock-run-record-error")).toHaveTextContent("Host 运行记录响应无法解析");
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
