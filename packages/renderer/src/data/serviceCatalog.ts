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

/** The honest restart consequence of one shared-template write, computed and observed by main. */
export interface ServiceRestartConsequenceView {
  /** Whether the write changed the launch material of any binding at all. */
  changed: boolean;
  /** A shared-template save or a binding adoption never starts, stops or restarts a process. */
  processRestarted: false;
  /** Task ids whose forked service-control channel this write revoked; empty for a read-only review. */
  fencedTaskIds: string[];
}

function restartConsequenceFromMain(value: unknown): ServiceRestartConsequenceView | null {
  if (!object(value) || Object.keys(value).sort().join(",") !== "changed,fencedTaskIds,processRestarted") return null;
  const ids = value["fencedTaskIds"];
  if (typeof value["changed"] !== "boolean" || value["processRestarted"] !== false ||
      !textList(ids, 500) || new Set(ids).size !== ids.length) return null;
  return { changed: value["changed"], processRestarted: false, fencedTaskIds: [...ids] };
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
  /** True only when the minted revision differs from the current one in any launched field. */
  contentChanged: boolean;
  diff: { added: string[]; changed: { key: string; before: string; after: string }[]; removed: string[] };
  restartNeeded: ServiceTemplateRestartRow[];
  restart: ServiceRestartConsequenceView;
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
      "contentChanged,descriptorChanged,diff,projectId,restart,restartNeeded,saved,serviceId,version,versionLabel") return null;
  if (value["projectId"] !== expected.projectId || value["serviceId"] !== expected.serviceId ||
      value["version"] !== expected.version || typeof value["versionLabel"] !== "string" ||
      !/^v[1-9][0-9]*$/.test(value["versionLabel"]) || typeof value["saved"] !== "boolean" ||
      typeof value["descriptorChanged"] !== "boolean" || typeof value["contentChanged"] !== "boolean") return null;
  const restart = restartConsequenceFromMain(value["restart"]);
  if (!restart) return null;
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
    contentChanged: value["contentChanged"],
    diff: { added: [...diff["added"]], changed, removed: [...diff["removed"]] }, restartNeeded: restarts, restart };
}

/**
 * Strict parse of main's `{op:"adoptBinding"}` answer. A review (`adopted:false`)
 * and a written re-pin (`adopted:true`) share one shape, so the page can never
 * read a review as an adopted binding; a moved identity, a different version
 * pair or a malformed restart row fails closed instead of rendering a partial
 * result.
 */
export function serviceBindingAdoptionFromMain(
  value: unknown, expected: { taskId: string; serviceId: string; from: number; to: number },
): ServiceBindingAdoptionView | null {
  if (!object(value) || Object.keys(value).sort().join(",") !== "adopted,from,restart,restartNeeded,serviceId,taskId,to") return null;
  if (value["taskId"] !== expected.taskId || value["serviceId"] !== expected.serviceId ||
      value["from"] !== expected.from || value["to"] !== expected.to || value["from"] === value["to"] ||
      typeof value["adopted"] !== "boolean") return null;
  const restart = restartConsequenceFromMain(value["restart"]);
  if (!restart) return null;
  const rows = value["restartNeeded"];
  if (!Array.isArray(rows) || rows.length > 500) return null;
  const restarts: ServiceTemplateRestartRow[] = [];
  for (const entry of rows) {
    if (!object(entry) || Object.keys(entry).sort().join(",") !== "from,name,serviceId,taskId,to" ||
        typeof entry["taskId"] !== "string" || entry["serviceId"] !== expected.serviceId || typeof entry["name"] !== "string" ||
        !Number.isSafeInteger(entry["from"]) || (entry["from"] as number) < 1 || entry["from"] === entry["to"] ||
        !Number.isSafeInteger(entry["to"]) || entry["to"] !== expected.to) return null;
    if (restarts.some((row) => row.taskId === entry["taskId"])) return null;
    restarts.push({ taskId: entry["taskId"], serviceId: expected.serviceId, name: entry["name"],
      from: entry["from"] as number, to: entry["to"] as number });
  }
  return { taskId: expected.taskId, serviceId: expected.serviceId, from: expected.from, to: expected.to,
    adopted: value["adopted"], restartNeeded: restarts, restart };
}

