/**
 * Agent tool execution through the real Host and the real kernel ([PiDock 02m] #5).
 *
 * Production runs the model context in a worker thread. These tests replace that
 * one hop with a loopback `SdkContextClient` built from the same `toolHost`
 * option the worker receives; everything else is real: the real
 * `TaskWorkspaceHost`, the real `PiSdkTextKernel` with a stub local model runtime
 * that emits tool calls, the real permission gate (`PiSessionChannel`), the real
 * task write coordinator and the real filesystem of a temp git task.
 *
 * The stub model is the "no network" stand-in: it parses the user prompt as
 * `{ tool, args }`, emits exactly that tool call, and then reports the tool
 * result text back as its assistant reply — so a refusal is asserted exactly as
 * the model would read it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AssistantMessage, Model, Provider } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { TaskWorkspaceHost, memoryTaskStore } from "./task-host.js";
import { buildTaskDiskRecord, readTaskRecordOnDisk, serializeTaskRecord } from "./task-store.js";
import { PiSdkTextKernel } from "./sdk-text-kernel.js";
import { commandPathTokens, derivedPrimaryCheckouts, resolveSdkAgentToolPath } from "./sdk-agent-tool-broker.js";
import { SDK_AGENT_TOOL_NAMES } from "./sdk-agent-tool-contract.js";
import { protectApplicationProfile } from "./protected-application-path.js";
import type { SdkContextClient, SdkContextOptions } from "./sdk-context-client.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

const PROVIDER_CONFIG = {
  profileId: "p-11111111-2222-3333-4444-555555555555",
  baseUrl: "https://models.example.test/v1",
  modelId: "gpt-5-mini",
  contextWindow: 128000,
  maxTokens: 8192,
  authRef: "PIDOCK_PROVIDER_EXAMPLE",
  generation: 1,
};

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TEMPLATE_DIR: "",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.test",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.test",
};

const model: Model<"pidock-local-test"> = {
  id: "fixture", name: "Fixture", api: "pidock-local-test", provider: "local-test",
  baseUrl: "http://127.0.0.1/unused", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 2048, maxTokens: 128,
};
const usage = { input: 4, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

interface Fixture {
  root: string;
  taskDir: string;
  worktree: string;
  worktreeReal: string;
  checkout: string;
  otherTaskDir: string;
  profileDir: string;
}

/** A real git repo, a real linked worktree inside the task, a sibling task and a protected profile. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pidock-agent-tools-"));
  roots.push(root);
  const checkout = join(root, "primary");
  mkdirSync(checkout);
  execFileSync("git", ["init", "-q"], { cwd: checkout, env: GIT_ENV });
  writeFileSync(join(checkout, "notes.txt"), "original\n");
  execFileSync("git", ["add", "-A"], { cwd: checkout, env: GIT_ENV });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: checkout, env: GIT_ENV });

  const taskDir = join(root, "task-aaaaaaaa");
  mkdirSync(taskDir);
  execFileSync("git", ["worktree", "add", "-b", "task-branch", join(taskDir, "repo")], { cwd: checkout, env: GIT_ENV });
  writeFileSync(join(taskDir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({
    taskId: "task-aaaaaaaa", name: "task-aaaaaaaa", dirId: "task-aaaaaaaa", branch: "task-branch", root, taskDir,
    remoteBranch: "main", baseCommit: "test", repos: ["repo"], now: new Date().toISOString(),
  })));
  // Task creation always writes this regular marker file (holding the task id)
  // directly in the task folder (`main/project-task-creation.ts`), so a search
  // rooted at the task folder must skip it exactly like the `.pidock-*` folders.
  writeFileSync(join(taskDir, ".pidock-creation"), "task-aaaaaaaa");

  const otherTaskDir = join(root, "task-bbbbbbbb");
  mkdirSync(otherTaskDir);
  writeFileSync(join(otherTaskDir, "secret.txt"), "another task's work\n");

  const profileDir = join(root, "profile");
  mkdirSync(profileDir);
  writeFileSync(join(profileDir, "app.json"), "{}\n");

  const worktree = join(taskDir, "repo");
  return { root, taskDir, worktree, worktreeReal: realpathSync(worktree), checkout, otherTaskDir, profileDir };
}

/**
 * The stub model: the user prompt is `{ tool, args }` JSON, so the first request
 * emits exactly that tool call; the follow-up request (which carries the tool
 * result) answers with the result text, so a refusal reaches the assertions the
 * way the model would see it.
 */
async function stubRuntime(cacheDir: string): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    authPath: join(cacheDir, ".pidock-sdk-auth.json"),
    modelsPath: join(cacheDir, ".pidock-sdk-models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const provider: Provider<"pidock-local-test"> = {
    id: model.provider,
    name: "Fixture",
    auth: { apiKey: { name: "Local", resolve: async () => ({ auth: {} }) } },
    getModels: () => [model],
    stream: (_model, context, options) => provider.streamSimple(_model, context, options),
    streamSimple: (_model, context) => {
      const messages = context.messages as { role: string; content: unknown }[];
      const text = (value: unknown): string => typeof value === "string" ? value
        : Array.isArray(value) ? (value as { type: string; text?: string }[]).filter((part) => part.type === "text").map((part) => part.text ?? "").join("") : "";
      const lastToolResult = messages.at(-1)?.role === "toolResult" ? messages.at(-1) : undefined;
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      const partial: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [], usage, stopReason: "pending", timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial });
        if (lastToolResult) {
          const reply = `tool-result:${text(lastToolResult.content)}`;          partial.content.push({ type: "text", text: reply });
          stream.push({ type: "text_start", contentIndex: 0, partial });
          stream.push({ type: "text_end", contentIndex: 0, content: reply, partial });
          stream.push({ type: "done", reason: "stop", message: { ...partial, stopReason: "stop" } });
          return;
        }
        const call = JSON.parse(text(lastUser?.content ?? "")) as { tool: string; args: Record<string, unknown> };
        const toolCall = { type: "toolCall" as const, id: "stub-call", name: call.tool, arguments: call.args };
        partial.content.push(toolCall);
        stream.push({ type: "toolcall_start", contentIndex: 0, partial });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
        stream.push({ type: "done", reason: "toolUse", message: { ...partial, stopReason: "toolUse" } });
      });
      return stream;
    },
  };
  runtime.registerNativeProvider(provider);
  return runtime;
}

