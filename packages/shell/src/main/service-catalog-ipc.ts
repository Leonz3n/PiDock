import type { ServiceBindingAdoption, ServiceCatalog, ServiceEnvironment, ServiceTaskBinding, ServiceTemplate, ServiceTemplateUpdateReview } from "./service-catalog.js";
import { TrustDomainViolation } from "./trust-domain.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function shape(value: unknown, names: string[]): Record<string, unknown> {
  if (!record(value) || Object.keys(value).sort().join(",") !== names.sort().join(",")) {
    throw new TrustDomainViolation("invalid-payload", "invalid service catalog request");
  }
  return value;
}

/**
 * The environment dimension's own refusals - `environment unavailable`, a
 * duplicate name, a document that predates the environment dimension - are the
 * page's only honest explanation, so they reach it NAMED (the store's own
 * message) instead of the generic "save or read failed" wording that the
 * surrounding IPC branch uses for an unexpected store failure. A trust-domain
 * shape violation keeps its own spelling.
 */
function namedEnvironmentRefusal<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    if (error instanceof TrustDomainViolation) throw error;
    throw new TrustDomainViolation("invalid-payload", error instanceof Error ? error.message : String(error));
  }
}

export interface ServiceTemplateProjection {
  projectId: string;
  /** Environment this revision belongs to: a revision is only meaningful inside one. */
  environmentId: string;
  serviceId: string;
  version: number;
  descriptor: ServiceTemplate["descriptor"];
  /** Shared rows, not just keys: the editor prefills from them and main still owns the write. */
  shared: { key: string; value: string }[];
}
function projection(row: ServiceTemplate): ServiceTemplateProjection {
  return { projectId: row.projectId, environmentId: row.environmentId, serviceId: row.serviceId, version: row.version,
    descriptor: row.descriptor, shared: row.shared.map((entry) => ({ key: entry.key, value: entry.value })) };
}

/**
 * One named, project-scoped environment as a page may see it. The page can name
 * it and select it; the values a launch uses stay in main's own store.
 */
export interface ServiceEnvironmentProjection {
  projectId: string;
  environmentId: string;
  name: string;
}
function environmentProjection(row: ServiceEnvironment): ServiceEnvironmentProjection {
  return { projectId: row.projectId, environmentId: row.environmentId, name: row.name };
}

export interface ServiceBindingProjection {
  taskId: string;
  serviceId: string;
  /** Environment this task selected for this service (main's own read, not page-supplied). */
  environmentId: string;
  /** The environment's name at read time, so a page names it instead of guessing. */
  environmentName: string;
  templateVersion: number;
  rootId: string;
  subdir: string;
  privateKeys: string[];
}
function bindingProjection(row: ServiceTaskBinding, environment: ServiceEnvironment): ServiceBindingProjection {
  return { taskId: row.taskId, serviceId: row.serviceId, environmentId: row.environmentId, environmentName: environment.name,
    templateVersion: row.templateVersion, rootId: row.rootId, subdir: row.subdir, privateKeys: row.privateRefs.map((ref) => ref.key) };
}

/** Picker-based binding is separate from synchronous template operations. */
export async function performServiceBindingOperation(
  store: Pick<ServiceCatalog, "taskBindings" | "prepareTaskBinding" | "commitTaskBinding">,
  request: unknown, pickProgram: () => Promise<string | null>, requireLiveSender: () => void,
): Promise<ServiceBindingProjection[] | { cancelled: boolean; binding?: ServiceBindingProjection }> {
  if (!record(request) || Buffer.byteLength(JSON.stringify(request)) > 16_384) {
    throw new TrustDomainViolation("invalid-payload", "invalid service binding request");
  }
  requireLiveSender();
  if (request["op"] === "taskBindings") {
    const input = shape(request, ["op", "projectId", "taskId"]);
    if (typeof input["projectId"] !== "string" || typeof input["taskId"] !== "string") throw new Error("invalid binding identity");
    return store.taskBindings(input["projectId"], input["taskId"]).map((row) => bindingProjection(row.binding, row.environment));
  }
  const input = shape(request, ["op", "projectId", "environmentId", "taskId", "serviceId", "templateVersion", "rootId", "subdir", "privateRefs"]);
  if (input["op"] !== "bind" || typeof input["projectId"] !== "string" || typeof input["taskId"] !== "string" ||
      typeof input["environmentId"] !== "string" || typeof input["serviceId"] !== "string" || typeof input["rootId"] !== "string" ||
      typeof input["subdir"] !== "string" || !Number.isSafeInteger(input["templateVersion"]) || !Array.isArray(input["privateRefs"])) {
    throw new Error("invalid binding request");
  }
  const prepared = store.prepareTaskBinding(input["projectId"], {
    taskId: input["taskId"], serviceId: input["serviceId"], environmentId: input["environmentId"],
    templateVersion: input["templateVersion"] as number, rootId: input["rootId"], subdir: input["subdir"], privateRefs: input["privateRefs"],
  });
  const selected = await pickProgram();
  requireLiveSender();
  if (selected === null) return { cancelled: true };
  const written = store.commitTaskBinding(prepared, selected);
  // The projection is main's own read-back of what it just wrote: the confirmed
  // binding must still name the same environment and version, so a page can
  // never render a binding main did not write.
  const fresh = store.taskBindings(input["projectId"], input["taskId"])
    .find((row) => row.binding.serviceId === written.serviceId);
  if (!fresh || fresh.binding.environmentId !== written.environmentId ||
      fresh.binding.templateVersion !== written.templateVersion || fresh.binding.rootId !== written.rootId) {
    throw new TrustDomainViolation("invalid-payload", "service binding could not be confirmed");
  }
  return { cancelled: false, binding: bindingProjection(fresh.binding, fresh.environment) };
}

