/**
 * Host -> main shared-template request ([PiDock 04] #7 box 6).
 *
 * The Agent's tool broker runs in the task Host, which holds catalog-DERIVED
 * facts (the owner snapshot: project, per-service pinned version) and not the
 * catalog store: the shared template document, its environments, its task
 * bindings and the write authority all live in main (`main/service-catalog.ts`),
 * and the Host may not even read an application-private path
 * (`main/protected-application-path.ts`). So an Agent edit of the SHARED template
 * is a request to main - the same direction as the browser capabilities of
 * [PiDock 06] #8 - and main stays the only writer.
 *
 * The request names what the Agent may name and nothing else: a serviceId this
 * task has bound plus the edit content (`descriptor`, the full `shared` rows and
 * the optional 服务依赖声明). The project, the environment and the expected
 * version are derived by MAIN from the addressed task's OWN binding pin, and the
 * task identity is the Host's fork binding (validated against the child main
 * actually forked), never a payload field. Two operations:
 *
 * - `review` computes the real row-level diff from the persisted document and
 *   writes NOTHING;
 * - `apply` re-derives the same pin and writes through the existing two-step
 *   (`reviewTemplateUpdate` -> `saveTemplate`), failing closed by name when the
 *   document moved since the review.
 *
 * The envelope is key-exact and size-bounded so a smuggled `projectId`,
 * `environmentId`, `expectedVersion` or path is a refusal, not a hint.
 */

/** Same bound as the sibling catalog write request the shell page sends. */
export const MAX_SERVICE_TEMPLATE_EDIT_BYTES = 16_384;
export const MAX_SERVICE_TEMPLATE_SHARED_ROWS = 80;
export const MAX_SERVICE_TEMPLATE_DEPENDENCIES = 40;
const MAX_ENVELOPE_ID_CHARS = 80;
const MAX_IDENTITY_CHARS = 128;
const SERVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** What the Agent may name: a bound service and the edit content, nothing else. */
export interface ServiceTemplateEditContent {
  serviceId: string;
  descriptor: unknown;
  shared: unknown;
  dependencies?: unknown;
}

/** One row-level value change, `before` -> `after`, as the user confirms it. */
export interface ServiceTemplateRowChange {
  key: string;
  before: string;
  after: string;
}

/**
 * The reviewed (and, once written, saved) revision of one shared template as the
 * Host reads it. `pinnedVersion` is the task's own pin the edit was derived
 * against; `version` is the version a confirmed save mints. `diff` is computed
 * from the PERSISTED document; `restartNeeded` lists the task bindings that stay
 * on the older version until someone explicitly adopts the new one.
 */
export interface ServiceTemplateReview {
  serviceId: string;
  pinnedVersion: number;
  version: number;
  versionLabel: string;
  saved: boolean;
  descriptorChanged: boolean;
  dependenciesChanged: boolean;
  contentChanged: boolean;
  diff: { added: string[]; changed: ServiceTemplateRowChange[]; removed: string[] };
  restartNeeded: { taskId: string; serviceId: string; name: string; from: number; to: number }[];
}

export type ServiceTemplateEditResult = { ok: true; review: ServiceTemplateReview } | { ok: false; error: string };

/**
 * The port the Agent tool broker consumes. Absent means this Host has no
 * shared-template channel: the tool is then refused BY NAME and nothing is read
 * or written - never a silent no-op and never a local fallback write.
 */
export interface ServiceTemplateEditPort {
  review(edit: ServiceTemplateEditContent): Promise<ServiceTemplateEditResult>;
  apply(edit: ServiceTemplateEditContent): Promise<ServiceTemplateEditResult>;
}

export type ServiceTemplateRequestHandler = (params: ServiceTemplateRequestParams) => Promise<ServiceTemplateRequestResult>;

export interface ServiceTemplateRequestParams {
  workspaceId: string;
  taskId: string;
  op: "review" | "apply";
  edit: ServiceTemplateEditContent;
}

