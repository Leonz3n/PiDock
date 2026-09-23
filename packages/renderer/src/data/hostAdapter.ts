import type {
  Approval,
  ApprovalStatus,
  AttentionItem,
  Capability,
  CapabilitySourceKind,
  CleanupItem,
  CleanupRunResult,
  CleanupSelection,
  ConfigEntry,
  ConfigScope,
  ContextWindowSource,
  Environment,
  HostEvent,
  LocalSettings,
  ModelThinking,
  Permission,
  ServiceMode,
  Project,
  ProjectDirectory,
  ProviderDiscoveryView,
  ProviderProfile,
  RemoteDevice,
  Reference,
  RunRecord,
  Schedule,
  ScheduledRun,
  ServiceRecipe,
  Session,
  Task,
  TaskLifecycleState,
  TaskWriteLockView,
  UsageCleanupScope,
  UsageKind,
  UsageRecord,
  Workspace,
} from "./types";
import type { SessionWriteState } from "./writeCoordination";
import type { ProtocolBindingView } from "./protocolBinding";
import type { ServiceTopologyView } from "./serviceTopology";
import type {
  TerminalControlResultView,
  TerminalHistoryEntryView,
  TerminalPlanRequest,
  TerminalPlanView,
  TerminalStateView,
  WorkspaceBrowserRequest,
  WorkspaceBrowserView,
  TerminalControlRequest,
} from "./workspaceFiles";

export type UsageFilter = {
  taskId?: string;
  projectId?: string;
  providerId?: string;
  sessionId?: string;
  from?: string;
  to?: string;
  /** [PiDock 12] #12: narrow to one call type (turn/compaction/...). */
  kind?: UsageKind;
};

export type SendMessageResult = {
  state: "completed" | "failed" | "approval" | "stopped";
  run: RunRecord;
  /** Host approval id, present only when `state` is `approval` (shell path). */
  approvalId?: string;
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
  /** Which source list it came from; defaults to `project` when omitted. */
  sourceKind?: CapabilitySourceKind;
  /** MCP: private credential reference name; a literal secret is refused. */
  authRef?: string;
  /** MCP: the enabled bridge Extension that hosts the server (required for mcp). */
  bridge?: { extensionId: string; command: string };
  /** Package: the version the source offers. */
  availableVersion?: string;
};