interface Harness {
  host: TaskWorkspaceHost;
  fixture: Fixture;
  prompt(tool: string, args: Record<string, unknown>): Promise<{ state: string; text: string }>;
}

/** The real Host with the worker hop replaced by a loopback context client. */
async function harness(): Promise<Harness> {
  const parts = fixture();
  const runtime = await stubRuntime(parts.taskDir);
  // The Host's source of truth about the task is its store; in production that
  // is `diskTaskStore` reading `task.json`. Seed the memory store with exactly
  // the record the fixture wrote so the scope is the real one.
  const store = memoryTaskStore();
  store.tasks.set(parts.taskDir, readTaskRecordOnDisk(parts.taskDir)!);
  const host = new TaskWorkspaceHost(
    "task-aaaaaaaa", parts.taskDir, store, () => "2026-09-22T10:00:00+08:00",
    () => [], undefined, undefined, undefined, undefined,
    (contextOptions: SdkContextOptions) => {
      const caller = contextOptions.toolHost;
      if (!caller) throw new Error("tool-host-missing");
      const kernel = new PiSdkTextKernel("task-aaaaaaaa", parts.taskDir, {
        model, modelRuntime: runtime,
        callTool: (sessionId, request) => caller.call(sessionId, request),
      });
      return {
        open: (sessionId: string) => kernel.open(sessionId),
        prompt: (sessionId: string, text: string, deliver?: Parameters<SdkContextClient["prompt"]>[2], issuedTurnId?: string) =>
          kernel.prompt(sessionId, text, deliver, issuedTurnId),
        cancel: (sessionId: string) => kernel.cancel(sessionId),
        seal: () => {},
        dispose: () => kernel.dispose(),
      } as unknown as SdkContextClient;
    },
    protectApplicationProfile(parts.profileDir),
  );
  let turn = 0;
  return {
    host,
    fixture: parts,
    async prompt(tool, args) {
      turn += 1;
      const issued = `00000000-0000-4000-8000-${String(turn).padStart(12, "0")}`;
      const result = await host.sdkTextKernel().prompt("main", JSON.stringify({ tool, args }), undefined, issued);
      return { state: result.state, text: result.text };
    },
  };
}

/**
 * Every file under `root` with its content, for "nothing changed" assertions.
 * The Host's own session/ledger bookkeeping is excluded: this asserts that no
 * *task* content changed, not that the Host wrote no journal.
 */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const relative = child.slice(root.length + 1);
      // Skip any path a `.pidock-*` segment takes part in. The check is on path
      // segments, not on a `/`-spelled substring: on win32 the same session
      // journal is `task-...\.pidock-sdk-sessions\...`, so a `/`-only predicate
      // fails to exclude it and the helper suddenly asserts on the journal it
      // exists to ignore.
      if (relative.split(/[\\/]/).some((segment) => segment.startsWith(".pidock-"))) continue;
      const stat = lstatSync(child);
      if (stat.isDirectory()) walk(child);
      else if (stat.isFile()) out[relative] = readFileSync(child).toString("base64");
      else out[relative] = `link:${readlinkSync(child)}`;
    }
  };
  walk(root);
  return out;
}

it("declares exactly the task tools (files, command and the #7 service surface) and executes a write inside the task worktree", async () => {
  const h = await harness();
  await h.host.configureSdkProvider({ config: PROVIDER_CONFIG, credential: "synthetic-key" });
  const opened = await h.host.sdkTextKernel().open("main");
  expect([...opened.tools].sort()).toEqual([...SDK_AGENT_TOOL_NAMES].sort());
  // [PiDock 04] #7 box 5: the Agent's service tools are declared to the session
  // like every other tool, i.e. every call reaches the one Host broker/gate.
  for (const name of ["service.status", "service.logs", "service.start", "service.stop"]) expect(opened.tools).toContain(name);

  const written = await h.prompt("fs.write", { path: "repo/new-file.txt", content: "written by the agent\n" });
  expect(written.state).toBe("done");
  // The change really landed in the task's own worktree, not in the original checkout.
  expect(readFileSync(join(h.fixture.worktree, "new-file.txt"), "utf8")).toBe("written by the agent\n");
  expect(existsSync(join(h.fixture.checkout, "new-file.txt"))).toBe(false);

  // The read comes back as the tool result the model sees.
  const read = await h.prompt("fs.read", { path: "repo/new-file.txt" });
  expect(read.text).toContain("written by the agent");
  await h.host.shutdownSdk();
});

it("lists and searches inside the task and runs a command in the worktree", async () => {
  const h = await harness();
  await h.host.configureSdkProvider({ config: PROVIDER_CONFIG, credential: "synthetic-key" });
  await h.host.setPermission("main", "auto");

  const listed = await h.prompt("fs.search", { path: "repo" });
  expect(listed.text).toContain("notes.txt");

  const searched = await h.prompt("fs.search", { path: "repo", pattern: "original" });
  expect(searched.text).toContain("notes.txt:1: original");

  const command = await h.prompt("exec.run", { command: "pwd && cat notes.txt" });
  const gitignore = await h.prompt("exec.run", { command: "echo node_modules > .gitignore" });
  // win32 (#53): `exec.run` executes through POSIX `/bin/sh -c` only and the Host
  // refuses by name there (no `cmd.exe` fallback, and none of "use `sh.exe` when
  // one is installed"), so the byte-level shell output below is unobserved on
  // win32: the named refusal is asserted instead, by the platform test that
  // follows this one.
  if (process.platform === "win32") {
    for (const result of [command, gitignore]) expect(result.text).toContain("tool-refused:exec-unsupported-platform");
    // A refused command has no effect, and `.gitignore` was going to be the
    // second command's whole effect.
    expect(existsSync(join(h.fixture.worktree, ".gitignore"))).toBe(false);
  } else {
    expect(command.text).toContain(h.fixture.worktreeReal);
    expect(command.text).toContain("original");
    expect(command.text).toContain("exit 0");
    // `.gitignore` is a legitimate token, not a `.git` control path: the escape
    // hardening must not refuse it.
    expect(gitignore.text).toContain("exit 0");
    expect(readFileSync(join(h.fixture.worktree, ".gitignore"), "utf8")).toBe("node_modules\n");
  }
  await h.host.shutdownSdk();
});