export interface ServiceTemplateRequest {
  kind: "service-template-request";
  id: string;
  params: ServiceTemplateRequestParams;
}

export type ServiceTemplateRequestResult = { ok: true; payload: ServiceTemplateReview } | { ok: false; error: string };

export interface ServiceTemplateResponseOk {
  kind: "service-template-response";
  id: string;
  ok: true;
  payload: ServiceTemplateReview;
}

export interface ServiceTemplateResponseError {
  kind: "service-template-response";
  id: string;
  ok: false;
  error: string;
}

export type ServiceTemplateResponse = ServiceTemplateResponseOk | ServiceTemplateResponseError;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wireBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? MAX_SERVICE_TEMPLATE_EDIT_BYTES + 1;
  } catch {
    return MAX_SERVICE_TEMPLATE_EDIT_BYTES + 1;
  }
}

/**
 * The edit content as both sides accept it: key-exact (a `projectId`,
 * `environmentId`, `expectedVersion`, task id or path is an unknown key and
 * therefore refused), structurally bounded, and inside the same size bound the
 * shell's own template edit page has. The DEEP rules (portable program, no
 * private value in a shared row, a declaration target that exists in the
 * environment) are the store's own named refusals, so both callers answer
 * identically.
 */
export function isServiceTemplateEdit(value: unknown): value is ServiceTemplateEditContent {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "descriptor,serviceId,shared" && keys !== "dependencies,descriptor,serviceId,shared") return false;
  if (typeof value["serviceId"] !== "string" || !SERVICE_ID_PATTERN.test(value["serviceId"] as string)) return false;
  if (!isRecord(value["descriptor"])) return false;
  const shared = value["shared"];
  if (!Array.isArray(shared) || shared.length > MAX_SERVICE_TEMPLATE_SHARED_ROWS || !shared.every((row) => isRecord(row))) return false;
  const dependencies = value["dependencies"];
  if (dependencies !== undefined && (!Array.isArray(dependencies) || dependencies.length > MAX_SERVICE_TEMPLATE_DEPENDENCIES || !dependencies.every((row) => isRecord(row)))) {
    return false;
  }
  return wireBytes(value) <= MAX_SERVICE_TEMPLATE_EDIT_BYTES;
}

/** Fail-closed envelope guard: ids, a known op, the key-exact edit and the size bound. */
export function isServiceTemplateRequest(value: unknown): value is ServiceTemplateRequest {
  if (!isRecord(value) || value["kind"] !== "service-template-request") return false;
  if (Object.keys(value).sort().join(",") !== "id,kind,params") return false;
  const id = value["id"];
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ENVELOPE_ID_CHARS) return false;
  const params = value["params"];
  if (!isRecord(params) || Object.keys(params).sort().join(",") !== "edit,op,taskId,workspaceId") return false;
  for (const key of ["workspaceId", "taskId"] as const) {
    const field = params[key];
    if (typeof field !== "string" || field.length === 0 || field.length > MAX_IDENTITY_CHARS) return false;
  }
  if (params["op"] !== "review" && params["op"] !== "apply") return false;
  return isServiceTemplateEdit(params["edit"]);
}

export function isServiceTemplateResponse(value: unknown): value is ServiceTemplateResponse {
  if (!isRecord(value) || value["kind"] !== "service-template-response") return false;
  if (typeof value["id"] !== "string" || value["id"].length === 0) return false;
  const keys = Object.keys(value).sort().join(",");
  if (value["ok"] === true) return keys === "id,kind,ok,payload" && isServiceTemplateReview(value["payload"]);
  if (value["ok"] === false) return keys === "error,id,kind,ok" && typeof value["error"] === "string" && value["error"].length > 0;
  return false;
}

