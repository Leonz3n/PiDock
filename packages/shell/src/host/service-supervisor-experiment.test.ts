import { chmodSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchSupervisorExperiment, type SupervisorLaunch } from "./service-supervisor-experiment.js";

const directories: string[] = [];
function directory() { const dir = mkdtempSync(join(tmpdir(), "pidock-supervisor-bridge-")); directories.push(dir); return realpathSync(dir); }
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function launch(root: string, program = "/bin/sleep", args = ["30"]): SupervisorLaunch {
  const stat = statSync(root, { bigint: true });
  const identity = { device: stat.dev.toString(), inode: stat.ino.toString() };
  return { taskRoot: root, cwd: root, program, args, env: {}, rootIdentity: identity, cwdIdentity: identity, graceMs: 100 };
}
function fake(root: string, script: string) {
  const file = join(root, "fake-supervisor");
  writeFileSync(file, `#!${process.execPath}\n${script}`); chmodSync(file, 0o700); return file;
}
const options = { redact: (line: string) => line.replaceAll("private-value", "[redacted]"), onLine: () => {}, readyMs: 3000, stopMs: 3000 };

describe.skipIf(process.platform === "win32")("isolated supervisor protocol bridge", () => {
  it("bounds readiness and rejects malformed, oversized and duplicate status", async () => {
    const root = directory();
    for (const script of ["setInterval(()=>{},1000)", "console.log('not-json');setInterval(()=>{},1000)",
      "console.log('x'.repeat(600));setInterval(()=>{},1000)",
      "console.log(JSON.stringify({event:'ready',pid:1}));console.log(JSON.stringify({event:'ready',pid:1}));setInterval(()=>{},1000)"]) {
      const started = Date.now();
      try {
        const session = await launchSupervisorExperiment(fake(root, script), launch(root), { ...options, readyMs: 100 });
        expect(await session.stop()).toEqual({ event: "unconfirmed" });
      } catch (error) { expect(String(error)).toMatch(/supervisor-(ready-timeout|launch-unconfirmed)/); }
      expect(Date.now() - started).toBeLessThan(2500);
    }
  });
  it("does not treat stdio closure or a stop timeout as confirmed termination", async () => {
    const root = directory();
    for (const script of ["console.log(JSON.stringify({event:'ready',pid:1}));process.stdin.resume();process.stdin.once('data',()=>process.exit(0))",
      "console.log(JSON.stringify({event:'ready',pid:1}));setInterval(()=>{},1000)"]) {
      const session = await launchSupervisorExperiment(fake(root, script), launch(root), { ...options, stopMs: 100 });
      expect(await session.stop()).toEqual({ event: "unconfirmed" });
    }
  });
  it("rejects unsolicited stop receipts and valid-looking terminal receipts followed by abnormal exit", async () => {
    const root = directory();
    for (const script of [
      "console.log(JSON.stringify({event:'ready',pid:1}));console.log(JSON.stringify({event:'stopped'}))",
      "console.log(JSON.stringify({event:'ready',pid:1}));console.log(JSON.stringify({event:'exit'}));process.exitCode=2",
      "console.log(JSON.stringify({event:'ready',pid:1}));process.stdout.write('{');process.exitCode=0",
    ]) {
      try {
        const session = await launchSupervisorExperiment(fake(root, script), launch(root), options);
        expect(await session.completion).toEqual({ event: "unconfirmed" });
      } catch (error) { expect(String(error)).toContain("supervisor-launch-unconfirmed"); }
    }
  });
  it("caps delivered logs and fails closed if redaction throws", async () => {
    const root = directory(); const lines: string[] = [];
    const binary = fake(root, "console.log(JSON.stringify({event:'ready',pid:1}));process.stderr.write('line\\n'.repeat(250));console.log(JSON.stringify({event:'exit'}))");
    const session = await launchSupervisorExperiment(binary, launch(root), { ...options, onLine: (line) => lines.push(line) });
    expect(await session.completion).toEqual({ event: "exit", code: 0 });
    expect(lines).toHaveLength(201);
    expect(lines.at(-1)).toBe("[output exceeded 200 lines]");
    lines.length = 0;
    try {
      const broken = await launchSupervisorExperiment(binary, launch(root), { ...options, onLine: (line) => lines.push(line), redact: () => { throw Error("private-value"); } });
      expect(await broken.completion).toEqual({ event: "unconfirmed" });
    } catch (error) { expect(String(error)).toContain("supervisor-launch-unconfirmed"); }
    expect(lines).toEqual([]);
  });
  it("redacts before delivery, drops oversized whole lines and preserves final exit code", async () => {
    const root = directory(); const lines: string[] = [];
    const binary = fake(root, "console.log(JSON.stringify({event:'ready',pid:1}));process.stderr.write('private-');setTimeout(()=>{process.stderr.write('value\\n'+'x'.repeat(1999)+'private-value\\n');console.log(JSON.stringify({event:'exit',code:7}));},20)");
    const session = await launchSupervisorExperiment(binary, launch(root), { ...options, onLine: (line) => lines.push(line) });
    expect(await session.completion).toEqual({ event: "exit", code: 7 });
    expect(lines).toEqual(["[redacted]", "[output line exceeded 2000 characters]"]);
    expect(lines.join()).not.toContain("private-value");
  });
});

describe.skipIf(process.platform !== "darwin")("real macOS supervisor bridge", () => {
  it("confirms stop and control disconnect with pinned directory identities", async () => {
    const root = directory(); const binary = join(root, "supervisor");
    execFileSync("go", ["build", "-o", binary, "."], { cwd: resolve("native/service-supervisor"), timeout: 30000 });
    for (const disconnect of [false, true]) {
      const session = await launchSupervisorExperiment(binary, launch(root), options);
      expect(session.pid).toBeGreaterThan(0);
      expect(await (disconnect ? session.disconnect() : session.stop())).toEqual({ event: "stopped" });
      expect(await session.completion).toEqual({ event: "stopped" });
      expect(() => process.kill(session.pid, 0)).toThrow();
    }
    const lines: string[] = [];
    const session = await launchSupervisorExperiment(binary, { ...launch(root, "/bin/sh", ["-c", "echo $API_TOKEN; exit 3"]), env: { API_TOKEN: "private-value" } },
      { ...options, onLine: (line) => lines.push(line) });
    expect(await session.completion).toEqual({ event: "exit", code: 3 });
    expect(lines).toEqual(["[redacted]"]);
    const descendants: string[] = [];
    const parent = await launchSupervisorExperiment(binary, launch(root, "/bin/sh", ["-c", "sleep 30 & echo $!; exit 0"]),
      { ...options, onLine: (line) => descendants.push(line) });
    expect(await parent.completion).toEqual({ event: "exit", code: 0 });
    const descendant = Number(descendants[0]);
    expect(descendant).toBeGreaterThan(0);
    expect(() => process.kill(descendant, 0)).toThrow();
    descendants.length = 0;
    const waiting = await launchSupervisorExperiment(binary, launch(root, "/bin/sh", ["-c", "sleep 30 & echo $!; wait"]),
      { ...options, onLine: (line) => descendants.push(line) });
    try {
      for (let attempt = 0; !descendants.length && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(descendants.length).toBe(1);
      expect(await waiting.disconnect()).toEqual({ event: "stopped" });
      expect(() => process.kill(Number(descendants[0]), 0)).toThrow();
    } finally { await waiting.stop(); }
  }, 30000);
});