// win32 (#53): the platform refusal has to reach the caller as a NAME, because the failure it
// replaces is unnamed at the surface the Agent calls - `spawn("/bin/sh", …)` reports `ENOENT`,
// which the exec tool renders as `command-spawn-failed: spawn /bin/sh ENOENT` with `exit unknown`,
// leaving the model nothing to act on. This test is win32-only: off-win32 the very same call really
// executes the command (asserted above), so there is no refusal path to exercise - a named platform
// skip, not a silent one.
it.skipIf(process.platform !== "win32")("refuses exec.run by its own platform code instead of leaking an unnamed /bin/sh ENOENT", async () => {
  const h = await harness();
  await h.host.configureSdkProvider({ config: PROVIDER_CONFIG, credential: "synthetic-key" });
  await h.host.setPermission("main", "auto");

  const result = await h.prompt("exec.run", { command: "echo named > named.txt" });
  // The stable code the caller can act on, spelled as the tool result carries it.
  expect(result.text).toContain("tool-refused:exec-unsupported-platform");
  // Actionable: the refusal names what is missing and that nothing was started.
  expect(result.text).toContain("未启动任何进程");
  // The unnamed failure it replaces is not merely reformatted, it is gone.
  expect(result.text).not.toContain("command-spawn-failed");
  expect(result.text).not.toContain("ENOENT");
  expect(result.text).not.toContain("exit unknown");
  // Fail closed: the refusal ran nothing.
  expect(existsSync(join(h.fixture.worktree, "named.txt"))).toBe(false);
  await h.host.shutdownSdk();
});

