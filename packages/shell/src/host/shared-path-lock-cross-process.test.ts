/**
 * [Pencil T06] #141 cross-process proof: two REAL processes writing the same or an
 * overlapping shared real directory mutually exclude, disjoint directories run in
 * parallel, a refusal names the actual holder, and a holder process killed with
 * SIGKILL is recovered by name (`lock-owner-dead`) instead of blocking forever.
 *
 * The children run the PRODUCTION lock module itself (loaded through the
 * repository's own TypeScript, no build step) with the same file format, the same
 * `realpath` keys and the same app-private directory this process uses; the
 * resolver hook is test scaffolding only (it maps this repo's `.js` specifiers to
 * their `.ts` sources inside the child).
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SHARED_PATH_LOCK_DIRECTORY, SHARED_PATH_LOCK_OWNER_DEAD, SharedPathLock } from "./shared-path-lock.js";

const EVIDENCE_TIMEOUT_MS = 90_000;
const here = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

const RESOLVER_HOOK = `
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".js") && (specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
      const candidate = new URL(specifier, context.parentURL);
      const tsUrl = new URL(candidate.href.replace(/\\.js$/, ".ts"));
      if (!existsSync(fileURLToPath(candidate)) && existsSync(fileURLToPath(tsUrl))) return { url: tsUrl.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
`;

/** A real process that holds the production lock, or names why it could not. */
const holderSource = (modulePath: string): string => `
import { SharedPathLock } from ${JSON.stringify(pathToFileURL(modulePath).href)};

const [userData, taskId, sessionId, ...paths] = process.argv.slice(2);
const lock = new SharedPathLock(userData, { notify: (message) => process.stderr.write(message + "\\n") });
const claimed = lock.claim({ taskId, sessionId, label: "回合工具 fs.write" }, paths);
process.stdout.write(JSON.stringify(claimed.ok
  ? { ok: true, added: claimed.added, pid: process.pid, hostInstance: lock.instanceId }
  : { ok: false, error: claimed.error, pid: process.pid, hostInstance: lock.instanceId }) + "\\n");
if (!claimed.ok) process.exit(2);
const stop = () => { lock.releaseTask(taskId); process.exit(0); };
process.stdin.resume();
process.stdin.on("data", stop);
process.stdin.on("end", stop);
setTimeout(stop, 120000);
`;

interface HolderLine {
  ok: boolean;
  added?: string[];
  error?: string;
  pid: number;
  hostInstance: string;
}

function readLine(child: ChildProcess, boundMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`holder produced no line within ${boundMs}ms: ${stderr}`)), boundMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolve(buffer.slice(0, newline));
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`holder exited before reporting (code ${String(code)}): ${stderr}`));
    });
  });
}

