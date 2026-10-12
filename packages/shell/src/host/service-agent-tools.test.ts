/**
 * [PiDock 04] (#7 box 5) the Agent's service tools, driven through the REAL tool
 * broker with REAL child processes.
 *
 * Evidence split (stated, not implied):
 * - REAL processes: the service fixture is a Node script started by the Host's
 *   own `TaskServiceProcesses` driver (the same `serviceDriverFor` pair
 *   `task/controlService` uses), and every liveness assertion probes the OS
 *   process the child itself reported in its marker file, never a returned flag.
 * - REAL production objects: `host.js`'s own `agentServiceHostFor` (the exact
 *   surface `taskHostFor` hands to `TaskWorkspaceHost`), the real
 *   `TaskWorkspaceHost`, the real `PiSessionChannel` gate, the real task write
 *   coordinator, the real `ServiceCatalog`/`ServiceCatalogAuthority`, the real
 *   `runHumanServiceControl` path and the real durable launch log.
 * - ONE replaced hop: production runs the model context in a worker thread and
 *   calls `broker.call(sessionId, request)` for every tool the model declares
 *   (`sdk-context-client.ts:210`). These tests capture the broker through the
 *   same `toolHost` option that worker receives and call it with the same
 *   signature, so the gate, the broker, the Host control sequence and the
 *   driver are the production ones; only the model/worker is absent (no
 *   Provider turn is started, and no model is stubbed).
 * - The expiry leg additionally builds the real `SdkAgentToolBroker` with the
 *   real channel and the same service surface, only to lower the confirmation
 *   timeout; the cast is limited to the option bag.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PI_GATED_TOOL_NAMES } from "../main/pi-session.js";
import { SERVICE_RUN_HUMAN_LABEL } from "../main/runtime.js";
import { ServiceCatalog, type ServiceCatalogAuthority } from "../main/service-catalog.js";
import { protectApplicationProfile } from "./protected-application-path.js";
import { SdkAgentToolBroker, type SdkAgentServiceHost } from "./sdk-agent-tool-broker.js";
import { SDK_AGENT_TOOL_NAMES, type SdkAgentToolName, type SdkAgentToolOutcome, type SdkAgentToolRequest } from "./sdk-agent-tool-contract.js";
import { publicServiceStatus } from "./service-public.js";
import { runHumanServiceControl } from "./service-control.js";
import { readLaunchVerificationOnDisk } from "./task-store.js";
import type { TaskWorkspaceHost } from "./task-host.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

/** The fixture child: reports its own pid, its own env and one oversized line, then stays alive. */
const SERVICE_SCRIPT = `const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(process.cwd(), "started-" + process.env.SERVICE_TAG + ".txt"), String(process.pid));
console.log("ready:" + process.env.SERVICE_GREETING + ":" + process.env.SERVICE_TAG);
console.log("pid:" + process.pid);
console.log("token:" + (process.env.SERVICE_TOKEN ?? "none"));
console.log("ambient:" + (process.env.PIDOCK_TEST_AMBIENT ?? "absent"));
process.stdout.write("x".repeat(2500) + "\\n");
setInterval(() => {}, 1000);
`;

const STOP_WAIT_MS = 30_000;
const POLL_INTERVAL_MS = 25;

/** Poll one tool call until its answer carries what the assertion needs (real output arrives asynchronously). */
async function untilTool(
  call: () => Promise<SdkAgentToolOutcome>,
  check: (outcome: SdkAgentToolOutcome) => boolean,
  label: string,
): Promise<SdkAgentToolOutcome> {
  let seen: SdkAgentToolOutcome = { outcome: "refused", text: "(no answer yet)" };
  for (let elapsed = 0; elapsed < STOP_WAIT_MS; elapsed += POLL_INTERVAL_MS) {
    seen = await call();
    if (check(seen)) return seen;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw Error(`timed out waiting for ${label}: ${seen.text.slice(0, 400)}`);
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let elapsed = 0; elapsed < STOP_WAIT_MS; elapsed += POLL_INTERVAL_MS) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw Error(`timed out waiting for ${label}`);
}

/** A real OS process probe: `kill(pid, 0)` reaches the child the fixture reported. */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) throw Error(`invalid-pid: ${pid}`);
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Raw text the fixture child wrote to its marker file, or `undefined` before it exists. */
function marker(taskDir: string, tag: string): string | undefined {
  try { return readFileSync(join(taskDir, "repo-a", `svc-${tag}`, `started-${tag}.txt`), "utf8"); } catch { return undefined; }
}

