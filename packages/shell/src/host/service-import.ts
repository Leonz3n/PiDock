import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parseDocument } from "yaml";
import { classifyImportDraft, auditImportVars, type ServiceRunType } from "../main/service-config.js";
import type { WorkspaceRoot } from "../main/workspace-files.js";

export interface ServiceImportHint {
  source: string;
  name: string;
  runType: ServiceRunType;
  /** Keys only. The scanner never returns env values or executable commands. */
  envKeys: string[];
  invalidVars: string[];
  toVerify: string[];
}

export interface ServiceImportScan {
  hints: ServiceImportHint[];
  errors: { source: string; reason: string }[];
}

const SOURCES = ["package.json", ".vscode/launch.json", "compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"] as const;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_HINTS = 100;
const MAX_ENV_ROWS = 100;
const MAX_ENV_KEY_CHARS = 100;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const display = (value: string) => value.slice(0, 100);

function readSource(root: string, source: string): string | null {
  const path = join(root, source);
  if (!existsSync(path)) return null;
  if (lstatSync(path).isSymbolicLink()) throw Error("配置文件是符号链接，需要人工核对");
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

function envAudit(value: unknown) {
  const entries = object(value) ? Object.entries(value) : Array.isArray(value)
    ? value.filter((row): row is string => typeof row === "string").map((row) => {
      const separator = row.indexOf("=");
      return separator < 0 ? [row, ""] as const : [row.slice(0, separator), row.slice(separator + 1)] as const;
    }) : [];
  const rows = entries.slice(0, MAX_ENV_ROWS).map(([key, raw]) => ({
    key: key.slice(0, MAX_ENV_KEY_CHARS),
    value: typeof raw === "string" ? raw : object(raw) && typeof raw["value"] === "string" ? raw["value"] : "",
  }));
  const audit = auditImportVars(rows, { sharedDraft: true });
  return { envKeys: rows.map((row) => row.key), invalidVars: audit.invalidVars.map(display),
    toVerify: [...audit.toVerify.map(display), ...(entries.length > MAX_ENV_ROWS ? ["环境变量列表已截断，请人工核对"] : [])] };
}

export function scanTaskServiceImportHints(input: { taskDir: string; roots: readonly WorkspaceRoot[] }, rootId: string): ServiceImportScan {
  const selected = input.roots.find((root) => root.id === rootId);
  if (!selected || selected.kind !== "worktree") throw Error("unknown-worktree: 请选择当前任务的仓库工作副本");
  const taskRoot = realpathSync(input.taskDir);
  const repoRoot = realpathSync(selected.path);
  const inside = relative(taskRoot, repoRoot);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`)) throw Error("path-out-of-scope: 仓库工作副本不在任务根内");
  return scanServiceImportHints(repoRoot);
}

/** Read fixed, bounded repo config files into non-executable, value-free import hints. */
export function scanServiceImportHints(repoRoot: string): ServiceImportScan {
  const root = realpathSync(repoRoot);
  if (!statSync(root).isDirectory()) throw Error("所选仓库不是目录");
  const hints: ServiceImportHint[] = [];
  const errors: ServiceImportScan["errors"] = [];
  const add = (source: string, name: string, command: string, env?: unknown) => {
    if (hints.length >= MAX_HINTS) return;
    const audit = envAudit(env);
    hints.push({ source, name: display(name), runType: classifyImportDraft({ name, command: `${name} ${command}`, origin: "unknown" }).runType,
      ...audit, toVerify: [...audit.toVerify, "启动命令、参数及工作目录需人工核对；草案不可直接运行"] });
  };
  for (const source of SOURCES) {
    try {
      const content = readSource(root, source);
      if (content === null) continue;
      if (source === "package.json" || source.endsWith("launch.json")) {
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
            add(source, config["name"], command, config["env"]);
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
          add(source, name, command, raw["environment"]);
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
  return { hints, errors };
}
