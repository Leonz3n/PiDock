import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "../rpc/host-client.js";
import { diskTaskStore } from "./task-host.js";
import { buildTaskDiskRecord } from "./task-store.js";
import { TaskWriteCoordinator } from "./write-coordination.js";

/**
 * [PiDock 01] #90. Main used to set `PIDOCK_SERVICE_OWNER_REQUIRED=1` for every
 * bound task on every platform, and a Host that never received main's bootstrap
 * answered it by injecting an unverified `service-owner-inventory` orphan. On
 * win32 that bootstrap can never arrive: the durable recovery store refuses
 * win32 on its first line (`service-recovery-unavailable`, measured on this
 * machine), so main always fenced the binding. The write coordinator then
 * refused EVERY write with 「执行资源尚未核验（service-owner-inventory）」,
 * which is why the built-in terminal could never open on Windows.
 *
 * The fix treats a platform with no service execution as owning the empty set
 * of services: `serviceExecutionAdmitted` is false there, so main does not set
 * the variable and the Host does not inject the orphan. These tests drive the
 * real in-process Host - forked exactly the way main forks it for a bound task,
 * owner requirement included - and pin three things: the gate is gone on an
 * un-admitted platform, an admitted platform keeps it fail-closed, and the
 * session write lock was NOT relaxed with the orphan.
 */
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** The platform this test file means by "cannot own a service". */
const UNADMITTED: NodeJS.Platform = "win32";

function onPlatform(platform: NodeJS.Platform): () => void {
  const saved = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  return () => Object.defineProperty(process, "platform", saved);
}

