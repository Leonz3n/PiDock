import {
  serviceWorkdirFromMain,
  type ServiceHealthKind,
  type ServiceRunType,
} from "./serviceTemplateRules";

/** One shared row of a stored revision. Main keeps the layer credential-free (`secret: false`, no credential-looking key, no credential/path-looking value) and fails closed, so a shared row is a human-typed literal, not a secret. */
export interface ServiceTemplateSharedRow {
  key: string;
  value: string;
}

export interface ServiceTemplateView {
  projectId: string;
  serviceId: string;
  version: number;
  descriptor: {
    name: string;
    program: string;
    args: string[];
    ports: number[];
    runType: ServiceRunType;
    healthCheck?: { kind: ServiceHealthKind; target?: string };
    /** Repo-relative working directory default; the task binding's own work directory is what a launch resolves. */
    workdir?: string;
  };
  shared: ServiceTemplateSharedRow[];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ServiceBindingView {
  taskId: string;
  serviceId: string;
  templateVersion: number;
  rootId: string;
  subdir: string;
  privateKeys: string[];
}
export function serviceBindingsFromMain(value: unknown, taskId: string): ServiceBindingView[] | null {
  if (!Array.isArray(value) || value.length > 500) return null;
  const result: ServiceBindingView[] = [];
  for (const row of value) {
    if (!object(row) || Object.keys(row).sort().join(",") !== "privateKeys,rootId,serviceId,subdir,taskId,templateVersion" ||
        row["taskId"] !== taskId || typeof row["serviceId"] !== "string" || !/^s-[0-9a-f-]{36}$/i.test(row["serviceId"]) ||
        !Number.isSafeInteger(row["templateVersion"]) || (row["templateVersion"] as number) < 1 ||
        typeof row["rootId"] !== "string" || typeof row["subdir"] !== "string" || !Array.isArray(row["privateKeys"]) ||
        row["privateKeys"].some((key) => typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) return null;
    result.push({ taskId, serviceId: row["serviceId"], templateVersion: row["templateVersion"] as number,
      rootId: row["rootId"], subdir: row["subdir"], privateKeys: [...row["privateKeys"]] as string[] });
  }
  return new Set(result.map((row) => row.serviceId)).size === result.length ? result : null;
}

function descriptorFromMain(value: unknown): ServiceTemplateView["descriptor"] | null {
  if (!object(value)) return null;
  const keys = Object.keys(value);
  if (!["name", "program", "args", "ports", "runType"].every((key) => keys.includes(key)) ||
      keys.some((key) => !["name", "program", "args", "ports", "runType", "healthCheck", "workdir"].includes(key))) return null;
  const name = value["name"];
  const program = value["program"];
  const args = value["args"];
  const ports = value["ports"];
  if (typeof name !== "string" || !name || typeof program !== "string" || !program || !Array.isArray(args) ||
      args.some((arg) => typeof arg !== "string") || !Array.isArray(ports) ||
      ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535) ||
      !["long-lived", "prepare", "one-shot"].includes(value["runType"] as string)) return null;
  let healthCheck: ServiceTemplateView["descriptor"]["healthCheck"];
  if (value["healthCheck"] !== undefined) {
    const health = value["healthCheck"];
    if (!object(health) || Object.keys(health).sort().join(",") !== (health["target"] === undefined ? "kind" : "kind,target") ||
        !["http", "tcp", "grpc"].includes(health["kind"] as string) ||
        (health["target"] !== undefined && (typeof health["target"] !== "string" || health["target"].length > 512))) return null;
    healthCheck = { kind: health["kind"] as ServiceHealthKind, ...(health["target"] === undefined ? {} : { target: health["target"] as string }) };
  }
  let workdir: string | undefined;
  if (value["workdir"] !== undefined) {
    const parsed = serviceWorkdirFromMain(value["workdir"]);
    if (parsed === null) return null;
    workdir = parsed;
  }
  return { name, program, args: [...args] as string[], ports: [...ports] as number[], runType: value["runType"] as ServiceRunType,
    ...(healthCheck === undefined ? {} : { healthCheck }), ...(workdir === undefined ? {} : { workdir }) };
}

function sharedFromMain(value: unknown): ServiceTemplateSharedRow[] | null {
  if (!Array.isArray(value) || value.length > 80) return null;
  const rows: ServiceTemplateSharedRow[] = [];
  for (const entry of value) {
    if (!object(entry) || Object.keys(entry).sort().join(",") !== "key,value" ||
        typeof entry["key"] !== "string" || typeof entry["value"] !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry["key"]) || entry["value"].length > 2048) return null;
    rows.push({ key: entry["key"], value: entry["value"] });
  }
  return new Set(rows.map((row) => row.key)).size === rows.length ? rows : null;
}

/**
 * Public projection only: machine paths, program paths, reference names and
 * reference values do not enter the page model. Shared rows do, because main
 * stores them fail-closed (credential-free keys and values, no machine path)
 * and the editor has to prefill an existing revision to edit it.
 */
