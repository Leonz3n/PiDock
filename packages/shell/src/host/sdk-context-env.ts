/**
 * Fork-time environment for the isolated SDK model context ([PiDock 02m] #46).
 *
 * The `ModelRuntime` behind an explicit Provider probes every built-in provider
 * for ambient credentials, so the context that owns it must not inherit the
 * host environment. This module is the single place that decides what crosses
 * into that context:
 *
 * - the OS-level minimum the runtime needs to start (PATH, a private HOME, temp
 *   dir, and the Windows shell variables),
 * - the explicit task binding (`PIDOCK_TASK_ID` / `PIDOCK_TASK_DIR`),
 * - nothing else.
 *
 * The credential does **not** travel here: it is passed as worker input
 * (`workerData`) by the trusted caller, so it never enters a process
 * environment and can never be inherited by anything the model context spawns.
 * Measured behaviour: a `node:worker_threads` worker with an explicit `env`
 * inherits no ambient variable (checked under plain Node and the Electron main
 * process with `OPENAI_API_KEY`, `AWS_SECRET_ACCESS_KEY` and `HTTP_PROXY` set
 * in the parent).
 *
 * Pure (injected base env) and unit-tested.
 */

import { isAbsolute } from "node:path";
import { isCredentialEnvName } from "./explicit-text-provider.js";

/** Variables the runtime/Node may legitimately need, by platform. */
const PASSTHROUGH_POSIX = ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"] as const;
const PASSTHROUGH_WINDOWS = ["PATH", "TEMP", "TMP", "SystemRoot", "ComSpec", "PATHEXT", "LOCALAPPDATA", "ProgramData"] as const;

export interface SdkContextTaskBinding {
  taskId: string;
  taskDir: string;
}

export interface SdkContextDirs {
  /** Private HOME for this context. Substitutes the real user home. */
  home: string;
  /** Optional workspace id, kept for log correlation only. */
  workspaceId?: string;
}

/** Every name this builder may ever produce; the assert below is the boundary. */
function allowedNames(platform: "posix" | "win32"): Set<string> {
  const names = new Set<string>([
    "HOME", "USERPROFILE", "PIDOCK_SDK_ISOLATED", "PIDOCK_TASK_ID", "PIDOCK_TASK_DIR", "PIDOCK_WORKSPACE_ID",
  ]);
  for (const name of platform === "win32" ? PASSTHROUGH_WINDOWS : PASSTHROUGH_POSIX) names.add(name);
  return names;
}

export function buildSdkContextEnv(
  baseEnv: Record<string, string | undefined>,
  task: SdkContextTaskBinding,
  dirs: SdkContextDirs,
  platform: "posix" | "win32" = process.platform === "win32" ? "win32" : "posix",
): Record<string, string> {
  if (typeof task.taskId !== "string" || task.taskId.length === 0) throw new Error("invalid-payload: taskId must be a non-empty string");
  if (typeof task.taskDir !== "string" || !isAbsolute(task.taskDir)) throw new Error("invalid-payload: taskDir must be an absolute task root");
  if (typeof dirs.home !== "string" || !isAbsolute(dirs.home)) throw new Error("invalid-payload: sdk home must be an absolute directory");

  const env: Record<string, string> = {};
  for (const name of platform === "win32" ? PASSTHROUGH_WINDOWS : PASSTHROUGH_POSIX) {
    const value = baseEnv[name];
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) env[name] = value;
  }
  env["HOME"] = dirs.home;
  env["USERPROFILE"] = dirs.home;
  env["PIDOCK_SDK_ISOLATED"] = "1";
  env["PIDOCK_TASK_ID"] = task.taskId;
  env["PIDOCK_TASK_DIR"] = task.taskDir;
  if (dirs.workspaceId !== undefined) env["PIDOCK_WORKSPACE_ID"] = dirs.workspaceId;
  assertSdkContextEnv(env, platform);
  return env;
}

/**
 * Final safety net before spawning: only allowlisted names, no NUL, the opt-in
 * present, and no credential-shaped name at all (the credential travels as
 * worker input, so its presence in the environment is always a bug).
 */
export function assertSdkContextEnv(env: Record<string, string>, platform: "posix" | "win32" = process.platform === "win32" ? "win32" : "posix"): void {
  const allowed = allowedNames(platform);
  for (const [name, value] of Object.entries(env)) {
    if (!allowed.has(name)) throw new Error(`sdk-context-env-unexpected: ${name}`);
    if (typeof value !== "string" || value.includes("\0")) throw new Error(`sdk-context-env-invalid: ${name}`);
    if (isCredentialEnvName(name)) throw new Error(`sdk-context-env-credential-leak: ${name}`);
  }
  if (env["PIDOCK_SDK_ISOLATED"] !== "1") throw new Error("sdk-context-env-unisolated");
  if (typeof env["HOME"] !== "string" || env["HOME"].length === 0) throw new Error("sdk-context-env-missing-home");
  if (typeof env["PIDOCK_TASK_ID"] !== "string" || env["PIDOCK_TASK_ID"]!.length === 0) throw new Error("sdk-context-env-missing-task");
  if (typeof env["PIDOCK_TASK_DIR"] !== "string" || !isAbsolute(env["PIDOCK_TASK_DIR"]!)) throw new Error("sdk-context-env-missing-task-dir");
}
