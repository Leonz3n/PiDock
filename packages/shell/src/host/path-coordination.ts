/**
 * Real-path write coordination across tasks for [PiDock 09] (#11).
 *
 * 任务级写操作权（`write-coordination.ts`）只回答「同一任务内谁在写」。但任务之间
 * 仍有真实共享的目录：03 的普通目录来源是**链接到原目录的共享视图**，写穿链接
 * 就是改原目录。所以任务锁**不能**当作共享文件的隔离手段 —— 本模块按**解析后的
 * 真实路径**（`realpath`，不是词法路径）再做一层跨任务协调：
 *
 * - 两个任务写同一真实路径（或互为祖先／后代）→ 串行，后来者被拒并说明持有者；
 * - 两个任务写互不重叠的真实路径 → 并行（不引入项目级／全局单会话锁）；
 * - 链接改指后真实路径变化 → 旧键随释放消失，新键重新判定，不沿用旧归属；
 * - 嵌套链接（链接目标落在另一个共享目录内）→ 按祖先真实路径判定重叠；
 * - 取消与派生执行 → 由 `release` / `releaseDerived` 释放，声明比回合活得久。
 *
 * 规则全是纯函数／纯状态机：Host 派发、renderer 展示和测试共用同一份判定，避免
 * 「真实路径写协调」被各处重写而漂移。fs 的真实解析（`realpathSync`）留在 Host，
 * 本模块只处理已经解析好的真实路径。
 */

/** Max live path keys; a bounded table, never an unbounded growth path. */
export const MAX_SHARED_PATH_KEYS = 64;
/** Max registered shared roots per task. */
export const MAX_SHARED_ROOTS = 16;

/**
 * Normalize one resolved path: slashes unified, `.`/`..` collapsed, no trailing
 * separator, Windows drive letters kept case-insensitively comparable. Returns
 * `""` for a value that carries no path.
 */
