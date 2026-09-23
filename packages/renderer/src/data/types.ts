/**
 * How current a session's context occupancy is ([PiDock 11] #9). Only
 * `actual`/`estimated` may be compared against a model limit; `pending` means
 * the value is being recomputed (e.g. right after a compaction) and `unknown`
 * that there is no usable value — neither is treated as a zero pass.
 */
export type ContextSource = "actual" | "estimated" | "pending" | "unknown";

/** One recorded provider/model switch; history keeps its own per-call attribution. */
export type ModelSwitchEvent = {
  at: string;
  from: { providerId: string; model: string } | null;
  to: { providerId: string; model: string };
  reason: "human-switch" | "agent-switch";
  /** Stale reasoning preference dropped by the switch, when any. */
  droppedThinking?: string;
};

export type RunState =
  | "idle"
  | "running"
  | "approval"
  | "failed"
  | "completed"
  | "stopped"
  | "rejected"
  | "expired";

/**
 * Session permission tier, mirroring the prototype's `permissionModes`
 * (`permissions.js`): 只读 / 默认权限 / 自动执行. `read` is the read-only tier
 * that gates edits, commands and browsers; `default` asks before side effects;
 * `auto` runs task-scoped reads/writes/commands without per-action prompts.
 */
export type Permission = "read" | "default" | "auto";

/** How a model exposes reasoning levels (prototype's thinking mode). */
export type ThinkingMode = "auto" | "none" | "custom";

export type ModelThinking = {
  mode: ThinkingMode;
  /** Selectable levels when `mode === "custom"`; empty means follow the catalog. */
  levels: string[];
  /** Default level; the session may override it. */
  default: string;
};

export type ServiceMode = "local" | "remote";

/** Configuration scope, mirroring the prototype's `task` / `shared` / `private` tabs. */
export type ConfigScope = "shared" | "private" | "task";

/** A KEY/VALUE pair. Sensitive values are marked `secret` and masked when displayed. */
export type ConfigEntry = { key: string; value: string; secret: boolean };

/** A resolved config row that still reports which layer it came from. */
export type ResolvedConfigEntry = ConfigEntry & { source: string };

/** A project-level ordinary directory. Stable `id`, display `name`, absolute `path`. */
export type ProjectDirectory = { id: string; name: string; path: string };

/** A directory snapshot captured in a task; `linkName` is the in-task symlink name. */
export type TaskDirectory = ProjectDirectory & { linkName: string };

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type TaskType = "normal" | "scheduled";

export type Reference = {
  id: string;
  kind: "file" | "directory" | "snippet" | "attachment" | "skill";
  label: string;
  detail: string;
  /** In-memory preview URL for a pasted/selected image attachment; never uploaded. */
  previewUrl?: string;
};

export type MessageRole = "user" | "agent" | "system";

export type Message = {
  id: string;
  role: MessageRole;
  text: string;
  /**
   * Provider/model that produced this response. Stamped when the turn settles
   * so a later rename/disable/removal still resolves the original account
   * (or reports it unavailable) instead of re-attributing old text.
   */
  attribution?: { providerId: string; model: string };
  streaming?: boolean;
  references?: Reference[];
  code?: { language: string; source: string; label: string };
};

export type Approval = {
  id: string;
  taskId: string;
  sessionId: string;
  title: string;
  command: string;
  cwd: string;
  impact: string;
  payloadVersion: string;
  status: ApprovalStatus;
  executed: boolean;
  requestedAt: string;
  expiresAt: string;
  recipient?: string;
};

export type RunRecord = {
  id: string;
  taskId: string;
  sessionId: string;
  state: RunState;
  startedAt: string;
  summary: string;
  failedScope?: string;
  steps: { label: string; state: "done" | "failed" | "pending" | "skipped" }[];
};

export type Session = {
  id: string;
  name: string;
  archived: boolean;
  permission: Permission;
  providerId: string;
  model: string;
  contextUsed: number;
  contextWindow: number;
  tokens: number;
  runState: RunState;
  unread: number;
  lastActivity: string;
  messages: Message[];
  /** Session-scoped reasoning level override; falls back to the model default. */
  thinking?: string;
  /** How current `contextUsed` is; absent = `actual` for the seeded demo data. */
  contextSource?: ContextSource;
  /** Recorded provider/model switches of this session. */
  switchEvents?: ModelSwitchEvent[];
};

