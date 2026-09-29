/**
 * Isolated SDK model context ([PiDock 02m] #46).
 *
 * Runs inside a `node:worker_threads` worker whose `process.env` contains only
 * the allowlisted minimum (see `sdk-context-env.ts`), so the pi `ModelRuntime`
 * cannot consult an ambient credential: the user's selected credential arrives
 * as `workerData`, never through the environment, and therefore is not
 * inherited by anything this context spawns either.
 *
 * The worker owns the whole `PiSdkTextKernel` for the task (sessions, JSONL
 * binding, the model runtime). The task Host keeps a read-only kernel for
 * projections, so the renderer-facing projection path stays synchronous while
 * every model-bearing operation happens here.
 */

import { parentPort, workerData } from "node:worker_threads";
import { assertSdkContextEnv, type SdkContextTaskBinding } from "./sdk-context-env.js";
import { createExplicitTextRuntime, validateExplicitTextProvider, type ExplicitTextProvider } from "./explicit-text-provider.js";
import { PiSdkTextKernel, type SdkTextEvent } from "./sdk-text-kernel.js";

export interface SdkContextInput {
  task: SdkContextTaskBinding;
  /** Non-secret provider configuration (validated again by the runtime factory). */
  config: ExplicitTextProvider;
  /** Resolved credential value. Never logged, persisted or returned. */
  credential: string;
}

export type SdkContextRequestPayload =
  | { op: "open"; sessionId: string }
  | { op: "prompt"; sessionId: string; text: string; issuedTurnId?: string }
  | { op: "cancel"; sessionId: string }
  | { op: "dispose" };

export type SdkContextRequest = SdkContextRequestPayload & { id: string };

export type SdkContextMessage =
  | { id: string; kind: "event"; event: SdkTextEvent }
  | { id: string; kind: "reply"; ok: true; payload: Record<string, unknown> }
  | { id: string; kind: "reply"; ok: false; error: string };

function request(value: unknown): SdkContextRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid-request");
  const record = value as Record<string, unknown>;
  const id = record["id"];
  const op = record["op"];
  const sessionId = record["sessionId"];
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("invalid-request");
  if (op === "dispose") return { id, op };
  if (typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(sessionId)) throw new Error("invalid-request");
  if (op === "open") return { id, op, sessionId };
  if (op === "cancel") return { id, op, sessionId };
  if (op === "prompt") {
    const text = record["text"];
    const issuedTurnId = record["issuedTurnId"];
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 16_384) throw new Error("invalid-request");
    if (issuedTurnId !== undefined && (typeof issuedTurnId !== "string" || !/^[a-f0-9-]{36}$/.test(issuedTurnId))) throw new Error("invalid-request");
    return { id, op, sessionId, text, ...(issuedTurnId === undefined ? {} : { issuedTurnId }) };
  }
  throw new Error("invalid-request");
}

function input(value: unknown): SdkContextInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("sdk-context-input-invalid");
  const record = value as Record<string, unknown>;
  const task = record["task"];
  if (typeof task !== "object" || task === null || Array.isArray(task)) throw new Error("sdk-context-input-invalid");
  const binding = task as Record<string, unknown>;
  if (typeof binding["taskId"] !== "string" || typeof binding["taskDir"] !== "string" ||
      typeof record["credential"] !== "string") throw new Error("sdk-context-input-invalid");
  return {
    task: { taskId: binding["taskId"], taskDir: binding["taskDir"] },
    config: validateExplicitTextProvider(record["config"]),
    credential: record["credential"],
  };
}

async function main(): Promise<void> {
  const port = parentPort;
  if (!port) throw new Error("sdk-context-unbound");
  const parsed = input(workerData);
  // The environment allowlist is re-checked inside the context that owns the
  // model runtime: it must contain no credential at all.
  assertSdkContextEnv(process.env as Record<string, string>);
  if (process.env["PIDOCK_TASK_ID"] !== parsed.task.taskId || process.env["PIDOCK_TASK_DIR"] !== parsed.task.taskDir) {
    throw new Error("sdk-context-task-mismatch");
  }
  const { runtime, model, bindingIdentity } = await createExplicitTextRuntime(parsed.config, parsed.credential);
  const kernel = new PiSdkTextKernel(parsed.task.taskId, parsed.task.taskDir, { model, modelRuntime: runtime, bindingIdentity });
  const send = (message: SdkContextMessage) => port.postMessage(message);
  let closing = false;
  port.on("message", (raw: unknown) => {
    void (async () => {
      let id = "unknown";
      try {
        const message = request(raw);
        id = message.id;
        if (closing && message.op !== "dispose") throw new Error("sdk-context-closing");
        if (message.op === "open") {
          send({ id, kind: "reply", ok: true, payload: { ...(await kernel.open(message.sessionId)) } });
          return;
        }
        if (message.op === "prompt") {
          const result = await kernel.prompt(message.sessionId, message.text, (event) => send({ id, kind: "event", event }), message.issuedTurnId);
          send({ id, kind: "reply", ok: true, payload: { state: result.state, text: result.text, ...(result.error ? { error: result.error } : {}) } });
          return;
        }
        if (message.op === "cancel") {
          await kernel.cancel(message.sessionId);
          send({ id, kind: "reply", ok: true, payload: { cancelled: true } });
          return;
        }
        closing = true;
        await kernel.dispose();
        send({ id, kind: "reply", ok: true, payload: { disposed: true } });
        port.close();
      } catch (error) {
        try { send({ id, kind: "reply", ok: false, error: error instanceof Error ? error.message : String(error) }); }
        catch { /* the parent is gone */ }
      }
    })();
  });
  port.postMessage({ id: "ready", kind: "reply", ok: true, payload: { ready: true, bindingIdentity } } satisfies SdkContextMessage);
}

void main().catch((error: unknown) => {
  // A failed bootstrap must not leave the parent waiting: report and end.
  try { parentPort?.postMessage({ id: "ready", kind: "reply", ok: false, error: error instanceof Error ? error.message : String(error) } satisfies SdkContextMessage); }
  catch { /* the parent is gone */ }
  process.exitCode = 1;
});