it("refuses every escape vector by name and changes nothing on disk", async () => {
  const h = await harness();
  await h.host.configureSdkProvider({ config: PROVIDER_CONFIG, credential: "synthetic-key" });
  await h.host.setPermission("main", "auto");
  // Symlinks inside the worktree are real escape vectors: one resolves to an
  // existing directory outside the task (a read through it escapes), the other
  // two are dangling (a write through one would create the file outside).
  const outsideDir = join(tmpdir(), `pidock-agent-tools-escape-${process.pid}`);
  // The escaping link must resolve to a REAL outside target; through a missing
  // one the same request is refused as an unreadable/dangling target instead of
  // as the escape it is. `/etc` was the POSIX-only spelling of this target —
  // win32 has no `/etc`, so there the link dangled and the verdict changed.
  const escapeOutsideDir = join(tmpdir(), `pidock-agent-tools-escape-outside-${process.pid}`);
  mkdirSync(escapeOutsideDir, { recursive: true });
  writeFileSync(join(escapeOutsideDir, "outside.txt"), "outside the task\n");
  roots.push(escapeOutsideDir);
  // The glued escape vectors are spelled as POSIX absolute paths, not
  // `join(tmpdir(), …)`: the command-path filter examines only POSIX-shaped
  // tokens (a token must contain `/`, start with `~`, be exactly `..`, or name a
  // `.git` path), so a native `C:\…` token is not a shape it can classify and
  // the platform gate refuses it instead (pinned by the win32 tripwire test
  // below). `/tmp/…` is still an absolute path outside the task on both
  // platforms, so the same `out-of-scope` refusal is exercised everywhere.
  const glued = `/tmp/pidock-agent-tools-glued-${process.pid}.txt`;
  const glued2 = `/tmp/pidock-agent-tools-glued2-${process.pid}.txt`;
  // `ln -s` as a program does not exist on win32 (and `/tmp` is not a real path
  // there), so the links are created with Node's own API. `type` is ignored on
  // POSIX; on win32 a DIR-shaped link needs it, and a junction is NOT usable
  // for the two dangling targets (a junction must point at an existing absolute
  // directory).
  const link = (target: string, linkPath: string, shape: "file" | "dir"): void => {
    if (process.platform === "win32") symlinkSync(target, linkPath, shape);
    else symlinkSync(target, linkPath);
  };
  link(escapeOutsideDir, join(h.fixture.worktree, "link-outside"), "dir");
  link(join(outsideDir, "planted.txt"), join(h.fixture.worktree, "link-dangling.txt"), "file");
  link(join(outsideDir, "planted"), join(h.fixture.worktree, "link-dangling-dir"), "dir");
  const before = snapshot(h.fixture.root);
  const gitPointerBefore = readFileSync(join(h.fixture.worktree, ".git"), "utf8");

  const cases: { tool: string; args: Record<string, unknown>; code: string }[] = [
    { tool: "fs.write", args: { path: "/tmp/pidock-agent-tools-escape.txt", content: "escape" }, code: "tool-refused:out-of-scope" },
    { tool: "fs.write", args: { path: "../outside.txt", content: "escape" }, code: "tool-refused:other-task" },
    { tool: "fs.write", args: { path: "../../outside.txt", content: "escape" }, code: "tool-refused:out-of-scope" },
    { tool: "fs.write", args: { path: `${h.fixture.checkout}/notes.txt`, content: "escape" }, code: "tool-refused:primary-checkout" },
    { tool: "fs.write", args: { path: `${h.fixture.otherTaskDir}/secret.txt`, content: "escape" }, code: "tool-refused:other-task" },
    { tool: "fs.read", args: { path: `${h.fixture.profileDir}/app.json` }, code: "tool-refused:protected-path" },
    { tool: "fs.write", args: { path: "task.json", content: "escape" }, code: "tool-refused:not-a-worktree" },
    { tool: "fs.read", args: { path: "repo/link-outside/outside.txt" }, code: "tool-refused:out-of-scope" },
    // A dangling link is refused by the application-profile assert (it never
    // treats a link whose target is missing as a valid lexical path) — see the
    // resolver unit test below for the link-chain rule itself.
    { tool: "fs.read", args: { path: "repo/link-dangling.txt" }, code: "tool-refused:protected-path" },
    { tool: "fs.write", args: { path: "repo/link-dangling.txt", content: "escape" }, code: "tool-refused:protected-path" },
    { tool: "fs.write", args: { path: "repo/link-dangling-dir/planted.txt", content: "escape" }, code: "tool-refused:protected-path" },
    { tool: "exec.run", args: { command: "cat /etc/hosts" }, code: "tool-refused:out-of-scope" },
    { tool: "exec.run", args: { command: "cd .. && ls" }, code: "tool-refused:not-a-worktree" },
    { tool: "exec.run", args: { command: "echo escape > /tmp/pidock-agent-tools-escape.txt" }, code: "tool-refused:out-of-scope" },
    { tool: "exec.run", args: { command: "cat ~/.zshrc" }, code: "tool-refused:out-of-scope" },
    // A path glued to a shell operator must be recognised as a path, not read
    // as a relative token that resolves inside the worktree while the shell
    // writes outside it (`x>/tmp/y`, `cat</etc/hosts`, `sh -c '…>/tmp/y'`).
    { tool: "exec.run", args: { command: `echo x>${glued}` }, code: "tool-refused:out-of-scope" },
    { tool: "exec.run", args: { command: "cat</etc/hosts" }, code: "tool-refused:out-of-scope" },
    { tool: "exec.run", args: { command: `sh -c 'echo x>${glued2}'` }, code: "tool-refused:out-of-scope" },
    // A command whose expansion the filter cannot decode is refused, not run.
    { tool: "exec.run", args: { command: "cat $HOME/.zshrc" }, code: "tool-refused:unresolvable-command" },
    // The worktree's own git control file is not a write target: rewriting it
    // would retarget git at the primary checkout this module keeps out of reach.
    { tool: "fs.write", args: { path: "repo/.git", content: "gitdir: /tmp/primary/.git\n" }, code: "tool-refused:invalid-target" },
    // Case does not make it a different entry: on the product's case-insensitive
    // filesystems (APFS, Windows) `repo/.GIT` IS `repo/.git`, so a case-sensitive
    // segment compare would still overwrite the git pointer.
    { tool: "fs.write", args: { path: "repo/.GIT", content: "gitdir: /tmp/primary/.git\n" }, code: "tool-refused:invalid-target" },
    // The same control file through `exec.run`: the bare token `.git` carries no
    // `/`, so a filter that only examines path-shaped tokens never sees it.
    { tool: "exec.run", args: { command: "echo x > .git" }, code: "tool-refused:invalid-target" },
    { tool: "exec.run", args: { command: "echo x > ./.GIT" }, code: "tool-refused:invalid-target" },
    { tool: "exec.run", args: { command: "echo x > '.git'" }, code: "tool-refused:invalid-target" },
    { tool: "exec.run", args: { command: "echo x > \".GIT\"" }, code: "tool-refused:invalid-target" },
    // A control path carried as a value (`dd of=.git`) rather than as a bare or
    // operator-glued token is refused the same way.
    { tool: "exec.run", args: { command: "dd of=.git" }, code: "tool-refused:invalid-target" },
    { tool: "exec.run", args: { command: "GIT_DIR=.GIT git status" }, code: "tool-refused:invalid-target" },
    // A native win32 spelling of the control path (#70): the token carries no
    // `/`, so before the filter knew the shape it was not examined at all and
    // an eventual native shell would have written a `.git` control file. The
    // refusal is by name and platform-independent — the segment split is
    // separator-agnostic.
    { tool: "exec.run", args: { command: String.raw`echo x > C:\repo\.git\config` }, code: "tool-refused:invalid-target" },
    // A quoting/escaping spelling is the same control file to `/bin/sh`: POSIX
    // quote removal turns `.g\it`, `.gi\t` and `.g"i"t` into `.git`, but the raw
    // token carries no `/`, so a raw-token-only test drops it before any check.
    // `.gi\'t` is refused fail-closed too: the shell keeps its escaped quote
    // literal, but a filter that decodes escapes must not have to model the
    // exact quoting pass to stay safe.
    { tool: "exec.run", args: { command: "echo x > .g\\it" }, code: "tool-refused:invalid-target" },
    { tool: "exec.run", args: { command: "echo x > .gi\\t" }, code: "tool-refused:invalid-target" },
    { tool: "exec.run", args: { command: "echo x > .gi\\'t" }, code: "tool-refused:invalid-target" },
    { tool: "exec.run", args: { command: "echo x > .g\"i\"t" }, code: "tool-refused:invalid-target" },
    // The Host's own bookkeeping is not task content, whatever the case the
    // caller names it in (`.PIDOCK-*` and `TASK.JSON` are the same entries on
    // the product's filesystems).
    { tool: "fs.read", args: { path: "task.json" }, code: "tool-refused:protected-path" },
    { tool: "fs.read", args: { path: ".pidock-sdk-sessions" }, code: "tool-refused:protected-path" },
    { tool: "fs.read", args: { path: "TASK.JSON" }, code: "tool-refused:protected-path" },
    { tool: "fs.read", args: { path: ".PIDOCK-SDK-SESSIONS" }, code: "tool-refused:protected-path" },
    { tool: "exec.run", args: { command: "pwd", cwd: h.fixture.otherTaskDir }, code: "tool-refused:other-task" },
  ];
  for (const entry of cases) {
    const result = await h.prompt(entry.tool, entry.args);
    expect(result.text, `${entry.tool} ${JSON.stringify(entry.args)}`).toContain(entry.code);
    expect(result.text).toContain("refused");
  }
  expect(snapshot(h.fixture.root)).toEqual(before);
  // The worktree's git pointer is byte-identical: no `repo/.git` and no
  // `repo/.GIT` write reached it.
  expect(readFileSync(join(h.fixture.worktree, ".git"), "utf8")).toBe(gitPointerBefore);
  expect(existsSync("/tmp/pidock-agent-tools-escape.txt")).toBe(false);
  expect(existsSync(glued)).toBe(false);
  expect(existsSync(glued2)).toBe(false);
  expect(existsSync(join(outsideDir, "planted.txt"))).toBe(false);
  expect(existsSync(join(outsideDir, "planted"))).toBe(false);
  await h.host.shutdownSdk();
});

