/**
 * [PiDock 10] (#15 box 28) 从任务打开外部编辑器: the user's own editor, opened at
 * the task workspace root the file tree already resolves.
 *
 * Design notes (from the box):
 * - The editor program is a USER SETTING stored in this application's own
 *   machine-private configuration (`external-editor.json` under the app
 *   profile). Nothing the renderer, the page or an Agent names can choose it
 *   for a launch: the renderer may only name `taskId` + `rootId`, and this
 *   module takes the program from the settings document alone. The program in
 *   that document is chosen by the user in 本机设置, which writes the same
 *   document through main's attested `shell/editorSettingsOp`
 *   (`main/external-editor-settings.ts`) — never by the launch request.
 * - The launch is a plain `spawn(program, argv)` with `shell: false`. The
 *   resolved path is ONE argv element, never interpolated into a command
 *   string, so a path containing spaces, quotes, `;` or `$HOME` cannot split
 *   into extra arguments or run anything else.
 * - A plain-directory link keeps its shared identity: the editor opens the
 *   link's ORIGINAL target (that is where the user's real files are) while the
 *   disclosure keeps the link location and the `修改影响原文件` note visible.
 * - 「不自动复制整套敏感编辑器配置」 is enforced by construction: this module
 *   reads no editor configuration and writes nothing at all, so no
 *   `.vscode/**`, `launch.json`, settings or tasks file can appear because of
 *   a launch. The user's own editor setup applies because the editor opens at
 *   the real path.
 *
 * Pure rules + the real read-only settings loader; the child process itself is
 * spawned Host-side (`host/open-editor.ts`), and the write side of the same
 * document lives in `main/external-editor-settings.ts` so this module stays
 * free of any write.
 */

import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  findWorkspaceRoot,
  workspaceAttribution,
  type WorkspaceAttribution,
  type WorkspaceRoot,
  type WorkspaceRootKind,
} from "./workspace-files.js";

/** Machine-private settings file this application reads for the editor program. */
export const EXTERNAL_EDITOR_SETTINGS_FILE = "external-editor.json";
/** Read cap: a settings document larger than this is refused, not loaded. */
export const MAX_EDITOR_SETTINGS_BYTES = 8 * 1024;
/** Bound on the user's own editor arguments (`--new-window` style flags). */
export const MAX_EDITOR_ARGS = 16;
export const MAX_EDITOR_ARG_CHARS = 4096;

/** What the user configured: one absolute program plus optional own arguments. */
export interface ExternalEditorSettings {
  /** Absolute path of the editor program (never resolved through a shell). */
  program: string;
  /** User's own extra arguments, passed verbatim before the path. */
  args?: string[];
}

export type ExternalEditorSettingsResult =
  | { ok: true; settings: ExternalEditorSettings }
  | { ok: false; error: string };

export function externalEditorSettingsPath(profileDir: string): string {
  return join(profileDir, EXTERNAL_EDITOR_SETTINGS_FILE);
}

/**
 * The box-28 disclosure every launch carries: stated where the launch happens
 * so the honest claim travels with the receipt instead of living only in docs.
 */
export const EDITOR_CONFIG_NOT_COPIED =
  "未读取、未写入也未复制任何编辑器配置（不生成 .vscode、launch.json、settings 或 tasks 文件）";

/**
 * [PiDock 11] (#108, #117 第 6 项 / 业主定 A) The external editor is the user's
 * own tool: PiDock cannot fence it and does not try. Its writes are explicitly
 * outside PiDock's write coordination, and PiDock never pauses its own writes
 * just because an editor is open. Stated where the launch happens so the claim
 * travels with the receipt instead of living only in an ADR.
 */
export const EDITOR_WRITE_COORDINATION_BOUNDARY =
  "编辑器对文件的写入不受 PiDock 写协调约束，PiDock 不会因为它开着而暂停自己的写入";

function editorNotConfigured(settingsPath: string): { ok: false; error: string } {
  return {
    ok: false,
    error:
      `editor-not-configured: 尚未配置外部编辑器程序，未启动任何程序；` +
      `请在 ${settingsPath} 写入 {"program": "/绝对路径/编辑器"} 后重试`,
  };
}

/**
 * The ONE absolute-path rule the launch and the save path both apply: a
 * program is a real absolute path with no `.`/`..` segment, so a relative name
 * (which only a shell or `PATH` lookup could turn into a program) and any
 * traversal are refused before a probe. Returns the refusal's reason, or
 * `null` when the program is well-formed; each caller names its own refusal
 * and states what did not happen (`未启动任何程序` / `未保存任何设置`).
 */
export function editorProgramPathRefusal(program: string): string | null {
  return !isAbsolute(program) || program.split("/").some((part) => part === "." || part === "..")
    ? `外部编辑器程序必须是绝对路径（${program}）`
    : null;
}

