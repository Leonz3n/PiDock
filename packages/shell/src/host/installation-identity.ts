/**
 * This installation's stable identity for the platform launch verification
 * ([PiDock 04] #7 box 7).
 *
 * A launch-verification entry names the platform and node version of the Host
 * that really watched a child start, but the document travels WITH the task
 * folder (a backup, a synced task root, a copy to another machine). A row must
 * therefore be evidence about ONE installation, not about every installation
 * that happens to run the same `<platform>-<arch>`: a `darwin-arm64` record
 * copied to another `darwin-arm64` machine is not a verification of that
 * machine, and without an installation binding the row could only be told apart
 * by the platform label, which cannot tell it.
 *
 * This module mints one random UUID per installation and keeps it under the
 * application profile main forks the Host with (`PIDOCK_PROTECTED_PROFILE` =
 * `app.getPath("userData")`). It is deliberately NOT a hardware, OS or user
 * identifier: nothing about the machine is read or recorded, only an opaque
 * token that differs between installations. Copying a single task workspace
 * does not copy it, so that copy's old launch stays unverified here.
 *
 * Fail closed: a missing or unwritable profile yields no identity, and a record
 * with no installation binding never reads as verified.
 */

import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const INSTALLATION_ID_FILE = "installation-id";
/** A minted id is a UUID; anything else in the file is not trusted as an identity. */
const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function installationIdPath(profileDir: string): string {
  return join(profileDir, INSTALLATION_ID_FILE);
}

/** The Host's own installation identity, from the fork-time profile binding. */
export function hostInstallationId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return loadInstallationId(env["PIDOCK_PROTECTED_PROFILE"]);
}

/**
 * Read this installation's identity, minting it once when it does not exist
 * yet. `undefined` means "no identity available" (no profile, or the profile is
 * not writable), which callers must treat as "cannot verify", never as a pass.
 * The mint uses an exclusive create so two Hosts forked at once agree on one id.
 */
export function loadInstallationId(profileDir: string | undefined): string | undefined {
  if (profileDir === undefined || profileDir.length === 0 || !isAbsolute(profileDir)) return undefined;
  const file = installationIdPath(profileDir);
  const existing = readInstallationId(file);
  if (existing !== undefined) return existing;
  return mintInstallationId(file);
}

function readInstallationId(file: string): string | undefined {
  try {
    const value = readFileSync(file, "utf8").trim();
    return INSTALLATION_ID.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function mintInstallationId(file: string): string | undefined {
  const id = randomUUID();
  try {
    const fd = openSync(file, "wx", 0o600);
    try {
      writeSync(fd, `${id}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return id;
  } catch (error) {
    // Another Host won the race to mint it: read what it wrote.
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return readInstallationId(file);
    return undefined;
  }
}
