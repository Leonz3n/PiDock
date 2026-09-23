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
import type {
  Approval,
  ApprovalStatus,
  AttentionItem,
  Capability,
  CleanupItem,
  Environment,
  LocalSettings,
  Permission,
  Project,
  ProjectDirectory,
  ProviderDiscoveryView,
  ProviderProfile,
  Reference,
  Schedule,
  ServiceMode,
  ScheduledRun,
  ServiceRecipe,
  Session,
  Task,
  UsageRecord,
  Workspace,
} from "../data/types";

type HostState = {
  adapter: HostAdapter;
  status: "loading" | "ready" | "error";
  error?: string;
  workspace?: Workspace;
  localSettings?: LocalSettings;
  attention: AttentionItem[];
  approvals: Approval[];
  usage: UsageRecord[];
  refresh: () => Promise<void>;
  loadUsage: (taskId?: string) => Promise<void>;
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
  renameTask: (taskId: string, name: string) => Promise<void>;
  renameSession: (taskId: string, sessionId: string, name: string) => Promise<void>;
  createSession: (taskId: string) => Promise<Session>;
  setServiceRunning: (taskId: string, serviceId: string, running: boolean) => Promise<void>;
  setServiceMode: (taskId: string, serviceId: string, mode: ServiceMode) => Promise<void>;
  setScheduleEnabled: (scheduleId: string, enabled: boolean) => Promise<void>;
  runScheduleNow: (scheduleId: string) => Promise<ScheduledRun>;
  setCapabilityEnabled: (capabilityId: string, enabled: boolean) => Promise<void>;
  revokeDevice: (deviceId: string) => Promise<void>;
  loadCleanupPreview: (taskId: string) => Promise<CleanupItem[]>;
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
  syncProviderModels: (providerId: string) => Promise<ProviderDiscoveryView>;
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

  loadUsage: async (taskId) => {
    const usage = await get().adapter.getUsage(taskId ? { taskId } : {});
    set({ usage });
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
    const result = await get().adapter.sendMessage(taskId, sessionId, text, references);
    await get().refresh();
    return result;
  },

  stopRun: async (taskId, sessionId) => {
    await get().adapter.stopRun(taskId, sessionId);
    await get().refresh();
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
  },

  archiveTask: async (taskId) => {
    await get().adapter.archiveTask(taskId);
    await get().refresh();
  },

  restoreTask: async (taskId) => {
    await get().adapter.restoreTask(taskId);
    await get().refresh();
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

  revokeDevice: async (deviceId) => {
    await get().adapter.revokeRemoteDevice(deviceId);
    await get().refresh();
  },

  loadCleanupPreview: async (taskId) => {
    return get().adapter.previewCleanup(taskId);
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

  syncProviderModels: (providerId) => get().adapter.syncProviderModels(providerId),

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
