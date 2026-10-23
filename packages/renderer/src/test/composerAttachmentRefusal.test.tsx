import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MAX_TEXT_ATTACHMENT_BYTES } from "../data/composerRules";
import type { Reference } from "../data/types";
import { useDraftStore } from "../stores/drafts";
import { renderApp } from "./helpers";

/**
 * [PiDock 13] (#16 box 2) the attachment entry refuses instead of swallowing.
 *
 * `addFiles` used to take every selected file: no type check, no size check, no
 * message. These cases drive the real file input so the refusal has to reach the
 * user by name and the refused file has to stay out of the draft.
 */
function selectFiles(files: File[]) {
  const input = screen.getByTestId("composer-file-input") as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

function attachmentReferences(): Reference[] {
  return useDraftStore.getState().getDraft("release", "main").references.filter((reference) => reference.kind === "attachment");
}

describe("composer attachment refusals", () => {
  it("refuses an over-limit file by name and keeps it out of the draft", async () => {
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    selectFiles([new File([new Uint8Array(MAX_TEXT_ATTACHMENT_BYTES + 1)], "huge.log", { type: "text/plain" })]);

    const report = await screen.findByText(/huge\.log/);
    expect(report).toHaveTextContent("未加入附件，拒绝 1 个");
    // The limit comes from the rule (1MB for text), not from a second constant.
    expect(report).toHaveTextContent("超过上限 1MB");
    expect(attachmentReferences()).toEqual([]);
    expect(screen.queryByTestId("composer-attachments")).not.toBeInTheDocument();
  });

  it("keeps the accepted files of a mixed selection and names every refused one", async () => {
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    selectFiles([
      new File(["png"], "shot.png", { type: "image/png" }),
      new File(["bin"], "archive.zip", { type: "application/zip" }),
      new File(["note"], "notes.md", { type: "text/markdown" }),
    ]);

    const attachments = await screen.findByTestId("composer-attachments");
    const labels = within(attachments)
      .getAllByTestId("composer-attachment-open")
      .map((chip) => chip.textContent?.trim() ?? "");
    // N accepted ... the refused one never becomes a chip.
    expect(labels).toEqual(["shot.png", "notes.md"]);
    expect(attachmentReferences()).toHaveLength(2);

    const report = await screen.findByText(/已加入 2 个，拒绝 1 个/);
    expect(report).toHaveTextContent("archive.zip");
    expect(report).toHaveTextContent("不支持的类型 application/zip");
  });

  it("states what an attachment actually provides instead of implying an upload", async () => {
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });

    selectFiles([new File(["note"], "notes.md", { type: "text/markdown" })]);

    const chip = await screen.findByRole("button", { name: "预览 notes.md" });
    const detail = chip.getAttribute("title") ?? "";
    // Code facts: the preview URL is in-memory only (`data/types.ts`), and the
    // Host runs the turn on the typed text alone — a reference is persisted,
    // never interpreted. The copy has to say that, not "sent"/"uploaded".
    expect(detail).toContain("仅本页保留");
    expect(detail).toContain("内容不上传、不读取");
    expect(detail).toContain("附件不会发给 Agent");
    expect(detail).not.toMatch(/已上传|已发送给|已进入 Agent 上下文/);
    expect(attachmentReferences()[0]?.detail).toBe(detail);
  });
});