export function serviceTemplatesFromMain(value: unknown, projectId: string): ServiceTemplateView[] | null {
  if (!Array.isArray(value) || value.length > 500) return null;
  const result: ServiceTemplateView[] = [];
  for (const entry of value) {
    if (!object(entry) || Object.keys(entry).sort().join(",") !== "descriptor,projectId,serviceId,shared,version" ||
        entry["projectId"] !== projectId || typeof entry["serviceId"] !== "string" ||
        !/^s-[0-9a-f-]{36}$/i.test(entry["serviceId"]) || !Number.isSafeInteger(entry["version"]) || (entry["version"] as number) < 1) return null;
    const descriptor = descriptorFromMain(entry["descriptor"]);
    const shared = sharedFromMain(entry["shared"]);
    if (!descriptor || !shared) return null;
    result.push({ projectId, serviceId: entry["serviceId"], version: entry["version"] as number, descriptor, shared });
  }
  if (new Set(result.map((row) => row.serviceId)).size !== result.length) return null;
  return result;
}

/** One pinned task binding whose service must be restarted before the new template takes effect. */
export interface ServiceTemplateRestartRow {
  taskId: string;
  serviceId: string;
  name: string;
  from: number;
  to: number;
}

export interface ServiceTemplateUpdateReviewView {
  projectId: string;
  serviceId: string;
  version: number;
  versionLabel: string;
  /** False for a review, true only once main reports the revision written. */
  saved: boolean;
  descriptorChanged: boolean;
  diff: { added: string[]; changed: { key: string; before: string; after: string }[]; removed: string[] };
  restartNeeded: ServiceTemplateRestartRow[];
}

function textList(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((entry) => typeof entry === "string");
}

/**
 * Strict parse of main's `{op:"update"}` answer. A review (`saved:false`) and a
 * written revision (`saved:true`) share one shape, so the page can never read a
 * review as a completed save; a mismatched identity, version or confirmation
 * fails closed instead of rendering a partial result.
 */
export function serviceTemplateUpdateFromMain(
  value: unknown, expected: { projectId: string; serviceId: string; version: number },
): ServiceTemplateUpdateReviewView | null {
  if (!object(value) || Object.keys(value).sort().join(",") !==
      "descriptorChanged,diff,projectId,restartNeeded,saved,serviceId,version,versionLabel") return null;
  if (value["projectId"] !== expected.projectId || value["serviceId"] !== expected.serviceId ||
      value["version"] !== expected.version || typeof value["versionLabel"] !== "string" ||
      !/^v[1-9][0-9]*$/.test(value["versionLabel"]) || typeof value["saved"] !== "boolean" ||
      typeof value["descriptorChanged"] !== "boolean") return null;
  const diff = value["diff"];
  if (!object(diff) || Object.keys(diff).sort().join(",") !== "added,changed,removed" ||
      !textList(diff["added"], 80) || !textList(diff["removed"], 80) || !Array.isArray(diff["changed"]) || diff["changed"].length > 80) return null;
  const changed: { key: string; before: string; after: string }[] = [];
  for (const entry of diff["changed"]) {
    if (!object(entry) || Object.keys(entry).sort().join(",") !== "after,before,key" ||
        typeof entry["key"] !== "string" || typeof entry["before"] !== "string" || typeof entry["after"] !== "string") return null;
    changed.push({ key: entry["key"], before: entry["before"], after: entry["after"] });
  }
  const restartNeeded = value["restartNeeded"];
  if (!Array.isArray(restartNeeded) || restartNeeded.length > 500) return null;
  const restarts: ServiceTemplateRestartRow[] = [];
  for (const entry of restartNeeded) {
    if (!object(entry) || Object.keys(entry).sort().join(",") !== "from,name,serviceId,taskId,to" ||
        typeof entry["taskId"] !== "string" || entry["serviceId"] !== expected.serviceId || typeof entry["name"] !== "string" ||
        !Number.isSafeInteger(entry["from"]) || !Number.isSafeInteger(entry["to"]) ||
        (entry["from"] as number) < 1 || entry["to"] !== expected.version) return null;
    restarts.push({ taskId: entry["taskId"], serviceId: expected.serviceId, name: entry["name"],
      from: entry["from"] as number, to: entry["to"] as number });
  }
  return { projectId: expected.projectId, serviceId: expected.serviceId, version: expected.version,
    versionLabel: value["versionLabel"], saved: value["saved"], descriptorChanged: value["descriptorChanged"],
    diff: { added: [...diff["added"]], changed, removed: [...diff["removed"]] }, restartNeeded: restarts };
}

/** Shared rows as main stores them: the shared layer is fail-closed on secrets, so `secret` is always false. */
export function sharedRowsForCatalog(rows: readonly ServiceTemplateSharedRow[]): { key: string; value: string; secret: false }[] {
  return rows.map((row) => ({ key: row.key.trim(), value: row.value, secret: false }));
}
