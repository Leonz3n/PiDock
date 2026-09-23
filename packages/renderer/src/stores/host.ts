import { create } from "zustand";
import type {
  AddCapabilityInput,
  AddTaskSourcesInput,
  CreateTaskInput,
  HostAdapter,
  ProjectDirectoryInput,
  SaveEnvironmentConfigInput,
  SaveEnvironmentInput,
  SaveProjectInput,
  SaveProviderInput,
  SaveScheduleInput,
  SaveServiceRecipeInput,
  SendMessageResult,
  TaskHeaderState,
  TaskProvisionState,
} from "../data/hostAdapter";
import { memoryHost } from "../data/memoryHost";
import { useWriteLockStore } from "./writeLock";
import type {
  Approval,
  ApprovalStatus,
  AttentionItem,
  Capability,
  CleanupItem,
  CleanupRunResult,
  CleanupSelection,
  Environment,
  LocalSettings,
  Permission,
  Project,
  ProjectDirectory,
  ProviderDiscoveryView,
  ProviderProfile,
  Reference,
  RemoteDevicePermission,
  RemoteEntryMode,
  RemotePairing,
  Schedule,
  ServiceMode,
  ScheduledRun,
  ServiceRecipe,
  Session,
  Task,
  UsageCleanupScope,
  UsageRecord,
  Workspace,
} from "../data/types";
import type { TaskLifecycleState } from "../data/types";
import type { ServiceTopologyView } from "../data/serviceTopology";
import type { ProtocolBindingView } from "../data/protocolBinding";
import type {
  TerminalControlRequest,
  TerminalControlResultView,
  TerminalPlanRequest,
  TerminalPlanView,
  TerminalStateView,
  WorkspaceBrowserRequest,
  WorkspaceBrowserView,
} from "../data/workspaceFiles";

