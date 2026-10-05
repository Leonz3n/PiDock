// Test-only utilityProcess entry. Never import this from the production Host.
import { existsSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { PiSessionChannel } from "../dist/main/pi-session.js";
import { ExperimentalServiceExecution } from "../dist/host/service-execution-experiment.js";
import { experimentalShutdownClient } from "../dist/host/host-shutdown-client-experiment.js";
import { ExperimentalHostShutdown } from "../dist/host/host-shutdown-experiment.js";
import { SdkContextClient } from "../dist/host/sdk-context-client.js";
import { SdkTurnTransport } from "../dist/host/sdk-turn-transport.js";
import { SdkTextKernelRouter } from "../dist/host/sdk-kernel-router.js";
import { PiSdkTextKernel } from "../dist/host/sdk-text-kernel.js";
import { experimentalCheckpointClient } from "../dist/host/service-checkpoint-client-experiment.js";
import { TaskWriteCoordinator } from "../dist/host/write-coordination.js";
import { launchSupervisorExperiment } from "../dist/host/service-supervisor-experiment.js";

const port = process.parentPort;
if (!port) throw Error("utility fixture requires parent port");
let session, execution, channel, abort, releaseReady, shutdown, sdkWorker, turns;
let started = false, handling = false, closeSucceeded = false;
const send = (message) => { try { port.postMessage(message); } catch { /* Dead test parent receives no fabricated receipt. */ } };
async function bindExecution(lifecycle, start) {
  channel = new PiSessionChannel({ taskId: lifecycle.taskId, taskDir: lifecycle.taskDir, sessionId: "main", permission: "auto", providerId: "local", model: "test" });
  const write = new TaskWriteCoordinator(() => execution.resources());
  const client = lifecycle.epoch ? experimentalCheckpointClient({
    send: (message) => port.postMessage(message),
    subscribe: (receive, disconnected) => {
      const listener = ({ data }) => { if (data?.kind === "checkpoint-ack") receive(data); };
      port.on("message", listener); port.on("close", disconnected);
      return () => { port.removeListener("message", listener); port.removeListener("close", disconnected); };
    },
  }, { taskId: lifecycle.taskId, serviceId: lifecycle.serviceId, epoch: lifecycle.epoch }) : undefined;
  const dependencies = { taskId: lifecycle.taskId, taskDir: lifecycle.taskDir, serviceId: lifecycle.serviceId,
    revision: () => { client?.verify(); return "synthetic-config-1"; }, write, start, recovery: client?.recovery ?? {
      read: () => existsSync(lifecycle.file) ? JSON.parse(readFileSync(lifecycle.file, "utf8")) : undefined,
      write: (record) => {
        // Isolated test directory only; not the application's recovery store.
        const temporary = lifecycle.file + ".tmp";
        writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flush: true }); renameSync(temporary, lifecycle.file);
        const fd = openSync(dirname(lifecycle.file), "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
        return undefined;
      },
    } };
  execution = client ? await ExperimentalServiceExecution.create({ ...dependencies, recovery: client.recovery }) : new ExperimentalServiceExecution(dependencies);
  if (lifecycle.closeReport) {
    const reportClient = experimentalShutdownClient({ send: (message) => port.postMessage(message), subscribe: (receive, disconnected) => {
      const listener = ({ data }) => { if (data?.kind === "shutdown-report-ack") receive(data); };
      port.on("message", listener); port.on("close", disconnected);
      return () => { port.removeListener("message", listener); port.removeListener("close", disconnected); };
    } }, { taskId: lifecycle.taskId, epoch: lifecycle.epoch });
    const active = lifecycle.activeSdk;
    const sdk = new SdkContextClient({ task: { taskId: lifecycle.taskId, taskDir: lifecycle.taskDir }, config: { profileId: "fixture", baseUrl: active?.baseUrl ?? "https://models.example.test/v1", modelId: "fixture", contextWindow: 2048, maxTokens: 128, authRef: "PIDOCK_PROVIDER_TEST", generation: 1 }, credential: "synthetic-shutdown-credential",
      ...(active ? { shutdownTimeoutMs: active.mode === "missing-termination-receipt" ? 200 : 5000, spawn: (env, workerData) => {
        sdkWorker = new Worker(new URL("../dist/host/sdk-context-worker.js", import.meta.url), { env, workerData });
        sdkWorker.once("exit", () => send({ event: "sdk-native-exit" }));
        if (active.mode === "missing-termination-receipt") {
          const terminate = sdkWorker.terminate.bind(sdkWorker);
          sdkWorker.terminate = () => { void terminate().catch(() => send({ event: "sdk-native-termination-failed" })); return new Promise(() => {}); };
        }
        return sdkWorker;
      } } : {}) });
    const opened = await sdk.open("main");
    if (opened.tools.length !== 0) throw Error("unexpected-sdk-tools");
    const router = active ? new SdkTextKernelRouter(new PiSdkTextKernel(lifecycle.taskId, lifecycle.taskDir), sdk) : undefined;
    turns = router ? new SdkTurnTransport(lifecycle.taskId, lifecycle.taskDir, router) : undefined;
    shutdown = new ExperimentalHostShutdown({ taskId: lifecycle.taskId, hostEpoch: lifecycle.epoch,
      sealSdk: () => { sdk.seal(); turns?.seal(); }, shutdownSdk: () => router ? router.dispose() : sdk.dispose(), settleTurns: () => turns ? turns.waitForTerminal() : Promise.resolve(),
      services: [execution], verify: () => { client.verify(); reportClient.verify(); }, persist: reportClient.persist });
  }
}
port.on("message", ({ data }) => {
  if (!data || typeof data !== "object") return;
  if (data.kind === "checkpoint-ack" || data.kind === "shutdown-report-ack") return;
  const concurrent = data.op === "cancel-start" || data.op === "close";
  if (handling && !concurrent) return;
  if (!concurrent) handling = true;
  void (async () => {
    if (data.op === "launch" && !started) {
      started = true;
      const start = async () => {
        // Synthetic test configuration only. Redact all provided env values.
        const secrets = Object.values(data.request.env).filter(Boolean).sort((a, b) => b.length - a.length);
        session = await launchSupervisorExperiment(data.binary, data.request, {
          redact: (line) => secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), line),
          onLine: (line) => send({ event: "log", line }),
        });
        send({ event: "started", pid: session.pid, supervisorPid: session.supervisorPid });
        void session.completion.then((result) => send({ event: "completed", result }));
        if (data.lifecycle?.holdReady) await new Promise((resolve) => { releaseReady = resolve; });
        return session;
      };
      if (data.lifecycle) {
        abort = new AbortController(); await bindExecution(data.lifecycle, start);
        const result = await execution.control({ channel, sessionId: "main", action: "start", signal: abort.signal, persist: () => {} });
        send({ event: "control-result", result, snapshot: execution.snapshot() });
      } else await start();
    } else if (data.op === "cancel-start" && abort && releaseReady) {
      abort.abort(); releaseReady();
    } else if (data.op === "sdk-start" && turns) {
      const turn = await turns.start("main", "active-model", "active report fixture", (event) => send({ event: "sdk-event", type: event.type }),
        (terminal) => send({ event: "sdk-terminal", state: terminal.state }));
      send({ event: "sdk-accepted", turnId: turn.turnId });
    } else if (data.op === "sdk-kill" && sdkWorker) {
      await Worker.prototype.terminate.call(sdkWorker);
      send({ event: "sdk-killed" });
    } else if (data.op === "sdk-poison" && sdkWorker) {
      // Deliberate parent-side protocol fault injection into the real Worker adapter.
      sdkWorker.emit("message", { id: "foreign", kind: "reply", ok: true, payload: {} });
      send({ event: "sdk-poisoned" });
    } else if (data.op === "close" && execution) {
      const result = await (shutdown ? shutdown.close() : execution.close());
      closeSucceeded = shutdown !== undefined && result.ok === true;
      send({ event: "close-result", result, snapshot: execution.snapshot() });
    } else if (data.op === "reopen" && !started) {
      started = true;
      let attempted = false;
      await bindExecution(data.lifecycle, async () => { attempted = true; throw Error("recovery-must-not-launch"); });
      const control = await execution.control({ channel, sessionId: "main", action: "start", persist: () => {} });
      const close = await execution.close();
      send({ event: "recovered", control, close, snapshot: execution.snapshot(), resources: execution.resources(), launchAttempted: attempted });
    } else if (data.op === "stop" && session) {
      await session.stop();
    } else if (data.op === "disconnect" && session) {
      await session.disconnect();
    } else if (data.op === "release" && closeSucceeded) {
      process.exit(0);
    } else if (data.op === "exit" && session) {
      process.exit(0);
    } else send({ event: "failed", reason: "invalid-test-operation" });
  })().catch(() => send({ event: "failed", reason: "experimental-launch-failed" }))
    .finally(() => { if (!concurrent) handling = false; });
});
send({ event: "boot", versions: { electron: process.versions.electron, node: process.versions.node } });
