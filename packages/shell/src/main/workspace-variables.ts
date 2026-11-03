/**
 * [Pencil T09] #144: workspace variables, task-local overrides and the exact
 * values a managed Agent process receives.
 *
 * One shared, non-secret key/value map per workspace; a task may override a key
 * locally and deleting that override restores inheritance. The effective value
 * therefore has a scope (`workspace` | `task`) that the UI shows next to it.
 *
 * Boundaries kept deliberately narrow:
 * - Values are injected into the managed Agent process environment (the per-task
 *   Host fork) and are visible to its tools/commands.
 * - Credentials are NOT variables. Credential-shaped names (`*_TOKEN`,
 *   `*_API_KEY`, …), Provider references (`PIDOCK_PROVIDER_*`) and OS startup
 *   names (PATH/HOME/…) are refused by name, so a shared value can never become
 *   an implicit credential and a credential can never land in the shared map.
 * - Errors name the key only, never a value.
 * - Changes are applied when the task's Host starts: a running Host/turn keeps
 *   the environment it was forked with.
 */

import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export type VariableScope = "workspace" | "task";
export interface VariableRow { key: string; value: string }
/** One effective variable, with the layer that supplied the value. */
export interface EffectiveVariable extends VariableRow {
  scope: VariableScope;
  /** The workspace value when a task override shadows it; `null` for an inherited row. */
  inheritedValue: string | null;
}
export interface VariableRefusal { key: string; code: "reserved" | "credential" | "invalid-name" | "invalid-value" | "duplicate" }

export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_VALUE = 4096;
const MAX_ROWS = 100;
const MAX_TASKS = 2000;
const MAX_FILE = 1024 * 1024;
const FILE = "task-variables.json";

/**
 * Names the Agent process itself needs (or that would let a shared value change
 * how the process starts). A workspace variable must never be able to rewrite
 * PATH/HOME or the Host's own `PIDOCK_*` binding.
 */
const RESERVED_EXACT = new Set([
  "PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "PWD", "OLDPWD", "SHELL", "COMSPEC",
  "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR", "PATHEXT", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "LANG", "LC_ALL", "LC_CTYPE", "NODE_OPTIONS",
  "NODE_PATH", "BASH_ENV", "ENV", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH", "TERM", "SSH_AUTH_SOCK", "DISPLAY", "ELECTRON_RUN_AS_NODE",
]);
/** Mirrors the Host's credential-shaped test: such a name is a credential, not a shared value. */
const CREDENTIAL_ENV = /(?:^|_)(?:API_?KEY|ACCESS_KEY(?:_ID)?|TOKEN|SECRET(?:_ACCESS_KEY|_KEY)?|PASSWORD|PASSWD|CREDENTIALS?)(?:$|_)/i;

export type VariableRefusalCode = VariableRefusal["code"];

/** Why `key` may not be a workspace/task variable; `null` when it may. */
export function variableNameRefusal(key: string): VariableRefusalCode | null {
  if (typeof key !== "string" || !VARIABLE_NAME.test(key)) return "invalid-name";
  const upper = key.toUpperCase();
  if (upper.startsWith("PIDOCK_") || RESERVED_EXACT.has(upper)) return "reserved";
  if (CREDENTIAL_ENV.test(key)) return "credential";
  return null;
}

const REFUSAL_TEXT: Record<VariableRefusalCode, string> = {
  reserved: "保留名称（PATH/HOME 等 OS 启动变量与 PIDOCK_* 绑定不可作为工作空间变量）",
  credential: "凭据形态名称，请改用 Provider 凭据或凭据引用，不放入共享变量",
  "invalid-name": "变量名必须是字母或下划线开头，仅含字母、数字、下划线，最长 128 字符",
  "invalid-value": "变量值必须是不超过 4096 字符的单行文本（不含 NUL）",
  duplicate: "变量名重复",
};

