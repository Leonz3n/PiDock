import { stat } from "node:fs/promises";
import type { LocalProject, ProjectSource } from "./project-registry.js";

/**
 * What a registered source path really is right now. `missing` and
 * `not-directory` are the two ways a workspace can stop being usable, and the UI
 * names them per source instead of failing the whole workspace.
 */
export type ProjectSourceStatus = "ok" | "missing" | "not-directory";
export interface ProjectSourceVerification {
  id: string;
  kind: "repository" | "directory";
  status: ProjectSourceStatus;
  /** The OS error code when the failure was not a plain absence (e.g. `EACCES`). */
  error?: string;
}
export interface ProjectSourceReport { projectId: string; sources: ProjectSourceVerification[] }

async function check(row: ProjectSource, kind: ProjectSourceVerification["kind"]): Promise<ProjectSourceVerification> {
  try {
    const info = await stat(row.path);
    return { id: row.id, kind, status: info.isDirectory() ? "ok" : "not-directory" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { id: row.id, kind, status: "missing" };
    // Anything else (permissions, loops, I/O) is reported as its own detail rather
    // than being flattened into "the folder is gone".
    return { id: row.id, kind, status: "missing", error: code ?? "stat-failed" };
  }
}

/** Main-side check: the renderer names a workspace, never a path. */
export async function verifyProjectSources(project: LocalProject): Promise<ProjectSourceReport> {
  const [repositories, directories] = await Promise.all([
    Promise.all(project.repositories.map((row) => check(row, "repository"))),
    Promise.all(project.directories.map((row) => check(row, "directory"))),
  ]);
  return { projectId: project.id, sources: [...repositories, ...directories] };
}
