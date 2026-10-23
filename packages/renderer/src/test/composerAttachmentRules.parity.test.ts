import { describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENT_BYTES as SHELL_MAX_ATTACHMENT_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES as SHELL_MAX_TEXT_ATTACHMENT_BYTES,
  classifyComposerAttachment as shellClassifyComposerAttachment,
} from "../../../shell/src/main/composer-references.js";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
  classifyComposerAttachment,
} from "../data/composerRules";

/**
 * Renderer/shell pre-send attachment-check parity ([PiDock 13] #16 box 2).
 *
 * The composer cannot import the shell module (no Node capability), so
 * `data/composerRules.ts` mirrors `classifyComposerAttachment` and the two size
 * limits. The mirror is only safe while it decides exactly like the shell rule,
 * so this test reads the shell source itself and compares every decision and
 * limit; importing that pure module here hands the page no capability, and the
 * renderer boundary scanner (`no-node-in-renderer.test.ts`) skips `*.test.*` on
 * purpose (same shape as `serviceTemplateRules.parity.test.ts`).
 */
const CASES: { name: string; size: number; type?: string }[] = [
  { name: "shot.png", size: 2000, type: "image/png" },
  { name: "photo.JPEG", size: 2000, type: "image/jpeg" },
  { name: "notes.md", size: 3000, type: "text/markdown" },
  { name: "notes.ts", size: 3000, type: "" },
  { name: "notes.ts", size: 3000 },
  { name: "config.yaml", size: 30, type: "application/yaml" },
  { name: "blob", size: 10, type: "" },
  { name: "archive.zip", size: 1000, type: "application/zip" },
  { name: "vector.svg", size: 1000, type: "image/svg+xml" },
  { name: "exact.log", size: MAX_TEXT_ATTACHMENT_BYTES, type: "text/plain" },
  { name: "over.log", size: MAX_TEXT_ATTACHMENT_BYTES + 1, type: "text/plain" },
  { name: "exact.png", size: MAX_ATTACHMENT_BYTES, type: "image/png" },
  { name: "over.png", size: MAX_ATTACHMENT_BYTES + 1, type: "image/png" },
  { name: "huge.bin", size: MAX_ATTACHMENT_BYTES + 1, type: "application/octet-stream" },
];

describe("composer attachment rules parity with the shell", () => {
  it("keeps both size limits equal to the shell rule", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(SHELL_MAX_ATTACHMENT_BYTES);
    expect(MAX_TEXT_ATTACHMENT_BYTES).toBe(SHELL_MAX_TEXT_ATTACHMENT_BYTES);
  });

  it.each(CASES)("decides $name ($size bytes, type $type) exactly like the shell", (input) => {
    expect(classifyComposerAttachment(input)).toEqual(shellClassifyComposerAttachment(input));
  });
});
