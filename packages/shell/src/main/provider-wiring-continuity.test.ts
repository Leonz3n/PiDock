import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ProviderWiring } from "./provider-ipc.js";
import { ProviderProfileStore } from "./provider-profile-store.js";
import { TaskWorkspaceHost, memoryTaskStore } from "../host/task-host.js";
import { buildTaskDiskRecord, serializeTaskRecord } from "../host/task-store.js";
import { SdkTurnTransport } from "../host/sdk-turn-transport.js";
import type { SdkContextClient, SdkContextOptions } from "../host/sdk-context-client.js";
import type { SdkTextResult } from "../host/sdk-text-kernel.js";

const INPUT = {
  name: "Synthetic Provider",
  baseUrl: "https://models.example.test/v1",
  modelId: "text-model",
  contextWindow: 128000,
  maxTokens: 8192,
  authRef: "PIDOCK_PROVIDER_CONTINUITY_TEST",
};
const SYNTHETIC_CREDENTIAL = "synthetic-continuity-test-only";
const fixtures: { root: string; hosts: TaskWorkspaceHost[] }[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await Promise.all(fixture.hosts.map((host) => host.shutdownSdk()));
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pidock-provider-continuity-"));
  const profileDir = join(root, "profile");
  const store = new ProviderProfileStore(profileDir);
  const env: Record<string, string | undefined> = { [INPUT.authRef]: SYNTHETIC_CREDENTIAL };
  const hosts = new Map<string, TaskWorkspaceHost>();
  const transports = new Map<string, SdkTurnTransport>();
  const prompts: { taskId: string; credential: string }[] = [];
  let heldReply: Promise<SdkTextResult> | undefined;
  let releaseReply: (() => void) | undefined;
  let heldOpen: Promise<void> | undefined;
  let releaseOpen: (() => void) | undefined;
  const cleanup = { root, hosts: [] as TaskWorkspaceHost[] };
  fixtures.push(cleanup);

  function taskHost(taskId: string) {
    const existing = hosts.get(taskId);
    if (existing) return existing;
    const dir = join(root, taskId);
    mkdirSync(dir);
    execFileSync("git", ["init", "-q", dir]);
    writeFileSync(join(dir, "task.json"), serializeTaskRecord(buildTaskDiskRecord({
      taskId, name: taskId, dirId: taskId, branch: "main", root, taskDir: dir,
      remoteBranch: "main", baseCommit: "test", repos: [], now: "2026-09-29T00:00:00.000Z",
    })));
    const context = (options: SdkContextOptions) => ({
      open: async () => {
        await heldOpen;
        return { sdkId: "synthetic-sdk", file: join(dir, "synthetic.jsonl"), tools: [] };
      },
      prompt: async () => {
        prompts.push({ taskId, credential: options.credential });
        return heldReply ?? { state: "done", text: "synthetic reply", events: [] } satisfies SdkTextResult;
      },
      cancel: async () => {},
      seal: () => {},
      dispose: async () => {},
    }) as unknown as SdkContextClient;
    const host = new TaskWorkspaceHost(taskId, dir, memoryTaskStore(), undefined, undefined,
      undefined, undefined, undefined, undefined, context);
    hosts.set(taskId, host);
    cleanup.hosts.push(host);
    return host;
  }

  // Mirrors the production installer: a committed terminal precedes changing
  // the actual Host context, and the transport is replaced only on success.
  const providers = new ProviderWiring(store, async (taskId, provider) => {
    transports.get(taskId)?.assertTerminalCommitted();
    await taskHost(taskId).configureSdkProvider(provider === null ? null : {
      config: store.config(provider.profileId), credential: provider.credential,
    });
    transports.delete(taskId);
  }, env);

  async function begin(taskId: string, requestId: string) {
    // This direct public-boundary probe checks actual context retirement, not
    // just UI state. The production start gate is tested separately through IPC.
    await providers.ensure(taskId, 7);
    return dispatch(taskId, requestId);
  }

  async function dispatch(taskId: string, requestId: string) {
    let transport = transports.get(taskId);
    if (!transport) {
      const host = taskHost(taskId);
      transport = new SdkTurnTransport(taskId, host.taskDir, host.sdkTextKernel());
      transports.set(taskId, transport);
    }
    return transport.start("main", requestId, "synthetic prompt", () => {});
  }

  async function send(taskId: string, requestId: string) {
    const turn = await begin(taskId, requestId);
    const transport = transports.get(taskId)!;
    await transport.waitForTerminal();
    return transport.status("main", requestId) ?? turn;
  }

  function holdNextPrompt() {
    heldReply = new Promise<SdkTextResult>((resolve) => {
      releaseReply = () => resolve({ state: "done", text: "synthetic reply", events: [] });
    });
  }

  async function settle(taskId: string) {
    releaseReply?.();
    heldReply = undefined;
    await transports.get(taskId)?.waitForTerminal();
  }

  function holdNextOpen() {
    heldOpen = new Promise<void>((resolve) => { releaseOpen = resolve; });
    return () => { releaseOpen?.(); heldOpen = undefined; };
  }

  return { store, env, providers, prompts, begin, dispatch, send, holdNextPrompt, holdNextOpen, settle };
}