function launchHolder(userData: string, taskId: string, paths: readonly string[], home: string): Promise<{ child: ChildProcess; line: HolderLine }> {
  const hook = join(home, "ts-js-resolver.mjs");
  const script = join(home, `holder-${taskId}.ts`);
  writeFileSync(hook, RESOLVER_HOOK);
  writeFileSync(script, holderSource(join(here, "shared-path-lock.ts")));
  const child = spawn(
    process.execPath,
    ["--import", pathToFileURL(hook).href, script, userData, taskId, "main", ...paths],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  // A refused holder exits immediately: its stdin is a closed pipe, and an
  // unhandled EPIPE on that write would surface as a test-runner error.
  child.stdin?.on("error", () => undefined);
  children.push(child);
  return readLine(child, EVIDENCE_TIMEOUT_MS).then((line) => ({ child, line: JSON.parse(line) as HolderLine }));
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  // A refused child already exited and closed its stdin: writing to it would
  // throw EPIPE instead of stopping anything.
  try {
    if (!child.stdin?.destroyed) child.stdin?.write("release\n");
  } catch {
    /* the holder already exited */
  }
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

interface World {
  userData: string;
  home: string;
  shared: string;
  nested: string;
  other: string;
}

function world(): World {
  const userData = temp("pidock-sp-cross-userdata-");
  const home = temp("pidock-sp-cross-home-");
  const shared = realpathSync(temp("pidock-sp-cross-shared-"));
  const other = realpathSync(temp("pidock-sp-cross-other-"));
  const nested = join(shared, "nested");
  mkdirSync(nested);
  return { userData, home, shared, nested: realpathSync(nested), other };
}

function parentLock(w: World, options: { notify?: (message: string) => void } = {}): SharedPathLock {
  return new SharedPathLock(w.userData, options);
}

describe("两个真实 Host 进程访问共享／重叠真实目录", () => {
  it("同一目录与祖先／后代重叠互斥，拒绝说明另一个真实进程的持有者", async () => {
    const w = world();
    const holder = await launchHolder(w.userData, "task-holder", [w.shared], w.home);
    expect(holder.line.ok).toBe(true);
    expect(holder.line.pid).not.toBe(process.pid);

    const me = parentLock(w);
    const same = me.claim({ taskId: "task-mine", sessionId: "main", label: "回合工具 fs.write" }, [w.shared]);
    expect(same.ok).toBe(false);
    if (!same.ok) {
      expect(same.error).toContain("shared-path-locked");
      expect(same.error).toContain("task-holder");
      expect(same.error).toContain(holder.line.hostInstance);
      expect(same.error).toContain(`进程 ${String(holder.line.pid)}`);
    }
    // Descendant of the other process's real path is the same conflict.
    const descendant = me.claim({ taskId: "task-mine", sessionId: "main", label: "回合工具 fs.write" }, [w.nested]);
    expect(descendant.ok).toBe(false);
    // A disjoint directory runs in parallel while the child holds its own.
    const disjoint = me.claim({ taskId: "task-mine", sessionId: "main", label: "回合工具 fs.write" }, [w.other]);
    expect(disjoint.ok).toBe(true);

    // Completion releases: the child's own release frees the real path.
    await stopChild(holder.child);
    expect(me.claim({ taskId: "task-mine", sessionId: "main", label: "回合工具 fs.write" }, [w.shared]).ok).toBe(true);
  }, EVIDENCE_TIMEOUT_MS);

  it("两个真实进程同时抢同一目录：恰好一个成功，另一个按名拒绝", async () => {
    const w = world();
    const [first, second] = await Promise.all([
      launchHolder(w.userData, "task-first", [w.shared], w.home),
      launchHolder(w.userData, "task-second", [w.shared], w.home),
    ]);
    // Each child reports once; a loser exits 2 while the winner keeps stdin open.
    const lines = [first.line, second.line];
    const winners = lines.filter((line) => line.ok);
    expect(winners).toHaveLength(1);
    const loser = lines.find((line) => !line.ok);
    expect(loser?.error).toContain("shared-path-locked");
    // The refusal names the process that actually holds the directory.
    expect(loser?.error).toContain(`进程 ${String(winners[0]!.pid)}`);
    expect(loser?.error).toContain(winners[0]!.hostInstance);
    // Exactly one record is left for the real path.
    const records = readdirSync(join(w.userData, SHARED_PATH_LOCK_DIRECTORY)).filter((name) => /^[0-9a-f]{64}\.lock$/.test(name));
    expect(records).toHaveLength(1);
    await stopChild(first.child);
    await stopChild(second.child);
  }, EVIDENCE_TIMEOUT_MS);

  it("持有者进程被 SIGKILL：lock-owner-dead 具名恢复并保留凭据（崩溃不永久阻塞）", async () => {
    const w = world();
    const holder = await launchHolder(w.userData, "task-crashed", [w.shared], w.home);
    expect(holder.line.ok).toBe(true);
    const exited = new Promise<void>((resolve) => holder.child.once("exit", () => resolve()));
    holder.child.kill("SIGKILL");
    await exited;

    const announcements: string[] = [];
    const me = parentLock(w, { notify: (message) => announcements.push(message) });
    const recovered = me.claim({ taskId: "task-after-crash", sessionId: "main", label: "回合工具 fs.write" }, [w.shared]);
    expect(recovered.ok).toBe(true);
    const announced = announcements.join("\n");
    expect(announced).toContain(SHARED_PATH_LOCK_OWNER_DEAD);
    expect(announced).toContain("task-crashed");
    expect(announced).toContain(`进程 ${String(holder.line.pid)}`);
    const receipts = readdirSync(join(w.userData, SHARED_PATH_LOCK_DIRECTORY)).filter((name) => name.includes(".stale-"));
    expect(receipts).toHaveLength(1);
    // The recovered owner can write again afterwards: recovery is not a grab.
    expect(me.claim({ taskId: "task-other", sessionId: "main", label: "回合工具 fs.write" }, [w.shared]).ok).toBe(false);
  }, EVIDENCE_TIMEOUT_MS);

  it("清理后的现场没有遗留锁记录", async () => {
    const w = world();
    const lock = parentLock(w);
    expect(lock.claim({ taskId: "task-clean", sessionId: "main", label: "回合工具 fs.write" }, [w.shared]).ok).toBe(true);
    lock.releaseTask("task-clean");
    lock.dispose();
    const directory = join(w.userData, SHARED_PATH_LOCK_DIRECTORY);
    expect(existsSync(directory)).toBe(true);
    expect(readdirSync(directory).filter((name) => /^[0-9a-f]{64}\.lock$/.test(name))).toEqual([]);
  });
});
