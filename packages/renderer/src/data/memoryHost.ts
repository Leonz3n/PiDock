import type {
  Approval,
  ApprovalStatus,
  AttentionItem,
  BrowserPage,
  Capability,
  CleanupItem,
  ConfigEntry,
  ConfigScope,
  HostEvent,
  LocalSettings,
  Message,
  Project,
  ProjectDirectory,
  Reference,
  RemoteDevice,
  ResolvedConfigEntry,
  RunRecord,
  RunState,
  Schedule,
  ScheduleTemplate,
  ScheduledRun,
  Service,
  Session,
  Task,
  UsageRecord,
  Workspace,
  WorkspaceFile,
} from "./types";
import type {
  CreateTaskInput,
  HostAdapter,
  ProjectDirectoryInput,
  SaveEnvironmentConfigInput,
  SendMessageResult,
  UsageFilter,
} from "./hostAdapter";
import { sessionKeyOf } from "./sessionKey";
import { isSensitiveKey, nextTemplateVersion } from "./configRows";
import { directoryLinkPath, normalizeDirectoryPath, toTaskDirectory } from "./directories";

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** Local application settings live on the machine, not in a project shared template. */
export const defaultWorkspaceRoot = "~/PiDockTasks";

/**
 * A task root must be absolute so task folders are never created relative to the
 * process working directory: POSIX (`/Users/name/Tasks`), Windows drive
 * (`D:\Tasks` or `D:/Tasks`) or UNC (`\\host\share`). A leading `~/` is also
 * accepted because the renderer's own default is home-relative; the prototype
 * rejected it, so this is a deliberate, documented extension.
 */
export function validWorkspaceRoot(root: string): boolean {
  return root.startsWith("/") || root.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(root) || /^\\\\[^\\]+\\[^\\]+/.test(root);
}

const defaultLocalSettings: LocalSettings = {
  configDir: "~/.pi/dock",
  configFile: "~/.pi/dock/config.json",
  workspaceRoot: defaultWorkspaceRoot,
};

const HISTORY_SESSION_COUNT = 52;

export const taskFileSeeds: WorkspaceFile[] = [
  {
    path: "front-monorepo/src/checkout/summary.tsx",
    status: "modified",
    preview: {
      language: "tsx",
      source: `export function CheckoutSummary({ total }: { total: number }) {
  return <strong data-testid="checkout-total">合计 {total.toFixed(2)}</strong>;
}`,
    },
  },
  { path: "front-monorepo/src/checkout/api.ts", status: "modified" },
  { path: "invoice-service/src/invoice/detail.py", status: "added" },
];

export const taskBrowserPageSeeds: BrowserPage[] = [
  { id: "page-1", title: "结账页 · staging", url: "https://staging.atlas.example.com/checkout" },
  { id: "page-2", title: "对账单详情", url: "https://staging.atlas.example.com/invoices/9f2c" },
];

export const taskTerminalSeed = [
  "$ pnpm --filter saas-web dev",
  "VITE v7.3.6  ready in 412 ms",
  "➜  Local:   http://127.0.0.1:5173/",
];

export const scheduleTemplates: ScheduleTemplate[] = [
  {
    id: "tl-weekly-repo",
    name: "每周仓库改动摘要",
    rule: "每周日 18:00",
    prompt: "汇总本任务各仓库本周的提交、未合并分支与需要人工确认的改动。",
  },
  {
    id: "tl-standup",
    name: "站会主题准备",
    rule: "周一至周五 09:15",
    prompt: "根据工作区当前改动与未完成事项，列出今天站会要同步的三个要点。",
  },
  {
    id: "tl-weekly-contribution",
    name: "每周代码贡献统计",
    rule: "每周日 19:00",
    prompt: "统计本任务涉及的仓库本周代码贡献，按仓库与目录分组，并标注异常提交。",
  },
  {
    id: "tl-daily-risk",
    name: "每日代码风险巡检",
    rule: "周一至周五 17:00",
    prompt: "检查本任务工作区中未提交改动、过期依赖和明显风险点，给出处理建议。",
  },
  {
    id: "tl-release-prep",
    name: "每周发布准备检查",
    rule: "每周五 15:00",
    prompt: "核对发布前检查清单：构建、测试、配置差异和待合并分支。",
  },
];

function makeUsage(total: number): UsageRecord[] {
  const providers = ["provider-anthropic", "provider-openai", "provider-local"];
  const models = ["Claude Sonnet", "团队轻量模型", "本地 Qwen"];
  const targets: [string, string, string][] = [
    ["atlas", "release", "main"],
    ["atlas", "release", "deploy"],
    ["atlas", "checkout", "main"],
    ["orbit", "latency", "main"],
  ];
  const records: UsageRecord[] = [];
  for (let index = 0; index < total; index += 1) {
    const [projectId, taskId, sessionId] = targets[index % targets.length];
    const providerIndex = index % providers.length;
    const day = 21 - Math.floor(index / 24);
    const hour = 23 - (index % 24);
    records.push({
      id: `usage-${index + 1}`,
      taskId,
      projectId,
      sessionId,
      providerId: providers[providerIndex],
      model: models[providerIndex],
      input: 3200 + ((index * 617) % 9600),
      output: 480 + ((index * 283) % 2400),
      cacheRead: index % 5 === 0 ? 1200 + ((index * 97) % 800) : 0,
      at: `2026-09-${String(Math.max(day, 1)).padStart(2, "0")}T${String(hour).padStart(2, "0")}:12:00+08:00`,
    });
  }
  return records;
}

