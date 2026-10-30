import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SdkTurnTransport } from "./sdk-turn-transport.js";
import type { SdkTurnKernelPort } from "./sdk-kernel-router.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pidock-turn-context-")); homes.push(home);
  const taskDir = join(home, "task-a"); mkdirSync(taskDir);
  const prompt = vi.fn<SdkTurnKernelPort["prompt"]>(async () => ({ state: "done", text: "fixture", events: [] }));
  const kernel: SdkTurnKernelPort = {
    open: async () => ({ sdkId: "fixture", file: "fixture.jsonl", tools: [] }),
    prompt,
    cancel: async () => {},
    dispose: async () => {},
    projection: () => { throw new Error("unused"); },
  };
  return { prompt, transport: new SdkTurnTransport("task-a", taskDir, kernel) };
}

const context = {
  references: [{ kind: "file" as const, label: "repo-a/invoice.md", source: "任务代码引用", detail: "worktree" }],
  attachments: [{ kind: "attachment" as const, label: "报价.pdf", detail: "本地附件 · 内容未上传" }],
};

it("hands the composed prompt to the SDK instead of the bare typed text", async () => {
  const f = fixture();
  await f.transport.start("main", "request-a", "请核对", () => {}, undefined, context);
  expect(f.prompt).toHaveBeenCalledTimes(1);
  const sent = f.prompt.mock.calls[0]![1];
  expect(sent).toContain("请核对\n\n—— PiDock 引用与附件（Host 附加，共 2 项）——");
  expect(sent).toContain("- [file] repo-a/invoice.md — 任务代码引用 · worktree");
  expect(sent).toContain("- [attachment] 报价.pdf — 本地附件 · 内容未上传");
});

it("fingerprints the composed prompt: a replay needs the same references", async () => {
  const f = fixture();
  await f.transport.start("main", "request-a", "请核对", () => {}, undefined, context);
  // Same request id and the same context is the same prompt: no second model call.
  await f.transport.start("main", "request-a", "请核对", () => {}, undefined, context);
  expect(f.prompt).toHaveBeenCalledTimes(1);
  // Same request id with different references is a different prompt, not a replay.
  await expect(f.transport.start("main", "request-a", "请核对", () => {}, undefined, {}))
    .rejects.toThrow("idempotency-mismatch");
  expect(f.prompt).toHaveBeenCalledTimes(1);
});

it("refuses an invalid context before any journal record or model call", async () => {
  const f = fixture();
  await expect(f.transport.start("main", "request-b", "请核对", () => {}, undefined, { references: [{ kind: "file" as const, label: " " }] }))
    .rejects.toThrow("sdk-prompt-context-invalid");
  expect(f.prompt).not.toHaveBeenCalled();
  expect(f.transport.status("main", "request-b")).toBeNull();
});
