import type {
  Approval,
  ApprovalStatus,
  AttentionItem,
  BrowserPage,
  Capability,
  CleanupItem,
  ConfigEntry,
  ConfigScope,
  Environment,
  HostEvent,
  LocalSettings,
  Message,
  Permission,
  ServiceMode,
  Project,
  ProjectDirectory,
  ProviderDiscoveryView,
  ProviderProfile,
  Reference,
  RemoteDevice,
  Repository,
  ResolvedConfigEntry,
  RunRecord,
  RunState,
  Schedule,
  ScheduleTemplate,
  ScheduledRun,
  Service,
  ServiceFailureView,
  ServiceRecipe,
  ServiceRunView,
  Session,
  Subagent,
  Task,
  TaskWriteLockView,
  UsageRecord,
  Workspace,
  WorkspaceFile,
} from "./types";
import type {
  AddCapabilityInput,
  AddTaskSourcesInput,
  CreateTaskInput,
  HostAdapter,
  ProjectDirectoryInput,
  ProvisionTaskInput,
  SaveEnvironmentConfigInput,
  SaveEnvironmentInput,
  SaveProjectInput,
  SaveProviderInput,
  SaveScheduleInput,
  SaveServiceRecipeInput,
  SendMessageResult,
  TaskHeaderState,
  TaskProvisionState,
  UsageFilter,
} from "./hostAdapter";
import { sessionKeyOf } from "./sessionKey";
import { sessionWriteStates, type SessionWriteState } from "./writeCoordination";
import { projectServiceTopology, type ServiceTopologyView } from "./serviceTopology";
import { isSensitiveKey, nextTemplateVersion } from "./configRows";
import {
  PROTOCOL_MODEL_FIXTURES,
  evaluateSessionModelSwitch,
  evaluateThinkingSelection,
  resolveSessionThinking,
  syncModelCandidates,
  validateProviderDraft,
  type DiscoveryTransport,
} from "./providerState";
import {
  buildTaskFormBranch,
  checkTaskFormDirIdConflict,
  directoryLinkName,
  directoryLinkPath,
  isAbsoluteTaskFormRoot,
  isTaskDirId,
  normalizeDirectoryPath,
  pinTaskFormBaseline,
  previewTaskFormPaths,
  resolveTaskFormRoot,
  toTaskDirectory,
  validateTaskFormName,
} from "./directories";

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

interface TaskLocks {
  /** taskId -> owner sessionId currently holding the task write right. */
  locks: Map<string, string>;
  /**
   * [PiDock 09] (#11) taskId -> sessions queued behind the holder, in queue
   * order. The queue is display state: the holder's stop/release clears it, and
   * a queued session writes as soon as it retries.
   */
  waiting: Map<string, string[]>;
}

const taskLocks: TaskLocks = { locks: new Map(), waiting: new Map() };

/** Test seam: reset cross-session task locks. */
export function resetTaskLocksForTests(): void {
  taskLocks.locks.clear();
  taskLocks.waiting.clear();
}

export function taskLockOwner(taskId: string): string | undefined {
  return taskLocks.locks.get(taskId);
}

/** Local application settings live on the machine, not in a project shared template. */
export const defaultWorkspaceRoot = "~/PiDockTasks";

/**
 * [PiDock 09] (#11) coordination view of one task, computed from the module
 * lock state: holder + claim label, queue order and read-only sessions. The
 * memory adapter spawns no agent-owned process, so `orphans`/`derived` stay
 * empty here (the shell adapter reports the real ones from the Host).
 */
export function memoryWriteLockView(task: Task): TaskWriteLockView {
  // The right is held by a live turn (running or waiting on a confirmation):
  // the mirror tracks it explicitly in `taskLocks`, it is not inferred from a
  // persisted session state (a restored task maps a stale approval to a
  // cancellation, so a session alone never implies a holder).
  const owner = taskLocks.locks.get(task.id) ?? null;
  const waiting = owner === null ? [] : [...(taskLocks.waiting.get(task.id) ?? [])].filter((sessionId) => sessionId !== owner);
  return {
    owner,
    waiting,
    ...(owner !== null ? { ownerLabel: memoryOwnerLabel(task, owner) } : {}),
    orphans: [],
    derived: [],
  };
}

function memoryOwnerLabel(task: Task, sessionId: string): string {
  const session = task.sessions.find((item) => item.id === sessionId);
  if (session?.runState === "approval") return "等待确认";
  if (session?.runState === "running") return "回合执行中";
  return "任务写操作";
}

/** Enqueue a session behind the current holder (bounded, deduplicated, FIFO). */
function noteWriteWait(taskId: string, sessionId: string): void {
  const current = taskLocks.waiting.get(taskId) ?? [];
  if (current.includes(sessionId) || current.length >= 8) return;
  taskLocks.waiting.set(taskId, [...current, sessionId]);
}

/** The holder's release frees the queue: nobody waits on a free right. */
function clearWriteWaits(taskId: string): void {
  taskLocks.waiting.delete(taskId);
}

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

/** Deterministic output length for the [PiDock 02] per-call usage record. */
function replyLength(state: string, text: string): number {
  if (state === "failed") return 64;
  if (state === "approval") return 48;
  return text.length * 3;
}

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

/**
 * [PiDock 05] (#10) seed services for one task. Ports are allocated against
 * the tasks that already exist, so two tasks running the same service name
 * get different local ports (box 3) — the second `saas-web` starts at 5174
 * instead of silently sharing 5173 with the first task's instance.
 *
 * Dependencies are seeded as data: `call` for the invoker → callee edges,
 * `prestart` for the migration step (a `prepare` unit that must finish
 * first), and a bidirectional pair (invoice ↔ shipment) that the start-group
 * projection merges into one listener group. Run records and the failure
 * fixture are simulated (this whole adapter is fixture data); they carry
 * `simulated: true` so the panel can label them.
 */
function makeServices(taskId: string, environment: string, running: boolean, existing: readonly Task[]) {
  const seeds: {
    name: string;
    repo?: string;
    preferred?: number;
    mode: "local" | "remote";
    runType: "long-lived" | "prepare" | "one-shot";
    dependencies: { to: string; kind: "call" | "prestart" }[];
  }[] = [
    { name: "saas-web", repo: "front-monorepo", preferred: 5173, mode: "local", runType: "long-lived", dependencies: [{ to: "saas-bff", kind: "call" }] },
    {
      name: "saas-bff",
      repo: "front-monorepo",
      preferred: 3001,
      mode: "local",
      runType: "long-lived",
      dependencies: [
        { to: "db-migrate", kind: "prestart" },
        { to: "invoice-service", kind: "call" },
        { to: "account-service", kind: "call" },
      ],
    },
    { name: "invoice-service", repo: "invoice-service", preferred: 9001, mode: "local", runType: "long-lived", dependencies: [{ to: "shipment-service", kind: "call" }] },
    { name: "shipment-service", repo: "shipment-service", preferred: 9002, mode: "local", runType: "long-lived", dependencies: [{ to: "invoice-service", kind: "call" }] },
    { name: "db-migrate", repo: "invoice-service", mode: "local", runType: "prepare", dependencies: [] },
    { name: "account-service", mode: "remote", runType: "long-lived", dependencies: [] },
    { name: "Redis / PostgreSQL", mode: "remote", runType: "long-lived", dependencies: [] },
  ];
  // Dependency seeds name services readably; the stored `to` is the unit id
  // (`<repo>:<name>`) so it matches `unitId` and the shell's dependency shape.
  const unitIdByName = new Map(seeds.map((seed) => [seed.name, `${seed.repo ?? "task"}:${seed.name}`]));
  const used = new Set<number>();
  for (const task of existing) {
    for (const service of task.services) if (service.port !== undefined) used.add(service.port);
  }
  return seeds.map((seed, index) => {
    let port = seed.preferred;
    if (port !== undefined) {
      while (used.has(port)) port += 1;
      used.add(port);
    }
    const local = seed.mode === "local";
    const isRunning = local && running && seed.runType === "long-lived";
    return {
      id: `${taskId}-service-${index + 1}`,
      unitId: `${seed.repo ?? "task"}:${seed.name}`,
      name: seed.name,
      repo: seed.repo,
      port,
      mode: seed.mode,
      running: isRunning,
      runType: seed.runType,
      dependencies: seed.dependencies.map((dependency) => ({
        to: unitIdByName.get(dependency.to) ?? dependency.to,
        kind: dependency.kind,
      })),
      configSource: `共享模板 · ${environment}`,
      templateVersion: "",
      // Recomputed from the environment layers on every projection so an edited
      // layer (shared / private / task) is what the service table reports.
      resolved: [] as ResolvedConfigEntry[],
      ...(isRunning ? { runRecord: simulatedRunRecord(taskId, seed.name, port, index) } : {}),
    };
  });
}

