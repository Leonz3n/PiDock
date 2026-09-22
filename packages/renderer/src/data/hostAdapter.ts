import type {
  Approval,
  ApprovalStatus,
  AttentionItem,
  Capability,
  CleanupItem,
  ConfigEntry,
  ConfigScope,
  Environment,
  HostEvent,
  LocalSettings,
  ModelThinking,
  Permission,
  ServiceMode,
  Project,
  ProjectDirectory,
  ProviderProfile,
  RemoteDevice,
  Reference,
  RunRecord,
  Schedule,
  ScheduledRun,
  ServiceRecipe,
  Session,
  Task,
  UsageRecord,
  Workspace,
} from "./types";

export type UsageFilter = {
  taskId?: string;
  projectId?: string;
  providerId?: string;
  sessionId?: string;
  from?: string;
  to?: string;
};

export type SendMessageResult = {
  state: "completed" | "failed" | "approval" | "stopped";
  run: RunRecord;
};

/** One layer of an environment's config, saved through the adapter. */
export type SaveEnvironmentConfigInput = {
  environmentId: string;
  scope: ConfigScope;
  rows: ConfigEntry[];
  /** Required when `scope` is `task`. */
  taskId?: string;
};

/** Upsert a project (name, description, linked repositories, ordinary directories). */
export type SaveProjectInput = {
  id?: string;
  name: string;
  description: string;
  /** Registered repository ids linked to the project. */
  repositoryIds: string[];
  directories: ProjectDirectoryInput[];
};

/** Create or edit an environment (name + description). */
export type SaveEnvironmentInput = {
  id?: string;
  projectId: string;
  name: string;
  description: string;
};

/** Add a capability source; new entries start disabled / pending review. */
export type AddCapabilityInput = {
  kind: "skill" | "extension" | "package" | "mcp";
  name: string;
  source: string;
  scope: string;
};

/** Create or edit a provider profile. */
export type SaveProviderInput = {
  id?: string;
  name: string;
  protocol: string;
  baseUrl: string;
  enabled: boolean;
  models: { id: string; name?: string; contextWindow: number; supportsImages?: boolean; thinking?: ModelThinking }[];
};

/** Edit a scheduled task's cadence, prompt, model and permission. */
export type SaveScheduleInput = {
  id: string;
  name?: string;
  rule: string;
  timezone: string;
  prompt: string;
  providerId: string;
  model: string;
  permission: Permission;
};

/** Add repositories and/or ordinary directories to an existing task. */
export type AddTaskSourcesInput = {
  repoIds: string[];
  directoryIds: string[];
};

/** A project-level ordinary directory entry, as edited in the project dialog. */
export type ProjectDirectoryInput = { id?: string; name: string; path: string };

/** Upsert one in-memory service startup recipe on an environment. */
export type SaveServiceRecipeInput = {
  environmentId: string;
  recipe: {
    id?: string;
    name: string;
    repo?: string;
    runtime: string;
    startNote: string;
    runType: string;
    healthCheck: string;
    dependencyBinding: string;
  };
};

/** In-memory task creation for the draft UI; real worktree preparation belongs to ticket 03. */
export type CreateTaskInput = {
  projectId: string;
  name: string;
  repoIds: string[];
  directoryIds: string[];
  environmentId?: string;
  /** Workspace key previewed in the create-task form; generated when omitted. */
  workspaceKey?: string;
  /** Present when creating a scheduled task (the prototype's scheduled task type). */
  schedule?: {
    rule: string;
    timezone: string;
    prompt: string;
    providerId: string;
    model: string;
    permission: Permission;
  };
};

/**
 * Everything the renderer needs from the Host. Ticket 02 replaces the in-memory
 * implementation with the real Host transport; nothing here may assume a transport.
 */
export interface HostAdapter {
  getWorkspace(): Promise<Workspace>;
  getProject(projectId: string): Promise<Project | undefined>;
  getTask(taskId: string): Promise<Task | undefined>;
  getSession(taskId: string, sessionId: string): Promise<Session | undefined>;
  getRun(taskId: string, sessionId: string): Promise<RunRecord | undefined>;
  getAttention(): Promise<AttentionItem[]>;
  getUsage(filter?: UsageFilter): Promise<UsageRecord[]>;

  sendMessage(
    taskId: string,
    sessionId: string,
    text: string,
    references: Reference[],
  ): Promise<SendMessageResult>;
  stopRun(taskId: string, sessionId: string): Promise<void>;
  createSession(taskId: string): Promise<Session>;
  renameSession(taskId: string, sessionId: string, name: string): Promise<void>;
  renameTask(taskId: string, name: string): Promise<void>;
  setSessionArchived(taskId: string, sessionId: string, archived: boolean): Promise<void>;
  archiveTask(taskId: string): Promise<void>;
  restoreTask(taskId: string): Promise<void>;

