import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Badge, Button, EmptyState, IconButton, Panel } from "./ui";
import { Icon, type IconName } from "./Icon";
import { CodeBlock } from "./CodeBlock";
import { ConfigTable } from "./ConfigTable";
import type { BrowserPage, Environment, Permission, Service, Subagent, Task, TaskDirectory, WorkspaceFile } from "../data/types";
import type { ToolPanel } from "../stores/ui";
import { environmentLabel } from "../data/shellNav";
import { directoryLinkPath } from "../data/directories";
import { useDraftStore } from "../stores/drafts";
import { useHostStore } from "../stores/host";
import { useUiStore } from "../stores/ui";
import {
  buildFreshnessLabel,
  codeStateLabel,
  failureLabel,
  instanceAddress,
  projectServiceTopology,
  type ServiceTopologyView,
} from "../data/serviceTopology";
import { serviceRouteView } from "../data/serviceTopology";
import {
  browserActionRefusal,
  markBrowserIssue,
  readBrowserEvidence,
  readBrowserPageState,
  setBrowserTakeover,
} from "../data/browserSurface";
import {
  protocolConsumerStateLabel,
  protocolModeLabel,
  toolchainStatusLabel,
  type ProtocolBindingView,
} from "../data/protocolBinding";
import type {
  TerminalHistoryEntryView,
  TerminalPlanView,
  TerminalStateView,
  WorkspaceBrowserView,
} from "../data/workspaceFiles";

export function panelName(panel: ToolPanel) {
  return { runtime: "运行", protocol: "协议", browser: "浏览器", files: "文件", terminal: "终端", logs: "日志" }[panel];
}

/**
 * Tool launcher glyphs ([UI 对齐 03] #27): the prototype's `toolItems` mapping
 * (`app.js`), plus `link` for 协议 — the prototype has no protocol tool, and the
 * panel is about generated artifacts and their local bindings.
 */
export const PANEL_ICONS: Record<ToolPanel, IconName> = {
  runtime: "server",
  protocol: "link",
  browser: "globe",
  files: "file",
  terminal: "terminal",
  logs: "chart",
};

/**
 * The prototype's `.workbench` ([UI 对齐 04] #28): a `.work-tabs` strip with one
 * tab per open tool — each with its own close button — plus the 收起工具区
 * control at the end, and a single `.work-content` that renders only the active
 * panel. The rail therefore never stacks panels, and a tab close only removes
 * the tab (the Host keeps services, browser pages and terminals).
 */
