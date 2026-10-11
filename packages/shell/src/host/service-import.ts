import type { TaskPathProtection } from "./protected-application-path.js";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseEnv } from "node:util";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parseDocument } from "yaml";
import { auditImportVars, carriesMachinePath, classifyImportDraft, isServiceSecretKey, SERVICE_KEY_PATTERN, SERVICE_VALUE_MASK,
  sharedValueRefusalClass, validateSharedServiceWorkdir, type ServiceRunType } from "../main/service-config.js";
import type { WorkspaceRoot } from "../main/workspace-files.js";

/**
 * One variable of an import draft ([PiDock 04] #7 box 3): its name, the file it
 * came from and the only value form an import may carry. The scanner never
 * reads a value out of the repository into a draft, so a credential or a
 * machine path in the source configuration cannot reach a page, the Agent or a
 * template through this route.
 */
export interface ServiceImportVariable {
  key: string;
  source: string;
  maskedValue: string;
}

export interface ServiceImportHint {
  source: string;
  name: string;
  /** null identifies configuration-only hints, never an executable run unit. */
  runType: ServiceRunType | null;
  /** The signal behind `runType` (or why there is none); always shown beside the label. */
  runTypeBasis: string;
  /** True when the source names no runnable command: the human picks the type, the draft never assumes. */
  runTypeUncertain: boolean;
  /** Variables with their provenance and a masked value; never a value from the repository. */
  variables: ServiceImportVariable[];
  /**
   * Command-token candidate after the redaction policy below: the program
   * name (empty when it was dropped or the source carries no command) and
   * the surviving argv. A hint is a form candidate for human review, never
   * an executable launch on its own.
   */
  program: string;
  args: string[];
  /** Repo-relative working-directory candidate; absent when the source names none or it was dropped. */
  workdir?: string;
  invalidVars: string[];
  toVerify: string[];
}

export interface ServiceImportScan {
  hints: ServiceImportHint[];
  errors: { source: string; reason: string }[];
  truncated: boolean;
}

const SOURCES = ["package.json", ".vscode/launch.json", "compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml", ".env"] as const;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_HINTS = 100;
const MAX_ENV_ROWS = 100;
const MAX_ENV_KEY_CHARS = 100;
const MAX_WARNINGS = 30;
const MAX_TOKEN_CHARS = 200;
const MAX_ARGS = 40;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const display = (value: string) => value.slice(0, 100);

/**
 * Redaction policy for one command token. A token is emitted only when it
 * carries no machine path and no credential: a path root anywhere in the token
 * (absolute/`~`/drive/UNC forms, `file:` URLs and a path behind a short flag
 * cluster such as `-I/Users/name/include`), `KEY=VALUE` assignments,
 * `scheme://user:pass@` URLs, credential-looking text and over-long tokens are
 * dropped. Dropped tokens are reported by reason class (never echoed) so the
 * draft reads as incomplete instead of silently truncated.
 */
function unsafeCommandToken(token: string): "path" | "credential" | null {
  if (token.length === 0) return null;
  if (token.length > MAX_TOKEN_CHARS || /[\r\n\0]/.test(token)) return "credential";
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || token.includes("=")) return "credential";
  if (/:\/\/[^/\s]*@/.test(token) || /(?:password|token|secret|api[_-]?key)/i.test(token)) return "credential";
  return carriesMachinePath(token) ? "path" : null;
}

