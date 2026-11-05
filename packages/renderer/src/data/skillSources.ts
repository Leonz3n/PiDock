/**
 * Renderer view of the local Skills sources ([Pencil T16] Pencil T16).
 *
 * The shapes mirror `packages/shell/src/host/skill-sources.ts`: every row the
 * pane shows came from main's real-disk scan, and every action is one named
 * `shell/skillsOp`. The renderer never builds a source, never derives a skill
 * from a static card and never guesses a status: a source is `ok`, `disabled`,
 * `missing` or `unreadable`, and a skill is `ok` or `invalid` with the reason
 * the SDK gave.
 */
import { shellBridge, type PidockBridge } from "./shellBridge";

export type SkillResourceView = { path: string; bytes: number };

export type SkillEntryView = {
  key: string;
  name: string;
  description: string;
  sourceId: string;
  sourcePath: string;
  skillFile: string;
  skillDir: string;
  resources: SkillResourceView[];
  status: "ok" | "invalid";
  reason?: string;
  duplicates: string[];
};

export type SkillSourceScanView = {
  ownership?: "native";
  id: string;
  path: string;
  enabled: boolean;
  status: "ok" | "disabled" | "missing" | "unreadable";
  message?: string;
  skills: SkillEntryView[];
  diagnostics: Array<{ message: string; path?: string }>;
};

export type SkillSourcesView = {
  state: "ok" | "empty" | "invalid";
  file: string;
  config?: { nativeAgentDir?: string; nativeWarnings?: string[] };
  sources: SkillSourceScanView[];
  message?: string;
};

export type SkillSourcesReply = { ok: boolean; view?: SkillSourcesView; error?: string };

const NO_BRIDGE: PidockBridge = {};

async function call(bridge: PidockBridge | undefined, request: Record<string, unknown>): Promise<SkillSourcesReply> {
  const target = bridge ?? shellBridge() ?? NO_BRIDGE;
  const op = target.skillsOp;
  if (typeof op !== "function") return { ok: false, error: "Skills 来源尚未接线：当前不在桌面外壳中" };
  try {
    const result = await op(request);
    if (!result || typeof result !== "object" || typeof result.ok !== "boolean") return { ok: false, error: "Skills 来源响应无法核对" };
    if (!result.ok) return { ok: false, error: typeof result.error === "string" ? result.error : "Skills 来源操作失败" };
    return { ok: true, view: result.payload as SkillSourcesView };
  } catch {
    return { ok: false, error: "Skills 来源请求失败" };
  }
}

export function readSkillSources(bridge?: PidockBridge): Promise<SkillSourcesReply> {
  return call(bridge, { op: "list" });
}
export function addSkillSource(bridge: PidockBridge | undefined, path: string): Promise<SkillSourcesReply> {
  return call(bridge, { op: "add", path });
}
export function setSkillSourceEnabled(bridge: PidockBridge | undefined, id: string, enabled: boolean): Promise<SkillSourcesReply> {
  return call(bridge, { op: "setEnabled", id, enabled });
}
export function removeSkillSource(bridge: PidockBridge | undefined, id: string): Promise<SkillSourcesReply> {
  return call(bridge, { op: "remove", id });
}
/**
 * Issue 151: open the row's own `SKILL.md` with the OS default handler. The page
 * names the key the row already shows; main re-derives the file from its own
 * scan, so no path crosses this bridge and nothing is written.
 */
export function openSkillFile(bridge: PidockBridge | undefined, key: string): Promise<SkillSourcesReply> {
  return call(bridge, { op: "open", key });
}

export function skillSourceStatusLabel(status: SkillSourceScanView["status"]): string {
  return { ok: "已扫描", disabled: "已停用", missing: "来源缺失", unreadable: "无法访问" }[status];
}

export function skillStatusLabel(entry: SkillEntryView): string {
  return entry.status === "ok" ? "可用" : "无效";
}

/** The source label a duplicate skill is distinguished by. */
export function sourceLabelOf(view: SkillSourcesView, sourceId: string): string {
  return view.sources.find((source) => source.id === sourceId)?.path ?? sourceId;
}

/** Counts the summary line shows: sources by state and skills by state. */
export function skillSourceCounts(view: SkillSourcesView): {
  sources: number;
  enabled: number;
  broken: number;
  skills: number;
  invalid: number;
  duplicates: number;
} {
  let enabled = 0;
  let broken = 0;
  let skills = 0;
  let invalid = 0;
  let duplicates = 0;
  for (const source of view.sources) {
    if (source.enabled) enabled += 1;
    if (source.status === "missing" || source.status === "unreadable") broken += 1;
    for (const skill of source.skills) {
      skills += 1;
      if (skill.status === "invalid") invalid += 1;
      if (skill.duplicates.length > 0) duplicates += 1;
    }
  }
  return { sources: view.sources.length, enabled, broken, skills, invalid, duplicates };
}

/**
 * A skill expands only for the explicit request. This note is the pane's own
 * wording of the boundary the tests pin: a session reads the source document
 * when it is created, and Pi loads `SKILL.md` only when the model (or the user)
 * asks for it — never on history restore or on re-opening this page.
 */
export const SKILL_LOAD_BOUNDARY = "技能说明只在会话开始注入一次；展开 SKILL.md 只发生在明确请求时，历史恢复或重新查看本页不会重新加载，也不会重新执行。";