// win32 (#70): the same proposition #64's tripwire pinned, now with the outcome
// the rewrite of the filter is supposed to produce. #64 pinned that a native
// absolute token was NOT a shape `commandPathTokens` examined, so the platform
// gate was the only refusal between it and a real spawn (safe only because
// win32 has no `/bin/sh`, #53). Rewriting it is not a weakening:
// - retained: the platform gate's own behaviour, with a command whose tokens are
//   all in scope, so the filter correctly finds nothing and the named platform
//   refusal is still what reaches the caller;
// - additionally pinned: the same shape of command with a native absolute target
//   is refused BY THE FILTER (`out-of-scope`, the token resolved outside the
//   task), i.e. the token was extracted and handed to the permission layer
//   instead of passing through unrecognised.
// Either way nothing runs: the target does not exist afterwards.
it.skipIf(process.platform !== "win32")("refuses a native absolute command token in the filter, before the platform gate sees the command", async () => {
  const h = await harness();
  await h.host.configureSdkProvider({ config: PROVIDER_CONFIG, credential: "synthetic-key" });
  await h.host.setPermission("main", "auto");
  const nativeTarget = join(tmpdir(), `pidock-agent-tools-native-token-${process.pid}.txt`);
  const result = await h.prompt("exec.run", { command: `echo x>${nativeTarget}` });
  // A POSIX-shaped glue is refused `out-of-scope` by the filter (the escape test
  // above); this native-shaped one now is too, which is what proves the filter
  // saw it. The platform gate is a different refusal, so its absence here is the
  // evidence that the filter refuses first.
  expect(result.text).toContain("tool-refused:out-of-scope");
  expect(result.text).not.toContain("tool-refused:exec-unsupported-platform");
  expect(existsSync(nativeTarget)).toBe(false);
  // The retained half: no path-shaped token at all, so nothing for the filter to
  // refuse, and the named platform refusal is unchanged.
  const plain = await h.prompt("exec.run", { command: "echo named > named.txt" });
  expect(plain.text).toContain("tool-refused:exec-unsupported-platform");
  expect(existsSync(join(h.fixture.worktree, "named.txt"))).toBe(false);
  await h.host.shutdownSdk();
});

/**
 * The command-path filter's token set itself (#70) — the filter is the unit under
 * test here, so it is called directly.
 *
 * Two directions are pinned. The POSIX shapes that existed before #70 are pinned
 * token for token: the native shapes are an addition, and a filter that dropped
 * or reshaped one of the old tokens while adding them would be a regression, not
 * a fix. The native win32 shapes are pinned to arrive in that same set — this is
 * the collection the permission loop in `perform` walks, so "present here" is
 * "handed to the permission layer", not merely "recognised as a string".
 */
const POSIX_SHAPED_COMMANDS: { command: string; tokens: string[] }[] = [
  { command: "cat /etc/hosts", tokens: ["/etc/hosts"] },
  { command: "cat</etc/hosts", tokens: ["/etc/hosts"] },
  { command: "echo escape > /tmp/pidock-agent-tools-escape.txt", tokens: ["/tmp/pidock-agent-tools-escape.txt"] },
  { command: "cat ~/.zshrc", tokens: ["~/.zshrc"] },
  { command: "cd ..", tokens: [".."] },
  { command: "cd ../..", tokens: ["../.."] },
  { command: "echo x > .git", tokens: [".git"] },
  { command: "echo x > ./.GIT", tokens: ["./.GIT"] },
  // The `NAME=value` spelling is kept whole (only a `--flag=value` is split), so
  // the guard sees it through its `=` segment boundary.
  { command: "dd of=.git", tokens: ["of=.git"] },
  { command: "GIT_DIR=.GIT git status", tokens: ["GIT_DIR=.GIT"] },
  // The quoting/escaping spelling: the raw token is kept, no `/` needed, because
  // the `.git` guard decodes it too.
  { command: "echo x > .g\\it", tokens: [".g\\it"] },
  { command: "cat --file=/etc/passwd", tokens: ["/etc/passwd"] },
  { command: "sh -c 'echo x>/tmp/y'", tokens: ["/tmp/y"] },
  // No path-shaped token, so no token: adding native shapes must not invent one.
  { command: "pwd && cat notes.txt", tokens: [] },
  { command: "echo node_modules > .gitignore", tokens: [] },
  { command: "git add -A", tokens: [] },
];

it("keeps every pre-existing POSIX-shaped token, token for token (#70)", () => {
  for (const { command, tokens } of POSIX_SHAPED_COMMANDS) {
    expect(commandPathTokens(command), command).toEqual({ tokens, unresolvable: false });
  }
});

const NATIVE_SHAPED_COMMANDS: { command: string; tokens: string[]; note: string }[] = [
  { command: String.raw`echo x>C:\Windows\System32\x.exe`, tokens: [String.raw`C:\Windows\System32\x.exe`], note: "drive-absolute, backslash" },
  { command: "echo x>C:/Windows/System32/x.exe", tokens: ["C:/Windows/System32/x.exe"], note: "drive-absolute, forward slash" },
  { command: String.raw`echo x>C:\Windows/System32\x.exe`, tokens: [String.raw`C:\Windows/System32\x.exe`], note: "drive-absolute, mixed separators" },
  { command: String.raw`echo x>\\server\share\x.exe`, tokens: [String.raw`\\server\share\x.exe`], note: "UNC, backslash" },
  { command: String.raw`echo x>\\server/share\x.exe`, tokens: [String.raw`\\server/share\x.exe`], note: "UNC, mixed separators" },
  { command: "echo x>//server/share/x.exe", tokens: ["//server/share/x.exe"], note: "UNC, forward slash (already a `/` token before #70)" },
  { command: "cp notes.txt C:foo", tokens: ["C:foo"], note: "drive-relative" },
  { command: "cp notes.txt D:relative", tokens: ["D:relative"], note: "drive-relative, foreign drive" },
  { command: "cp notes.txt x:", tokens: ["x:"], note: "drive-relative, bare drive" },
  { command: String.raw`FOO=C:\x cmd`, tokens: [String.raw`FOO=C:\x`], note: "assignment value" },
  { command: String.raw`dd of=D:\x`, tokens: [String.raw`of=D:\x`], note: "`NAME=value` payload" },
  { command: String.raw`cat --file=C:\x`, tokens: [String.raw`C:\x`], note: "flag payload" },
  { command: String.raw`echo x > C:\repo\.git\config`, tokens: [String.raw`C:\repo\.git\config`], note: "native spelling of a .git control path" },
];

