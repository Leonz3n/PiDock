/**
 * Renderer view of the Host's per-repo prepare state for [PiDock 03] (#6)
 * recovery (`task/prepareStatus` / `task/resumeAppend`).
 *
 * Pure and transport-free: it only shapes the Host payload into rows the
 * recovery UI renders. The renderer never executes git, never scans a
 * worktree and never invents a status — a payload that does not carry the
 * Host's classification is rejected instead of shown as ready.
 */

export type RepoPrepareStatus = "created" | "pending" | "failed";

export interface RepoPrepareRow {
  repoDir: string;
  status: RepoPrepareStatus;
  /** The Host's real per-repo reason; present for `failed`. */
  reason?: string;
}

export interface RepoPrepareView {
  rows: RepoPrepareRow[];
  created: string[];
  /** Unfinished repos whose worktree is absent and whose recorded baseline
   *  allows a resume: the resume retry set. */
  retry: string[];
  /** Repos a resume must not plan: a path already exists at the wanted
   *  worktree dir (never ours to take over) or the record has no remote
   *  baseline for the repo. Human handling; the row carries the Host reason. */
  hold: string[];
  /** True when at least one unfinished repo can be resumed. */
  canResume: boolean;
}

const STATUSES: readonly RepoPrepareStatus[] = ["created", "pending", "failed"];

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
    return null;
  }
  return value as string[];
}

/**
 * Parse the Host's prepare payload. Returns `null` for anything that is not
 * the typed shape (missing `outcomes`/`retry`/`hold`, an unknown status, or
 * a retry/hold repo the outcomes do not name), so the UI keeps its last
 * known state instead of showing a fabricated all-created view.
 */
export function readRepoPrepareView(payload: unknown): RepoPrepareView | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const rawOutcomes = record["outcomes"];
  const retry = asStringArray(record["retry"]);
  const hold = asStringArray(record["hold"]);
  if (!Array.isArray(rawOutcomes) || retry === null || hold === null) return null;
  const rows: RepoPrepareRow[] = [];
  for (const entry of rawOutcomes) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const outcome = entry as Record<string, unknown>;
    const repoDir = outcome["repoDir"];
    const status = outcome["status"];
    if (typeof repoDir !== "string" || repoDir.length === 0) return null;
    if (typeof status !== "string" || !(STATUSES as readonly string[]).includes(status)) return null;
    const failure = outcome["error"];
    const reason =
      failure && typeof failure === "object" && !Array.isArray(failure) &&
      typeof (failure as Record<string, unknown>)["message"] === "string"
        ? ((failure as Record<string, unknown>)["message"] as string)
        : undefined;
    rows.push({ repoDir, status: status as RepoPrepareStatus, reason });
  }
  const named = new Set(rows.map((row) => row.repoDir));
  if ([...retry, ...hold].some((repoDir) => !named.has(repoDir))) return null;
  return {
    rows,
    created: rows.filter((row) => row.status === "created").map((row) => row.repoDir),
    retry,
    hold,
    canResume: retry.length > 0,
  };
}