/** Create or edit a provider profile. */
export type SaveProviderInput = {
  id?: string;
  name: string;
  protocol: string;
  baseUrl: string;
  /** Reference name in the machine-private configuration; a literal secret is rejected. */
  authRef?: string;
  enabled: boolean;
  models: {
    id: string;
    name?: string;
    contextWindow: number;
    /** Provenance of `contextWindow` (presentation only; absent means `manual`). */
    contextWindowSource?: ContextWindowSource;
    /** Max output tokens for this model (same unit as `contextWindow`). */
    maxOutput?: number;
    supportsImages?: boolean;
    thinking?: ModelThinking;
  }[];
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

/**
 * [PiDock 02] provision state for the create-task form, derived from the
 * persisted task record: the actual root saved on the task, the pinned
 * remote branch + commit, the editable branch, and the last failure (kept
 * with a retry entry, never silently replaced by a stale reference).
 *
 * [PiDock 03] (#6): `repoSources` carries per-repo remote+branch+pinned
 * commit for multi-repo tasks (absent on single-repo records); `dirLinks`
 * carries plain-dir link snapshots (shared views of the originals).
 */
export type RepoSourceState = {
  repoDir: string;
  remote: string;
  remoteBranch: string;
  baseCommit: string;
};

export type DirLinkState = {
  linkName: string;
  directoryId: string;
  sourcePath: string;
  snapshotAt: string;
};

export type TaskProvisionState = {
  taskId: string;
  name: string;
  dirId: string;
  branch: string;
  root: string;
  taskDir: string;
  remoteBranch: string;
  baseCommit: string;
  repoSources?: RepoSourceState[];
  dirLinks?: DirLinkState[];
  ready: boolean;
  lastError?: { code: string; message: string };
};

/**
 * [PiDock 02] header state: name/repo/branch/ready/code-change read from
 * the task record + session state. Errors stay bound to the task id.
 */
export type TaskHeaderState = {
  taskId: string;
  name: string;
  repos: string[];
  branch: string;
  /** Stored actual root (`task.json` through the shell, task record in dev/memory). */
  root: string;
  ready: boolean;
  changedFiles: { path: string; status: string }[];
  error?: string;
};

/** Per-creation provision fields the form hands to the Host. */
export type ProvisionTaskInput = {
  taskId: string;
  name: string;
  dirId: string;
  /** Editable branch; defaults to `task/<dirId>` when omitted. */
  branch?: string;
  /** Per-creation root override; omitted means the persisted default root. */
  rootOverride?: string;
  remoteBranch: string;
  fetchedCommit: string;
  repos?: string[];
  mainCheckouts?: Record<string, string>;
  /**
   * [PiDock 03] (#6) per-repo sources: each repo names its own remote +
   * baseline branch; `fetchedCommits` pins each repo's fresh commit
   * (all-success gate Host-side). `plainDirs` snapshots plain-directory
   * links (shared views of the originals, never copies).
   */
  repoSelections?: { repoDir: string; remote: string; remoteBranch: string; mainCheckoutDir: string }[];
  fetchedCommits?: Record<string, string>;
  plainDirs?: { directoryId: string; sourcePath: string }[];
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
 *
 * [PiDock 02] task-record seam: the shell persists `task.json` (+ branch,
 * baseline, root) per task folder. The renderer mirrors that record through
 * `TaskProvisionState` (see `directories.ts` + the shell bridge):
 * the create-task form previews real paths, keeps the form on fetch/provision
 * failure with a retry entry, and stores the resolved root on the created
 * task. The per-task header reads from the same record plus session state,
 * so file panels and errors always bind to the task id.
 */
export interface HostAdapter {
  getWorkspace(): Promise<Workspace>;
  getProject(projectId: string): Promise<Project | undefined>;
  getTask(taskId: string): Promise<Task | undefined>;
  getSession(taskId: string, sessionId: string): Promise<Session | undefined>;
  getRun(taskId: string, sessionId: string): Promise<RunRecord | undefined>;
  getAttention(): Promise<AttentionItem[]>;
  /**
   * [PiDock 17] (#19 box 5) 读取完成清除未读: clear the read items of one task.
   * Only 完成未读 items clear; a 待处理 id comes back in `kept` so the caller can
   * say why it is still there (待确认/失败/过期须处理后移除).
   */
  markAttentionRead(taskId: string, itemIds: string[]): Promise<{ cleared: string[]; kept: string[] }>;
  getUsage(filter?: UsageFilter): Promise<UsageRecord[]>;
  /**
   * [PiDock 12] #12 box 8: remove usage details in one explicit scope. Archiving
   * a conversation never removes usage; only this call does.
   */
  clearUsage(scope: UsageCleanupScope): Promise<{ removed: number; remaining: number; description: string }>;

  sendMessage(
    taskId: string,
    sessionId: string,
    text: string,
    references: Reference[],
  ): Promise<SendMessageResult>;
  stopRun(taskId: string, sessionId: string): Promise<void>;
  createSession(taskId: string): Promise<Session>;
  /**
   * [PiDock 09] (#11) write coordination of one task: holder (+ claim label),
   * queue order, leftover agent-owned resources, derived executions and the
   * per-session role the navigation badges use. The shell adapter reads the
   * Host (`task/sessionStates`); the memory adapter computes it from its locks.
   */
  sessionWriteStates(taskId: string): Promise<{ writeLock: TaskWriteLockView; sessions: SessionWriteState[] }>;
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
  /**
   * [PiDock 05] (#10) multi-service topology view for one task: units and
   * locations, the actual dependency routing, start groups, run records,
   * locatable failures and shared-resource limits. The shell adapter asks the
   * Host (`task/planServiceGroup` + `task/serviceRunRecords`) and falls back
   * to the in-memory projection when the Host cannot answer.
   */
  serviceTopology(taskId: string): Promise<ServiceTopologyView>;
  /**
   * [PiDock 08] (#14) task-local protocol plan and consumer binding state:
   * the protocol repository, the generation steps, the actual generated
   * version, the per-consumer binding/staleness and the platform toolchain
   * result. The shell adapter asks the Host (`task/protocolState`) and falls
   * back to the in-memory projection when the Host cannot answer.
   */
  protocolBinding(taskId: string): Promise<ProtocolBindingView>;
  /**
   * [PiDock 10] (#15) task file browser: browsable roots (repo worktrees +
   * plain-directory links) plus the selected root's tree/preview/diff/delivery
   * view. The shell adapter asks the Host (`task/fileRoots` + the selected read
   * ops) and falls back to the in-memory projection when the Host cannot answer.
   */
  workspaceBrowser(taskId: string, request?: WorkspaceBrowserRequest): Promise<WorkspaceBrowserView>;
  /**
   * [PiDock 10] (#15) built-in terminal: plan one terminal for a task root
   * (cwd + resolved env rows, masked) and list this task's instances. No real
   * pty in this slice (`spawnImplemented: false`).
   */
  planTerminal(taskId: string, request: TerminalPlanRequest): Promise<TerminalPlanView>;
  controlTerminal(taskId: string, request: TerminalControlRequest): Promise<TerminalControlResultView>;
  terminalState(taskId: string): Promise<TerminalStateView>;
  terminalHistory(taskId: string, instanceId: string, limit?: number): Promise<TerminalHistoryEntryView[]>;
  getSchedules(): Promise<Schedule[]>;
  setScheduleEnabled(scheduleId: string, enabled: boolean): Promise<void>;
  runScheduleNow(scheduleId: string): Promise<ScheduledRun>;

  getCapabilities(): Promise<Capability[]>;
  /**
   * [PiDock 16] (#18) enable/disable at the safe session boundary: while a
   * turn runs the change waits and the running call keeps its version.
   */
  setCapabilityEnabled(capabilityId: string, enabled: boolean): Promise<void>;
  /** [PiDock 16] (#18) retry an MCP connection through its bridge Extension. */
  retryMcpConnection(capabilityId: string): Promise<Capability>;
  /** [PiDock 16] (#18) install/update a package; only a package is an install entry. */
  installCapability(capabilityId: string): Promise<Capability>;
  /** [PiDock 16] (#18) re-check sources and repair recovered rows, never merging same names. */
  recheckCapabilities(): Promise<Capability[]>;
  getRemoteDevices(): Promise<RemoteDevice[]>;
  revokeRemoteDevice(deviceId: string): Promise<void>;
  /**
   * [PiDock 14] (#17) cleanup scope of one archived task. `selection` decides
   * which records are exported first; unselected records are removed and the
   * preview says so. The shell adapter asks the Host
   * (`task/cleanupPreview`) and falls back to the in-memory projection.
   */
  previewCleanup(taskId: string, selection?: CleanupSelection): Promise<CleanupItem[]>;
  /**
   * [PiDock 14] (#17) run the cleanup: keep an independent copy of the
   * undelivered code plus the selected exports, verify them, then remove
   * identity-confirmed managed resources. Partial failure keeps the task
   * registration and one recovery entry per failed item.
   */
  runCleanup(taskId: string, selection: CleanupSelection): Promise<CleanupRunResult>;
  /** [PiDock 14] (#17) archive state, cleanup receipt and resource identities. */
  lifecycleState(taskId: string): Promise<TaskLifecycleState>;

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
  /** Enable/disable one provider without touching its models or any session. */
  setProviderEnabled(providerId: string, enabled: boolean): Promise<ProviderProfile>;
  /**
   * 「同步模型列表」: fetch candidate model ids through the provider's own
   * connection. Only the candidate list changes — configured model rows are
   * never overwritten, auto-added or removed.
   */
  /**
   * 「同步模型列表」 for a saved configuration, or — before the first save —
   * for a draft connection (address + protocol taken from the form).
   */
  syncProviderModels(providerId: string, connection?: { protocol: string; baseUrl: string }): Promise<ProviderDiscoveryView>;

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
  /**
   * [PiDock 02] provision state for the task form, derived from persistent
   * records — the actual root saved on the task, the pinned remote branch
   * + commit, the editable branch, and the last failure (kept with a retry
   * entry, never silently replaced by a stale reference).
   */
  getTaskProvision(taskId: string): Promise<TaskProvisionState | undefined>;
  /**
   * [PiDock 02] header state: name/repo/branch/ready/code-change read from
   * the task record + session state, errors bound to the task id.
   */
  getTaskHeader(taskId: string): Promise<TaskHeaderState>;
  /**
   * [PiDock 02] provision a task through the form fields (name/dirId/
   * branch/rootOverride/baseline). Failures return `{ok:false}` with the
   * form kept and a retry entry — never a rejected invoke.
   */
  provisionTaskThroughForm(input: ProvisionTaskInput): Promise<
    { ok: true; provision: TaskProvisionState } | { ok: false; error: { code: string; message: string } }
  >;
  /** Build a file reference from an in-task directory symlink. */
  createDirectoryFileReference(taskId: string, directoryId: string): Promise<Reference>;

  /** Builds a file reference from the task workspace instead of a hardcoded label. */
  createFileReference(taskId: string): Promise<Reference>;
  /** Simulated terminal execution; the renderer only displays what comes back. */
  runTerminalCommand(taskId: string, command: string): Promise<string[]>;

  subscribe(listener: (event: HostEvent) => void): () => void;
}
