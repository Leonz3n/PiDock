import type {
  Approval,
  ApprovalStatus,
  AttentionItem,
  Capability,
  CleanupItem,
  HostEvent,
  Project,
  Reference,
  RemoteDevice,
  RunRecord,
  RunState,
  Schedule,
  ScheduleTemplate,
  ScheduledRun,
  Session,
  Task,
  UsageRecord,
  Workspace,
} from "./types";
import type { HostAdapter, SendMessageResult, UsageFilter } from "./hostAdapter";

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

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

function resolvedConfig(service: string, environment: string) {
  return [
    {
      key: "API_BASE_URL",
      value: `https://${service}.${environment}.atlas.example.com`,
      source: `共享模板 · ${environment} · v12`,
      secret: false,
    },
    { key: "FEATURE_CHECKOUT_V2", value: "false", source: "仓库默认配置 · .env", secret: false },
    { key: "LOCAL_PORT", value: "5173", source: "任务覆盖", secret: false },
    {
      key: "INVOICE_ACCESS_TOKEN",
      value: "iv_live_9f2c8ba7d41e",
      source: "本机私有配置 · ~/.pi/dock/config.json",
      secret: true,
    },
  ];
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
    configSource: `共享模板 · ${environment} · v12`,
    templateVersion: "v12",
    resolved: resolvedConfig(name, environment),
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
      directories: ["/Users/leonz3n/Workspace/atlas-docs"],
      taskIds: ["release", "checkout", "legacy-auth"],
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

function seedSessions(): Record<string, Session[]> {
  const base = (id: string, name: string, overrides: Partial<Session> = {}): Session => ({
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
  });

  return {
    release: [
      base("main", "实现与验证", {
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
        ],
      }),
      base("deploy", "部署审查", {
        runState: "approval",
        messages: [
          { id: "m-3", role: "user", text: "把这次改动部署到 staging 检查一次。" },
          { id: "m-4", role: "agent", text: "部署会更新共享环境，需要你确认下面这条命令。" },
        ],
      }),
      base("failed", "失败排查", {
        messages: [{ id: "m-5", role: "agent", text: "构建失败，我先保留现场。" }],
      }),
      base("archived-1", "历史排查", { archived: true, permission: "read" }),
    ],
    checkout: [base("main", "实现与验证")],
    "legacy-auth": [base("main", "实现与验证", { archived: true })],
    latency: [base("main", "实现与验证", { unread: 1 })],
  };
}

function seedTasks(): Task[] {
  const sessions = seedSessions();
  const tasks: Task[] = [
    {
      id: "release",
      projectId: "atlas",
      name: "发布前检查",
      workspaceKey: "task-a1f92c3d",
      type: "normal",
      environmentId: "testing",
      repos: ["front-monorepo", "invoice-service", "shipment-service", "apis"],
      directories: ["/Users/leonz3n/Workspace/atlas-docs"],
      archived: false,
      permission: "write",
      services: makeServices("release", "testing", true),
      sessions: sessions.release,
      activeSessionId: "main",
      unread: 2,
    },
    {
      id: "checkout",
      projectId: "atlas",
      name: "结账页无障碍",
      workspaceKey: "task-b77e10aa",
      type: "normal",
      environmentId: "testing",
      repos: ["front-monorepo"],
      directories: [],
      archived: false,
      permission: "write",
      services: makeServices("checkout", "testing", false),
      sessions: sessions.checkout,
      activeSessionId: "main",
      unread: 0,
    },
    {
      id: "legacy-auth",
      projectId: "atlas",
      name: "旧登录重构",
      workspaceKey: "task-90cc41de",
      type: "normal",
      environmentId: "dev",
      repos: ["front-monorepo", "apis"],
      directories: [],
      archived: true,
      permission: "read",
      services: makeServices("legacy-auth", "dev", false),
      sessions: sessions["legacy-auth"],
      activeSessionId: "main",
      unread: 0,
      cleanupAvailableAt: "2026-09-18T10:00:00+08:00",
    },
    {
      id: "latency",
      projectId: "orbit",
      name: "排查延迟峰值",
      workspaceKey: "task-54ab77c1",
      type: "normal",
      environmentId: "orbit-testing",
      repos: ["orbit-api"],
      directories: [],
      archived: false,
      permission: "write",
      services: makeServices("latency", "orbit-testing", false),
      sessions: sessions.latency,
      activeSessionId: "main",
      unread: 1,
    },
  ];
  return tasks;
}

