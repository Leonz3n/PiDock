/**
 * Main-side operations for the Skills pane — [Pencil T16] #151.
 *
 * The renderer names one of four fixed ops and, at most, a directory path or a
 * source id. It never names the config file, never names a JSON document and
 * never asks main to load a skill: main's own `SkillSourceStore` owns the
 * app-private document under `userData`, and the scan runs through the SDK's
 * real loader against the real disk.
 *
 * The path a user adds is checked here rather than in the page (the page has no
 * filesystem at all): it must be absolute, must exist, must be a directory and
 * must not be an application-private config path. A refusal is a named sentence
 * the page can show, never a silently dropped row.
 */

import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { SkillSourceStore, type SkillSourcesView } from "./skill-source-store.js";
import { sourcePathKey } from "../host/skill-sources.js";

export type SkillSourcesResult =
  | {
    ok: true;
    view: SkillSourcesView;
    /**
     * [#151] The exact file `open` resolved. The caller launches it with the OS
     * handler; the page never receives or names a path.
     */
    open?: string;
  }
  | { ok: false; error: string };

const OPS = ["list", "add", "remove", "setEnabled", "open"] as const;
export type SkillSourcesOp = (typeof OPS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function directoryRefusal(path: unknown): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof path !== "string") return { ok: false, error: "请选择要添加的本地目录" };
  if (path.length === 0 || path.length > 4096 || path.includes("\0")) return { ok: false, error: "目录路径无效" };
  if (!isAbsolute(path) || path.startsWith("~")) return { ok: false, error: "请添加绝对路径的本地目录" };
  const resolved = resolve(path);
  try {
    if (!statSync(resolved).isDirectory()) return { ok: false, error: "该路径不是目录" };
  } catch {
    return { ok: false, error: "该目录不存在或不可访问" };
  }
  return { ok: true, path: resolved };
}

export function performSkillSourcesOperation(payload: unknown, userData: string, nativeAgentDir?: string): SkillSourcesResult {
  if (!isRecord(payload)) return { ok: false, error: "Skills 操作参数无效" };
  const op = payload["op"];
  if (typeof op !== "string" || !(OPS as readonly string[]).includes(op)) return { ok: false, error: "未知的 Skills 操作" };
  const allowed: Record<SkillSourcesOp, readonly string[]> = {
    list: ["op"],
    add: ["op", "path"],
    remove: ["op", "id"],
    setEnabled: ["op", "id", "enabled"],
    // `open` names the skill key the pane already shows; main re-derives the
    // file from its OWN scan, so a path is never accepted from the page.
    open: ["op", "key"],
  };
  if (Object.keys(payload).some((key) => !allowed[op as SkillSourcesOp].includes(key))) {
    return { ok: false, error: "Skills 操作包含多余字段" };
  }
  const store = new SkillSourceStore(userData, undefined, nativeAgentDir);
  if (op === "list") return { ok: true, view: store.view() };
  if (op === "open") {
    const key = payload["key"];
    if (typeof key !== "string" || key.length === 0 || key.length > 512) return { ok: false, error: "技能标识无效" };
    // [#151] The row's key is re-verified against the CURRENT scan: a source that
    // was switched off or removed since the pane was rendered has no entry any
    // more, and the file is served only when it still resolves inside that
    // source's directory.
    const view = store.view();
    const sourceId = key.includes("::") ? key.slice(0, key.indexOf("::")) : "";
    const source = view.sources.find((item) => item.id === sourceId);
    if (!source) return { ok: false, error: "技能不存在或来源已被移除" };
    if (!source.enabled) return { ok: false, error: "该技能来源已停用，重新启用后才能打开" };
    const entry = source.skills.find((skill) => skill.key === key);
    if (!entry) return { ok: false, error: "技能不存在，可能已从来源中移除" };
    const root = sourcePathKey(source.path);
    const file = sourcePathKey(entry.skillFile);
    if (file !== root && !file.startsWith(`${root}/`)) {
      return { ok: false, error: "技能文件不在来源目录内，已拒绝打开" };
    }
    return { ok: true, view, open: entry.skillFile };
  }
  if (op === "add") {
    const path = directoryRefusal(payload["path"]);
    if (!path.ok) return { ok: false, error: path.error };
    const added = store.add(path.path);
    if (!added.ok) return { ok: false, error: added.error };
    return { ok: true, view: store.view() };
  }
  const id = payload["id"];
  if (typeof id !== "string" || !/^src-[0-9a-f]{8}$/.test(id)) return { ok: false, error: "来源标识无效" };
  if (op === "remove") {
    const removed = store.remove(id);
    if (!removed.ok) return { ok: false, error: removed.error };
    return { ok: true, view: store.view() };
  }
  const enabled = payload["enabled"];
  if (typeof enabled !== "boolean") return { ok: false, error: "启停状态必须是布尔值" };
  const updated = store.setEnabled(id, enabled);
  if (!updated.ok) return { ok: false, error: updated.error };
  return { ok: true, view: store.view() };
}