function makeServices(taskId: string, environment: string, running: boolean) {
  const seeds: [string, string | undefined, number | undefined, "local" | "remote"][] = [
    ["saas-web", "front-monorepo", 5173, "local"],
    ["saas-bff", "front-monorepo", 3001, "local"],
    ["invoice-service", "invoice-service", 9001, "local"],
    ["shipment-service", "shipment-service", 9002, "local"],
    ["account-service", undefined, undefined, "remote"],
    ["Redis / PostgreSQL", undefined, undefined, "remote"],
  ];
  return seeds.map(([name, repo, port, mode], index) => ({
    id: `${taskId}-service-${index + 1}`,
    name,
    repo,
    port,
    mode,
    running: mode === "local" && running,
    configSource: `共享模板 · ${environment}`,
    templateVersion: "",
    // Recomputed from the environment layers on every projection so an edited
    // layer (shared / private / task) is what the service table reports.
    resolved: [] as ResolvedConfigEntry[],
  }));
}

function seedProjects(): Project[] {
  return [
    {
      id: "atlas",
      name: "Atlas Web",
      repositories: [
        { id: "front-monorepo", name: "front-monorepo", baseBranch: "main" },
        { id: "invoice-service", name: "invoice-service", baseBranch: "main" },
        { id: "shipment-service", name: "shipment-service", baseBranch: "release/2026.09" },
        { id: "apis", name: "apis", baseBranch: "main" },
      ],
      directories: [{ id: "atlas-docs", name: "Atlas 设计资料", path: "/Users/leonz3n/Workspace/atlas-docs" }],
      taskIds: ["release", "checkout", "legacy-auth", "design-docs"],
    },
    {
      id: "orbit",
      name: "Orbit API",
      repositories: [{ id: "orbit-api", name: "orbit-api", baseBranch: "main" }],
      directories: [],
      taskIds: ["latency"],
    },
  ];
}

const agentGreeting = "任务工作区已就绪，我可以开始检查构建与配置。";

function baseSession(id: string, name: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    name,
    archived: false,
    permission: "write",
    providerId: "provider-anthropic",
    model: "Claude Sonnet",
    contextUsed: 24.8,
    contextWindow: 200,
    tokens: 68.4,
    runState: "idle",
    unread: 0,
    lastActivity: "2026-09-22T09:40:00+08:00",
    messages: [],
    ...overrides,
  };
}

/**
 * A long, deterministic session history so the "all sessions" list is a real
 * dense scenario instead of a four-row fixture. Only the list is virtualized;
 * the four session tabs stay a small, un-virtualized collection.
 */
function historySessions(count: number, archivedFrom: number): Session[] {
  return Array.from({ length: count }, (_, index) =>
    baseSession(`history-${index + 1}`, `历史会话 ${String(index + 1).padStart(2, "0")}`, {
      archived: index >= archivedFrom,
      permission: index % 3 === 0 ? "read" : "write",
      lastActivity: `2026-09-${String(20 - (index % 20)).padStart(2, "0")}T${String(9 + (index % 9)).padStart(2, "0")}:00:00+08:00`,
    }),
  );
}

function taskAssets() {
  return {
    files: taskFileSeeds.map((file) => ({ ...file, preview: file.preview ? { ...file.preview } : undefined })),
    browserPages: taskBrowserPageSeeds.map((page) => ({ ...page })),
    terminalSeed: [...taskTerminalSeed],
  };
}

function seedSessions(): Record<string, Session[]> {
  return {
    release: [
      baseSession("main", "实现与验证", {
        unread: 2,
        messages: [
          { id: "m-1", role: "agent", text: agentGreeting },
          {
            id: "m-2",
            role: "agent",
            text: "依赖已安装，前端与 BFF 已启动。",
            code: {
              language: "bash",
              label: "本地启动",
              source: "pnpm --filter saas-web dev\npnpm --filter saas-bff dev",
            },
          },
          ...conversationHistory(),
        ],
      }),
      baseSession("deploy", "部署审查", {
        runState: "approval",
        messages: [
          { id: "m-3", role: "user", text: "把这次改动部署到 staging 检查一次。" },
          { id: "m-4", role: "agent", text: "部署会更新共享环境，需要你确认下面这条命令。" },
        ],
      }),
      baseSession("failed", "失败排查", {
        messages: [{ id: "m-5", role: "agent", text: "构建失败，我先保留现场。" }],
      }),
      baseSession("archived-1", "历史排查", { archived: true, permission: "read" }),
      ...historySessions(HISTORY_SESSION_COUNT, 40),
    ],
    checkout: [baseSession("main", "实现与验证")],
    "legacy-auth": [baseSession("main", "实现与验证", { archived: true })],
    latency: [baseSession("main", "实现与验证", { unread: 1 })],
  };
}

/** Long enough to overflow the conversation viewport for the anchor-follow check. */
function conversationHistory(): Message[] {
  return Array.from({ length: 30 }, (_, index) => ({
    id: `m-history-${index + 1}`,
    role: index % 2 === 0 ? ("user" as const) : ("agent" as const),
    text: `历史消息 ${index + 1}：确认构建、配置与运行状态的第 ${index + 1} 步结果。`,
  }));
}

