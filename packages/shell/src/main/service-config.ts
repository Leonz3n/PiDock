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
 *   the shared template: `validateNoSecretsInShared` enforces it for keys,
 *   and `validateSharedServiceProgram` / `validateSharedServiceArgument` /
 *   `validateSharedServiceHealthTarget` / `validateSharedServiceValue` extend
 *   the same fail-closed policy to a program name, an argument, a health
 *   target and a shared value (machine paths and credential spellings are
 *   refused wherever they appear in one field).
 * - A shared template's working directory is repo-relative and portable
 *   (`validateSharedServiceWorkdir`); the absolute cwd of one machine is
 *   the task binding's job.
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

/**
 * The one masked spelling a value takes wherever it leaves the Host: the page's
 * effective-config table, the Agent's service status and an import draft all
 * show this form instead of a private value.
 */
export const SERVICE_VALUE_MASK = "••••••••";

/** Display form: secrets are masked, everything else verbatim. */
export function maskServiceValue(entry: ServiceConfigEntry): string {
  return entry.secret || isServiceSecretKey(entry.key) ? SERVICE_VALUE_MASK : entry.value;
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

/**
 * Shared-template working directory: the portable, repo-relative default the
 * task binding pre-fills. A shared revision never carries a machine path, so
 * absolute forms (POSIX `/…`, `~/…`, Windows drive, UNC), `\`, control
 * characters, `.`/`..` segments, empty segments and credential-looking
 * segments are rejected fail-closed; the concrete absolute cwd stays in the
 * task binding (`rootId` + `subdir`) and is what a launch resolves.
 */
export function validateSharedServiceWorkdir(workdir: string): ServiceConfigError | null {
  const value = workdir.trim();
  if (value.length === 0) {
    return { code: "invalid-service", message: "工作目录不能为空；不填写表示使用仓库根目录" };
  }
  if (value.length > 512) {
    return { code: "invalid-service", message: "工作目录过长，请使用仓库内的简短相对目录" };
  }
  if (value.startsWith("/") || value.startsWith("~") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) {
    return { code: "invalid-service", message: "工作目录必须是仓库内相对目录，不能是本机绝对路径" };
  }
  if (/[\\\0\r\n]/.test(value)) {
    return { code: "invalid-service", message: "工作目录不能包含反斜杠或控制字符" };
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0)) {
    return { code: "invalid-service", message: "工作目录不能以斜杠开头、结尾或包含空目录名" };
  }
  if (parts.some((part) => part === "." || part === "..")) {
    return { code: "invalid-service", message: "工作目录不能包含 . 或 .. 片段，不能跳出仓库" };
  }
  if (isServiceSecretKey(value)) {
    return { code: "secret-in-shared", message: "工作目录不能包含疑似凭据片段，请改用中性目录名" };
  }
  return null;
}

/** One path root at the start of a token: POSIX absolute, home, Windows drive/UNC, or an escape segment. */
function pathRootOf(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value) ||
    value === ".." || value.startsWith("../") || value.startsWith("..\\");
}

/**
 * True when one command token, health target or value carries a machine path
 * *anywhere* in the token: at the start, after `=` or a short flag cluster
 * (`-I/Users/name` is as private as `/Users/name`), or as a `file://` URL. A
 * repo-relative token (`src/main.ts`) stays portable, so a shared revision
 * does not lose legitimate relative arguments.
 */