async function installed() {
  vi.resetModules();
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pidock-owner-admission-")));
  // Windows keeps a handle on the task folder for a beat after the just-stopped
  // ConPTY terminal's process tree is reaped, so removal retries like the other
  // real-terminal fixture in this suite.
  cleanups.push(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const profile = join(home, "profile"), root = join(home, "tasks"), taskId = "task-12345678", taskDir = join(root, taskId), workspaceId = "workspace-a";
  mkdirSync(profile, { mode: 0o700 });
  mkdirSync(join(taskDir, "work"), { recursive: true });
  diskTaskStore.writeTask(taskDir, buildTaskDiskRecord({ taskId, name: "Admission", dirId: taskId, branch: "task/main", root, taskDir,
    remoteBranch: "main", baseCommit: "source-fixture", repos: ["work"], now: "2026-01-01T00:00:00.000Z" }));
  const child = new EventEmitter() as EventEmitter & { postMessage(value: unknown): void; kill(): void };
  child.kill = vi.fn(() => { child.emit("exit", 0); });
  const parent = new EventEmitter() as EventEmitter & { postMessage(value: unknown): void };
  child.postMessage = (value) => { parent.emit("message", { data: value }); };
  parent.postMessage = (value) => { child.emit("message", value); };
  const oldPort = Object.getOwnPropertyDescriptor(process, "parentPort");
  Object.defineProperty(process, "parentPort", { configurable: true, value: parent });
  cleanups.push(() => { if (oldPort) Object.defineProperty(process, "parentPort", oldPort); else Reflect.deleteProperty(process, "parentPort"); });
  // The fork-time environment main builds for a bound task, owner requirement
  // included: this file measures the Host's answer to that requirement.
  for (const [name, value] of Object.entries({ PIDOCK_WORKSPACE_ID: workspaceId, PIDOCK_TASK_ID: taskId, PIDOCK_TASK_DIR: taskDir,
    PIDOCK_PROTECTED_PROFILE: profile, PIDOCK_SERVICE_OWNER_REQUIRED: "1" })) vi.stubEnv(name, value);
  const { startHost } = await import("./host.js");
  startHost();
  const client = new HostClient(child as never);
  cleanups.push(async () => { client.dispose(); child.emit("exit", 0); });
  const task = (op: Parameters<HostClient["task"]>[0]["op"], payload: Record<string, unknown> = {}) =>
    client.task({ workspaceId, taskId, op, payload, origin: { kind: "shell-ui", senderWebContentsId: 7 } });
  /** A failed Host op answers with an error response, which the RPC client rejects. */
  const request = async (op: Parameters<HostClient["task"]>[0]["op"], payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    try { return (await task(op, payload)).payload; } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  };
  const orphans = async () => (await task("task/sessionStates")).payload["orphans"];
  return { profile, taskId, taskDir, task, request, orphans };
}

/** One human terminal keystroke: the shortest real path through the write gate. */
const humanTerminalInput = { instanceId: "term-absent", action: "input", data: "\r" };

describe("the service-owner requirement on a platform without service execution", () => {
  it("does not inject the owner orphan and does not gate a human terminal operation", async () => {
    const f = await installed();
    const restore = onPlatform(UNADMITTED);
    try {
      // The owner's symptom, verbatim: a human terminal operation refused by the
      // durability gate instead of reaching its own terminal.
      const input = await f.request("task/terminalControl", humanTerminalInput);
      expect(input["error"]).toContain("terminal-not-running");
      expect(input["error"]).not.toContain("执行资源尚未核验");
      expect(await f.orphans()).toEqual([]);
    } finally { restore(); }
  });

  /**
   * A real terminal start needs the un-admitted platform's pinned ConPTY
   * payload, so this row is skipped off win32 BY NAME instead of passing
   * silently; the stubbed test above covers the same gate on every platform.
   */
  const realWin32Terminal = process.platform === UNADMITTED;
  it.skipIf(!realWin32Terminal)("still really starts a human terminal on the un-admitted platform", { timeout: 90_000 }, async () => {
    const f = await installed();
    const started = await f.request("task/terminalControl", { instanceId: "human-term-1", action: "start", rootId: "work",
      program: process.env["ComSpec"] ?? "cmd.exe", args: ["/c", "ping -n 30 127.0.0.1 >nul"],
      layers: { repoDefaults: [{ key: "PATH", value: `${process.env["SystemRoot"] ?? "C:\\Windows"}\\System32`, secret: false }], shared: [], privateEntries: [], task: [] } });
    expect(started["error"]).toBeUndefined();
    expect(started).toMatchObject({ instanceId: "human-term-1", action: "start", actor: "human", instance: { lifecycle: "running" } });
    const stopped = await f.request("task/terminalControl", { instanceId: "human-term-1", action: "stop" });
    expect(stopped["error"]).toBeUndefined();
    expect(stopped).toMatchObject({ instance: { lifecycle: "exited" } });
  });

  it("keeps the requirement fail-closed where service execution is admitted", async () => {
    const f = await installed();
    const restore = onPlatform("darwin");
    try {
      expect(await f.orphans()).toMatchObject([{ resourceId: "service-owner-inventory", kind: "service", ownerSessionId: null, verificationRequired: true }]);
      const input = await f.request("task/terminalControl", humanTerminalInput);
      expect(input["error"]).toContain("执行资源尚未核验（service-owner-inventory）");
    } finally { restore(); }
  });

  it("keeps the session write lock while the owner orphan is gone", () => {
    // The live resources the fixed Host reports on an un-admitted platform: the
    // empty set (asserted against the Host itself above). The lock that keeps two
    // sessions apart is a different rule and must not have been relaxed with it.
    const write = new TaskWriteCoordinator(() => []);
    const human = write.claimWrite("human-ui", "auto", { kind: "terminal-control", label: "终端启动 term-absent（用户显式操作）" });
    expect(human.ok).toBe(true);
    if (human.ok) write.releaseWrite(human.claimId);
    const held = write.claimWrite("session-a", "auto", { kind: "turn", label: "回合工具 fs.write" });
    expect(held.ok).toBe(true);
    expect(write.claimWrite("session-b", "auto", { kind: "turn", label: "回合工具 fs.write" }))
      .toMatchObject({ ok: false, verdict: "locked", owner: "session-a" });
    // The owner keeps working: the refusal is mutual exclusion, not a blanket lock.
    expect(write.claimDerivedExecution({ resourceId: "derived-a", sessionId: "session-a", label: "派生执行" })).toBe(true);
  });
});
