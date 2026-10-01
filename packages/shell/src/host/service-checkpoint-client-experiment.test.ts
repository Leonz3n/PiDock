import { afterEach, expect, it, vi } from "vitest";
import { experimentalCheckpointClient } from "./service-checkpoint-client-experiment.js";
const scope = { taskId: "task-async", serviceId: "service-a", epoch: "12345678-1234-4123-8123-123456789abc", timeoutMs: 50 };
const checkpoint = { schemaVersion: 1 as const, taskId: scope.taskId, serviceId: scope.serviceId, state: "starting" as const, ownerSessionId: "main" };
function setup() {
  let receive!: (message: unknown) => void, disconnected!: () => void;
  const detach = vi.fn(), send = vi.fn();
  const client = experimentalCheckpointClient({ send, subscribe: (onMessage, onExit) => { receive = onMessage; disconnected = onExit; return detach; } }, scope);
  const ack = (extra = {}) => receive({ kind: "checkpoint-ack", epoch: scope.epoch, id: send.mock.calls.at(-1)?.[0].id, ok: true, ...extra });
  return { client, send, receive: (value: unknown) => receive(value), disconnected: () => disconnected(), detach, ack };
}
afterEach(() => vi.useRealTimers());
it("waits for strict read/write acknowledgements instead of treating send as durable", async () => {
  const f = setup(), read = f.client.recovery.read(); let done = false; void read.then(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false);
  f.ack({ checkpoint }); expect(await read).toEqual(checkpoint);
  const write = f.client.recovery.write(checkpoint); expect(f.send.mock.calls[1][0].packet.checkpoint).toEqual(checkpoint);
  f.ack(); expect(await write).toBeUndefined(); f.client.dispose();
});
it("represents only an explicit null checkpoint acknowledgement as absence", async () => {
  const f = setup(), read = f.client.recovery.read(); f.ack({ checkpoint: null }); expect(await read).toBeUndefined(); f.client.dispose();
});
it("fences malformed, foreign, failed, secret-bearing and mismatched acknowledgements", async () => {
  for (const bad of [null, {}, { epoch: "foreign" }, { id: 999 }, { ok: false, error: "private-value" }, { checkpoint: { ...checkpoint, env: { TOKEN: "private" } } }, { checkpoint, path: "/private" }]) {
    const f = setup(), read = f.client.recovery.read(), rejected = expect(read).rejects.toThrow("service-recovery-transport-unconfirmed");
    if (bad === null) f.receive(null); else f.ack(bad); await rejected;
    expect(() => f.client.verify()).toThrow(); await expect(f.client.recovery.write(checkpoint)).rejects.toThrow(); expect(f.send).toHaveBeenCalledTimes(1);
  }
});
it("refuses concurrent requests without dispatching another write", async () => {
  const f = setup(), read = f.client.recovery.read();
  await expect(f.client.recovery.write(checkpoint)).rejects.toThrow("service-recovery-request-in-flight"); expect(f.send).toHaveBeenCalledTimes(1);
  f.ack({ checkpoint: null }); await read; f.client.dispose();
});
it("fences timeout, disconnect, dispose and possibly sent failures with no retries or late success", async () => {
  vi.useFakeTimers();
  for (const mode of ["timeout", "disconnect", "dispose", "send-failure"] as const) {
    const f = setup(); if (mode === "send-failure") f.send.mockImplementation(() => { throw Error("private-send-error"); });
    const write = f.client.recovery.write(checkpoint), rejected = expect(write).rejects.toThrow("service-recovery-transport-unconfirmed");
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(50);
    if (mode === "disconnect") f.disconnected(); if (mode === "dispose") f.client.dispose();
    await rejected; f.ack(); await expect(f.client.recovery.read()).rejects.toThrow(); expect(f.send).toHaveBeenCalledTimes(1);
  }
});
it("fences duplicate acks rather than applying them to the next operation", async () => {
  const f = setup(), read = f.client.recovery.read(); f.ack({ checkpoint: null }); await read;
  f.ack({ checkpoint: null }); expect(() => f.client.verify()).toThrow(); expect(f.detach).toHaveBeenCalled();
});
it("snapshots trusted scope and validates outbound records before send", async () => {
  const input = { ...scope }; const send = vi.fn(); let receive!: (value: unknown) => void;
  const client = experimentalCheckpointClient({ send, subscribe: (callback) => { receive = callback; return () => {}; } }, input);
  input.epoch = "changed";
  const read = client.recovery.read(); expect(send.mock.calls[0][0].packet.epoch).toBe(scope.epoch);
  receive({ kind: "checkpoint-ack", epoch: scope.epoch, id: 1, ok: true, checkpoint: null }); await read;
  await expect(client.recovery.write({ ...checkpoint, taskId: "foreign" })).rejects.toThrow("invalid-service-recovery"); expect(send).toHaveBeenCalledTimes(1); client.dispose();
});