type HostState = {
  adapter: HostAdapter;
  status: "loading" | "ready" | "error";
  error?: string;
  workspace?: Workspace;
  localSettings?: LocalSettings;
  attention: AttentionItem[];
  /** [PiDock 17] (#19 box 5) 读取完成清除未读: clears unread items, then reloads the list. */
  markAttentionRead: (taskId: string, itemIds: string[]) => Promise<{ cleared: string[]; kept: string[] }>;
  approvals: Approval[];
  usage: UsageRecord[];
  refresh: () => Promise<void>;
  loadUsage: (taskId?: string) => Promise<void>;
  /** [PiDock 12] #12: remove usage in an explicit scope, then reload. */
  clearUsage: (scope: UsageCleanupScope) => Promise<{ removed: number; remaining: number; description: string }>;
  setWorkspaceRoot: (workspaceRoot: string) => Promise<LocalSettings>;
  task: (taskId: string) => Task | undefined;
  session: (taskId: string, sessionId: string) => Session | undefined;
  project: (projectId: string) => Project | undefined;
  createFileReference: (taskId: string) => Promise<Reference>;
  setRepositoryPath: (repositoryId: string, localPath: string) => Promise<void>;
  createDirectoryFileReference: (taskId: string, directoryId: string) => Promise<Reference>;
  runTerminalCommand: (taskId: string, command: string) => Promise<string[]>;
  sendMessage: (
    taskId: string,
    sessionId: string,
    text: string,
    references: Reference[],
  ) => Promise<SendMessageResult>;
  stopRun: (taskId: string, sessionId: string) => Promise<void>;
  resolveApproval: (approvalId: string, status: ApprovalStatus) => Promise<Approval>;
  simulateExpiry: (approvalId: string) => Promise<Approval>;
  archiveSession: (taskId: string, sessionId: string, archived: boolean) => Promise<void>;
  archiveTask: (taskId: string) => Promise<void>;
  restoreTask: (taskId: string) => Promise<void>;
  /** [PiDock 14] (#17) archive state, cleanup receipt and resource identities. */
  loadLifecycleState: (taskId: string) => Promise<TaskLifecycleState>;
  /** [PiDock 14] (#17) run the cleanup with the chosen exports. */
  runCleanup: (taskId: string, selection: CleanupSelection) => Promise<CleanupRunResult>;
  renameTask: (taskId: string, name: string) => Promise<void>;
  renameSession: (taskId: string, sessionId: string, name: string) => Promise<void>;
  createSession: (taskId: string) => Promise<Session>;
  setServiceRunning: (taskId: string, serviceId: string, running: boolean) => Promise<void>;
  setServiceMode: (taskId: string, serviceId: string, mode: ServiceMode) => Promise<void>;
  /** [PiDock 05] (#10) topology view for the runtime panel (Host plan or memory projection). */
  serviceTopology: (taskId: string) => Promise<ServiceTopologyView>;
  /** [PiDock 08] (#14) protocol plan + consumer binding view (Host state or memory projection). */
  protocolBinding: (taskId: string) => Promise<ProtocolBindingView>;
  /**
   * [PiDock 10] (#15) task file browser (roots + selected tree/preview/diff/
   * delivery). Read-only: the Host validates every path against one root and
   * bounds/masks the answer; the renderer only displays it.
   */
  workspaceBrowser: (taskId: string, request?: WorkspaceBrowserRequest) => Promise<WorkspaceBrowserView>;
  /** [PiDock 10] (#15) plan one terminal for a task root (masked env rows). */
  planTerminal: (taskId: string, request: TerminalPlanRequest) => Promise<TerminalPlanView>;
  /** [PiDock 10] (#15) start/stop one terminal through the Host's gate. */
  controlTerminal: (taskId: string, request: TerminalControlRequest) => Promise<TerminalControlResultView>;
  /** [PiDock 10] (#15) this task's terminal instances (no real pty yet). */
  terminalState: (taskId: string) => Promise<TerminalStateView>;
  setScheduleEnabled: (scheduleId: string, enabled: boolean) => Promise<void>;
  runScheduleNow: (scheduleId: string) => Promise<ScheduledRun>;
  setCapabilityEnabled: (capabilityId: string, enabled: boolean) => Promise<void>;
  /** [PiDock 16] (#18) retry an MCP connection through its bridge Extension. */
  retryMcpConnection: (capabilityId: string) => Promise<Capability>;
  /** [PiDock 16] (#18) install/update a package; only a package has a version to install. */
  installCapability: (capabilityId: string) => Promise<Capability>;
  /** [PiDock 16] (#18) re-check sources: recovered rows work again, same names stay apart. */
  recheckCapabilities: () => Promise<Capability[]>;
  /** [PiDock 19] (#21) desktop pairing + per-device credential management. */
  mintRemotePairing: () => Promise<RemotePairing>;
  cancelRemotePairing: () => Promise<void>;
  confirmRemoteDevice: (deviceId: string, permissions?: RemoteDevicePermission[]) => Promise<void>;
  rejectRemoteDevice: (deviceId: string) => Promise<void>;
  rotateRemoteDevice: (deviceId: string) => Promise<void>;
  revokeDevice: (deviceId: string) => Promise<void>;
  setRemoteEntryMode: (mode: RemoteEntryMode, baseUrl?: string) => Promise<void>;
  loadCleanupPreview: (taskId: string, selection?: CleanupSelection) => Promise<CleanupItem[]>;
  saveEnvironmentConfig: (input: SaveEnvironmentConfigInput) => Promise<void>;
  adoptLatestTemplate: (taskId: string) => Promise<void>;
  saveProject: (input: SaveProjectInput) => Promise<Project>;
  deleteProject: (projectId: string) => Promise<void>;
  saveEnvironment: (input: SaveEnvironmentInput) => Promise<Environment>;
  deleteEnvironment: (environmentId: string) => Promise<void>;
  addCapability: (input: AddCapabilityInput) => Promise<Capability>;
  saveProvider: (input: SaveProviderInput) => Promise<ProviderProfile>;
  removeProvider: (providerId: string) => Promise<void>;
  setProviderEnabled: (providerId: string, enabled: boolean) => Promise<void>;
  syncProviderModels: (providerId: string, connection?: { protocol: string; baseUrl: string }) => Promise<ProviderDiscoveryView>;
  setSessionPermission: (taskId: string, sessionId: string, permission: Permission) => Promise<void>;
  setSessionModel: (taskId: string, sessionId: string, providerId: string, model: string) => Promise<void>;
  setSessionThinking: (taskId: string, sessionId: string, level: string) => Promise<void>;
  compactSessionContext: (taskId: string, sessionId: string) => Promise<void>;
  saveSchedule: (input: SaveScheduleInput) => Promise<Schedule>;
  addTaskSources: (taskId: string, input: AddTaskSourcesInput) => Promise<void>;
  saveServiceRecipe: (input: SaveServiceRecipeInput) => Promise<ServiceRecipe>;
  importVscodeConfig: (environmentId: string) => Promise<ServiceRecipe[]>;
  setProjectDirectories: (projectId: string, rows: ProjectDirectoryInput[]) => Promise<ProjectDirectory[]>;
  setTaskDirectories: (taskId: string, directoryIds: string[]) => Promise<void>;
  createTask: (input: CreateTaskInput) => Promise<Task>;
  getTaskProvision: (taskId: string) => Promise<TaskProvisionState | undefined>;
  getTaskHeader: (taskId: string) => Promise<TaskHeaderState>;
};

