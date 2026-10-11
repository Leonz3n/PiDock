import { serviceWorkdirFromMain } from "./serviceTemplateRules";

/**
 * The one value form an import draft carries ([PiDock 04] #7 box 3), mirroring
 * the Host's `SERVICE_VALUE_MASK`: the page shows a variable's source and this
 * mask, never a value read out of the repository.
 */
export const SERVICE_VALUE_MASK = "••••••••";

export interface ServiceImportVariableView {
  key: string;
  /** The scanned file or mechanism this key came from. */
  source: string;
  /** Always the mask: an imported variable never brings a value into the page. */
  maskedValue: string;
}

export interface ServiceImportHintView {
  source: string;
  name: string;
  runType: "long-lived" | "one-shot" | "prepare" | null;
  /** The signal behind `runType`, shown beside the label so the guess is reviewable. */
  runTypeBasis: string;
  /** True when nothing in the source identifies the run type: the page asks, it never guesses. */
  runTypeUncertain: boolean;
  variables: ServiceImportVariableView[];
  /**
   * Redacted command candidate the scanner extracted (`program` empty when it
   * was dropped or the source carries no command) plus a repo-relative working
   * directory when the source names one. A hint only fills the form; it never
   * saves, creates or binds anything.
   */
  program: string;
  args: string[];
  workdir?: string;
  invalidVars: string[];
  toVerify: string[];
}

export interface ServiceImportScanView {
  hints: ServiceImportHintView[];
  errors: { source: string; reason: string }[];
  truncated: boolean;
}

const sources = new Set(["package.json", ".vscode/launch.json", "compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml", ".env"]);
const runTypes = new Set(["long-lived", "one-shot", "prepare"]);
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const shortText = (value: unknown, max = 100): value is string => typeof value === "string" && value.length <= max;
const shortTexts = (value: unknown, maxEntries: number): value is string[] =>
  Array.isArray(value) && value.length <= maxEntries && value.every((entry) => shortText(entry));

/**
 * Variables with their provenance and a masked value. Any row that claims a
 * source other than the one this hint was scanned from, repeats a key, or
 * carries anything but the mask makes the whole reply untrusted: a value that
 * arrived unmasked must never be rendered as if the Host had masked it.
 */
function variablesFromHost(value: unknown, source: string): ServiceImportVariableView[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const rows: ServiceImportVariableView[] = [];
  for (const raw of value) {
    const row = record(raw);
    if (!row || Object.keys(row).sort().join(",") !== "key,maskedValue,source" ||
        typeof row["key"] !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row["key"]) || row["key"].length > 100 ||
        row["source"] !== source || row["maskedValue"] !== SERVICE_VALUE_MASK) return null;
    rows.push({ key: row["key"], source, maskedValue: SERVICE_VALUE_MASK });
  }
  if (new Set(rows.map((row) => row.key)).size !== rows.length) return null;
  return rows;
}

/** A malformed Host reply must never be rendered as an empty or successful scan. */
export function serviceImportScanFromHost(payload: unknown): ServiceImportScanView | null {
  const scan = record(record(payload)?.["scan"]);
  if (!scan || !Array.isArray(scan["hints"]) || scan["hints"].length > 100 ||
      !Array.isArray(scan["errors"]) || scan["errors"].length > sources.size || typeof scan["truncated"] !== "boolean") return null;
  const hints: ServiceImportHintView[] = [];
  for (const raw of scan["hints"]) {
    const hint = record(raw);
    if (!hint || !shortText(hint["source"]) || !sources.has(hint["source"]) || !shortText(hint["name"]) ||
        !shortText(hint["runTypeBasis"]) || typeof hint["runTypeUncertain"] !== "boolean" ||
        !shortTexts(hint["invalidVars"], 100) || !shortTexts(hint["toVerify"], 32) ||
        !shortText(hint["program"], 200) || !shortTexts(hint["args"], 40)) return null;
    const variables = variablesFromHost(hint["variables"], hint["source"] as string);
    if (variables === null) return null;
    let workdir: string | undefined;
    if (hint["workdir"] !== undefined) {
      const parsed = serviceWorkdirFromMain(hint["workdir"]);
      if (parsed === null) return null;
      workdir = parsed;
    }
    if (hint["source"] === ".env") {
      if (hint["runType"] !== null || hint["runTypeUncertain"] !== false || hint["name"] !== ".env" ||
          hint["invalidVars"].length || hint["program"] !== "" ||
          (hint["args"] as string[]).length || workdir !== undefined) return null;
    } else if (!shortText(hint["runType"]) || !runTypes.has(hint["runType"])) return null;
    hints.push({ source: hint["source"], name: hint["name"], runType: hint["runType"] as ServiceImportHintView["runType"],
      runTypeBasis: hint["runTypeBasis"], runTypeUncertain: hint["runTypeUncertain"], variables,
      program: hint["program"], args: [...hint["args"]], ...(workdir === undefined ? {} : { workdir }),
      invalidVars: hint["invalidVars"], toVerify: hint["toVerify"] });
  }
  const errors: ServiceImportScanView["errors"] = [];
  for (const raw of scan["errors"]) {
    const error = record(raw);
    if (!error || !shortText(error["source"]) || !sources.has(error["source"]) || !shortText(error["reason"])) return null;
    errors.push({ source: error["source"], reason: error["reason"] });
  }
  return { hints, errors, truncated: scan["truncated"] };
}