/** Attach a locatable failure fixture to one seeded service (box 5 demo). */
function withServiceFailure(services: Service[], name: string, failure: ServiceFailureView): Service[] {
  return services.map((service) => (service.name === name ? { ...service, failure } : service));
}

/** One simulated run record so the freshness/label rules are visible in the fixture. */
function simulatedRunRecord(taskId: string, serviceName: string, port: number | undefined, index: number): ServiceRunView {
  const commit = "9acb5b6f";
  const variants: { codeState: ServiceRunView["codeState"]; buildFreshness: ServiceRunView["buildFreshness"]; codeCommit?: string }[] = [
    { codeState: "committed-clean", buildFreshness: "fresh", codeCommit: commit },
    { codeState: "uncommitted", buildFreshness: "uncommitted-code", codeCommit: commit },
    { codeState: "committed-clean", buildFreshness: "stale-build", codeCommit: commit },
  ];
  const variant = variants[index % variants.length] as (typeof variants)[number];
  return {
    runId: `run-${index + 1}`,
    templateVersion: "v12",
    codeState: variant.codeState,
    ...(variant.codeCommit !== undefined ? { codeCommit: variant.codeCommit } : {}),
    buildFreshness: variant.buildFreshness,
    ports: port === undefined ? [] : [port],
    processIdentity: { owner: "human", pid: 4100 + index, startedAt: "2026-09-22T09:30:00+08:00" },
    logRef: `/tasks/${taskId}/services/${serviceName}/run-${index + 1}.log`,
    startedAt: "2026-09-22T09:30:00+08:00",
    verifications: [],
    simulated: true,
  };
}

function seedProjects(): Project[] {
  return [
    {
      id: "atlas",
      name: "Atlas Web",
      description: "微服务开发工作台",
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
      description: "延迟与用量排查",
      repositories: [{ id: "orbit-api", name: "orbit-api", baseBranch: "main" }],
      directories: [],
      taskIds: ["latency"],
    },
  ];
}

/**
 * Machine-registered repositories, mirroring the prototype's global `repos`
 * list. Projects link a subset; the edit dialog disables repos a task uses so a
 * live task's worktree is never unlinked silently.
 */
function seedRepositories(): Repository[] {
  // Machine-local checkout paths, mirroring the prototype's 「本机仓库绑定」
  // sample values (`app.js` `project-bind`). Display-only, never read from disk.
  return [
    { id: "front-monorepo", name: "front-monorepo", baseBranch: "main", localPath: "/Users/leonz3n/Workspace/adber/front-monorepo" },
    { id: "invoice-service", name: "invoice-service", baseBranch: "main", localPath: "/Users/leonz3n/Workspace/adber/invoice-service" },
    { id: "shipment-service", name: "shipment-service", baseBranch: "release/2026.09", localPath: "/Users/leonz3n/Workspace/adber/shipment-service" },
    { id: "apis", name: "apis", baseBranch: "main" },
    { id: "orbit-api", name: "orbit-api", baseBranch: "main" },
  ];
}

const agentGreeting = "任务工作区已就绪，我可以开始检查构建与配置。";

/**
 * Seeded service startup recipes, mirroring the prototype's `environmentEditor()`
 * cards for an atlas environment (first two Node.js project scripts, the rest Go
 * reading the repository's default config). These are in-memory display data.
 */
function atlasRecipes(prefix: string): ServiceRecipe[] {
  const seeds: [string, string, string, string][] = [
    ["saas-web", "front-monorepo", "Node.js", "使用项目脚本启动"],
    ["saas-bff", "front-monorepo", "Node.js", "使用项目脚本启动"],
    ["invoice-service", "invoice-service", "Go", "读取仓库默认 config.yaml"],
    ["shipment-service", "shipment-service", "Go", "读取仓库默认 config.yaml"],
  ];
  return seeds.map(([name, repo, runtime, startNote], index) => ({
    id: `${prefix}-recipe-${index + 1}`,
    name,
    repo,
    runtime,
    startNote,
    runType: "常驻服务",
    healthCheck: runtime === "Go" ? "gRPC health" : "HTTP",
    dependencyBinding: index < 2 ? "本地依赖指向当前任务" : "共享测试环境",
  }));
}