export function performServiceConfigPreview(
  store: Pick<ServiceCatalog, "previewSavedConfig">, request: unknown, env: Record<string, string | undefined>,
) {
  const input = shape(request, ["op", "projectId", "taskId", "serviceId"]);
  if (input["op"] !== "previewConfig" || typeof input["projectId"] !== "string" || typeof input["taskId"] !== "string" ||
      typeof input["serviceId"] !== "string" || Buffer.byteLength(JSON.stringify(input)) > 1024) {
    throw new TrustDomainViolation("invalid-payload", "invalid service config preview");
  }
  return store.previewSavedConfig(input["projectId"], input["taskId"], input["serviceId"], env);
}

/**
 * One start/stop request for a task-bound service ([PiDock 04] #7). Main
 * resolves the trusted catalog launch itself; the page names only the
 * project, task and service, so it can never supply a program, cwd or value.
 */
export interface ServiceRunRequest {
  taskId: string;
  projectId: string;
  serviceId: string;
  action: "start" | "stop";
}

export function parseServiceRunRequest(request: unknown): ServiceRunRequest {
  if (!record(request) || Buffer.byteLength(JSON.stringify(request)) > 4096) {
    throw new TrustDomainViolation("invalid-payload", "invalid service run request");
  }
  const input = shape(request, ["op", "projectId", "taskId", "serviceId", "action"]);
  if (input["op"] !== "runTaskService" || typeof input["projectId"] !== "string" || typeof input["taskId"] !== "string" ||
      typeof input["serviceId"] !== "string" || (input["action"] !== "start" && input["action"] !== "stop")) {
    throw new TrustDomainViolation("invalid-payload", "invalid service run request");
  }
  return { taskId: input["taskId"], projectId: input["projectId"], serviceId: input["serviceId"], action: input["action"] };
}

/**
 * One group start for a task's planned run units ([PiDock 05] #10 box 4), the
 * production caller `task/controlService {group:true}` never had.
 *
 * The accepted keys are exactly `{op,projectId,taskId}` - there is deliberately
 * no `serviceId`, no `units` and no plan of any kind. Which services form the
 * task's group is decided by MAIN from the trusted persisted catalog (the same
 * direction as `runTaskService`), so a page can neither select units nor supply
 * a launch, a cwd or a value; a payload carrying plan content is refused by
 * name instead of being ignored.
 */
export interface ServiceRunGroupRequest {
  taskId: string;
  projectId: string;
}

const SERVICE_RUN_GROUP_KEYS = ["op", "projectId", "taskId"] as const;