it("extracts native win32 absolute and drive-relative tokens into the checked set (#70)", () => {
  for (const { command, tokens, note } of NATIVE_SHAPED_COMMANDS) {
    expect(commandPathTokens(command), `${note}: ${command}`).toEqual({ tokens, unresolvable: false });
  }
  // The set, not the string: a native token and a POSIX token in one command both
  // reach the permission loop, in command order.
  expect(commandPathTokens(String.raw`cp /etc/hosts C:\Windows\x.txt`)).toEqual({
    tokens: ["/etc/hosts", String.raw`C:\Windows\x.txt`],
    unresolvable: false,
  });
});

/**
 * The over-refusal measurement that drove the rule's boundaries (#70): a false
 * token means a legitimate command is refused, and the permission layer is the
 * only thing between a token and a refusal.
 *
 * Measured against the repo's own command strings (all `command:` literals of
 * its tests) and its commit-message prose: the only new prose class the native
 * rules capture is a single letter followed by `:` (`a:`), while the shapes that
 * ordinary prose and shells are full of — `docs:`, `Host:`, `12:30`, a URL,
 * `%h:%s`, an escaped-space grep — are not tokens at all, before or after. That
 * is why the drive-relative rule is anchored at a token/value boundary
 * (`(?:^|=)[A-Za-z]:`) instead of matching any `letter:` anywhere.
 *
 * The `a:` case is pinned as a TOKEN on purpose: it is the accepted, measured
 * cost of covering drive-relative at all (`D:relative` resolves to `D:\relative`
 * on win32, outside the worktree — see the rule's comment in the broker), not an
 * oversight. It only becomes a refusal when a single-letter argument is used,
 * and on win32 the permission layer then reports it as out-of-scope.
 */
const PROSE_COMMANDS: { command: string; tokens: string[] }[] = [
  { command: 'git commit -m "docs: note the trade"', tokens: [] },
  { command: "curl -H 'Host: example.test'", tokens: [] },
  { command: "git log --format=%h:%s", tokens: [] },
  { command: "echo ratio 3:1", tokens: [] },
  { command: "grep '\\w' notes.txt", tokens: [] },
  { command: "grep -e a: notes.txt", tokens: ["a:"] },
];

it("adds no token to ordinary prose and shell arguments (#70)", () => {
  for (const { command, tokens } of PROSE_COMMANDS) {
    expect(commandPathTokens(command), command).toEqual({ tokens, unresolvable: false });
  }
  // A command the filter cannot decode is still refused whole, not tokenised.
  expect(commandPathTokens("cat $HOME/.zshrc")).toEqual({ tokens: [], unresolvable: true });
  expect(commandPathTokens("echo `date` > C:\\x")).toEqual({ tokens: [], unresolvable: true });
});


it("never returns the task host's own bookkeeping from a search rooted at the task folder", async () => {
  const h = await harness();
  await h.host.configureSdkProvider({ config: PROVIDER_CONFIG, credential: "synthetic-key" });
  await h.host.setPermission("main", "auto");

  // `original` matches the worktree file, and this request's own prompt (with
  // its pattern) is echoed into the session JSONL under `.pidock-sdk-sessions`:
  // a traversal that walked the Host's state would report a match there.
  const worktree = await h.prompt("fs.search", { path: ".", pattern: "original" });
  // The product reports the platform-native relative path, so the expected
  // string is built with the platform separator (POSIX stays byte-identical).
  expect(worktree.text).toContain(`${join("repo", "notes.txt")}:1: original`);
  expect(worktree.text).not.toContain(".pidock-");

  // `task-aaaaaaaa` is the id in the task record itself: a traversal of the task
  // folder must not hand the top-level `task.json` back as searchable content.
  const record = await h.prompt("fs.search", { path: ".", pattern: "task-aaaaaaaa" });
  expect(record.text).not.toContain("task.json");
  expect(record.text).not.toContain(".pidock-");
  await h.host.shutdownSdk();
});

it("never returns the .pidock-creation marker or any .pidock-* file, but still returns a repo file", async () => {
  const h = await harness();
  await h.host.configureSdkProvider({ config: PROVIDER_CONFIG, credential: "synthetic-key" });
  await h.host.setPermission("main", "auto");
  // A regular `.pidock-*` file (not a directory) beside the marker: the
  // traversal's directory skip alone would still hand both back as content.
  writeFileSync(join(h.fixture.taskDir, ".pidock-notes.txt"), "task-aaaaaaaa\n");

  const marker = await h.prompt("fs.search", { path: ".", pattern: "task-aaaaaaaa" });
  expect(marker.text).not.toContain(".pidock-creation");
  expect(marker.text).not.toContain(".pidock-notes");
  expect(marker.text).not.toContain(".pidock-");

  // The skip narrows Host state only: a normal repository file is still found.
  const repo = await h.prompt("fs.search", { path: ".", pattern: "original" });
  expect(repo.text).toContain(`${join("repo", "notes.txt")}:1: original`);
  await h.host.shutdownSdk();
});

it("refuses a path outside the task even when the target does not exist yet", async () => {
  // The symlink cases above prove the real-path check; this proves the lexical
  // one for a path that cannot be created at all.
  const h = await harness();
  await h.host.configureSdkProvider({ config: PROVIDER_CONFIG, credential: "synthetic-key" });
  await h.host.setPermission("main", "auto");
  const outside = join(h.fixture.root, "never-created.txt");
  const refused = await h.prompt("fs.write", { path: outside, content: "no" });
  expect(refused.text).toContain("tool-refused:other-task");
  expect(existsSync(outside)).toBe(false);
  await h.host.shutdownSdk();
});

it("read-only permission refuses write and command with zero side effect", async () => {
  const h = await harness();
  await h.host.configureSdkProvider({ config: PROVIDER_CONFIG, credential: "synthetic-key" });
  await h.host.setPermission("main", "read");
  const before = snapshot(h.fixture.root);

  const write = await h.prompt("fs.write", { path: "repo/read-only.txt", content: "no" });
  // The task write coordinator is the first refusal a read-only session meets
  // (`只读会话不持有写操作权`); either way nothing is executed.
  expect(write.text).toMatch(/tool-refused:(write-lock|gate-denied)/);
  const command = await h.prompt("exec.run", { command: "echo no > attempted.txt" });
  expect(command.text).toMatch(/tool-refused:(write-lock|gate-denied)/);
  // Reads stay available under read-only permission.
  const read = await h.prompt("fs.read", { path: "repo/notes.txt" });
  expect(read.text).toContain("original");
  // No confirmation was ever minted (nothing to approve retroactively).
  expect(h.host.listApprovals("main")).toEqual([]);
  expect(h.host.writeLockOwner).toBeNull();

  expect(snapshot(h.fixture.root)).toEqual(before);
  expect(existsSync(join(h.fixture.worktree, "attempted.txt"))).toBe(false);
  await h.host.shutdownSdk();
});

