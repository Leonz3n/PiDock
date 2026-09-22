/**
 * Service configuration domain for [PiDock 04] (#7), S1 slice.
 *
 * Pure rules (no Electron, no child_process, no filesystem): service
 * descriptors with explicit program+args, environment resolution with
 * source labels, import-draft classification, template diffs, and the
 * restart-needed computation. The Host execution layer (S2) and the
 * renderer forms (S3) both build on these rules; unit tests lock them
 * here so later slices cannot drift the contract.
 *
 * Design notes (from the #7 boxes):
 * - Business defaults are read by the service itself; the resolved rows
 *   below only record where each row came from (`仓库默认配置` first,
 *   then 共享模板 / 本机私有配置 / 任务覆盖, then runtime bindings).
 * - Credentials and local paths live in the private layer and NEVER in
 *   the shared template: `validateNoSecretsInShared` enforces it.
 * - Desktop launch uses an explicit program + argv array, never Unix-only
 *   inline env assignment (`FOO=bar cmd`); `validateServiceDescriptor`
 *   rejects programs carrying assignments or shell chaining.
 * - Each child process gets its own env object; nothing here touches
 *   `process.env` (S2 constructs the per-child env via `buildChildEnv`).
 */

export type ServiceRunType = "long-lived" | "prepare" | "one-shot";

export type ServiceHealthKind = "http" | "tcp" | "grpc";

export interface ServiceDescriptor {
  /** Stable id; absent when the form has not saved yet. */
  id?: string;
  name: string;
  /** Explicit program (single token, e.g. `pnpm`, `node`, `/usr/bin/python3`). */
  program: string;
  /** Explicit argv (never a shell string). */
  args: string[];
  /** Working directory; absolute task-root form (validated by the caller). */
  cwd?: string;
  /** Ports the service binds (e.g. `[5173]`). */
  ports: number[];
  healthCheck?: { kind: ServiceHealthKind; target?: string };
  runType: ServiceRunType;
  /** Owning repo (optional display link). */
  repo?: string;
}

export interface ServiceConfigEntry {
  key: string;
  value: string;
  secret: boolean;
}

export type ServiceConfigSource =
  | "仓库默认配置"
  | "共享模板"
  | "本机私有配置"
  | "任务覆盖"
  | "运行时绑定";

export interface ResolvedServiceRow extends ServiceConfigEntry {
  source: ServiceConfigSource;
}

export interface ServiceConfigError {
  code:
    | "invalid-service"
    | "invalid-key"
    | "duplicate-key"
    | "missing-ref"
    | "secret-in-shared"
    | "invalid-port";
  message: string;
}

export const SERVICE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Keys that must live in the private layer, never in the shared template. */
export function isServiceSecretKey(key: string): boolean {
  return /PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY/i.test(key);
}

/** Display form: secrets are masked, everything else verbatim. */
export function maskServiceValue(entry: ServiceConfigEntry): string {
  return entry.secret || isServiceSecretKey(entry.key) ? "••••••••" : entry.value;
}

/**
 * Validate one service descriptor. Rejects Unix-only inline env assignment
 * (`FOO=bar pnpm dev`), shell chaining (`&&`, `||`, `;`, `|`, backticks,
 * `$()`), blank programs, whitespace inside the program token, out-of-range
 * ports, and unknown health-check kinds. `cwd`, when present, must be an
 * absolute path (POSIX `/…`, `~/…`, Windows drive, or UNC — same rule as
 * task roots).
 */
