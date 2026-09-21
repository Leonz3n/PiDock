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
  resolved: { key: string; value: string; source: string; secret: boolean }[];
};

export type Repository = { id: string; name: string; baseBranch: string };

export type Task = {
  id: string;
  projectId: string;
  name: string;
  workspaceKey: string;
  type: TaskType;
  environmentId: string;
  repos: string[];
  directories: string[];
  archived: boolean;
  permission: Permission;
  services: Service[];
  sessions: Session[];
  activeSessionId: string;
  unread: number;
  cleanupAvailableAt?: string;
};

export type Project = {
  id: string;
  name: string;
  repositories: Repository[];
  directories: string[];
  taskIds: string[];
};

export type Environment = {
  id: string;
  projectId: string;
  name: string;
  templateVersion: string;
  variables: { key: string; value: string; secret: boolean; source: string }[];
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
