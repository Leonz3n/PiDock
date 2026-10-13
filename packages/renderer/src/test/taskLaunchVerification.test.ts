/**
 * [PiDock 04] (#7 box 7) the renderer's read of the Host's per-platform launch
 * verification.
 *
 * The payload literals below are the exact key sets `publicServiceStatus`
 * emits (`packages/shell/src/host/service-public.ts`), pinned from the shell
 * side by `service-launch-verification.test.ts` ("lists the exact row shape the
 * renderer parses, so the two ends cannot drift apart"). Only the platform
 * label is machine-dependent, and these tests use this machine's real
 * platform/arch, so a payload claiming a pass for any other platform is the
 * contradictory input the parser must refuse.
 */
import { describe, expect, it } from "vitest";
import { serviceStatusFromHost } from "../data/taskServices";

const SERVICE_ID = "s-11111111-1111-1111-1111-111111111111";
const HERE = `${process.platform}-${process.arch}`;

const status = (launchVerification: unknown) => ({
  service: { serviceId: SERVICE_ID, lifecycle: "stopped", templateVersion: "2", resolved: [], launchVerification },
});

/** A platform label the Host may not produce (an arch suffix carrying a dot). */
const ODD_ARCH_LABEL = `${process.platform}-arm64.v7`;

/** One real verification of this machine, as the Host projects it. */
const verifiedRow = {
  platform: HERE, verified: true, nodeVersion: process.versions.node, program: "pnpm",
  startedAt: "2026-10-08T00:00:00.000Z", stopped: true, stoppedAt: "2026-10-08T00:01:00.000Z",
};

describe("[PiDock 04] #7 the platform launch verification the panel reads", () => {
  it("keeps this machine's real verification and names Windows as unverified", () => {
    const payload = status({
      platform: HERE,
      rows: [verifiedRow, { platform: "win32-x64", verified: false, reason: "本机未运行该平台，未实测" }],
    });
    const view = serviceStatusFromHost(payload, SERVICE_ID);
    expect(view).toMatchObject({ kind: "registry", launchVerification: { platform: HERE } });
    const rows = view?.kind === "registry" ? view.launchVerification?.rows ?? [] : [];
    expect(rows.filter((row) => row.verified)).toEqual([
      { platform: HERE, verified: true, nodeVersion: process.versions.node, program: "pnpm",
        startedAt: "2026-10-08T00:00:00.000Z", stopped: true, stoppedAt: "2026-10-08T00:01:00.000Z" },
    ]);
    // Windows is present and NOT a pass: the platform this build cannot run in
    // this environment is named, with the Host's own reason.
    expect(rows.find((row) => row.platform === "win32-x64")).toEqual({ platform: "win32-x64", verified: false, reason: "本机未运行该平台，未实测" });
  });

  it("never turns an unverified platform into a pass: no record, another platform's record, or an observation-free one", () => {
    // (a) A Host that sends no record at all: nothing is shown as verified, and
    // the row is absent so the panel says the Host provided none.
    const none = serviceStatusFromHost(status({ platform: HERE, rows: [{ platform: HERE, verified: false, reason: "本任务尚无该平台的实测启动记录" }] }), SERVICE_ID);
    expect(none?.kind === "registry" ? none.launchVerification?.rows.every((row) => !row.verified) : false).toBe(true);
    const absent = serviceStatusFromHost({ service: { serviceId: SERVICE_ID, lifecycle: "stopped", templateVersion: "2", resolved: [] } }, SERVICE_ID);
    expect(absent?.kind === "registry" ? absent.launchVerification : "missing").toBeUndefined();

    // (b) The mutation this slice exists to prevent: a payload that claims a
    // pass on a platform this Host is not running on is contradictory, so the
    // whole read is refused instead of rendering a green row.
    expect(serviceStatusFromHost(status({ platform: HERE, rows: [{ ...verifiedRow, platform: "win32-x64" }] }), SERVICE_ID)).toBeNull();
    // A pass with no observed launch fact attached is refused too (a record
    // that named no observation is not evidence).
    for (const row of [{ platform: HERE, verified: true }, { platform: HERE, verified: true, program: "pnpm", nodeVersion: "24.21.0" },
      { platform: HERE, verified: true, stopped: false, program: "pnpm", nodeVersion: "24.21.0" }]) {
      expect(serviceStatusFromHost(status({ platform: HERE, rows: [row] }), SERVICE_ID)).toBeNull();
    }
    // (c) A not-verified row that names no reason, and a duplicate platform row
    // (the only way a `false` could be replaced by a `true`), are refused.
    expect(serviceStatusFromHost(status({ platform: HERE, rows: [{ platform: "win32-x64", verified: false }] }), SERVICE_ID)).toBeNull();
    expect(serviceStatusFromHost(status({ platform: HERE, rows: [{ platform: "win32-x64", verified: false, reason: "x" }, { platform: "win32-x64", verified: false, reason: "y" }] }), SERVICE_ID)).toBeNull();
    // An observation made on another platform stays readable, and stays NOT
    // verified for this machine.
    const other = serviceStatusFromHost(status({ platform: HERE, rows: [{ ...verifiedRow, platform: "win32-x64", verified: false, reason: "记录来自其他平台（win32-x64），本机未实测" }] }), SERVICE_ID);
    expect(other?.kind === "registry" ? other.launchVerification?.rows.filter((row) => row.verified) : "unreadable").toEqual([]);
  });

  it("rejects a malformed verification value instead of reading part of it", () => {
    for (const value of [
      { platform: HERE }, { rows: [] }, { platform: ODD_ARCH_LABEL, rows: [{ platform: HERE, verified: false, reason: "x" }] },
      { platform: "darwin", rows: [{ platform: HERE, verified: false, reason: "x" }] },
      { platform: HERE, rows: [] }, { platform: HERE, rows: [{ platform: HERE, verified: "yes", reason: "x" }] },
      { platform: HERE, rows: [{ platform: "win32-x64", verified: false, reason: "x", extra: 1 }] },
      { platform: HERE, rows: [{ platform: HERE, verified: false, reason: "" }] }, "verified",
    ]) {
      expect(serviceStatusFromHost(status(value), SERVICE_ID)).toBeNull();
    }
  });
});