/** The pid the marker file holds once the child wrote a complete positive integer. */
function markerPid(taskDir: string, tag: string): number | undefined {
  const raw = marker(taskDir, tag);
  const pid = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

interface Harness {
  taskId: string;
  taskDir: string;
  profile: string;
  projectId: string;
  serviceId: string;
  surface: SdkAgentServiceHost;
  /** The real broker, captured exactly as the model worker receives it. */
  broker: { call(sessionId: string, request: SdkAgentToolRequest): Promise<SdkAgentToolOutcome> };
  host: TaskWorkspaceHost;
  /** One tool call as the model makes it. */
  call(tool: SdkAgentToolName, args: Record<string, unknown>, sessionId?: string): Promise<SdkAgentToolOutcome>;
}

async function harness(): Promise<Harness> {
  vi.resetModules();
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-agent-service-")));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const profile = join(home, "profile");
  const root = join(home, "tasks");
  const taskId = "task-8c41d0aa";
  const taskDir = join(root, taskId);
  const projectId = randomUUID();
  mkdirSync(profile, { mode: 0o700 });
  mkdirSync(join(taskDir, "repo-a", "svc-a"), { recursive: true });
  writeFileSync(join(taskDir, "repo-a", "svc-a", "service.cjs"), SERVICE_SCRIPT);

  // The Host speaks RPC over `process.parentPort`; these tests never send one,
  // but the module load requires the port to exist (as in the production Host).
  const port = new EventEmitter() as EventEmitter & { postMessage(value: unknown): void };
  port.postMessage = () => {};
  const oldPort = Object.getOwnPropertyDescriptor(process, "parentPort");
  Object.defineProperty(process, "parentPort", { configurable: true, value: port });
  cleanups.push(() => { if (oldPort) Object.defineProperty(process, "parentPort", oldPort); else Reflect.deleteProperty(process, "parentPort"); });
  for (const [name, value] of Object.entries({ PIDOCK_WORKSPACE_ID: "workspace-a", PIDOCK_TASK_ID: taskId, PIDOCK_TASK_DIR: taskDir, PIDOCK_PROTECTED_PROFILE: profile })) vi.stubEnv(name, value);
  vi.stubEnv("LOCAL_TEST_TOKEN", "synthetic-private-value");

  const { agentServiceHostFor } = await import("./host.js");
  const { TaskWorkspaceHost, diskTaskStore } = await import("./task-host.js");
  const { buildTaskDiskRecord } = await import("./task-store.js");
  diskTaskStore.writeTask(taskDir, buildTaskDiskRecord({ taskId, name: "Agent services", dirId: taskId, branch: "task/main",
    root, taskDir, remoteBranch: "main", baseCommit: "source-fixture", repos: ["repo-a"], now: "2026-01-01T00:00:00.000Z" }));

  const surface = agentServiceHostFor(taskId);
  if (!surface) throw Error("the production Agent service surface is not wired");
  const taskStat = statSync(taskDir, { bigint: true });
  const identity = { taskId, createdAt: "2026-01-01T00:00:00.000Z", root, realRoot: root, dirId: taskId,
    directoryDevice: taskStat.dev.toString(), directoryInode: taskStat.ino.toString() };
  const owner = (id: string) => id === taskId ? { identity, projectId, rootIds: ["repo-a"] } : null;
  const authority: ServiceCatalogAuthority = { projectExists: (id) => id === projectId, task: (id) => owner(id), verifiedTask: (id) => owner(id) };
  const catalog = new ServiceCatalog(profile, authority);
  // The trusted launch main resolves for a task-bound service (program, pinned
  // argv, cwd, private refs): the Agent never supplies any of it.
  const template = catalog.saveTemplate({ projectId, descriptor: { name: "API a", program: "node", args: ["service.cjs"], ports: [], runType: "long-lived" },
    shared: [{ key: "SERVICE_GREETING", value: "hello-a", secret: false }, { key: "SERVICE_TAG", value: "a", secret: false }] });
  catalog.bindTask({ taskId, serviceId: template.serviceId, templateVersion: 1, rootId: "repo-a", subdir: "svc-a",
    programPath: realpathSync(process.execPath), privateRefs: [{ key: "SERVICE_TOKEN", envRef: "LOCAL_TEST_TOKEN" }] });
  const launch = catalog.launchFor(taskId, projectId, template.serviceId, process.env);
  surface.services.register({ serviceId: launch.serviceId, descriptor: launch.descriptor, layers: launch.layers,
    templateVersion: String(launch.templateVersion), launchSource: "catalog" });

  let broker: Harness["broker"] | undefined;
  const host = new TaskWorkspaceHost(taskId, taskDir, diskTaskStore, () => "2026-09-22T10:00:00+08:00", () => [], undefined, undefined, undefined, undefined,
    (contextOptions) => {
      const caller = contextOptions.toolHost;
      if (!caller) throw new Error("tool-host-missing");
      broker = caller;
      return {
        open: async () => ({ tools: [...SDK_AGENT_TOOL_NAMES] }),
        prompt: async () => { throw new Error("no model turn in this suite"); },
        cancel: async () => {},
        seal: () => {},
        dispose: async () => {},
      } as never;
    },
    protectApplicationProfile(profile),
    () => agentServiceHostFor(taskId));

  // A real Provider install is what hands the broker to the model context; the
  // factory above replaces only the worker hop and captured that same broker.
  await host.configureSdkProvider({
    config: { profileId: "p-11111111-2222-3333-4444-555555555555", baseUrl: "https://models.example.test/v1", modelId: "gpt-5-mini",
      contextWindow: 128000, maxTokens: 8192, authRef: "PIDOCK_PROVIDER_EXAMPLE", generation: 1 },
    credential: "synthetic-key",
  });
  if (!broker) throw Error("broker-not-captured");
  // The gate decides a tool the Host knows; the session channel is created the
  // way a turn creates it, and the tier is left at the honest default.
  host.setPermission("main", "default");

  // Never leak a child: stop everything this harness spawned and SIGKILL any
  // pid a marker file reported, on every exit path.
  cleanups.push(async () => {
    for (const serviceId of surface.services.ids()) {
      try { await surface.driver().stop(serviceId); } catch { /* already stopped, never registered, or unreachable */ }
    }
    const pid = markerPid(taskDir, "a");
    if (pid !== undefined) { try { process.kill(pid, "SIGKILL"); } catch { /* the child is gone */ } }
    await host.shutdownSdk().catch(() => {});
  });

  const captured = broker;
  return {
    taskId, taskDir, profile, projectId, serviceId: launch.serviceId, surface, broker: captured, host,
    call: (tool, args, sessionId = "main") => captured.call(sessionId, { tool, args }),
  };
}

/**
 * The real broker with the same service surface, built directly so the
 * confirmation timeout can be lowered (`TaskWorkspaceHost` always uses the
 * production default). Every other option is what the Host passes.
 */
function brokerWithOptions(f: Harness, options: { approvalTimeoutMs?: number; services?: () => SdkAgentServiceHost | undefined }): SdkAgentToolBroker {
  return new SdkAgentToolBroker({
    sessionKnown: (sessionId) => sessionId === "main",
    channel: (sessionId) => f.host.openSession(sessionId),
    persist: () => {},
    write: f.host,
    scope: () => ({ taskDir: f.taskDir, taskRoot: join(f.taskDir, ".."), worktrees: [], primaryCheckouts: [], assertProtected: () => {} }),
    resolveRealPath: (path) => path,
    closing: () => false,
    services: options.services ?? (() => f.surface),
    ...(options.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: options.approvalTimeoutMs } : {}),
  });
}