/** Key-exact: any extra key (a plan, a unit list, a program, a value) is a named refusal. */
export function parseServiceRunGroupRequest(request: unknown): ServiceRunGroupRequest {
  if (!record(request) || Buffer.byteLength(JSON.stringify(request)) > 4096) {
    throw new TrustDomainViolation("invalid-payload", "invalid service group run request");
  }
  if (Object.keys(request).sort().join(",") !== [...SERVICE_RUN_GROUP_KEYS].sort().join(",")) {
    throw new TrustDomainViolation(
      "invalid-payload",
      `invalid service group run request: 只接受 ${SERVICE_RUN_GROUP_KEYS.join("/")}（运行单元由主进程按可信服务目录决定，页面不能提供计划）`,
    );
  }
  const input = request as Record<string, unknown>;
  if (
    input["op"] !== "runTaskServiceGroup" ||
    typeof input["projectId"] !== "string" ||
    typeof input["taskId"] !== "string" ||
    input["taskId"].length === 0
  ) {
    throw new TrustDomainViolation("invalid-payload", "invalid service group run request");
  }
  return { taskId: input["taskId"], projectId: input["projectId"] };
}

/**
 * One explicit re-bind of a task's service owner ([PiDock 04] #7 slice): the
 * human asks main to restore the task's start/stop channel after a write moved
 * the task's owner snapshot (a shared-template adoption, a binding change or a
 * project re-association). Main resolves the task and its bindings itself; the
 * page names only the project, the task and whether it confirms.
 */
export interface ServiceOwnerRebindRequest {
  taskId: string;
  projectId: string;
  confirm: boolean;
}

/** Same key-exact, bounded discipline as the sibling catalog requests: identity and a confirmation flag, never a path. */
export function parseServiceOwnerRebindRequest(request: unknown): ServiceOwnerRebindRequest {
  if (!record(request) || Buffer.byteLength(JSON.stringify(request)) > 4096) {
    throw new TrustDomainViolation("invalid-payload", "invalid service owner rebind request");
  }
  const input = shape(request, ["op", "projectId", "taskId", "confirm"]);
  if (input["op"] !== "rebindServiceOwner" || typeof input["projectId"] !== "string" ||
      typeof input["taskId"] !== "string" || input["taskId"].length === 0 || typeof input["confirm"] !== "boolean") {
    throw new TrustDomainViolation("invalid-payload", "invalid service owner rebind request");
  }
  return { taskId: input["taskId"], projectId: input["projectId"], confirm: input["confirm"] };
}

/** One binding adoption as main reviews and writes it: identity, the moved pin and the restart-needed consequence. */
export interface ServiceBindingAdoptionProjection {
  taskId: string;
  serviceId: string;
  /** The binding's own environment: an adoption never moves a task across environments. */
  environmentId: string;
  from: number;
  to: number;
  adopted: boolean;
  restartNeeded: { taskId: string; serviceId: string; name: string; from: number; to: number }[];
}
function adoptionProjection(row: ServiceBindingAdoption): ServiceBindingAdoptionProjection {
  return { taskId: row.taskId, serviceId: row.serviceId, environmentId: row.environmentId, from: row.from, to: row.to, adopted: row.adopted,
    restartNeeded: row.restartNeeded.map((entry) => ({ ...entry })) };
}