const cleanupByTask: Record<string, CleanupItem[]> = {
  "legacy-auth": [
    { resource: "代码", action: "保留到手动确认", detail: "worktree 含 2 个未推送提交" },
    { resource: "会话与草稿", action: "导出后删除", detail: "12 个会话，3 份草稿" },
    { resource: "用量", action: "保留汇总", detail: "明细保留 30 天" },
    { resource: "浏览器状态", action: "删除", detail: "Cookies 与页面快照" },
    { resource: "终端", action: "停止并删除", detail: "1 个已休眠终端" },
    { resource: "worktree", action: "暂不删除", detail: "等待代码处理确认" },
    { resource: "链接", action: "解除关联", detail: "保留外部资源本身" },
  ],
};

class MemoryHost implements HostAdapter {
  readonly kind = "memory";

  private projects = seedProjects();
  private tasks = seedTasks();
  private environments = [
    {
      id: "testing",
      projectId: "atlas",
      name: "测试环境",
      templateVersion: "v12",
      variables: [
        { key: "API_BASE_URL", value: "https://api.testing.atlas.example.com", secret: false, source: "共享模板 v12" },
        { key: "LOG_LEVEL", value: "debug", secret: false, source: "共享模板 v12" },
        { key: "INVOICE_ACCESS_TOKEN", value: "iv_live_9f2c8ba7d41e", secret: true, source: "本机私有配置" },
      ],
    },
    {
      id: "dev",
      projectId: "atlas",
      name: "开发环境",
      templateVersion: "v11",
      variables: [
        { key: "API_BASE_URL", value: "https://api.dev.atlas.example.com", secret: false, source: "共享模板 v11" },
        { key: "LOG_LEVEL", value: "info", secret: false, source: "仓库默认配置" },
      ],
    },
    {
      id: "orbit-testing",
      projectId: "orbit",
      name: "测试环境",
      templateVersion: "v4",
      variables: [{ key: "API_BASE_URL", value: "https://api.testing.orbit.example.com", secret: false, source: "共享模板 v4" }],
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

  private scheduledRuns: ScheduledRun[] = [
    { id: "run-1", scheduleId: "schedule-1", taskId: "release", sessionId: "scheduled-1", at: "2026-09-19T15:00:00+08:00", result: "completed" },
    { id: "run-2", scheduleId: "schedule-1", taskId: "release", sessionId: "scheduled-2", at: "2026-09-12T15:00:00+08:00", result: "completed" },
    { id: "run-3", scheduleId: "schedule-2", taskId: "latency", sessionId: "scheduled-3", at: "2026-09-18T09:15:00+08:00", result: "skipped" },
  ];

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
    "release:failed": {
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
    "release:failed": "failed",
    "release:deploy": "approval",
  };

  private tickMs = 6;

  private sequence = 0;

  private nextId(prefix: string) {
    this.sequence += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.sequence}`;
  }

  getTickMs() {
    return this.tickMs;
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

  async getWorkspace(): Promise<Workspace> {
    return {
      projects: this.projects.map((item) => ({ ...item })),
      tasks: this.tasks.map((item) => ({ ...item })),
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
    return this.projects.find((item) => item.id === projectId);
  }

  async getTask(taskId: string) {
    return this.task(taskId);
  }

  async getSession(taskId: string, sessionId: string) {
    return this.session(taskId, sessionId);
  }

  async getRun(taskId: string, sessionId: string) {
    return this.runs[`${taskId}:${sessionId}`];
  }

  async getAttention(): Promise<AttentionItem[]> {
    const items: AttentionItem[] = [];
    for (const task of this.tasks) {
      for (const session of task.sessions) {
        const project = this.projects.find((item) => item.id === task.projectId);
        const pending = Object.values(this.approvals).find(
          (approval) => approval.taskId === task.id && approval.status === "pending",
        );
        if (pending) {
          items.push({
            id: `attention-approval-${pending.id}`,
            kind: "approval",
            projectId: task.projectId,
            taskId: task.id,
            sessionId: pending.sessionId,
            label: `${project?.name ?? task.projectId} · ${task.name}`,
            detail: `待确认：${pending.title}`,
          });
        }
        const failed = this.runs[`${task.id}:${session.id}`];
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
    this.runs[`${taskId}:${sessionId}`] = record;
    this.emit({ type: "run-state", taskId, sessionId, state: "running", record });

    const agentMessageId = this.nextId("msg-agent");
    const chunks = ["正在准备环境", "，随后执行构建与检查", "…"];
    for (const delta of chunks) {
      await new Promise((resolve) => setTimeout(resolve, this.tickMs));
      this.emit({ type: "message-delta", taskId, sessionId, messageId: agentMessageId, delta });
    }

    const outcome = this.scripted[`${taskId}:${sessionId}`] ?? "completed";
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
    const record = this.runs[`${taskId}:${sessionId}`];
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
    const record = this.runs[`${next.taskId}:${next.sessionId}`];
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
    const items = cleanupByTask[taskId];
    if (!items) throw new Error("清理清单尚未生成");
    return items.map((item) => ({ ...item }));
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
export type { RunState };
