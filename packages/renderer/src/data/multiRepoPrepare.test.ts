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
  });
});
