import { describe, expect, it } from "vitest";
import {
  USAGE_DEFINITIONS,
  applyUsageCleanup,
  dedupeInheritedUsage,
  describeUsageCleanupScope,
  filterUsageDetails,
  groupUsageDetails,
  mergeUsageDetails,
  normalizeReportedUsage,
  parseUsageInstant,
  providerConfigVersion,
  resolveUsageWindow,
  sumOwnedUsage,
  sumUsageDetails,
  toUsageDetail,
  unparsableUsageTimes,
  usageCarriesReport,
  usageDayKey,
  type PiUsageDetail,
} from "./usage-ledger.js";

function detail(overrides: Partial<PiUsageDetail> = {}): PiUsageDetail {
  const { id, ...rest } = overrides;
  return toUsageDetail({
    callId: id ?? "call-1",
    taskId: "release",
    projectId: "atlas",
    sessionId: "main",
    providerId: "provider-anthropic",
    providerVersion: "anthropic-messages::https://a.example.com::claude-sonnet",
    requestModel: "claude-sonnet",
    kind: "turn",
    endState: "completed",
    at: "2026-09-22T10:00:00+08:00",
    usage: normalizeReportedUsage({ input: 100, output: 40, cacheRead: 10, cacheWrite: 5, reasoning: 12 }, "actual"),
    ...rest,
  });
}

describe("[PiDock 12] usage normalization", () => {
  it("reads a full provider report as reported and keeps reasoning/total out of the counters", () => {
    const usage = normalizeReportedUsage({ input: 100, output: 40, cacheRead: 10, cacheWrite: 5, reasoning: 12, totalTokens: 155 }, "actual");
    expect(usage).toEqual({
      input: 100,
      output: 40,
      cacheRead: 10,
      cacheWrite: 5,
      source: "actual",
      completeness: "reported",
      reasoning: 12,
      reportedTotal: 155,
    });
  });

  it("never folds reasoning into output or a provider total into the cache counters", () => {
    const usage = normalizeReportedUsage({ input: 100, output: 40, cacheRead: 10, cacheWrite: 5, reasoning: 12, totalTokens: 1000 }, "actual");
    const totals = sumUsageDetails([detail({ usage })]);
    expect(totals.output).toBe(40);
    expect(totals.reasoning).toBe(12);
    expect(totals.cacheRead + totals.cacheWrite).toBe(15);
    expect(totals.input + totals.output + totals.cacheRead + totals.cacheWrite).toBe(155);
  });

  it("marks a report with only some counters as partial and unsent fields as missing, never as zero", () => {
    expect(normalizeReportedUsage({ input: 12 }, "actual").completeness).toBe("partial");
    expect(normalizeReportedUsage({ input: 12 }, "actual").cacheRead).toBe(0);
    expect(normalizeReportedUsage(undefined, "actual").completeness).toBe("missing");
    expect(normalizeReportedUsage({}, "actual").completeness).toBe("missing");
  });

  it("treats an unreported source as missing even when SDK zero-initialised numbers arrive", () => {
    const usage = normalizeReportedUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, "unreported");
    expect(usage.completeness).toBe("missing");
    expect(usageCarriesReport(usage)).toBe(false);
    const totals = sumUsageDetails([detail({ usage })]);
    expect(totals).toMatchObject({ calls: 1, missing: 1, input: 0, output: 0 });
  });

  it("counts unknown reports instead of silently adding them as zero consumption", () => {
    const totals = sumUsageDetails([
      detail({ id: "call-1", usage: normalizeReportedUsage({ input: 100, output: 40, cacheRead: 0, cacheWrite: 0 }, "actual") }),
      detail({ id: "call-2", usage: normalizeReportedUsage({}, "unreported") }),
    ]);
    expect(totals).toMatchObject({ calls: 2, reported: 1, partial: 0, missing: 1, input: 100, output: 40 });
  });

  it("rejects an unknown usage source fail-closed", () => {
    expect(() => normalizeReportedUsage({ input: 1 }, "live" as never)).toThrow("usageSource");
  });
});

describe("[PiDock 12] provider config version", () => {
  it("keeps the same version when only the display name changes", () => {
    const base = { protocol: "anthropic-messages", baseUrl: "https://a.example.com", models: [{ id: "claude-sonnet" }] };
    expect(providerConfigVersion(base)).toBe(providerConfigVersion({ ...base, models: [{ id: "claude-sonnet" }] }));
  });

  it("produces a new version when the address or the model list changes", () => {
    const base = { protocol: "openai-responses", baseUrl: "https://a.example.com", models: [{ id: "gpt-5" }] };
    expect(providerConfigVersion(base)).not.toBe(providerConfigVersion({ ...base, baseUrl: "https://b.example.com" }));
    expect(providerConfigVersion(base)).not.toBe(providerConfigVersion({ ...base, models: [{ id: "gpt-5" }, { id: "gpt-5-mini" }] }));
  });
});

