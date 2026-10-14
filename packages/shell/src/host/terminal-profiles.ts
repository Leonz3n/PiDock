/**
 * The OS seam behind the (#85) shell-profile table.
 *
 * `main/terminal-config.ts` owns the table and its rules and takes the platform,
 * the environment and the file probe as arguments, so every branch is decidable
 * by an injected probe in a test and `main` stays free of the filesystem. This
 * file is the only place those arguments come from the running Host: its own
 * `process.platform`, its own `process.env` and real `statSync`/`accessSync`
 * probes. Nothing here decides which shell is right - it only reports which of
 * the table's known executables this machine really has.
 */

import { accessSync, constants, statSync } from "node:fs";
import {
  resolveShellProfiles,
  resolveTerminalProfile,
  type TerminalProfileProbe,
  type TerminalProfileResolution,
} from "../main/terminal-config.js";

/** Whether the path names a regular file; a directory or an absent path is not a program. */
function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The real probe. `X_OK` is the POSIX execute bit; on win32 Node treats it as
 * `F_OK` (there is no execute bit to read), so the same call is the honest
 * answer on both platforms instead of a win32-only branch that would claim less
 * than it could.
 */
export function nodeTerminalProfileProbe(): TerminalProfileProbe {
  return {
    exists: (path) => isRegularFile(path),
    isExecutable: (path) => {
      if (!isRegularFile(path)) return false;
      try {
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * The shell profiles this Host can offer, resolved against its own OS. The
 * optional inputs exist so a test can drive the seam without inventing a
 * platform; the Host itself passes none of them.
 */
export function resolveHostShellProfiles(
  input: { platform?: NodeJS.Platform; env?: Record<string, string | undefined>; probe?: TerminalProfileProbe } = {},
): TerminalProfileResolution {
  return resolveShellProfiles({
    platform: input.platform ?? process.platform,
    env: input.env ?? process.env,
    probe: input.probe ?? nodeTerminalProfileProbe(),
  });
}

/**
 * The exact wire shape of `task/terminalProfiles`, spelled out field by field:
 * the renderer parses these keys and nothing else, so the op's payload is a
 * deliberate projection of the resolution rather than the resolution object
 * itself.
 */
export function terminalProfilesPayload(resolution: TerminalProfileResolution): Record<string, unknown> {
  return {
    platform: resolution.platform,
    profiles: resolution.profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      source: profile.source,
      program: profile.program,
      args: [...profile.args],
    })),
    defaultProfileId: resolution.defaultProfileId,
    unavailable: resolution.unavailable.map((entry) => ({ id: entry.id, label: entry.label, missing: [...entry.missing] })),
  };
}

export type TerminalProfileLaunch = { ok: true; program: string; args: string[] } | { ok: false; error: string };

/**
 * The launch one profile id names, re-verified on disk at PLAN time.
 *
 * Detection time is when the table proved the path exists and is executable, and
 * that proof is the whole reason a profile program is trusted without the #7
 * caller-string proxy. A `pwsh.exe` uninstalled between those two moments would
 * otherwise be spawned on the strength of a stale proof, so the same probe runs
 * again here and a shell that is gone is refused BY NAME - never spawned, never
 * swapped for another shell (`statSync(selected).isFile()` precedent:
 * `main/runtime.ts` `pickProgram`).
 */
export function resolveTerminalProfileLaunch(
  profileId: unknown,
  input: { resolution?: TerminalProfileResolution; probe?: TerminalProfileProbe } = {},
): TerminalProfileLaunch {
  const resolution = input.resolution ?? resolveHostShellProfiles();
  const probe = input.probe ?? nodeTerminalProfileProbe();
  const selected = resolveTerminalProfile(resolution, profileId);
  if (!selected.ok) return selected;
  if (!probe.isExecutable(selected.profile.program)) {
    return {
      ok: false,
      error: `terminal-profile-unavailable: 终端 shell 配置「${selected.profile.label}」的程序已不在本机或不可执行：${selected.profile.program}`,
    };
  }
  return { ok: true, program: selected.profile.program, args: [...selected.profile.args] };
}

export type TerminalLaunchFromRecord =
  | { ok: true; program: unknown; args: unknown; programSource: "caller" | "profile" }
  | { ok: false; error: string };

/**
 * Resolve the launch a plan/start RECORD asks for, which is the only place the
 * "this program is a profile, not a caller string" claim is ever made.
 *
 * Two fields are read and nothing else: `profileId` (which can only name a table
 * entry, and is re-probed on disk) and `program`/`args` (the #7 explicit argv
 * channel, validated by `planTerminal` exactly as before). A record naming both
 * is refused rather than silently preferring one, and a record naming neither
 * stays a caller program with no value - refused by the same check. Because
 * `programSource` is derived HERE and not read from the record, no op payload can
 * claim the exemption: a payload that carries a `programSource` field of its own
 * is still resolved as a caller program.
 */
export function terminalLaunchFromRecord(
  record: Record<string, unknown>,
  input: { resolution?: TerminalProfileResolution; probe?: TerminalProfileProbe } = {},
): TerminalLaunchFromRecord {
  const profileId = record["profileId"];
  const program = record["program"];
  if (profileId === undefined) return { ok: true, program, args: record["args"], programSource: "caller" };
  if (program !== undefined) return { ok: false, error: "invalid-payload: 终端不能同时指定 profileId 与 program" };
  const launch = resolveTerminalProfileLaunch(profileId, input);
  return launch.ok
    ? { ok: true, program: launch.program, args: launch.args, programSource: "profile" }
    : { ok: false, error: launch.error };
}
