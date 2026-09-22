import type { ConfigEntry, ConfigScope } from "./types";

/** A row being edited in the environment table; `id` is a stable React/key handle. */
export type ConfigRowDraft = { id: string; key: string; value: string };

/** Environment variable names follow the prototype's rule: letters, digits, `_`, no leading digit. */
export const CONFIG_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Keys whose value is a credential. Such values are shown masked and are the
 * only ones seeded into the machine-private layer, matching the prototype's
 * `sensitiveEnvKey`. This is a display heuristic, not a security boundary.
 */
export function isSensitiveKey(key: string): boolean {
  return /PASSWORD|SECRET|TOKEN|API_KEY/i.test(key);
}

/**
 * KEY validation for a table of rows, run before any save. VALUE may be empty.
 * Returns a row-specific message, or `null` when the table is valid. This is a
 * pure function so the rule is testable without rendering the page.
 */
export function validateConfigRows(rows: ConfigRowDraft[]): string | null {
  const seen = new Set<string>();
  for (let index = 0; index < rows.length; index += 1) {
    const key = rows[index].key.trim();
    if (!key) return `第 ${index + 1} 行 KEY 不能为空，请填写或删除此行。`;
    if (!CONFIG_KEY_PATTERN.test(key)) return `第 ${index + 1} 行 KEY 只能包含字母、数字和下划线，且不能以数字开头。`;
    if (seen.has(key)) return `第 ${index + 1} 行 KEY「${key}」重复，请使用不同名称。`;
    seen.add(key);
  }
  return null;
}

/** Classified before/after of a shared-template save. A KEY rename shows up as removed + added. */
export type ConfigDiff = {
  added: string[];
  changed: { key: string; before: string; after: string }[];
  removed: string[];
};

/** Every key in `before` that is absent from `after`, in `before` order. */
function missingKeys(before: ConfigEntry[], after: ConfigRowDraft[]): string[] {
  const afterKeys = new Set(after.map((row) => row.key.trim()));
  return before.filter((entry) => !afterKeys.has(entry.key)).map((entry) => entry.key);
}

/**
 * The diff shown before saving a shared template: added keys, keys whose value
 * changed, and removed keys. A KEY rename is intentionally reported as a
 * removal plus an addition, exactly like the prototype's review dialog.
 */
export function diffConfigRows(before: ConfigEntry[], after: ConfigRowDraft[]): ConfigDiff {
  const beforeByKey = new Map(before.map((entry) => [entry.key, entry.value]));
  const added = after.filter((row) => !beforeByKey.has(row.key.trim())).map((row) => row.key.trim());
  const changed = after
    .filter((row) => beforeByKey.has(row.key.trim()) && beforeByKey.get(row.key.trim()) !== row.value)
    .map((row) => ({ key: row.key.trim(), before: beforeByKey.get(row.key.trim()) ?? "", after: row.value }));
  return { added, changed, removed: missingKeys(before, after) };
}

/** `v12` → `v13`. A shared-template save always produces a new version. */
export function nextTemplateVersion(version: string): string {
  const parsed = Number.parseInt(version.replace(/^v/i, ""), 10);
  return `v${Number.isFinite(parsed) ? parsed + 1 : 1}`;
}

/**
 * Draft isolation key: 项目 / 环境 / 作用域 / 任务. Shared and private drafts
 * ignore the task segment; task overrides are per task.
 */
export function configDraftKey(
  projectId: string,
  environmentId: string,
  scope: ConfigScope,
  taskId?: string,
): string {
  return [projectId, environmentId, scope, scope === "task" ? (taskId ?? "") : ""].join(":");
}

/** Map a stored layer into editable rows. */
export function toConfigRows(entries: ConfigEntry[]): ConfigRowDraft[] {
  return entries.map((entry, index) => ({ id: `${entry.key}-${index}`, key: entry.key, value: entry.value }));
}