it("asks first for a command under default permission and executes nothing when rejected", async () => {
  const h = await harness();
  await h.host.configureSdkProvider({ config: PROVIDER_CONFIG, credential: "synthetic-key" });
  await h.host.setPermission("main", "default");
  const running = h.prompt("exec.run", { command: "echo approved > command.txt" });

  await vi.waitFor(() => expect(h.host.listApprovals("main").some((item) => item.status === "pending")).toBe(true));
  const approval = h.host.listApprovals("main").find((item) => item.status === "pending")!;
  // The confirmation must show the real operation, not only the cwd: two
  // different commands in one worktree otherwise render an identical card.
  expect(approval).toMatchObject({ tool: "exec.run", scope: "agent-tool", permissionAtRequest: "default", target: h.fixture.worktree, operation: "echo approved > command.txt" });
  h.host.reject("main", approval.id);

  const result = await running;
  expect(result.text).toContain("tool-refused:approval-rejected");
  expect(existsSync(join(h.fixture.worktree, "command.txt"))).toBe(false);
  await h.host.shutdownSdk();
});

it("executes an approved command exactly once and refuses to settle the same confirmation twice", async () => {
  const h = await harness();
  await h.host.configureSdkProvider({ config: PROVIDER_CONFIG, credential: "synthetic-key" });
  await h.host.setPermission("main", "default");
  const running = h.prompt("exec.run", { command: "echo approved > command.txt" });

  await vi.waitFor(() => expect(h.host.listApprovals("main").some((item) => item.status === "pending")).toBe(true));
  const approval = h.host.listApprovals("main").find((item) => item.status === "pending")!;
  h.host.approve("main", approval.id);

  const result = await running;
  // win32 (#53): the confirmation is still minted and spent (the one-shot assert
  // below is platform-independent), and the approved command then meets the named
  // platform refusal instead of running - the POSIX output is unobserved there.
  if (process.platform === "win32") {
    expect(result.text).toContain("tool-refused:exec-unsupported-platform");
    expect(existsSync(join(h.fixture.worktree, "command.txt"))).toBe(false);
  } else {
    expect(result.text).toContain("exit 0");
    expect(readFileSync(join(h.fixture.worktree, "command.txt"), "utf8")).toBe("approved\n");
  }
  expect(() => h.host.approve("main", approval.id)).toThrow(/不可重放|已处理|已消费/);
  await h.host.shutdownSdk();
});

it("a turn cancel withdraws the parked confirmation so a later approve cannot execute", async () => {
  const h = await harness();
  await h.host.configureSdkProvider({ config: PROVIDER_CONFIG, credential: "synthetic-key" });
  await h.host.setPermission("main", "default");
  const running = h.prompt("exec.run", { command: "echo turn-cancelled > turn-cancelled.txt" });

  await vi.waitFor(() => expect(h.host.listApprovals("main").some((item) => item.status === "pending")).toBe(true));
  const approval = h.host.listApprovals("main").find((item) => item.status === "pending")!;
  // `cancel` here is the router the turn transport uses for `task/sdkCancel`:
  // the SDK abort alone cannot unblock a tool parked on the Host broker, so
  // without the withdrawal this call (and the parked turn) never settle.
  await h.host.sdkTextKernel().cancel("main");
  await running;

  expect(existsSync(join(h.fixture.worktree, "turn-cancelled.txt"))).toBe(false);
  expect(h.host.listApprovals("main").filter((item) => item.status === "pending")).toEqual([]);
  expect(h.host.writeLockOwner).toBeNull();
  // A late approve of the withdrawn confirmation must not run the command.
  expect(() => h.host.approve("main", approval.id)).toThrow();
  expect(existsSync(join(h.fixture.worktree, "turn-cancelled.txt"))).toBe(false);
  await h.host.shutdownSdk();
});

it("writes are allowed under default permission while commands ask first", async () => {
  const h = await harness();
  await h.host.configureSdkProvider({ config: PROVIDER_CONFIG, credential: "synthetic-key" });
  await h.host.setPermission("main", "default");
  // The existing gate asks for commands (and browser actions) under `default`;
  // a file write inside the task's own worktree is not a command.
  const written = await h.prompt("fs.write", { path: "repo/no-ask.txt", content: "no ask\n" });
  expect(written.text).toContain("Successfully wrote");
  expect(readFileSync(join(h.fixture.worktree, "no-ask.txt"), "utf8")).toBe("no ask\n");
  expect(h.host.listApprovals("main")).toEqual([]);
  await h.host.shutdownSdk();
});

it("cancelling the session stops a parked tool call with no effect and releases the write right", async () => {
  const h = await harness();
  await h.host.configureSdkProvider({ config: PROVIDER_CONFIG, credential: "synthetic-key" });
  await h.host.setPermission("main", "default");
  const running = h.prompt("exec.run", { command: "echo cancelled > cancelled.txt" });

  await vi.waitFor(() => expect(h.host.writeLockOwner).toBe("main"));
  h.host.cancel("main");
  const result = await running;
  expect(result.text).toContain("tool-refused:approval-cancelled");
  expect(existsSync(join(h.fixture.worktree, "cancelled.txt"))).toBe(false);
  expect(h.host.writeLockOwner).toBeNull();
  expect(h.host.listApprovals("main").filter((item) => item.status === "pending")).toEqual([]);
  // `host.cancel` is the legacy session stop, not the SDK turn's cancel
  // authority: it deliberately fences the in-flight execution projection, so a
  // clean SDK shutdown is no longer reported (`sdk-execution-ledger.test.ts`
  // > "retains SDK success and permanently fences an execution whose terminal
  // transition is no longer valid" documents the same rule without tools).
  await expect(h.host.shutdownSdk()).rejects.toThrow("sdk-host-shutdown-unconfirmed");
});