describe("[PiDock 12] replay, retry and inheritance", () => {
  it("updates the same call for a streamed increment followed by the final report", () => {
    const partial = detail({ usage: normalizeReportedUsage({ input: 100 }, "actual") });
    const final = detail({ usage: normalizeReportedUsage({ input: 100, output: 40, cacheRead: 10, cacheWrite: 5 }, "actual") });
    const merged = mergeUsageDetails([partial], [final]);
    expect(merged).toHaveLength(1);
    expect(merged[0].usage).toMatchObject({ output: 40, completeness: "reported" });
  });

  it("is idempotent: re-reading the same call records adds no consumption", () => {
    const records = [detail(), detail({ id: "call-2" })];
    const once = mergeUsageDetails([], records);
    const twice = mergeUsageDetails(once, records);
    expect(sumUsageDetails(twice)).toEqual(sumUsageDetails(once));
    expect(sumUsageDetails(twice).calls).toBe(2);
  });

  it("keeps a call's start time when a later event re-reports it", () => {
    const started = detail({ at: "2026-09-22T10:00:00+08:00" });
    const replayed = detail({ at: "2026-09-22T10:05:00+08:00", usage: normalizeReportedUsage({ input: 100, output: 41, cacheRead: 10, cacheWrite: 5 }, "actual") });
    const merged = mergeUsageDetails([started], [replayed]);
    expect(merged[0].at).toBe("2026-09-22T10:00:00+08:00");
  });

  it("counts a retry as its own attempt with its own usage", () => {
    const first = detail({ id: "call-1", endState: "failed", usage: normalizeReportedUsage({ input: 100, output: 4 }, "actual") });
    const retry = detail({ id: "call-2", endState: "completed", usage: normalizeReportedUsage({ input: 100, output: 40 }, "actual") });
    const totals = sumUsageDetails([first, retry]);
    expect(totals.calls).toBe(2);
    expect(totals.input).toBe(200);
  });

  it("counts an inherited clone copy once and keeps the original attribution", () => {
    const original = detail();
    const clone = detail({
      taskId: "release-clone",
      sessionId: "main-copy",
      origin: { taskId: original.taskId, sessionId: original.sessionId, callId: original.id },
    });
    expect(sumUsageDetails([original, clone]).input).toBe(200);
    expect(sumOwnedUsage([original, clone]).input).toBe(100);
    expect(dedupeInheritedUsage([clone, original])[0].sessionId).toBe("main");
    const groups = groupUsageDetails([original, clone], "task");
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("release");
    expect(groups[0].totals.input).toBe(100);
  });

  it("keeps a clone visible when only the inherited copy is known", () => {
    const clone = detail({ origin: { taskId: "release", sessionId: "main", callId: "call-1" } });
    expect(sumOwnedUsage([clone]).input).toBe(100);
    expect(groupUsageDetails([clone], "session")[0].key).toBe("release · main");
  });
});