export class VariableInputError extends Error {
  constructor(readonly code: VariableRefusalCode, readonly key: string) {
    // The key is safe to name; a value is never part of an error message.
    super(`variable-${code}: ${key} — ${REFUSAL_TEXT[code]}`);
    this.name = "VariableInputError";
  }
}

export function assertVariable(key: unknown, value: unknown): VariableRow {
  if (typeof key !== "string") throw new VariableInputError("invalid-name", "<non-string>");
  const refusal = variableNameRefusal(key);
  if (refusal !== null) throw new VariableInputError(refusal, key);
  if (typeof value !== "string" || value.length > MAX_VALUE || value.includes("\0") || /[\r\n]/.test(value)) {
    throw new VariableInputError("invalid-value", key);
  }
  return { key, value };
}

/**
 * Exact-key validation of a whole layer. Reserved/credential shapes are refused
 * with their own code so a caller can name the row instead of dropping it.
 */
export function validateVariableRows(rows: unknown): VariableRow[] {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new VariableInputError("invalid-value", "<rows>");
  const seen = new Set<string>();
  return rows.map((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) throw new VariableInputError("invalid-value", "<row>");
    const { key, value } = row as Record<string, unknown>;
    const valid = assertVariable(key, value);
    if (seen.has(valid.key)) throw new VariableInputError("duplicate", valid.key);
    seen.add(valid.key);
    return valid;
  });
}

/**
 * Effective rows for a task: workspace layer first, task overrides on top.
 * Reserved/credential rows that predate this validation (an older registry) are
 * dropped and reported by key, never injected and never silently accepted.
 */
export function resolveTaskVariables(
  workspace: readonly VariableRow[],
  overrides: readonly VariableRow[],
): { rows: EffectiveVariable[]; refused: VariableRefusal[] } {
  const refused: VariableRefusal[] = [];
  const merged = new Map<string, EffectiveVariable>();
  for (const row of workspace) {
    const code = variableNameRefusal(row.key);
    if (code !== null) { refused.push({ key: row.key, code }); continue; }
    merged.set(row.key, { key: row.key, value: row.value, scope: "workspace", inheritedValue: null });
  }
  for (const row of overrides) {
    const code = variableNameRefusal(row.key);
    if (code !== null) { refused.push({ key: row.key, code }); continue; }
    const inherited = merged.get(row.key);
    merged.set(row.key, {
      key: row.key, value: row.value, scope: "task",
      inheritedValue: inherited === undefined ? null : inherited.scope === "workspace" ? inherited.value : inherited.inheritedValue,
    });
  }
  const rows = [...merged.values()].sort((left, right) => left.key.localeCompare(right.key));
  return { rows, refused };
}

/** The environment record a Host fork receives, from already-resolved rows. */
export function variableEnvironment(rows: readonly EffectiveVariable[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const row of rows) env[row.key] = row.value;
  return env;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(value).sort().join(",") === [...fields].sort().join(",");
}
function taskId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value) || value === "." || value === "..") {
    throw new Error("task-variable-invalid-task");
  }
  return value;
}
function document(value: unknown): { version: 1; tasks: Array<{ taskId: string; environment: VariableRow[] }> } {
  if (!record(value) || !exactKeys(value, ["version", "tasks"]) || value["version"] !== 1 || !Array.isArray(value["tasks"])) {
    throw new Error("task-variable-store-invalid");
  }
  const tasks = (value["tasks"] as unknown[]).map((row) => {
    if (!record(row) || !exactKeys(row, ["taskId", "environment"])) throw new Error("task-variable-store-invalid");
    return { taskId: taskId(row["taskId"]), environment: validateVariableRows(row["environment"]) };
  });
  if (new Set(tasks.map((row) => row.taskId)).size !== tasks.length || tasks.length > MAX_TASKS) {
    throw new Error("task-variable-store-invalid");
  }
  return { version: 1, tasks };
}

export interface TaskVariableHooks { beforeCommit?: () => void }