it("refuses the next model request when the sole configured credential reference disappears", async () => {
  const { store, env, providers, prompts, send } = fixture();
  const profile = store.save(INPUT);
  await providers.select("task-a", profile.id, 7);
  expect(await send("task-a", "first")).toMatchObject({ state: "done" });
  expect(prompts).toHaveLength(1);

  delete env[INPUT.authRef];
  const requestCount = prompts.length;
  let refused = false;
  try { await send("task-a", "after-reference-removal"); }
  catch { refused = true; }
  expect({ state: providers.status("task-a").state, refused, newModelRequests: prompts.length - requestCount })
    .toEqual({ state: "credential-missing", refused: true, newModelRequests: 0 });
});

it("rejects an unusable designated credential before reusing a cached context", async () => {
  const { store, env, providers, prompts, send } = fixture();
  const profile = store.save(INPUT);
  await providers.select("task-a", profile.id, 7);
  expect(await send("task-a", "before-unusable")).toMatchObject({ state: "done" });
  env[INPUT.authRef] = "short";
  const before = prompts.length;
  let refused = false;
  try { await send("task-a", "after-unusable"); }
  catch { refused = true; }
  expect({ state: providers.status("task-a").state, refused, newModelRequests: prompts.length - before })
    .toEqual({ state: "credential-missing", refused: true, newModelRequests: 0 });
});

it("a defining profile edit from one task prevents another task using the old context", async () => {
  const { store, providers, prompts, send } = fixture();
  const profile = store.save(INPUT);
  await providers.select("task-a", profile.id, 7);
  await providers.select("task-b", profile.id, 7);
  expect(await send("task-b", "before-edit")).toMatchObject({ state: "done" });

  await providers.perform({ op: "save", taskId: "task-a", profile: {
    ...INPUT, id: profile.id, baseUrl: "https://changed.example.test/v1",
  } }, 7);
  expect(store.selection("task-b")).toBeNull();
  const requestCount = prompts.length;
  let refused = false;
  try { await send("task-b", "after-edit"); }
  catch { refused = true; }
  expect({ refused, newModelRequests: prompts.length - requestCount })
    .toEqual({ refused: true, newModelRequests: 0 });
});

it("removing a shared profile prevents another task using its old context", async () => {
  const { store, providers, prompts, send } = fixture();
  const profile = store.save(INPUT);
  await providers.select("task-a", profile.id, 7);
  await providers.select("task-b", profile.id, 7);
  expect(await send("task-b", "before-remove")).toMatchObject({ state: "done" });

  await providers.perform({ op: "remove", taskId: "task-a", profileId: profile.id }, 7);
  expect(store.list().profiles).toHaveLength(0);
  expect(store.selection("task-b")).toBeNull();
  const requestCount = prompts.length;
  let refused = false;
  try { await send("task-b", "after-remove"); }
  catch { refused = true; }
  expect({ refused, newModelRequests: prompts.length - requestCount })
    .toEqual({ refused: true, newModelRequests: 0 });
});

it("requires an explicit selection to restore sending after a lost credential reappears", async () => {
  const { store, env, providers, send } = fixture();
  const profile = store.save(INPUT);
  await providers.select("task-a", profile.id, 7);
  delete env[INPUT.authRef];
  expect(await providers.ensure("task-a", 7)).toBe("credential-missing");
  expect(store.selection("task-a")?.profileId).toBe(profile.id);
  env[INPUT.authRef] = SYNTHETIC_CREDENTIAL;
  expect(await providers.ensure("task-a", 7)).toBe("credential-missing");
  await expect(send("task-a", "not-an-explicit-restore")).rejects.toThrow("provider-not-configured");
  expect(await providers.select("task-a", profile.id, 7)).toMatchObject({ state: "configured" });
  expect(await send("task-a", "explicitly-restored")).toMatchObject({ state: "done" });
});