it("starts the task's bound service through the gate with a real child, reads its bounded status and log, and stops it", { timeout: 30_000 }, async () => {
  const f = await harness();
  await f.host.setPermission("main", "auto");
  vi.stubEnv("PIDOCK_TEST_AMBIENT", "must-not-reach-a-service");

  const started = await f.call("service.start", { serviceId: f.serviceId });
  expect(started.outcome).toBe("ok");
  expect(started.text).toContain(`service ${f.serviceId} start: agent (permission auto)`);

  // (1) A REAL child process runs the task's bound service: the pid it wrote
  // itself is alive, and the marker proves it is the catalog's program in the
  // bound subdirectory with the effective env (private ref redacted, ambient absent).
  await until(() => markerPid(f.taskDir, "a") !== undefined, "the service child to report its pid");
  const pid = markerPid(f.taskDir, "a")!;
  expect(alive(pid)).toBe(true);
  expect(marker(f.taskDir, "a")).toBe(String(pid));
  expect(JSON.parse(readFileSync(join(f.taskDir, "service-ownership.json"), "utf8")).entries[0]).toMatchObject({ serviceId: f.serviceId, pid });

  const status = await f.call("service.status", { serviceId: f.serviceId });
  expect(status.outcome).toBe("ok");
  expect(status.text).toContain("lifecycle: running");
  expect(status.text).toContain("launchSource: catalog");
  // (5) Attribution: the Agent path is labelled with the session it was decided for.
  expect(status.text).toContain("lastControl: agent:main (start)");
  // (3) Provenance and a masked value: the Agent reads which layer each variable
  // came from, and no resolved value - shared or private - reaches the model.
  expect(status.text).toContain("env: 3 行");
  expect(status.text).toContain("SERVICE_GREETING · 来源 共享模板 · ••••••••");
  expect(status.text).toContain("SERVICE_TOKEN · 来源 本机私有配置 · ••••••••");
  expect(status.text).not.toContain("synthetic-private-value");
  expect(status.text).not.toContain("hello-a");

  const logs = await untilTool(
    () => f.call("service.logs", { serviceId: f.serviceId, limit: 10 }),
    (outcome) => outcome.text.includes("ambient:absent") && outcome.text.includes("[output line exceeded 2000 characters]"),
    "the bounded log of the running child",
  );
  expect(logs.outcome).toBe("ok");
  expect(logs.text).toContain("ready:hello-a:a");
  expect(logs.text).toContain(`pid:${pid}`);
  // The Host's own redaction and truncation survive into the tool output.
  expect(logs.text).toContain("token:••••••••");
  expect(logs.text).not.toContain("synthetic-private-value");
  expect(logs.text).toContain("ambient:absent");
  // Bounded: the requested line count holds, the oversized line is truncated,
  // and the whole answer stays inside the byte budget.
  expect(logs.text.split("\n").length).toBeLessThanOrEqual(11);
  expect(logs.text).toContain("[output line exceeded 2000 characters]");
  expect(logs.text.length).toBeLessThan(9 * 1024);

  const stopped = await f.call("service.stop", { serviceId: f.serviceId });
  expect(stopped.outcome).toBe("ok");
  await until(() => !alive(pid), "the real child to exit on the Agent stop");
  expect((await f.call("service.status", { serviceId: f.serviceId })).text).toContain("lifecycle: stopped");
  // (5) The UI-facing projection carries the same attribution, not a bare state.
  expect(publicServiceStatus(f.surface.services.get(f.serviceId)!).lastControl).toEqual({ action: "stop", actor: "agent", label: "main" });
});

