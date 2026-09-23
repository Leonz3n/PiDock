import { useState } from "react";
import { Badge, Button, EmptyState, Panel } from "./ui";
import { CodeBlock } from "./CodeBlock";
import { ConfigTable } from "./ConfigTable";
import type { BrowserPage, Permission, Service, Subagent, Task, TaskDirectory, WorkspaceFile } from "../data/types";
import { directoryLinkPath } from "../data/directories";
import { useDraftStore } from "../stores/drafts";
import { useHostStore } from "../stores/host";
import {
  buildFreshnessLabel,
  codeStateLabel,
  failureLabel,
  instanceAddress,
  projectServiceTopology,
  type ServiceTopologyView,
} from "../data/serviceTopology";
import {
  browserActionRefusal,
  markBrowserIssue,
  readBrowserEvidence,
  readBrowserPageState,
  setBrowserTakeover,
} from "../data/browserSurface";

export function RuntimePanel({
  task,
  topology: provided,
  onToggleService,
  onSetServiceMode,
  readonly = false,
  onReadonlyAttempt,
}: {
  task: Task;
  /** Adapter view (Host plan in shell mode); falls back to the pure projection. */
  topology?: ServiceTopologyView;
  onToggleService: (serviceId: string, running: boolean) => void;
  onSetServiceMode?: (serviceId: string, mode: Service["mode"]) => void;
  /** Read-only sessions cannot change run state (prototype `sessionReadonly()`). */
  readonly?: boolean;
  onReadonlyAttempt?: () => void;
}) {
  const [selected, setSelected] = useState<string | undefined>(task.services[0]?.id);
  const service: Service | undefined = task.services.find((item) => item.id === selected) ?? task.services[0];
  // [PiDock 05] (#10) task-view projection: unit identity + location, the
  // actual dependency destination, the start groups (prestart / bidirectional
  // listener group), the run record and the shared-resource limits.
  const topology = provided ?? projectServiceTopology(task, environmentName(task));
  const selectedUnit = service ? topology.units.find((unit) => unit.serviceId === service.id) : undefined;
  const selectedRouting = selectedUnit ? topology.routing.filter((entry) => entry.unitId === selectedUnit.unitId) : [];
  const selectedGroups = selectedUnit
    ? topology.groups.filter((group) => group.members.includes(selectedUnit.unitId))
    : [];
  const locationLabel = (item: Service) => {
    if (item.runType === "prepare") return item.port !== undefined ? `准备步骤 · 本地 :${item.port}` : "准备步骤 · 本机命令";
    if (item.mode === "remote") return "远程依赖";
    return item.port !== undefined ? `本地 :${item.port}` : "本地";
  };
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-1.5">
        {task.services.map((item) => {
          const unit = topology.units.find((candidate) => candidate.serviceId === item.id);
          return (
          <li key={item.id} className="flex items-center justify-between gap-2 rounded-md border border-line px-2.5 py-2 text-xs">
            <button type="button" className="text-left" data-testid={`service-row-${item.id}`} onClick={() => setSelected(item.id)}>
              <span className="text-ink">{item.name}</span>
              <span className="ml-2 text-muted">
                {locationLabel(item)}
                {item.repo ? ` · ${item.repo}` : ""}
              </span>
              {unit ? (
                <span className="ml-2 font-mono text-[10px] text-muted" data-testid={`service-instance-${item.id}`}>
                  {instanceAddress(task.id, unit.serviceId, item.port)}
                </span>
              ) : null}
            </button>
            <div className="flex items-center gap-2">
              <Badge tone={item.running ? "accent" : "neutral"}>{item.running ? "运行中" : item.mode === "remote" ? "远程" : "已停止"}</Badge>
              {item.mode === "local" ? (
                <Button
                  size="sm"
                  onClick={() => {
                    if (readonly) {
                      onReadonlyAttempt?.();
                      return;
                    }
                    onToggleService(item.id, !item.running);
                  }}
                >
                  {item.running ? "停止" : "启动"}
                </Button>
              ) : null}
              {onSetServiceMode ? (
                <Button
                  size="sm"
                  aria-label={`切换 ${item.name} 依赖去向`}
                  onClick={() => {
                    if (readonly) {
                      onReadonlyAttempt?.();
                      return;
                    }
                    onSetServiceMode(item.id, item.mode === "local" ? "remote" : "local");
                  }}
                >
                  {item.mode === "local" ? "改为远程" : "改为本地"}
                </Button>
              ) : null}
            </div>
          </li>
          );
        })}
      </ul>
      {service && service.failure ? (
        <div className="rounded-md border border-warn/60 bg-warn/10 px-2.5 py-2 text-xs" data-testid="service-failure">
          <div className="text-ink">
            {failureLabel(service.failure.code).label} · {service.name}
          </div>
          <div className="mt-1 text-muted">{service.failure.message}</div>
          <div className="mt-1 text-[11px] text-muted">{service.failure.hint ?? failureLabel(service.failure.code).hint}</div>
        </div>
      ) : null}
      {service ? (
        <Panel title={`生效配置 · ${service.name}`}>
          <ConfigTable rows={service.resolved} />
          <p className="mt-2 text-[11px] text-muted">
            敏感值遮蔽；未保存草稿不参与解析。共享模板版本 {service.templateVersion}。
          </p>
        </Panel>
      ) : null}
      {selectedRouting.length > 0 ? (
        <Panel title="依赖去向">
          <ul className="flex flex-col gap-1 text-xs" data-testid="service-routing">
            {selectedRouting.map((entry) => (
              <li key={`${entry.unitId}-${entry.key}`} className="flex items-start justify-between gap-2">
                <span className="shrink-0 font-mono text-[11px] text-ink">{entry.key}</span>
                <span className="text-right text-muted">
                  <span className="block">{entry.value}</span>
                  <span className="block">
                    {entry.target.kind === "local-instance" ? `${entry.target.address}（本任务实例）` : `共享环境 ${entry.target.environment}`}
                  </span>
                  <span className="block text-[10px]">读取点：{entry.readPoints.join("、")}</span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      {selectedGroups.length > 0 ? (
        <Panel title="启动顺序">
          <ul className="flex flex-col gap-1.5 text-xs" data-testid="service-groups">
            {topology.groups.map((group) => (
              <li key={group.groupId} className="rounded-md border border-line px-2 py-1.5">
                <div className="text-ink">
                  {group.reason === "prestart" ? "准备步骤（先完成）" : group.bidirectional ? "双向调用组（先监听再互验）" : "监听"}
                  {" · "}
                  {group.members
                    .map((member) => topology.units.find((unit) => unit.unitId === member)?.name ?? member)
                    .join(" + ")}
                </div>
                {group.verify.length > 0 ? (
                  <ul className="mt-1 flex flex-col gap-0.5 text-[11px] text-muted">
                    {group.verify.map((step) => (
                      <li key={step}>· {step}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      {service?.runRecord ? (
        <Panel title="运行记录">
          <dl className="flex flex-col gap-1 text-[11px] text-muted" data-testid="service-run-record">
            <Row label="运行标识" value={service.runRecord.runId} mono />
            <Row label="模板版本" value={service.runRecord.templateVersion} />
            <Row label="代码状态" value={`${codeStateLabel(service.runRecord.codeState)}${service.runRecord.codeCommit ? ` · ${service.runRecord.codeCommit}` : ""}`} />
            <Row label="构建状态" value={buildFreshnessLabel(service.runRecord.buildFreshness)} />
            <Row label="端口" value={service.runRecord.ports.length > 0 ? service.runRecord.ports.join(", ") : "无端口绑定"} />
            <Row
              label="进程身份"
              value={`${service.runRecord.processIdentity.owner === "human" ? "用户操作" : "Agent"} · pid ${service.runRecord.processIdentity.pid} · ${service.runRecord.processIdentity.startedAt}`}
            />
            <Row label="日志" value={service.runRecord.logRef} mono />
            {service.runRecord.exitReason ? <Row label="结束原因" value={service.runRecord.exitReason} /> : null}
            {service.runRecord.simulated ? <Row label="数据来源" value="内存模拟记录（未接入真实进程）" /> : null}
          </dl>
          {service.runRecord.verifications.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-0.5 text-[11px] text-muted">
              {service.runRecord.verifications.map((verification) => (
                <li key={verification.detail}>
                  · {verification.ok ? "通过" : "未通过"} {verification.detail}
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>
      ) : null}
      {topology.resources.length > 0 ? (
        <Panel title="共享外部资源与已知限制">
          <ul className="flex flex-col gap-1 text-[11px] text-muted" data-testid="service-known-limits">
            {topology.resources.map((resource) => (
              <li key={resource.resourceId}>
                {resource.name} · {resource.isolation === "isolated" ? "已隔离" : resource.isolation === "not-isolated" ? "共享（未隔离）" : "隔离未验证"}
              </li>
            ))}
            {topology.knownLimits.map((limit) => (
              <li key={limit}>· {limit}</li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

/** Small definition row used by the run-record block. */
function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0">{label}</dt>
      <dd className={`text-right text-ink ${mono ? "font-mono text-[10px]" : ""}`}>{value}</dd>
    </div>
  );
}

/** Environment display name for the task (remote target label / tests). */
function environmentName(task: Task): string {
  return task.environmentId;
}

export function BrowserPanel({
  pages,
  taskId,
  sessionId,
  permission,
}: {
  pages: BrowserPage[];
  taskId: string;
  /** Current session a marker is sent into (absent outside a task session). */
  sessionId?: string;
  /** Session tier: read-only means the Agent will not drive the page. */
  permission?: Permission;
}) {
  const [pageId, setPageId] = useState(pages[0]?.id);
  const [takeover, setTakeover] = useState<{ paused: boolean; reason?: string }>({ paused: false });
  const [marks, setMarks] = useState<{ id: string; label: string; needsRelocation: boolean }[]>([]);
  const [notice, setNotice] = useState<string>();
  const [annotation, setAnnotation] = useState("");
  const [evidence, setEvidence] = useState<{ consoleErrors: string[]; failedRequests: { url: string; errorText: string }[] }>({
    consoleErrors: [],
    failedRequests: [],
  });
  const active = pages.find((page) => page.id === pageId) ?? pages[0];
  const handle = active ? { pageId: active.id } : undefined;
  const agentRefusal = permission !== undefined ? browserActionRefusal(permission) : undefined;

  const toggleTakeover = async () => {
    if (!handle) return;
    const paused = !takeover.paused;
    const result = await setBrowserTakeover({ taskId, page: handle, paused, reason: "用户接管" });
    setTakeover(paused ? { paused: true, reason: "用户接管" } : { paused: false });
    setNotice(result.kind === "idle" ? undefined : result.text);
  };

  const markIssue = async () => {
    if (!handle || !active) return;
    // Read the page state first: a marker is raised against the live epoch,
    // and the panel refreshes when the page has moved on.
    const state = await readBrowserPageState({ taskId, page: handle });
    const marked = await markBrowserIssue({
      taskId,
      page: handle,
      url: state.url.length > 0 ? state.url : active.url,
      annotation,
      epoch: state.epoch,
      mode: "box",
      // No fabricated locator: element/semantic info is attached only when
      // the page-side picker actually produced one (GUI residual).
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
    setNotice(marked.notice.kind === "idle" ? undefined : marked.notice.text);
    const marker = marked.marker;
    if (marker) {
      setMarks((items) => [...items, { id: marker.id, label: `${marker.annotation} · ${marker.url}`, needsRelocation: marker.needsRelocation }]);
      setAnnotation("");
    }
  };

  const refreshEvidence = async () => {
    if (!handle) return;
    const result = await readBrowserEvidence({ taskId, page: handle });
    setEvidence(result.evidence);
    setNotice(result.ok ? "已获取当前页面的控制台与网络失败证据（内容已限幅）" : result.error);
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-muted">
        任务页面与 PiDock 自有界面分属不同信任范围；Agent 与用户操作同一页面实例，渲染层不直接调用 CDP。
      </p>
      {agentRefusal ? <p className="text-[11px] text-muted">{agentRefusal}</p> : null}
      <ul className="flex flex-col gap-1.5">
        {pages.map((page) => (
          <li key={page.id} className="rounded-md border border-line px-2.5 py-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-ink">{page.title}</span>
              <Badge>{page.id === active?.id ? "当前页面" : "标签页"}</Badge>
            </div>
            <p className="mt-1 font-mono text-[11px] text-muted">{page.url}</p>
            {pages.length > 1 ? (
              <Button size="sm" variant="ghost" onClick={() => setPageId(page.id)}>
                切换到此页
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void toggleTakeover()}>
          {takeover.paused ? "交还控制" : "人工接管"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void refreshEvidence()}>
          获取证据
        </Button>
        <Badge tone={takeover.paused ? "warn" : "neutral"}>{takeover.paused ? "人工接管中：自动化已暂停" : "Agent 控制中"}</Badge>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-[11px] text-muted" htmlFor="browser-marker-annotation">
          标记说明
        </label>
        <input
          id="browser-marker-annotation"
          className="rounded-md border border-line bg-transparent px-2.5 py-1.5 text-xs text-ink"
          placeholder="例如：总额与对账单不一致"
          value={annotation}
          onChange={(event) => setAnnotation(event.target.value)}
        />
        <Button size="sm" onClick={() => void markIssue()} disabled={!handle}>
          框选元素标记
        </Button>
      </div>
      {notice ? <p className="text-[11px] text-muted">{notice}</p> : null}
      {evidence.consoleErrors.length > 0 || evidence.failedRequests.length > 0 ? (
        <ul className="flex flex-col gap-1.5 text-xs">
          {evidence.consoleErrors.map((text, index) => (
            <li key={`console-${index}`} className="rounded-md border border-line px-2.5 py-2 font-mono text-[11px] text-muted">
              控制台：{text}
            </li>
          ))}
          {evidence.failedRequests.map((request, index) => (
            <li key={`network-${index}`} className="rounded-md border border-line px-2.5 py-2 font-mono text-[11px] text-muted">
              网络：{request.url} · {request.errorText}
            </li>
          ))}
        </ul>
      ) : null}
      {marks.length > 0 ? (
        <ul className="flex flex-col gap-1.5 text-xs">
          {marks.map((mark) => (
            <li key={mark.id} className="rounded-md border border-line px-2.5 py-2">
              {mark.label} · 页面快照与元素信息随说明发送
              {mark.needsRelocation ? " · 页面已变化，Agent 需重新定位" : ""}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState>还没有标记。页面刷新后旧标记会失效，需要重新定位。</EmptyState>
      )}
    </div>
  );
}

export function FilesPanel({ files }: { files: WorkspaceFile[] }) {
  const preview = files.find((file) => file.preview)?.preview;
  const previewPath = files.find((file) => file.preview)?.path;
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-1 text-xs">
        {files.map((file) => (
          <li key={file.path} className="flex items-center justify-between gap-2 rounded border border-line px-2.5 py-1.5">
            <span className="font-mono text-[11px] text-ink">{file.path}</span>
            <Badge tone={file.status === "added" ? "accent" : "warn"}>
              {file.status === "added" ? "新增" : file.status === "deleted" ? "已删除" : "已修改"}
            </Badge>
          </li>
        ))}
      </ul>
      {preview ? <CodeBlock label={previewPath} language={preview.language} code={preview.source} /> : null}
    </div>
  );
}

export function TerminalPanel({ taskId, seed }: { taskId: string; seed: string[] }) {
  const runTerminalCommand = useHostStore((state) => state.runTerminalCommand);
  const [lines, setLines] = useState<string[]>(seed);
  const [value, setValue] = useState("");
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] text-muted">终端输出与输入由本面板渲染，PTY 属于受管执行侧；当前为内存模拟。</p>
      <div className="h-56 overflow-auto rounded-md border border-line bg-ink/95 p-3 font-mono text-[11px] leading-5 text-white/90">
        {lines.map((line, index) => (
          <div key={`${line}-${index}`}>{line}</div>
        ))}
      </div>
      <form
        className="flex gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          const command = value.trim();
          if (!command) return;
          setValue("");
          const output = await runTerminalCommand(taskId, command);
          setLines((items) => [...items, ...output]);
        }}
      >
        <input
          aria-label="终端输入"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="flex-1 rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-xs"
          placeholder="输入命令"
        />
        <Button size="sm" type="submit">
          执行
        </Button>
      </form>
    </div>
  );
}

const SUBAGENT_STATUS_LABEL: Record<Subagent["status"], string> = {
  running: "运行中",
  completed: "已完成",
  waiting: "等待中",
  failed: "失败",
  stopped: "已停止",
};

/** Card list of a session's child agents; selecting one opens the read-only sidebar. */
export function SessionSubagentList({
  agents,
  selectedId,
  onSelect,
}: {
  agents: Subagent[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  if (agents.length === 0) return null;
  const running = agents.filter((agent) => agent.status === "running").length;
  return (
    <div className="rounded-panel border border-line bg-paper px-3 py-2.5" aria-label="当前会话启动的 Subagent">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-ink">Subagent <Badge>{agents.length}</Badge></span>
        <small className="text-muted">{running > 0 ? `${running} 个运行中` : "全部已结束"} · 示例</small>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            aria-pressed={agent.id === selectedId}
            onClick={() => onSelect(agent.id)}
            className={`w-56 rounded-md border px-2.5 py-2 text-left text-xs ${
              agent.id === selectedId ? "border-accent/40 bg-accent/10 text-accent" : "border-line text-ink hover:bg-soft"
            }`}
          >
            <span className="flex items-center justify-between gap-2">
              <strong>{agent.name}</strong>
              <Badge tone={agent.status === "running" ? "accent" : agent.status === "failed" ? "warn" : "neutral"}>
                {SUBAGENT_STATUS_LABEL[agent.status]}
              </Badge>
            </span>
            <small className="mt-1 block text-muted">{agent.summary}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Read-only child-agent detail; the main composer keeps sending to the parent session. */
export function SubagentPanel({
  agents,
  selectedId,
  parentLabel,
  sessionName,
  onSelect,
}: {
  agents: Subagent[];
  selectedId: string;
  parentLabel: string;
  sessionName: string;
  onSelect: (id: string) => void;
}) {
  const agent = agents.find((item) => item.id === selectedId) ?? agents[0];
  if (!agent) return <EmptyState>本会话尚未启动 Subagent</EmptyState>;
  return (
    <Panel title="Subagent" actions={<Badge>示例记录</Badge>}>
      <div className="text-[11px] text-muted">
        <div>{parentLabel}</div>
        <div>所属会话：{sessionName}</div>
      </div>
      <label className="mt-3 flex flex-col gap-1 text-[11px] text-muted">
        选择 Subagent
        <select
          aria-label="选择 Subagent"
          value={agent.id}
          onChange={(event) => onSelect(event.target.value)}
          className="rounded-md border border-line bg-paper px-2 py-1 text-xs"
        >
          {agents.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {SUBAGENT_STATUS_LABEL[item.status]}
            </option>
          ))}
        </select>
      </label>
      <div className="mt-3 flex items-center justify-between text-xs">
        <Badge tone={agent.status === "running" ? "accent" : "neutral"}>{SUBAGENT_STATUS_LABEL[agent.status]}</Badge>
        <small className="text-muted">{agent.started} 启动 · {agent.mode}</small>
      </div>
      <p className="mt-1 text-[11px] text-muted">{agent.provider} / {agent.model}</p>
      <details className="mt-3 rounded-md border border-line px-2.5 py-2 text-xs">
        <summary className="text-ink">分配的任务</summary>
        <p className="mt-1 text-muted">{agent.assignment}</p>
      </details>
      <ul className="mt-3 flex flex-col gap-2">
        {agent.events.map((event, index) => (
          <li key={index} className="rounded-md border border-line px-2.5 py-2 text-xs">
            {event.kind === "tool" ? (
              <details>
                <summary className="text-ink">
                  {event.name} <small className="text-muted">{event.time}</small>
                </summary>
                <code className="mt-1 block font-mono text-[11px] text-muted">{event.command}</code>
                <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-ink">{event.output}</pre>
              </details>
            ) : (
              <>
                <div className="flex items-center justify-between text-ink">
                  <strong>{event.role === "主 Agent" ? "主 Agent" : agent.name}</strong>
                  <small className="text-muted">{event.time}</small>
                </div>
                <p className="mt-1 text-muted">{event.text}</p>
              </>
            )}
          </li>
        ))}
      </ul>
      {agent.result ? (
        <div className="mt-3 rounded-md border border-accent/25 bg-accent/10 px-2.5 py-2 text-xs text-accent">
          已返回主会话：{agent.result}
        </div>
      ) : null}
      <p className="mt-3 text-[11px] text-muted">仅查看 · 左侧输入框仍发送给主会话；不启动真实子代理。</p>
    </Panel>
  );
}

export function LogsPanel({ task }: { task: Task }) {
  // Mirrors the prototype's `logsView()`: per-service lifecycle lines plus the
  // shared routing/dependency lines. Timestamps and messages are in-memory samples.
  const localServices = task.services.filter((service) => service.mode === "local");
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-ink">运行日志</span>
        <Badge>示例记录</Badge>
      </div>
      <div className="h-56 overflow-auto rounded-md border border-line bg-ink/95 p-3 font-mono text-[11px] leading-5 text-white/90" data-testid="runtime-logs">
        {localServices.length === 0 ? (
          <div>尚未配置本地服务。可在环境与服务中按需添加。</div>
        ) : (
          localServices.map((service) => (
            <div key={service.id}>
              <span className="text-accent">{service.runRecord?.startedAt.slice(11, 19) ?? "10:25:01"}</span> [{service.name}]{' '}
              {service.running ? `listening at :${service.port}` : "process stopped"}
            </div>
          ))
        )}
        <div>10:25:02 [routes] local task bindings resolved</div>
        <div>10:25:03 [account-service] remote test environment</div>
      </div>
      {/* [PiDock 05] (#10): each log belongs to one run record, so the panel
          names the instance and the exact log file instead of a shared stream. */}
      {localServices.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-[11px] text-muted" data-testid="log-instances">
          {localServices.map((service) => (
            <li key={service.id}>
              {service.name} · {instanceAddress(task.id, service.id, service.port)}
              {service.runRecord ? ` · ${service.runRecord.logRef}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-[11px] text-muted">日志按运行实例与运行记录归属；这里仅展示信息布局，未接入真实日志流。</p>
    </div>
  );
}

/**
 * Directory root chooser shared by the ordinary-directory file and terminal
 * panels. The prototype's `directoryRootChoices()` lists the Git worktrees and
 * the ordinary directories so a mixed task can switch back to its worktree
 * view; the renderer shows one combined worktree entry because its file panel
 * already merges the task's repositories.
 */
export function DirectoryRootChoices({ task, selected, onSelect }: { task: Task; selected?: TaskDirectory; onSelect: (id: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {task.repos.length > 0 ? (
        <Button size="sm" variant={selected ? "default" : "primary"} onClick={() => onSelect("")}>
          仓库工作副本
        </Button>
      ) : null}
      {task.directories.map((directory) => (
        <Button
          key={directory.id}
          size="sm"
          variant={selected?.id === directory.id ? "primary" : "default"}
          onClick={() => onSelect(directory.id)}
        >
          {directory.name}
        </Button>
      ))}
    </div>
  );
}

/**
 * File panel for an ordinary directory. It shows the in-task symlink path and
 * the original path, and deliberately offers no Git diff / branch / commit
 * entry points. Editing through the link affects the original directory.
 *
 * Selection is controlled when a mixed task shares one active directory across
 * its file and terminal panels; the directory-only task keeps local state.
 */
export function DirectoryFilesPanel({
  task,
  selectedId: controlledId,
  onSelect,
}: {
  task: Task;
  selectedId?: string;
  onSelect?: (id: string) => void;
}) {
  const [localId, setLocalId] = useState(task.directories[0]?.id ?? "");
  const selectedId = controlledId ?? localId;
  const select = (id: string) => {
    setLocalId(id);
    onSelect?.(id);
  };
  const directory = task.directories.find((item) => item.id === selectedId) ?? task.directories[0];
  const createDirectoryFileReference = useHostStore((state) => state.createDirectoryFileReference);
  const addReference = useDraftStore((state) => state.addReference);
  if (!directory) return <EmptyState>这个任务还没有普通目录。</EmptyState>;
  const linkPath = directoryLinkPath(task.workspaceRoot, task.workspaceKey, directory);
  return (
    <div className="flex flex-col gap-3">
      <DirectoryRootChoices task={task} selected={directory} onSelect={select} />
      <div className="rounded-md border border-line bg-soft/40 px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <strong className="text-ink">{directory.name}</strong>
          <Badge>软链接</Badge>
        </div>
        <p className="mt-1 text-[11px] text-muted">任务内软链接</p>
        <p className="font-mono text-[11px] text-ink" data-testid="directory-link-path">
          {linkPath}
        </p>
        <p className="mt-1 font-mono text-[11px] text-muted" data-testid="directory-original-path">
          指向原目录：{directory.path}
        </p>
        <p className="mt-1 text-[11px] text-muted">修改会影响原目录 · 文件未隔离</p>
      </div>
      <div className="rounded-md border border-line px-2.5 py-2 text-xs">
        <p className="font-mono text-[11px] text-ink">▾ {directory.linkName} → {directory.name}</p>
        <p className="mt-1 font-mono text-[11px] text-muted">{"  README.md（示例）"}</p>
      </div>
      <CodeBlock label={`${directory.linkName}/README.md`} language="markdown" code={"# 项目资料\n\n在这里整理说明与待办。"} />
      <Button
        size="sm"
        onClick={async () => addReference(task.id, task.activeSessionId, await createDirectoryFileReference(task.id, directory.id))}
      >
        引用示例文件
      </Button>
      <p className="text-[11px] text-muted">未读取真实目录。此目录不提供 Git 差异、分支或提交操作。</p>
    </div>
  );
}

/** Terminal panel that opens in the in-task symlink directory and shows the intended cwd. */
export function DirectoryTerminalPanel({
  task,
  selectedId: controlledId,
  onSelect,
}: {
  task: Task;
  selectedId?: string;
  onSelect?: (id: string) => void;
}) {
  const [localId, setLocalId] = useState(task.directories[0]?.id ?? "");
  const selectedId = controlledId ?? localId;
  const select = (id: string) => {
    setLocalId(id);
    onSelect?.(id);
  };
  const directory = task.directories.find((item) => item.id === selectedId) ?? task.directories[0];
  const runTerminalCommand = useHostStore((state) => state.runTerminalCommand);
  const [lines, setLines] = useState<string[]>([]);
  const [value, setValue] = useState("");
  if (!directory) return <EmptyState>这个任务还没有普通目录。</EmptyState>;
  const cwd = directoryLinkPath(task.workspaceRoot, task.workspaceKey, directory);
  return (
    <div className="flex flex-col gap-2">
      <DirectoryRootChoices task={task} selected={directory} onSelect={select} />
      <p className="text-[11px] text-muted">拟用工作目录</p>
      <p className="font-mono text-[11px] text-ink" data-testid="directory-terminal-cwd">
        {cwd}
      </p>
      <p className="font-mono text-[11px] text-muted">指向原目录：{directory.path}</p>
      <p className="text-[11px] text-muted">原型终端：拟从以上链接位置打开，仅回显，不执行命令。</p>
      <div className="h-48 overflow-auto rounded-md border border-line bg-ink/95 p-3 font-mono text-[11px] leading-5 text-white/90">
        {lines.map((line, index) => (
          <div key={`${line}-${index}`}>{line}</div>
        ))}
      </div>
      <form
        className="flex gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          const command = value.trim();
          if (!command) return;
          setValue("");
          const output = await runTerminalCommand(task.id, command);
          setLines((items) => [...items, ...output]);
        }}
      >
        <input
          aria-label="终端输入"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="flex-1 rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-xs"
          placeholder="输入示例命令"
        />
        <Button size="sm" type="submit">
          执行
        </Button>
      </form>
    </div>
  );
}