export function normalizeScopePath(value: string): string {
  const raw = value.trim().replace(/\\/g, "/");
  if (raw.length === 0) return "";
  const drive = /^([A-Za-z]):\//.exec(raw)?.[1];
  const absolute = raw.startsWith("/") || drive !== undefined;
  const body = drive !== undefined ? raw.slice(drive.length + 2) : raw;
  const parts: string[] = [];
  for (const segment of body.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  const joined = parts.join("/");
  if (drive !== undefined) return `${drive.toLowerCase()}:/${joined}`;
  return absolute ? `/${joined}` : joined;
}

/**
 * True when two resolved paths are the same path or one contains the other.
 * Segment-aware: `/a/bc` never overlaps `/a/b`.
 */
export function pathScopeOverlaps(left: string, right: string): boolean {
  const a = normalizeScopePath(left);
  const b = normalizeScopePath(right);
  if (a.length === 0 || b.length === 0) return false;
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Claim keys for a set of resolved paths: normalized, deduplicated and reduced
 * to the outermost paths, so claiming `/a` and `/a/b` holds one key (`/a`) and
 * a later request for `/a/c` still overlaps it.
 */
export function scopeKeysFor(paths: readonly string[]): string[] {
  const normalized = [...new Set(paths.map(normalizeScopePath).filter((path) => path.length > 0))].sort();
  return normalized.filter((path) => !normalized.some((other) => other !== path && path.startsWith(`${other}/`)));
}

/** A task's shared plain-directory root, as recorded at link time. */
export interface SharedRoot {
  /** Project directory id (link identity), for display. */
  directoryId: string;
  /** Absolute recorded source path (link target at link time). */
  sourcePath: string;
  /** Absolute real path resolved now (fs); differs from `sourcePath` when retargeted. */
  realPath: string;
}

/** Where one requested path lands, judged on the real path. */
export type PathScopeVerdict =
  | { kind: "task"; path: string; key: string }
  | { kind: "shared"; path: string; key: string; directoryId: string }
  | { kind: "outside"; path: string; reason: string };

/** A verdict that passed validation: the target is inside an allowed root. */
export type AllowedPathScope = Extract<PathScopeVerdict, { kind: "task" } | { kind: "shared" }>;

/**
 * Classify one **resolved** requested path against a task's allowed real-path
 * roots: the task folder itself, or one of its plain-directory link targets.
 * Anything else is `outside` and must be refused — this is what makes a
 * retargeted link (`sourcePath` now resolves elsewhere) and a nested link
 * (target inside another shared directory) validated on the real path instead
 * of the lexical one.
 *
 * The returned `key` is the normalized requested path itself (the unit of
 * coordination); `kind`/`directoryId` say which allowed root contains it, so a
 * caller can report "写入共享目录 X 下的路径". Distinct paths under one root are
 * compared with `pathScopeOverlaps` at claim time.
 */
export function classifyRealPath(input: {
  resolvedPath: string;
  taskDir: string;
  roots: readonly SharedRoot[];
}): PathScopeVerdict {
  const path = normalizeScopePath(input.resolvedPath);
  if (path.length === 0) return { kind: "outside", path, reason: "路径为空，无法按真实路径校验" };
  const taskDir = normalizeScopePath(input.taskDir);
  // Longest match wins: a link nested inside another shared directory keeps its
  // own identity instead of being reported as the outer root.
  const candidates = [...input.roots]
    .map((root) => ({ root, real: normalizeScopePath(root.realPath) }))
    .filter((entry) => entry.real.length > 0)
    .sort((a, b) => b.real.length - a.real.length);
  for (const entry of candidates) {
    if (pathScopeOverlaps(path, entry.real)) {
      return { kind: "shared", path, key: path, directoryId: entry.root.directoryId };
    }
  }
  if (taskDir.length > 0 && pathScopeOverlaps(path, taskDir)) return { kind: "task", path, key: path };
  return { kind: "outside", path, reason: `路径不在任务范围或其共享目录内（真实路径 ${path}）` };
}

export interface SharedPathClaim {
  taskId: string;
  sessionId: string;
  /** Human label: what the paths are held for. */
  label: string;
  /** Resolved real paths (or their containing shared roots). */
  paths: readonly string[];
  /** Derived executions are released explicitly, not with the turn. */
  derivedExecutionIds?: readonly string[];
}

export interface SharedPathHolder {
  taskId: string;
  sessionId: string;
  label: string;
  keys: string[];
  derivedExecutionIds: string[];
}

export type SharedPathClaimResult =
  | { ok: true; keys: string[] }
  | { ok: false; reason: string; conflicts: { key: string; holder: SharedPathHolder }[] };

/**
 * Cross-task coordination table keyed by real path. One holder per real-path
 * key; a request that overlaps another task's/session's key is refused with the
 * holder named (`shared-path-locked: ...`). Requests from the same task+session
 * extend their own holder (a nested tool inside a turn is not a conflict), and
 * a request from another session of the **same** task is still refused here so
 * the shared rule holds even if the task-level lock were bypassed.
 */
export class SharedPathCoordinator {
  private readonly holders = new Map<string, SharedPathHolder>();

  /** Live holders, oldest first, for display and tests. */
  snapshot(): SharedPathHolder[] {
    return [...this.holders.values()].map((holder) => ({ ...holder, keys: [...holder.keys], derivedExecutionIds: [...holder.derivedExecutionIds] }));
  }

  holderOf(path: string): SharedPathHolder | null {
    const key = normalizeScopePath(path);
    if (key.length === 0) return null;
    for (const holder of this.holders.values()) {
      if (holder.keys.some((held) => pathScopeOverlaps(held, key))) return { ...holder, keys: [...holder.keys], derivedExecutionIds: [...holder.derivedExecutionIds] };
    }
    return null;
  }

  /** Overlapping keys held by someone other than this task+session. */
  conflictsFor(claim: Pick<SharedPathClaim, "taskId" | "sessionId" | "paths">): { key: string; holder: SharedPathHolder }[] {
    const conflicts: { key: string; holder: SharedPathHolder }[] = [];
    for (const key of scopeKeysFor(claim.paths)) {
      for (const holder of this.holders.values()) {
        if (holder.taskId === claim.taskId && holder.sessionId === claim.sessionId) continue;
        if (holder.keys.some((held) => pathScopeOverlaps(held, key))) {
          conflicts.push({ key, holder: { ...holder, keys: [...holder.keys], derivedExecutionIds: [...holder.derivedExecutionIds] } });
        }
      }
    }
    return conflicts;
  }

  claim(claim: SharedPathClaim): SharedPathClaimResult {
    const keys = scopeKeysFor(claim.paths);
    if (keys.length === 0) return { ok: true, keys: [] };
    const conflicts = this.conflictsFor(claim);
    if (conflicts.length > 0) {
      const first = conflicts[0]!;
      return {
        ok: false,
        reason: `shared-path-locked: 真实路径 ${first.key} 由任务 ${first.holder.taskId} 的会话 ${first.holder.sessionId} 持有（${first.holder.label}），请等待其释放后再写入`,
        conflicts,
      };
    }
    const existing = this.holders.get(`${claim.taskId}::${claim.sessionId}`);
    const derivedExecutionIds = [...(existing?.derivedExecutionIds ?? []), ...(claim.derivedExecutionIds ?? [])];
    const merged = scopeKeysFor([...(existing?.keys ?? []), ...keys]);
    if (merged.length > MAX_SHARED_PATH_KEYS) {
      return { ok: false, reason: `真实路径写协调表已达上限（${MAX_SHARED_PATH_KEYS}），请先释放不再使用的共享路径`, conflicts: [] };
    }
    this.holders.set(`${claim.taskId}::${claim.sessionId}`, {
      taskId: claim.taskId,
      sessionId: claim.sessionId,
      label: claim.label,
      keys: merged,
      derivedExecutionIds,
    });
    return { ok: true, keys: merged };
  }

  /**
   * Release this session's keys. A holder with live derived executions keeps
   * its keys (盒子 4: the child process still writes them); with an explicit
   * `keepPaths` the holder stays on exactly those keys (partial release, e.g. a
   * turn settled while one subtree stays claimed). Otherwise the holder is
   * dropped entirely.
   */
  release(input: {
    taskId: string;
    sessionId: string;
    keepDerivedExecutionIds?: readonly string[];
    keepPaths?: readonly string[];
  }): { released: boolean; holder: SharedPathHolder | null } {
    const id = `${input.taskId}::${input.sessionId}`;
    const holder = this.holders.get(id);
    if (!holder) return { released: false, holder: null };
    const keepDerived = (input.keepDerivedExecutionIds ?? []).filter((entry) => holder.derivedExecutionIds.includes(entry));
    const keepPaths = scopeKeysFor(input.keepPaths ?? []);
    const nextKeys = keepDerived.length > 0 ? holder.keys : keepPaths;
    if (nextKeys.length > 0) {
      const next: SharedPathHolder = { ...holder, keys: nextKeys, derivedExecutionIds: keepDerived };
      this.holders.set(id, next);
      return { released: true, holder: { ...next, keys: [...next.keys], derivedExecutionIds: [...next.derivedExecutionIds] } };
    }
    this.holders.delete(id);
    return { released: true, holder: null };
  }

  /** Cancel/dispose: drop every key of one task, optionally keeping derived ids. */
  releaseTask(taskId: string, keepDerivedExecutionIds: readonly string[] = []): string[] {
    const released: string[] = [];
    for (const [id, holder] of [...this.holders.entries()]) {
      if (holder.taskId !== taskId) continue;
      const keep = keepDerivedExecutionIds.filter((entry) => holder.derivedExecutionIds.includes(entry));
      if (keep.length > 0) this.holders.set(id, { ...holder, keys: [], derivedExecutionIds: keep });
      else this.holders.delete(id);
      released.push(holder.sessionId);
    }
    return released;
  }

  reset(): void {
    this.holders.clear();
  }
}

/**
 * Why a shared-path claim was refused, in the words the renderer shows. Keeps
 * the `shared-path-locked` prefix the RPC layer and tests look for.
 */
export function sharedPathClaimError(result: Extract<SharedPathClaimResult, { ok: false }>): string {
  return result.reason;
}