export function validateServiceDescriptor(descriptor: ServiceDescriptor): ServiceConfigError | null {
  const program = descriptor.program.trim();
  if (program.length === 0) {
    return { code: "invalid-service", message: "启动程序不能为空，请填写明确的可执行程序" };
  }
  if (/[\s]/.test(program)) {
    return { code: "invalid-service", message: `启动程序必须是单个可执行文件，不能包含空格：${program}` };
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(program) || program.includes("=")) {
    return {
      code: "invalid-service",
      message: `启动程序不能携带内联环境赋值（${program}）；请把变量写入环境层，程序与参数分开填写`,
    };
  }
  if (/(&&|\|\||[;|`]|\$\()/.test([program, ...descriptor.args].join(" "))) {
    return { code: "invalid-service", message: "启动命令不能使用 shell 连接符；请拆分为明确的程序与参数" };
  }
  if (descriptor.name.trim().length === 0) {
    return { code: "invalid-service", message: "请填写服务名称" };
  }
  for (const port of descriptor.ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { code: "invalid-port", message: `端口必须在 1–65535 之间：${String(port)}` };
    }
  }
  if (descriptor.healthCheck && !["http", "tcp", "grpc"].includes(descriptor.healthCheck.kind)) {
    return { code: "invalid-service", message: `未知的健康检查类型：${String(descriptor.healthCheck.kind)}` };
  }
  if (descriptor.cwd !== undefined) {
    const cwd = descriptor.cwd.trim();
    const absolute =
      cwd.startsWith("/") || cwd.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(cwd) || /^\\\\[^\\]+\\[^\\]+/.test(cwd);
    if (!absolute) {
      return { code: "invalid-service", message: "工作目录必须是本机绝对路径" };
    }
  }
  return null;
}

export interface ServiceEnvLayers {
  /** Business defaults the service reads itself (e.g. `.env`, `config.yaml`). */
  repoDefaults: ServiceConfigEntry[];
  shared: ServiceConfigEntry[];
  privateEntries: ServiceConfigEntry[];
  task: ServiceConfigEntry[];
  /** Runtime bindings (e.g. PORT) appended last with the `运行时绑定` source. */
  runtime?: ServiceConfigEntry[];
}

function checkLayerKeys(layer: ServiceConfigEntry[], layerLabel: string): ServiceConfigError | null {
  const seen = new Set<string>();
  for (const entry of layer) {
    const key = entry.key.trim();
    if (!SERVICE_KEY_PATTERN.test(key)) {
      return { code: "invalid-key", message: `${layerLabel}：KEY「${entry.key}」只能包含字母、数字和下划线，且不能以数字开头` };
    }
    if (seen.has(key)) {
      return { code: "duplicate-key", message: `${layerLabel}：KEY「${key}」重复，请使用不同名称` };
    }
    seen.add(key);
  }
  return null;
}

/**
 * Shared templates must never carry secrets: a shared entry whose key looks
 * like a credential (or is marked secret) is rejected fail-closed so an
 * import carrying sensitive values cannot leak into a committable template.
 */
export function validateNoSecretsInShared(shared: ServiceConfigEntry[]): ServiceConfigError | null {
  for (const entry of shared) {
    if (entry.secret || isServiceSecretKey(entry.key.trim())) {
      return {
        code: "secret-in-shared",
        message: `共享模板不能包含凭据「${entry.key.trim()}」；请移入本机私有配置`,
      };
    }
  }
  return null;
}

const REF_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Resolve the effective env for one service. Precedence (low → high):
 * repoDefaults → shared → private → task → runtime. Each row keeps its
 * source label for the read-only effective-value view. `${VAR}` / `$VAR`
 * references resolve against lower-precedence rows already resolved; a
 * reference to an unknown name fails closed with `missing-ref` (never
 * silently empty). Duplicate keys *within* one layer fail closed with
 * `duplicate-key`; overrides *across* layers are the documented mechanism.
 */
export function resolveServiceEnv(layers: ServiceEnvLayers): { ok: true; rows: ResolvedServiceRow[] } | { ok: false; error: ServiceConfigError } {
  const labeled: [ServiceConfigSource, ServiceConfigEntry[]][] = [
    ["仓库默认配置", layers.repoDefaults],
    ["共享模板", layers.shared],
    ["本机私有配置", layers.privateEntries],
    ["任务覆盖", layers.task],
    ["运行时绑定", layers.runtime ?? []],
  ];
  for (const [source, entries] of labeled) {
    const invalid = checkLayerKeys(entries, source);
    if (invalid) return { ok: false, error: invalid };
  }
  const secretShared = validateNoSecretsInShared(layers.shared);
  if (secretShared) return { ok: false, error: secretShared };

  const merged = new Map<string, { value: string; secret: boolean; source: ServiceConfigSource }>();
  for (const [source, entries] of labeled) {
    for (const entry of entries) {
      const key = entry.key.trim();
      merged.set(key, { value: entry.value, secret: entry.secret || isServiceSecretKey(key), source });
    }
  }
  const rows: ResolvedServiceRow[] = [];
  for (const [key, cell] of merged) {
    const missing: string[] = [];
    const resolved = cell.value.replace(REF_PATTERN, (_match, braced: string | undefined, plain: string | undefined) => {
      const name = braced ?? plain ?? "";
      const target = merged.get(name);
      if (!target) {
        missing.push(name);
        return _match;
      }
      return target.value;
    });
    if (missing.length > 0) {
      return { ok: false, error: { code: "missing-ref", message: `变量「${key}」引用的 ${missing.map((name) => `「${name}」`).join("、")} 未定义` } };
    }
    rows.push({ key, value: resolved, secret: cell.secret, source: cell.source });
  }
  return { ok: true, rows };
}

/**
 * Build the per-child-process env object from resolved rows. Returns a fresh
 * object every call and never reads or writes `process.env`, so sibling
 * services cannot leak into each other and the app's global env is untouched.
 */
export function buildChildEnv(rows: ResolvedServiceRow[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const row of rows) env[row.key] = row.value;
  return env;
}

/**
 * Auto-adjust PORT-like bindings already taken: for each resolved row whose
 * key ends with `PORT` and whose numeric value is in `taken`, bump upward
 * until free (bounded: at most 100 steps, then the original value stays and
 * the caller reports the conflict). Returns the adjusted rows plus the list
 * of keys that moved. Pure: the input rows are never mutated.
 */
export function autoAdjustPorts(
  rows: ResolvedServiceRow[],
  taken: ReadonlySet<number>,
): { rows: ResolvedServiceRow[]; adjusted: { key: string; before: number; after: number }[] } {
  const used = new Set<number>(taken);
  const adjusted: { key: string; before: number; after: number }[] = [];
  const next = rows.map((row) => {
    if (!/PORT$/.test(row.key)) {
      const numeric = Number(row.value);
      if (Number.isInteger(numeric)) used.add(numeric);
      return row;
    }
    const value = Number(row.value);
    if (!Number.isInteger(value) || value < 1 || value > 65535) return row;
    let candidate = value;
    let steps = 0;
    while (used.has(candidate) && steps < 100) {
      candidate += 1;
      steps += 1;
    }
    used.add(candidate);
    if (candidate !== value) adjusted.push({ key: row.key, before: value, after: candidate });
    return candidate === value ? row : { ...row, value: String(candidate) };
  });
  return { rows: next, adjusted };
}

export interface ImportDraftInput {
  /** Service/recipe display name guess (e.g. package.json name, compose service). */
  name?: string;
  /** Raw start command line (e.g. `pnpm dev`, `go run ./...`, `bun run db:migrate`). */
  command: string;
  /** Where the draft came from (`.vscode/launch.json`, `package.json`, `compose.yaml`, …). */
  origin?: string;
}

export interface ImportDraft {
  name: string;
  program: string;
  args: string[];
  runType: ServiceRunType;
  /** KEYs that are syntactically invalid and need fixing before save. */
  invalidVars: string[];
  /** Items needing human confirmation (empty values, unresolvable refs, secret-looking values in a shared draft). */
  toVerify: string[];
  origin: string;
}

/**
 * Classify one imported start command into a service draft. Splits the
 * command line on whitespace (no shell evaluation — chaining operators stay
 * inside the last arg so `validateServiceDescriptor` can reject them later).
 * runType guess: `dev|start|serve|watch` → long-lived; `prepare|install|
 * setup|migrate|seed|postinstall` → prepare; everything else → one-shot
 * (caller confirms; the dialog always shows the guess for correction).
 */
export function classifyImportDraft(input: ImportDraftInput): ImportDraft {
  const tokens = input.command.trim().split(/\s+/).filter((token) => token.length > 0);
  const [program = "", ...args] = tokens;
  const lowered = input.command.toLowerCase();
  const runType: ServiceRunType =
    /(^|[\s:"'])(dev|start|serve|watch)([\s:"']|$)/.test(lowered) &&
    !/(migrate|seed|prepare|install)/.test(lowered)
      ? "long-lived"
      : /(prepare|postinstall|preinstall|install|setup|migrate|seed)/.test(lowered)
        ? "prepare"
        : "one-shot";
  return {
    name: input.name?.trim() || program,
    program,
    args,
    runType,
    invalidVars: [],
    toVerify: [],
    origin: input.origin ?? "unknown",
  };
}

/**
 * Audit env rows extracted alongside an import draft: syntactically invalid
 * KEYs go to `invalidVars`; empty values, `${REF}`s pointing outside the
 * extracted set, and secret-looking keys in a shared draft go to `toVerify`.
 * Pure helper so the import dialog can show both lists before saving.
 */
export function auditImportVars(
  rows: { key: string; value: string }[],
  options: { sharedDraft: boolean },
): { invalidVars: string[]; toVerify: string[] } {
  const invalidVars: string[] = [];
  const toVerify: string[] = [];
  const names = new Set(rows.map((row) => row.key.trim()));
  for (const row of rows) {
    const key = row.key.trim();
    if (!SERVICE_KEY_PATTERN.test(key)) {
      invalidVars.push(row.key);
      continue;
    }
    if (row.value.length === 0) {
      toVerify.push(`${key}：值为空，请确认`);
      continue;
    }
    if (options.sharedDraft && isServiceSecretKey(key)) {
      toVerify.push(`${key}：疑似凭据，请移入本机私有配置`);
      continue;
    }
    const missing: string[] = [];
    for (const match of row.value.matchAll(REF_PATTERN)) {
      const name = match[1] ?? match[2] ?? "";
      if (name && !names.has(name)) missing.push(name);
    }
    for (const name of missing) toVerify.push(`${key}：引用的「${name}」不在本次导入中，请确认`);
  }
  return { invalidVars, toVerify };
}

export interface TemplateDiff {
  added: string[];
  changed: { key: string; before: string; after: string }[];
  removed: string[];
}

/** Before/after diff for an Agent template edit (rename = remove + add). */
export function diffServiceTemplate(before: ServiceConfigEntry[], after: ServiceConfigEntry[]): TemplateDiff {
  const beforeByKey = new Map(before.map((entry) => [entry.key.trim(), entry.value]));
  return {
    added: after.filter((row) => !beforeByKey.has(row.key.trim())).map((row) => row.key.trim()),
    changed: after
      .filter((row) => beforeByKey.has(row.key.trim()) && beforeByKey.get(row.key.trim()) !== row.value)
      .map((row) => ({ key: row.key.trim(), before: beforeByKey.get(row.key.trim()) ?? "", after: row.value })),
    removed: before.filter((entry) => !after.some((row) => row.key.trim() === entry.key)).map((entry) => entry.key),
  };
}

/** `v12` → `v13`; a shared-template save always produces a new version. */
export function nextServiceTemplateVersion(version: string): string {
  const parsed = Number.parseInt(version.replace(/^v/i, ""), 10);
  return `v${Number.isFinite(parsed) ? parsed + 1 : 1}`;
}

/**
 * Services that must restart after a task adopts a newer template version:
 * every service whose recorded version differs from the adopted one. Pure
 * helper so the "explicit update lists restart-needed" box is testable
 * without rendering.
 */
export function restartNeededForTemplateAdopt(
  services: { id: string; name: string; templateVersion: string }[],
  adoptedVersion: string,
): { id: string; name: string; from: string; to: string }[] {
  return services
    .filter((service) => service.templateVersion !== adoptedVersion)
    .map((service) => ({ id: service.id, name: service.name, from: service.templateVersion, to: adoptedVersion }));
}

export interface PlatformLaunchRecord {
  program: string;
  args: string[];
  platform: string;
  nodeVersion: string;
  ok: boolean;
  note: string;
}

/** Record one per-platform desktop-launch verification (explicit program+args). */
export function recordPlatformLaunch(input: {
  program: string;
  args: string[];
  platform: string;
  nodeVersion: string;
  ok: boolean;
  note?: string;
}): PlatformLaunchRecord {
  return {
    program: input.program,
    args: [...input.args],
    platform: input.platform,
    nodeVersion: input.nodeVersion,
    ok: input.ok,
    note: input.note ?? "",
  };
}
