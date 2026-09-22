import {
  configDraftKey,
  diffConfigRows,
  nextTemplateVersion,
  validateConfigRows,
  type ConfigRowDraft,
} from "../data/configRows";
import type { ConfigEntry } from "../data/types";

const row = (id: string, key: string, value: string): ConfigRowDraft => ({ id, key, value });

describe("validateConfigRows", () => {
  it("accepts a valid table, including empty values", () => {
    expect(validateConfigRows([row("1", "API_BASE_URL", ""), row("2", "_private_key", "x")])).toBeNull();
  });

  it("rejects a blank KEY", () => {
    expect(validateConfigRows([row("1", "  ", "x")])).toContain("不能为空");
  });

  it("rejects a KEY that is not letters/digits/underscore or starts with a digit", () => {
    expect(validateConfigRows([row("1", "1API", "x")])).toContain("字母、数字和下划线");
    expect(validateConfigRows([row("1", "API-BASE", "x")])).toContain("字母、数字和下划线");
  });

  it("rejects a duplicate KEY even when the value differs or whitespace is trimmed", () => {
    expect(validateConfigRows([row("1", "A", "1"), row("2", "A", "2")])).toContain("重复");
    expect(validateConfigRows([row("1", "A", "1"), row("2", " A ", "2")])).toContain("重复");
  });
});

describe("diffConfigRows", () => {
  const before: ConfigEntry[] = [
    { key: "A", value: "1", secret: false },
    { key: "B", value: "2", secret: false },
    { key: "C", value: "3", secret: false },
  ];

  it("classifies added, changed and removed keys", () => {
    const after = [row("1", "A", "1"), row("2", "B", "9"), row("3", "D", "4")];
    expect(diffConfigRows(before, after)).toEqual({
      added: ["D"],
      changed: [{ key: "B", before: "2", after: "9" }],
      removed: ["C"],
    });
  });

  it("reports a KEY rename as a removal plus an addition, not a change", () => {
    const after = [row("1", "A", "1"), row("2", "B", "2"), row("3", "C_RENAMED", "3")];
    expect(diffConfigRows(before, after)).toEqual({ added: ["C_RENAMED"], changed: [], removed: ["C"] });
  });
});

describe("nextTemplateVersion", () => {
  it("increments a v-prefixed version number", () => {
    expect(nextTemplateVersion("v12")).toBe("v13");
  });

  it("falls back to v1 when the version is unparseable", () => {
    expect(nextTemplateVersion("draft")).toBe("v1");
  });
});

describe("configDraftKey", () => {
  it("keeps task-scope drafts separate per project/environment/scope/task", () => {
    expect(configDraftKey("atlas", "testing", "shared")).toBe("atlas:testing:shared:");
    expect(configDraftKey("atlas", "testing", "task", "release")).not.toBe(configDraftKey("atlas", "testing", "task", "checkout"));
    expect(configDraftKey("atlas", "dev", "task", "release")).not.toBe(configDraftKey("atlas", "testing", "task", "release"));
  });
});
