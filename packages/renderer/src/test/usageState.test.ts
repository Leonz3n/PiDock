import { describe, expect, it } from "vitest";
import {
  USAGE_DEFINITIONS,
  USAGE_GROUP_OPTIONS,
  describeUsageCleanupScope,
  filterUsageRecords,
  groupUsageRecords,
  sumUsageRecords,
  unparsableUsageTimes,
  usageDayKey,
  usageWindow,
} from "../data/usageState";
import type { UsageRecord } from "../data/types";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: "usage-1",
    taskId: "release",
    projectId: "atlas",
    sessionId: "main",
    providerId: "provider-anthropic",
    providerVersion: "anthropic-messages::https://a.example.com::claude-sonnet",
    model: "claude-sonnet",
    kind: "turn",
    endState: "completed",
    completeness: "reported",
    input: 100,
    output: 40,
    cacheRead: 10,
    cacheWrite: 5,
    reasoning: 12,
    at: "2026-09-22T10:00:00+08:00",
    ...overrides,
  };
}

describe("[PiDock 12] renderer usage mirror", () => {
  it("keeps reasoning inside output and never treats an unreported row as zero", () => {
    const totals = sumUsageRecords([
      record(),
      record({ id: "usage-2", completeness: "missing", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: undefined }),
    ]);
    expect(totals).toMatchObject({ calls: 2, reported: 1, missing: 1, input: 100, output: 40, cacheRead: 10, cacheWrite: 5, reasoning: 12 });
    expect(totals.input + totals.output + totals.cacheRead + totals.cacheWrite).toBe(155);
  });

  it("resolves date-only bounds on the declared timezone and keeps both ends inclusive", () => {
    const window = usageWindow({ from: "2026-09-22", to: "2026-09-22" });
    expect(new Date(window.fromMs ?? 0).toISOString()).toBe("2026-09-21T16:00:00.000Z");
    expect(new Date(window.toMs ?? 0).toISOString()).toBe("2026-09-22T15:59:59.999Z");
    expect(window.label).toContain("UTC+08:00");
    const rows = [record({ id: "a", at: "2026-09-21T23:59:59+08:00" }), record({ id: "b", at: "2026-09-22T00:00:00+08:00" }), record({ id: "c", at: "2026-09-23T00:00:00+08:00" })];
    expect(filterUsageRecords(rows, { from: "2026-09-22", to: "2026-09-22" }).map((row) => row.id)).toEqual(["b"]);
    expect(usageDayKey("2026-09-21T16:30:00Z")).toBe("2026-09-22");
  });

  it("filters by provider, model (request or response), session, kind and range", () => {
    const rows = [
      record(),
      record({ id: "usage-2", kind: "compaction", providerId: "provider-openai", model: "gpt-5", responseModel: "gpt-5-2026-08", sessionId: "review" }),
    ];
    expect(filterUsageRecords(rows, { providerId: "provider-openai" }).map((row) => row.id)).toEqual(["usage-2"]);
    expect(filterUsageRecords(rows, { model: "gpt-5-2026-08" })).toHaveLength(1);
    expect(filterUsageRecords(rows, { kind: "compaction" })).toHaveLength(1);
    expect(filterUsageRecords(rows, { sessionId: "main" })).toHaveLength(1);
    expect(filterUsageRecords(rows, { projectId: "atlas" })).toHaveLength(2);
    expect(unparsableUsageTimes([record({ id: "bad", at: "not-a-time" })])).toEqual(["bad"]);
  });

  it("groups by each offered dimension with the kind label translated", () => {
    const rows = [record(), record({ id: "usage-2", kind: "compaction", taskId: "latency", sessionId: "main" })];
    expect(groupUsageRecords(rows, "task").map((group) => group.key).sort()).toEqual(["latency", "release"]);
    expect(groupUsageRecords(rows, "session").map((group) => group.key).sort()).toEqual(["latency · main", "release · main"]);
    expect(groupUsageRecords(rows, "kind").map((group) => group.label).sort((a, b) => a.localeCompare(b, "zh"))).toEqual(["回合", "压缩"]);
    expect(groupUsageRecords(rows, "day")[0].key).toBe("2026-09-22");
    expect(USAGE_GROUP_OPTIONS.map((option) => option.id)).toContain("provider");
  });

  it("states every cleanup scope in words and lists the statistics definitions", () => {
    expect(describeUsageCleanupScope({ kind: "all" })).toContain("全部用量");
    expect(describeUsageCleanupScope({ kind: "session", sessionId: "review" })).toContain("review");
    expect(describeUsageCleanupScope({ kind: "before", before: "2026-09-01" })).toContain("2026-09-01 当日结束");
    expect(USAGE_DEFINITIONS.map((item) => item.term)).toContain("未知用量");
    expect(USAGE_DEFINITIONS.some((item) => item.definition.includes("不等同账户账单"))).toBe(true);
    expect(USAGE_DEFINITIONS.some((item) => item.definition.includes("只计一次"))).toBe(true);
  });
});
