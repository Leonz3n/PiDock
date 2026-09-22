export type TrustDomain = "shell" | "task";

export type TrustViolationCode =
  | "duplicate-web-contents"
  | "unknown-sender"
  | "wrong-domain"
  | "non-main-frame"
  | "invalid-payload"
  | "payload-workspace-mismatch"
  | "task-identity-mismatch";

export class TrustDomainViolation extends Error {
  constructor(
    readonly code: TrustViolationCode,
    message: string,
  ) {
    super(message);
    this.name = "TrustDomainViolation";
  }
}

interface ShellBinding {
  domain: "shell";
  webContentsId: number;
  viewId: string;
  workspaceId: string;
}

interface TaskBinding {
  domain: "task";
  webContentsId: number;
  viewId: string;
  workspaceId: string;
  taskId: string;
  pageId: string;
}

export type TrustBinding = ShellBinding | TaskBinding;

interface SenderIdentity {
  sender: {
    id: number;
    mainFrame: { processId: number; routingId: number };
  };
  senderFrame: { processId: number; routingId: number } | null;
}

export interface ExpectedTaskIdentity {
  taskId: string;
  pageId: string;
}

export type ShellInvokeMethod =
  | "shell/getVersions"
  | "shell/hostPing"
  | "shell/taskOp";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TrustDomainViolation(
      "invalid-payload",
      `${label} must be a non-empty string`,
    );
  }
}

/**
 * Main-process authority for WebContents identity. Renderers never choose
 * their task/page binding: main registers the actual WebContents ids after
 * creating the trusted views and resolves every IPC sender through this map.
 */
export class TrustDomainRegistry {
  private readonly bindings = new Map<number, TrustBinding>();

  registerShell(binding: Omit<ShellBinding, "domain">): void {
    this.register({ domain: "shell", ...binding });
  }

  registerTask(binding: Omit<TaskBinding, "domain">): void {
    this.register({ domain: "task", ...binding });
  }

  unregister(webContentsId: number): void {
    this.bindings.delete(webContentsId);
  }

  get(webContentsId: number): TrustBinding | undefined {
    return this.bindings.get(webContentsId);
  }

  requireShellSender(event: SenderIdentity): ShellBinding {
    const binding = this.bindings.get(event.sender.id);
    if (!binding) {
      throw new TrustDomainViolation(
        "unknown-sender",
        `unknown WebContents sender: ${event.sender.id}`,
      );
    }
    if (binding.domain !== "shell") {
      throw new TrustDomainViolation(
        "wrong-domain",
        `sender is not in the shell trust domain: ${event.sender.id}`,
      );
    }
    if (
      event.senderFrame === null ||
      event.senderFrame.processId !== event.sender.mainFrame.processId ||
      event.senderFrame.routingId !== event.sender.mainFrame.routingId
    ) {
      throw new TrustDomainViolation(
        "non-main-frame",
        `IPC sender is not the main frame: ${event.sender.id}`,
      );
    }
    return binding;
  }

  requireTaskBinding(
    webContentsId: number,
    expected?: ExpectedTaskIdentity,
  ): TaskBinding {
    const binding = this.bindings.get(webContentsId);
    if (!binding) {
      throw new TrustDomainViolation(
        "unknown-sender",
        `unknown WebContents task binding: ${webContentsId}`,
      );
    }
    if (binding.domain !== "task") {
      throw new TrustDomainViolation(
        "wrong-domain",
        `WebContents is not in the task trust domain: ${webContentsId}`,
      );
    }
    if (
      expected &&
      (binding.taskId !== expected.taskId || binding.pageId !== expected.pageId)
    ) {
      throw new TrustDomainViolation(
        "task-identity-mismatch",
        `task/page identity mismatch for WebContents ${webContentsId}`,
      );
    }
    return binding;
  }

  private register(binding: TrustBinding): void {
    requireNonEmpty(binding.viewId, "viewId");
    requireNonEmpty(binding.workspaceId, "workspaceId");
    if (binding.domain === "task") {
      requireNonEmpty(binding.taskId, "taskId");
      requireNonEmpty(binding.pageId, "pageId");
    }
    if (this.bindings.has(binding.webContentsId)) {
      throw new TrustDomainViolation(
        "duplicate-web-contents",
        `WebContents ${binding.webContentsId} already has a trust binding`,
      );
    }
    this.bindings.set(binding.webContentsId, binding);
  }
}

/**
 * Validate the renderer payload against the workspace resolved from the
 * actual sender. A renderer can repeat its own workspace id, but can never
 * select or widen it.
 */
export function validateShellInvocationPayload(
  method: ShellInvokeMethod,
  payload: unknown,
  senderWorkspaceId: string,
): { workspaceId: string } {
  if (method === "shell/getVersions") {
    if (payload !== undefined) {
      throw new TrustDomainViolation(
        "invalid-payload",
        "shell/getVersions does not accept a payload",
      );
    }
    return { workspaceId: senderWorkspaceId };
  }

  if (method === "shell/taskOp") {
    return validateTaskOpPayload(payload, senderWorkspaceId);
  }

  if (payload === undefined) {
    return { workspaceId: senderWorkspaceId };
  }
  if (
    !isRecord(payload) ||
    Object.keys(payload).length !== 1 ||
    !Object.hasOwn(payload, "workspaceId") ||
    typeof payload["workspaceId"] !== "string" ||
    payload["workspaceId"].length === 0
  ) {
    throw new TrustDomainViolation(
      "invalid-payload",
      "invalid shell/hostPing payload",
    );
  }
  if (payload["workspaceId"] !== senderWorkspaceId) {
    throw new TrustDomainViolation(
      "payload-workspace-mismatch",
      "payload workspace does not match sender binding",
    );
  }
  return { workspaceId: senderWorkspaceId };
}

/**
 * Renderer task-op payload: the task id selects the task, but the workspace
 * still binds to the sender — a renderer can name its own task, never
 * another workspace's. Unknown ops are rejected fail-closed.
 */
function validateTaskOpPayload(
  payload: unknown,
  senderWorkspaceId: string,
): { workspaceId: string } {
  if (!isRecord(payload)) {
    throw new TrustDomainViolation("invalid-payload", "invalid shell/taskOp payload");
  }
  const taskId = payload["taskId"];
  const op = payload["op"];
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new TrustDomainViolation("invalid-payload", "shell/taskOp requires a taskId");
  }
  if (
    typeof op !== "string" ||
    !["task/provision", "task/appendRepos", "task/probeLink", "task/sendMessage", "task/cancel", "task/approve", "task/reject", "task/saveDraft", "task/clearDraft", "task/setPermission", "task/listApprovals", "task/getApproval", "task/registerService", "task/planServiceStart", "task/controlService", "task/serviceStatus", "task/serviceLog"].includes(op)
  ) {
    throw new TrustDomainViolation("invalid-payload", `unknown task op: ${String(op)}`);
  }
  const workspaceId = payload["workspaceId"];
  if (workspaceId !== undefined && workspaceId !== senderWorkspaceId) {
    throw new TrustDomainViolation(
      "payload-workspace-mismatch",
      "payload workspace does not match sender binding",
    );
  }
  return { workspaceId: senderWorkspaceId };
}
