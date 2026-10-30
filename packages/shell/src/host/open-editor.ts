/**
 * [PiDock 10] (#15 box 28) the Host-side external-editor launch.
 *
 * The rules (which program, which path, which refusal) live in
 * `main/external-editor.ts`; this module is the actor that really spawns, so
 * the operation runs inside the per-task Host bound to the task folder the
 * file tree reads — an editor launch resolves the SAME root the tree shows.
 *
 * Design notes:
 * - Explicit human action only: the op requires the `shell-ui` attestation
 *   main stamps from the validated renderer sender, and the payload schema has
 *   no `sessionId`/`label` field at all (extra keys are refused at the
 *   envelope), so an Agent session cannot express control of this op and the
 *   Agent toolbox contains no editor tool.
 * - `spawn(program, argv)` with `shell: false`: the resolved path is one argv
 *   element. Nothing here builds a command string, so a path with spaces,
 *   quotes, `;` or `$HOME` cannot split into extra arguments.
 * - The program is probed on disk (here, immediately before the spawn) and the
 *   child is only reported as started once the OS confirmed the spawn, so a
 *   failure is a named refusal instead of a silent nothing.
 * - The launch writes nothing: no editor configuration is read, copied or
 *   generated, and the task workspace is untouched (盒子 28).
 * - The child is detached and unref'd: the user's editor outlives this Host
 *   (the Host is torn down with its task) and is never signalled by PiDock.
 */

import { spawn } from "node:child_process";
import { isTaskOpOrigin, type TaskOpOrigin } from "../rpc/protocol.js";
import {
  EDITOR_CONFIG_NOT_COPIED,
  EDITOR_WRITE_COORDINATION_BOUNDARY,
  externalEditorPlan,
  probeEditorDirectory,
  probeEditorProgram,
  type ExternalEditorLaunch,
} from "../main/external-editor.js";
import type { TaskWorkspaceFiles } from "./workspace-files.js";

/** Upper bound on the confirmation wait for the OS spawn result. */
export const EDITOR_SPAWN_CONFIRM_MS = 5_000;

/** What a launch reports back: the launch itself plus honest process facts. */
export interface ExternalEditorReceipt extends ExternalEditorLaunch {
  /** Control attribution: this is a labelled human explicit action. */
  actor: "human";
  label: string;
  started: true;
  pid?: number;
  /** The editor's own window is outside this workbench's observation. */
  windowObserved: false;
  note: string;
}

export type ExternalEditorOpenResult =
  | { ok: true; launch: ExternalEditorReceipt }
  | { ok: false; error: string };

/** One real spawner. Injectable so tests can also count launches. */
export interface ExternalEditorLauncher {
  launch(launch: ExternalEditorLaunch): Promise<{ ok: true; pid?: number } | { ok: false; error: string }>;
}

/**
 * The Host environment without the Host's own bindings: the editor is the
 * user's program and inherits the user's OS environment (PATH/HOME/TMPDIR/
 * locale — the same allowlist this Host was forked with), never PiDock's
 * workspace/task identity variables.
 */
function editorEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("PIDOCK_")) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Wait for the OS result of one spawn: confirmed start, or a named failure.
 *
 * The `error` listener is deliberately NOT detached on settle: Node reports a
 * `uv_spawn` failure (ENOENT/EACCES/EMFILE/EAGAIN/ENFILE) as a deferred event
 * after `spawn()` has already returned, so an unhandled `error` here would
 * throw inside this Host process — killing the process that owes the caller a
 * refusal. `onError` is idempotent through `settled`, so the leftover listener
 * is inert once the result is decided.
 */
function confirmSpawn(child: ReturnType<typeof spawn>): Promise<"spawned" | "failed"> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: "spawned" | "failed") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("spawn", onSpawn);
      resolve(result);
    };
    const onSpawn = () => settle("spawned");
    const onError = () => settle("failed");
    // A child that emitted neither event within the bound is not known to have
    // failed; the spawn call itself already returned a pid.
    const timer = setTimeout(() => settle("spawned"), EDITOR_SPAWN_CONFIRM_MS);
    timer.unref?.();
    child.once("spawn", onSpawn);
    child.once("error", onError);
    if (child.pid === undefined) settle("failed");
  });
}

export const nodeExternalEditorLauncher: ExternalEditorLauncher = {
  async launch(launch) {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launch.program, launch.args, {
        cwd: launch.cwd,
        // The editor is a GUI process of the user's own: it must outlive this
        // Host and must not inherit our stdio pipes.
        detached: true,
        stdio: "ignore",
        shell: false,
        env: editorEnvironment(),
      });
    } catch (error) {
      return { ok: false, error: `editor-spawn-failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    const confirmed = await confirmSpawn(child);
    if (confirmed === "failed") {
      return { ok: false, error: `editor-spawn-failed: 无法启动配置的外部编辑器程序（${launch.program}）` };
    }
    child.unref();
    return { ok: true, ...(child.pid !== undefined ? { pid: child.pid } : {}) };
  },
};

/**
 * One editor launch for one root of this task: human attestation first, then
 * the rules, then the real spawn. Nothing is spawned unless every check passed,
 * and a refused launch reports its own name instead of a boolean.
 */
export async function openExternalEditor(input: {
  files: TaskWorkspaceFiles;
  /** Envelope payload: `{rootId, editor:{program, args?}}` only. */
  payload: Record<string, unknown>;
  origin?: TaskOpOrigin;
  launcher?: ExternalEditorLauncher;
  probeProgram?: typeof probeEditorProgram;
  probeDirectory?: typeof probeEditorDirectory;
}): Promise<ExternalEditorOpenResult> {
  // Explicit human action: only main can mint the `shell-ui` attestation (from
  // the validated shell sender), and the `service-catalog` origin is main's
  // own recipe path, not a user action, so it is refused here as well.
  if (!isTaskOpOrigin(input.origin) || input.origin.kind !== "shell-ui") {
    return {
      ok: false,
      error: "permission-denied: 外部编辑器只允许界面显式操作（需要受信任来源），未启动任何程序",
    };
  }
  let roots;
  try {
    roots = input.files.roots();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const planned = externalEditorPlan({
    roots,
    taskId: input.files.taskId,
    taskDir: input.files.taskDir,
    rootId: input.payload["rootId"],
    settings: input.payload["editor"],
    probeProgram: input.probeProgram ?? probeEditorProgram,
    probeDirectory: input.probeDirectory ?? probeEditorDirectory,
  });
  if (!planned.ok) return { ok: false, error: planned.error };
  const launcher = input.launcher ?? nodeExternalEditorLauncher;
  const spawned = await launcher.launch(planned.launch);
  if (!spawned.ok) return { ok: false, error: spawned.error };
  return {
    ok: true,
    launch: {
      ...planned.launch,
      actor: "human",
      label: `外部编辑器 ${planned.launch.rootId}（用户显式操作）`,
      started: true,
      ...(spawned.pid !== undefined ? { pid: spawned.pid } : {}),
      windowObserved: false,
      // The box-28 rule travels with the receipt; the editor's own window is
      // not observed by this workbench, so nothing about it is claimed.
      note: `${EDITOR_CONFIG_NOT_COPIED}；编辑器自身窗口状态不在本工作台观察范围内；${EDITOR_WRITE_COORDINATION_BOUNDARY}`,
    },
  };
}
