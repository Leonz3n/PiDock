import { describe, expect, it } from "vitest";
import { composePromptContext } from "./sdk-prompt-context.js";

/**
 * [#117 第 1 项 / #16 盒 3] The Host owns the trailing context section: the SDK
 * only ever receives one string, so what the Agent can see about a reference is
 * exactly what this function wrote.
 */
describe("composePromptContext", () => {
  it("returns the typed text unchanged when the turn carries no references", () => {
    expect(composePromptContext("看一下这个账单", {})).toEqual({ ok: true, prompt: "看一下这个账单" });
    expect(composePromptContext("看一下这个账单")).toEqual({ ok: true, prompt: "看一下这个账单" });
  });

  it("appends one fixed section naming kind, identity and source of every entry", () => {
    const composed = composePromptContext("请核对", {
      references: [
        { kind: "file", label: "repo-a/invoice.md", source: "任务代码引用", detail: "worktree · 版本未记录" },
        { kind: "directory", label: "invoice-docs", source: "普通目录" },
      ],
      attachments: [{ kind: "attachment", label: "报价.pdf", detail: "本地附件 · 内容未上传" }],
    });
    expect(composed.ok).toBe(true);
    const prompt = composed.ok ? composed.prompt : "";
    // The user's text stays first and unmodified; the section is an addition.
    expect(prompt.startsWith("请核对\n\n—— PiDock 引用与附件（Host 附加，共 3 项）——")).toBe(true);
    expect(prompt).toContain("引用\n- [file] repo-a/invoice.md — 任务代码引用 · worktree · 版本未记录\n- [directory] invoice-docs — 普通目录");
    expect(prompt).toContain("附件\n- [attachment] 报价.pdf — 本地附件 · 内容未上传");
    // The Agent is told these are identities, not contents: nothing here embeds
    // a file body, and the section says so.
    expect(prompt).toContain("以上是清单与来源身份，不是文件内容；需要时请用工具自行读取。");
  });

  it("refuses entries that are extra keys, unknown kinds or over the bound instead of trimming them", () => {
    expect(composePromptContext("x", { references: [{ kind: "file", label: "a", content: "file body" } as never] }))
      .toEqual({ ok: false, error: "sdk-prompt-context-invalid: 条目字段不合法" });
    expect(composePromptContext("x", { references: [{ kind: "web" as never, label: "a" }] }))
      .toEqual({ ok: false, error: "sdk-prompt-context-invalid: 条目字段不合法" });
    expect(composePromptContext("x", { attachments: [{ kind: "attachment", label: "a".repeat(201) }] }))
      .toEqual({ ok: false, error: "sdk-prompt-context-invalid: 条目字段不合法" });
    expect(composePromptContext("x", { references: Array.from({ length: 21 }, () => ({ kind: "file" as const, label: "a" })) }))
      .toEqual({ ok: false, error: "sdk-prompt-context-invalid: 条目过多或不是数组" });
  });

  it("refuses when the appended section itself would exceed its own bound", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ kind: "file" as const, label: `f-${index}`, source: "s".repeat(200), detail: "d".repeat(400) }));
    expect(composePromptContext("x", { references: many })).toEqual({ ok: false, error: "sdk-prompt-context-invalid: 附加段落超长" });
  });
});
