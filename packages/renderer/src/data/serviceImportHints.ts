import { serviceWorkdirFromMain } from "./serviceTemplateRules";

export interface ServiceImportHintView {
  source: string;
  name: string;
  runType: "long-lived" | "one-shot" | "prepare" | null;
  envKeys: string[];
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

/** A malformed Host reply must never be rendered as an empty or successful scan. */
export function serviceImportScanFromHost(payload: unknown): ServiceImportScanView | null {
  const scan = record(record(payload)?.["scan"]);
  if (!scan || !Array.isArray(scan["hints"]) || scan["hints"].length > 100 ||
      !Array.isArray(scan["errors"]) || scan["errors"].length > sources.size || typeof scan["truncated"] !== "boolean") return null;
  const hints: ServiceImportHintView[] = [];
  for (const raw of scan["hints"]) {
    const hint = record(raw);
    if (!hint || !shortText(hint["source"]) || !sources.has(hint["source"]) || !shortText(hint["name"]) ||
        !shortTexts(hint["envKeys"], 100) || !shortTexts(hint["invalidVars"], 100) || !shortTexts(hint["toVerify"], 32) ||
        !shortText(hint["program"], 200) || !shortTexts(hint["args"], 40)) return null;
    let workdir: string | undefined;
    if (hint["workdir"] !== undefined) {
      const parsed = serviceWorkdirFromMain(hint["workdir"]);
      if (parsed === null) return null;
      workdir = parsed;
    }
    if (hint["source"] === ".env") {
      if (hint["runType"] !== null || hint["name"] !== ".env" || hint["invalidVars"].length || hint["program"] !== "" ||
          (hint["args"] as string[]).length || workdir !== undefined ||
          !hint["envKeys"].every((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) return null;
    } else if (!shortText(hint["runType"]) || !runTypes.has(hint["runType"])) return null;
    hints.push({ source: hint["source"], name: hint["name"], runType: hint["runType"] as ServiceImportHintView["runType"],
      envKeys: hint["envKeys"], program: hint["program"], args: [...hint["args"]], ...(workdir === undefined ? {} : { workdir }),
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
