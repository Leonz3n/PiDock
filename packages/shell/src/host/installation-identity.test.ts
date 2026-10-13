/**
 * [PiDock 04] (#7 box 7) the installation identity the launch-verification
 * record is bound to. Unit-level: the binding's own contract (stable, per
 * profile, fail-closed on a missing or unusable profile). The end-to-end
 * consequence — another installation's same-platform record reads as NOT
 * verified — is pinned in `service-launch-verification.test.ts` and the renderer
 * seam test.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostInstallationId, installationIdPath, loadInstallationId } from "./installation-identity.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), "pidock-installation-"));
  dirs.push(dir);
  return dir;
}

describe("#7 the installation's stable identity", () => {
  it("mints one identity under the profile and keeps it stable", () => {
    const dir = profile();
    const first = loadInstallationId(dir);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(loadInstallationId(dir)).toBe(first);
    expect(readFileSync(installationIdPath(dir), "utf8").trim()).toBe(first);
  });

  it("has no identity without a usable profile, and never trusts a bad file", () => {
    expect(loadInstallationId(undefined)).toBeUndefined();
    expect(loadInstallationId("")).toBeUndefined();
    expect(loadInstallationId("relative/profile")).toBeUndefined();
    const dir = profile();
    writeFileSync(installationIdPath(dir), "not-a-uuid");
    expect(loadInstallationId(dir)).toBeUndefined();
  });

  it("reads the Host's identity from the fork-time profile binding", () => {
    const dir = profile();
    expect(hostInstallationId({ PIDOCK_PROTECTED_PROFILE: dir })).toBe(loadInstallationId(dir));
    expect(hostInstallationId({})).toBeUndefined();
  });
});