export type Service = {
  id: string;
  name: string;
  repo?: string;
  port?: number;
  mode: ServiceMode;
  running: boolean;
  configSource: string;
  templateVersion: string;
  resolved: ResolvedConfigEntry[];
};

export type Repository = {
  id: string;
  name: string;
  baseBranch: string;
  /** Machine-local checkout path; the prototype keeps this in local settings. */
  localPath?: string;
};

/** Files surfaced by the task file panel; the preview travels with the mock data. */
export type WorkspaceFile = {
  path: string;
  status: "modified" | "added" | "deleted";
  preview?: { language: string; source: string };
};

/** Pages the built-in browser panel can show for a task. */
export type BrowserPage = { id: string; title: string; url: string };

/** Local application settings; never part of a project shared template. */
export type LocalSettings = {
  configDir: string;
  configFile: string;
  workspaceRoot: string;
};

export type Task = {
  id: string;
  projectId: string;
  name: string;
  workspaceKey: string;
  /** Task root the task was created under; used to derive in-task symlink paths. */
  workspaceRoot: string;
  type: TaskType;
  environmentId: string;
  /** Environment template version this task adopted; new shared versions do not migrate it. */
  templateVersion: string;
  repos: string[];
  directories: TaskDirectory[];
  /** Task-scope config overrides (the third config layer). */
  configOverrides: ConfigEntry[];
  archived: boolean;
  permission: Permission;
  services: Service[];
  sessions: Session[];
  activeSessionId: string;
  unread: number;
  files: WorkspaceFile[];
  browserPages: BrowserPage[];
  terminalSeed: string[];
  cleanupAvailableAt?: string;
  /** Illustrative child-agent records keyed by session id; view-only. */
  subagentsBySession?: Record<string, Subagent[]>;
};

export type Project = {
  id: string;
  name: string;
  description: string;
  repositories: Repository[];
  directories: ProjectDirectory[];
  taskIds: string[];
};

export type Environment = {
  id: string;
  projectId: string;
  name: string;
  description: string;
  templateVersion: string;
  /** Shared template layer (`shared`). */
  variables: ConfigEntry[];
  /** Machine-private layer (`private`); credentials and paths that never enter the shared template. */
  privateVariables: ConfigEntry[];
  /** In-memory service startup recipes shown on the environment page. */
  recipes: ServiceRecipe[];
};

/**
 * A service startup recipe maintained on an environment. The prototype's
 * `environmentEditor()` card (name, repo, runtime, start note) is editable in
 * memory; the real repository scan / config write / process start stay out of
 * scope and are labelled so on the page.
 */
export type ServiceRecipe = {
  id: string;
  name: string;
  repo?: string;
  /** e.g. `Node.js` / `Go`, matching the prototype's card metadata. */
  runtime: string;
  /** e.g. `使用项目脚本启动` / `读取仓库默认 config.yaml`. */
  startNote: string;
  /** 运行类型: 常驻服务 / 准备步骤 / 一次性命令 (prototype `recipeDialog`). */
  runType: string;
  /** 健康检查: gRPC health / HTTP / TCP (prototype `recipeDialog`). */
  healthCheck: string;
  /** 依赖地址绑定说明, e.g. `INVOICE_SERVICE_ENDPOINT → invoice-service`. */
  dependencyBinding: string;
};

/**
 * Where a model's context-window number came from: the provider's model
 * directory, the editor default, or the user's hand-typed value. Absent means
 * the value was hand-typed (older rows).
 */
export type ContextWindowSource = "catalog" | "default" | "manual";

export type ProviderModel = {
  id: string;
  /** Display name; absent means the model ID is shown (prototype's default-follow behaviour). */
  name?: string;
  contextWindow: number;
  /** Provenance of `contextWindow`; absent means `manual`. */
  contextWindowSource?: ContextWindowSource;
  /** Max output in the same unit as `contextWindow`; absent means undeclared. */
  maxOutput?: number;
  /** Declares image input support; the composer refuses image sends otherwise. */
  supportsImages?: boolean;
  /** Optional reasoning configuration; absent means the catalog is unknown. */
  thinking?: ModelThinking;
};

