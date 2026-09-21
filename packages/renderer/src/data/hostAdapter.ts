import type {
  Approval,
  ApprovalStatus,
  AttentionItem,
  Capability,
  CleanupItem,
  HostEvent,
  LocalSettings,
  Project,
  RemoteDevice,
  Reference,
  RunRecord,
  Schedule,
  ScheduledRun,
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

  /** Builds a file reference from the task workspace instead of a hardcoded label. */
  createFileReference(taskId: string): Promise<Reference>;
  /** Simulated terminal execution; the renderer only displays what comes back. */
  runTerminalCommand(taskId: string, command: string): Promise<string[]>;

  subscribe(listener: (event: HostEvent) => void): () => void;
}