function seedTasks(): Task[] {
  const sessions = seedSessions();
  const atlasDocs = toTaskDirectory({ id: "atlas-docs", name: "Atlas 设计资料", path: "/Users/leonz3n/Workspace/atlas-docs" });
  const tasks: Task[] = [
    {
      id: "release",
      projectId: "atlas",
      name: "发布前检查",
      workspaceKey: "task-a1f92c3d",
      workspaceRoot: defaultWorkspaceRoot,
      type: "normal",
      environmentId: "testing",
      templateVersion: "v12",
      repos: ["front-monorepo", "invoice-service", "shipment-service", "apis"],
      directories: [atlasDocs],
      configOverrides: [{ key: "LOCAL_PORT", value: "5173", secret: false }],
      archived: false,
      permission: "write",
      services: makeServices("release", "testing", true),
      sessions: sessions.release,
      activeSessionId: "main",
      unread: 2,
      ...taskAssets(),
    },
    {
      id: "checkout",
      projectId: "atlas",
      name: "结账页无障碍",
      workspaceKey: "task-b77e10aa",
      workspaceRoot: defaultWorkspaceRoot,
      type: "normal",
      environmentId: "testing",
      templateVersion: "v12",
      repos: ["front-monorepo"],
      directories: [],
      configOverrides: [],
      archived: false,
      permission: "write",
      services: makeServices("checkout", "testing", false),
      sessions: sessions.checkout,
      activeSessionId: "main",
      unread: 0,
      ...taskAssets(),
    },
    {
      id: "legacy-auth",
      projectId: "atlas",
      name: "旧登录重构",
      workspaceKey: "task-90cc41de",
      workspaceRoot: defaultWorkspaceRoot,
      type: "normal",
      environmentId: "dev",
      templateVersion: "v11",
      repos: ["front-monorepo", "apis"],
      directories: [],
      configOverrides: [],
      archived: true,
      permission: "read",
      services: makeServices("legacy-auth", "dev", false),
      sessions: sessions["legacy-auth"],
      activeSessionId: "main",
      unread: 0,
      ...taskAssets(),
      cleanupAvailableAt: "2026-09-18T10:00:00+08:00",
    },
    {
      id: "latency",
      projectId: "orbit",
      name: "排查延迟峰值",
      workspaceKey: "task-54ab77c1",
      workspaceRoot: defaultWorkspaceRoot,
      type: "normal",
      environmentId: "orbit-testing",
      templateVersion: "v4",
      repos: ["orbit-api"],
      directories: [],
      configOverrides: [],
      archived: false,
      permission: "write",
      services: makeServices("latency", "orbit-testing", false),
      sessions: sessions.latency,
      activeSessionId: "main",
      unread: 1,
      ...taskAssets(),
    },
    {
      // Ordinary-directory-only task: no Git worktree, so the task page has no
      // branch / remote / worktree / diff / commit entry points.
      id: "design-docs",
      projectId: "atlas",
      name: "设计资料整理",
      workspaceKey: "task-c4e21b90",
      workspaceRoot: defaultWorkspaceRoot,
      type: "normal",
      environmentId: "testing",
      templateVersion: "v12",
      repos: [],
      directories: [atlasDocs],
      configOverrides: [],
      archived: false,
      permission: "write",
      services: [],
      sessions: [baseSession("main", "实现与验证")],
      activeSessionId: "main",
      unread: 0,
      files: [],
      browserPages: [],
      terminalSeed: [],
    },
  ];
  return tasks;
}

/** Dense scheduled-run history so the execution log is a real long-list scenario. */
function seedScheduledRuns(): ScheduledRun[] {
  const results: ScheduledRun["result"][] = ["completed", "skipped", "failed"];
  const base: ScheduledRun[] = [
    { id: "run-1", scheduleId: "schedule-1", taskId: "release", sessionId: "scheduled-1", at: "2026-09-19T15:00:00+08:00", result: "completed" },
    { id: "run-2", scheduleId: "schedule-1", taskId: "release", sessionId: "scheduled-2", at: "2026-09-12T15:00:00+08:00", result: "completed" },
    { id: "run-3", scheduleId: "schedule-2", taskId: "latency", sessionId: "scheduled-3", at: "2026-09-18T09:15:00+08:00", result: "skipped" },
  ];
  const generated = Array.from({ length: 44 }, (_, index) => {
    const day = 19 - Math.floor(index / 3);
    return {
      id: `run-history-${index + 1}`,
      scheduleId: index % 4 === 0 ? "schedule-2" : "schedule-1",
      taskId: index % 4 === 0 ? "latency" : "release",
      sessionId: `scheduled-history-${index + 1}`,
      at: `2026-09-${String(Math.max(day, 1)).padStart(2, "0")}T09:15:00+08:00`,
      result: results[index % results.length],
    } satisfies ScheduledRun;
  });
  return [...base, ...generated];
}

/** Default cleanup checklist for an archived task; a task's own list overrides it. */
const baseCleanupItems: CleanupItem[] = [
  { resource: "代码", action: "保留到手动确认", detail: "worktree 含 2 个未推送提交" },
  { resource: "会话与草稿", action: "导出后删除", detail: "12 个会话，3 份草稿" },
  { resource: "用量", action: "保留汇总", detail: "明细保留 30 天" },
  { resource: "浏览器状态", action: "删除", detail: "Cookies 与页面快照" },
  { resource: "终端", action: "停止并删除", detail: "1 个已休眠终端" },
  { resource: "worktree", action: "暂不删除", detail: "等待代码处理确认" },
  { resource: "链接", action: "解除关联", detail: "保留外部资源本身" },
];

const cleanupByTask: Record<string, CleanupItem[]> = {
  "legacy-auth": baseCleanupItems,
};

