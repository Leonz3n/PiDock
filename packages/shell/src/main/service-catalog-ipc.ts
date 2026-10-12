import type { ServiceBindingAdoption, ServiceCatalog, ServiceEnvironment, ServiceTaskBinding, ServiceTemplate, ServiceTemplateDependency, ServiceTemplateUpdateReview } from "./service-catalog.js";
import { isServiceTemplateEdit, type ServiceTemplateRequestParams, type ServiceTemplateRequestResult, type ServiceTemplateReview } from "../rpc/service-template-request.js";
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
 * Key-exact shape with ONE documented optional key (the 服务依赖声明). A request
 * that declares nothing omits it - the shape the slice before this one sent - so
 * an absent key and an empty list mean the same thing here: no declaration, and
 * therefore no edge, never a synthesised one.
 */
function shapeWithOptional(value: unknown, names: string[], optional: string): Record<string, unknown> {
  if (!record(value)) throw new TrustDomainViolation("invalid-payload", "invalid service catalog request");
  const keys = Object.keys(value).sort().join(",");
  if (keys !== [...names].sort().join(",") && keys !== [...names, optional].sort().join(",")) {
    throw new TrustDomainViolation("invalid-payload", "invalid service catalog request");
  }
  return value;
}
/**
 * The declaration rows as the page may send them: the target's catalog identity
 * and one of the two kinds, nothing else. The deeper rules (the target really
 * exists in this environment, no self-edge, no duplicate) are the store's own
 * named refusals, so both callers answer identically.
 */
function dependencyRows(value: unknown): ServiceTemplateDependency[] | undefined {
  if (value === undefined) return undefined;
  const wellFormed = Array.isArray(value) && value.length <= 40 && value.every((entry) => record(entry) &&
    Object.keys(entry).sort().join(",") === "kind,to" && typeof entry["to"] === "string" &&
    (entry["kind"] === "call" || entry["kind"] === "prestart"));
  if (!wellFormed) throw new TrustDomainViolation("invalid-payload", "invalid service dependency declaration");
  return (value as Record<string, unknown>[]).map((entry) => ({ to: entry["to"] as string, kind: entry["kind"] as ServiceTemplateDependency["kind"] }));
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
  /** The revision's 服务依赖声明, ABSENT when it declares none: no key, no edge. */
  dependencies?: ServiceTemplateDependency[];
}
function projection(row: ServiceTemplate): ServiceTemplateProjection {
  return { projectId: row.projectId, environmentId: row.environmentId, serviceId: row.serviceId, version: row.version,
    descriptor: row.descriptor, shared: row.shared.map((entry) => ({ key: entry.key, value: entry.value })),
    ...(row.dependencies === undefined ? {} : { dependencies: row.dependencies.map((dependency) => ({ ...dependency })) }) };
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
    const input = shapeWithOptional(request, ["op", "projectId", "environmentId", "descriptor", "shared"], "dependencies");
    const project = input["projectId"], environment = input["environmentId"], descriptor = input["descriptor"], rows = input["shared"];
    if (typeof project !== "string" || typeof environment !== "string" || !record(descriptor) || !Array.isArray(rows)) {
      throw new TrustDomainViolation("invalid-payload", "invalid service template");
    }
    const declared = dependencyRows(input["dependencies"]);
    return projection(namedEnvironmentRefusal(() => store.saveTemplate({ projectId: project, environmentId: environment,
      descriptor: descriptor as unknown as ServiceTemplate["descriptor"], shared: rows,
      ...(declared === undefined ? {} : { dependencies: declared }) })));
  }
  if (request["op"] === "update") {
    const input = shapeWithOptional(request, ["op", "projectId", "environmentId", "serviceId", "expectedVersion", "descriptor", "shared", "confirm"], "dependencies");
    const project = input["projectId"], environment = input["environmentId"], id = input["serviceId"], rows = input["shared"];
    if (typeof project !== "string" || typeof environment !== "string" || typeof id !== "string" ||
        !Number.isSafeInteger(input["expectedVersion"]) || (input["expectedVersion"] as number) < 1 ||
        !record(input["descriptor"]) || !Array.isArray(rows) || typeof input["confirm"] !== "boolean") {
      throw new TrustDomainViolation("invalid-payload", "invalid service template update");
    }
    const declared = dependencyRows(input["dependencies"]);
    const edit = { projectId: project, environmentId: environment, serviceId: id,
      expectedVersion: input["expectedVersion"] as number,
      descriptor: input["descriptor"] as unknown as ServiceTemplate["descriptor"], shared: rows,
      ...(declared === undefined ? {} : { dependencies: declared }) };
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

/**
 * [PiDock 04] (#7 box 6) the Agent's half of 「Agent 修改共享模板生成差异确认」: the
 * SAME two-step as the page's `update` branch above, with the three facts the
 * Agent must not name derived from the addressed task's OWN binding pin instead
 * of being supplied:
 *
 * - the project and the environment come from the binding that owns `serviceId`
 *   (`store.listTask`), so an edit cannot retarget another project's or another
 *   environment's revision space, and a task that has not bound the service is
 *   refused BY NAME with nothing read or written;
 * - `expectedVersion` is the binding's own pinned version, so a template that
 *   moved since the pin (someone edited it first) is the named
 *   `template-version-conflict` refusal - never a silent overwrite of the newer
 *   revision;
 * - the descriptor, the shared rows and the optional 服务依赖声明 are the edit
 *   content: they are the only page-independent inputs.
 *
 * `confirm:false` returns the review and writes NOTHING; the confirming call
 * writes through the identical store API the page path uses (`reviewTemplateUpdate`
 * -> `saveTemplate`) and cross-checks that the written revision is the reviewed
 * one. Main stays the only writer of the template document.
 */
export function performTaskBoundTemplateEdit(
  store: Pick<ServiceCatalog, "listTask" | "reviewTemplateUpdate" | "saveTemplate">,
  input: {
    taskId: string;
    serviceId: string;
    descriptor: ServiceTemplate["descriptor"];
    shared: ServiceTemplate["shared"];
    dependencies?: ServiceTemplateDependency[];
    confirm: boolean;
  },
): ServiceTemplateReview {
  const bound = store.listTask(input.taskId).find((row) => row.binding.serviceId === input.serviceId);
  if (!bound) throw new Error(`unknown-service: ${input.serviceId} 不是本任务绑定的服务`);
  const pinnedVersion = bound.binding.templateVersion;
  const edit = { projectId: bound.binding.projectId, environmentId: bound.binding.environmentId, serviceId: input.serviceId,
    expectedVersion: pinnedVersion, descriptor: input.descriptor, shared: input.shared,
    ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies }) };
  const review = templateEditCall(() => store.reviewTemplateUpdate(edit), pinnedVersion);
  if (!input.confirm) return templateReviewProjection(review, pinnedVersion);
  const written = templateEditCall(() => store.saveTemplate(edit), pinnedVersion);
  if (written.serviceId !== review.serviceId || written.version !== review.version || written.environmentId !== review.environmentId) {
    throw new Error("invalid-payload: 共享模板写入结果与复核不一致，未确认");
  }
  return templateReviewProjection({ ...review, saved: true }, pinnedVersion);
}

