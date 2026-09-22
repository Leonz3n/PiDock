export type RunState =
  | "idle"
  | "running"
  | "approval"
  | "failed"
  | "completed"
  | "stopped"
  | "rejected"
  | "expired";

export type Permission = "write" | "read";

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
  kind: "file" | "directory" | "snippet";
  label: string;
  detail: string;
};

export type MessageRole = "user" | "agent" | "system";

export type Message = {
  id: string;
  role: MessageRole;
  text: string;
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

export type Repository = { id: string; name: string; baseBranch: string };

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
};

export type Project = {
  id: string;
  name: string;
  repositories: Repository[];
  directories: ProjectDirectory[];
  taskIds: string[];
};

export type Environment = {
  id: string;
  projectId: string;
  name: string;
  templateVersion: string;
  /** Shared template layer (`shared`). */
  variables: ConfigEntry[];
  /** Machine-private layer (`private`); credentials and paths that never enter the shared template. */
  privateVariables: ConfigEntry[];
};

export type ProviderProfile = {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  models: { id: string; contextWindow: number }[];
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
  status: "enabled" | "disabled" | "update-available";
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
