// Test-only utilityProcess entry. Never import this from the production Host.
import { existsSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { PiSessionChannel } from "../dist/main/pi-session.js";
import { ExperimentalServiceExecution } from "../dist/host/service-execution-experiment.js";
import { TaskWriteCoordinator } from "../dist/host/write-coordination.js";
import { launchSupervisorExperiment } from "../dist/host/service-supervisor-experiment.js";

const port = process.parentPort;
if (!port) throw Error("utility fixture requires parent port");
let session, execution, channel, abort, releaseReady;
let started = false, handling = false;
const send = (message) => { try { port.postMessage(message); } catch { /* Dead test parent receives no fabricated receipt. */ } };
function bindExecution(lifecycle, start) {
  channel = new PiSessionChannel({ taskId: lifecycle.taskId, taskDir: lifecycle.taskDir, sessionId: "main", permission: "auto", providerId: "local", model: "test" });
  const write = new TaskWriteCoordinator(() => execution.resources());
  execution = new ExperimentalServiceExecution({ taskId: lifecycle.taskId, taskDir: lifecycle.taskDir, serviceId: lifecycle.serviceId,
    revision: () => "synthetic-config-1", write, start, recovery: {
      read: () => existsSync(lifecycle.file) ? JSON.parse(readFileSync(lifecycle.file, "utf8")) : undefined,
      write: (record) => {
        // Isolated test directory only; not the application's recovery store.
        const temporary = lifecycle.file + ".tmp";
        writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flush: true }); renameSync(temporary, lifecycle.file);
        const fd = openSync(dirname(lifecycle.file), "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
        return undefined;
      },
    } });
}
port.on("message", ({ data }) => {
  if (!data || typeof data !== "object") return;
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
        abort = new AbortController(); bindExecution(data.lifecycle, start);
        const result = await execution.control({ channel, sessionId: "main", action: "start", signal: abort.signal, persist: () => {} });
        send({ event: "control-result", result, snapshot: execution.snapshot() });
      } else await start();
    } else if (data.op === "cancel-start" && abort && releaseReady) {
      abort.abort(); releaseReady();
    } else if (data.op === "close" && execution) {
      const result = await execution.close();
      send({ event: "close-result", result, snapshot: execution.snapshot() });
    } else if (data.op === "reopen" && !started) {
      started = true;
      let attempted = false;
      bindExecution(data.lifecycle, async () => { attempted = true; throw Error("recovery-must-not-launch"); });
      const control = await execution.control({ channel, sessionId: "main", action: "start", persist: () => {} });
      const close = await execution.close();
      send({ event: "recovered", control, close, snapshot: execution.snapshot(), resources: execution.resources(), launchAttempted: attempted });
    } else if (data.op === "stop" && session) {
      await session.stop();
    } else if (data.op === "disconnect" && session) {
      await session.disconnect();
    } else if (data.op === "exit" && session) {
      process.exit(0);
    } else send({ event: "failed", reason: "invalid-test-operation" });
  })().catch(() => send({ event: "failed", reason: "experimental-launch-failed" }))
    .finally(() => { if (!concurrent) handling = false; });
});
send({ event: "boot", versions: { electron: process.versions.electron, node: process.versions.node } });