/** The exact document a save writes and a launch reads (`{program, args?}`). */
export function serializeEditorSettings(settings: ExternalEditorSettings): string {
  return JSON.stringify(settings);
}

/** Strict shape check of the user's settings document (no unknown keys). */
function parseSettings(value: unknown): ExternalEditorSettings | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "配置必须是 JSON 对象";
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "program" && key !== "args") return `配置包含未知字段 ${key}`;
  }
  const program = record["program"];
  if (typeof program !== "string" || program.length === 0 || program.includes("\0") || program.length > MAX_EDITOR_ARG_CHARS) {
    return "program 必须是非空字符串（可执行程序的绝对路径）";
  }
  const args = record["args"];
  if (args !== undefined) {
    if (!Array.isArray(args) || args.length > MAX_EDITOR_ARGS) return `args 必须是至多 ${MAX_EDITOR_ARGS} 项的字符串数组`;
    for (const entry of args) {
      if (typeof entry !== "string" || entry.includes("\0") || entry.length > MAX_EDITOR_ARG_CHARS) {
        return "args 必须是至多 4096 字符的字符串数组";
      }
    }
  }
  return args === undefined ? { program } : { program, args: [...(args as string[])] };
}

/**
 * Read the user's editor program from this application's machine-private
 * settings document. A missing document is the named `editor-not-configured`
 * refusal (nothing is launched, nothing is created); an unreadable or
 * malformed document is refused by name rather than half-applied.
 */
export function loadExternalEditorSettings(profileDir: string): ExternalEditorSettingsResult {
  const path = externalEditorSettingsPath(profileDir);
  let text: string;
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > MAX_EDITOR_SETTINGS_BYTES) {
      return { ok: false, error: `editor-settings-invalid: ${path} 不是可读取的配置文件，未启动任何程序` };
    }
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return editorNotConfigured(path);
    return { ok: false, error: `editor-settings-invalid: 无法读取 ${path}，未启动任何程序` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: `editor-settings-invalid: ${path} 不是合法 JSON，未启动任何程序` };
  }
  const parsed = parseSettings(value);
  return typeof parsed === "string"
    ? { ok: false, error: `editor-settings-invalid: ${path} 的${parsed}，未启动任何程序` }
    : { ok: true, settings: parsed };
}

/**
 * Validate one editor program the USER is saving, with the launch's own rules
 * so a stored value is always a value a launch can use.
 *
 * Fail-closed and named: a shape problem is `editor-settings-invalid`, a
 * relative or traversing program is `editor-program-invalid`, and a document
 * that would exceed the read cap the launch enforces is refused as
 * `editor-settings-too-large` instead of being stored as a setting that could
 * never be read back. The program's existence/executability is probed by the
 * caller (`saveExternalEditorSetting`), which adds the launch's own
 * `editor-program-not-found` / `editor-program-not-executable` names.
 */
export function validateEditorProgramChoice(input: { program: unknown; args: unknown }): ExternalEditorSettingsResult {
  const candidate: Record<string, unknown> = { program: input.program };
  if (input.args !== undefined) candidate["args"] = input.args;
  const parsed = parseSettings(candidate);
  if (typeof parsed === "string") return { ok: false, error: `editor-settings-invalid: ${parsed}，未保存任何设置` };
  const pathRefusal = editorProgramPathRefusal(parsed.program);
  if (pathRefusal !== null) return { ok: false, error: `editor-program-invalid: ${pathRefusal}，未保存任何设置` };
  const document = serializeEditorSettings(parsed);
  if (Buffer.byteLength(document, "utf8") > MAX_EDITOR_SETTINGS_BYTES) {
    return {
      ok: false,
      error: `editor-settings-too-large: 配置超过 ${MAX_EDITOR_SETTINGS_BYTES} 字节，未保存任何设置`,
    };
  }
  return { ok: true, settings: parsed };
}

/** Result of checking one configured program on the real filesystem. */
export type ProgramProbeResult = "executable" | "missing" | "not-executable";

/** Real probe: an existing regular file the current user may execute. */
export function probeEditorProgram(program: string): ProgramProbeResult {
  try {
    if (!statSync(program).isFile()) return "not-executable";
  } catch {
    return "missing";
  }
  try {
    if (process.platform === "win32") accessSync(program, constants.F_OK);
    else accessSync(program, constants.X_OK);
    return "executable";
  } catch {
    return "not-executable";
  }
}