it("refuses start and stop in a read-only session and leaves the running human-started child untouched", { timeout: 30_000 }, async () => {
  const f = await harness();
  // The explicit human click is the production human path; its label is main's own.
  const human = await runHumanServiceControl({ services: f.surface.services, driver: f.surface.driver(), serviceId: f.serviceId, action: "start", label: SERVICE_RUN_HUMAN_LABEL });
  expect(human).toMatchObject({ ok: true, payload: { actor: "human" } });
  await until(() => markerPid(f.taskDir, "a") !== undefined, "the human-started child");
  const pid = markerPid(f.taskDir, "a")!;
  expect(alive(pid)).toBe(true);
  // (5) A human explicit action is labelled as such, with main's own label.
  expect(publicServiceStatus(f.surface.services.get(f.serviceId)!).lastControl).toEqual({ action: "start", actor: "human", label: SERVICE_RUN_HUMAN_LABEL });

  await f.host.setPermission("main", "read");
  // (2) Read-only: the gate refuses both command tools by its own reason...
  const startRefused = await f.call("service.start", { serviceId: f.serviceId });
  expect(startRefused.outcome).toBe("refused");
  expect(startRefused.code).toBe("tool-refused:gate-denied");
  expect(startRefused.text).toContain("只读");
  const stopRefused = await f.call("service.stop", { serviceId: f.serviceId });
  expect(stopRefused).toMatchObject({ outcome: "refused", code: "tool-refused:gate-denied" });
  // ...and nothing happened: no second child, and the running one was not killed.
  expect(alive(pid)).toBe(true);
  expect(marker(f.taskDir, "a")).toBe(String(pid));
  expect((await f.call("service.status", { serviceId: f.serviceId })).text).toContain("lifecycle: running");
  expect((await f.call("service.status", { serviceId: f.serviceId })).text).toContain("lastControl: human:");
  // (2) Reads stay allowed for a read-only session (status/logs are `read` kind).
  // The child writes its marker file with a synchronous `writeFileSync` but its
  // stdout reaches this Host over a pipe asynchronously (on macOS a pipe write
  // is asynchronous), so "the marker file exists" is NOT "the log line was
  // ingested yet": read once here and the assertion races the child's output.
  // Wait for the readiness line this assertion is about, exactly as the
  // `service.logs` case above waits for the lines it asserts.
  const logs = await untilTool(
    () => f.call("service.logs", { serviceId: f.serviceId, limit: 50 }),
    (outcome) => outcome.text.includes("ready:hello-a:a"),
    "the human-started child's readiness line in the bounded log",
  );
  expect(logs.outcome).toBe("ok");
  expect(logs.text).toContain("ready:hello-a:a");
});

