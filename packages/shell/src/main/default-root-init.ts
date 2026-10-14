/**
 * First-run establishment of the machine-local default task root (#81).
 *
 * ADR 0001 keeps a task root that is missing, moved or identity-mismatched in the
 * named 待修复 state, and the creation flow refuses by name while any root is in
 * that state (`project-task-creation.ts` prepare, `runtime.ts` provisioning). That
 * rule is right for a root this profile already used — but a first run has nothing
 * to repair: `<home>/PiDockTasks` was simply never established, and no in-app
 * affordance can establish it (「找回任务根」 refuses the default-root path and
 * requires existing task records; the settings chooser has no host interface). With
 * the root absent, `prepare` refuses before it can create anything, so without this
 * step a clean machine could never create a task at all.
 *
 * So startup creates the missing default root itself, with the same ownership marker
 * the creation flow writes, and only when the profile holds no evidence of ever
 * having used it. The evidence is the persisted association history in the project
 * registry (live memberships plus claim/unlink/transfer receipts, each recording its
 * task's root) — the only place a profile's past roots outlive the roots themselves.
 * Everything that could make the answer wrong keeps the repair state: unreadable
 * history, a path that exists but is not a directory (a file, or a link the app must
 * not follow), and a directory the app cannot create. A root the app did not create
 * is never touched, and a refusal is returned rather than thrown so startup cannot
 * fail on a user-controlled path.
 */
import { lstatSync } from "node:fs";
import { CREATED_ROOT_MARKER, createOwnedDirectory } from "./project-task-creation.js";

/**
 * Marker content of a root startup created. Deliberately not a creation-intent ID:
 * a later `commit` whose intent was prepared while the root was absent must still
 * refuse to take the root over (`任务根在准备后被建立，不能接管；需要显式恢复`).
 */
const STARTUP_ROOT_OWNER = "shell-startup";

export type DefaultRootRefusal = "used-before" | "history-unreadable" | "path-not-directory" | "path-unreadable" | "create-failed";
export type DefaultRootInit =
  /** The root did not exist and this profile never used it: created, with the ownership marker. */
  | { state: "created"; root: string }
  /** The root is already a directory: left exactly as it is, untouched and unmarked. */
  | { state: "existing"; root: string }
  /** Nothing was created: the missing root keeps its 待修复 state. */
  | { state: "unavailable"; root: string; reason: DefaultRootRefusal };

/** `lstat`, so a link reports as `other`: the app never follows a root it did not create. */
function pathState(path: string): "absent" | "directory" | "other" | "unreadable" {
  try {
    return lstatSync(path).isDirectory() ? "directory" : "other";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
  }
}

export function initializeDefaultTaskRoot(defaultRoot: string, usedBefore: () => boolean): DefaultRootInit {
  const at = pathState(defaultRoot);
  if (at === "directory") return { state: "existing", root: defaultRoot };
  if (at !== "absent") return { state: "unavailable", root: defaultRoot, reason: at === "other" ? "path-not-directory" : "path-unreadable" };
  let used: boolean;
  try {
    used = usedBefore();
  } catch {
    return { state: "unavailable", root: defaultRoot, reason: "history-unreadable" };
  }
  if (used) return { state: "unavailable", root: defaultRoot, reason: "used-before" };
  try {
    createOwnedDirectory(defaultRoot, CREATED_ROOT_MARKER, STARTUP_ROOT_OWNER, "root");
  } catch {
    return { state: "unavailable", root: defaultRoot, reason: "create-failed" };
  }
  return { state: "created", root: defaultRoot };
}