export function ToolWorkbench({
  panels,
  activePanel,
  onSelectPanel,
  onClosePanel,
  onCollapse,
  children,
}: {
  panels: ToolPanel[];
  activePanel: ToolPanel;
  onSelectPanel: (panel: ToolPanel) => void;
  onClosePanel: (panel: ToolPanel) => void;
  onCollapse: () => void;
  children: ReactNode;
}) {
  // ARIA tabs pattern with roving tab index: the strip is one Tab stop, arrow
  // keys move the selection (and focus), Home/End jump to the ends.
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const moveSelection = (panel: ToolPanel, step: number | "first" | "last") => {
    const from = panels.indexOf(panel);
    const target =
      step === "first" ? panels[0] : step === "last" ? panels[panels.length - 1] : panels[(from + step + panels.length) % panels.length];
    if (target === undefined) return;
    onSelectPanel(target);
    tabRefs.current[target]?.focus();
  };
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, panel: ToolPanel) => {
    const keys = {
      ArrowRight: 1,
      ArrowLeft: -1,
    } as const;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      moveSelection(panel, keys[event.key]);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      moveSelection(panel, event.key === "Home" ? "first" : "last");
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectPanel(panel);
    }
  };
  return (
    <section
      data-testid="task-workbench"
      aria-label="任务工具面板"
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-panel border border-line bg-[#fafbfb]"
    >
      <div className="flex h-11 min-h-11 items-center gap-1.5 border-b border-line bg-paper px-4">
        <div
          role="tablist"
          aria-label="已打开的工具"
          data-testid="tool-tabs"
          className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto"
        >
          {panels.map((panel) => {
            const active = panel === activePanel;
            return (
              <div
                key={panel}
                data-testid={`tool-tab-item-${panel}`}
                className={`flex shrink-0 items-center border-b-2 ${active ? "border-accent" : "border-transparent"}`}
              >
                <button
                  type="button"
                  role="tab"
                  id={`tool-tab-${panel}`}
                  aria-selected={active}
                  aria-controls="tool-panel"
                  tabIndex={active ? 0 : -1}
                  ref={(node) => {
                    tabRefs.current[panel] = node;
                  }}
                  onKeyDown={(event) => onTabKeyDown(event, panel)}
                  data-testid={`tool-tab-${panel}`}
                  onClick={() => onSelectPanel(panel)}
                  className={`flex items-center gap-1.5 whitespace-nowrap py-2.5 pl-1.5 pr-0.5 text-[11px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${active ? "font-medium text-accent" : "text-muted hover:text-ink"}`}
                >
                  <Icon name={PANEL_ICONS[panel]} className="h-3.5 w-3.5" />
                  {panelName(panel)}
                </button>
                <button
                  type="button"
                  data-testid={`tool-tab-close-${panel}`}
                  aria-label={`关闭${panelName(panel)}`}
                  title={`关闭${panelName(panel)}`}
                  onClick={() => onClosePanel(panel)}
                  className="mr-1 grid h-5 w-5 place-items-center rounded text-[#9ba4b2] hover:bg-soft hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <Icon name="close" className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
        {/* The collapse control sits beside the strip, not inside it: the ARIA
            tabs pattern expects `tablist` to own only tabs, and the visual row
            keeps it at the right edge (prototype `.collapse-tools`). */}
        <IconButton
          icon="close"
          label="收起工具区"
          className="ml-auto shrink-0"
          data-testid="collapse-tools"
          onClick={onCollapse}
        />
      </div>
      <div
        id="tool-panel"
        role="tabpanel"
        aria-labelledby={`tool-tab-${activePanel}`}
        data-testid="tool-content"
        className="min-h-0 flex-1 overflow-auto p-5"
      >
        {children}
      </div>
    </section>
  );
}

export function RuntimePanel({
  task,
  topology: provided,
  environments = [],
  onToggleService,
  onSetServiceMode,
  readonly = false,
  onReadonlyAttempt,
}: {
  task: Task;
  /** Adapter view (Host plan in shell mode); falls back to the pure projection. */
  topology?: ServiceTopologyView;
  /** Workspace environments: the route box names the shared environment. */
  environments?: readonly Environment[];
  onToggleService: (serviceId: string, running: boolean) => void;
  onSetServiceMode?: (serviceId: string, mode: Service["mode"]) => void;
  /** Read-only sessions cannot change run state (prototype `sessionReadonly()`). */
  readonly?: boolean;
  onReadonlyAttempt?: () => void;
}) {
  // The selected row survives a tab swap, like the prototype's global `state`
  // (#28 review P2-3), so the detail blocks below keep their subject.
  const selected = useUiStore((state) => state.toolPanelState[task.id]?.runtimeServiceId) ?? task.services[0]?.id;
  const setPanelState = useUiStore((state) => state.setToolPanelState);
  const setSelected = (serviceId: string) => setPanelState(task.id, { runtimeServiceId: serviceId });
  const service: Service | undefined = task.services.find((item) => item.id === selected) ?? task.services[0];
  // The environment is named the way the rest of the app names it: the display
  // name ("测试环境"), not the task's `environmentId` (#28 review P2-1).
  const environment = environmentLabel(task, environments);
  // [PiDock 05] (#10) task-view projection: unit identity + location, the
  // actual dependency destination, the start groups (prestart / bidirectional
  // listener group), the run record and the shared-resource limits.
  const topology = provided ?? projectServiceTopology(task, environment);
  const selectedUnit = service ? topology.units.find((unit) => unit.serviceId === service.id) : undefined;
  const selectedRouting = selectedUnit ? topology.routing.filter((entry) => entry.unitId === selectedUnit.unitId) : [];
  const selectedGroups = selectedUnit
    ? topology.groups.filter((group) => group.members.includes(selectedUnit.unitId))
    : [];
  const locationLabel = (item: Service) => {
    if (item.runType === "prepare") return item.port !== undefined ? `准备步骤 · 本地 :${item.port}` : "准备步骤 · 本机命令";
    if (item.mode === "remote") return "测试环境 · 共享";
    return item.port !== undefined ? `127.0.0.1:${item.port} · ${item.running ? "运行中" : "已停止"}` : `本地 · ${item.running ? "运行中" : "已停止"}`;
  };
  // Prototype `services()`: 「本地运行」 and 「远程依赖」 groups over the same
  // compact rows, so the panel answers "what runs here" before the per-service
  // detail below.
  const localServices = task.services.filter((item) => item.mode === "local");
  const remoteServices = task.services.filter((item) => item.mode === "remote");
  const route = serviceRouteView(topology, environment);
  const serviceRow = (item: Service) => {
    const unit = topology.units.find((candidate) => candidate.serviceId === item.id);
    const endpoint = locationLabel(item);
    const address = unit ? instanceAddress(task.id, unit.serviceId, item.port) : undefined;
    return (
      <li
        key={item.id}
        data-testid={`service-item-${item.id}`}
        // The panel is 43% of the workspace and the instance address is a long
        // monospace string: the row keeps the endpoint on its own line and
        // exposes the untruncated identity through `title` (#27 review P2-A).
        title={[item.name, endpoint, address].filter((part): part is string => part !== undefined).join(" · ")}
        className="flex items-center gap-2.5 border-b border-[#f0f0f1] px-2.5 py-2.5 last:border-0"
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.running ? "bg-accent shadow-[0_0_0_3px_rgba(66,90,147,0.07)]" : "bg-[#9aa4ab]"}`} />
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          data-testid={`service-row-${item.id}`}
          onClick={() => setSelected(item.id)}
        >
          <span className="block truncate text-[11px] text-ink">{item.name}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            {/* The endpoint is the prototype's `.endpoint` and must stay readable
                at every tier, so it never shrinks; the instance address wraps to
                its own line when the rail is narrow and truncates there. */}
            <span className="shrink-0 font-mono text-[10px] text-muted" data-testid={`service-endpoint-${item.id}`}>{endpoint}</span>
            {unit ? (
              <span className="min-w-0 truncate font-mono text-[10px] text-muted" data-testid={`service-instance-${item.id}`}>
                {instanceAddress(task.id, unit.serviceId, item.port)}
              </span>
            ) : null}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1 whitespace-nowrap">
          {onSetServiceMode ? (
            <Button
              size="sm"
              className="shrink-0"
              title="切换本地或远程"
              aria-label={`切换 ${item.name} 依赖去向`}
              onClick={() => {
                if (readonly) {
                  onReadonlyAttempt?.();
                  return;
                }
                onSetServiceMode(item.id, item.mode === "local" ? "remote" : "local");
              }}
            >
              {item.mode === "local" ? "本地" : "远程"}
            </Button>
          ) : null}
          {item.runType !== "prepare" ? (
            <IconButton
              icon={item.running ? "stop" : "play"}
              label={`${item.running ? "停止" : "启动"} ${item.name}`}
              className="shrink-0"
              onClick={() => {
                if (readonly) {
                  onReadonlyAttempt?.();
                  return;
                }
                onToggleService(item.id, !item.running);
              }}
            />
          ) : null}
        </div>
      </li>
    );
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5" data-testid="service-groups-view">
        <div className="flex items-center justify-between text-[10px] tracking-[1px] text-muted">
          <span>本地运行</span>
          <span>自动分配端口</span>
        </div>
        <ul className="overflow-hidden rounded-md border border-line bg-paper" data-testid="service-list-local">
          {localServices.map(serviceRow)}
        </ul>
      </div>
      {remoteServices.length > 0 ? (
        <div className="flex flex-col gap-1.5" data-testid="service-remote-group">
          <div className="text-[10px] tracking-[1px] text-muted">远程依赖</div>
          <ul className="overflow-hidden rounded-md border border-line bg-paper" data-testid="service-list-remote">
            {remoteServices.map(serviceRow)}
          </ul>
        </div>
      ) : null}
      <div className="rounded-md border border-dashed border-[#d5d8e0] px-3 py-3 text-[10px] leading-relaxed text-muted" data-testid="service-route-box">
        <div className="text-ink">请求去向 · {route.environment}</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {route.local.map((segment) => (
            <span key={segment.name} className="flex items-center gap-1.5">
              {segment.connector === "call" ? <span aria-hidden="true">→</span> : null}
              {segment.connector === "pair" ? <span aria-hidden="true">⇄</span> : null}
              <code className="rounded border border-line bg-paper px-1.5 py-0.5 font-mono">{segment.name}</code>
            </span>
          ))}
          {route.remote.length > 0 ? <span>· 远程 {route.remote.join("、")}</span> : null}
        </div>
        <div className="mt-1.5">本地依赖指向当前任务实例；远程数据设施沿用共享环境。</div>
      </div>

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
      {/* Prototype `services()` closing note: the task owns its working copies,
          processes, ports and browser state. */}
      <p className="text-[10px] leading-relaxed text-muted" data-testid="service-runtime-note">
        worktree、进程、端口和浏览器状态按任务独立。
      </p>
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

/**
 * [PiDock 08] (#14) protocol preparation panel: the protocol repository, the
 * generation steps, the *actual* generated version, each consumer's binding
 * and staleness, the platform toolchain result and the reasons a switch is
 * stopped. Display only — the Host owns the decisions; the panel never shows a
 * generated version it was not given.
 */
export function ProtocolPanel({ view }: { view: ProtocolBindingView }) {
  const staleConsumers = view.consumers.filter((consumer) => consumer.state !== "ready");
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-1.5 text-xs" data-testid="protocol-summary">
        <li className="rounded-md border border-line px-2 py-1.5">
          <span className="text-ink">协议仓库 {view.protocol.repoDir || "未配置"}</span>
          <span className="block text-[10px] text-muted">
            绑定方式：{protocolModeLabel(view.mode)}
            {view.simulated ? " · 内存投影（非 Host 结果）" : ""}
          </span>
        </li>
        <li className="rounded-md border border-line px-2 py-1.5" data-testid="protocol-generated-version">
          <span className="text-ink">实际生成版本：{view.generatedVersion ?? "尚未生成"}</span>
          {view.generatedAt ? <span className="block text-[10px] text-muted">生成时间：{view.generatedAt}</span> : null}
          <span className="block text-[10px] text-muted">{view.generationReason}</span>
        </li>
        {view.runsGeneration ? (
          <li className="rounded-md border border-line px-2 py-1.5" data-testid="protocol-steps">
            <span className="text-ink">生成步骤</span>
            <ul className="mt-1 flex flex-col gap-0.5 text-[11px] text-muted">
              {view.generationSteps.map((step) => (
                <li key={`${step.kind}-${step.program}`}>
                  · {step.kind === "postprocess" ? "后处理" : "生成"} {step.program} {step.args.join(" ")}
                </li>
              ))}
            </ul>
          </li>
        ) : null}
      </ul>

      <Panel title="准备状态">
        <ul className="flex flex-col gap-1 text-[11px] text-muted" data-testid="protocol-prepare">
          {view.prepare.map((entry) => (
            <li key={entry.state}>
              {entry.ok ? "✓" : "○"} {entry.label}：{entry.detail}
            </li>
          ))}
        </ul>
      </Panel>

      {view.consumers.length > 0 ? (
        <Panel title="消费者绑定">
          <ul className="flex flex-col gap-1.5 text-xs" data-testid="protocol-consumers">
            {view.consumers.map((consumer) => (
              <li key={consumer.consumerId} className="rounded-md border border-line px-2 py-1.5">
                <div className="text-ink">
                  {consumer.name} · {consumer.language === "go" ? "Go" : "TS"} · {protocolConsumerStateLabel(consumer.state)}
                </div>
                <span className="block text-[10px] text-muted">
                  {consumer.binding.kind === "release"
                    ? `发布依赖：${consumer.binding.dependency}`
                    : consumer.binding.kind === "go-workspace"
                      ? `任务工作区：${consumer.binding.path}`
                      : `受管链接：${consumer.binding.linkPath}`}
                </span>
                {consumer.binding.kind === "go-workspace" && consumer.binding.excludedConsumers.length > 0 ? (
                  <span className="block text-[10px] text-muted">
                    未并入（避免合并依赖选择）：{consumer.binding.excludedConsumers.join("、")}
                  </span>
                ) : null}
                {consumer.binding.kind === "go-workspace" ? (
                  <span className="block text-[10px] text-muted">不改写发布配置：{consumer.binding.releaseManifestsUntouched.join("、")}</span>
                ) : null}
                {consumer.binding.kind === "ts-link" ? (
                  <span className="block text-[10px] text-muted">
                    恢复绑定：{consumer.binding.restore.program} {consumer.binding.restore.args.join(" ")}
                  </span>
                ) : null}
                <span className="block text-[10px] text-muted">{consumer.stateDetail}</span>
                {consumer.resolution ? (
                  <span className="block text-[10px] text-muted">
                    解析路径：{consumer.resolution.ok ? "已确认" : "未通过"} {consumer.resolution.message}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {staleConsumers.length > 0 ? (
            <p className="mt-2 text-[10px] text-muted" data-testid="protocol-stale-note">
              {staleConsumers.length} 个消费者需要重新生成/编译/重启后才算使用新协议
            </p>
          ) : null}
        </Panel>
      ) : null}

      {view.blockers.length > 0 || view.diagnostics.length > 0 ? (
        <Panel title="停止原因与诊断">
          <ul className="flex flex-col gap-1 text-[11px] text-muted" data-testid="protocol-diagnostics">
            {view.blockers.map((blocker) => (
              <li key={`${blocker.code}-${blocker.consumerId}`}>· [{blocker.code}] {blocker.message}</li>
            ))}
            {view.diagnostics.map((diagnostic) => (
              <li key={`${diagnostic.code}-${diagnostic.message}`}>· [{diagnostic.code}] {diagnostic.message}</li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel title="生成工具链">
        <p className="text-[11px] text-muted">
          平台：{view.toolchain.platform || "未探测"} · {view.toolchain.ok ? "就绪" : "未就绪"}；桌面可启动不等同于生成支持。
        </p>
        <ul className="mt-1 flex flex-col gap-0.5 text-[11px] text-muted" data-testid="protocol-toolchain">
          {view.toolchain.entries.map((entry) => (
            <li key={entry.toolId}>
              · {entry.label}：{toolchainStatusLabel(entry.status)}

              {entry.version ? ` (${entry.version})` : ""}
            </li>
          ))}
          {view.toolchain.entries.length === 0 ? <li>· {view.toolchain.note}</li> : null}
        </ul>
      </Panel>
    </div>
  );
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
  // The panel is unmounted whenever another tab is active, so everything the
  // user changed inside it is kept in the ui store (prototype `state`), not in
  // `useState` (#28 review P2-3).
  const panelState = useUiStore((state) => state.toolPanelState[taskId]);
  const setPanelState = useUiStore((state) => state.setToolPanelState);
  const pageId = panelState?.browserPageId ?? pages[0]?.id;
  // The takeover flag lives in the ui store: the panel and the shell summary
  // bar must report the same controller after a handover.
  const takeoverPaused = useUiStore((state) => state.browserTakeover[taskId] ?? false);
  const setTakeoverPaused = useUiStore((state) => state.setBrowserTakeover);
  const marks = panelState?.browserMarks ?? [];
  const notice = panelState?.browserNotice;
  const annotation = panelState?.browserAnnotation ?? "";
  const evidence = panelState?.browserEvidence ?? { consoleErrors: [], failedRequests: [] };
  const active = pages.find((page) => page.id === pageId) ?? pages[0];
  const handle = active ? { pageId: active.id } : undefined;
  const agentRefusal = permission !== undefined ? browserActionRefusal(permission) : undefined;
  // Read-only sessions never hand the page to the Agent, so the handover
  // control is disabled with the same reason the refusal states.
  const readonly = permission === "read";

  const toggleTakeover = async () => {
    if (!handle) return;
    const paused = !takeoverPaused;
    const result = await setBrowserTakeover({ taskId, page: handle, paused, reason: "用户接管" });
    setTakeoverPaused(taskId, paused);
    setPanelState(taskId, { browserNotice: result.kind === "idle" ? undefined : result.text });
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
    setPanelState(taskId, { browserNotice: marked.notice.kind === "idle" ? undefined : marked.notice.text });
    const marker = marked.marker;
    if (marker) {
      setPanelState(taskId, {
        browserMarks: [...marks, { id: marker.id, label: `${marker.annotation} · ${marker.url}`, needsRelocation: marker.needsRelocation }],
        browserAnnotation: "",
      });
    }
  };

  const refreshEvidence = async () => {
    if (!handle) return;
    const result = await readBrowserEvidence({ taskId, page: handle });
    setPanelState(taskId, {
      browserEvidence: result.evidence,
      browserNotice: result.ok ? "已获取当前页面的控制台与网络失败证据（内容已限幅）" : result.error,
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-muted">
        任务页面与 PiDock 自有界面分属不同信任范围；Agent 与用户操作同一页面实例，渲染层不直接调用 CDP。
      </p>
      {agentRefusal ? <p className="text-[11px] text-muted">{agentRefusal}</p> : null}
      {/* Prototype `browser-owner`: who drives the shared page right now, with
          the handover control beside it. */}
      <div className="flex items-center justify-between gap-2 border-y border-line py-2.5" data-testid="browser-owner">
        <span className="flex items-center gap-2 text-[10px] text-muted">
          <span className={`h-1.5 w-1.5 rounded-full ${takeoverPaused ? "bg-orange" : "bg-accent shadow-[0_0_0_3px_rgba(66,90,147,0.07)]"}`} />
          {takeoverPaused ? "你正在操作 · Agent 已暂停" : "Agent 可控制 · 当前空闲"}
        </span>
        <Button
          size="sm"
          disabled={readonly}
          title={readonly ? "只读会话：Agent 不会操作浏览器，无需接管" : undefined}
          onClick={() => void toggleTakeover()}
        >
          {takeoverPaused ? "交还 Agent" : "接管浏览器"}
        </Button>
      </div>
      <ul className="flex flex-col gap-1.5">
        {pages.map((page) => (
          <li key={page.id} className="rounded-md border border-line px-2.5 py-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-ink">{page.title}</span>
              <Badge>{page.id === active?.id ? "当前页面" : "标签页"}</Badge>
            </div>
            <p className="mt-1 font-mono text-[11px] text-muted">{page.url}</p>
            {pages.length > 1 ? (
              <Button size="sm" variant="ghost" onClick={() => setPanelState(taskId, { browserPageId: page.id })}>
                切换到此页
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => void refreshEvidence()}>
          获取证据
        </Button>
        <Badge tone={takeoverPaused ? "warn" : "neutral"}>{takeoverPaused ? "人工接管中：自动化已暂停" : "Agent 控制中"}</Badge>
      </div>
      {/* Prototype `snapshot`: what the task page instance is, in one block. */}
      <div className="flex flex-col gap-1.5 rounded-md bg-[#f0f2f5] px-3 py-2.5 text-[10px] text-muted" data-testid="browser-snapshot">
        <div>{marks.length > 0 ? `${marks.length} 条标记待 Agent 处理` : "尚未标记页面问题"}</div>
        <div className="font-mono text-[9px]">{active ? active.url : "尚未打开任务页面"}</div>
        <div>页面实例属于任务 {taskId}；证据与标记经 preload 桥路由 main 处置。</div>
      </div>
      <div className="flex flex-col gap-1.5">
        <h3 className="text-[11px] font-medium text-ink">验证记录</h3>
        <label className="text-[11px] text-muted" htmlFor="browser-marker-annotation">
          标记说明
        </label>
        <input
          id="browser-marker-annotation"
          className="rounded-md border border-line bg-transparent px-2.5 py-1.5 text-xs text-ink"
          placeholder="例如：总额与对账单不一致"
          value={annotation}
          onChange={(event) => setPanelState(taskId, { browserAnnotation: event.target.value })}
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

export function FilesPanel({
  files,
  browser,
  onSelectRoot,
  onSelectFile,
}: {
  files: WorkspaceFile[];
  /** [PiDock 10] (#15) Host/memory browser view: roots, tree, preview, diff. */
  browser?: WorkspaceBrowserView;
  onSelectRoot?: (rootId: string) => void;
  onSelectFile?: (relative: string) => void;
}) {
  const preview = files.find((file) => file.preview)?.preview;
  const previewPath = files.find((file) => file.preview)?.path;
  if (browser) {
    const selected = browser.selected;
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-1.5" data-testid="file-roots">
          {browser.roots.map((root) => (
            <button
              key={root.id}
              type="button"
              onClick={() => onSelectRoot?.(root.id)}
              className={`rounded border px-2 py-1 text-[11px] ${selected?.rootId === root.id ? "border-accent text-ink" : "border-line text-muted"}`}
            >
              {root.label}
              <span className="ml-1 text-[10px] text-muted">{root.kind === "shared-dir" ? "普通目录" : root.repo ?? root.id}</span>
            </button>
          ))}
        </div>
        {selected ? (
          <p className="text-[11px] text-muted">
            任务 {selected.tree?.attribution.taskId ?? browser.taskId} · 仓库 {selected.tree?.attribution.repo ?? selected.tree?.attribution.directoryId ?? "-"} · 工作目录 {""}
            <span className="font-mono">{selected.tree?.attribution.piWorkDir ?? browser.taskDir}</span>
          </p>
        ) : null}
        {selected?.tree?.attribution.sharedNote ? (
          <p className="rounded border border-warn/40 px-2 py-1 text-[11px] text-warn" data-testid="shared-dir-note">
            {selected.tree.attribution.sharedNote} · 原始目标 <span className="font-mono">{selected.tree.attribution.sourcePath}</span>
          </p>
        ) : null}
        {selected?.tree ? (
          <ul className="flex max-h-52 flex-col gap-1 overflow-auto text-xs" data-testid="file-tree">
            {selected.tree.entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  disabled={entry.kind === "dir"}
                  onClick={() => onSelectFile?.(entry.path)}
                  className="w-full truncate text-left font-mono text-[11px] text-ink disabled:text-muted"
                >
                  {entry.kind === "dir" ? "📁 " : ""}
                  {entry.path}
                </button>
              </li>
            ))}
            {selected.tree.entries.length === 0 ? <li className="text-[11px] text-muted">该目录为空。</li> : null}
            {selected.tree.truncated ? <li className="text-[11px] text-muted">条目过多，仅显示前 {selected.tree.entries.length} 条。</li> : null}
          </ul>
        ) : null}
        {selected?.preview ? <CodeBlock label={selected.preview.path} language={selected.preview.language} code={selected.preview.source} /> : null}
        {selected?.diff ? (
          <div className="flex flex-col gap-1" data-testid="file-diff">
            <span className="text-[11px] text-muted">Git 差异 · {selected.diff.attribution.repo ?? "-"}</span>
            <pre className="max-h-52 overflow-auto rounded border border-line p-2 font-mono text-[10px] text-ink">{selected.diff.diff}</pre>
          </div>
        ) : null}
        {selected?.delivery ? (
          <p className="text-[11px] text-muted" data-testid="delivery-target">
            交付入口：{selected.delivery.repo} · 分支 {selected.delivery.branch || "未记录"} · 不自动提交/推送/合并
          </p>
        ) : null}
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
      </div>
    );
  }
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

export function TerminalPanel({
  taskId,
  seed,
  terminal,
}: {
  taskId: string;
  seed: string[];
  /**
   * [PiDock 10] (#15) Host/memory terminal view: the planned cwd + resolved env
   * rows, this task's instances and their real state. `spawnImplemented: false`
   * means the plan/tracking exists but no real pty is running yet, and the
   * panel says so rather than showing a fake pid.
   */
  terminal?: {
    plan?: TerminalPlanView;
    state?: TerminalStateView;
    history?: TerminalHistoryEntryView[];
    onStart?: () => void;
    onStop?: (instanceId: string) => void;
    onResize?: (instanceId: string, cols: number, rows: number) => void;
  };
}) {
  const runTerminalCommand = useHostStore((state) => state.runTerminalCommand);
  // Scrollback and the pending input survive a tab swap, so they live in the ui
  // store (prototype `state`) and fall back to the task seed the first time the
  // panel opens (#28 review P2-3).
  const panelState = useUiStore((state) => state.toolPanelState[taskId]);
  const setPanelState = useUiStore((state) => state.setToolPanelState);
  const lines = panelState?.terminalLines ?? seed;
  const value = panelState?.terminalValue ?? "";
  const instance = terminal?.state?.instances[terminal.state.instances.length - 1];
  return (
    <div className="flex flex-col gap-2">
      {terminal?.plan ? (
        <div className="flex flex-col gap-1 text-[11px] text-muted" data-testid="terminal-plan">
          <span>
            工作目录 <span className="font-mono text-ink">{terminal.plan.cwd}</span> · 程序 {terminal.plan.program}
            {" "}
            {terminal.plan.args.join(" ")}
          </span>
          <span>终端归属：{terminal.plan.owner.sessionId === null ? `用户显式操作（${terminal.plan.owner.label}）` : `Agent 会话 ${terminal.plan.owner.sessionId}`}</span>
          {terminal.plan.attribution.sharedNote ? <span className="text-warn">{terminal.plan.attribution.sharedNote}</span> : null}
          <ul className="flex flex-col gap-0.5">
            {terminal.plan.resolved.map((row) => (
              <li key={row.key} className="font-mono text-[10px]">
                {row.key}={row.value} <span className="text-muted">（{row.source}）</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {terminal?.state && !terminal.state.spawnImplemented ? (
        <p className="rounded border border-warn/40 px-2 py-1 text-[11px] text-warn" data-testid="terminal-spawn-residual">
          终端计划、环境与归属已由 Host 管理；本机 PTY 进程启动属未实现范围，面板不会显示进程号。
        </p>
      ) : null}
      {instance ? (
        <div className="flex flex-col gap-1 text-[11px] text-muted" data-testid="terminal-instance">
          <span>
            {instance.instanceId} · {instance.lifecycle === "running" ? "运行中" : "已退出"}
            {instance.processKnown ? ` · pid ${instance.processId}` : " · 未报告进程号"}
            {instance.exitCode !== undefined ? ` · 退出码 ${instance.exitCode}` : ""}
            {instance.exitReason ? ` · ${instance.exitReason}` : ""}
          </span>
          <div className="flex gap-2">
            {instance.lifecycle === "running" ? (
              <Button size="sm" onClick={() => terminal?.onStop?.(instance.instanceId)}>
                停止终端
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => terminal?.onResize?.(instance.instanceId, instance.cols + 20, instance.rows)}>
              加宽（{instance.cols}×{instance.rows}）
            </Button>
          </div>
        </div>
      ) : terminal?.onStart ? (
        <Button size="sm" onClick={() => terminal.onStart?.()}>
          按计划启动终端
        </Button>
      ) : null}
      <p className="text-[11px] text-muted">终端输出与输入由本面板渲染；当前为模拟输入，真实 PTY 属未实现范围。</p>
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
          setPanelState(taskId, { terminalValue: "" });
          const output = await runTerminalCommand(taskId, command);
          setPanelState(taskId, { terminalLines: [...lines, ...output] });
        }}
      >
        <input
          aria-label="终端输入"
          value={value}
          onChange={(event) => setPanelState(taskId, { terminalValue: event.target.value })}
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
  // [UI 对齐 03] (#27) vertical budget: the prototype's `.session-subagents` is
  // a two-line block (`padding:12px 20px` + label + one card row), so the card
  // keeps a single compact line here instead of wrapping the summary below the
  // name. Only sessions that actually started Subagents render it (caller).
  return (
    <div className="rounded-panel border border-line bg-paper px-3 py-2" aria-label="当前会话启动的 Subagent">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-ink">Subagent <Badge>{agents.length}</Badge></span>
        <small className="text-muted">{running > 0 ? `${running} 个运行中` : "全部已结束"} · 示例</small>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            aria-pressed={agent.id === selectedId}
            onClick={() => onSelect(agent.id)}
            title={agent.summary}
            className={`flex w-64 items-center gap-2 rounded-md border px-2.5 py-1 text-left text-xs ${
              agent.id === selectedId ? "border-accent/40 bg-accent/10 text-accent" : "border-line text-ink hover:bg-soft"
            }`}
          >
            <strong className="shrink-0">{agent.name}</strong>
            <small className="min-w-0 flex-1 truncate text-muted">{agent.summary}</small>
            <Badge tone={agent.status === "running" ? "accent" : agent.status === "failed" ? "warn" : "neutral"}>
              {SUBAGENT_STATUS_LABEL[agent.status]}
            </Badge>
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
  // Same reason as `TerminalPanel`: the rail unmounts this panel on a tab swap,
  // so the scrollback and the pending input live in the ui store.
  const panelState = useUiStore((state) => state.toolPanelState[task.id]);
  const setPanelState = useUiStore((state) => state.setToolPanelState);
  const lines = panelState?.terminalLines ?? [];
  const value = panelState?.terminalValue ?? "";
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
          setPanelState(task.id, { terminalValue: "" });
          const output = await runTerminalCommand(task.id, command);
          setPanelState(task.id, { terminalLines: [...lines, ...output] });
        }}
      >
        <input
          aria-label="终端输入"
          value={value}
          onChange={(event) => setPanelState(task.id, { terminalValue: event.target.value })}
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
