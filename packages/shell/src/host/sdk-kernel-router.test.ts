import { expect, it, vi } from "vitest";
import { SdkTextKernelRouter } from "./sdk-kernel-router.js";
import type { SdkContextClient } from "./sdk-context-client.js";
import { PiSdkTextKernel } from "./sdk-text-kernel.js";

const snapshot = { source: "sdk-jsonl" as const, sessionId: "main", messages: [], interrupted: false };

function reader() {
  const kernel = Object.create(PiSdkTextKernel.prototype) as PiSdkTextKernel;
  kernel.projection = vi.fn(() => snapshot) as unknown as PiSdkTextKernel["projection"];
  kernel.open = vi.fn(async () => { throw new Error("provider-not-configured"); });
  kernel.prompt = vi.fn(async () => ({ state: "failed" as const, text: "", events: [], error: "provider-not-configured" }));
  kernel.cancel = vi.fn(async () => {});
  kernel.dispose = vi.fn(async () => {});
  return kernel;
}

function context() {
  return {
    open: vi.fn(async () => ({ sdkId: "sdk-1", file: "/tmp/sdk-1.jsonl", tools: [] })),
    prompt: vi.fn(async () => ({ state: "done" as const, text: "hi", events: [] })),
    cancel: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } as unknown as SdkContextClient;
}

it("keeps projections on the read-only kernel and refuses model calls without a context", async () => {
  const local = reader();
  const router = new SdkTextKernelRouter(local);
  expect(router.configured).toBe(false);
  expect(router.projection("main")).toEqual(snapshot);
  await expect(router.open("main")).rejects.toThrow("provider-not-configured");
  expect(await router.prompt("main", "hello")).toMatchObject({ state: "failed", error: "provider-not-configured" });
  // Projection stays available even though model calls fail closed.
  expect(router.projection("main")).toEqual(snapshot);
  await router.dispose();
  expect(local.dispose).toHaveBeenCalledTimes(1);
});

it("delegates model operations to the isolated context and disposes it before the reader", async () => {
  const local = reader();
  const remote = context();
  const router = new SdkTextKernelRouter(local, remote);
  expect(router.configured).toBe(true);
  await router.open("main");
  expect(await router.prompt("main", "hello")).toMatchObject({ state: "done", text: "hi" });
  await router.cancel("main");
  expect(remote.open).toHaveBeenCalledWith("main");
  expect(remote.prompt).toHaveBeenCalledWith("main", "hello", undefined, undefined);
  expect(remote.cancel).toHaveBeenCalledWith("main");
  expect(local.open).not.toHaveBeenCalled();
  expect(router.projection("main")).toEqual(snapshot);

  const order: string[] = [];
  vi.mocked(remote.dispose).mockImplementation(async () => { order.push("context"); });
  vi.mocked(local.dispose).mockImplementation(async () => { order.push("reader"); });
  await router.dispose();
  expect(order).toEqual(["context", "reader"]);
  // A second dispose must not resurrect the cleared context.
  await router.dispose();
  expect(remote.dispose).toHaveBeenCalledTimes(1);
  expect(router.configured).toBe(false);
});