export function carriesMachinePath(value: string): boolean {
  if (/^file:\/\//i.test(value)) return true;
  const flagStripped = value.replace(/^--?[A-Za-z0-9]+/, "");
  return pathRootOf(value) || (flagStripped !== value && pathRootOf(flagStripped)) ||
    /(?:^|=)(?:[/\\~]|[A-Za-z]:[\\/]|\.\.[\\/])/.test(value);
}

/** Credential word; in an argument it counts even without `=` (`--token`). */
const SHARED_CREDENTIAL_WORD = /(?:password|passwd|secret|token|api[_-]?key|access[_-]?token|private[_-]?key)/i;
/** Credential assignment or URL userinfo anywhere: `apikey=`, `api_key=`, `x-key=`, `https://user:pass@…`. */
const SHARED_CREDENTIAL_ASSIGNMENT =
  /:\/\/[^/\s]+@|(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?token|private[_-]?key)\s*=|(?:^|[?&])[^=&\s]{0,40}(?:key|secret|token|password|passwd|auth)\s*=/i;
/** One shared argument: the value/target spellings plus a bare credential word. */
const SHARED_ARGUMENT_CREDENTIAL = new RegExp(`(?:${SHARED_CREDENTIAL_WORD.source})|(?:${SHARED_CREDENTIAL_ASSIGNMENT.source})`, "i");

/**
 * Shared-revision portability policy for the non-key fields (command
 * arguments, health-check targets, shared values): a shared revision never
 * carries a machine path or a credential, and the matcher is deliberately
 * wider than one leading-path or `[?&]`-prefixed spelling. Only the class is
 * returned, so a refused credential is never echoed back into a page.
 */
function sharedFieldRefusal(value: string, credential: RegExp): "path" | "credential" | null {
  if (credential.test(value)) return "credential";
  return carriesMachinePath(value) ? "path" : null;
}

/** One shared command argument: bounded, single-line, and never a machine path or credential. */
export function validateSharedServiceArgument(argument: string): ServiceConfigError | null {
  if (argument.length > 512) {
    return { code: "invalid-service", message: "共享模板参数过长，请改用简短的可移植参数" };
  }
  if (/[\r\n\0]/.test(argument)) {
    return { code: "invalid-service", message: "共享模板参数不能包含控制字符，请改用单行参数" };
  }
  const refusal = sharedFieldRefusal(argument, SHARED_ARGUMENT_CREDENTIAL);
  if (refusal === "path") {
    return { code: "invalid-service", message: "共享模板参数不能携带本机路径；请改用仓库内相对参数" };
  }
  if (refusal === "credential") {
    return { code: "secret-in-shared", message: "共享模板参数不能携带凭据；请移入本机私有配置" };
  }
  return null;
}

/** One shared health-check target: bounded, single-line, and never a local socket/file path or credential. */
export function validateSharedServiceHealthTarget(target: string): ServiceConfigError | null {
  if (target.length > 512) {
    return { code: "invalid-service", message: "健康检查目标过长，请填写简短的服务地址" };
  }
  if (/[\r\n\0]/.test(target)) {
    return { code: "invalid-service", message: "健康检查目标不能包含控制字符，请填写单行地址" };
  }
  const refusal = sharedFieldRefusal(target, SHARED_CREDENTIAL_ASSIGNMENT);
  if (refusal === "path") {
    return { code: "invalid-service", message: "健康检查目标不能是本机文件路径；请填写服务地址，如 http://127.0.0.1:3000/health" };
  }
  if (refusal === "credential") {
    return { code: "secret-in-shared", message: "健康检查目标不能携带凭据或令牌；请移入本机私有配置" };
  }
  return null;
}

/** One shared value: bounded, single-line, and never a machine path or credential. */
export function validateSharedServiceValue(value: string): ServiceConfigError | null {
  if (value.length > 2048) {
    return { code: "invalid-service", message: "共享模板的值过长，请改用简短的可提交值" };
  }
  if (/[\0\r\n]/.test(value)) {
    return { code: "invalid-service", message: "共享模板的值不能包含控制字符" };
  }
  const refusal = sharedFieldRefusal(value, SHARED_CREDENTIAL_ASSIGNMENT);
  if (refusal === "path") {
    return { code: "invalid-service", message: "共享模板的值不能携带本机路径；请移入本机私有配置" };
  }
  if (refusal === "credential") {
    return { code: "secret-in-shared", message: "共享模板的值不能携带凭据；请移入本机私有配置" };
  }
  return null;
}

/**
 * Class of one value that must not become a shared value, reusing
 * `validateSharedServiceValue` ([PiDock 04] #7 box 3): a credential or a
 * machine path belongs to the local private layer, `unportable` covers the
 * remaining refusals (control characters, over-long text). Only the class is
 * returned, so an import draft can name the key that needs review without ever
 * echoing the value it refused.
 */
export function sharedValueRefusalClass(value: string): "credential" | "path" | "unportable" | null {
  if (value.length === 0) return null;
  const refusal = validateSharedServiceValue(value);
  if (refusal === null) return null;
  if (refusal.code === "secret-in-shared") return "credential";
  return carriesMachinePath(value) ? "path" : "unportable";
}

/** One shared program name: portable only (no machine path, no other special character). */
export function validateSharedServiceProgram(program: string): ServiceConfigError | null {
  if (!/^[A-Za-z0-9_.+-]+$/.test(program)) {
    return { code: "invalid-service", message: "共享模板的启动程序必须是可移植的程序名（如 node、pnpm），不能是本机路径或其他特殊字符" };
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
 * references resolve against earlier-resolved rows only (lower precedence
 * first; single pass, so a ref to a same/higher-layer key or a transitive
 * `A→B→C` chain resolves one level and an unknown name fails closed with
 * `missing-ref`, never silently empty). Duplicate keys *within* one layer
 * fail closed with `duplicate-key`; overrides *across* layers are the
 * documented mechanism. Secret flags propagate from the referenced row.
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

  // Layer order matters: rows resolve in precedence order against the
  // already-resolved lower-precedence map, so a `${REF}` always names an
  // earlier row and can never see a higher-precedence override.
  const resolvedByKey = new Map<string, ResolvedServiceRow>();
  const order: string[] = [];
  for (const [source, entries] of labeled) {
    for (const entry of entries) {
      const key = entry.key.trim();
      let secret = entry.secret || isServiceSecretKey(key);
      const missing: string[] = [];
      const resolved = entry.value.replace(REF_PATTERN, (_match, braced: string | undefined, plain: string | undefined) => {
        const name = braced ?? plain ?? "";
        const target = resolvedByKey.get(name);
        if (!target) {
          missing.push(name);
          return _match;
        }
        if (target.secret) secret = true;
        return target.value;
      });
      if (missing.length > 0) {
        return { ok: false, error: { code: "missing-ref", message: `变量「${key}」引用的 ${missing.map((name) => `「${name}」`).join("、")} 未定义` } };
      }
      // A higher-precedence override replaces the row but keeps source
      // label of the overriding layer; refs resolved below never see it.
      const rerendered: ResolvedServiceRow = { key, value: resolved, secret, source };
      if (!resolvedByKey.has(key)) order.push(key);
      resolvedByKey.set(key, rerendered);
    }
  }
  return { ok: true, rows: order.map((key) => resolvedByKey.get(key) as ResolvedServiceRow) };
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
 * until free (bounded: at most 100 steps). When still taken after the cap,
 * the original value stays and the key is NOT reported as moved — only
 * real moves land in `adjusted`, so the caller never reports a move to a
 * still-taken port. Returns the rows plus the moved keys. Pure: the input
 * rows are never mutated.
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
    if (candidate === value || used.has(candidate)) return row;
    used.add(candidate);
    adjusted.push({ key: row.key, before: value, after: candidate });
    return { ...row, value: String(candidate) };
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
  /** The signal in the candidate that chose `runType`; always shown beside the label. */
  runTypeBasis: string;
  /**
   * True when the candidate names no runnable command, so nothing distinguishes
   * a resident service from a one-shot command or a prepare step. The caller
   * must ask the human; the draft keeps the conservative `one-shot` and never
   * reports the candidate as a resident service.
   */
  runTypeUncertain: boolean;
  /** KEYs that are syntactically invalid and need fixing before save. */
  invalidVars: string[];
  /** Items needing human confirmation (empty values, unresolvable refs, secret-looking values in a shared draft). */
  toVerify: string[];
  origin: string;
}

const RESIDENT_RUN_SIGNAL = /(^|[\s:"'])(dev|start|serve|watch)([\s:"']|$)/;
const PREPARE_RUN_SIGNAL = /(prepare|postinstall|preinstall|install|setup|migrate|seed)/;
/** A resident word beside one of these starts a prepare step, not a long-running server. */
const RESIDENT_RUN_SIGNAL_VETO = /(migrate|seed|prepare|install)/;

/**
 * Classify one imported start command into a service draft. Splits the
 * command line on whitespace (no shell evaluation — chaining operators stay
 * inside the last arg so `validateServiceDescriptor` can reject them later).
 *
 * The run type is a *guess with a named basis*, never a silent promotion:
 * `dev|start|serve|watch` → long-lived, `prepare|install|setup|migrate|seed` →
 * prepare (a prepare word beside a resident word wins), everything else →
 * one-shot. The candidate name counts as a signal because that is where a
 * package script carries its own convention, and `runTypeBasis` says which of
 * the two matched. A candidate that names **no command at all** cannot be
 * classified: `runTypeUncertain` is true and `runType` stays `one-shot`, so a
 * caller can never turn an unknown candidate into a resident service by
 * accident.
 */
export function classifyImportDraft(input: ImportDraftInput): ImportDraft {
  const tokens = input.command.trim().split(/\s+/).filter((token) => token.length > 0);
  const [program = "", ...args] = tokens;
  const name = input.name?.trim() ?? "";
  const lowered = `${name} ${input.command}`.toLowerCase();
  const uncertain = program.length === 0;
  const resident = RESIDENT_RUN_SIGNAL.test(lowered) && !RESIDENT_RUN_SIGNAL_VETO.test(lowered);
  const prepare = !resident && PREPARE_RUN_SIGNAL.test(lowered);
  const runTypeBasis = uncertain
    ? "配置未给出启动命令，无法判定运行类型"
    : resident
      ? (RESIDENT_RUN_SIGNAL.test(input.command.toLowerCase()) ? "命令含常驻关键字 dev/start/serve/watch" : "名称含常驻关键字 dev/start/serve/watch")
      : prepare
        ? (PREPARE_RUN_SIGNAL.test(input.command.toLowerCase()) ? "命令含准备关键字 prepare/install/setup/migrate/seed" : "名称含准备关键字 prepare/install/setup/migrate/seed")
        : "未匹配常驻或准备关键字，按一次性命令处理";
  return {
    name: name || program,
    program,
    args,
    runType: uncertain ? "one-shot" : resident ? "long-lived" : prepare ? "prepare" : "one-shot",
    runTypeBasis,
    runTypeUncertain: uncertain,
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

/** Before/after diff for an Agent template edit (rename = remove + add). Keys compare trimmed on both sides so `" A"`↔`"A"` is not a phantom add/remove. */
export function diffServiceTemplate(before: ServiceConfigEntry[], after: ServiceConfigEntry[]): TemplateDiff {
  const beforeByKey = new Map(before.map((entry) => [entry.key.trim(), entry.value]));
  return {
    added: after.filter((row) => !beforeByKey.has(row.key.trim())).map((row) => row.key.trim()),
    changed: after
      .filter((row) => beforeByKey.has(row.key.trim()) && beforeByKey.get(row.key.trim()) !== row.value)
      .map((row) => ({ key: row.key.trim(), before: beforeByKey.get(row.key.trim()) ?? "", after: row.value })),
    removed: before.filter((entry) => !after.some((row) => row.key.trim() === entry.key.trim())).map((entry) => entry.key.trim()),
  };
}

/** `v12` → `v13`; a shared-template save always produces a new version. Versions are opaque: any non-empty string is accepted and compared by exact equality (`register`/`restartNeeded` never parse); only `nextServiceTemplateVersion` minting and the restart-needed equality check are contract. */
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