/** One resolved launch: exactly what will be spawned, and what it discloses. */
export interface ExternalEditorLaunch {
  rootId: string;
  rootKind: WorkspaceRootKind;
  /** Absolute path of the user-configured program. */
  program: string;
  /** The exact argv after the program: the user's args, then the ONE path. */
  args: string[];
  /** Working directory of the child: the real directory the editor opens. */
  cwd: string;
  /**
   * The single path argument handed to the editor. For a worktree root it is
   * the worktree itself; for a plain-directory link it is the link's ORIGINAL
   * target, so the user's own editor configuration applies to the real files.
   */
  openedPath: string;
  attribution: WorkspaceAttribution;
  /** Shared-directory or worktree identity, stated with the launch. */
  disclosure: string;
  configDisclosure: string;
}

export type ExternalEditorPlanResult =
  | { ok: true; launch: ExternalEditorLaunch }
  | { ok: false; error: string };

/**
 * Resolve one launch for one root of one task. The program comes only from the
 * user's settings, the root only from the task record, and the program is
 * probed on disk before anything is spawned so a missing or non-executable
 * editor is a named refusal instead of a silent nothing.
 */
export function externalEditorPlan(input: {
  roots: readonly WorkspaceRoot[];
  taskId: string;
  taskDir: string;
  rootId: unknown;
  /** The user's configured editor; `undefined` is the not-configured refusal. */
  settings: unknown;
  /** Injected so tests can force each branch and prove nothing was spawned. */
  probeProgram: (program: string) => ProgramProbeResult;
  probeDirectory: (path: string) => "directory" | "missing" | "not-directory";
}): ExternalEditorPlanResult {
  const settings = input.settings;
  if (settings === undefined || settings === null) {
    return { ok: false, error: "editor-not-configured: 尚未配置外部编辑器程序，未启动任何程序" };
  }
  const parsed = parseSettings(settings);
  if (typeof parsed === "string") {
    return { ok: false, error: `editor-settings-invalid: ${parsed}，未启动任何程序` };
  }
  const pathRefusal = editorProgramPathRefusal(parsed.program);
  if (pathRefusal !== null) {
    return { ok: false, error: `editor-program-invalid: ${pathRefusal}，未启动任何程序` };
  }
  const probed = input.probeProgram(parsed.program);
  if (probed === "missing") {
    return { ok: false, error: `editor-program-not-found: 配置的外部编辑器程序不存在（${parsed.program}），未启动任何程序` };
  }
  if (probed !== "executable") {
    return { ok: false, error: `editor-program-not-executable: 配置的外部编辑器程序不可执行（${parsed.program}），未启动任何程序` };
  }
  if (typeof input.rootId !== "string" || input.rootId.trim().length === 0) {
    return { ok: false, error: "invalid-payload: rootId must be a non-empty string" };
  }
  const root = findWorkspaceRoot(input.roots, input.rootId.trim());
  if (!root) {
    return {
      ok: false,
      error: `unknown-root: ${input.rootId.trim()} 不是本任务的文件根（仓库或普通目录链接）`,
    };
  }
  const attribution = workspaceAttribution(root, input.taskId, input.taskDir);
  // A link's identity is its original target: that is where the user's real
  // files (and their editor setup) live, so open the source, not the in-task
  // symlink, and keep the link location visible in the disclosure.
  const openedPath = root.kind === "worktree" ? root.path : (root.sourcePath ?? "");
  if (openedPath.length === 0) {
    return {
      ok: false,
      error: `plain-dir-source-missing: ${root.label} 是普通目录链接但没有记录原始目标，未启动任何程序`,
    };
  }
  const probedPath = input.probeDirectory(openedPath);
  if (probedPath === "missing") {
    return { ok: false, error: `editor-path-missing: 要打开的工作目录不存在（${openedPath}），未启动任何程序` };
  }
  if (probedPath !== "directory") {
    return { ok: false, error: `editor-path-not-directory: 要打开的工作路径不是目录（${openedPath}），未启动任何程序` };
  }
  const disclosure =
    root.kind === "worktree"
      // The pinned baseline is named as such: this worktree is on the task's own
      // branch (`task/<taskDirId>`), which is a different fact.
      ? `外部编辑器在任务工作副本打开：${openedPath}（仓库 ${attribution.repo ?? root.id}，远程基线分支 ${root.baselineBranch ?? ""}）`
      : `${attribution.sharedNote ?? "普通目录链接"}；外部编辑器打开原目录（链接位置 ${attribution.linkPath ?? root.path}）`;
  return {
    ok: true,
    launch: {
      rootId: root.id,
      rootKind: root.kind,
      program: parsed.program,
      args: [...(parsed.args ?? []), openedPath],
      cwd: openedPath,
      openedPath,
      attribution,
      disclosure,
      configDisclosure: EDITOR_CONFIG_NOT_COPIED,
    },
  };
}

/** Real directory probe for the path about to be opened. */
export function probeEditorDirectory(path: string): "directory" | "missing" | "not-directory" {
  try {
    return statSync(path).isDirectory() ? "directory" : "not-directory";
  } catch {
    return "missing";
  }
}