it("asks first under default, performs no action on a rejection, and spends the granted confirmation exactly once", { timeout: 30_000 }, async () => {
  const f = await harness();
  const ownership = join(f.taskDir, "service-ownership.json");

  // (3) The call asks first: it parks on the confirmation and starts nothing.
  const first = f.call("service.start", { serviceId: f.serviceId });
  await until(() => f.host.listApprovals("main").some((row) => row.status === "pending"), "the confirmation to be minted");
  const asked = f.host.listApprovals("main").find((row) => row.status === "pending")!;
  expect(asked.tool).toBe("exec.run");
  expect(marker(f.taskDir, "a")).toBeUndefined();
  expect(existsSync(ownership)).toBe(false);
  expect((await f.call("service.status", { serviceId: f.serviceId })).text).toContain("lifecycle: stopped");

  // A rejected confirmation performs no action at all.
  f.host.reject("main", asked.id);
  expect(await first).toMatchObject({ outcome: "refused", code: "tool-refused:approval-rejected" });
  expect(marker(f.taskDir, "a")).toBeUndefined();
  expect(existsSync(ownership)).toBe(false);

  // A granted confirmation is the only thing that starts the child.
  const second = f.call("service.start", { serviceId: f.serviceId });
  await until(() => f.host.listApprovals("main").filter((row) => row.status === "pending").length === 1, "the second confirmation");
  const granted = f.host.listApprovals("main").find((row) => row.status === "pending")!;
  expect(granted.id).not.toBe(asked.id);
  expect(marker(f.taskDir, "a")).toBeUndefined();
  f.host.approve("main", granted.id);
  expect(await second).toMatchObject({ outcome: "ok" });
  await until(() => markerPid(f.taskDir, "a") !== undefined, "the approved start to run the child");
  const pid = markerPid(f.taskDir, "a")!;
  expect(alive(pid)).toBe(true);
  // The confirmation really was spent (not merely marked approved): this is the
  // fact the double-spend guard rests on, and it fails if `consumeApproval` is
  // dropped from the Host control sequence.
  const spent = f.host.openSession("main").snapshot().approvals.find((row) => row.id === granted.id);
  expect(spent?.status).toBe("approved");
  expect(spent?.consumedAt).toBeDefined();

  // A second action asks again instead of reusing the spent confirmation, and
  // cancelling that new confirmation stops the process from stopping.
  const third = f.call("service.stop", { serviceId: f.serviceId });
  await until(() => f.host.listApprovals("main").filter((row) => row.status === "pending").length === 1, "the stop confirmation");
  const forStop = f.host.listApprovals("main").find((row) => row.status === "pending")!;
  expect(forStop.id).not.toBe(granted.id);
  f.host.cancel("main");
  expect(await third).toMatchObject({ outcome: "refused", code: "tool-refused:approval-cancelled" });
  // Nothing was stopped: the child the approved start spawned is still alive.
  expect(alive(pid)).toBe(true);
  expect((await f.call("service.status", { serviceId: f.serviceId })).text).toContain("lifecycle: running");
});

it("performs no action when the confirmation expires without a decision", { timeout: 30_000 }, async () => {
  const f = await harness();
  const broker = brokerWithOptions(f, { approvalTimeoutMs: 120 });
  const pending = broker.call("main", { tool: "service.start", args: { serviceId: f.serviceId } });
  await until(() => f.host.listApprovals("main").some((row) => row.status === "pending"), "the confirmation to be minted");
  expect(await pending).toMatchObject({ outcome: "refused", code: "tool-refused:approval-expired" });
  // The unanswered confirmation started nothing, and the parked call settled it
  // through the same channel that minted it, so it is not left spendable.
  expect(marker(f.taskDir, "a")).toBeUndefined();
  expect(existsSync(join(f.taskDir, "service-ownership.json"))).toBe(false);
  expect((await f.call("service.status", { serviceId: f.serviceId })).text).toContain("lifecycle: stopped");
  expect(f.host.listApprovals("main").some((row) => row.status === "pending")).toBe(false);
});