export const useHostStore = create<HostState>((set, get) => ({
  adapter: memoryHost,
  status: "loading",
  attention: [],
  approvals: [],
  usage: [],

  refresh: async () => {
    try {
      const workspace = await get().adapter.getWorkspace();
      const attention = await get().adapter.getAttention();
      const localSettings = await get().adapter.getLocalSettings();
      const approvals = (await Promise.all(workspace.tasks.map((task) => get().adapter.listApprovals(task.id)))).flat();
      set({ workspace, attention, approvals, localSettings, status: "ready", error: undefined });
    } catch (error) {
      set({ status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  },

  markAttentionRead: async (taskId, itemIds) => {
    const result = await get().adapter.markAttentionRead(taskId, itemIds);
    set({ attention: await get().adapter.getAttention() });
    return result;
  },

  loadUsage: async (taskId) => {
    const usage = await get().adapter.getUsage(taskId ? { taskId } : {});
    set({ usage });
  },

  clearUsage: async (scope) => {
    const result = await get().adapter.clearUsage(scope);
    await get().loadUsage();
    return result;
  },

  setWorkspaceRoot: async (workspaceRoot) => {
    const localSettings = await get().adapter.setWorkspaceRoot(workspaceRoot);
    set({ localSettings });
    return localSettings;
  },

  task: (taskId) => get().workspace?.tasks.find((item) => item.id === taskId),
  session: (taskId, sessionId) =>
    get()
      .workspace?.tasks.find((item) => item.id === taskId)
      ?.sessions.find((item) => item.id === sessionId),
  project: (projectId) => get().workspace?.projects.find((item) => item.id === projectId),
  createFileReference: (taskId) => get().adapter.createFileReference(taskId),
  setRepositoryPath: async (repositoryId, localPath) => {
    await get().adapter.setRepositoryPath(repositoryId, localPath);
    await get().refresh();
  },
  createDirectoryFileReference: (taskId, directoryId) => get().adapter.createDirectoryFileReference(taskId, directoryId),
  runTerminalCommand: (taskId, command) => get().adapter.runTerminalCommand(taskId, command),

  sendMessage: async (taskId, sessionId, text, references) => {
    try {
      const result = await get().adapter.sendMessage(taskId, sessionId, text, references);
      await get().refresh();
      await useWriteLockStore.getState().load(taskId);
      return result;
    } catch (error) {
      // A refusal (another session holds the write right, or the tier is
      // read-only) still changes the coordination view: this session is now
      // queued / shown read-only. Load it before rethrowing so the navigation
      // shows the holder and the queue instead of an unchanged screen.
      await useWriteLockStore.getState().load(taskId);
      throw error;
    }
  },

  stopRun: async (taskId, sessionId) => {
    await get().adapter.stopRun(taskId, sessionId);
    await get().refresh();
    await useWriteLockStore.getState().load(taskId);
  },

  resolveApproval: async (approvalId, status) => {
    const approval = await get().adapter.resolveApproval(approvalId, status);
    await get().refresh();
    return approval;
  },

  simulateExpiry: async (approvalId) => {
    const approval = await get().adapter.simulateExpiry(approvalId);
    await get().refresh();
    return approval;
  },

  archiveSession: async (taskId, sessionId, archived) => {
    await get().adapter.setSessionArchived(taskId, sessionId, archived);
    await get().refresh();
    await useWriteLockStore.getState().load(taskId);
  },

  archiveTask: async (taskId) => {
    await get().adapter.archiveTask(taskId);
    await get().refresh();
  },

  restoreTask: async (taskId) => {
    await get().adapter.restoreTask(taskId);
    await get().refresh();
  },

  loadLifecycleState: async (taskId) => get().adapter.lifecycleState(taskId),

  runCleanup: async (taskId, selection) => {
    const result = await get().adapter.runCleanup(taskId, selection);
    await get().refresh();
    return result;
  },

  renameTask: async (taskId, name) => {
    await get().adapter.renameTask(taskId, name);
    await get().refresh();
  },

  renameSession: async (taskId, sessionId, name) => {
    await get().adapter.renameSession(taskId, sessionId, name);
    await get().refresh();
  },

  createSession: async (taskId) => {
    const session = await get().adapter.createSession(taskId);
    await get().refresh();
    return session;
  },

  setServiceRunning: async (taskId, serviceId, running) => {
    await get().adapter.setServiceRunning(taskId, serviceId, running);
    await get().refresh();
  },

  setServiceMode: async (taskId, serviceId, mode) => {
    await get().adapter.setServiceMode(taskId, serviceId, mode);
    await get().refresh();
  },

  serviceTopology: async (taskId) => get().adapter.serviceTopology(taskId),
  workspaceBrowser: async (taskId, request) => get().adapter.workspaceBrowser(taskId, request),
  planTerminal: async (taskId, request) => get().adapter.planTerminal(taskId, request),
  controlTerminal: async (taskId, request) => get().adapter.controlTerminal(taskId, request),
  terminalState: async (taskId) => get().adapter.terminalState(taskId),

  protocolBinding: async (taskId) => get().adapter.protocolBinding(taskId),

  setScheduleEnabled: async (scheduleId, enabled) => {
    await get().adapter.setScheduleEnabled(scheduleId, enabled);
    await get().refresh();
  },

  runScheduleNow: async (scheduleId) => {
    const run = await get().adapter.runScheduleNow(scheduleId);
    await get().refresh();
    return run;
  },

  setCapabilityEnabled: async (capabilityId, enabled) => {
    await get().adapter.setCapabilityEnabled(capabilityId, enabled);
    await get().refresh();
  },

  retryMcpConnection: async (capabilityId) => {
    const capability = await get().adapter.retryMcpConnection(capabilityId);
    await get().refresh();
    return capability;
  },

  installCapability: async (capabilityId) => {
    const capability = await get().adapter.installCapability(capabilityId);
    await get().refresh();
    return capability;
  },

  recheckCapabilities: async () => {
    const capabilities = await get().adapter.recheckCapabilities();
    await get().refresh();
    return capabilities;
  },

  mintRemotePairing: async () => {
    const pairing = await get().adapter.mintRemotePairing();
    await get().refresh();
    return pairing;
  },

  cancelRemotePairing: async () => {
    await get().adapter.cancelRemotePairing();
    await get().refresh();
  },

  confirmRemoteDevice: async (deviceId, permissions) => {
    await get().adapter.confirmRemoteDevice(deviceId, permissions);
    await get().refresh();
  },

  rejectRemoteDevice: async (deviceId) => {
    await get().adapter.rejectRemoteDevice(deviceId);
    await get().refresh();
  },

  rotateRemoteDevice: async (deviceId) => {
    await get().adapter.rotateRemoteDevice(deviceId);
    await get().refresh();
  },

  revokeDevice: async (deviceId) => {
    await get().adapter.revokeRemoteDevice(deviceId);
    await get().refresh();
  },

  setRemoteEntryMode: async (mode, baseUrl) => {
    await get().adapter.setRemoteEntryMode(mode, baseUrl);
    await get().refresh();
  },

  loadCleanupPreview: async (taskId, selection) => {
    return get().adapter.previewCleanup(taskId, selection);
  },

  saveEnvironmentConfig: async (input) => {
    await get().adapter.saveEnvironmentConfig(input);
    await get().refresh();
  },

  adoptLatestTemplate: async (taskId) => {
    await get().adapter.adoptLatestTemplate(taskId);
    await get().refresh();
  },

  saveProject: async (input) => {
    const project = await get().adapter.saveProject(input);
    await get().refresh();
    return project;
  },

  deleteProject: async (projectId) => {
    await get().adapter.deleteProject(projectId);
    await get().refresh();
  },

  saveEnvironment: async (input) => {
    const environment = await get().adapter.saveEnvironment(input);
    await get().refresh();
    return environment;
  },

  deleteEnvironment: async (environmentId) => {
    await get().adapter.deleteEnvironment(environmentId);
    await get().refresh();
  },

  addCapability: async (input) => {
    const capability = await get().adapter.addCapability(input);
    await get().refresh();
    return capability;
  },

  saveProvider: async (input) => {
    const provider = await get().adapter.saveProvider(input);
    await get().refresh();
    return provider;
  },

  removeProvider: async (providerId) => {
    await get().adapter.removeProvider(providerId);
    await get().refresh();
  },

  setProviderEnabled: async (providerId, enabled) => {
    await get().adapter.setProviderEnabled(providerId, enabled);
    await get().refresh();
  },

  syncProviderModels: (providerId, connection) => get().adapter.syncProviderModels(providerId, connection),

  setSessionPermission: async (taskId, sessionId, permission) => {
    await get().adapter.setSessionPermission(taskId, sessionId, permission);
    await get().refresh();
  },

  setSessionModel: async (taskId, sessionId, providerId, model) => {
    await get().adapter.setSessionModel(taskId, sessionId, providerId, model);
    await get().refresh();
  },

  setSessionThinking: async (taskId, sessionId, level) => {
    await get().adapter.setSessionThinking(taskId, sessionId, level);
    await get().refresh();
  },

  compactSessionContext: async (taskId, sessionId) => {
    await get().adapter.compactSessionContext(taskId, sessionId);
    await get().refresh();
  },

  saveSchedule: async (input) => {
    const schedule = await get().adapter.saveSchedule(input);
    await get().refresh();
    return schedule;
  },

  addTaskSources: async (taskId, input) => {
    await get().adapter.addTaskSources(taskId, input);
    await get().refresh();
  },

  saveServiceRecipe: async (input) => {
    const recipe = await get().adapter.saveServiceRecipe(input);
    await get().refresh();
    return recipe;
  },

  importVscodeConfig: async (environmentId) => {
    const added = await get().adapter.importVscodeConfig(environmentId);
    await get().refresh();
    return added;
  },

  setProjectDirectories: async (projectId, rows) => {
    const directories = await get().adapter.setProjectDirectories(projectId, rows);
    await get().refresh();
    return directories;
  },

  setTaskDirectories: async (taskId, directoryIds) => {
    await get().adapter.setTaskDirectories(taskId, directoryIds);
    await get().refresh();
  },

  createTask: async (input) => {
    const task = await get().adapter.createTask(input);
    await get().refresh();
    return task;
  },

  getTaskProvision: (taskId) => get().adapter.getTaskProvision(taskId),

  getTaskHeader: (taskId) => get().adapter.getTaskHeader(taskId),
}));