/** One explicit re-bind of a task's service owner ([PiDock 04] #7 slice): main's real observation, what it changes and whether the confirmed replacement ran. */
export interface ServiceOwnerRebindView {
  taskId: string;
  projectId: string;
  state: "absent" | "current" | "fenced";
  confirmed: boolean;
  rebound: boolean;
  /** Named services whose resolved owner contract differs between the replaced owner and the catalog now. */
  changes: { serviceId: string; name: string; was: number | null; now: number | null }[];
  /** Copy facts: the re-bind replaces only the ownership binding. */
  stopsProcesses: false;
  restartsProcesses: false;
}

/**
 * Strict parse of main's `{op:"rebindServiceOwner"}` answer. The identity, the
 * three real states and the two copy facts are required, and every change row
 * must name a service on this task, so the page can never render a re-bind main
 * did not report; an unparseable answer leaves the panel on its previous state
 * instead of claiming control came back.
 */
export function serviceOwnerRebindFromMain(value: unknown, expected: { taskId: string; projectId: string }): ServiceOwnerRebindView | null {
  if (!object(value) || Object.keys(value).sort().join(",") !==
      "changes,confirmed,projectId,rebound,restartsProcesses,state,stopsProcesses,taskId") return null;
  if (value["taskId"] !== expected.taskId || value["projectId"] !== expected.projectId ||
      !["absent", "current", "fenced"].includes(value["state"] as string) ||
      typeof value["confirmed"] !== "boolean" || typeof value["rebound"] !== "boolean" ||
      value["stopsProcesses"] !== false || value["restartsProcesses"] !== false ||
      (value["rebound"] === true && value["confirmed"] !== true)) return null;
  const rows = value["changes"];
  if (!Array.isArray(rows) || rows.length > 500) return null;
  const changes: ServiceOwnerRebindView["changes"] = [];
  for (const entry of rows) {
    if (!object(entry) || Object.keys(entry).sort().join(",") !== "name,now,serviceId,was" ||
        typeof entry["serviceId"] !== "string" || !/^s-[0-9a-f-]{36}$/i.test(entry["serviceId"]) ||
        typeof entry["name"] !== "string" || entry["name"].length === 0) return null;
    const version = (item: unknown) => item === null || Number.isSafeInteger(item) && (item as number) >= 1;
    if (!version(entry["was"]) || !version(entry["now"]) || entry["was"] === null && entry["now"] === null ||
        entry["was"] === entry["now"] || changes.some((row) => row.serviceId === entry["serviceId"])) return null;
    changes.push({ serviceId: entry["serviceId"], name: entry["name"],
      was: entry["was"] === null ? null : entry["was"] as number, now: entry["now"] === null ? null : entry["now"] as number });
  }
  return { taskId: expected.taskId, projectId: expected.projectId, state: value["state"] as ServiceOwnerRebindView["state"],
    confirmed: value["confirmed"], rebound: value["rebound"], changes, stopsProcesses: false, restartsProcesses: false };
}

/** One explicit adoption of an existing revision by one task binding: the moved pin plus the bindings that still need an explicit restart. */
export interface ServiceBindingAdoptionView {
  taskId: string;
  serviceId: string;
  from: number;
  to: number;
  adopted: boolean;
  restartNeeded: ServiceTemplateRestartRow[];
  restart: ServiceRestartConsequenceView;
}

/** Shared rows as main stores them: the shared layer is fail-closed on secrets, so `secret` is always false. */
export function sharedRowsForCatalog(rows: readonly ServiceTemplateSharedRow[]): { key: string; value: string; secret: false }[] {
  return rows.map((row) => ({ key: row.key.trim(), value: row.value, secret: false }));
}