class MemoryHost implements HostAdapter {
  private projects = seedProjects();
  private tasks = seedTasks();
  private environments = [
    {
      id: "testing",
      projectId: "atlas",
      name: "测试环境",
      templateVersion: "v12",
      variables: [{ key: "LOG_LEVEL", value: "debug", secret: false }],
      privateVariables: [{ key: "INVOICE_ACCESS_TOKEN", value: "iv_live_9f2c8ba7d41e", secret: true }],
    },
    {
      id: "dev",
      projectId: "atlas",
      name: "开发环境",
      templateVersion: "v11",
      variables: [{ key: "LOG_LEVEL", value: "info", secret: false }],
      privateVariables: [],
    },
    {
      id: "orbit-testing",
      projectId: "orbit",
      name: "测试环境",
      templateVersion: "v4",
      variables: [{ key: "LOG_LEVEL", value: "warn", secret: false }],
      privateVariables: [],
    },
  ];

  private providers = [
    {
      id: "provider-anthropic",
      name: "Anthropic 官方",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      models: [
        { id: "Claude Sonnet", contextWindow: 200 },
        { id: "Claude Haiku", contextWindow: 200 },
      ],
    },
    {
      id: "provider-openai",
      name: "OpenAI 兼容网关",
      protocol: "openai-responses",
      baseUrl: "https://gateway.example.com/v1",
      models: [{ id: "团队轻量模型", contextWindow: 16 }],
    },
    {
      id: "provider-local",
      name: "本地推理",
      protocol: "openai-chat-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
      models: [{ id: "本地 Qwen", contextWindow: 32 }],
    },
  ];

  private schedules: Schedule[] = [
    {
      id: "schedule-1",
      taskId: "release",
      name: "发布前检查",
      rule: "每周五 15:00",
      timezone: "Asia/Shanghai",
      prompt: "核对发布前检查清单：构建、测试、配置差异和待合并分支。",
      providerId: "provider-anthropic",
      model: "Claude Sonnet",
      permission: "write",
      enabled: true,
      nextRun: "2026-09-25T15:00:00+08:00",
    },
    {
      id: "schedule-2",
      taskId: "latency",
      name: "排查延迟峰值",
      rule: "每日 09:15",
      timezone: "Asia/Shanghai",
      prompt: "检查昨日延迟峰值与错误率，给出可疑改动列表。",
      providerId: "provider-openai",
      model: "团队轻量模型",
      permission: "read",
      enabled: false,
      nextRun: "已暂停",
    },
  ];

  private scheduledRuns: ScheduledRun[] = seedScheduledRuns();

  private capabilities: Capability[] = [
    { id: "cap-1", kind: "skill", name: "code-review", source: "项目 · .pi/skills", scope: "本任务工作区", status: "enabled" },
    { id: "cap-2", kind: "extension", name: "playwright-bridge", source: "项目 · .pi/extensions", scope: "本任务工作区", status: "enabled" },
    { id: "cap-3", kind: "package", name: "@pi/tools-git", source: "Pi Package · 1.8.2", scope: "全局", status: "update-available" },
    { id: "cap-4", kind: "mcp", name: "figma-context", source: "PiDock bridge · MCP Server", scope: "项目 atlas", status: "disabled" },
  ];

  private devices: RemoteDevice[] = [
    {
      id: "device-1",
      name: "iPhone 16 Pro",
      pairedAt: "2026-09-15T20:00:00+08:00",
      lastSeen: "2026-09-22T08:12:00+08:00",
      permissions: ["查看", "受限对话"],
      status: "active",
    },
    {
      id: "device-2",
      name: "旧 iPad",
      pairedAt: "2026-08-02T11:00:00+08:00",
      lastSeen: "2026-08-30T09:00:00+08:00",
      permissions: ["查看"],
      status: "revoked",
    },
  ];

  private usage = makeUsage(240);

  private approvals: Record<string, Approval> = {
    "approval-deploy": {
      id: "approval-deploy",
      taskId: "release",
      sessionId: "deploy",
      title: "部署到 Staging",
      command: "bun run deploy:staging",
      cwd: "/workspace/atlas-web",
      impact: "更新 staging.atlas.example.com，预计 2 分钟",
      payloadVersion: "v12+task-a1f92c3d",
      status: "pending",
      executed: false,
      requestedAt: "2026-09-22T09:30:00+08:00",
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    },
    "approval-migrate": {
      id: "approval-migrate",
      taskId: "release",
      sessionId: "deploy",
      title: "执行数据库迁移",
      command: "bun run db:migrate",
      cwd: "/workspace/atlas-api",
      impact: "变更共享测试库 schema",
      payloadVersion: "v12+task-a1f92c3d",
      status: "pending",
      executed: false,
      requestedAt: "2026-09-22T09:31:00+08:00",
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    },
  };

  private runs: Record<string, RunRecord> = {
    [sessionKeyOf("release", "failed")]: {
      id: "run-failed-1",
      taskId: "release",
      sessionId: "failed",
      state: "failed",
      startedAt: "2026-09-22T09:20:00+08:00",
      summary: "构建失败，已保留现场",
      failedScope: "构建步骤：front-monorepo web 包编译失败",
      steps: [
        { label: "安装依赖", state: "done" },
        { label: "启动 saas-web", state: "done" },
        { label: "构建 front-monorepo", state: "failed" },
        { label: "运行冒烟检查", state: "skipped" },
      ],
    },
  };

  private listeners = new Set<(event: HostEvent) => void>();

  private scripted: Record<string, "completed" | "failed" | "approval"> = {
    [sessionKeyOf("release", "failed")]: "failed",
    [sessionKeyOf("release", "deploy")]: "approval",
  };

  private tickMs = 6;

  private sequence = 0;

  private workspaceSequence = 0;

  private localSettings: LocalSettings = { ...defaultLocalSettings };