/** A shell-only, project-scoped human editing surface. No execution ops. `update` reviews one edit and only writes it when the page confirms; `adoptBinding` re-pins one existing binding to an existing revision the same two-step way, and starts or stops nothing. */
export function performServiceCatalogOperation(
  store: Pick<ServiceCatalog, "listEnvironments" | "createEnvironment" | "listTemplates" | "saveTemplate" | "reviewTemplateUpdate" | "reviewTaskBindingAdoption" | "adoptTaskBinding">, request: unknown,
): ServiceEnvironmentProjection[] | ServiceEnvironmentProjection | ServiceTemplateProjection[] | ServiceTemplateProjection | ServiceTemplateUpdateReview | ServiceBindingAdoptionProjection {
  if (!record(request) || typeof request["op"] !== "string") {
    throw new TrustDomainViolation("invalid-payload", "invalid service catalog request");
  }
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body) > 16_384) throw new TrustDomainViolation("invalid-payload", "service catalog request too large");
  // [PiDock 04] (#7 box 1) the named, project-scoped environments. `list` is
  // what the page selects from and `create` mints one; both are inert data and
  // a refusal is NAMED (the store's own message reaches the page) instead of
  // being flattened into "save failed", so a duplicate name is actionable.
  if (request["op"] === "listEnvironments") {
    const input = shape(request, ["op", "projectId"]);
    const project = input["projectId"];
    if (typeof project !== "string") throw new TrustDomainViolation("invalid-payload", "invalid project ID");
    return namedEnvironmentRefusal(() => store.listEnvironments(project)).map(environmentProjection);
  }
  if (request["op"] === "createEnvironment") {
    const input = shape(request, ["op", "projectId", "name"]);
    const project = input["projectId"], name = input["name"];
    if (typeof project !== "string" || typeof name !== "string") {
      throw new TrustDomainViolation("invalid-payload", "invalid environment creation");
    }
    return environmentProjection(namedEnvironmentRefusal(() => store.createEnvironment({ projectId: project, name })));
  }
  if (request["op"] === "list") {
    const input = shape(request, ["op", "projectId", "environmentId"]);
    const project = input["projectId"], environment = input["environmentId"];
    if (typeof project !== "string" || typeof environment !== "string") {
      throw new TrustDomainViolation("invalid-payload", "invalid project or environment ID");
    }
    return namedEnvironmentRefusal(() => store.listTemplates(project, environment)).map(projection);
  }
  if (request["op"] === "create") {
    const input = shape(request, ["op", "projectId", "environmentId", "descriptor", "shared"]);
    const project = input["projectId"], environment = input["environmentId"], descriptor = input["descriptor"], rows = input["shared"];
    if (typeof project !== "string" || typeof environment !== "string" || !record(descriptor) || !Array.isArray(rows)) {
      throw new TrustDomainViolation("invalid-payload", "invalid service template");
    }
    return projection(namedEnvironmentRefusal(() => store.saveTemplate({ projectId: project, environmentId: environment,
      descriptor: descriptor as unknown as ServiceTemplate["descriptor"], shared: rows })));
  }
  if (request["op"] === "update") {
    const input = shape(request, ["op", "projectId", "environmentId", "serviceId", "expectedVersion", "descriptor", "shared", "confirm"]);
    const project = input["projectId"], environment = input["environmentId"], id = input["serviceId"], rows = input["shared"];
    if (typeof project !== "string" || typeof environment !== "string" || typeof id !== "string" ||
        !Number.isSafeInteger(input["expectedVersion"]) || (input["expectedVersion"] as number) < 1 ||
        !record(input["descriptor"]) || !Array.isArray(rows) || typeof input["confirm"] !== "boolean") {
      throw new TrustDomainViolation("invalid-payload", "invalid service template update");
    }
    const edit = { projectId: project, environmentId: environment, serviceId: id,
      expectedVersion: input["expectedVersion"] as number,
      descriptor: input["descriptor"] as unknown as ServiceTemplate["descriptor"], shared: rows };
    // The review is the rules layer's answer (row diff, restart candidates) and
    // is always computed before any write; a request that does not confirm
    // stops here and can never be read as a saved revision.
    const review = namedEnvironmentRefusal(() => store.reviewTemplateUpdate(edit));
    if (input["confirm"] !== true) return review;
    const written = namedEnvironmentRefusal(() => store.saveTemplate(edit));
    if (written.serviceId !== review.serviceId || written.version !== review.version || written.environmentId !== review.environmentId) {
      throw new TrustDomainViolation("invalid-payload", "service template update could not be confirmed");
    }
    return { ...review, saved: true };
  }
  if (request["op"] === "adoptBinding") {
    const input = shape(request, ["op", "projectId", "taskId", "serviceId", "templateVersion", "confirm"]);
    if (typeof input["projectId"] !== "string" || typeof input["taskId"] !== "string" || typeof input["serviceId"] !== "string" ||
        !Number.isSafeInteger(input["templateVersion"]) || (input["templateVersion"] as number) < 1 || typeof input["confirm"] !== "boolean") {
      throw new TrustDomainViolation("invalid-payload", "invalid service binding adoption");
    }
    const adoption = { projectId: input["projectId"], taskId: input["taskId"], serviceId: input["serviceId"],
      templateVersion: input["templateVersion"] as number };
    // Same two-step rule as `update`: the review is the rules layer's answer
    // (the moved pin plus the bindings that still need a restart) and is always
    // computed before any write, so a request that does not confirm stops here
    // and can never be read as an adopted binding.
    const review = store.reviewTaskBindingAdoption(adoption);
    if (input["confirm"] !== true) return adoptionProjection(review);
    const written = store.adoptTaskBinding(adoption);
    if (written.taskId !== review.taskId || written.serviceId !== review.serviceId ||
        written.from !== review.from || written.to !== review.to) {
      throw new TrustDomainViolation("invalid-payload", "service binding adoption could not be confirmed");
    }
    return adoptionProjection(written);
  }
  throw new TrustDomainViolation("invalid-payload", "unknown service catalog operation");
}
