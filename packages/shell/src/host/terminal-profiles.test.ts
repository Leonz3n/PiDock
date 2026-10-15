/**
 * Tests for the (#85) host-side shell-profile seam: the real probe the table is
 * decided through, and the table this machine really resolves to.
 *
 * The win32 case is real-host evidence (it stats this machine's own PowerShell);
 * on a POSIX host the same case is skipped by name rather than passed, because
 * the win32 table is not observable there.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  nodeTerminalProfileProbe,
  resolveHostShellProfiles,
  resolveTerminalProfileLaunch,
  terminalLaunchFromRecord,
} from "./terminal-profiles.js";

const win32Only = it.skipIf(process.platform !== "win32");
const posixOnly = it.skipIf(process.platform === "win32");

describe("host shell profiles (#85)", () => {
  it("reads a real file as an existing executable and a missing path as neither", () => {
    const probe = nodeTerminalProfileProbe();
    expect(probe.exists(process.execPath)).toBe(true);
    expect(probe.isExecutable(process.execPath)).toBe(true);
    const missing = join(tmpdir(), "pidock-profile-85-not-here", "nope.exe");
    expect(probe.exists(missing)).toBe(false);
    expect(probe.isExecutable(missing)).toBe(false);
    // A directory is not a program, whatever the execute bits say.
    expect(probe.exists(tmpdir())).toBe(false);
    expect(probe.isExecutable(tmpdir())).toBe(false);
  });

  win32Only("resolves this machine's win32 table and selects PowerShell with no profile-swallowing argv", () => {
    const resolution = resolveHostShellProfiles();
    expect(resolution.platform).toBe("win32");
    expect(resolution.defaultProfileId).toBe("powershell");
    const powershell = resolution.profiles[0]!;
    expect(powershell.id).toBe("powershell");
    expect(isAbsolute(powershell.program)).toBe(true);
    expect(statSync(powershell.program).isFile()).toBe(true);
    expect(powershell.program.toLowerCase()).toMatch(/pwsh\.exe$|powershell\.exe$/);
    // Clause 6: the user's own profile runs - no `-NoProfile`, no `/c` chaining.
    expect(powershell.args).toEqual([]);
    // Every offered profile is a resolvable program, and every one that is
    // missing is named with the paths that were probed.
    for (const profile of resolution.profiles) expect(statSync(profile.program).isFile()).toBe(true);
    for (const entry of resolution.unavailable) expect(entry.missing.length).toBeGreaterThan(0);
  });

  posixOnly("resolves a login shell profile for this machine's own $SHELL", () => {
    const resolution = resolveHostShellProfiles();
    expect(resolution.platform).toBe(process.platform);
    for (const profile of resolution.profiles) {
      expect(statSync(profile.program).isFile()).toBe(true);
      expect(profile.args).toEqual(["-l"]);
    }
    const shell = process.env["SHELL"];
    if (shell !== undefined && isAbsolute(shell) && existsSync(shell)) {
      expect(resolution.defaultProfileId).toBe(shell.split("/").pop());
      expect(resolution.profiles[0]).toMatchObject({ program: shell });
    }
  });
});

/**
 * The launch seam a plan/start record is resolved through: the profile's own
 * proof is taken again at plan time, and the "this is a table path, not a caller
 * string" provenance is derived from the record instead of being readable from it.
 */
describe("terminal profile launch resolution (#85)", () => {
  const RESOLUTION = {
    platform: "win32" as const,
    profiles: [
      { id: "powershell", label: "PowerShell", source: "PowerShell", program: "C:/Program Files/PowerShell/7/pwsh.exe", args: [] },
    ],
    defaultProfileId: "powershell",
    unavailable: [{ id: "git-bash", label: "Git Bash", missing: ["C:/Program Files/Git/bin/bash.exe"] }],
  };
  const probe = (paths: readonly string[]) => ({
    exists: (path: string) => paths.includes(path),
    isExecutable: (path: string) => paths.includes(path),
  });

  it("re-probes the profile program at plan time and refuses one that is gone, by name", () => {
    // Detection time is what lets a profile program skip the caller-string proxy,
    // so the proof is taken again here: a shell uninstalled in between is refused
    // with its own path - never spawned, never swapped for another shell.
    const gone = resolveTerminalProfileLaunch("powershell", { resolution: RESOLUTION, probe: probe([]) });
    expect(gone.ok).toBe(false);
    if (gone.ok) return;
    expect(gone.error).toContain("terminal-profile-unavailable");
    expect(gone.error).toContain("C:/Program Files/PowerShell/7/pwsh.exe");

    const present = resolveTerminalProfileLaunch("powershell", {
      resolution: RESOLUTION,
      probe: probe(["C:/Program Files/PowerShell/7/pwsh.exe"]),
    });
    expect(present).toEqual({ ok: true, program: "C:/Program Files/PowerShell/7/pwsh.exe", args: [] });
  });

  it("refuses a profile id outside the table by name", () => {
    const unknown = resolveTerminalProfileLaunch("cmder", { resolution: RESOLUTION, probe: probe([]) });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error).toContain("terminal-profile-unknown");
    expect(unknown.error).toContain("cmder");
  });

  it("derives the launch provenance from the record, so no payload can carry it in", () => {
    // A record IS the op payload. Only `profileId` and `program`/`args` are read;
    // a payload's own `programSource` field is ignored, so a caller program keeps
    // the #7 rule (it is planned as `caller`):
    const smuggled = terminalLaunchFromRecord(
      { program: "C:/Program Files/PowerShell/7/pwsh.exe", programSource: "profile" },
      { resolution: RESOLUTION, probe: probe(["C:/Program Files/PowerShell/7/pwsh.exe"]) },
    );
    expect(smuggled).toEqual({ ok: true, program: "C:/Program Files/PowerShell/7/pwsh.exe", args: undefined, programSource: "caller" });
    // A real profile id is resolved and re-probed...
    expect(
      terminalLaunchFromRecord({ profileId: "powershell" }, { resolution: RESOLUTION, probe: probe(["C:/Program Files/PowerShell/7/pwsh.exe"]) }),
    ).toEqual({ ok: true, program: "C:/Program Files/PowerShell/7/pwsh.exe", args: [], programSource: "profile" });
    // ...and both answers at once are refused instead of one being preferred.
    const both = terminalLaunchFromRecord({ profileId: "powershell", program: "/bin/sh" }, { resolution: RESOLUTION });
    expect(both.ok).toBe(false);
    if (both.ok) return;
    expect(both.error).toContain("不能同时指定 profileId 与 program");
  });
});
