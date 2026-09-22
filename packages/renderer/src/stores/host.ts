import { create } from "zustand";
import type {
  CreateTaskInput,
  HostAdapter,
  ProjectDirectoryInput,
  SaveEnvironmentConfigInput,
  SaveServiceRecipeInput,
  SendMessageResult,
} from "../data/hostAdapter";
import { memoryHost } from "../data/memoryHost";
import type {
  Approval,
  ApprovalStatus,
  AttentionItem,
  CleanupItem,
  LocalSettings,
  Project,
  ProjectDirectory,
  Reference,
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
  setScheduleEnabled: (scheduleId: string, enabled: boolean) => Promise<void>;
  runScheduleNow: (scheduleId: string) => Promise<ScheduledRun>;
  setCapabilityEnabled: (capabilityId: string, enabled: boolean) => Promise<void>;
  revokeDevice: (deviceId: string) => Promise<void>;
  loadCleanupPreview: (taskId: string) => Promise<CleanupItem[]>;
  saveEnvironmentConfig: (input: SaveEnvironmentConfigInput) => Promise<void>;
  adoptLatestTemplate: (taskId: string) => Promise<void>;
  saveServiceRecipe: (input: SaveServiceRecipeInput) => Promise<ServiceRecipe>;
  importVscodeConfig: (environmentId: string) => Promise<ServiceRecipe[]>;
  setProjectDirectories: (projectId: string, rows: ProjectDirectoryInput[]) => Promise<ProjectDirectory[]>;
  setTaskDirectories: (taskId: string, directoryIds: string[]) => Promise<void>;
  createTask: (input: CreateTaskInput) => Promise<Task>;
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
}));
