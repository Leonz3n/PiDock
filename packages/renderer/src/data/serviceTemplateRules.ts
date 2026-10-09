/**
 * Renderer mirror of the shell's shared-template rules
 * (`packages/shell/src/main/service-config.ts`) — the boundary note in
 * `docs/task-graph.md` keeps the renderer from importing shell modules, so
 * this is an independent pure mirror with the *same* codes and messages:
 * `validateServiceDescriptor` (program/args/ports/healthCheck/runType),
 * `validateSharedServiceWorkdir` (repo-relative working directory) and the
 * `共享模板` layer checks of `resolveServiceEnv` / `validateNoSecretsInShared`.
 * `test/serviceTemplateRules.parity.test.ts` locks every message against the
 * shell rule source, and main re-validates the same rules fail-closed, so the
 * page can show a precise reason without ever being the authority.
 */

export type ServiceRunType = "long-lived" | "prepare" | "one-shot";
export type ServiceHealthKind = "http" | "tcp" | "grpc";

export interface ServiceTemplateRuleError {
  code: "invalid-service" | "invalid-key" | "duplicate-key" | "missing-ref" | "secret-in-shared" | "invalid-port";
  message: string;
}

export interface ServiceTemplateDraft {
  name: string;
  program: string;
  args: string[];
  ports: number[];
  runType: ServiceRunType;
  /** Optional until the human picks a kind; `target` stays display-only. */
  healthCheck?: { kind: ServiceHealthKind; target?: string };
  /** Repo-relative working directory (never a machine path); absent means the repository root. */
  workdir?: string;
  shared: { key: string; value: string }[];
}

const SERVICE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Same heuristic as the shell rule: a key that must live in the private layer. */
export function isServiceSecretKey(key: string): boolean {
  return /PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY/i.test(key);
}

/**
 * Mirror of `validateSharedServiceWorkdir`: only a repo-relative directory is
 * portable enough for a shared revision; absolute forms, `\`, control
 * characters, `.`/`..`/empty segments, over-long values and credential-looking
 * segments are refused.
 */
export function validateServiceWorkdir(workdir: string): ServiceTemplateRuleError | null {
  const value = workdir.trim();
  if (value.length === 0) return { code: "invalid-service", message: "工作目录不能为空；不填写表示使用仓库根目录" };
  if (value.length > 512) return { code: "invalid-service", message: "工作目录过长，请使用仓库内的简短相对目录" };
  if (value.startsWith("/") || value.startsWith("~") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) {
    return { code: "invalid-service", message: "工作目录必须是仓库内相对目录，不能是本机绝对路径" };
  }
  if (/[\\\0\r\n]/.test(value)) return { code: "invalid-service", message: "工作目录不能包含反斜杠或控制字符" };
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0)) {
    return { code: "invalid-service", message: "工作目录不能以斜杠开头、结尾或包含空目录名" };
  }
  if (parts.some((part) => part === "." || part === "..")) {
    return { code: "invalid-service", message: "工作目录不能包含 . 或 .. 片段，不能跳出仓库" };
  }
  if (isServiceSecretKey(value)) return { code: "secret-in-shared", message: "工作目录不能包含疑似凭据片段，请改用中性目录名" };
  return null;
}

/** Strict parser for a Host/renderer-boundary workdir value: valid or refused. */
export function serviceWorkdirFromMain(value: unknown): string | null {
  return typeof value === "string" && validateServiceWorkdir(value) === null ? value : null;
}

/**
 * The comma-separated port field as the rule layer sees it: a numeric part out
 * of range reports the shell's own message, and text that is not a number (the
 * shell never receives one) is named as the form-level problem it is.
 */
export function servicePortsFromDraft(text: string): { ports: number[] } | { error: ServiceTemplateRuleError } {
  const parts = text.trim() === "" ? [] : text.split(",").map((part) => part.trim());
  const ports: number[] = [];
  for (const part of parts) {
    if (part === "") return { error: { code: "invalid-port", message: "端口不能为空；多个端口请以逗号分隔" } };
    if (!/^[0-9]+$/.test(part)) return { error: { code: "invalid-port", message: `端口必须是数字：${part}` } };
    const value = Number(part);
    if (value < 1 || value > 65535) return { error: { code: "invalid-port", message: `端口必须在 1–65535 之间：${part}` } };
    ports.push(value);
  }
  return { ports };
}

/** One list row of shared values plus the layer checks the shell applies to them. */
function validateSharedRows(rows: readonly { key: string; value: string }[]): ServiceTemplateRuleError | null {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (!SERVICE_KEY_PATTERN.test(key)) {
      return { code: "invalid-key", message: `共享模板：KEY「${row.key}」只能包含字母、数字和下划线，且不能以数字开头` };
    }
    if (seen.has(key)) return { code: "duplicate-key", message: `共享模板：KEY「${key}」重复，请使用不同名称` };
    seen.add(key);
    if (isServiceSecretKey(key)) {
      return { code: "secret-in-shared", message: `共享模板不能包含凭据「${key}」；请移入本机私有配置` };
    }
  }
  return null;
}

/**
 * Validate one shared-template draft in the shell's own order: descriptor
 * fields, then the shared working directory, then the shared rows. The first
 * refusal is returned verbatim so the editor shows the rule's exact reason.
 */
export function validateServiceTemplateDraft(draft: ServiceTemplateDraft): ServiceTemplateRuleError | null {
  const program = draft.program.trim();
  if (program.length === 0) return { code: "invalid-service", message: "启动程序不能为空，请填写明确的可执行程序" };
  if (/[\s]/.test(program)) return { code: "invalid-service", message: `启动程序必须是单个可执行文件，不能包含空格：${program}` };
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(program) || program.includes("=")) {
    return { code: "invalid-service", message: `启动程序不能携带内联环境赋值（${program}）；请把变量写入环境层，程序与参数分开填写` };
  }
  if (/(&&|\|\||[;|`]|\$\()/.test([program, ...draft.args].join(" "))) {
    return { code: "invalid-service", message: "启动命令不能使用 shell 连接符；请拆分为明确的程序与参数" };
  }
  if (draft.name.trim().length === 0) return { code: "invalid-service", message: "请填写服务名称" };
  for (const port of draft.ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { code: "invalid-port", message: `端口必须在 1–65535 之间：${String(port)}` };
    }
  }
  if (draft.healthCheck && !["http", "tcp", "grpc"].includes(draft.healthCheck.kind)) {
    return { code: "invalid-service", message: `未知的健康检查类型：${String(draft.healthCheck.kind)}` };
  }
  if (draft.workdir !== undefined) {
    const workdir = validateServiceWorkdir(draft.workdir);
    if (workdir) return workdir;
  }
  return validateSharedRows(draft.shared);
}

/** One list row of shared values plus the layer checks the shell applies to them. */
