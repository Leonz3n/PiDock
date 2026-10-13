/**
 * [PiDock 10] (#15 box 28) 外部编辑器设置的渲染层契约.
 *
 * The renderer never reads or writes a file: it names the program the user
 * typed, and main validates it with the launch's own rules, probes it on disk
 * and writes its own machine-private document (`external-editor.json`). The
 * document path in the status is main's own path, shown to the user; it is not
 * something the page can choose.
 *
 * The parser is fail-closed: a payload that is not the documented shape is
 * dropped instead of being shown as 「未配置」, so a broken round trip never
 * reads like an empty setting the user could then "clear" by accident.
 */

import { shellBridge, type EditorSettingsRequest, type ShellTaskOpResult } from "./shellBridge";

export type EditorSettingsView = {
  /** The program the next launch would use; `null` = nothing is saved. */
  program: string | null;
  /** The user's own extra arguments, in order. */
  args: string[];
  /** Absolute path of the machine-private document main reads and writes. */
  settingsPath: string;
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Strict parse of main's settings status; a surprise drops the whole answer. */
export function editorSettingsFromHost(payload: unknown): EditorSettingsView | undefined {
  if (!record(payload)) return undefined;
  const program = payload["program"];
  const args = payload["args"];
  const settingsPath = payload["settingsPath"];
  if (program !== null && (typeof program !== "string" || program.length === 0)) return undefined;
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== "string")) return undefined;
  if (typeof settingsPath !== "string" || settingsPath.length === 0) return undefined;
  return { program, args: [...args] as string[], settingsPath };
}

export type EditorSettingsCall = { ok: true; settings: EditorSettingsView } | { ok: false; error: string };

/**
 * One `shell/editorSettingsOp` round trip through the attested main entry. Main
 * resolves the document path itself; this call carries the program the user
 * typed and nothing else.
 */
async function editorSettingsCall(request: EditorSettingsRequest): Promise<EditorSettingsCall> {
  const bridge = shellBridge();
  if (!bridge?.editorSettingsOp) return { ok: false, error: "当前不在桌面壳内，无法读写外部编辑器设置" };
  let result: ShellTaskOpResult;
  try {
    result = await bridge.editorSettingsOp(request);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
    return { ok: false, error: "invalid-payload: 外部编辑器设置返回异常，请重试" };
  }
  if (!result.ok) return { ok: false, error: result.error ?? "外部编辑器设置未保存" };
  const settings = editorSettingsFromHost(result.payload);
  if (!settings) return { ok: false, error: "Host 外部编辑器设置响应无法解析" };
  return { ok: true, settings };
}

/** True when the page runs inside the desktop shell with the settings op. */
export function editorSettingsAvailable(): boolean {
  return typeof shellBridge()?.editorSettingsOp === "function";
}

export const readEditorSettings = (): Promise<EditorSettingsCall> => editorSettingsCall({ op: "read" });

/** `args` is omitted, not sent empty, when the user gave no extra arguments. */
export const saveEditorSettings = (program: string, args: readonly string[]): Promise<EditorSettingsCall> =>
  editorSettingsCall({ op: "save", program, ...(args.length > 0 ? { args: [...args] } : {}) });

export const clearEditorSettings = (): Promise<EditorSettingsCall> => editorSettingsCall({ op: "clear" });