export type ProviderProfile = {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  /**
   * Name of the entry in the machine-private configuration (env key / keychain
   * label). A reference only — a literal credential is rejected and never
   * stored, displayed or logged.
   */
  authRef?: string;
  enabled: boolean;
  models: ProviderModel[];
};

/** Availability of the provider/model a session, schedule or history call names. */
export type ProviderAvailability = "available" | "disabled" | "missing" | "model-unavailable";

/** A locatable provider problem: code + the field to show it at. */
export type ProviderIssue = { code: string; field: string; message: string };

/** Renderer-facing status of one provider (availability + auth presence + issues). */
export type ProviderStatusView = {
  availability: ProviderAvailability;
  availabilityMessage?: string;
  /** Whether an auth reference is configured — never its value. */
  auth: "reference" | "none";
  issues: ProviderIssue[];
};

/** Outcome of one 「同步模型列表」 attempt. */
export type ProviderDiscoveryView = {
  status: "success" | "empty" | "failure" | "unsupported";
  candidates: string[];
  message: string;
  /** Connection this attempt ran against; a changed connection invalidates the set. */
  fingerprint: string;
  ignored: number;
};

export type UsageRecord = {
  id: string;
  taskId: string;
  projectId: string;
  sessionId: string;
  providerId: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  at: string;
};

export type ScheduleTemplate = {
  id: string;
  name: string;
  rule: string;
  prompt: string;
};

export type Schedule = {
  id: string;
  taskId: string;
  name: string;
  rule: string;
  timezone: string;
  prompt: string;
  providerId: string;
  model: string;
  permission: Permission;
  enabled: boolean;
  nextRun: string;
};

export type ScheduledRun = {
  id: string;
  scheduleId: string;
  taskId: string;
  sessionId: string;
  at: string;
  result: "completed" | "skipped" | "failed";
};

export type Capability = {
  id: string;
  kind: "skill" | "extension" | "package" | "mcp";
  name: string;
  source: string;
  scope: string;
  /** `pending-review` mirrors the prototype's 待审阅: added but not yet enabled. */
  status: "enabled" | "disabled" | "update-available" | "pending-review";
};

export type SubagentEvent =
  | { kind: "message"; role: string; time: string; text: string }
  | { kind: "tool"; name: string; time: string; command: string; output: string };

/** Read-only illustrative child-agent record (the prototype never launches real agents). */
export type Subagent = {
  id: string;
  name: string;
  status: "running" | "completed" | "waiting" | "failed" | "stopped";
  summary: string;
  assignment: string;
  model: string;
  provider: string;
  started: string;
  mode: string;
  events: SubagentEvent[];
  result?: string;
};

export type RemoteDevice = {
  id: string;
  name: string;
  pairedAt: string;
  lastSeen: string;
  permissions: string[];
  status: "active" | "revoked";
};

export type CleanupItem = {
  resource: string;
  action: string;
  detail: string;
};

export type AttentionItem = {
  id: string;
  kind: "approval" | "failed" | "expired" | "completed-unread";
  projectId: string;
  taskId: string;
  sessionId: string;
  label: string;
  detail: string;
};

export type Workspace = {
  /** Machine-registered repositories; a project links a subset of these. */
  repositories: Repository[];
  projects: Project[];
  tasks: Task[];
  environments: Environment[];
  providers: ProviderProfile[];
  schedules: Schedule[];
  scheduledRuns: ScheduledRun[];
  capabilities: Capability[];
  devices: RemoteDevice[];
  templates: ScheduleTemplate[];
};

export type HostEvent =
  | { type: "message-delta"; taskId: string; sessionId: string; messageId: string; delta: string }
  | { type: "message-done"; taskId: string; sessionId: string; messageId: string }
  | { type: "run-state"; taskId: string; sessionId: string; state: RunState; record?: RunRecord }
  | { type: "approval"; taskId: string; sessionId: string; approval: Approval }
  | { type: "toast"; text: string };
