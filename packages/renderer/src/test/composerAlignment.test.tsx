import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "./helpers";
import { useHostStore } from "../stores/host";

/**
 * [UI 对齐 06] (#30) composer alignment with prototype A. jsdom has no layout,
 * so the heights live in `docs/evidence/ui-alignment-s4/capture-composer.mjs`;
 * what is asserted here is the behaviour and the class contracts that keep the
 * bottom row a single line and the attachment strip bounded at every tier.
 */

/**
 * Dispatch the prototype's paste route: a `paste` event whose `clipboardData`
 * carries image items. jsdom has no `DataTransfer`, so the payload is built by
 * hand — it exercises the same `items`/`files`/`getData` surface the real
 * clipboard offers (the synthetic-event caveat is recorded in the evidence log).
 */
function pasteImage(input: HTMLElement, files: File[], text = "") {
  const clipboardData = {
    items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
    files,
    getData: () => text,
  };
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: clipboardData });
  return input.dispatchEvent(event);
}

describe("composer alignment", () => {
  it("uses the prototype's names for the input, the attachment entry and the meta row", async () => {
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    const input = screen.getByLabelText("给 Agent 的消息");
    expect(input).toHaveAttribute("placeholder", "描述你想做什么，或粘贴图片／截图…");
    // Prototype `.composer textarea{min-height:66px}`.
    expect(input.className).toContain("min-h-[66px]");

    const attach = screen.getByRole("button", { name: "添加文件" });
    expect(attach).toHaveAttribute("title", "添加文件");
    // Prototype `.composer .iconbtn{width:22px}`, 28px tall.
    expect(attach.className).toContain("w-[22px]");
    expect(attach.className).toContain("h-7");

    // Prototype `.send{height:27px;width:27px;background:var(--accent)}` with the
    // arrow glyph and 发送消息 as its accessible name.
    const send = screen.getByRole("button", { name: "发送消息" });
    expect(send).toHaveAttribute("type", "submit");
    expect(send.className).toContain("h-[27px]");
    expect(send.className).toContain("w-[27px]");
    expect(send.querySelector("[data-icon='arrow']")).not.toBeNull();
    expect(screen.getByRole("button", { name: /^选择模型：/ })).toHaveAttribute("aria-haspopup", "dialog");
    expect(screen.getByRole("button", { name: /^选择权限：/ })).toHaveAttribute("aria-haspopup", "dialog");

    // Prototype `.compose-bottom{flex-wrap:wrap}` stays one line because the
    // context button moved out to `compose-meta`; the context control is no
    // longer part of the box's button row.
    const form = input.closest("form")!;
    expect(within(form).queryByRole("button", { name: "查看上下文占用" })).not.toBeInTheDocument();
    const meta = screen.getByTestId("compose-meta");
    expect(within(meta).getByRole("button", { name: "查看上下文占用" })).toBeInTheDocument();
  });

  it("reads the meta row from the session record and never invents an estimate", async () => {
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    const session = (await useHostStore.getState().adapter.getSession("release", "main"))!;
    const meta = screen.getByTestId("compose-meta");
    const occupancy = within(meta).getByRole("button", { name: "查看上下文占用" });
    // 24.8k of a 200k window, 12.4%, no marker: the seeded session is `actual`.
    expect(session.contextUsed).toBe(24.8);
    expect(occupancy).toHaveTextContent("24.8k / 200k · 12.4%");
    expect(occupancy).not.toHaveTextContent("估算");
    expect(within(meta).getByRole("button", { name: "查看本会话 Token 用量" })).toHaveTextContent(`本会话 ${session.tokens.toFixed(1)}k tokens`);
    // Prototype `.meter{width:43px;height:4px}` with the fill at the percentage.
    const meter = within(meta).getByTestId("compose-meta-meter");
    expect(meter.className).toContain("w-[43px]");
    expect((meter.querySelector("i") as HTMLElement).style.width).toBe("12.4%");
  });

  it("turns a pasted image into an attachment and keeps the clipboard text", async () => {
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:mock" });
    try {
      const input = screen.getByLabelText("给 Agent 的消息") as HTMLTextAreaElement;
      await userEvent.setup().click(input);
      const shot = new File(["png"], "shot.png", { type: "image/png" });
      // The handler cancels the browser's own paste so the image is not dropped.
      const prevented = await act(async () => pasteImage(input, [shot], "看这张截图"));
      expect(prevented).toBe(false);

      const attachments = await screen.findByTestId("composer-attachments");
      // The clipboard carries no file name, so the id names the attachment.
      const chip = within(attachments).getByRole("button", { name: /^预览 粘贴图片-/ });
      expect(chip).toHaveTextContent(/^粘贴图片-\w+\.png$/);
      // The provenance line the composer no longer repeats as a note.
      expect(chip).toHaveAttribute("title", "剪贴板图片 · 1 KB · 仅本页保留");
      // The clipboard's plain text is inserted at the caret.
      expect(input.value).toBe("看这张截图");
      expect(await screen.findByText("已粘贴 1 张图片，可附上文字后发送")).toBeInTheDocument();

      // Expanding the chip shows the source line; removing it clears the strip.
      await userEvent.setup().click(chip);
      expect(await screen.findByTestId("composer-attachment-preview")).toHaveTextContent("仅本页保留");
      await userEvent.setup().click(within(attachments).getByRole("button", { name: /^移除附件 / }));
      await waitFor(() => expect(screen.queryByTestId("composer-attachments")).not.toBeInTheDocument());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leaves a paste without an image to the browser", async () => {
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    const input = screen.getByLabelText("给 Agent 的消息") as HTMLTextAreaElement;
    await userEvent.setup().click(input);
    const note = new File(["hello"], "notes.txt", { type: "text/plain" });
    // Not cancelled: the normal text paste (and its undo) still works.
    const prevented = await act(async () => pasteImage(input, [note], "普通文字"));
    expect(prevented).toBe(true);
    expect(screen.queryByTestId("composer-attachments")).not.toBeInTheDocument();
    expect(screen.queryByText(/已粘贴/)).not.toBeInTheDocument();
  });

  it("keeps the attachment strip bounded and the composer from shrinking", async () => {
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    await userEvent.setup().upload(screen.getByLabelText("附件选择") as HTMLInputElement, [
      new File(["a"], "a.txt", { type: "text/plain" }),
    ]);
    const composer = screen.getByTestId("task-composer");
    // Prototype `.composer-wrap{max-height:65%;overflow:auto;flex-shrink:0}`.
    expect(composer.className).toContain("max-h-[65%]");
    expect(composer.className).toContain("shrink-0");
    // Prototype `.image-attachments{max-height:182px;overflow:auto}`.
    const strip = await screen.findByTestId("composer-attachments");
    expect(strip.className).toContain("max-h-[182px]");
    expect(strip.className).toContain("overflow-auto");
  });

  it("warns about an unsupported image and refuses to send it", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:mock" });
    try {
      // 本地 Qwen is the seeded text-only model.
      await user.click(screen.getByRole("button", { name: /^选择模型：Claude Sonnet$/ }));
      const picker = await screen.findByRole("dialog", { name: /模型/ });
      await user.click(within(picker).getByRole("button", { name: /本地 Qwen/ }));
      await waitFor(() => expect(screen.getByRole("button", { name: "选择模型：本地 Qwen" })).toBeInTheDocument());

      const input = screen.getByLabelText("给 Agent 的消息") as HTMLTextAreaElement;
      await user.click(input);
      await act(async () => pasteImage(input, [new File(["png"], "shot.png", { type: "image/png" })], "看图"));
      // Prototype `.attachment-warning`: the refusal is visible, the entry to
      // choose another model is inline, and the draft keeps the attachment.
      const warning = await screen.findByText("当前模型未启用图片输入，请切换模型后发送。");
      expect(warning.closest("p")).toHaveAttribute("role", "status");
      expect(within(warning.closest("p") as HTMLElement).getByRole("button", { name: "选择模型" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
      expect(screen.getByTestId("composer-attachments")).toBeInTheDocument();
      expect(input.value).toBe("看图");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hands focus back to the trigger when a composer dialog closes with Escape", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    const trigger = screen.getByRole("button", { name: "查看上下文占用" });
    await user.click(trigger);
    expect(await screen.findByRole("dialog", { name: "上下文占用" })).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "上下文占用" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("disables the input and the attachment entry in a read-only session with a visible reason", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    await user.click(screen.getByRole("button", { name: /^选择权限：/ }));
    await user.click(await screen.findByTestId("permission-read"));

    const hint = await screen.findByTestId("composer-readonly-hint");
    expect(hint).toHaveAttribute("role", "status");
    expect(hint).toHaveTextContent("当前是只读会话，请先调整会话权限");
    expect(hint).toHaveTextContent("不能发送消息或添加附件");
    expect(screen.getByLabelText("给 Agent 的消息")).toBeDisabled();
    expect(screen.getByLabelText("附件选择")).toBeDisabled();
    const attach = screen.getByRole("button", { name: "添加文件" });
    expect(attach).toBeDisabled();
    // A disabled control still has to look disabled.
    expect(attach.className).toContain("disabled:opacity-50");
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
  });
});