it("keeps the credential-loss fence when an explicit selection is refused during an active turn", async () => {
  const { store, env, providers, prompts, begin, send, holdNextPrompt, settle } = fixture();
  const profile = store.save(INPUT);
  await providers.select("task-a", profile.id, 7);
  holdNextPrompt();
  expect(await begin("task-a", "before-reference-loss")).toMatchObject({ state: "accepted" });
  delete env[INPUT.authRef];
  expect(await providers.ensure("task-a", 7)).toBe("credential-missing");
  env[INPUT.authRef] = "synthetic-replacement-test-only";
  const refusedSelection = await providers.select("task-a", profile.id, 7);
  const selectionRetained = store.selection("task-a")?.profileId === profile.id;
  await settle("task-a");
  const nextStartState = await providers.ensure("task-a", 7);
  const before = prompts.length;
  // Production admits a start only when the public wiring state is configured;
  // the separate IPC regression exercises that gate rather than bypassing it.
  const startAllowed = nextStartState === "configured";
  if (startAllowed) {
    await send("task-a", "after-refused-selection");
  }
  expect({ refusedSelectionState: refusedSelection.state, selectionRetained, nextStartState,
    startAllowed, newModelRequests: prompts.length - before })
    .toEqual({ refusedSelectionState: "credential-missing", selectionRetained: true,
      nextStartState: "credential-missing", startAllowed: false, newModelRequests: 0 });
  expect(await providers.select("task-a", profile.id, 7)).toMatchObject({ state: "configured" });
  expect(await send("task-a", "after-successful-idle-selection")).toMatchObject({ state: "done" });
  expect(prompts).toHaveLength(before + 1);
});

it("keeps an invalidated active context until terminal and then refuses its next prompt", async () => {
  const { store, providers, prompts, begin, send, holdNextPrompt, settle } = fixture();
  const profile = store.save(INPUT);
  await providers.select("task-a", profile.id, 7);
  await providers.select("task-b", profile.id, 7);
  holdNextPrompt();
  expect(await begin("task-b", "before-active-edit")).toMatchObject({ state: "accepted" });
  await providers.perform({ op: "save", taskId: "task-a", profile: {
    ...INPUT, id: profile.id, baseUrl: "https://changed.example.test/v1",
  } }, 7);
  expect(await providers.ensure("task-b", 7)).toBe("pending");
  expect(providers.status("task-b").state).toBe("pending");
  const requestsBefore = prompts.length;
  await expect(send("task-b", "while-active")).rejects.toThrow("task-locked");
  await settle("task-b");
  expect(await providers.ensure("task-b", 7)).toBe("not-configured");
  await expect(send("task-b", "after-terminal")).rejects.toThrow("provider-not-configured");
  expect(prompts).toHaveLength(requestsBefore);
});

it.each(["edit", "remove", "credential-removal"] as const)("refuses a first start invalidated by %s during eager Provider open", async (change) => {
  const { store, env, providers, prompts, dispatch, holdNextOpen, settle } = fixture();
  const profile = store.save(INPUT);
  store.select("task-a", profile.id);
  const release = holdNextOpen();
  const installing = providers.ensure("task-a", 7);
  await Promise.resolve();
  if (change === "credential-removal") delete env[INPUT.authRef];
  else if (change === "remove") await providers.perform({ op: "remove", taskId: "task-b", profileId: profile.id }, 7);
  else await providers.perform({ op: "save", taskId: "task-b", profile: {
    ...INPUT, id: profile.id, baseUrl: "https://changed.example.test/v1",
  } }, 7);
  release();
  const state = await installing;
  if (state === "configured") {
    await dispatch("task-a", "invalidated-first-start");
    await settle("task-a");
  }
  expect({ startAllowed: state === "configured", newModelRequests: prompts.length,
    selectionPresent: store.selection("task-a") !== null })
    .toEqual({ startAllowed: false, newModelRequests: 0, selectionPresent: change === "credential-removal" });
});

it.each(["edit", "remove"] as const)("does not recreate a selection after %s during explicit Provider install", async (change) => {
  const { store, providers, holdNextOpen } = fixture();
  const profile = store.save(INPUT);
  const release = holdNextOpen();
  const selecting = providers.select("task-a", profile.id, 7);
  await Promise.resolve();
  if (change === "remove") await providers.perform({ op: "remove", taskId: "task-b", profileId: profile.id }, 7);
  else await providers.perform({ op: "save", taskId: "task-b", profile: {
    ...INPUT, id: profile.id, baseUrl: "https://changed.example.test/v1",
  } }, 7);
  release();
  const status = await selecting;
  expect({ configured: status.state === "configured", selection: store.selection("task-a") })
    .toEqual({ configured: false, selection: null });
});

it("retains the selection when clearing is refused by an active turn and clears after terminal", async () => {
  const { store, providers, begin, holdNextPrompt, settle } = fixture();
  const profile = store.save(INPUT);
  await providers.select("task-a", profile.id, 7);
  holdNextPrompt();
  const turn = await begin("task-a", "active-clear");
  expect(turn.state).toBe("accepted");

  await expect(providers.clear("task-a", 7)).rejects.toThrow("sdk-turn-journal-uncommitted");
  const selectionRetained = store.selection("task-a")?.profileId === profile.id;
  const stateAfterRefusal = providers.status("task-a").state;
  await settle("task-a");
  const cleared = await providers.clear("task-a", 7);
  expect({ selectionRetained, stateAfterRefusal, stateAfterRetry: cleared.state, selectionAfterRetry: store.selection("task-a") })
    .toEqual({ selectionRetained: true, stateAfterRefusal: "configured", stateAfterRetry: "not-configured", selectionAfterRetry: null });
});
