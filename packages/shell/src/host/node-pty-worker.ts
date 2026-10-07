import type { IPty } from "node-pty";
import { pathToFileURL } from "node:url";
import { inspectNodePtyPrebuild } from "./node-pty-preflight.js";
import { MAX_PTY_OUTPUT_BYTES, MAX_PTY_ENVELOPE_BYTES, parsePtyRequest, sameEnvelope, type PtyEnvelope, type PtyEvent, type PtyRequest, type PtyReason } from "./node-pty-protocol.js";

/** Experiment entry only. This process owns one PTY, never a descendant-drain receipt. */
let binding: PtyEnvelope | undefined;
let terminal: IPty | undefined;
let requestId = 0, sequence = 0, pendingBytes = 0, pendingMessages = 0;
let rootExited = false, fenced = false;

function disconnectWhenDrained(): void {
  if (rootExited && pendingMessages === 0 && process.connected) process.disconnect();
}
function send(event: PtyEvent): void {
  if (!process.connected || !process.send) { fenced = true; terminal?.pause(); return; }
  const size = Buffer.byteLength(JSON.stringify(event));
  pendingBytes += size; pendingMessages++;
  process.send(event, (error: Error | null) => {
    pendingBytes -= size; pendingMessages--;
    if (error) { fenced = true; terminal?.pause(); }
    disconnectWhenDrained();
  });
}
function uncertain(reason: PtyReason = "protocol-unconfirmed"): void {
  fenced = true; terminal?.pause();
  if (binding) send({ ...binding, kind: "reply", requestId, status: "unknown", reason });
}
function output(data: string): void {
  if (!binding || fenced) return;
  // Bound outstanding IPC output as well as each chunk. On pressure retain the
  // operation and stop reading, rather than accumulating an unbounded history.
  if (pendingBytes + Buffer.byteLength(data) * 6 + 4096 > MAX_PTY_ENVELOPE_BYTES) { uncertain("output-limit"); return; }
  let chunk = "", bytes = 0;
  for (const character of data) {
    const size = Buffer.byteLength(character);
    if (bytes + size > MAX_PTY_OUTPUT_BYTES) {
      send({ ...binding, kind: "output", sequence: ++sequence, data: chunk }); chunk = ""; bytes = 0;
    }
    chunk += character; bytes += size;
  }
  if (chunk) send({ ...binding, kind: "output", sequence: ++sequence, data: chunk });
}
async function start(request: PtyRequest & { action: "spawn" }): Promise<void> {
  send({ ...binding!, kind: "phase", phase: "preflight" });
  let entryPath: string;
  try {
    const preflight = inspectNodePtyPrebuild();
    if (!preflight.ready) throw Error();
    entryPath = preflight.entryPath;
  }
  catch {
    send({ ...binding!, kind: "reply", requestId, status: "not-started", reason: "preflight-unavailable" });
    rootExited = true; disconnectWhenDrained(); return;
  }
  send({ ...binding!, kind: "phase", phase: "library-load" });
  let library: typeof import("node-pty");
  try { library = await import(pathToFileURL(entryPath).href) as typeof import("node-pty"); }
  catch { uncertain("library-load-unconfirmed"); return; }
  // A malformed/early control during async loading must not dispatch a late spawn.
  if (fenced) return;
  send({ ...binding!, kind: "phase", phase: "native-spawn" });
  try {
    terminal = library.spawn(request.launch.program, [...request.launch.args], {
      cwd: request.launch.cwd, env: { ...request.launch.env }, cols: request.launch.cols, rows: request.launch.rows,
      name: request.launch.env.TERM ?? "xterm-256color", encoding: "utf8",
    });
    terminal.onData(output);
    terminal.onExit(({ exitCode, signal }) => {
      rootExited = true;
      send({ ...binding!, kind: "exit", exitCode, signal: signal ?? 0 });
      disconnectWhenDrained();
    });
    send({ ...binding!, kind: "reply", requestId, status: "started", rootPid: terminal.pid });
  } catch { uncertain("native-spawn-unconfirmed"); }
}

// There is intentionally no kill/destroy/dispose command: public node-pty
// termination exposes numeric PID/console lists, not a containment handle.
process.on("message", (raw: unknown) => {
  let request: PtyRequest;
  try {
    request = parsePtyRequest(raw);
    if (process.platform !== "darwin" || process.arch !== "arm64" || process.versions.electron || process.versions.node !== "24.21.0") throw Error();
    if (!binding) {
      if (request.action !== "spawn" || request.requestId !== 1) throw Error();
      binding = { workspaceId: request.workspaceId, identity: { ...request.identity }, operationId: request.operationId };
      requestId = 1;
      void start(request); return;
    }
    if (!sameEnvelope(binding, request) || request.requestId !== requestId + 1 || request.action === "spawn" || !terminal || rootExited || fenced) throw Error();
    requestId = request.requestId;
    if (request.action === "input") terminal.write(request.data);
    else terminal.resize(request.cols, request.rows);
    send({ ...binding, kind: "reply", requestId, status: "accepted" });
  } catch {
    if (binding) uncertain();
    else { rootExited = true; process.exitCode = 1; disconnectWhenDrained(); }
  }
});
process.on("disconnect", () => { if (!rootExited) { fenced = true; terminal?.pause(); } });