it("reports process liveness and dependency reachability as two separate facts", { timeout: 30_000 }, async () => {
  const f = await harness();
  await f.host.setPermission("main", "auto");
  await f.call("service.start", { serviceId: f.serviceId });
  await until(() => markerPid(f.taskDir, "a") !== undefined, "the service child");
  const pid = markerPid(f.taskDir, "a")!;

  // A live process with no dependency probe: liveness is running and the
  // dependency fact is explicitly "not probed" instead of a passing health claim.
  const running = await f.call("service.status", { serviceId: f.serviceId });
  expect(running.text).toContain("lifecycle: running");
  expect(running.text).toContain("dependency: not probed (reachability is never reported as process liveness)");

  // The reverse direction: the process is really dead (SIGKILL, observed on the
  // OS) while a dependency is recorded reachable — the tool must not report the
  // reachable dependency as a live process.
  process.kill(pid, "SIGKILL");
  await until(() => !alive(pid), "the child to die");
  f.surface.services.markDependencyReachable(f.serviceId, "port 127.0.0.1:9412 answered");
  await until(() => f.surface.services.get(f.serviceId)?.lifecycle === "stopped", "the Host to observe the exit");
  const dead = await f.call("service.status", { serviceId: f.serviceId });
  expect(dead.text).toContain("lifecycle: stopped");
  expect(dead.text).toContain("dependency: port 127.0.0.1:9412 answered (reachability note only; process liveness stays stopped)");
  expect(dead.text).not.toContain("lifecycle: running");
});

it("refuses an unknown or foreign service, a display-only registration, and any payload naming a program, path or port", { timeout: 30_000 }, async () => {
  const f = await harness();
  await f.host.setPermission("main", "auto");
  const markerBefore = marker(f.taskDir, "a");

  // (6) A service this task does not have is refused by name; nothing starts.
  expect(await f.call("service.start", { serviceId: "s-99999999-9999-9999-9999-999999999999" })).toMatchObject({ outcome: "refused", code: "tool-refused:unknown-service" });
  expect(await f.call("service.status", { serviceId: "another-task-service" })).toMatchObject({ code: "tool-refused:unknown-service" });
  // A path-shaped id is not an id at all.
  expect(await f.call("service.start", { serviceId: "../../etc/passwd" })).toMatchObject({ code: "tool-refused:invalid-arguments" });
  expect(await f.call("service.start", { serviceId: `${f.taskDir}/repo-a/svc-a/service.cjs` })).toMatchObject({ code: "tool-refused:invalid-arguments" });

  // (6) The Agent may name a service id and nothing else: a program, a path, a
  // port, args, an env value or an approval id are all unknown arguments.
  for (const args of [{ serviceId: f.serviceId, program: "/bin/sh" }, { serviceId: f.serviceId, path: "/etc/passwd" },
    { serviceId: f.serviceId, port: 9412 }, { serviceId: f.serviceId, args: ["-c", "touch pwned"] },
    { serviceId: f.serviceId, env: { PATH: "/tmp" } }, { serviceId: f.serviceId, approvalId: "approval-1" },
    { serviceId: f.serviceId, action: "start" }, {}]) {
    expect(await f.call("service.start", args)).toMatchObject({ outcome: "refused", code: "tool-refused:invalid-arguments" });
  }
  expect(await f.call("service.logs", { serviceId: f.serviceId, limit: 500 })).toMatchObject({ code: "tool-refused:invalid-arguments" });

  // A display-only (`ui`) registration is not executable material: refused by
  // name, with the page-supplied program never run.
  f.surface.services.register({
    serviceId: "s-ui-only",
    descriptor: { name: "page", program: realpathSync(process.execPath), args: ["-e", "require('node:fs').writeFileSync('pwned.txt','x')"],
      cwd: join(f.taskDir, "repo-a", "svc-a"), ports: [], runType: "one-shot" },
    layers: { repoDefaults: [], shared: [], privateEntries: [], task: [] },
    templateVersion: "v1",
  });
  expect(await f.call("service.start", { serviceId: "s-ui-only" })).toMatchObject({ code: "tool-refused:service-execution-unavailable" });

  expect(marker(f.taskDir, "a")).toBe(markerBefore);
  expect(existsSync(join(f.taskDir, "repo-a", "svc-a", "pwned.txt"))).toBe(false);
  expect(existsSync(join(f.taskDir, "service-ownership.json"))).toBe(false);
  expect((await f.call("service.status", { serviceId: f.serviceId })).text).toContain("lifecycle: stopped");
});