/** A response payload is only read when it really is a review of the shared template. */
export function isServiceTemplateReview(value: unknown): value is ServiceTemplateReview {
  if (!isRecord(value)) return false;
  const required = ["contentChanged", "dependenciesChanged", "descriptorChanged", "diff", "pinnedVersion", "restartNeeded", "saved", "serviceId", "version", "versionLabel"];
  if (Object.keys(value).sort().join(",") !== required.sort().join(",")) return false;
  if (typeof value["serviceId"] !== "string" || typeof value["versionLabel"] !== "string" || typeof value["saved"] !== "boolean") return false;
  for (const key of ["pinnedVersion", "version"] as const) if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 1) return false;
  for (const key of ["contentChanged", "descriptorChanged", "dependenciesChanged"] as const) if (typeof value[key] !== "boolean") return false;
  const diff = value["diff"];
  if (!isRecord(diff) || !Array.isArray(diff["added"]) || !Array.isArray(diff["removed"]) || !Array.isArray(diff["changed"])) return false;
  if (!(diff["added"] as unknown[]).every((row) => typeof row === "string") || !(diff["removed"] as unknown[]).every((row) => typeof row === "string")) return false;
  if (!(diff["changed"] as unknown[]).every((row) => isRecord(row) && typeof row["key"] === "string" && typeof row["before"] === "string" && typeof row["after"] === "string")) return false;
  return (value["restartNeeded"] as unknown[]).every((row) => isRecord(row) && typeof row["taskId"] === "string" && typeof row["serviceId"] === "string" &&
    typeof row["name"] === "string" && Number.isSafeInteger(row["from"]) && Number.isSafeInteger(row["to"]));
}

/** Minimal post surface the utilityProcess Host has (`process.parentPort`). */
export interface ServiceTemplateTransport {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): void;
  removeListener?(event: "message", listener: (message: unknown) => void): void;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Host -> main client for the shared-template request: one request per call,
 * correlated by id, and every other parent-port message is ignored (main's RPC
 * replies, the browser pair, the owner protocol and the SDK turn events share
 * the same port). A stopped or unbound main answers with a named error instead
 * of hanging the tool call.
 */
export class ServiceTemplateRequestClient implements ServiceTemplateEditPort {
  private readonly pending = new Map<string, { resolve: (value: ServiceTemplateEditResult) => void; timer: NodeJS.Timeout }>();
  private sequence = 0;
  private readonly onMessage = (message: unknown): void => { this.handleMessage(message); };

  constructor(
    private readonly transport: ServiceTemplateTransport,
    private readonly workspaceId: string,
    private readonly taskId: string,
    private readonly options: { timeoutMs?: number } = {},
  ) {
    if (workspaceId.trim().length === 0 || taskId.trim().length === 0) throw new Error("workspaceId and taskId must be non-empty");
    this.transport.on("message", this.onMessage);
  }

  review(edit: ServiceTemplateEditContent): Promise<ServiceTemplateEditResult> {
    return this.send("review", edit);
  }

  apply(edit: ServiceTemplateEditContent): Promise<ServiceTemplateEditResult> {
    return this.send("apply", edit);
  }

  dispose(): void {
    if (typeof this.transport.removeListener === "function") this.transport.removeListener("message", this.onMessage);
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error: "template-unavailable: 共享模板通道已关闭" });
      this.pending.delete(id);
    }
  }

  private send(op: "review" | "apply", edit: ServiceTemplateEditContent): Promise<ServiceTemplateEditResult> {
    const id = `template-${++this.sequence}`;
    const request: ServiceTemplateRequest = { kind: "service-template-request", id, params: { workspaceId: this.workspaceId, taskId: this.taskId, op, edit } };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `template-timeout: 主进程未在 ${this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms 内完成共享模板操作` });
      }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      try {
        this.transport.postMessage(request);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: "template-unavailable: 主进程连接已关闭" });
      }
    });
  }

  private handleMessage(message: unknown): void {
    if (!isServiceTemplateResponse(message)) return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    entry.resolve(message.ok ? { ok: true, review: message.payload } : { ok: false, error: message.error });
  }
}