  listApprovals(taskId: string): Promise<Approval[]>;
  getApproval(approvalId: string): Promise<Approval | undefined>;
  resolveApproval(approvalId: string, status: ApprovalStatus): Promise<Approval>;
  simulateExpiry(approvalId: string): Promise<Approval>;

  setServiceRunning(taskId: string, serviceId: string, running: boolean): Promise<void>;
  /** Switch a service's dependency target between the local instance and the remote one. */
  setServiceMode(taskId: string, serviceId: string, mode: ServiceMode): Promise<void>;
  getSchedules(): Promise<Schedule[]>;
  setScheduleEnabled(scheduleId: string, enabled: boolean): Promise<void>;
  runScheduleNow(scheduleId: string): Promise<ScheduledRun>;

  getCapabilities(): Promise<Capability[]>;
  setCapabilityEnabled(capabilityId: string, enabled: boolean): Promise<void>;
  getRemoteDevices(): Promise<RemoteDevice[]>;
  revokeRemoteDevice(deviceId: string): Promise<void>;
  previewCleanup(taskId: string): Promise<CleanupItem[]>;

  getLocalSettings(): Promise<LocalSettings>;
  setWorkspaceRoot(workspaceRoot: string): Promise<LocalSettings>;

  /** Replace one config layer. A `shared` save increments the environment template version. */
  saveEnvironmentConfig(input: SaveEnvironmentConfigInput): Promise<void>;
  /** Adopt the environment's current shared-template version on a task that kept an older one. */
  adoptLatestTemplate(taskId: string): Promise<void>;

  /** Create or edit a project; registered repos used by a task stay locked in the UI. */
  saveProject(input: SaveProjectInput): Promise<Project>;
  /** Remove only when the project has no tasks (including archived); never touches disk. */
  deleteProject(projectId: string): Promise<void>;
  /** Create or edit an environment. Editing a name keeps task template versions. */
  saveEnvironment(input: SaveEnvironmentInput): Promise<Environment>;
  /** Remove only when no task references the environment. */
  deleteEnvironment(environmentId: string): Promise<void>;

  /** Add one capability source, saved disabled / pending review and never auto-loaded. */
  addCapability(input: AddCapabilityInput): Promise<Capability>;
  /** Create or edit a provider profile; `removeProvider` deletes one. */
  saveProvider(input: SaveProviderInput): Promise<ProviderProfile>;
  removeProvider(providerId: string): Promise<void>;

  /** Set the current session's permission tier (read / default / auto). */
  setSessionPermission(taskId: string, sessionId: string, permission: Permission): Promise<void>;
  /** Switch the session's provider + model, preserving history and token totals. */
  setSessionModel(taskId: string, sessionId: string, providerId: string, model: string): Promise<void>;
  /** Pick a session-scoped reasoning level for the current model. */
  setSessionThinking(taskId: string, sessionId: string, level: string): Promise<void>;
  /** Simulated context compaction; keeps cumulative token totals. */
  compactSessionContext(taskId: string, sessionId: string): Promise<void>;

  /** Edit a scheduled task in memory. */
  saveSchedule(input: SaveScheduleInput): Promise<Schedule>;

  /** Bind a machine-local checkout path to a registered repository. */
  setRepositoryPath(repositoryId: string, localPath: string): Promise<void>;

  /** Add repositories and/or ordinary directories to an existing task. */
  addTaskSources(taskId: string, input: AddTaskSourcesInput): Promise<void>;

  /** Upsert an in-memory service startup recipe; no repository scan or file write. */
  saveServiceRecipe(input: SaveServiceRecipeInput): Promise<ServiceRecipe>;
  /** Simulated `.vscode` import: adds example recipes from the project's registered repos. */
  importVscodeConfig(environmentId: string): Promise<ServiceRecipe[]>;

  /** Replace the project's ordinary-directory registrations; locked entries must be unchanged. */
  setProjectDirectories(projectId: string, rows: ProjectDirectoryInput[]): Promise<ProjectDirectory[]>;
  /** Set the exact set of directories linked into a task, keeping existing link names. */
  setTaskDirectories(taskId: string, directoryIds: string[]): Promise<void>;
  /** In-memory task creation; Git worktree preparation stays simulated. */
  createTask(input: CreateTaskInput): Promise<Task>;
  /** Build a file reference from an in-task directory symlink. */
  createDirectoryFileReference(taskId: string, directoryId: string): Promise<Reference>;

  /** Builds a file reference from the task workspace instead of a hardcoded label. */
  createFileReference(taskId: string): Promise<Reference>;
  /** Simulated terminal execution; the renderer only displays what comes back. */
  runTerminalCommand(taskId: string, command: string): Promise<string[]>;

  subscribe(listener: (event: HostEvent) => void): () => void;
}