it("declares only gated service tools, so no service tool is reachable outside the one gate", { timeout: 30_000 }, async () => {
  // Every tool the broker can execute is a gated tool name, so the gate decides
  // all of them; a name outside the gate cannot be executed by the broker.
  for (const name of SDK_AGENT_TOOL_NAMES) expect(PI_GATED_TOOL_NAMES).toContain(name);
  for (const name of ["service.status", "service.logs", "service.start", "service.stop"]) {
    expect(SDK_AGENT_TOOL_NAMES).toContain(name);
    expect(PI_GATED_TOOL_NAMES).toContain(name);
  }

  // The worker contract stays declarative: names, schemas and prompt only, with
  // no Node capability, so the model context can never act on its own.
  const source = readFileSync(new URL("./sdk-agent-tool-contract.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/from\s+"node:/);
  expect(source).not.toMatch(/require\(/);

  const f = await harness();
  await f.host.setPermission("main", "auto");
  // An unknown tool and an unknown session are refused before any gate or effect.
  expect(await f.call("service.kill" as SdkAgentToolName, { serviceId: f.serviceId })).toMatchObject({ code: "tool-refused:unknown-tool" });
  expect(await f.call("service.start", { serviceId: f.serviceId }, "not-a-session")).toMatchObject({ code: "tool-refused:unknown-session" });
  // A Host with no real service surface refuses every service tool by name.
  const unwired = brokerWithOptions(f, { services: () => undefined });
  expect(await unwired.call("main", { tool: "service.status", args: { serviceId: f.serviceId } })).toMatchObject({ code: "tool-refused:service-control-unavailable" });
  expect(await unwired.call("main", { tool: "service.start", args: { serviceId: f.serviceId } })).toMatchObject({ code: "tool-refused:service-control-unavailable" });
  expect(existsSync(join(f.taskDir, "service-ownership.json"))).toBe(false);
});

// [PiDock 04] (#7 box 7) the production wiring of the platform launch record:
// `host.js`'s own `agentServiceHostFor` builds the task runtime with the task
// workspace's durable launch-verification document, so a real Agent-driven
// launch leaves a record a later read can show - and every platform this
// machine did not run stays explicitly unverified.
it("records THIS platform's real launch in the task workspace and projects it with Windows unverified", { timeout: 30_000 }, async () => {
  const f = await harness();
  await f.host.setPermission("main", "auto");
  expect((await f.call("service.start", { serviceId: f.serviceId })).outcome).toBe("ok");
  await until(() => markerPid(f.taskDir, "a") !== undefined, "the service child to report its pid");

  const document = readLaunchVerificationOnDisk(f.taskDir);
  const program = realpathSync(process.execPath);
  expect(document.entries).toEqual([{
    schemaVersion: 1,
    serviceId: f.serviceId,
    platform: `${process.platform}-${process.arch}`,
    nodeVersion: process.versions.node,
    program,
    args: ["service.cjs"],
    startedAt: expect.any(String),
    stopped: false,
  }]);

  const rows = publicServiceStatus(f.surface.services.get(f.serviceId)!).launchVerification.rows;
  expect(process.platform).not.toBe("win32");
  expect(rows.filter((row) => row.verified)).toEqual([
    { platform: `${process.platform}-${process.arch}`, verified: true, nodeVersion: process.versions.node, program, startedAt: expect.any(String), stopped: false },
  ]);
  // Windows is named and unverified, never absent and never a pass.
  expect(rows.find((row) => row.platform === "win32-x64")).toEqual({ platform: "win32-x64", verified: false, reason: "本机未运行该平台，未实测" });

  expect((await f.call("service.stop", { serviceId: f.serviceId })).outcome).toBe("ok");
  expect(readLaunchVerificationOnDisk(f.taskDir).entries[0]).toMatchObject({ stopped: true, startedAt: document.entries[0].startedAt });
});
