import { expect, it, vi } from "vitest";
import { experimentalShutdownClient } from "./host-shutdown-client-experiment.js";
const epoch = "11111111-2222-4333-8444-555555555555", report = { schemaVersion: 1 as const, taskId: "task-a", hostEpoch: epoch, status: "closed" as const };
function fixture(timeoutMs = 20) {
  let receive!: (value: unknown) => void, disconnect!: () => void;
  const send = vi.fn(), detach = vi.fn();
  const client = experimentalShutdownClient({ send, subscribe: (read, closed) => { receive = read; disconnect = closed; return detach; } }, { taskId: "task-a", epoch, timeoutMs });
  return { client, send, detach, receive: (value: unknown) => receive(value), disconnect: () => disconnect(), ack: () => receive({ kind: "shutdown-report-ack", id: 1, epoch, ok: true }) };
}
it("rejects invalid trusted scope and deadline before installing a transport listener", () => {
  const subscribe = vi.fn(() => () => {}), transport = { subscribe, send: vi.fn() };
  for (const scope of [{ taskId: null, epoch }, { taskId: "task-a", epoch: "foreign" }, { taskId: "task-a", epoch, timeoutMs: 0 }]) expect(() => experimentalShutdownClient(transport, scope as never)).toThrow("invalid-shutdown-client");
  expect(subscribe).not.toHaveBeenCalled();
});
it("awaits the exact current-epoch ack and sends/caches a single report", async () => {
  const f = fixture(), pending = f.client.persist(report); expect(f.client.persist(report)).toBe(pending);
  let settled = false; void pending.then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
  expect(f.send).toHaveBeenCalledWith({ kind: "shutdown-report-request", id: 1, packet: { op: "shutdown", epoch, report } });
  f.ack(); await pending; expect(f.client.persist(report)).toBe(pending); expect(f.send).toHaveBeenCalledTimes(1); f.client.verify();
});
it("fences timeout, late ack and disconnect without resending", async () => {
  for (const mode of ["timeout", "disconnect"]) {
    const f = fixture(10), pending = f.client.persist(report), failed = expect(pending).rejects.toThrow("shutdown-report-unconfirmed");
    if (mode === "disconnect") f.disconnect(); await failed; f.ack();
    expect(() => f.client.verify()).toThrow(); await expect(f.client.persist(report)).rejects.toThrow(); expect(f.send).toHaveBeenCalledTimes(1);
  }
});
it.each([null, { kind: "shutdown-report-ack", id: 2, epoch, ok: true }, { kind: "shutdown-report-ack", id: 1, epoch: "foreign", ok: true }, { kind: "shutdown-report-ack", id: 1, epoch, ok: false }, { kind: "shutdown-report-ack", id: 1, epoch, ok: true, payload: report }])("refuses malformed/foreign acknowledgement %j", async (ack) => {
  const f = fixture(), pending = f.client.persist(report), failed = expect(pending).rejects.toThrow("shutdown-report-unconfirmed"); f.receive(ack); await failed; expect(() => f.client.verify()).toThrow();
});
it("fences duplicate receipts and potentially sent transport exceptions", async () => {
  const f = fixture(); const pending = f.client.persist(report); f.ack(); await pending; f.ack(); expect(() => f.client.verify()).toThrow();
  const other = fixture(); other.send.mockImplementation(() => { throw Error("synthetic-private-error"); }); await expect(other.client.persist(report)).rejects.toThrow("shutdown-report-unconfirmed"); expect(() => other.client.verify()).toThrow();
});