it("a permission change never retroactively authorizes a parked request, and later requests follow the new tier", async () => {
  const h = await harness();
  await h.host.configureSdkProvider({ config: PROVIDER_CONFIG, credential: "synthetic-key" });
  await h.host.setPermission("main", "default");
  const parked = h.prompt("exec.run", { command: "echo parked > parked.txt" });

  await vi.waitFor(() => expect(h.host.listApprovals("main").some((item) => item.status === "pending")).toBe(true));
  const approval = h.host.listApprovals("main").find((item) => item.status === "pending")!;
  h.host.setPermission("main", "auto");
  h.host.approve("main", approval.id);

  const parkedResult = await parked;
  expect(parkedResult.text).toContain("tool-refused:permission-changed");
  expect(existsSync(join(h.fixture.worktree, "parked.txt"))).toBe(false);

  // The new tier applies to the next request: no confirmation is minted at all.
  const later = await h.prompt("exec.run", { command: "echo later > later.txt" });
  // win32 (#53): under `auto` the call really executes on POSIX and meets the named
  // platform refusal on win32, so the POSIX output is unobserved there (see the
  // win32-only platform test above); that no confirmation is minted holds either way.
  if (process.platform === "win32") {
    expect(later.text).toContain("tool-refused:exec-unsupported-platform");
    expect(existsSync(join(h.fixture.worktree, "later.txt"))).toBe(false);
  } else {
    expect(later.text).toContain("exit 0");
    expect(readFileSync(join(h.fixture.worktree, "later.txt"), "utf8")).toBe("later\n");
  }
  expect(h.host.listApprovals("main").filter((item) => item.status === "pending")).toEqual([]);
  await h.host.shutdownSdk();
});

it("holds the task write right while a mutating tool runs and refuses a concurrent human operation", async () => {
  const h = await harness();
  await h.host.configureSdkProvider({ config: PROVIDER_CONFIG, credential: "synthetic-key" });
  await h.host.setPermission("main", "default");
  const running = h.prompt("exec.run", { command: "echo locked > locked.txt" });

  await vi.waitFor(() => expect(h.host.writeLockOwner).toBe("main"));
  // The human terminal start takes the same right through the same coordinator.
  const human = h.host.claimWrite("human-ui", "auto", { kind: "terminal-control", label: "终端启动 t1（用户显式操作）" });
  expect(human.ok).toBe(false);
  if (human.ok) throw new Error("unreachable");
  expect(human.verdict).toBe("locked");
  expect(human.owner).toBe("main");

  const approval = h.host.listApprovals("main").find((item) => item.status === "pending")!;
  h.host.approve("main", approval.id);
  await running;
  // The lock is released when the tool completes.
  expect(h.host.writeLockOwner).toBeNull();
  const after = h.host.claimWrite("human-ui", "auto", { kind: "terminal-control", label: "终端启动 t1（用户显式操作）" });
  expect(after.ok).toBe(true);
  if (after.ok) h.host.releaseWrite(after.claimId);
  await h.host.shutdownSdk();
});

it("keeps the fail-closed provider-not-configured path and declares no tools without a Host caller", async () => {
  const h = await harness();
  await expect(h.host.sdkTextKernel().open("main")).rejects.toThrow("provider-not-configured");
  expect(h.host.sdkTextKernel().projection("main").source).toBe("sdk-jsonl");
  await h.host.shutdownSdk();

  // A kernel with a model selection but no Host caller still declares no tools.
  const parts = fixture();
  const runtime = await stubRuntime(parts.taskDir);
  const bare = new PiSdkTextKernel("task-aaaaaaaa", parts.taskDir, { model, modelRuntime: runtime });
  expect((await bare.open("main")).tools).toEqual([]);
  await bare.dispose();
});

// win32 (#57): both links below are FILE-shaped - the second is a link to the first, whose own
// target never exists - and a file symlink needs SeCreateSymbolicLinkPrivilege, which a normal user
// does not hold (measured under a restricted token, `runas /trustlevel:0x20000`: every
// `symlinkSync(..., "file")` fails `EPERM` there while a junction succeeds). A junction is the only
// link win32 creates without that privilege and it is directory-only, so it cannot stand in for a
// dangling file link; the external `ln -s` this fixture used cannot build it either (observed:
// `ln: failed to create symbolic link './dangling': No such file or directory`, with the target
// spelled `\tmp\...` - `join("/tmp", ...)` is not a real win32 path). Named skip: the
// link-chain-then-dangling-target proposition is unobserved on win32, not dropped silently.
it.skipIf(process.platform === "win32")("resolves a symlink chain (including a dangling link) to the path it really names", () => {
  const parts = fixture();
  const target = join("/tmp", `pidock-agent-tools-dangling-${process.pid}`, "planted.txt");
  // The external `ln -s` program is gone: Node's own API makes the very same link on POSIX, and on
  // win32 a file link has no shape a normal user can create (see the skip above).
  symlinkSync(target, join(parts.worktree, "dangling"));
  symlinkSync("dangling", join(parts.worktree, "dangling-alias"));
  const scope = {
    taskDir: parts.taskDir,
    taskRoot: parts.root,
    worktrees: [{ repoDir: "repo", path: parts.worktree }],
    primaryCheckouts: [] as string[],
    assertProtected: () => {},
  };
  const refused = resolveSdkAgentToolPath({
    scope,
    resolveRealPath: (path) => path,
    requested: "repo/dangling-alias",
    base: parts.taskDir,
    mode: "write",
  });
  expect(refused.ok).toBe(false);
  if (refused.ok) throw new Error("unreachable");
  // The refusal names the link's target, not the link: the chain was followed.
  expect(refused.code).toBe("tool-refused:out-of-scope");
  // The refusal names the link's target, not the link: the chain was followed.
  expect(refused.reason).toContain("pidock-agent-tools-dangling-");
  expect(refused.reason).not.toContain("dangling-alias");
  expect(existsSync(target)).toBe(false);
});

it("derives the original checkout from the worktree's own git pointer", async () => {
  const parts = fixture();
  // The pointer git writes is already a real path (macOS `/var` is a link).
  expect(derivedPrimaryCheckouts([parts.worktree])).toEqual([realpathSync(parts.checkout)]);
  expect(derivedPrimaryCheckouts([parts.taskDir])).toEqual([]);
});