/** Split one scanned command into redacted program/argv plus the drop notes. */
function commandCandidate(command: string): { program: string; args: string[]; toVerify: string[] } {
  const toVerify: string[] = [];
  const tokens = command.trim().split(/\s+/).filter((token) => token.length > 0);
  let head = tokens[0] ?? "";
  // `PORT=4100 node server.js`: the leading assignments are configuration, not
  // the program, so they are dropped (never echoed) and the first safe token
  // becomes the program candidate.
  let droppedHead = 0;
  while (head.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
    droppedHead += 1;
    head = tokens[droppedHead] ?? "";
  }
  if (head.length === 0) {
    return { program: "", args: [], toVerify: tokens.length > 0
      ? ["启动命令只包含内联环境赋值，已从草案移除；请填写可移植的程序名"] : toVerify };
  }
  const headReason = unsafeCommandToken(head);
  if (headReason !== null) {
    return { program: "", args: [], toVerify: [...toVerify, headReason === "path"
      ? "启动命令以本机路径开头，已从草案移除；请填写可移植的程序名"
      : "启动命令以疑似凭据开头，已从草案移除；请填写可移植的程序名"] };
  }
  const rest = tokens.slice(droppedHead + 1);
  const args = rest.filter((token) => unsafeCommandToken(token) === null);
  const dropped = droppedHead + (rest.length - args.length);
  if (dropped > 0) toVerify.push(`启动命令有 ${String(dropped)} 个片段含本机路径、内联环境赋值或疑似凭据，已从草案移除，请人工核对`);
  if (args.length > MAX_ARGS) toVerify.push("启动参数已截断，请人工核对");
  return { program: head, args: args.slice(0, MAX_ARGS), toVerify };
}

/**
 * Repo-relative working-directory candidate for one scanned config. Only a
 * value the shared rule accepts is emitted; `${workspaceFolder}` resolves to
 * the repo root (no candidate), and anything else is dropped with a note.
 */
function workdirCandidate(value: string | undefined, toVerify: string[]): string | undefined {
  if (value === undefined) return undefined;
  const relative = value.replace(/^\$\{workspaceFolder\}/, "").replace(/^\$\{workspaceRoot\}/, "");
  if (relative.length === 0 || relative === ".") return undefined;
  if (validateSharedServiceWorkdir(relative) !== null) {
    toVerify.push("配置中的工作目录不是可移植的仓库内相对目录，已从草案移除，请人工核对");
    return undefined;
  }
  return relative;
}

