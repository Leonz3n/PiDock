import { execFileSync } from "node:child_process";

/**
 * One row of the win32 process table: the process id and the parent id the OS
 * recorded when that process was created.
 *
 * `Win32_Process.ParentProcessId` is set at creation and never rewritten on
 * win32 (there is no reparenting), so the parent chain is this platform's only
 * process-tree structure - and it stays readable after an ancestor exits, which
 * is what makes a descendant attributable to a root that has already ended.
 */
export interface Win32ProcessRow {
  pid: number;
  ppid: number;
}

/**
 * Bound on one whole-table read. PowerShell start-up dominates the cost (a full
 * `Get-CimInstance` read measured at ~350 ms on Windows 11 x64); the bound is
 * generous for a loaded host while still refusing a probe that never returns.
 */
const SNAPSHOT_TIMEOUT_MS = 10_000;
const SNAPSHOT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Read-only snapshot of the win32 process table (`pid`, `ppid`) via PowerShell
 * CIM. This is deliberately NOT `readProcessTable`: that reader's win32 refusal
 * is a by-design boundary the service-ownership family depends on, so the
 * terminal's win32 evidence comes from this independent source instead of
 * widening that one.
 *
 * Returns `null` when the probe itself is unavailable (not win32, PowerShell
 * missing/disabled, a timeout, or an oversized read): "the probe failed" is NOT
 * "the table was empty", and a caller that proves a drain must fail closed in
 * the former case. An actually empty table is `[]`.
 *
 * Limits, recorded rather than hidden:
 * - the read is one blocking child process per call (~350 ms measured), so it is
 *   taken at a decision point (a stop / an end), never on a cadence;
 * - `ParentProcessId` is the whole structure: a descendant whose launcher gave
 *   it a different parent was never linked to the root here and cannot be named
 *   by this probe - the parent chain is the boundary, not an OS sandbox;
 * - a pid can be recycled between two reads, so a pid that is present in a later
 *   read is treated as alive and the drain stays unproven (`unknown`). The probe
 *   is only ever asked "is this named pid gone", never "whose is it".
 */
export function readWin32ProcessTable(): Win32ProcessRow[] | null {
  if (process.platform !== "win32") return null;
  let printed: string;
  try {
    printed = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      timeout: SNAPSHOT_TIMEOUT_MS, maxBuffer: SNAPSHOT_MAX_BUFFER,
    });
  } catch {
    return null;
  }
  const rows: Win32ProcessRow[] = [];
  for (const line of printed.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 2) continue;
    const pid = Number.parseInt(fields[0]!, 10), ppid = Number.parseInt(fields[1]!, 10);
    if (Number.isInteger(pid) && Number.isInteger(ppid) && pid >= 1 && ppid >= 0) rows.push({ pid, ppid });
  }
  return rows;
}

/**
 * Whether `pid` currently names a process. `kill(pid, 0)` is the OS existence
 * probe; a pid owned by another user answers `EPERM`, which still means the
 * process exists.
 *
 * The answer is "a process with this pid exists", not "our process exists": a
 * pid the OS recycled reads as alive. Callers use it only to prove a named pid
 * GONE, so a recycled pid makes a drain unproven (`unknown`) and can never turn
 * into a false stopped-tree claim.
 */
export function win32ProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