describe("[PiDock 12] time range and grouping", () => {
  const at = (value: string) => detail({ id: value, at: value });

  it("resolves date-only boundaries in the declared timezone, inclusive on both ends", () => {
    const window = resolveUsageWindow({ from: "2026-09-22", to: "2026-09-22" });
    expect(new Date(window.fromMs ?? 0).toISOString()).toBe("2026-09-21T16:00:00.000Z");
    expect(new Date(window.toMs ?? 0).toISOString()).toBe("2026-09-22T15:59:59.999Z");
    expect(window.label).toContain("UTC+08:00");
    const rows = [at("2026-09-21T23:59:59+08:00"), at("2026-09-22T00:00:00+08:00"), at("2026-09-22T23:59:59+08:00"), at("2026-09-23T00:00:00+08:00")];
    expect(filterUsageDetails(rows, { from: "2026-09-22", to: "2026-09-22" }).map((row) => row.at)).toEqual([
      "2026-09-22T00:00:00+08:00",
      "2026-09-22T23:59:59+08:00",
    ]);
  });

  it("compares instants by their own offset so a UTC instant lands in the same Shanghai day", () => {
    const rows = [at("2026-09-21T16:30:00Z")];
    expect(filterUsageDetails(rows, { from: "2026-09-22", to: "2026-09-22" })).toHaveLength(1);
    expect(usageDayKey("2026-09-21T16:30:00Z")).toBe("2026-09-22");
    expect(usageDayKey("2026-09-21T15:30:00Z")).toBe("2026-09-21");
  });

  it("filters by provider, model, session, project and kind", () => {
    const rows = [detail(), detail({ id: "call-2", kind: "compaction", providerId: "provider-openai", requestModel: "gpt-5", sessionId: "review" })];
    expect(filterUsageDetails(rows, { providerId: "provider-openai" }).map((row) => row.id)).toEqual(["call-2"]);
    expect(filterUsageDetails(rows, { model: "gpt-5" })).toHaveLength(1);
    expect(filterUsageDetails(rows, { sessionId: "main" })).toHaveLength(1);
    expect(filterUsageDetails(rows, { projectId: "atlas" })).toHaveLength(2);
    expect(filterUsageDetails(rows, { kind: "compaction" })).toHaveLength(1);
    expect(filterUsageDetails(rows, { model: "claude-sonnet" })).toHaveLength(1);
  });

  it("keeps an unparsable time only without bounds and reports the ids", () => {
    const rows = [detail({ id: "call-bad", at: "not-a-time" }), detail({ id: "call-ok" })];
    expect(filterUsageDetails(rows, {}).map((row) => row.id)).toContain("call-bad");
    expect(filterUsageDetails(rows, { from: "2026-09-01" }).map((row) => row.id)).toEqual(["call-ok"]);
    expect(unparsableUsageTimes(rows)).toEqual(["call-bad"]);
    expect(parseUsageInstant("not-a-time")).toBeNull();
  });

  it("counts compaction, branch summaries and model tools under their own kind", () => {
    const rows = [
      detail({ id: "c1" }),
      detail({ id: "c2", kind: "compaction" }),
      detail({ id: "c3", kind: "branch-summary" }),
      detail({ id: "c4", kind: "model-tool" }),
    ];
    const groups = groupUsageDetails(rows, "kind");
    expect(groups.map((group) => group.key).sort()).toEqual(["branch-summary", "compaction", "model-tool", "turn"]);
    expect(groups.find((group) => group.key === "compaction")?.label).toBe("压缩");
    expect(groupUsageDetails(rows, "day")[0].key).toBe("2026-09-22");
  });

  it("groups by project, task, session, provider and model", () => {
    const rows = [detail(), detail({ id: "call-2", projectId: "orbit", taskId: "latency", sessionId: "main", providerId: "provider-local", requestModel: "qwen" })];
    expect(groupUsageDetails(rows, "project").map((group) => group.key).sort()).toEqual(["atlas", "orbit"]);
    expect(groupUsageDetails(rows, "task").map((group) => group.key).sort()).toEqual(["latency", "release"]);
    expect(groupUsageDetails(rows, "session").map((group) => group.key).sort()).toEqual(["latency · main", "release · main"]);
    expect(groupUsageDetails(rows, "provider")).toHaveLength(2);
    expect(groupUsageDetails(rows, "model")).toHaveLength(2);
  });
});

describe("[PiDock 12] cleanup scope", () => {
  it("keeps usage on archive (no scope) and only removes what the scope names", () => {
    const rows = [detail({ id: "call-1", sessionId: "main" }), detail({ id: "call-2", sessionId: "review", at: "2026-08-01T10:00:00+08:00" })];
    expect(applyUsageCleanup(rows, { kind: "session", sessionId: "review" }).map((row) => row.id)).toEqual(["call-1"]);
    expect(applyUsageCleanup(rows, { kind: "before", before: "2026-09-01" }).map((row) => row.id)).toEqual(["call-1"]);
    expect(applyUsageCleanup(rows, { kind: "all" })).toEqual([]);
  });

  it("describes each cleanup scope so deleting sessions and deleting usage stay distinct", () => {
    expect(describeUsageCleanupScope({ kind: "all" })).toContain("全部用量");
    expect(describeUsageCleanupScope({ kind: "session", sessionId: "review" })).toContain("review");
    expect(describeUsageCleanupScope({ kind: "before", before: "2026-09-01" })).toContain("2026-09-01 当日结束");
  });

  it("exposes the statistics definitions the page shows", () => {
    expect(USAGE_DEFINITIONS.length).toBeGreaterThanOrEqual(8);
    expect(USAGE_DEFINITIONS.map((item) => item.term)).toContain("未知用量");
    expect(USAGE_DEFINITIONS.some((item) => item.definition.includes("不等同账户账单"))).toBe(true);
  });
});