function readSource(root: string, source: string, protection?: TaskPathProtection): string | null {
  const path = join(root, source);
  protection?.assert(path);
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return null;
  if (entry.isSymbolicLink()) throw Error("配置文件是符号链接，需要人工核对");
  const resolved = realpathSync(path);
  const inside = relative(root, resolved);
  if (inside === ".." || inside.startsWith(`..${sep}`)) throw Error("配置文件不在所选仓库内");
  const info = statSync(resolved);
  if (!info.isFile() || info.size > MAX_FILE_BYTES) throw Error("配置文件不是受限大小的普通文件");
  const fd = openSync(resolved, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_FILE_BYTES || opened.dev !== info.dev || opened.ino !== info.ino) {
      throw Error("配置文件在读取前被替换或超限");
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * One scanned variable row: the key plus the value only this module ever sees.
 * The value is turned into a named review item (never into a draft field), so a
 * hint can report what has to move to the local private layer without echoing
 * the text it refused.
 */
function variableRows(value: unknown): { rows: { key: string; value: string }[]; truncated: boolean } {
  const entries = object(value) ? Object.entries(value) : Array.isArray(value)
    ? value.filter((row): row is string => typeof row === "string").map((row) => {
      const separator = row.indexOf("=");
      return separator < 0 ? [row, ""] as const : [row.slice(0, separator), row.slice(separator + 1)] as const;
    }) : [];
  return { rows: entries.slice(0, MAX_ENV_ROWS).map(([key, raw]) => ({
    key: key.slice(0, MAX_ENV_KEY_CHARS),
    value: typeof raw === "string" ? raw : object(raw) && typeof raw["value"] === "string" ? raw["value"] : "",
  })), truncated: entries.length > MAX_ENV_ROWS };
}

/** One named review item for a value the shared template must not take. */
function valueRefusalNote(key: string, value: string): string | null {
  // A secret-looking KEY is already named by `auditImportVars`; a second note
  // about the same key would read as two separate problems.
  if (isServiceSecretKey(key)) return null;
  const refusal = sharedValueRefusalClass(value);
  if (refusal === null) return null;
  if (refusal === "credential") return `${key}：原配置中的值疑似凭据，已遮蔽；请移入本机私有配置`;
  if (refusal === "path") return `${key}：原配置中的值是本机路径，已遮蔽；请移入本机私有配置`;
  return `${key}：原配置中的值不能作为共享值保存，请人工核对`;
}

/** Variables with provenance and a masked value; a key's value never rides along. */
function variablesFor(rows: { key: string }[], source: string): ServiceImportVariable[] {
  return rows.map((row) => ({ key: row.key, source, maskedValue: SERVICE_VALUE_MASK }));
}

/** The named review items for the values of one scanned environment block. */
function valueRefusalNotes(rows: { key: string; value: string }[]): string[] {
  return [...new Set(rows.map((row) => valueRefusalNote(row.key, row.value)).filter((note): note is string => note !== null))];
}

function envAudit(value: unknown) {
  const scanned = variableRows(value);
  const audit = auditImportVars(scanned.rows, { sharedDraft: true });
  const malformed = value !== undefined && !object(value) && (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"));
  const warnings = [...new Set([...audit.toVerify.map(display), ...valueRefusalNotes(scanned.rows).map(display)]),
    ...(malformed ? ["环境变量结构无效，请人工核对"] : []),
    ...(scanned.truncated ? ["环境变量列表已截断，请人工核对"] : [])];
  return { rows: scanned.rows, invalidVars: audit.invalidVars.map(display),
    toVerify: warnings.length > MAX_WARNINGS ? [...warnings.slice(0, MAX_WARNINGS), "待核对项已截断"] : warnings };
}

function inlineAssignmentKey(command: string): string | null {
  const match = /^\s*(?:(?:export|set)\s+)?([^\s=]+)=/i.exec(command);
  return match ? match[1] ?? "" : null;
}

export function scanTaskServiceImportHints(input: { taskDir: string; roots: readonly WorkspaceRoot[]; protection?: TaskPathProtection }, rootId: string): ServiceImportScan {
  const selected = input.roots.find((root) => root.id === rootId);
  if (!selected || selected.kind !== "worktree") throw Error("unknown-worktree: 请选择当前任务的仓库工作副本");
  input.protection?.assert(input.taskDir); input.protection?.assert(selected.path);
  const taskRoot = realpathSync(input.taskDir);
  const repoRoot = realpathSync(selected.path);
  const inside = relative(taskRoot, repoRoot);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`)) throw Error("path-out-of-scope: 仓库工作副本不在任务根内");
  return scanServiceImportHints(repoRoot, input.protection);
}

/**
 * Read fixed, bounded repo config files into redacted import hints. Every
 * variable carries only its key, its source and a masked value (never a value
 * from the repository), command tokens pass the redaction policy above, the
 * run type is a named guess with an honest "cannot tell" case and the working
 * directory stays repo-relative, so nothing here is a launch plan: a hint only
 * fills a form for human review.
 */
export function scanServiceImportHints(repoRoot: string, protection?: TaskPathProtection): ServiceImportScan {
  protection?.assert(repoRoot);
  const root = realpathSync(repoRoot);
  if (!statSync(root).isDirectory()) throw Error("所选仓库不是目录");
  const hints: ServiceImportHint[] = [];
  const errors: ServiceImportScan["errors"] = [];
  let truncated = false;
  const add = (source: string, name: string, command: string, env?: unknown, workdir?: unknown) => {
    if (hints.length >= MAX_HINTS) { truncated = true; return; }
    const audit = envAudit(env);
    const draft = classifyImportDraft({ name, command, origin: source });
    const candidate = commandCandidate(command);
    const inlineKey = source === "package.json" ? inlineAssignmentKey(command) : null;
    const toVerify = [...audit.toVerify, ...candidate.toVerify];
    if (draft.runTypeUncertain) toVerify.push(`「${display(name)}」：${draft.runTypeBasis}；请人工选择常驻服务、一次性命令或准备步骤`);
    const workdirValue = workdirCandidate(typeof workdir === "string" ? workdir : undefined, toVerify);
    const invalidVars = inlineKey && !SERVICE_KEY_PATTERN.test(inlineKey) ? [...audit.invalidVars, display(inlineKey)] : audit.invalidVars;
    hints.push({ source, name: display(name), runType: draft.runType, runTypeBasis: draft.runTypeBasis,
      runTypeUncertain: draft.runTypeUncertain,
      variables: variablesFor(audit.rows, source),
      program: candidate.program, args: candidate.args, ...(workdirValue === undefined ? {} : { workdir: workdirValue }),
      invalidVars, toVerify: [...toVerify,
        ...(inlineKey ? ["脚本开头使用内联环境赋值；请将变量移入配置层以支持跨平台启动"] : []),
        "启动命令、参数及工作目录需人工核对；草案不可直接运行"] });
  };
  for (const source of SOURCES) {
    try {
      const content = readSource(root, source, protection);
      if (content === null) continue;
      if (source === ".env") {
        if (hints.length >= MAX_HINTS) { truncated = true; continue; }
        // Node's permissive parser provides candidates, not syntax or business
        // configuration validation. Keys are filtered to the shared key pattern
        // (so an .env hint never reports an invalid variable) and the values are
        // read only to classify what has to move to the private layer: no
        // value-derived text and no value itself is ever returned.
        const parsed = parseEnv(content);
        const usable = Object.keys(parsed).filter((key) => key.length <= MAX_ENV_KEY_CHARS && SERVICE_KEY_PATTERN.test(key));
        const rows = usable.slice(0, MAX_ENV_ROWS).map((key) => ({ key, value: parsed[key] ?? "" }));
        hints.push({ source, name: source, runType: null, runTypeBasis: "配置文件本身不是运行单元", runTypeUncertain: false,
          variables: variablesFor(rows, source), program: "", args: [], invalidVars: [],
          toVerify: ["仅提取变量键名；语法及业务读取点、生效优先级和 URL 覆盖规则需人工核对", "仅显示变量来源与遮蔽值；值本身不进入草案，也不写入共享模板",
            ...valueRefusalNotes(rows),
            ...(usable.length > MAX_ENV_ROWS ? ["环境变量列表已截断，请人工核对"] : [])] });
      } else if (source === "package.json" || source.endsWith("launch.json")) {
        const parseErrors: ParseError[] = [];
        const data = parseJsonc(content, parseErrors, { allowTrailingComma: source.endsWith("launch.json"), disallowComments: source === "package.json" }) as unknown;
        if (parseErrors.length || !object(data)) throw Error("JSON 配置格式无效");
        if (source === "package.json") {
          if (!object(data["scripts"])) throw Error("未找到 scripts 对象");
          for (const [name, command] of Object.entries(data["scripts"])) {
            if (typeof command === "string") add(source, name, command);
          }
        } else {
          const configs = data["configurations"];
          if (!Array.isArray(configs)) throw Error("未找到 configurations 数组");
          for (const config of configs) {
            if (!object(config) || typeof config["name"] !== "string") continue;
            const command = [config["program"], ...(Array.isArray(config["args"]) ? config["args"] : [])].filter((part): part is string => typeof part === "string").join(" ");
            add(source, config["name"], command, config["env"], config["cwd"]);
          }
        }
      } else {
        const doc = parseDocument(content, { uniqueKeys: true });
        if (doc.errors.length) throw Error("Compose YAML 格式无效");
        const data = doc.toJS({ maxAliasCount: 0 }) as unknown;
        if (!object(data) || !object(data["services"])) throw Error("未找到 services 对象");
        for (const [name, raw] of Object.entries(data["services"])) {
          if (!object(raw)) continue;
          const command = typeof raw["command"] === "string" ? raw["command"] : Array.isArray(raw["command"]) ? raw["command"].filter((part): part is string => typeof part === "string").join(" ") : "";
          add(source, name, command, raw["environment"], raw["working_dir"]);
        }
      }
    } catch (error) {
      const reason = error instanceof Error && [
        "配置文件是符号链接，需要人工核对", "配置文件不在所选仓库内",
        "配置文件不是受限大小的普通文件", "配置文件在读取前被替换或超限", "JSON 配置格式无效",
        "未找到 scripts 对象", "未找到 configurations 数组",
        "Compose YAML 格式无效", "未找到 services 对象",
      ].includes(error.message) ? error.message : "配置读取失败";
      errors.push({ source, reason });
    }
  }
  return { hints, errors, truncated };
}
