// Test-only utilityProcess entry. Never import this from the production Host.
import { launchSupervisorExperiment } from "../dist/host/service-supervisor-experiment.js";

const port = process.parentPort;
if (!port) throw Error("utility fixture requires parent port");
let session;
let started = false;
let handling = false;
port.on("message", ({ data }) => {
  if (handling || !data || typeof data !== "object") return;
  handling = true;
  void (async () => {
    if (data.op === "launch" && !started) {
      started = true;
      // Synthetic test configuration only. Redact all provided env values.
      const secrets = Object.values(data.request.env).filter(Boolean).sort((a, b) => b.length - a.length);
      session = await launchSupervisorExperiment(data.binary, data.request, {
        redact: (line) => secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), line),
        onLine: (line) => port.postMessage({ event: "log", line }),
      });
      port.postMessage({ event: "started", pid: session.pid, supervisorPid: session.supervisorPid });
      void session.completion.then((result) => port.postMessage({ event: "completed", result }));
    } else if (data.op === "stop" && session) {
      await session.stop();
    } else if (data.op === "disconnect" && session) {
      await session.disconnect();
    } else if (data.op === "exit" && session) {
      process.exit(0);
    } else {
      port.postMessage({ event: "failed", reason: "invalid-test-operation" });
    }
  })().catch(() => port.postMessage({ event: "failed", reason: "experimental-launch-failed" }))
    .finally(() => { handling = false; });
});
port.postMessage({ event: "boot", versions: { electron: process.versions.electron, node: process.versions.node } });