function baseSession(id: string, name: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    name,
    archived: false,
    permission: "default",
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
      permission: index % 3 === 0 ? "read" : "default",
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

/** Illustrative child-agent records for the release task's main session (view-only). */
function releaseSubagents(): Record<string, Subagent[]> {
  return {
    main: [
      {
        id: "query-chain",
        name: "查询链路分析",
        status: "running",
        summary: "正在核对 BFF 到 invoice、shipment 的调用关系",
        assignment: "梳理对账单详情查询链路，确认运单账号字段来源。只读检查，不修改文件；将关键文件和结论交回主 Agent。",
        model: "Claude Sonnet",
        provider: "Anthropic 官方",
        started: "10:25",
        mode: "只读分析",
        events: [
          { kind: "message", role: "主 Agent", time: "10:25", text: "请检查 invoice-service 与 shipment-service 中对账单详情的同步查询，列出运单账号的数据来源和相关文件。" },
          { kind: "message", role: "Subagent", time: "10:25", text: "已接收任务，将从详情接口和 shipment 查询入口检查字段传递。" },
          {
            kind: "tool",
            name: "搜索调用入口",
            time: "10:26",
            command: "search · invoice-service / shipment-service",
            output: "示例匹配：\ninvoice-service/internal/service/detail.go\nshipment-service/internal/service/shipment.go",
          },
        ],
      },
      {
        id: "ui-field",
        name: "前端字段检查",
        status: "completed",
        summary: "已完成：确认详情页字段映射与空值展示",
        assignment: "检查前端对账单详情中运单账号的展示与空值处理。只读分析，将发现回传主 Agent。",
        model: "Claude Sonnet",
        provider: "Anthropic 官方",
        started: "10:25",
        mode: "只读分析",
        events: [
          { kind: "message", role: "主 Agent", time: "10:25", text: "请检查 front-monorepo 的详情字段映射和空值展示，不修改代码。" },
          {
            kind: "tool",
            name: "读取详情组件",
            time: "10:26",
            command: "read · front-monorepo/src/detail.ts",
            output: "示例片段：\naccount: response.account\n展示层在字段为空时显示占位符。",
          },
        ],
        result: "已向主 Agent 返回：前端直接读取 account；需要结合后端响应确认空值处理。",
      },
    ],
  };
}

function seedTasks(): Task[] {
  const sessions = seedSessions();
  const atlasDocs = toTaskDirectory({ id: "atlas-docs", name: "Atlas 设计资料", path: "/Users/leonz3n/Workspace/atlas-docs" });
  // Built in order so each task's ports are allocated against the previous
  // ones: two tasks never share a local port for the same service name.
  const releaseTask: Task = {
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
      permission: "default",
      services: makeServices("release", "testing", true, []),
      externalResources: [
        { resourceId: "res-invoice-events", name: "invoice-events", kind: "queue" },
        { resourceId: "res-dtm-callback", name: "dtm-callback", kind: "dtm-callback" },
      ],
      sessions: sessions.release,
      activeSessionId: "main",
      unread: 2,
      subagentsBySession: releaseSubagents(),
      ...taskAssets(),
    };
  const checkoutTask: Task = {
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
      permission: "default",
      // Simulated locatable failure: the second task cannot bind the port its
      // fixture asked for, so the panel shows the code + retry hint instead of
      // a generic error.
      services: withServiceFailure(makeServices("checkout", "testing", false, [releaseTask]), "invoice-service", {
        code: "port-taken",
        // The owning instance is the release task's invoice-service, which
        // holds 9001 — the port this task's invoice-service asked for. Keep
        // the message consistent with the fixture's own allocation
        // (`release/invoice-service` = 9001, `release/shipment-service` = 9002).
        message: "端口 9001 已被任务实例 release/invoice-service@9001 占用",
        hint: "运行管理会重新分配端口并更新受影响的消费者",
      }),
      externalResources: [{ resourceId: "res-order-events", name: "order-events", kind: "queue" }],
      sessions: sessions.checkout,
      activeSessionId: "main",
      unread: 0,
      ...taskAssets(),
    };
  const legacyAuthTask: Task = {
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
      services: makeServices("legacy-auth", "dev", false, [releaseTask, checkoutTask]),
      sessions: sessions["legacy-auth"],
      activeSessionId: "main",
      unread: 0,
      ...taskAssets(),
      cleanupAvailableAt: "2026-09-18T10:00:00+08:00",
    };
  const latencyTask: Task = {
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
      permission: "default",
      services: makeServices("latency", "orbit-testing", false, [releaseTask, checkoutTask, legacyAuthTask]),
      externalResources: [{ resourceId: "res-shared-pg", name: "shared-pg", kind: "database" }],
      sessions: sessions.latency,
      activeSessionId: "main",
      unread: 1,
      ...taskAssets(),
    };
  const designDocsTask: Task = {
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
      permission: "default",
      services: [],
      sessions: [baseSession("main", "实现与验证")],
      activeSessionId: "main",
      unread: 0,
      files: [],
      browserPages: [],
      terminalSeed: [],
    };
  return [releaseTask, checkoutTask, legacyAuthTask, latencyTask, designDocsTask];
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
  private repositories: Repository[] = seedRepositories();
  private projects = seedProjects();
  private tasks = seedTasks();
  private environments = [
    {
      id: "testing",
      projectId: "atlas",
      name: "测试环境",
      description: "本地联调使用的远程测试依赖",
      templateVersion: "v12",
      variables: [{ key: "LOG_LEVEL", value: "debug", secret: false }],
      privateVariables: [{ key: "INVOICE_ACCESS_TOKEN", value: "__local_testing_token__", secret: true }],
      recipes: atlasRecipes("testing"),
    },
    {
      id: "dev",
      projectId: "atlas",
      name: "开发环境",
      description: "日常开发与远程开发依赖",
      templateVersion: "v11",
      variables: [{ key: "LOG_LEVEL", value: "info", secret: false }],
      privateVariables: [],
      recipes: atlasRecipes("dev"),
    },
    {
      id: "orbit-testing",
      projectId: "orbit",
      name: "测试环境",
      description: "默认环境",
      templateVersion: "v4",
      variables: [{ key: "LOG_LEVEL", value: "warn", secret: false }],
      privateVariables: [],
      recipes: [
        {
          id: "orbit-testing-recipe-1",
          name: "orbit-api",
          repo: "orbit-api",
          runtime: "Go",
          startNote: "读取仓库默认 config.yaml",
          runType: "常驻服务",
          healthCheck: "gRPC health",
          dependencyBinding: "共享测试环境",
        },
      ],
    },
    {
      // Deliberately unreferenced: no task adopts it, which is the case that
      // hides 任务覆盖 (a task override cannot target another environment) and
      // the case that environment deletion is allowed for.
      id: "staging-preview",
      projectId: "atlas",
      name: "预发布环境",
      description: "预发布演练",
      templateVersion: "v3",
      variables: [{ key: "RELEASE_CHANNEL", value: "canary", secret: false }],
      privateVariables: [],
      recipes: [],
    },
  ];

  private providers: ProviderProfile[] = [
    {
      id: "provider-anthropic",
      name: "Anthropic 官方",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      authRef: "anthropic-key",
      enabled: true,
      models: [
        { id: "Claude Sonnet", contextWindow: 200, maxOutput: 8, supportsImages: true },
        { id: "Claude Haiku", contextWindow: 200, maxOutput: 4 },
      ],
    },
    {
      id: "provider-openai",
      name: "OpenAI 兼容网关",
      protocol: "openai-responses",
      baseUrl: "https://gateway.example.com/v1",
      authRef: "gateway-key",
      enabled: true,
      models: [{ id: "团队轻量模型", contextWindow: 16, maxOutput: 2, supportsImages: true }],
    },
    {
      id: "provider-local",
      name: "本地推理",
      protocol: "openai-chat-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
      enabled: true,
      models: [
        {
          id: "本地 Qwen",
          contextWindow: 32,
          maxOutput: 4,
          thinking: { mode: "custom", levels: ["off", "low", "medium", "high"], default: "medium" },
        },
      ],
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
      permission: "default",
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

  /**
   * [PiDock 02] per-task provision entries backing `getTaskProvision` /
   * `provisionTaskThroughForm`: branch + pinned baseline + readiness +
   * last failure. Failures keep the form (with retry) instead of creating
   * from a stale reference.
   */
  private provisions = new Map<
    string,
    {
      branch: string;
      remoteBranch: string;
      baseCommit: string;
      ready: boolean;
      lastError?: { code: string; message: string };
      /** [PiDock 03] (#6) per-repo sources + plain-dir links (memory mirror). */
      repoSources?: { repoDir: string; remote: string; remoteBranch: string; baseCommit: string }[];
      dirLinks?: { linkName: string; directoryId: string; sourcePath: string; snapshotAt: string }[];
    }
  >();

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
      // [PiDock 09] (#11) the coordination view travels with the task, so a
      // workspace refresh (which every settled turn triggers) updates holder,
      // queue and read-only state without a second fetch path.
      writeLock: memoryWriteLockView(task),
    };
  }

  /**
   * [PiDock 09] (#11) coordination read for one task: the same view `getWorkspace`
   * attaches, plus the per-session roles the navigation badges use.
   */
  async sessionWriteStates(taskId: string): Promise<{ writeLock: TaskWriteLockView; sessions: SessionWriteState[] }> {
    const task = this.task(taskId);
    if (!task) throw new Error("任务不存在");
    const writeLock = memoryWriteLockView(task);
    return { writeLock, sessions: sessionWriteStates({ sessions: task.sessions, writeLock }) };
  }

  async getWorkspace(): Promise<Workspace> {
    return {
      repositories: this.repositories.map((item) => ({ ...item })),
      projects: this.projects.map((item) => ({ ...item, directories: item.directories.map((directory) => ({ ...directory })) })),
      tasks: this.tasks.map((item) => this.projectTask(item)),
      environments: this.environments.map((item) => ({
        ...item,
        recipes: item.recipes.map((recipe) => ({ ...recipe })),
      })),
      providers: this.providers.map((item) => ({ ...item, models: item.models.map((model) => ({ ...model })) })),
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
    // [PiDock 02] task-scoped write right, extended by [PiDock 09] (#11) box 2:
    // at most one running session per task. Same-session reruns still throw the
    // single-session message; a different session of the same task gets the
    // task-lock message **and is recorded in the coordination queue**, so the
    // navigation shows 持有者／排队位置 and the abort entry.
    const owner = taskLocks.locks.get(taskId);
    if (owner !== undefined && owner !== sessionId) {
      noteWriteWait(taskId, sessionId);
      throw new Error(`同一任务写操作权由会话 ${owner} 持有，排队等待或先中止该会话`);
    }
    if (session.runState === "running") throw new Error("当前会话正在执行，请先停止");

    // [PiDock 02]: read-only sessions refuse side-effecting turns at the tool
    // layer, not just by hiding the composer (the composer stays disabled as
    // the first line, this is the enforced second line).
    if (session.permission === "read") {
      throw new Error("只读会话仅允许阅读分析，请先调整会话权限");
    }
    const userMessage = {
      id: this.nextId("msg-user"),
      role: "user" as const,
      text,
      references,
    };
    session.messages = [...session.messages, userMessage];
    session.runState = "running";
    taskLocks.locks.set(taskId, sessionId);
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
    session.lastActivity = new Date().toISOString();
    // The task write right lasts until the turn settles (completed/failed
    // keep it released immediately; approval keeps the session as owner
    // until resolve/stop/archive). Awaiting approval is not a detached lock:
    // stop/resolve/archive always clear it (see stopRun/resolveApproval).
    // [PiDock 09] (#11): a session that got the right leaves the queue; when
    // the right becomes free the queue is cleared with it.
    if (finalState === "approval") {
      taskLocks.locks.set(taskId, sessionId);
    } else {
      if (taskLocks.locks.get(taskId) === sessionId) taskLocks.locks.delete(taskId);
      clearWriteWaits(taskId);
    }
    // [PiDock 11] #9: a settled turn reports a measured context reading, so the
    // switch gate judges the next switch on fresh numbers instead of a value
    // left `pending` by an earlier compaction.
    session.contextUsed = session.contextUsed + 1.4 + text.length * 0.01;
    session.contextSource = "actual";
    // [PiDock 02]: from the first model call, record the stable call identity
    // (provider + model + usage source + events) so later Provider/usage work
    // can recover it instead of re-reading rendered text.
    this.usage.push({
      id: record.id,
      taskId,
      projectId: task.projectId,
      sessionId,
      providerId: session.providerId,
      model: session.model,
      input: 3200 + text.length * 7,
      output: 480 + replyLength(finalState, text),
      cacheRead: 0,
      at: record.startedAt,
    });
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
        // [PiDock 11] #9: the response keeps the account that produced it.
        attribution: { providerId: session.providerId, model: session.model },
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
    session.lastActivity = new Date().toISOString();
    // Stop is the abort entry ([PiDock 09] #11 box 2): it ends this session's
    // write right and frees the queue, so a waiting session can write.
    if (taskLocks.locks.get(taskId) === sessionId) {
      taskLocks.locks.delete(taskId);
      clearWriteWaits(taskId);
    } else {
      const waiting = taskLocks.waiting.get(taskId) ?? [];
      if (waiting.includes(sessionId)) {
        const next = waiting.filter((item) => item !== sessionId);
        if (next.length === 0) taskLocks.waiting.delete(taskId);
        else taskLocks.waiting.set(taskId, next);
      }
    }
    const record = this.runs[sessionKeyOf(taskId, sessionId)];
    if (record) record.state = "stopped";
    // A session may be stopped before it ever ran a turn (e.g. a restored
    // session waiting on a confirmation): emit a complete run record so the
    // UI never receives a run without its steps array.
    const emitted: RunRecord = record ?? {
      id: this.nextId("run"),
      taskId,
      sessionId,
      state: "stopped",
      startedAt: new Date().toISOString(),
      summary: "已中止",
      steps: [],
    };
    this.runs[sessionKeyOf(taskId, sessionId)] = emitted;
    this.emit({ type: "run-state", taskId, sessionId, state: "stopped", record: emitted });
  }

  async createSession(taskId: string) {
    const task = this.task(taskId);
    if (!task) throw new Error("任务不存在");
    const session: Session = {
      id: this.nextId("session"),
      name: "新会话",
      archived: false,
      // New sessions always start at 默认权限 (the prototype's `sessionPermission`
      // fallback for a non-read-only session), not the task's last tier.
      permission: "default",
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
    // [PiDock 09] (#11) 收口规则：最后一个会话归档后仍可带归档标记查看，**不自动
    // 新建空会话**（归档不是任务归档，也不是禁止继续对话）。这里只归档，不建会话。
    if (archived && taskLocks.locks.get(taskId) === sessionId) {
      taskLocks.locks.delete(taskId);
      clearWriteWaits(taskId);
    }
  }

  async archiveTask(taskId: string) {
    const task = this.task(taskId);
    if (!task) return;
    task.archived = true;
    // Archiving stops this task's own services only; the run record keeps its
    // code/build state and gets the exit reason ([PiDock 05] #10 box 8).
    task.services = task.services.map((service) => ({
      ...service,
      running: false,
      ...(service.runRecord && service.runRecord.endedAt === undefined
        ? { runRecord: { ...service.runRecord, endedAt: new Date().toISOString(), exitReason: "task-archived" } }
        : {}),
    }));
    task.sessions = task.sessions.map((session) =>
      session.runState === "approval" ? { ...session, runState: "expired" as const } : session,
    );
    for (const approval of Object.values(this.approvals)) {
      if (approval.taskId === taskId && approval.status === "pending") {
        approval.status = "expired";
        this.emit({ type: "approval", taskId, sessionId: approval.sessionId, approval });
      }
    }
    // Archiving releases the whole task's write right regardless of owner.
    taskLocks.locks.delete(taskId);
    clearWriteWaits(taskId);
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
    // Approval settles the waiting turn: keep the lock only while the
    // approved turn re-runs; rejected/expired release it so another session
    // of the same task may run.
    if (status === "approved") {
      taskLocks.locks.set(next.taskId, next.sessionId);
    } else if (taskLocks.locks.get(next.taskId) === next.sessionId) {
      taskLocks.locks.delete(next.taskId);
      clearWriteWaits(next.taskId);
    }
    if (session) session.lastActivity = new Date().toISOString();
    this.emit({ type: "approval", taskId: next.taskId, sessionId: next.sessionId, approval: next });
    return next;
  }

  async simulateExpiry(approvalId: string) {
    return this.resolveApproval(approvalId, "expired");
  }

  async setServiceRunning(taskId: string, serviceId: string, running: boolean) {
    // [PiDock 04] (#7) memory mirror of the Host service lifecycle: the
    // shell adapter (shellHost.ts) routes this through `task/controlService`
    // with no sessionId for services the Host has registered, and falls back
    // here otherwise; dev/test callers land here. Read-only sessions
    // refuse at this tool layer (the RuntimePanel hides the buttons first;
    // this is the enforced second line). Liveness only — dependency
    // reachability never flips `running` (see `resolveServiceConfig` note
    // on the simulated page verification).
    const task = this.task(taskId);
    const session = task?.sessions.find((item) => item.id === task.activeSessionId);
    if (session?.permission === "read") {
      throw new Error("只读会话禁止服务启停，请先调整会话权限");
    }
    const service = task?.services.find((item) => item.id === serviceId);
    if (!service) return;
    service.running = running;
    if (running && service.mode === "local") {
      // A start clears the previous failure fixture and records a fresh
      // (simulated) run so the panel shows code/build state, ports and the
      // per-instance log path together ([PiDock 05] #10 box 6).
      service.failure = undefined;
      service.runRecord = {
        ...simulatedRunRecord(taskId, service.name, service.port, task?.services.indexOf(service) ?? 0),
        runId: `${service.id}-run-1`,
        templateVersion: task?.templateVersion ?? "",
        startedAt: new Date().toISOString(),
        processIdentity: { owner: "human", pid: 5200 + (task?.services.indexOf(service) ?? 0), startedAt: new Date().toISOString() },
      };
    } else if (service.runRecord) {
      service.runRecord = { ...service.runRecord, endedAt: new Date().toISOString(), exitReason: "user-request" };
    }
  }

  async setServiceMode(taskId: string, serviceId: string, mode: ServiceMode) {
    const task = this.task(taskId);
    const service = task?.services.find((item) => item.id === serviceId);
    if (!service) return;
    // Switching the dependency target stops the instance and invalidates the
    // simulated page verification (prototype `data-action="service-mode"`).
    service.mode = mode;
    service.running = false;
    service.configSource = mode === "local" ? service.configSource : "远程依赖 · 未在本任务启动";
    // Switching the destination ends the run: the record keeps its code/build
    // state and the exit reason so the moved consumer is traceable.
    if (service.runRecord) {
      service.runRecord = { ...service.runRecord, endedAt: new Date().toISOString(), exitReason: "dependency-target-changed" };
    }
  }

  /**
   * [PiDock 05] (#10) task-view topology projection (memory mode). Same shape
   * as the Host plan, so the runtime panel renders identically when the shell
   * answers `task/planServiceGroup`.
   */
  async serviceTopology(taskId: string): Promise<ServiceTopologyView> {
    const task = this.task(taskId);
    if (!task) throw new Error("任务不存在");
    const environment = this.environments.find((item) => item.id === task.environmentId);
    // Project first: the stored service rows carry no resolved config, so the
    // routing read points only exist on the projected task.
    return projectServiceTopology(this.projectTask(task), environment?.name ?? task.environmentId);
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
      const linkPath = directoryLinkPath(task.workspaceRoot, task.workspaceKey, directory);
      items.push({
        resource: `普通目录 · ${directory.name}`,
        action: "移除任务内软链接",
        detail: `移除任务内软链接 ${linkPath}；保留原目录 ${directory.path} 及其全部文件`,
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
      // Shared templates must never carry secrets (fail-closed, same rule
      // as the Host `validateNoSecretsInShared`): a shared entry whose key
      // looks like a credential is rejected instead of saved+versioned.
      for (const entry of entries) {
        if (entry.secret) {
          throw new Error(`secret-in-shared: 共享模板不能包含凭据「${entry.key}」；请移入本机私有配置`);
        }
      }
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

  async saveServiceRecipe({ environmentId, recipe }: SaveServiceRecipeInput): Promise<ServiceRecipe> {
    const environment = this.environments.find((item) => item.id === environmentId);
    if (!environment) throw new Error("环境不存在");
    const name = recipe.name.trim();
    if (!name) throw new Error("请填写服务名称");
    const existing = recipe.id ? environment.recipes.find((item) => item.id === recipe.id) : undefined;
    if (recipe.id && !existing) throw new Error("服务配方不存在");
    const next: ServiceRecipe = {
      id: existing?.id ?? this.nextId("recipe"),
      name,
      repo: recipe.repo?.trim() || undefined,
      runtime: recipe.runtime.trim() || "Node.js",
      startNote: recipe.startNote.trim(),
      runType: recipe.runType.trim() || "常驻服务",
      healthCheck: recipe.healthCheck.trim() || "HTTP",
      dependencyBinding: recipe.dependencyBinding.trim(),
    };
    environment.recipes = existing
      ? environment.recipes.map((item) => (item.id === next.id ? next : item))
      : [...environment.recipes, next];
    return { ...next };
  }

  /**
   * Simulated `.vscode` import. It never reads a repository: it derives example
   * recipes from the project's registered repos so the prototype's import entry
   * has an in-memory result, and skips names already present.
   */
  async importVscodeConfig(environmentId: string): Promise<ServiceRecipe[]> {
    const environment = this.environments.find((item) => item.id === environmentId);
    if (!environment) throw new Error("环境不存在");
    const project = this.projects.find((item) => item.id === environment.projectId);
    const repositories = project?.repositories ?? [];
    if (repositories.length === 0) throw new Error("当前项目还没有可扫描的仓库");
    const existingNames = new Set(environment.recipes.map((item) => item.name));
    const added: ServiceRecipe[] = [];
    repositories.forEach((repository, index) => {
      if (existingNames.has(repository.name)) return;
      added.push({
        id: this.nextId("recipe"),
        name: repository.name,
        repo: repository.name,
        runtime: index % 2 === 0 ? "Node.js" : "Go",
        startNote: "从 .vscode 导入 · 读取仓库默认 config.yaml",
        runType: "常驻服务",
        healthCheck: "HTTP",
        dependencyBinding: "",
      });
    });
    environment.recipes = [...environment.recipes, ...added];
    return added.map((item) => ({ ...item }));
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

  /** Validate ordinary-directory rows the same way for project create and edit. */
  private normalizeDirectories(rows: ProjectDirectoryInput[]): ProjectDirectory[] {
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
    return next;
  }

  async saveProject({ id, name, description, repositoryIds, directories }: SaveProjectInput): Promise<Project> {
    const projectName = name.trim();
    if (!projectName) throw new Error("请填写项目名称");
    if (this.projects.some((item) => item.id !== id && item.name === projectName)) {
      throw new Error("已有同名项目，请使用其他名称");
    }
    const nextDirectories = this.normalizeDirectories(directories);
    const repositories = repositoryIds
      .map((repoId) => this.repositories.find((item) => item.id === repoId))
      .filter((item): item is Repository => Boolean(item));
    if (id) {
      const project = this.projects.find((item) => item.id === id);
      if (!project) throw new Error("项目不存在");
      // A repository or directory a task uses cannot be unlinked under it (the
      // prototype disables those checkboxes / removes); keep tasks consistent.
      for (const task of this.tasks) {
        if (task.projectId !== id) continue;
        for (const repoId of task.repos) {
          if (!repositories.some((item) => item.id === repoId)) {
            throw new Error("任务使用中的仓库不能解除关联");
          }
        }
        for (const directory of task.directories) {
          const updated = nextDirectories.find((item) => item.id === directory.id);
          if (!updated || updated.name !== directory.name || updated.path !== directory.path) {
            throw new Error("任务使用中的普通目录不能修改名称或路径");
          }
        }
      }
      project.name = projectName;
      project.description = description.trim();
      project.repositories = repositories;
      project.directories = nextDirectories;
      return { ...project, directories: project.directories.map((item) => ({ ...item })) };
    }
    const project: Project = {
      id: this.nextId("project"),
      name: projectName,
      description: description.trim(),
      repositories,
      directories: nextDirectories,
      taskIds: [],
    };
    this.projects.push(project);
    return { ...project, directories: project.directories.map((item) => ({ ...item })) };
  }

  async deleteProject(projectId: string): Promise<void> {
    const project = this.projects.find((item) => item.id === projectId);
    if (!project) throw new Error("项目不存在");
    // Archived tasks still block deletion (the prototype counts them too).
    const bound = this.tasks.filter((item) => item.projectId === projectId);
    if (bound.length > 0) {
      throw new Error(`还有 ${bound.length} 个关联任务（包含已归档任务），暂不能删除项目`);
    }
    this.projects = this.projects.filter((item) => item.id !== projectId);
    this.environments = this.environments.filter((item) => item.projectId !== projectId);
  }

  async saveEnvironment({ id, projectId, name, description }: SaveEnvironmentInput): Promise<Environment> {
    if (!this.projects.some((item) => item.id === projectId)) throw new Error("项目不存在");
    const environmentName = name.trim();
    if (!environmentName) throw new Error("请填写环境名称");
    const siblings = this.environments.filter((item) => item.projectId === projectId);
    if (siblings.some((item) => item.id !== id && item.name === environmentName)) {
      throw new Error("当前项目已有同名环境");
    }
    if (id) {
      const environment = this.environments.find((item) => item.id === id);
      if (!environment) throw new Error("环境不存在");
      // Renaming keeps every task's adopted template version and does not
      // restart services (the prototype's `saveEnvironment` copies name/description only).
      environment.name = environmentName;
      environment.description = description.trim();
      return { ...environment, recipes: environment.recipes.map((item) => ({ ...item })) };
    }
    const environment: Environment = {
      id: this.nextId("env"),
      projectId,
      name: environmentName,
      description: description.trim(),
      templateVersion: "v1",
      variables: [],
      privateVariables: [],
      recipes: [],
    };
    this.environments.push(environment);
    return { ...environment };
  }

  async deleteEnvironment(environmentId: string): Promise<void> {
    const environment = this.environments.find((item) => item.id === environmentId);
    if (!environment) throw new Error("环境不存在");
    const referencing = this.tasks.filter((item) => item.environmentId === environmentId);
    if (referencing.length > 0) {
      throw new Error(`${referencing.length} 个任务正在引用此环境（包含已归档任务），暂不能删除`);
    }
    this.environments = this.environments.filter((item) => item.id !== environmentId);
  }

  async addCapability({ kind, name, source, scope }: AddCapabilityInput): Promise<Capability> {
    const capabilityName = name.trim();
    const capabilitySource = source.trim();
    if (!capabilityName || !capabilitySource) throw new Error("请填写名称和来源");
    const capability: Capability = {
      id: this.nextId("cap"),
      kind,
      name: capabilityName,
      source: capabilitySource,
      scope,
      // Added disabled / pending review and never auto-loaded.
      status: "pending-review",
    };
    this.capabilities = [...this.capabilities, capability];
    return { ...capability };
  }

  async saveProvider({ id, name, protocol, baseUrl, authRef, enabled, models }: SaveProviderInput): Promise<ProviderProfile> {
    // Locatable validation shared with the shell rules (`providerState.ts`):
    // the first issue is thrown with the field it belongs to, so the form can
    // mark that field instead of showing one generic message.
    const issues = validateProviderDraft({ name, protocol, baseUrl, ...(authRef !== undefined ? { authRef } : {}), models });
    if (issues.length > 0) throw new Error(issues[0].message);
    const existing = id ? this.providers.find((item) => item.id === id) : undefined;
    if (id && !existing) throw new Error("Provider 不存在");
    const next: ProviderProfile = {
      id: existing?.id ?? this.nextId("provider"),
      name: name.trim(),
      protocol,
      baseUrl: baseUrl.trim(),
      ...(authRef !== undefined && authRef.trim().length > 0 ? { authRef: authRef.trim() } : {}),
      enabled,
      models: models.map((model) => {
        const prior = existing?.models.find((item) => item.id === model.id.trim());
        return {
          id: model.id.trim(),
          name: model.name?.trim() || undefined,
          contextWindow: model.contextWindow,
          ...(model.contextWindowSource !== undefined
            ? { contextWindowSource: model.contextWindowSource }
            : prior?.contextWindowSource !== undefined
              ? { contextWindowSource: prior.contextWindowSource }
              : {}),
          ...(model.maxOutput !== undefined ? { maxOutput: model.maxOutput } : prior?.maxOutput !== undefined ? { maxOutput: prior.maxOutput } : {}),
          supportsImages: model.supportsImages ?? prior?.supportsImages,
          thinking: model.thinking ?? prior?.thinking,
        };
      }),
    };
    this.providers = existing
      ? this.providers.map((item) => (item.id === next.id ? next : item))
      : [...this.providers, next];
    return { ...next, models: next.models.map((model) => ({ ...model })) };
  }

  async removeProvider(providerId: string): Promise<void> {
    if (!this.providers.some((item) => item.id === providerId)) throw new Error("Provider 不存在");
    // [PiDock 11] #9: sessions (and history) keep the original provider id. A
    // deleted configuration is reported as unavailable (`describeHistoryAttribution`)
    // instead of silently rerouting the session to another account.
    this.providers = this.providers.filter((item) => item.id !== providerId);
  }

  /** Enable/disable one provider without rewriting its models or any session. */
  async setProviderEnabled(providerId: string, enabled: boolean): Promise<ProviderProfile> {
    const provider = this.providers.find((item) => item.id === providerId);
    if (!provider) throw new Error("Provider 不存在");
    provider.enabled = enabled;
    return { ...provider, models: provider.models.map((model) => ({ ...model })) };
  }

  /**
   * 「同步模型列表」 in the in-memory model. Candidates come from a recorded
   * fixture transport (no request leaves the app): the fixture answers per
   * protocol, and a `baseUrl` ending in `empty` / `fail` / `timeout` /
   * `no-discovery` reproduces the empty / failure / rejection / unsupported
   * outcomes so the form can be exercised without a provider. Configured
   * model rows are never touched — only the candidate list changes.
   */
  async syncProviderModels(providerId: string, connection?: { protocol: string; baseUrl: string }): Promise<ProviderDiscoveryView> {
    const saved = this.providers.find((item) => item.id === providerId);
    if (!saved && providerId.length > 0) throw new Error("Provider 不存在");
    // [PiDock 11] #9: the Add form syncs the draft connection before the first
    // save; the outcome only ever updates candidates.
    if (!saved && connection !== undefined && connection.baseUrl.trim().length === 0) {
      throw new Error("请先填写服务地址，再同步模型列表");
    }
    const provider = saved ?? { protocol: connection?.protocol ?? "", baseUrl: connection?.baseUrl ?? "" };
    if (provider.baseUrl.trim().endsWith("no-discovery")) {
      return {
        status: "unsupported",
        candidates: [],
        message: "当前连接未声明模型发现端点；请直接填写模型 ID，已配置模型不受影响",
        fingerprint: `${provider.protocol}::${provider.baseUrl.trim()}`,
        ignored: 0,
      };
    }
    const transport: DiscoveryTransport = async ({ baseUrl, protocol }) => {
      const key = baseUrl.trim();
      if (key.endsWith("empty")) return { ok: true, ids: [] };
      if (key.endsWith("fail")) return { ok: false, message: "401 未授权" };
      if (key.endsWith("timeout")) throw new Error("连接超时");
      return { ok: true, ids: PROTOCOL_MODEL_FIXTURES[protocol] ?? [] };

    };
    return syncModelCandidates({ connection: { protocol: provider.protocol, baseUrl: provider.baseUrl }, transport });
  }

  async setSessionPermission(taskId: string, sessionId: string, permission: Permission): Promise<void> {
    const session = this.session(taskId, sessionId);
    if (!session) throw new Error("会话不存在");
    session.permission = permission;
  }

  /**
   * Switch the session's provider/model with the same fail-closed order as the
   * Host: a running round/tool/confirmation first, then availability, then the
   * strict context bound (> refuses, = and < pass; unknown/pending occupancy
   * never passes). A refusal changes nothing: model, history and draft stay.
   */
  async setSessionModel(taskId: string, sessionId: string, providerId: string, model: string): Promise<void> {
    const session = this.session(taskId, sessionId);
    if (!session) throw new Error("会话不存在");
    const provider = this.providers.find((item) => item.id === providerId);
    const target = provider?.models.find((item) => item.id === model);
    const running = session.runState === "running" || session.runState === "approval";
    const decision = evaluateSessionModelSwitch({
      running,
      ...(running ? { busyLabel: session.runState === "approval" ? "等待确认中" : "回合或工具执行中" } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(target !== undefined ? { model: target } : {}),
      contextUsed: session.contextUsed,
      contextSource: session.contextSource ?? "actual",
    });
    if (!decision.ok) throw new Error(decision.refusal.message);
    if (provider === undefined || target === undefined) throw new Error("模型不可用");
    const previousThinking = session.thinking;
    const previousSelection = { providerId: session.providerId, model: session.model };
    const resolved = resolveSessionThinking(target, previousThinking);
    session.providerId = providerId;
    session.model = model;
    session.contextWindow = target.contextWindow;
    session.thinking = resolved.source === "session" ? resolved.level : undefined;
    session.switchEvents = [
      ...(session.switchEvents ?? []),
      {
        at: new Date().toISOString(),
        from: previousSelection,
        to: { providerId, model },
        reason: "human-switch",
        ...(resolved.stale !== undefined ? { droppedThinking: resolved.stale } : {}),
      },
    ];
  }

  /** Session reasoning level; an undeclared tier or an impossible "off" fails closed. */
  async setSessionThinking(taskId: string, sessionId: string, level: string): Promise<void> {
    const session = this.session(taskId, sessionId);
    if (!session) throw new Error("会话不存在");
    const model = this.providers.find((item) => item.id === session.providerId)?.models.find((item) => item.id === session.model);
    const decision = evaluateThinkingSelection({ ...(model?.thinking !== undefined ? { thinking: model.thinking } : {}), level });
    if (!decision.ok) throw new Error(decision.error.message);
    session.thinking = decision.level;
  }

  /**
   * Compaction replaces the current occupancy with a smaller estimate marked
   * `pending` (the UI must not keep showing a stale exact number) and leaves
   * cumulative token consumption untouched.
   */
  async compactSessionContext(taskId: string, sessionId: string): Promise<void> {
    const session = this.session(taskId, sessionId);
    if (!session) throw new Error("会话不存在");
    // [PiDock 11] #9: compacting is a turn-scoped action like a model switch —
    // it waits for the current execution instead of rewriting a live call.
    if (session.runState === "running" || session.runState === "approval") {
      throw new Error("当前回合尚未结束，请先等待完成或停止后再压缩上下文");
    }
    session.contextUsed = Math.min(session.contextUsed, 9.2);
    session.contextSource = "pending";
  }

  async saveSchedule({ id, name, rule, timezone, prompt, providerId, model, permission }: SaveScheduleInput): Promise<Schedule> {
    const schedule = this.schedules.find((item) => item.id === id);
    if (!schedule) throw new Error("定时任务不存在");
    const nextRule = rule.trim();
    const nextPrompt = prompt.trim();
    if (!nextRule) throw new Error("请填写执行周期");
    if (!nextPrompt) throw new Error("请填写提示词");
    schedule.rule = nextRule;
    schedule.timezone = timezone;
    schedule.prompt = nextPrompt;
    schedule.providerId = providerId;
    schedule.model = model;
    schedule.permission = permission;
    const nextName = name?.trim();
    if (nextName) {
      schedule.name = nextName;
      const task = this.task(schedule.taskId);
      if (task) task.name = nextName;
    }
    return { ...schedule };
  }

  async setRepositoryPath(repositoryId: string, localPath: string): Promise<void> {
    const repository = this.repositories.find((item) => item.id === repositoryId);
    if (!repository) throw new Error("仓库未登记");
    const value = localPath.trim();
    // The prototype only checks the path shape (directories.js `validWorkspaceRoot`).
    if (value && !validWorkspaceRoot(value)) throw new Error("请填写完整的本机路径");
    repository.localPath = value || undefined;
  }

  async addTaskSources(taskId: string, { repoIds, directoryIds }: AddTaskSourcesInput): Promise<void> {
    const task = this.task(taskId);
    if (!task) throw new Error("任务不存在");
    const project = this.projects.find((item) => item.id === task.projectId);
    if (!project) throw new Error("项目不存在");
    const addedSources = repoIds.filter((id) => project.repositories.some((repository) => repository.id === id));
    if (repoIds.length > 0 && addedSources.length === 0 && directoryIds.length === 0) {
      throw new Error("请选择要追加的仓库或目录");
    }
    task.repos = [...new Set([...task.repos, ...addedSources])];
    const existing = new Map(task.directories.map((directory) => [directory.id, directory]));
    task.directories = directoryIds.map((id) => {
      const prior = existing.get(id);
      if (prior) return prior;
      const registered = project.directories.find((item) => item.id === id);
      if (!registered) throw new Error("目录不存在");
      return toTaskDirectory(registered);
    });
    // A task that only had directories gains services when a repository is added.
    if (task.repos.length > 0 && task.services.length === 0) {
      const environment = this.environments.find((item) => item.id === task.environmentId);
      task.services = makeServices(task.id, environment?.name ?? "", false, this.tasks);
    }
  }

  async createTask({ projectId, name, repoIds, directoryIds, environmentId, workspaceKey, schedule }: CreateTaskInput): Promise<Task> {
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
    const scheduled = Boolean(schedule);
    if (schedule) {
      if (!schedule.prompt.trim()) throw new Error("定时任务需要填写提示词");
      if (!schedule.rule.trim()) throw new Error("请填写执行周期");
      if (!schedule.providerId || !schedule.model) throw new Error("定时任务需要选择模型");
    }
    const task: Task = {
      id,
      projectId,
      name: taskName,
      workspaceKey: workspaceKey ?? this.nextWorkspaceKey(),
      workspaceRoot: this.localSettings.workspaceRoot,
      type: scheduled ? "scheduled" : "normal",
      environmentId: targetEnvironmentId,
      templateVersion: environment?.templateVersion ?? "",
      repos,
      directories,
      configOverrides: [],
      archived: false,
      permission: schedule?.permission ?? "default",
      services: repos.length > 0 ? makeServices(id, environment?.name ?? "", false, this.tasks) : [],
      // A scheduled task starts with one placeholder session (the prototype's
      // 「等待首次执行」); each trigger later creates its own session.
      sessions: [baseSession("main", scheduled ? "等待首次执行" : "实现与验证")],
      activeSessionId: "main",
      unread: 0,
      files: repos.length > 0 ? assets.files : [],
      browserPages: repos.length > 0 ? assets.browserPages : [],
      terminalSeed: repos.length > 0 ? assets.terminalSeed : [],
    };
    this.tasks.push(task);
    project.taskIds = [...project.taskIds, id];
    if (schedule) {
      this.schedules = [
        {
          id: this.nextId("schedule"),
          taskId: id,
          name: taskName,
          rule: schedule.rule.trim(),
          timezone: schedule.timezone || "Asia/Shanghai",
          prompt: schedule.prompt.trim(),
          providerId: schedule.providerId,
          model: schedule.model,
          permission: schedule.permission,
          enabled: true,
          nextRun: schedule.rule.trim(),
        },
        ...this.schedules,
      ];
    }
    return this.projectTask(task);
  }

  async runTerminalCommand(taskId: string, command: string): Promise<string[]> {
    if (!this.task(taskId)) throw new Error("任务不存在");
    return [`$ ${command}`, "命令已加入模拟队列"];
  }

  /**
   * [PiDock 02] provision state for the task form, derived from the stored
   * task record: the actual root saved at creation, the pinned remote
   * branch + commit, the editable branch, and readiness. The memory Host
   * has no separate `task.json`, so the record fields live on the task
   * itself (`workspaceRoot` is the stored actual root — a later default
   * change never migrates it).
   */
  async getTaskProvision(taskId: string): Promise<TaskProvisionState | undefined> {
    const task = this.task(taskId);
    if (!task) return undefined;
    const provision = this.provisions.get(taskId);
    const dirId = isTaskDirId(task.workspaceKey) ? task.workspaceKey : "task-00000000";
    const branch = provision?.branch ?? `task/${dirId}`;
    return {
      taskId: task.id,
      name: task.name,
      dirId,
      branch,
      root: task.workspaceRoot,
      taskDir: `${task.workspaceRoot.replace(/[\\/]+$/, "")}/${dirId}`,
      remoteBranch: provision?.remoteBranch ?? "",
      baseCommit: provision?.baseCommit ?? "",
      // #6: per-repo sources + link snapshots ride the same state so the
      // task view and the Agent see the same repos/links (shared view of
      // the originals, never isolated copies).
      repoSources: provision?.repoSources !== undefined ? [...provision.repoSources] : undefined,
      dirLinks: provision?.dirLinks !== undefined ? [...provision.dirLinks] : undefined,
      ready: provision?.ready ?? (task.repos.length > 0 || task.directories.length > 0),
      lastError: provision?.lastError,
    };
  }

  /**
   * [PiDock 02] header state: name/repo/branch/ready/code-change read from
   * the task record + session state. Errors stay bound to the task id so a
   * failure in one task never surfaces as another task's header.
   */
  async getTaskHeader(taskId: string): Promise<TaskHeaderState> {
    const task = this.task(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    const provision = await this.getTaskProvision(taskId);
    const project = this.projects.find((item) => item.id === task.projectId);
    const repoNames = task.repos.map(
      (id) => project?.repositories.find((repository) => repository.id === id)?.name ?? id,
    );
    return {
      taskId: task.id,
      name: task.name,
      repos: repoNames,
      branch: provision?.branch ?? `task/${task.workspaceKey}`,
      root: provision?.root ?? task.workspaceRoot,
      ready: provision?.ready ?? false,
      changedFiles: task.files.map((file) => ({ path: file.path, status: file.status })),
      error: provision?.lastError ? `${provision.lastError.code}: ${provision.lastError.message}` : undefined,
    };
  }

  /**
   * [PiDock 02] provision a task through the form fields. Mirrors the
   * shell-side per-task provision contract:
   *
   * - Chinese display name validated, auto `task-oooooooo` dir id
   *   conflict-checked, editable branch validated separately;
   * - default root + per-creation override resolved (stored actual root
   *   never migrates on later default changes);
   * - remote baseline pinned before creation (`fetch-failed` keeps the
   *   form with a retry entry instead of creating from a stale ref);
   * - failures are recorded on the provision entry (`lastError`) so the
   *   form keeps its input and offers retry; `ok:false` never throws a
   *   rejected invoke at the caller.
   */
  async provisionTaskThroughForm(input: ProvisionTaskInput): Promise<
    { ok: true; provision: TaskProvisionState } | { ok: false; error: { code: string; message: string } }
  > {
    const named = validateTaskFormName(input.name);
    if (!named.ok) return { ok: false, error: { ...named.error } };
    if (!isTaskDirId(input.dirId)) {
      return { ok: false, error: { code: "invalid-path", message: "任务目录标识格式不正确，请重新生成" } };
    }
    const usedDirIds = this.tasks
      .filter((task) => task.id !== input.taskId)
      .map((task) => task.workspaceKey)
      .filter((key) => isTaskDirId(key));
    const conflict = checkTaskFormDirIdConflict(input.dirId, usedDirIds);
    if (conflict) return { ok: false, error: { ...conflict } };
    const resolved = resolveTaskFormRoot(this.localSettings.workspaceRoot, input.rootOverride);
    if (!resolved.ok) return { ok: false, error: { ...resolved.error } };
    const branched = buildTaskFormBranch(input.dirId, input.branch);
    if (!branched.ok) return { ok: false, error: { ...branched.error } };
    const pinned = pinTaskFormBaseline(input.remoteBranch, input.fetchedCommit);
    if (!pinned.ok) {
      this.provisions.set(input.taskId, {
        branch: branched.branch,
        remoteBranch: input.remoteBranch,
        baseCommit: "",
        ready: false,
        lastError: { ...pinned.error },
      });
      return { ok: false, error: { ...pinned.error } };
    }
    const repoNames = [...(input.repos ?? [])];
    const paths = previewTaskFormPaths(resolved.root, input.dirId, repoNames, []);
    void paths;
    // #6: per-repo sources persist alongside the task-level baseline;
    // plain-dir links snapshot as shared views of the originals.
    // No cross-use: every selection must pin its own freshly fetched
    // commit (mirrors the Host fail-closed gate in `TaskWorkspaceHost`).
    const now = new Date().toISOString();
    // #6 residual: mirror the Host fail-closed gates locally (memory is the
    // offline test double, so it must reject what the Host would reject:
    // selection shape via the same rules as `validateRepoSelections`,
    // per-repo commit shape via `pinTaskFormBaseline`, link-name
    // collisions, and plain-dir source shape).
    const failProvision = (code: string, message: string) => {
      const error = { code, message };
      this.provisions.set(input.taskId, {
        branch: branched.branch,
        remoteBranch: input.remoteBranch,
        baseCommit: "",
        ready: false,
        lastError: { ...error },
      });
      return { ok: false as const, error: { ...error } };
    };
    if (input.repoSelections !== undefined) {
      const seenRepoDirs = new Set<string>();
      for (const selection of input.repoSelections) {
        if (
          typeof selection.repoDir !== "string" ||
          selection.repoDir.length === 0 ||
          selection.repoDir === "." ||
          selection.repoDir === ".." ||
          selection.repoDir.includes("/") ||
          selection.repoDir.includes("\\") ||
          selection.repoDir.includes("\0") ||
          selection.repoDir.trim() !== selection.repoDir
        ) {
          return failProvision("invalid-repo", `仓库目录名不合法: ${String(selection.repoDir)}`);
        }
        if (seenRepoDirs.has(selection.repoDir)) {
          return failProvision("duplicate-repo", `仓库 ${selection.repoDir} 被选择了两次，请只保留一个来源`);
        }
        seenRepoDirs.add(selection.repoDir);
        if (typeof selection.remote !== "string" || selection.remote.trim().length === 0) {
          return failProvision("invalid-repo", `仓库 ${selection.repoDir} 缺少远程名称，请选择本次获取的远程`);
        }
        if (typeof selection.remoteBranch !== "string" || selection.remoteBranch.trim().length === 0) {
          return failProvision("invalid-repo", `仓库 ${selection.repoDir} 缺少基线分支，请选择本次获取的远程分支`);
        }
        if (typeof selection.mainCheckoutDir !== "string" || !isAbsoluteTaskFormRoot(selection.mainCheckoutDir)) {
          return failProvision("repo-unusable", `仓库 ${selection.repoDir} 的来源检出不可用: ${String(selection.mainCheckoutDir)}`);
        }
        const commit = input.fetchedCommits?.[selection.repoDir];
        if (typeof commit !== "string" || commit.trim().length === 0) {
          return failProvision(
            "fetch-failed",
            `仓库 ${selection.repoDir} 尚未获取基线，已保留表单，请重试获取后再创建`,
          );
        }
        const pinnedRepo = pinTaskFormBaseline(selection.remoteBranch, commit);
        if (!pinnedRepo.ok) {
          return failProvision(
            "fetch-failed",
            `仓库 ${selection.repoDir} 获取远程基线失败，已保留表单，请重试获取后再创建`,
          );
        }
      }
    }
    if (input.plainDirs !== undefined) {
      const seenLinkNames = new Map<string, string>();
      for (const entry of input.plainDirs) {
        if (typeof entry.directoryId !== "string" || entry.directoryId.trim().length === 0) {
          return failProvision("invalid-repo", "普通目录缺少标识");
        }
        if (typeof entry.sourcePath !== "string" || !isAbsoluteTaskFormRoot(entry.sourcePath)) {
          return failProvision("repo-unusable", `普通目录来源不可用: ${String(entry.sourcePath)}`);
        }
        const linkName = directoryLinkName({ id: entry.directoryId });
        const first = seenLinkNames.get(linkName);
        if (first !== undefined && first !== entry.directoryId) {
          return failProvision(
            "duplicate-repo",
            `普通目录链接名冲突: ${entry.directoryId} 与 ${first} 均映射到 ${linkName}，请更换目录标识`,
          );
        }
        seenLinkNames.set(linkName, entry.directoryId);
      }
    }
    const repoSources = input.repoSelections?.map((selection) => ({
      repoDir: selection.repoDir,
      remote: selection.remote.trim(),
      remoteBranch: selection.remoteBranch.trim(),
      baseCommit: (input.fetchedCommits?.[selection.repoDir] as string).trim().toLowerCase(),
    }));
    const dirLinks = input.plainDirs?.map((entry) => ({
      linkName: directoryLinkName({ id: entry.directoryId }),
      directoryId: entry.directoryId,
      sourcePath: entry.sourcePath.trim(),
      snapshotAt: now,
    }));
    const entry = {
      branch: branched.branch,
      remoteBranch: pinned.remoteBranch,
      baseCommit: pinned.commit,
      ready: true,
      lastError: undefined as { code: string; message: string } | undefined,
      repoSources,
      dirLinks,
    };
    this.provisions.set(input.taskId, entry);
    const task = this.task(input.taskId);
    if (task) task.workspaceRoot = resolved.root;
    const provision = await this.getTaskProvision(input.taskId);
    if (!provision) return { ok: false, error: { code: "unknown-task", message: `任务不存在: ${input.taskId}` } };
    return { ok: true, provision };
  }

  subscribe(listener: (event: HostEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function createMemoryHost(): HostAdapter {
  // Fresh adapter instances must not inherit a stale cross-session task
  // lock from an earlier test/host (locks are module-scoped by design).
  resetTaskLocksForTests();
  return new MemoryHost();
}

export const memoryHost = createMemoryHost();
