import { expect, it } from "vitest";
import { HostTaskAdmission } from "./host-task-admission.js";
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
it("seals synchronously and waits for every admitted operation, including rejected work", async () => {
  const gate = new HostTaskAdmission(), first = deferred(), second = deferred();
  const a = gate.run(() => first.promise), b = gate.run(async () => { await second.promise; throw Error("operation-refused"); });
  const rejected = expect(b).rejects.toThrow("operation-refused");
  gate.seal(); let drained = false; const drain = gate.drain().then(() => { drained = true; });
  let executed = false; await expect(gate.run(async () => { executed = true; })).rejects.toThrow("task-host-closing");
  expect(executed).toBe(false); first.resolve(); await a; await Promise.resolve(); expect(drained).toBe(false);
  second.resolve(); await rejected; await drain; expect(drained).toBe(true);
});
it("requires sealed admission before taking a shutdown snapshot", async () => {
  const gate = new HostTaskAdmission(); await expect(gate.drain()).rejects.toThrow("task-host-not-sealed");
  gate.seal(); gate.seal(); await gate.drain();
});
it("registers before invoking reentrant work and releases synchronous failures", async () => {
  const gate = new HostTaskAdmission(); let drained = false, drain!: Promise<void>;
  await expect(gate.run(() => { gate.seal(); drain = gate.drain().then(() => { drained = true; }); expect(drained).toBe(false); throw Error("operation-failed"); })).rejects.toThrow("operation-failed");
  await drain; expect(drained).toBe(true);
});