  private nextId(prefix: string) {
    this.sequence += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.sequence}`;
  }

  private emit(event: HostEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private task(taskId: string): Task | undefined {
    return this.tasks.find((item) => item.id === taskId);
  }

  private session(taskId: string, sessionId: string): Session | undefined {
    return this.task(taskId)?.sessions.find((item) => item.id === sessionId);
  }

  /** Stable, ASCII-only task workspace key (the prototype's `task-<8 位标识>`). */
  private nextWorkspaceKey(): string {
    this.workspaceSequence += 1;
    return `task-${(0x10000000 + this.workspaceSequence).toString(16).slice(0, 8)}`;
  }

  /**
   * Resolve a service's effective config from the layers (repository default,
   * shared template, machine private, task override, runtime port), keeping the
   * source of each row so the read-only view can report where it came from.
   */
  private resolveServiceConfig(task: Task, service: Service): ResolvedConfigEntry[] {
    const environment = this.environments.find((item) => item.id === task.environmentId);
    const rows = new Map<string, ResolvedConfigEntry>();
    const put = (key: string, value: string, source: string) =>
      rows.set(key, { key, value, source, secret: isSensitiveKey(key) });
    put(
      "API_BASE_URL",
      `https://${service.name}.${environment?.name ?? task.projectId}.atlas.example.com`,
      "仓库默认配置 · .env",
    );
    const layers: [ConfigScope, ConfigEntry[]][] = [
      ["shared", environment?.variables ?? []],
      ["private", environment?.privateVariables ?? []],
      ["task", task.configOverrides],
    ];
    for (const [scope, entries] of layers) {
      const source =
        scope === "shared"
          ? `共享模板 · ${environment?.name ?? "?"} · ${task.templateVersion}`
          : scope === "private"
            ? `本机私有配置 · ${this.localSettings.configFile}`
            : "任务覆盖";
      for (const entry of entries) {
        rows.set(entry.key, { ...entry, source, secret: entry.secret || isSensitiveKey(entry.key) });
      }
    }
    if (service.port) put("PORT", String(service.port), `运行时端口绑定 · ${service.mode === "local" ? "本地" : "远程"}`);
    return [...rows.values()];
  }

  /** Project a task with its current template version and freshly resolved config. */
  private projectTask(task: Task): Task {
    return {
      ...task,
      directories: task.directories.map((directory) => ({ ...directory })),
      configOverrides: task.configOverrides.map((entry) => ({ ...entry })),
      services: task.services.map((service) => ({
        ...service,
        templateVersion: task.templateVersion,
        resolved: this.resolveServiceConfig(task, service),
      })),
    };
  }

  async getWorkspace(): Promise<Workspace> {
    return {
      projects: this.projects.map((item) => ({ ...item, directories: item.directories.map((directory) => ({ ...directory })) })),
      tasks: this.tasks.map((item) => this.projectTask(item)),
      environments: this.environments.map((item) => ({ ...item })),
      providers: this.providers.map((item) => ({ ...item })),
      schedules: this.schedules.map((item) => ({ ...item })),
      scheduledRuns: this.scheduledRuns.map((item) => ({ ...item })),
      capabilities: this.capabilities.map((item) => ({ ...item })),
      devices: this.devices.map((item) => ({ ...item })),
      templates: scheduleTemplates.map((item) => ({ ...item })),
    };
  }

  async getProject(projectId: string) {
    const project = this.projects.find((item) => item.id === projectId);
    return project ? { ...project, directories: project.directories.map((directory) => ({ ...directory })) } : undefined;
  }

  async getTask(taskId: string) {
    const task = this.task(taskId);
    return task ? this.projectTask(task) : undefined;
  }

  async getSession(taskId: string, sessionId: string) {
    return this.session(taskId, sessionId);
  }

  async getRun(taskId: string, sessionId: string) {
    return this.runs[sessionKeyOf(taskId, sessionId)];
  }

  async getAttention(): Promise<AttentionItem[]> {
    const items: AttentionItem[] = [];
    // One item per pending approval, not one per session of its task.
    for (const approval of Object.values(this.approvals)) {
      if (approval.status !== "pending") continue;
      const task = this.task(approval.taskId);
      if (!task) continue;
      const project = this.projects.find((item) => item.id === task.projectId);
      items.push({
        id: `attention-approval-${approval.id}`,
        kind: "approval",
        projectId: task.projectId,
        taskId: task.id,
        sessionId: approval.sessionId,
        label: `${project?.name ?? task.projectId} · ${task.name}`,
        detail: `待确认：${approval.title}`,
      });
    }
    for (const task of this.tasks) {
      const project = this.projects.find((item) => item.id === task.projectId);
      for (const session of task.sessions) {
        const failed = this.runs[sessionKeyOf(task.id, session.id)];
        if (failed?.state === "failed") {
          items.push({
            id: `attention-failed-${failed.id}`,
            kind: "failed",
            projectId: task.projectId,
            taskId: task.id,
            sessionId: session.id,
            label: `${project?.name ?? task.projectId} · ${task.name}`,
            detail: `执行失败：${failed.failedScope ?? failed.summary}`,
          });
        }
        if (session.unread > 0 && session.runState === "completed") {
          items.push({
            id: `attention-unread-${task.id}-${session.id}`,
            kind: "completed-unread",
            projectId: task.projectId,
            taskId: task.id,
            sessionId: session.id,
            label: `${project?.name ?? task.projectId} · ${task.name}`,
            detail: `完成未读：${session.name}`,
          });
        }
      }
    }
    return items;
  }

  async getUsage(filter: UsageFilter = {}) {
    return this.usage.filter((record) => {
      if (filter.taskId && record.taskId !== filter.taskId) return false;
      if (filter.projectId && record.projectId !== filter.projectId) return false;
      if (filter.providerId && record.providerId !== filter.providerId) return false;
      if (filter.sessionId && record.sessionId !== filter.sessionId) return false;
      if (filter.from && record.at < filter.from) return false;
      if (filter.to && record.at > filter.to) return false;
      return true;
    });
  }

  async sendMessage(
    taskId: string,
    sessionId: string,
    text: string,
    references: Reference[],
  ): Promise<SendMessageResult> {
    const task = this.task(taskId);
    const session = this.session(taskId, sessionId);
    if (!task || !session) throw new Error("会话不存在");
    if (session.runState === "running") throw new Error("当前会话正在执行，请先停止");

    const userMessage = {
      id: this.nextId("msg-user"),
      role: "user" as const,
      text,
      references,
    };
    session.messages = [...session.messages, userMessage];
    session.runState = "running";
    const record: RunRecord = {
      id: this.nextId("run"),
      taskId,
      sessionId,
      state: "running",
      startedAt: new Date().toISOString(),
      summary: "正在执行",
      steps: [
        { label: "读取任务上下文", state: "done" },
        { label: "运行工具", state: "pending" },
      ],
    };
    this.runs[sessionKeyOf(taskId, sessionId)] = record;
    this.emit({ type: "run-state", taskId, sessionId, state: "running", record });

    const agentMessageId = this.nextId("msg-agent");
    const chunks = ["正在准备环境", "，随后执行构建与检查", "…"];
    for (const delta of chunks) {
      await new Promise((resolve) => setTimeout(resolve, this.tickMs));
      this.emit({ type: "message-delta", taskId, sessionId, messageId: agentMessageId, delta });
    }

    const outcome = this.scripted[sessionKeyOf(taskId, sessionId)] ?? "completed";
    let finalState: RunState = "completed";
    if (outcome === "failed") {
      finalState = "failed";
      record.state = "failed";
      record.summary = "构建失败，已保留现场";
      record.failedScope = "构建步骤：front-monorepo web 包编译失败";
      record.steps = [
        { label: "安装依赖", state: "done" },
        { label: "启动 saas-web", state: "done" },
        { label: "构建 front-monorepo", state: "failed" },
        { label: "运行冒烟检查", state: "skipped" },
      ];
    } else if (outcome === "approval") {
      finalState = "approval";
      record.state = "approval";
      record.summary = "等待确认";
      record.steps = [
        { label: "读取任务上下文", state: "done" },
        { label: "执行部署命令", state: "pending" },
      ];
      const approval: Approval = {
        id: this.nextId("approval"),
        taskId,
        sessionId,
        title: "部署到 Staging",
        command: "bun run deploy:staging",
        cwd: "/workspace/atlas-web",
        impact: "更新 staging.atlas.example.com，预计 2 分钟",
        payloadVersion: `v12+${task.workspaceKey}`,
        status: "pending",
        executed: false,
        requestedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
      };
      this.approvals[approval.id] = approval;
      this.emit({ type: "approval", taskId, sessionId, approval });
    }

    session.runState = finalState;
    const reply =
      finalState === "failed"
        ? "构建失败，我先保留现场和你的输入，修复后可以继续。"
        : finalState === "approval"
          ? "这条命令会改动共享环境，请先确认。"
          : `已按「${text}」完成检查。`;
    session.messages = [
      ...session.messages,
      {
        id: agentMessageId,
        role: "agent",
        text: reply,
      },
    ];
    this.emit({ type: "message-done", taskId, sessionId, messageId: agentMessageId });
    this.emit({ type: "run-state", taskId, sessionId, state: finalState, record });
    return { state: finalState, run: record };
  }

  async stopRun(taskId: string, sessionId: string) {
    const session = this.session(taskId, sessionId);
    if (!session) return;
    session.runState = "stopped";
    const record = this.runs[sessionKeyOf(taskId, sessionId)];
    if (record) record.state = "stopped";
    this.emit({ type: "run-state", taskId, sessionId, state: "stopped", record });
  }

  async createSession(taskId: string) {
    const task = this.task(taskId);
    if (!task) throw new Error("任务不存在");
    const session: Session = {
      id: this.nextId("session"),
      name: "新会话",
      archived: false,
      permission: task.permission,
      providerId: this.providers[0].id,
      model: this.providers[0].models[0].id,
      contextUsed: 0,
      contextWindow: this.providers[0].models[0].contextWindow,
      tokens: 0,
      runState: "idle",
      unread: 0,
      lastActivity: new Date().toISOString(),
      messages: [],
    };
    task.sessions = [...task.sessions, session];
    task.activeSessionId = session.id;
    return session;
  }

  async renameSession(taskId: string, sessionId: string, name: string) {
    const session = this.session(taskId, sessionId);
    if (session) session.name = name;
  }

  async renameTask(taskId: string, name: string) {
    const task = this.task(taskId);
    if (!task) return;
    task.name = name;
    const schedule = this.schedules.find((item) => item.taskId === taskId);
    if (schedule) schedule.name = name;
  }

  async setSessionArchived(taskId: string, sessionId: string, archived: boolean) {
    const session = this.session(taskId, sessionId);
    if (!session) return;
    if (archived && (session.runState === "running" || session.runState === "approval")) {
      throw new Error("请先停止会话执行，再归档");
    }
    session.archived = archived;
  }

  async archiveTask(taskId: string) {
    const task = this.task(taskId);
    if (!task) return;
    task.archived = true;
    task.services = task.services.map((service) => ({ ...service, running: false }));
    task.sessions = task.sessions.map((session) =>
      session.runState === "approval" ? { ...session, runState: "expired" as const } : session,
    );
    for (const approval of Object.values(this.approvals)) {
      if (approval.taskId === taskId && approval.status === "pending") {
        approval.status = "expired";
        this.emit({ type: "approval", taskId, sessionId: approval.sessionId, approval });
      }
    }
    const schedule = this.schedules.find((item) => item.taskId === taskId);
    if (schedule) {
      schedule.enabled = false;
      schedule.nextRun = "已暂停";
    }
  }

  async restoreTask(taskId: string) {
    const task = this.task(taskId);
    if (task) task.archived = false;
  }

  async listApprovals(taskId: string) {
    return Object.values(this.approvals).filter((approval) => approval.taskId === taskId);
  }

  async getApproval(approvalId: string) {
    return this.approvals[approvalId];
  }

  async resolveApproval(approvalId: string, status: ApprovalStatus) {
    const approval = this.approvals[approvalId];
    if (!approval) throw new Error("确认请求不存在");
    const executable = status === "approved";
    const next: Approval = { ...approval, status, executed: executable };
    this.approvals[approvalId] = next;
    const session = this.session(next.taskId, next.sessionId);
    if (session) {
      session.runState =
        status === "approved" ? "running" : status === "expired" ? "expired" : "rejected";
    }
    const record = this.runs[sessionKeyOf(next.taskId, next.sessionId)];
    if (record) {
      record.state = status === "approved" ? "running" : status === "expired" ? "expired" : "rejected";
    }
    this.emit({ type: "approval", taskId: next.taskId, sessionId: next.sessionId, approval: next });
    return next;
  }

  async simulateExpiry(approvalId: string) {
    return this.resolveApproval(approvalId, "expired");
  }

  async setServiceRunning(taskId: string, serviceId: string, running: boolean) {
    const task = this.task(taskId);
    const service = task?.services.find((item) => item.id === serviceId);
    if (service) service.running = running;
  }

  async getSchedules() {
    return this.schedules.map((item) => ({ ...item }));
  }

  async setScheduleEnabled(scheduleId: string, enabled: boolean) {
    const schedule = this.schedules.find((item) => item.id === scheduleId);
    if (!schedule) return;
    schedule.enabled = enabled;
    schedule.nextRun = enabled ? "2026-09-25T15:00:00+08:00" : "已暂停";
    const task = this.task(schedule.taskId);
    if (task?.archived && enabled) throw new Error("已归档任务不能直接启用调度，请先恢复任务");
  }

  async runScheduleNow(scheduleId: string) {
    const schedule = this.schedules.find((item) => item.id === scheduleId);
    if (!schedule) throw new Error("定时任务不存在");
    const task = this.task(schedule.taskId);
    if (task?.archived) throw new Error("已归档任务不能通过「立即运行」绕过恢复");
    const session = await this.createSession(schedule.taskId);
    session.name = `${schedule.name} · ${new Date().toLocaleDateString("zh-CN")}`;
    const run: ScheduledRun = {
      id: this.nextId("run"),
      scheduleId,
      taskId: schedule.taskId,
      sessionId: session.id,
      at: new Date().toISOString(),
      result: "completed",
    };
    this.scheduledRuns = [run, ...this.scheduledRuns];
    return run;
  }

  async getCapabilities() {
    return this.capabilities.map((item) => ({ ...item }));
  }

  async setCapabilityEnabled(capabilityId: string, enabled: boolean) {
    const capability = this.capabilities.find((item) => item.id === capabilityId);
    if (capability) capability.status = enabled ? "enabled" : "disabled";
  }

  async getRemoteDevices() {
    return this.devices.map((item) => ({ ...item }));
  }

  async revokeRemoteDevice(deviceId: string) {
    const device = this.devices.find((item) => item.id === deviceId);
    if (device) device.status = "revoked";
  }

  async previewCleanup(taskId: string): Promise<CleanupItem[]> {
    const task = this.task(taskId);
    if (!task) throw new Error("任务不存在");
    if (!task.archived) throw new Error("只有已归档任务可清理");
    const items = (cleanupByTask[taskId] ?? baseCleanupItems).map((item) => ({ ...item }));
    // Ordinary directories: cleanup only removes the in-task symlink and keeps
    // the original directory and every file in it.
    for (const directory of task.directories) {
      items.push({
        resource: `普通目录 · ${directory.name}`,
        action: "移除任务内软链接",
        detail: `保留原目录 ${directory.path} 及其全部文件`,
      });
    }
    return items;
  }

  async getLocalSettings(): Promise<LocalSettings> {
    return { ...this.localSettings };
  }

  async setWorkspaceRoot(workspaceRoot: string): Promise<LocalSettings> {
    const value = workspaceRoot.trim();
    if (!value) throw new Error("请填写完整的任务根目录");
    // Restored from the prototype's `validWorkspaceRoot`: a non-absolute root
    // would create task folders relative to the process working directory.
    if (!validWorkspaceRoot(value)) throw new Error("请填写完整的任务根目录，例如 /Users/name/Tasks 或 D:\\Tasks");
    this.localSettings = { ...this.localSettings, workspaceRoot: value };
    return { ...this.localSettings };
  }

  async createFileReference(taskId: string): Promise<Reference> {
    const file = this.task(taskId)?.files[0];
    return {
      id: this.nextId("ref"),
      kind: "file",
      label: file?.path ?? "工作区文件",
      detail: "当前任务工作区文件",
    };
  }

  async createDirectoryFileReference(taskId: string, directoryId: string): Promise<Reference> {
    const task = this.task(taskId);
    const directory = task?.directories.find((item) => item.id === directoryId);
    if (!task || !directory) throw new Error("目录不存在");
    return {
      id: this.nextId("ref"),
      kind: "directory",
      label: `${directory.linkName}/README.md`,
      detail: `${directoryLinkPath(task.workspaceRoot, task.workspaceKey, directory)} → ${directory.path} · 示例引用，尚未读取`,
    };
  }

  async saveEnvironmentConfig({ environmentId, scope, rows, taskId }: SaveEnvironmentConfigInput): Promise<void> {
    const entries: ConfigEntry[] = rows.map((row) => ({
      key: row.key.trim(),
      value: row.value,
      secret: isSensitiveKey(row.key.trim()),
    }));
    if (scope === "task") {
      const task = taskId ? this.task(taskId) : undefined;
      if (!task) throw new Error("任务不存在");
      task.configOverrides = entries;
      return;
    }
    const environment = this.environments.find((item) => item.id === environmentId);
    if (!environment) throw new Error("环境不存在");
    if (scope === "shared") {
      // A shared-template save always produces a new version; tasks keep their
      // recorded version until they explicitly adopt the new one.
      environment.variables = entries;
      environment.templateVersion = nextTemplateVersion(environment.templateVersion);
      return;
    }
    environment.privateVariables = entries;
  }

  async adoptLatestTemplate(taskId: string): Promise<void> {
    const task = this.task(taskId);
    if (!task) throw new Error("任务不存在");
    const environment = this.environments.find((item) => item.id === task.environmentId);
    if (environment) task.templateVersion = environment.templateVersion;
  }

  async setProjectDirectories(projectId: string, rows: ProjectDirectoryInput[]): Promise<ProjectDirectory[]> {
    const project = this.projects.find((item) => item.id === projectId);
    if (!project) throw new Error("项目不存在");
    const seen = new Set<string>();
    const next: ProjectDirectory[] = [];
    for (const row of rows) {
      const name = row.name.trim();
      const path = row.path.trim();
      if (!name || !validWorkspaceRoot(path)) throw new Error("请填写每个普通目录的名称和完整路径");
      const normalized = normalizeDirectoryPath(path);
      if (seen.has(normalized)) throw new Error("请勿重复添加同一路径");
      seen.add(normalized);
      next.push({ id: row.id ?? this.nextId("dir"), name, path });
    }
    // A directory referenced by any task is locked: its name and path must not
    // change silently underneath an in-flight task.
    for (const task of this.tasks) {
      if (task.projectId !== projectId) continue;
      for (const directory of task.directories) {
        const updated = next.find((item) => item.id === directory.id);
        if (!updated || updated.name !== directory.name || updated.path !== directory.path) {
          throw new Error("任务使用中的普通目录不能修改名称或路径");
        }
      }
    }
    project.directories = next;
    return next.map((item) => ({ ...item }));
  }

  async setTaskDirectories(taskId: string, directoryIds: string[]): Promise<void> {
    const task = this.task(taskId);
    if (!task) throw new Error("任务不存在");
    const project = this.projects.find((item) => item.id === task.projectId);
    const existing = new Map(task.directories.map((directory) => [directory.id, directory]));
    task.directories = directoryIds.map((id) => {
      const prior = existing.get(id);
      if (prior) return prior;
      const registered = project?.directories.find((item) => item.id === id);
      if (!registered) throw new Error("目录不存在");
      return toTaskDirectory(registered);
    });
  }

  async createTask({ projectId, name, repoIds, directoryIds, environmentId }: CreateTaskInput): Promise<Task> {
    const project = this.projects.find((item) => item.id === projectId);
    if (!project) throw new Error("项目不存在");
    const taskName = name.trim();
    if (!taskName) throw new Error("请填写任务名称");
    const repos = repoIds.filter((id) => project.repositories.some((repository) => repository.id === id));
    const directories = directoryIds.map((id) => {
      const registered = project.directories.find((directory) => directory.id === id);
      if (!registered) throw new Error("目录不存在");
      return toTaskDirectory(registered);
    });
    const targetEnvironmentId = environmentId ?? this.environments.find((item) => item.projectId === projectId)?.id ?? "";
    const environment = this.environments.find((item) => item.id === targetEnvironmentId);
    const id = this.nextId("task");
    const assets = taskAssets();
    const task: Task = {
      id,
      projectId,
      name: taskName,
      workspaceKey: this.nextWorkspaceKey(),
      workspaceRoot: this.localSettings.workspaceRoot,
      type: "normal",
      environmentId: targetEnvironmentId,
      templateVersion: environment?.templateVersion ?? "",
      repos,
      directories,
      configOverrides: [],
      archived: false,
      permission: "write",
      services: repos.length > 0 ? makeServices(id, environment?.name ?? "", false) : [],
      sessions: [baseSession("main", "实现与验证")],
      activeSessionId: "main",
      unread: 0,
      files: repos.length > 0 ? assets.files : [],
      browserPages: repos.length > 0 ? assets.browserPages : [],
      terminalSeed: repos.length > 0 ? assets.terminalSeed : [],
    };
    this.tasks.push(task);
    project.taskIds = [...project.taskIds, id];
    return this.projectTask(task);
  }

  async runTerminalCommand(taskId: string, command: string): Promise<string[]> {
    if (!this.task(taskId)) throw new Error("任务不存在");
    return [`$ ${command}`, "命令已加入模拟队列"];
  }

  subscribe(listener: (event: HostEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function createMemoryHost(): HostAdapter {
  return new MemoryHost();
}

export const memoryHost = createMemoryHost();
