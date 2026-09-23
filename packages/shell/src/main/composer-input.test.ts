import { describe, expect, it } from "vitest";
import {
  activeCompletionToken,
  isEnvStyleDollar,
  parseSkillInvocations,
  resolveComposerKey,
  scanCodeRegions,
  splitComposerSegments,
  suggestCommand,
} from "./composer-input.js";

describe("composer input rules", () => {
  it("serves @/$ for a trailing token and / only at the message start", () => {
    expect(activeCompletionToken("@sr", 3)).toEqual({ symbol: "@", query: "sr", start: 0, end: 3 });
    expect(activeCompletionToken("看看 $code", 8)).toEqual({ symbol: "$", query: "code", start: 3, end: 8 });
    expect(activeCompletionToken("/mo", 3)).toEqual({ symbol: "/", query: "mo", start: 0, end: 3 });
    // `/` mid-message is ordinary text, not a command entry.
    expect(activeCompletionToken("先说明 /mo", 8)).toBeNull();
    // `@` mid-token is not a trailing marker (email/URL/path forms).
    expect(activeCompletionToken("联系 a@b.com", 11)).toBeNull();
  });

  it("keeps escaped markers, env-style dollars and code contents literal", () => {
    expect(activeCompletionToken("\\@sr", 4)).toBeNull();
    expect(activeCompletionToken("$HOME", 5)).toBeNull();
    expect(activeCompletionToken("${PATH}", 8)).toBeNull();
    expect(isEnvStyleDollar("$HOME", 0)).toBe(true);
    expect(isEnvStyleDollar("$code-review", 0)).toBe(false);
    expect(activeCompletionToken("`@sr`", 4)).toBeNull();
    expect(activeCompletionToken("```\n@sr", 7)).toBeNull();
    expect(scanCodeRegions("a `b` c")).toEqual([{ start: 2, end: 5, kind: "inline-code" }]);
    // An unterminated fence protects the rest instead of leaking markers.
    expect(scanCodeRegions("```\n@sr")).toEqual([{ start: 0, end: 7, kind: "fence" }]);
  });

  it("parses $name and /skill:name with same-line args and never duplicates a skill", () => {
    const known = ["code-review", "unit-tests"];
    expect(parseSkillInvocations("$code-review 使用中文", known)).toEqual([
      { name: "code-review", args: "使用中文", style: "dollar", resolved: true, raw: "$code-review", start: 0, end: 12 },
    ]);
    const combined = parseSkillInvocations("先 $code-review 再 $unit-tests 收尾", known);
    expect(combined.map((item) => [item.name, item.args])).toEqual([
      ["code-review", "再"],
      ["unit-tests", "收尾"],
    ]);
    expect(parseSkillInvocations("/skill:code-review --strict", known)).toEqual([
      { name: "code-review", args: "--strict", style: "slash", resolved: true, raw: "/skill:code-review", start: 0, end: 18 },
    ]);
    // Unknown names stay literal text; an explicit /skill: entry is reported unresolved.
    expect(parseSkillInvocations("$unknown-skill", known)).toEqual([]);
    expect(parseSkillInvocations("/skill:missing", known)[0]).toMatchObject({ name: "missing", resolved: false });
    // Inside code and escaped markers are not invocations.
    expect(parseSkillInvocations("`$code-review`", known)).toEqual([]);
    expect(parseSkillInvocations("\\$code-review", known)).toEqual([]);
  });

  it("separates literal text from skill segments, keeping each skill once", () => {
    const known = ["code-review"];
    const segments = splitComposerSegments("请用 $code-review 检查 src/api.ts，邮箱 a@b.com", known);
    expect(segments.map((segment) => segment.kind)).toEqual(["text", "skill", "text"]);
    expect(segments[0]).toEqual({ kind: "text", value: "请用 " });
    expect(segments[2]).toEqual({ kind: "text", value: " 检查 src/api.ts，邮箱 a@b.com" });
    const counts = new Map<string, number>();
    for (const segment of segments) {
      if (segment.kind === "skill") counts.set(segment.invocation.name, (counts.get(segment.invocation.name) ?? 0) + 1);
    }
    expect(counts.get("code-review")).toBe(1);
  });

  it("resolves keyboard intent so keyboard confirm never also sends", () => {
    expect(resolveComposerKey({ key: "Enter", candidateCount: 3 })).toBe("confirm-candidate");
    expect(resolveComposerKey({ key: "Tab", candidateCount: 3 })).toBe("confirm-candidate");
    expect(resolveComposerKey({ key: "ArrowDown", candidateCount: 3 })).toBe("move-candidate-down");
    expect(resolveComposerKey({ key: "ArrowUp", candidateCount: 3 })).toBe("move-candidate-up");
    expect(resolveComposerKey({ key: "Escape", candidateCount: 3 })).toBe("close-candidate");
    expect(resolveComposerKey({ key: "Enter" })).toBe("send");
    expect(resolveComposerKey({ key: "Enter", shift: true })).toBe("newline");
    // IME composition confirm must not submit the message or run a command.
    expect(resolveComposerKey({ key: "Enter", composing: true })).toBe("ignore-composition");
    expect(resolveComposerKey({ key: "Escape", composing: true, candidateCount: 2 })).toBe("ignore-composition");
  });

  it("corrects an unknown command only when a known entry is close enough", () => {
    const known = ["/new", "/model", "/compact", "/skills", "/session", "/usage", "/help"];
    expect(suggestCommand("/modle", known)).toBe("/model");
    expect(suggestCommand("/compct", known)).toBe("/compact");
    expect(suggestCommand("/zzzzzzzz", known)).toBeNull();
  });
});