/**
 * One store call whose refusal is named for the Host: the store's own version
 * conflict gets its own code (it is the one refusal the Agent path can hit by
 * itself), every other store refusal keeps the store's message under a
 * `invalid-payload:` code. Nothing is written on any of these paths.
 */
function templateEditCall<T>(call: () => T, pinnedVersion: number): T {
  try {
    return call();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (reason === "template version conflict") {
      throw new Error(`template-version-conflict: 本任务的绑定钉在 v${pinnedVersion}，共享模板已不是该版本（未写入任何内容，请重新发起调用）`);
    }
    throw new Error(`invalid-payload: ${reason}`);
  }
}

function templateReviewProjection(review: ServiceTemplateUpdateReview, pinnedVersion: number): ServiceTemplateReview {
  return { serviceId: review.serviceId, pinnedVersion, version: review.version, versionLabel: review.versionLabel, saved: review.saved,
    descriptorChanged: review.descriptorChanged, dependenciesChanged: review.dependenciesChanged, contentChanged: review.contentChanged,
    diff: { added: [...review.diff.added], changed: review.diff.changed.map((row) => ({ ...row })), removed: [...review.diff.removed] },
    restartNeeded: review.restartNeeded.map((row) => ({ ...row })) };
}

/** Every refusal the Host reads carries a code token, so the tool can name it. */
function namedTemplateRefusal(reason: string): string {
  return /^[a-z][a-z0-9-]{1,63}: /.test(reason) ? reason : `template-unavailable: ${reason}`;
}

/**
 * The main half of the Host -> main shared-template request
 * (`rpc/service-template-request.ts`). Main binds this handler to the child it
 * actually forked, so `taskId` here is main's own fact and the payload's task id
 * is only checked against it: a request naming another task is refused by name
 * and reaches no store call.
 *
 * Each operation derives the binding pin for THIS call, so an `apply` never
 * treats the earlier review's answer as the write's authority: a template that
 * moved between the review and the confirmation fails closed by name instead of
 * overwriting the newer revision.
 */
export function createServiceTemplateHandler(
  store: Pick<ServiceCatalog, "listTask" | "reviewTemplateUpdate" | "saveTemplate">,
  taskId: string,
): (request: ServiceTemplateRequestParams) => Promise<ServiceTemplateRequestResult> {
  return async (request) => {
    if (request.taskId !== taskId) {
      return { ok: false, error: `task-identity-mismatch: 共享模板请求的任务与子进程绑定不一致（${request.taskId}）` };
    }
    if (!isServiceTemplateEdit(request.edit)) {
      return { ok: false, error: "invalid-payload: 共享模板编辑只能有 serviceId、descriptor、shared 与可选 dependencies" };
    }
    try {
      return { ok: true, payload: performTaskBoundTemplateEdit(store, {
        taskId,
        serviceId: request.edit.serviceId,
        descriptor: request.edit.descriptor as ServiceTemplate["descriptor"],
        shared: request.edit.shared as ServiceTemplate["shared"],
        ...(request.edit.dependencies === undefined ? {} : { dependencies: request.edit.dependencies as ServiceTemplateDependency[] }),
        confirm: request.op === "apply",
      }) };
    } catch (error) {
      return { ok: false, error: namedTemplateRefusal(error instanceof Error ? error.message : String(error)) };
    }
  };
}
