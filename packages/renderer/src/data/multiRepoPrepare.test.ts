import { describe, expect, it } from "vitest";
import { readRepoPrepareView } from "./multiRepoPrepare";

// Seam: #6 recovery payload -> rows. Pure, so the panel cannot show a status
// the Host did not classify.

const payload = {
  outcomes: [
    { repoDir: "frontend", status: "created" },
    { repoDir: "invoice", status: "pending" },
    {
      repoDir: "shipment",
      status: "failed",
      error: { code: "fetch-failed", repoDir: "shipment", message: "仓库 shipment 获取远程基线失败" },
    },
  ],
  retry: ["invoice", "shipment"],
  hold: [],
};

describe("readRepoPrepareView", () => {
  it("shapes the Host classification with each real reason", () => {
    expect(readRepoPrepareView(payload)).toEqual({
      rows: [
        { repoDir: "frontend", status: "created", reason: undefined },
        { repoDir: "invoice", status: "pending", reason: undefined },
        {
          repoDir: "shipment",
          status: "failed",
          reason: "仓库 shipment 获取远程基线失败",
        },
      ],
      created: ["frontend"],
      retry: ["invoice", "shipment"],
      hold: [],
      canResume: true,
      resumed: false,
    });
  });

  it("rejects a payload that is not the typed Host shape instead of faking a status", () => {
    expect(readRepoPrepareView(undefined)).toBeNull();
    expect(readRepoPrepareView({})).toBeNull();
    expect(readRepoPrepareView({ outcomes: [], retry: [], hold: [] })).toMatchObject({ canResume: false });
    // Unknown status.
    expect(readRepoPrepareView({ ...payload, outcomes: [{ repoDir: "x", status: "ready" }] })).toBeNull();
    // Missing repoDir.
    expect(readRepoPrepareView({ ...payload, outcomes: [{ status: "created" }] })).toBeNull();
    // Missing retry/hold lists.
    expect(readRepoPrepareView({ outcomes: payload.outcomes })).toBeNull();
    // A retry/hold repo the outcomes do not name.
    expect(readRepoPrepareView({ ...payload, retry: ["ghost"] })).toBeNull();
    // A `failed` row without the Host's real reason is rejected rather than
    // rendered as a bare "失败" with no actionable detail.
    expect(readRepoPrepareView({ ...payload, outcomes: [{ repoDir: "x", status: "failed" }] })).toBeNull();
    expect(
      readRepoPrepareView({
        ...payload,
        outcomes: [{ repoDir: "x", status: "failed", error: { code: "fetch-failed", message: "" } }],
        retry: [],
      }),
    ).toBeNull();
  });

  it("reads `resumed` only from a resume response, never from a status read", () => {
    expect(readRepoPrepareView(payload)?.resumed).toBe(false);
    // The real Host resume payload carries the retried set and `resumed: true`
    // (it never returns `canResume`); the view derives canResume from retry.
    const resumeResponse = {
      outcomes: payload.outcomes,
      retry: ["invoice", "shipment"],
      hold: [],
      created: ["frontend"],
      pending: ["invoice", "shipment"],
      failed: [],
      resumed: true,
    };
    expect(readRepoPrepareView(resumeResponse)).toMatchObject({ canResume: true, resumed: true });
  });
});