/**
 * Main-owned, exact-key task override store (one file, atomic replace, 0600).
 * A task without an entry inherits the workspace untouched; deleting the last
 * override removes the entry so inheritance is restored, not shadowed by an
 * empty layer.
 */
export class TaskVariableStore {
  constructor(private readonly userData: string, private readonly hooks: TaskVariableHooks = {}) {}

  private path(): string { return join(this.userData, FILE); }

  private load(): { version: 1; tasks: Array<{ taskId: string; environment: VariableRow[] }> } {
    const file = this.path();
    let raw: Buffer;
    try {
      if (!lstatSync(file).isFile()) throw new Error("task-variable-store-invalid");
      raw = readFileSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, tasks: [] };
      throw error;
    }
    if (raw.length > MAX_FILE) throw new Error("task-variable-store-too-large");
    return document(JSON.parse(raw.toString("utf8")));
  }

  private save(value: { version: 1; tasks: Array<{ taskId: string; environment: VariableRow[] }> }): void {
    const serialized = JSON.stringify(document(value));
    if (Buffer.byteLength(serialized) > MAX_FILE) throw new Error("task-variable-store-too-large");
    try {
      if (!lstatSync(this.userData).isDirectory()) throw new Error("task-variable-store-invalid");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(this.userData, { recursive: true, mode: 0o700 });
    }
    const file = this.path();
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(tmp, "wx", 0o600);
      try { writeFileSync(fd, serialized); fsyncSync(fd); } finally { closeSync(fd); }
      this.hooks.beforeCommit?.();
      renameSync(tmp, file);
      if (process.platform !== "win32") {
        const dir = openSync(this.userData, "r");
        try { fsyncSync(dir); } finally { closeSync(dir); }
      }
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  list(taskId: string): VariableRow[] {
    const id = taskId_(taskId);
    return this.load().tasks.find((row) => row.taskId === id)?.environment.map((row) => ({ ...row })) ?? [];
  }

  /** One exact-key upsert; returns the task's whole override layer. */
  set(taskId: string, key: string, value: string): VariableRow[] {
    const id = taskId_(taskId);
    const row = assertVariable(key, value);
    const value_ = this.load();
    const entry = value_.tasks.find((item) => item.taskId === id);
    if (entry) {
      const existing = entry.environment.findIndex((item) => item.key === row.key);
      if (existing < 0) entry.environment.push(row); else entry.environment[existing] = row;
      entry.environment.sort((left, right) => left.key.localeCompare(right.key));
    } else {
      if (value_.tasks.length >= MAX_TASKS) throw new Error("task-variable-store-too-large");
      value_.tasks.push({ taskId: id, environment: [row] });
    }
    this.save(value_);
    return this.list(id);
  }

  /** Delete one override; the key falls back to the workspace value. */
  remove(taskId: string, key: string): { removed: boolean; overrides: VariableRow[] } {
    const id = taskId_(taskId);
    if (typeof key !== "string") throw new VariableInputError("invalid-name", "<non-string>");
    const value_ = this.load();
    const entry = value_.tasks.find((item) => item.taskId === id);
    if (!entry) return { removed: false, overrides: [] };
    const before = entry.environment.length;
    entry.environment = entry.environment.filter((item) => item.key !== key);
    const removed = entry.environment.length !== before;
    if (entry.environment.length === 0) value_.tasks = value_.tasks.filter((item) => item.taskId !== id);
    if (removed) this.save(value_);
    return { removed, overrides: this.list(id) };
  }

  /** Task deletion/transfer helper: no overrides survive an erased task identity. */
  clear(taskId: string): void {
    const id = taskId_(taskId);
    const value_ = this.load();
    const next = value_.tasks.filter((item) => item.taskId !== id);
    if (next.length !== value_.tasks.length) { value_.tasks = next; this.save(value_); }
  }
}

function taskId_(value: string): string {
  return taskId(value);
}
