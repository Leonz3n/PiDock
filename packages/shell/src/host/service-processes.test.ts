import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskServiceProcesses } from "./service-processes.js";
import type { ServiceStartPlan } from "./service-runtime.js";

const dirs: string[] = [];
const taskDir = () => { const dir = mkdtempSync(join(tmpdir(), "pidock-service-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const plan = (serviceId: string, cwd: string, args: string[], env: Record<string, string> = {}): ServiceStartPlan =>
  ({ serviceId, cwd, program: process.execPath, args, env, runType: "long-lived" });

async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw Error("timed out waiting for child output");
}

describe("#7 Host-owned real service processes", () => {
  it("runs with only the planned environment, captures bounded output, and records actual exit", async () => {
    const root = taskDir();
    const lines: string[] = []; const exits: string[] = [];
    const processes = new TaskServiceProcesses(root, (_, line) => lines.push(line), (_, reason) => exits.push(reason), (line) => line.replaceAll("private-value", "[redacted]"));
    const pid = await processes.start(plan("one", root, ["-e", "console.log(process.env.PIDOCK_SENTINEL); console.log(process.env.PIDOCK_SECRET); console.log('a'.repeat(3000)); process.exit(3)"], { PIDOCK_SENTINEL: "planned", PIDOCK_SECRET: "private-value" }));
    expect(pid).toBeGreaterThan(0);
    await until(() => exits.length === 1);
    expect(lines).toContain("planned");
    expect(lines).toContain("[redacted]");
    expect(lines).not.toContain("private-value");
    expect(lines.every((line) => line.length <= 2000)).toBe(true);
    expect(exits).toEqual(["exit:3"]);
    expect(processes.ids()).toEqual([]);
  });

  it("stops only its registered child and rejects duplicate starts", async () => {
    const root = taskDir(); const exits: string[] = [];
    const processes = new TaskServiceProcesses(root, () => {}, (id) => exits.push(id), (line) => line);
    const running = ["-e", "setInterval(() => {}, 1000)"];
    await processes.start(plan("one", root, running));
    await processes.start(plan("two", root, running));
    await expect(processes.start(plan("one", root, running))).rejects.toThrow("already-running");
    try {
      await processes.stop("one");
      expect(processes.ids()).toEqual(["two"]);
      expect(exits).toEqual(["one"]);
    } finally { if (processes.ids().includes("two")) await processes.stop("two"); }
  });

  it("stops every owned child on normal Host cleanup", async () => {
    const root = taskDir(); const processes = new TaskServiceProcesses(root, () => {}, () => {}, (line) => line);
    const args = ["-e", "setInterval(() => {}, 1000)"];
    await processes.start(plan("one", root, args));
    await processes.start(plan("two", root, args));
    await processes.stopAll();
    expect(processes.ids()).toEqual([]);
  });

  it("never inherits an unrelated Host environment variable", async () => {
    const root = taskDir(); const lines: string[] = []; const exits: string[] = [];
    const previous = process.env.PIDOCK_UNRELATED;
    process.env.PIDOCK_UNRELATED = "host-only";
    try {
      const processes = new TaskServiceProcesses(root, (_, line) => lines.push(line), (_, reason) => exits.push(reason), (line) => line);
      await processes.start(plan("one", root, ["-e", "console.log(process.env.PIDOCK_UNRELATED || 'absent')"]));
      await until(() => exits.length === 1);
      expect(lines).toContain("absent");
      expect(lines).not.toContain("host-only");
    } finally {
      if (previous === undefined) delete process.env.PIDOCK_UNRELATED;
      else process.env.PIDOCK_UNRELATED = previous;
    }
  });

  it("reports spawn failure without leaving a registered process", async () => {
    const root = taskDir(); const processes = new TaskServiceProcesses(root, () => {}, () => {}, (line) => line);
    await expect(processes.start({ ...plan("missing", root, []), program: join(root, "missing-bin") })).rejects.toThrow();
    expect(processes.ids()).toEqual([]);
  });

  it("refuses other task directories and symlinks escaping its root before spawning", async () => {
    const root = taskDir(); const outside = taskDir();
    symlinkSync(outside, join(root, "escape"));
    const processes = new TaskServiceProcesses(root, () => {}, () => {}, (line) => line);
    await expect(processes.start(plan("one", outside, ["-e", "0"]))).rejects.toThrow("escapes task root");
    await expect(processes.start(plan("one", join(root, "escape"), ["-e", "0"]))).rejects.toThrow("escapes task root");
    mkdirSync(join(root, "sub"));
    await expect(processes.start(plan("one", join(root, "sub"), ["-e", "0"], {}))).resolves.toBeGreaterThan(0);
  });
});
