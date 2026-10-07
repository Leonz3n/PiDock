import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReviewedServiceLeafDriver, SERVICE_LEAF_SOURCE_SHA256 } from "./service-owned-driver.js";
import type { ServiceOwnerLaunch } from "./service-execution-experiment.js";
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const identity = { workspaceId: "service-owner-fixture", taskId: "task-service-owner", sessionId: "main", serviceId: "s-11111111-1111-4111-8111-111111111111", generation: 1, configRevision: "fixed-v1" };
function fixture() {
  const launch: ServiceOwnerLaunch = { capability: "reviewed-no-child-fixture", program: realpathSync(process.execPath), args: [resolve("scripts/fixtures/service-owned-leaf.mjs")], cwd: realpathSync(process.cwd()),
    env: { FIXTURE_VALUE: "synthetic-service-value" }, envRevision: "fixed-env-v1", sourceSha256: SERVICE_LEAF_SOURCE_SHA256,
    programSha256: createHash("sha256").update(readFileSync(process.execPath)).digest("hex") };
  const child = Object.assign(new EventEmitter(), { pid: 123, stdout: new PassThrough(), stderr: new PassThrough() });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const driver = new ReviewedServiceLeafDriver(launch);
  const close = () => { child.stdout.write(JSON.stringify({ kind: "fixed-service-leaf", value: "synthetic-service-value", keys: ["FIXTURE_VALUE"], cwd: launch.cwd, pid: 123 }) + "\nfixed-service-leaf-complete\n"); child.emit("close", 0, null); };
  return { launch, child, driver, close };
}
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const nodeDescriptor = Object.getOwnPropertyDescriptor(process.versions, "node")!;
beforeEach(() => {
  // These OS observations join the mocked spawn boundary; no host platform earns fixture proof.
  Object.defineProperty(process, "platform", { configurable: true, get: () => platformDescriptor.value });
  Object.defineProperty(process.versions, "node", { configurable: true, get: () => nodeDescriptor.value });
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.spyOn(process.versions, "node", "get").mockReturnValue("24.21.0");
});
afterEach(() => {
  vi.useRealTimers(); vi.clearAllMocks(); vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platformDescriptor); Object.defineProperty(process.versions, "node", nodeDescriptor);
});
it("reviewed leaf refuses unreviewed source and ambient preload env with zero OS dispatch", async () => {
  for (const mode of ["source", "env"] as const) {
    const f = fixture();
    if (mode === "source") f.launch.sourceSha256 = "a".repeat(64); else f.launch.env.NODE_OPTIONS = "--require=unknown";
    const driver = new ReviewedServiceLeafDriver(f.launch), session = await driver.start(identity, f.launch);
    expect(await session.completion).toMatchObject({ event: "not-started", ...identity }); expect(spawn).not.toHaveBeenCalled();
  }
});
it("reviewed leaf binds exact fixture hashes and native close to its limited no-child receipt", async () => {
  const f = fixture(), session = await f.driver.start(identity, f.launch); f.child.emit("spawn");
  expect(spawn).toHaveBeenCalledWith(f.launch.program, f.launch.args, { cwd: f.launch.cwd, env: { FIXTURE_VALUE: "synthetic-service-value" }, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  f.close(); expect(await session.completion).toEqual({ ...identity, capability: "reviewed-no-child-fixture", sourceSha256: SERVICE_LEAF_SOURCE_SHA256,
    programSha256: f.launch.programSha256, envRevision: "fixed-env-v1", event: "exit", code: 0 });
  expect(f.driver.observation()).toMatchObject({ pid: 123, close: { code: 0, signal: null }, fixtureMatched: true, uncertain: false });
});
it("reviewed leaf caches unknown on the deadline and preserves the handle observation after late native close", async () => {
  vi.useFakeTimers(); const f = fixture(), session = await f.driver.start(identity, f.launch); f.child.emit("spawn");
  await vi.advanceTimersByTimeAsync(10_000); expect(await session.stop()).toMatchObject({ event: "unconfirmed", ...identity });
  f.close(); expect(await session.completion).toMatchObject({ event: "unconfirmed" }); expect(f.driver.observation()).toMatchObject({ pid: 123, close: { code: 0, signal: null }, uncertain: true });
});
it("reviewed leaf rejects native close without matching fixed fixture output", async () => {
  const f = fixture(), session = await f.driver.start(identity, f.launch); f.child.emit("close", 0, null);
  expect(await session.completion).toMatchObject({ event: "unconfirmed" }); expect(f.driver.observation().fixtureMatched).toBe(false);
});
it.each(["win32", "linux", "wrong-node"] as const)("reviewed leaf refuses unsupported runtime %s with zero OS dispatch", async (runtime) => {
  if (runtime === "wrong-node") vi.spyOn(process.versions, "node", "get").mockReturnValue("24.20.0");
  else vi.spyOn(process, "platform", "get").mockReturnValue(runtime);
  const f = fixture(), session = await f.driver.start(identity, f.launch);
  expect(await session.completion).toMatchObject({ ...identity, event: "not-started" }); expect(spawn).not.toHaveBeenCalled();
  expect(f.driver.observation()).toMatchObject({ pid: null, close: null, uncertain: false });
});
