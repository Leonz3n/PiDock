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

export type SkillSourcesResult = { ok: true; view: SkillSourcesView } | { ok: false; error: string };

const OPS = ["list", "add", "remove", "setEnabled"] as const;
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

export function performSkillSourcesOperation(payload: unknown, userData: string): SkillSourcesResult {
  if (!isRecord(payload)) return { ok: false, error: "Skills 操作参数无效" };
  const op = payload["op"];
  if (typeof op !== "string" || !(OPS as readonly string[]).includes(op)) return { ok: false, error: "未知的 Skills 操作" };
  const allowed: Record<SkillSourcesOp, readonly string[]> = {
    list: ["op"],
    add: ["op", "path"],
    remove: ["op", "id"],
    setEnabled: ["op", "id", "enabled"],
  };
  if (Object.keys(payload).some((key) => !allowed[op as SkillSourcesOp].includes(key))) {
    return { ok: false, error: "Skills 操作包含多余字段" };
  }
  const store = new SkillSourceStore(userData);
  if (op === "list") return { ok: true, view: store.view() };
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
