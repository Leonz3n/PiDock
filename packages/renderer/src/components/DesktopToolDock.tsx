import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import {
  browserActionThroughShell,
  deliveryInfoThroughShell,
  fileDiffThroughShell,
  filePreviewThroughShell,
  fileRootsThroughShell,
  fileTreeThroughShell,
  openTaskEditorThroughShell,
  planTerminalThroughShell,
  protocolStateThroughShell,
  serviceLogThroughShell,
  terminalStateThroughShell,
} from "../data/shellBridge";
import { protocolBindingFromHost } from "../data/protocolBinding";
import {
  loadTaskServices,
  runBoundTaskServiceGroupThroughShell,
  runBoundTaskServiceThroughShell,
  serviceLogFromHost,
  shellFailure,
  type BoundServiceRow,
  type ServiceGroupDiagnosticView,
  type ServiceGroupRunView,
  type ServiceGroupUnitView,
  type ServiceHealthDetailView,
  type ServiceHealthStateView,
  type ServiceRunRecordView,
  type ServiceStatusView,
  type ServiceRegistryStatusView,
  type TaskDependencyReadPointView,
  type TaskDependencyRoutingView,
  type TaskServicesLoad,
} from "../data/taskServices";
import { buildFreshnessLabel, codeStateLabel, failureLabel, linkageStateLabel } from "../data/serviceTopology";
// The two panels the packaged dock mounts live in a module that reads no
// fixture state ([UI 对齐 S8a] #47): importing them from `./ToolPanels` would
// pull `stores/host` → `data/memoryHost` into the production graph.
import { ProtocolPanel, TerminalTakeoverPanel } from "./ProtocolTerminalPanels";
import { ServiceOwnerRebind } from "./ServiceOwnerRebind";
import {
  externalEditorLaunchFromHost,
  hostText,
  observedText,
  terminalPlanFromHost,
  terminalStateFromHost,
  workspaceDeliveryFromHost,
  workspaceDiffFromHost,
  workspacePreviewFromHost,
  workspaceRootsFromHost,
  workspaceTreeFromHost,
  type ExternalEditorLaunchView,
  type TerminalPlanView,
  type TerminalStateView,
  type WorkspaceAttributionView,
  type WorkspaceDeliveryView,
  type WorkspaceDiffView,
  type WorkspacePreviewView,
  type WorkspaceRootView,
  type WorkspaceTreeEntryView,
  type WorkspaceTreeView,
} from "../data/workspaceFiles";

/**
 * [UI 对齐] (#47 S8d) Production tool dock.
 *
 * Every row here comes from a real Host op and is parsed strictly; a failed op
 * shows the Host's own refusal instead of falling back to sample data.
 *
 * - 文件/终端: `task/fileRoots|fileTree|filePreview|fileDiff`, `task/planTerminal|terminalState`
 * - 协议: `task/protocolState`
 * - 运行/日志: `shell/projectOp associations` + `serviceCatalogOp taskBindings|list`
 *   (the task's real bound services), `task/serviceStatus` (the Host's own
 *   runtime answer), `task/serviceRunRecords` (the Host's real run record:
 *   declared-vs-observed ports, code/build state, process identity, exit reason)
 *   and `task/serviceLog` (on-demand log tail).
 * - 浏览器: `task/browserAction` (`page/open`, `page/state`, `evidence`,
 *   `takeover/pause|resume`); main owns the visible page, so the page itself is
 *   never embedded here.
 *
 * Controls this build cannot serve (local/remote switching, remote dependency
 * and routing reads, live log streaming, page discovery and embedding, page
 * marks) stay visible and explicitly marked 未接线 with the reason; none of
 * them is filled with sample data. Service start/stop is real: the run panel's
 * per-service trigger drives main's trusted catalog path
 * (`shell/serviceCatalogOp {op:"runTaskService"}` - main resolves the launch,
 * registers it on the task Host and controls it), so no row here is labelled
 * 未接线 for a control that is wired, and no wire is claimed for a control that
 * is not.
 */
export type DesktopTool = "runtime" | "browser" | "files" | "terminal" | "logs" | "protocol";

export const DESKTOP_TOOL_LABELS: Record<DesktopTool, string> = {
  runtime: "运行",
  browser: "浏览器",
  files: "文件",
  terminal: "终端",
  logs: "日志",
  protocol: "协议",
};

/**
 * Prototype-A tools that still have no production panel at all. S8d wired
 * 运行/浏览器/日志 to real Host reads, so this registry is empty; a tool that
 * loses its Host path must be listed here again instead of silently rendering
 * sample rows.
 */
export const DESKTOP_TOOLS_UNWIRED: { id: string; label: string; reason: string }[] = [];

/**
 * Prototype-A controls inside the S8d panels that this build cannot ask the
 * Host for. Each one is rendered disabled with its reason, never hidden and
 * never replaced by sample data.
 */
export const DESKTOP_TOOL_CONTROLS_UNWIRED: Record<string, string> = {
  // (#10 box 1) 本地/远程位置, 远程依赖 and 请求去向 LEFT this registry: main now
  // derives them from the trusted catalog and the task's PINNED bindings, and the
  // rows below render what it answers. A reason string that says the Host has no
  // read op would be false next to a working row, so it is gone - the same rule
  // this registry exists for.
  "runtime-config": "原型在此提供「配置」入口跳转环境与服务；此面板未接线跳转，共享模板在「环境与服务」页维护",
  "runtime-worktrees": "原型在本面板列出代码工作副本；生产由「文件」面板读取真实 task/fileRoots，本面板不重复列举",
  "log-stream": "Host 无日志订阅推送 op：只能按需读取一次日志尾部",
  "browser-embed": "任务页面由主进程窗口承载，渲染层不能内嵌（不复制第二套页面）",
  "browser-pages": "Host 无「本任务已打开页面」枚举读取 op，重开面板无法恢复页面句柄",
  "browser-owner": "Host 无「页面持有者」状态读取 op；接管状态只由接管/交还应答反映",
  "browser-nav": "任务页面由主进程窗口承载，渲染层无前进/后退/刷新 op",
  "browser-marks": "页面标记与验证记录入口未接线到生产面板",
};

const SERVICE_STATE_TEXT: Record<ServiceStatusView["kind"], Record<string, string>> = {
  owner: { stopped: "已停止", starting: "启动中", running: "运行中", stopping: "停止中", exited: "已退出", unconfirmed: "终止未确认" },
  registry: { stopped: "已停止", running: "运行中" },
};

function UnwiredRow({ id, children }: { id: string; children?: ReactNode }) {
  return (
    <li className="flex min-w-0 flex-wrap items-baseline gap-1.5 text-[11px] text-muted" data-unwired={id}>
      <Badge variant="soft">未接线</Badge>
      <span className="min-w-0 break-words">{children ?? DESKTOP_TOOL_CONTROLS_UNWIRED[id]}</span>
    </li>
  );
}

function statusText(row: BoundServiceRow): string {
  const status = row.status;
  if (!status) return row.statusError ?? "状态未读取";
  if (status.kind === "owner") {
    const text = SERVICE_STATE_TEXT.owner[status.state] ?? status.state;
    return status.executionAvailable ? text : `${text} · Host 未接管进程`;
  }
  // `lifecycle` is process liveness only. The declared 健康检查's observed
  // state rides beside it ([PiDock 04] #7 box 5): the row states the named
  // result of the Host's bounded probe, so a failed probe never reads as a
  // dead process (nor a live one as healthy).
  return `${SERVICE_STATE_TEXT.registry[status.lifecycle] ?? status.lifecycle} · 配方 v${hostText(status.templateVersion, "Host 未上报配方版本")} · ${status.resolvedKeys.length} 项环境变量${healthText(status)}${controlText(status)}`;
}

/** One Chinese name per health state; the Agent's `service.status` text repeats them verbatim. */
const HEALTH_STATE_TEXT: Record<ServiceHealthStateView, string> = {
  healthy: "健康正常",
  unhealthy: "健康异常",
  "not-probed": "健康未探测",
  undeclared: "未声明健康检查",
};

const HEALTH_KIND_TEXT: Record<NonNullable<ServiceHealthDetailView["kind"]>, string> = { http: "HTTP", tcp: "TCP", grpc: "gRPC" };

/**
 * The observed health of one service, as the row shows it: the named state, the
 * facts the probe really observed (the real HTTP code or kind, the real elapsed
 * ms) and - whenever it is not a pass - the Host's own named reason. A Host that
 * reports no health field at all says so instead of implying a pass.
 */
function healthText(status: ServiceRegistryStatusView): string {
  const state = status.health;
  if (state === undefined) return " · 健康未读取（Host 未报告健康字段）";
  const detail = status.healthDetail;
  const facts: string[] = [];
  if (detail?.kind === "http" && detail.statusCode !== undefined) facts.push(`HTTP ${String(detail.statusCode)}`);
  else if (detail?.kind !== undefined) facts.push(HEALTH_KIND_TEXT[detail.kind]);
  if (detail?.elapsedMs !== undefined) facts.push(`${String(detail.elapsedMs)}ms`);
  if (detail?.reason !== undefined) facts.push(detail.reason);
  return ` · ${HEALTH_STATE_TEXT[state]}${facts.length === 0 ? "" : `（${facts.join("，")}）`}`;
}

/**
 * Who last started or stopped this service ([PiDock 04] #7 box 5). The Host
 * labels the explicit human action and the gated Agent path apart, so the row
 * repeats that fact verbatim: an action the Agent took is never shown as a
 * click the user made, and the human label keeps main's own wording. A Host
 * that recorded no control says so instead of guessing an author.
 */
function controlText(status: ServiceRegistryStatusView): string {
  const last = status.lastControl;
  if (!last) return "";
  const action = last.action === "start" ? "启动" : "停止";
  return last.actor === "human"
    ? ` · 最近${action}：人工（${last.label}）`
    : ` · 最近${action}：Agent 会话 ${last.label}`;
}

/**
 * The Host's per-platform launch verification for one service ([PiDock 04] #7
 * box 7). Each row names WHICH platform and WHAT was actually observed on this
 * machine (that a real service child started, and whether its stop was
 * confirmed); every other platform the Host names stays 未验证 with the Host's
 * own reason, so a platform nobody ran here — Windows on this macOS machine,
 * say — can never read as a pass. A Host that sends no record at all says
 * exactly that instead of implying one.
 */
function LaunchVerification({ view }: { view: ServiceRegistryStatusView["launchVerification"] }) {
  if (view === undefined) {
    return <ul className="mt-0.5 text-[10px] text-muted" data-testid="dock-launch-verification" data-platform="unknown">
      <li>本机平台实测：该 Host 未提供平台实测记录（不表示已通过）</li>
    </ul>;
  }
  return <ul className="mt-0.5 flex flex-col text-[10px] text-muted" data-testid="dock-launch-verification" data-platform={view.platform}>
    {view.rows.map((row) => (
      <li key={row.platform} data-platform-row={row.platform} data-verified={row.verified ? "true" : "false"}>
        {row.verified
          ? `本机 ${row.platform} 实测：已启动（${row.program ?? "程序未记录"}）${row.stopped ? " · 已停止" : " · 停止未记录"} · Node ${row.nodeVersion ?? "未记录"}`
          : `${row.platform} 未验证（${row.reason ?? "Host 未给出原因"}）`}
      </li>
    ))}
  </ul>;
}

/** The Host's own liveness answer for one row; a failed read is never "running". */
function serviceRunning(row: BoundServiceRow): boolean {
  const status = row.status;
  if (status?.kind === "owner") return status.state === "running";
  if (status?.kind === "registry") return status.lifecycle === "running";
  return false;
}

function serviceName(row: BoundServiceRow): string {
  return row.template?.descriptor.name ?? row.binding.serviceId;
}

/**
 * The run record's port line ([PiDock 05] #10 box 6 honesty). The Host owns no
 * port probe, so a production run is `declared`: the list is what the launch is
 * SET UP to bind, never what was seen listening. The two origins are named
 * (`配方声明端口` / `实测监听`) so a declared port can never read as observed, and
 * an unlabelled list says it was not labelled instead of picking a side.
 */
function runPortText(record: ServiceRunRecordView): string {
  if (record.ports.length === 0) return "无端口绑定";
  const ports = record.ports.map((port) => `127.0.0.1:${port}`).join(" ");
  if (record.portsSource === "observed") return `${ports}（实测监听）`;
  if (record.portsSource === "declared") return `${ports}（配方声明端口 · 未实测监听）`;
  return `${ports}（来源未标注 · 未实测监听）`;
}

/** One `label: value` frame of the run record. */
function RunFact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className={`min-w-0 break-all ${mono ? "font-mono" : ""}`}>{value}</dd>
    </>
  );
}

/**
 * The Host's real run record for one service ([PiDock 05] #10 box 6): 运行标识,
 * 模板版本, code/build state, the DECLARED-vs-OBSERVED port label, the real
 * process identity (owner + pid + start time) and the per-run log entry. Only
 * facts the Host recorded are printed; nothing is inferred. No argv or raw
 * environment is carried here (the Host's `RunRecord` has none).
 */
function RunRecordFacts({ record }: { record: ServiceRunRecordView }) {
  return (
    <div className="mt-0.5 min-w-0 text-[10px] text-muted" data-testid="dock-run-record">
      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
        <RunFact label="运行标识" value={record.runId} mono />
        <RunFact label="模板版本" value={hostText(record.templateVersion, "Host 未上报模板版本")} />
        <RunFact label="代码状态" value={`${codeStateLabel(record.codeState)}${record.codeCommit !== undefined ? ` · ${record.codeCommit}` : ""}`} />
        <RunFact label="构建状态" value={buildFreshnessLabel(record.buildFreshness)} />
        <RunFact label="端口" value={runPortText(record)} />
        <RunFact label="进程标识" value={`${record.processIdentity.owner === "human" ? "用户操作" : "Agent"} · pid ${record.processIdentity.pid} · ${record.processIdentity.startedAt}`} />
        <RunFact label="日志入口" value={record.logRef} mono />
        {record.exitReason !== undefined && <RunFact label="结束原因" value={record.exitReason} />}
      </dl>
      <RunVerification record={record} />
    </div>
  );
}

/**
 * The run's REAL observations ([PiDock 05] #10 box 4), each labelled by what it
 * actually observed: 已监听 / 已互验 for an accepted connection, 未监听 /
 * 依赖不可达 for one that did not reach, and 未探测 when the record carried no
 * observation at all. 已启动 is the record's own 进程标识 row above — this block
 * never turns a started process into a listening or a verified one.
 */
function RunVerification({ record }: { record: ServiceRunRecordView }) {
  if (record.verifications.length === 0) {
    return <p className="mt-0.5 text-[10px] text-muted" data-testid="dock-run-verification" data-state="未探测">联通核验：未探测（运行记录没有实测监听/联通结果）</p>;
  }
  return (
    <ul className="mt-0.5 flex flex-col text-[10px] text-muted" data-testid="dock-run-verification">
      {record.verifications.map((entry, index) => (
        <li key={`${entry.kind}:${index}`} data-verification-state={linkageStateLabel(entry)}>
          联通核验：{linkageStateLabel(entry)} · {hostText(entry.detail, "Host 未上报核验细节")}
        </li>
      ))}
    </ul>
  );
}

/**
 * The run-record line of one bound service. Three exclusive states, each named:
 * the Host's real record, its named refusal/unreadable answer, or the explicit
 * "no record yet" state. The third is not an empty success: a service nobody
 * really started here says so by name.
 */
function ServiceRunRecord({ row }: { row: BoundServiceRow }) {
  if (row.runRecordError !== undefined) {
    return <p role="alert" className="mt-0.5 min-w-0 break-words text-[10px] text-[#ad4545]" data-testid="dock-run-record-error">{row.runRecordError}</p>;
  }
  if (row.runRecord !== undefined) return <RunRecordFacts record={row.runRecord} />;
  return <p className="mt-0.5 text-[10px] text-muted" data-testid="dock-run-record-absent">尚无本任务实测启动记录</p>;
}

function attribution(entry: WorkspaceAttributionView) {
  return entry.rootLabel;
}

function RootChips({
  roots,
  selectedId,
  onSelect,
}: {
  roots: readonly WorkspaceRootView[];
  selectedId?: string;
  onSelect: (rootId: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="dock-roots">
      {roots.map((root) => (
        <Button
          key={root.id}
          type="button"
          variant={root.id === selectedId ? "secondary" : "outline"}
          size="sm"
          onClick={() => onSelect(root.id)}
          aria-pressed={root.id === selectedId}
          className={root.id === selectedId ? "border-primary" : "text-muted-foreground"}
        >
          <span>{hostText(root.label, "Host 未上报根名称")}</span>
          {/* The chip carries the OBSERVED working branch, never the root's
              pinned baseline: a worktree the Host could not read shows no
              branch here, and the metadata block below names the unknown. An
              OBSERVED value the Host left empty is an observed fact with no
              name in it, so the name it does not give is named instead of a
              bare `· ` that would read as a branch neither empty nor unread. */}
          {root.workingBranch?.state === "observed" && (
            <span className="text-[10px] text-muted">· {hostText(root.workingBranch.value, "Host 未上报工作分支名")}</span>
          )}
        </Button>
      ))}
    </div>
  );
}

function TreeList({
  entries,
  onOpenDirectory,
  onOpenFile,
  relative,
}: {
  entries: readonly WorkspaceTreeEntryView[];
  onOpenDirectory: (relative: string) => void;
  onOpenFile: (relative: string) => void;
  relative: string;
}) {
  return (
    <ul className="mt-2 flex flex-col" data-testid="dock-tree">
      <li className="flex items-center gap-1.5 px-1 py-1 text-[11px] text-muted">
        <span className="font-mono">/{relative}</span>
      </li>
      {entries.map((entry) => (
        <li key={`${entry.kind}:${entry.name}`}>
          <Button
            type="button"
            variant="ghost"
            onClick={() => (entry.kind === "dir" ? onOpenDirectory(entry.path) : onOpenFile(entry.path))}
            className="flex h-auto w-full justify-start gap-2 rounded-none px-1 py-1 text-left text-xs"
          >
            <span className="w-3 text-[10px] text-muted">{entry.kind === "dir" ? "▸" : "·"}</span>
            {/* A name the Host left empty is NAMED: an entry that renders as a
                bare bullet would be an identity claim the panel cannot make. */}
            <span className="truncate font-mono">{hostText(entry.name, "Host 未上报条目名称")}</span>
            {entry.kind === "file" && entry.size !== undefined && (
              <span className="ml-auto shrink-0 text-[10px] text-muted">{entry.size} B</span>
            )}
          </Button>
        </li>
      ))}
      {!entries.length && <li className="px-1 py-2 text-xs text-muted" data-testid="dock-tree-empty">目录为空</li>}
    </ul>
  );
}

/**
 * [PiDock 10] (#15 盒子 2/9) 每视图归属. The task and the repository — or a
 * linked directory's own identity — exactly as the Host stated them in THIS
 * view's `attribution`, repeated beside the tree, the preview and the diff, so
 * a two-repo task can never read as one Git repository. The identity string
 * follows `rootKind`, so a link root is never presented as a worktree; a
 * shared-directory view additionally discloses the unified pi working
 * directory, where the link lives and the original target it writes through to.
 * Every value comes from the payload; nothing here is derived or defaulted, and
 * an identity the Host did not state is named as absent instead of being filled
 * in with the root label.
 */
function ViewAttribution({ label, attribution, testId }: { label: string; attribution: WorkspaceAttributionView; testId: string }) {
  const identity = attribution.rootKind === "worktree"
    ? `仓库 ${hostText(attribution.repo, "Host 未上报仓库身份")}`
    : `普通目录链接 ${hostText(attribution.directoryId, "Host 未上报链接目录身份")}`;
  return (
    <div className="text-[10px] text-muted" data-testid={testId} data-root-kind={attribution.rootKind}>
      <p>
        {label}归属：任务 {hostText(attribution.taskId, "Host 未上报任务身份")} · {identity}
      </p>
      {attribution.rootKind === "shared-dir" && (
        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
          <dt>统一 pi 工作目录</dt>
          <dd className="min-w-0 break-all font-mono" data-testid="dock-shared-pi-work-dir">{hostText(attribution.piWorkDir, "Host 未上报统一工作目录")}</dd>
          <dt>链接位置</dt>
          <dd className="min-w-0 break-all font-mono" data-testid="dock-shared-link-path">
            {hostText(attribution.linkPath, "Host 未上报链接位置")}
          </dd>
          <dt>原始目标</dt>
          <dd className="min-w-0 break-all font-mono" data-testid="dock-shared-source-path">
            {hostText(attribution.sourcePath, "Host 未记录原始目标")}
          </dd>
          <dt>写入影响</dt>
          <dd className="min-w-0 break-all" data-testid="dock-shared-note">
            {hostText(attribution.sharedNote, "Host 未上报共享目录说明")}
          </dd>
        </dl>
      )}
    </div>
  );
}

/**
 * [PiDock 10] (#15 盒子 7) the Git delivery target the Host resolved for the
 * selected worktree root, disclosed BEFORE anything is executed. Every value is
 * the Host's own: the repo, the DECLARED pinned remote baseline it names as the
 * delivery branch, and the three automation flags the sentence is built from —
 * the panel never writes its own branch name and never claims "nothing is
 * automatic" out of its own head. The panel runs no Git command at all.
 */
function DeliveryTargetReadout({ target }: { target: WorkspaceDeliveryView }) {
  const automation = [
    target.autoCommit ? "自动提交" : "不自动提交",
    target.autoPush ? "自动推送" : "不自动推送",
    target.autoMerge ? "自动合并" : "不自动合并",
  ].join("、");
  return (
    <section
      className="border border-line bg-paper px-2 py-1.5"
      data-testid="dock-delivery"
      data-auto-commit={target.autoCommit}
      data-auto-push={target.autoPush}
      data-auto-merge={target.autoMerge}
    >
      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px]">
        <dt className="text-muted">交付仓库</dt>
        <dd className="min-w-0 break-all font-mono" data-testid="dock-delivery-repo">{hostText(target.repo, "Host 未上报交付仓库身份")}</dd>
        <dt className="text-muted">交付分支（Host 记录的远程基线）</dt>
        <dd className="min-w-0 break-all font-mono" data-testid="dock-delivery-branch">
          {target.branch.length > 0 ? target.branch : "Host 未记录远程基线分支"}
        </dd>
        <dt className="text-muted">自动化</dt>
        <dd className="min-w-0 break-all" data-testid="dock-delivery-auto">{automation}</dd>
      </dl>
      <p className="mt-1 text-[10px] text-muted">执行前显示目标；本面板自身不执行任何 Git 操作。</p>
    </section>
  );
}

/**
 * [PiDock 10] (#15 盒子 2) 过期的根不许冒充当前根. One answer may be shown only
 * when BOTH the request it answers and the payload it carries name the root the
 * user has selected NOW; `askedRoot` is the root the read was made for and
 * `declaredRoot` is the `attribution.rootId` the payload itself states (absent
 * on a refusal, where the request is the only evidence there is). A tree,
 * preview, diff, delivery or editor-receipt answer for a root the user already
 * left is DROPPED — never rendered under the current root's chip, because one
 * repository must never be shown as another's. Only the DATA is dropped: the
 * caller's in-flight flag is cleared as soon as the response arrives, so a
 * dropped answer can never leave the panel stuck in a loading state.
 */
type FilesPanelAnswer = "文件树响应" | "交付目标响应" | "预览响应" | "改动响应" | "外部编辑器回执";

/** Why one answer may not be shown here: the user left that root, or the
 *  payload names another root than the one the read was made for. */
type AnswerDropReason = "过期" | "自述不符";

function answerDropReason(askedRoot: string, currentRoot: string | undefined, declaredRoot: string | undefined): AnswerDropReason | null {
  if (currentRoot !== askedRoot) return "过期";
  if (declaredRoot !== undefined && declaredRoot !== askedRoot) return "自述不符";
  return null;
}

/**
 * The NAME of a dropped answer: a drop is never silent, because silence is the
 * same lie by omission as showing the data (盒子 2). Both root identities in the
 * sentence come from the renderer's OWN records — `askedRoot` is the root this
 * read was made for, `currentRoot` the root the user has selected — so the
 * sentence can never be built from the payload's own claim about itself.
 */
function droppedAnswerText(
  what: FilesPanelAnswer,
  reason: AnswerDropReason,
  askedRoot: string,
  currentRoot: string | undefined,
  declaredRoot: string | undefined,
): string {
  // Every root id in these sentences comes from the Host (`str()` keeps `""`),
  // and a drop sentence is only useful if it NAMES the roots it says were
  // involved: an absent id is named, never left blank.
  const asked = hostText(askedRoot, "Host 未上报根标识");
  return reason === "过期"
    ? `已丢弃过期根 ${asked} 的${what} · 当前根 ${hostText(currentRoot, "本面板尚未选定根")}`
    : `Host ${what}自述根 ${hostText(declaredRoot, "Host 未上报根标识")} 与所请求的根 ${asked} 不符：本面板不显示`;
}

function FilesTool({ taskId }: { taskId: string }) {
  const [roots, setRoots] = useState<WorkspaceRootView[] | null>(null);
  const [rootId, setRootId] = useState<string | undefined>(undefined);
  const [relative, setRelative] = useState("");
  /** The whole tree view, so the per-view `attribution` is not dropped here. */
  const [tree, setTree] = useState<WorkspaceTreeView | null>(null);
  const [preview, setPreview] = useState<WorkspacePreviewView | null>(null);
  const [diff, setDiff] = useState<WorkspaceDiffView | null>(null);
  const [delivery, setDelivery] = useState<WorkspaceDeliveryView | null>(null);
  const [deliveryNotice, setDeliveryNotice] = useState<string | null>(null);
  const [taskDir, setTaskDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<ExternalEditorLaunchView | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  /** The launch is its own in-flight state: it is not a file read. */
  const [editorBusy, setEditorBusy] = useState(false);
  /**
   * The NAMED state a dropped answer leaves behind, with the region it explains:
   * a response that is discarded must not leave an empty area with nothing said
   * about it. It is cleared when a fresh answer for that same region is
   * accepted, or when the user selects another root (which is also the only
   * thing that can make "当前根 …" in its sentence stale).
   */
  const [droppedAnswer, setDroppedAnswer] = useState<{ what: FilesPanelAnswer; text: string } | null>(null);
  /**
   * The root the panel last ASKED for, written synchronously in `selectRoot`.
   * `rootId` is state (applied asynchronously), so an answer is checked against
   * this ref instead: it is the only value that is already current when a late
   * response arrives.
   */
  const selectedRootRef = useRef<string | undefined>(undefined);
  /**
   * A monotonic token for tree reads. The identity drop above compares ROOT
   * identity, which cannot tell two directory navigations within ONE root apart:
   * the header (`relative`) is the renderer's own state, while the entries come
   * from whichever answer lands last. The token makes the NEWEST read the only
   * one allowed to write the tree.
   */
  const treeReadRef = useRef(0);

  /**
   * Drop one answer that is not this panel's, and NAME the drop. Stable across
   * renders, so the read callbacks it is called from keep a stable dependency
   * list and the roots effect cannot loop.
   */
  const dropAnswer = useCallback((what: FilesPanelAnswer, askedRoot: string, declaredRoot: string | undefined): boolean => {
    const reason = answerDropReason(askedRoot, selectedRootRef.current, declaredRoot);
    if (reason === null) return false;
    setDroppedAnswer({ what, text: droppedAnswerText(what, reason, askedRoot, selectedRootRef.current, declaredRoot) });
    return true;
  }, []);

  /** The region that dropped an answer is freshly on screen again: its naming
   *  has done its job. Another region's naming is left alone. */
  const clearDroppedAnswer = useCallback((what: FilesPanelAnswer) => {
    setDroppedAnswer((previous) => (previous?.what === what ? null : previous));
  }, []);

  const loadTree = useCallback(
    async (nextRootId: string, nextRelative: string) => {
      const treeRead = ++treeReadRef.current;
      setBusy(true);
      const result = await fileTreeThroughShell({ taskId, rootId: nextRootId, relative: nextRelative || undefined });
      const view = result.ok ? workspaceTreeFromHost(result.payload) : undefined;
      // An answer for another root — or for a root the user has already left —
      // is not this panel's data: it is dropped BY NAME, so the tree region is
      // never left empty with nothing said about it.
      const dropped = dropAnswer("文件树响应", nextRootId, view?.attribution.rootId);
      // Only the NEWEST read owns the in-flight state: an older answer must not
      // clear the `读取中…` of the read that replaced it.
      if (treeRead === treeReadRef.current) setBusy(false);
      if (dropped) return;
      // A newer tree read has started since this one — same root, another
      // directory. The header now describes a directory this answer is not
      // about, so it must not overwrite the newest directory's entries.
      if (treeRead !== treeReadRef.current) return;
      clearDroppedAnswer("文件树响应");
      if (!result.ok) {
        setTree(null);
        setError(shellFailure(result, "读取目录失败"));
        return;
      }
      if (!view) {
        setTree(null);
        setError("Host 目录响应无法解析");
        return;
      }
      setTree(view);
      setError(null);
    },
    [taskId, dropAnswer, clearDroppedAnswer],
  );

  /**
   * [PiDock 10] (#15 盒子 7) the delivery target of the selected root, read on
   * its own so a refusal cannot blank the file view. The Host answers a
   * worktree root with the repo + pinned baseline + three automation flags, and
   * refuses a plain-directory link with its own wording — both are rendered as
   * they arrived. A payload that does not parse is a NAMED error, never a
   * synthesized branch and never a sample target.
   */
  const loadDelivery = useCallback(
    async (nextRootId: string) => {
      const result = await deliveryInfoThroughShell({ taskId, rootId: nextRootId });
      const view = result.ok ? workspaceDeliveryFromHost(result.payload) : undefined;
      // Same rule as the tree: a target that belongs to another root (or to a
      // root the user has left) is never shown under the current chip, and the
      // drop is named.
      if (dropAnswer("交付目标响应", nextRootId, view?.attribution.rootId)) return;
      clearDroppedAnswer("交付目标响应");
      if (!result.ok) {
        setDelivery(null);
        setDeliveryNotice(shellFailure(result, "读取交付目标失败"));
        return;
      }
      if (!view) {
        setDelivery(null);
        setDeliveryNotice("Host 交付目标响应无法解析");
        return;
      }
      setDelivery(view);
      setDeliveryNotice(null);
    },
    [taskId, dropAnswer, clearDroppedAnswer],
  );

  /** Select one root: its tree and its delivery target are this root's own reads. */
  const selectRoot = useCallback(
    async (nextRootId: string) => {
      // Written FIRST and synchronously, before the awaits below: from here on
      // every answer of the previous root is refused as stale.
      selectedRootRef.current = nextRootId;
      setRootId(nextRootId);
      setRelative("");
      // Every region is cleared, the TREE included: while the new root's own
      // answer is in flight the panel must not keep showing the previous
      // root's entries under the new root's chip. `读取中…` is the named state
      // for that gap.
      setTree(null);
      setPreview(null);
      setDiff(null);
      setEditor(null);
      setEditorError(null);
      setDelivery(null);
      setDeliveryNotice(null);
      // A drop naming the root the user just left would be a stale claim itself.
      setDroppedAnswer(null);
      await loadTree(nextRootId, "");
      await loadDelivery(nextRootId);
    },
    [loadDelivery, loadTree],
  );

  useEffect(() => {
    let live = true;
    void (async () => {
      const result = await fileRootsThroughShell(taskId);
      if (!live) return;
      if (!result.ok) {
        setRoots([]);
        setError(shellFailure(result, "读取任务文件根失败"));
        return;
      }
      const parsed = workspaceRootsFromHost(result.payload);
      if (!parsed) {
        setRoots([]);
        setError("Host 文件根响应无法解析");
        return;
      }
      setRoots(parsed.roots);
      setTaskDir(parsed.taskDir);
      const first = parsed.roots[0];
      if (!first) {
        setError(null);
        return;
      }
      await selectRoot(first.id);
    })();
    return () => {
      live = false;
    };
  }, [taskId, selectRoot]);

  const openFile = async (path: string) => {
    if (!rootId) return;
    const askedRoot = rootId;
    setBusy(true);
    const result = await filePreviewThroughShell({ taskId, rootId: askedRoot, relative: path });
    setBusy(false);
    const view = result.ok ? workspacePreviewFromHost(result.payload) : undefined;
    if (dropAnswer("预览响应", askedRoot, view?.attribution.rootId)) return;
    clearDroppedAnswer("预览响应");
    if (!result.ok) {
      setPreview(null);
      setDiff(null);
      setError(shellFailure(result, "读取文件失败"));
      return;
    }
    if (!view) {
      setPreview(null);
      setError("Host 文件响应无法解析");
      return;
    }
    setPreview(view);
    setDiff(null);
    setError(null);
  };

  const openDiff = async () => {
    if (!rootId || !preview) return;
    const askedRoot = rootId;
    setBusy(true);
    const result = await fileDiffThroughShell({ taskId, rootId: askedRoot, relative: preview.path });
    setBusy(false);
    const view = result.ok ? workspaceDiffFromHost(result.payload) : undefined;
    if (dropAnswer("改动响应", askedRoot, view?.attribution.rootId)) return;
    clearDroppedAnswer("改动响应");
    if (!result.ok) {
      setDiff(null);
      setError(shellFailure(result, "读取改动失败"));
      return;
    }
    if (!view) {
      setDiff(null);
      setError("Host 改动响应无法解析");
      return;
    }
    setDiff(view);
    setError(null);
  };

  const selectedRoot = roots?.find((root) => root.id === rootId);
  /**
   * [PiDock 10] (#15 盒子 9) "a link/plain directory has no Git delivery target"
   * is enforced HERE from the RENDERER's own knowledge of the selected root —
   * never from the payload's self-declared `rootKind`, which is the very value
   * under suspicion: a target that mis-describes itself must not be able to talk
   * its way past this invariant. A refusal is always BY NAME. It is not a blank
   * and not "响应无法解析" — the payload parsed fine, the panel simply may not
   * show a target where none can exist.
   */
  /**
   * The name of a root kind, in the renderer's own vocabulary.
   */
  const rootKindText = (kind: WorkspaceRootView["kind"] | undefined) =>
    kind === "worktree" ? "工作树" : kind === "shared-dir" ? "普通目录链接" : "尚未选定的根";
  const deliveryTargetIsShown = delivery !== null && selectedRoot?.kind === "worktree" && delivery.attribution.rootKind === "worktree";
  /**
   * The refusal NAMES the side the panel believes, as a three-way on the
   * payload's self-declared kind and the renderer's own knowledge. When both
   * AGREE the panel states that kind; when they DISAGREE the renderer's kind is
   * named, and the payload's claim is only ever quoted as the payload's own —
   * never repeated back as the panel's conclusion about the selected root.
   */
  const linkDeliveryRefusal = delivery === null || deliveryTargetIsShown
    ? null
    : delivery.attribution.rootKind === selectedRoot?.kind
      ? `Host 交付目标与根类型不符：${rootKindText(selectedRoot?.kind)}没有 Git 交付，本面板不显示`
      : `Host 交付目标自述为${rootKindText(delivery.attribution.rootKind)}，与所选根（${rootKindText(selectedRoot?.kind)}）不符：本面板只按所选根的类型判定，不显示 Git 交付目标`;
  const deliveryNoticeText = deliveryNotice ?? linkDeliveryRefusal;

  /**
   * [PiDock 10] (#15 box 28) 从任务打开外部编辑器. The page names the task and the
   * selected root only: main reads the editor program from the user's own
   * settings and launches it at the resolved root. The receipt (or the Host's
   * named refusal) is what is shown — never an invented success, and never a
   * receipt for a root the user has left.
   */
  const openEditor = async () => {
    if (!rootId) return;
    const askedRoot = rootId;
    setEditorBusy(true);
    const result = await openTaskEditorThroughShell({ taskId, rootId: askedRoot });
    setEditorBusy(false);
    const view = result.ok ? externalEditorLaunchFromHost(result.payload) : undefined;
    // The receipt is a payload like the others: one for another root — or for a
    // root the user has left — is refused BY NAME instead of being rendered as
    // this root's launch.
    if (dropAnswer("外部编辑器回执", askedRoot, view?.attribution.rootId)) return;
    clearDroppedAnswer("外部编辑器回执");
    if (!result.ok) {
      setEditor(null);
      setEditorError(shellFailure(result, "打开外部编辑器失败"));
      return;
    }
    if (!view) {
      setEditor(null);
      setEditorError("Host 外部编辑器响应无法解析");
      return;
    }
    setEditor(view);
    setEditorError(null);
  };

  if (roots === null) return <p className="text-xs text-muted">正在读取任务文件根…</p>;
  return (
    <div className="flex min-h-0 flex-col gap-2">
      {error && (
        <p role="status" className="border border-[#e0b4b4] bg-[#fdf3f3] px-2 py-1.5 text-[11px] text-[#8a3b3b]">
          {error}
        </p>
      )}
      {taskDir !== null && (
        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px]">
          <dt className="text-muted">任务目录</dt>
          <dd className="min-w-0 break-all font-mono">{hostText(taskDir, "Host 未上报任务目录")}</dd>
          {selectedRoot && <>
            <dt className="text-muted">实际目录</dt>
            <dd className="min-w-0 break-all font-mono">{hostText(selectedRoot.path, "Host 未上报根目录路径")}</dd>
            {selectedRoot.kind === "worktree" && <>
              {/* [PiDock 03] (#6 盒子 6) 工作分支 is an OBSERVATION of this worktree
                  (`task/fileRoots` → `observedRoots()`); the pinned baseline is a
                  DECLARED record fact shown beside it, never as the working
                  branch. An unread branch says so by name. */}
              <dt className="text-muted">工作分支</dt>
              <dd className="min-w-0 break-all font-mono" data-testid="dock-working-branch">
                {observedText(selectedRoot.workingBranch, (name) => hostText(name, "Host 未上报工作分支名"), "Host 未上报工作分支观察")}
              </dd>
              <dt className="text-muted">未提交改动</dt>
              <dd className="min-w-0 break-all font-mono" data-testid="dock-uncommitted">
                {observedText(selectedRoot.dirty, (dirty) => (dirty ? "有" : "无"), "Host 未上报未提交状态")}
              </dd>
              <dt className="text-muted">远程基线分支</dt>
              <dd className="min-w-0 break-all font-mono">{selectedRoot.baselineBranch || "Host 未提供"}</dd>
              <dt className="text-muted">创建提交</dt>
              <dd className="min-w-0 break-all font-mono">{selectedRoot.baseCommit || "Host 未提供"}</dd>
            </>}
          </>}
        </dl>
      )}
      {!roots.length && !error && <p className="text-xs text-muted">本任务没有可读取的文件根</p>}
      {roots.length > 0 && (
        <>
          <RootChips
            roots={roots}
            selectedId={rootId}
            onSelect={(next) => void selectRoot(next)}
          />
          {/* [PiDock 10] (#15 盒子 7/9) the Host's delivery target for the selected
              root, or the Host's own refusal. A link root gets the refusal and
              NO Git affordance; a worktree root gets the disclosed target — a
              target that names any other root kind is refused by name below. */}
          {deliveryTargetIsShown && delivery && <DeliveryTargetReadout target={delivery} />}
          {deliveryNoticeText && (
            <p
              role="status"
              className="border border-[#e5d9b0] bg-[#fdfbf3] px-2 py-1.5 text-[11px] text-[#7a5c1f]"
              data-testid="dock-delivery-notice"
            >
              {deliveryNoticeText}
            </p>
          )}
          {/* [PiDock 10] (#15 盒子 2) a discarded answer is NAMED here: the region
              it belonged to says what happened instead of going quietly empty. */}
          {droppedAnswer && (
            <p
              role="status"
              className="border border-[#e5d9b0] bg-[#fdfbf3] px-2 py-1.5 text-[11px] text-[#7a5c1f]"
              data-testid="dock-stale-answer"
            >
              {droppedAnswer.text}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!rootId || busy || editorBusy}
              onClick={() => void openEditor()}
              className="h-auto px-2 py-1 text-[11px]"
            >
              用外部编辑器打开
            </Button>
            <span className="text-[10px] text-muted">程序来自本机用户配置（可在「本机设置 · 外部编辑器」中配置），未写入或复制任何编辑器配置</span>
          </div>
          {editorBusy && <p className="text-[11px] text-muted">正在启动外部编辑器…</p>}
          {editorError && (
            <p role="status" className="border border-[#e0b4b4] bg-[#fdf3f3] px-2 py-1.5 text-[11px] text-[#8a3b3b]">
              {editorError}
            </p>
          )}
          {editor && (
            <section className="border border-line bg-paper p-2 text-[11px]">
              <p className="text-muted">外部编辑器已启动（用户显式操作）</p>
              <dl className="mt-1 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1">
                <dt className="text-muted">程序</dt>
                <dd className="min-w-0 break-all font-mono">{hostText(editor.program, "Host 未上报编辑器程序")}</dd>
                <dt className="text-muted">已打开</dt>
                <dd className="min-w-0 break-all font-mono">{hostText(editor.openedPath, "Host 未上报打开路径")}</dd>
                <dt className="text-muted">工作目录</dt>
                <dd className="min-w-0 break-all font-mono">{hostText(editor.cwd, "Host 未上报编辑器工作目录")}</dd>
                {editor.pid !== undefined && <>
                  <dt className="text-muted">进程号</dt>
                  <dd className="min-w-0 break-all font-mono">{editor.pid}</dd>
                </>}
              </dl>
              <p className="mt-1 text-[10px] text-muted">{hostText(editor.disclosure, "Host 未上报外部编辑器说明")}</p>
              <p className="mt-1 text-[10px] text-muted">{hostText(editor.note, "Host 未上报外部编辑器边界说明")}</p>
            </section>
          )}
          {busy && <p className="text-[11px] text-muted">读取中…</p>}
          {tree && rootId && (
            <>
              <ViewAttribution label="文件树" attribution={tree.attribution} testId="dock-tree-attribution" />
              <TreeList
                entries={tree.entries}
                relative={relative}
                onOpenDirectory={(path) => {
                  setRelative(path);
                  setPreview(null);
                  setDiff(null);
                  void loadTree(rootId, path);
                }}
                onOpenFile={(path) => void openFile(path)}
              />
            </>
          )}
          {preview && (
            <section className="min-h-0 border-t border-line pt-2">
              <div className="flex items-center gap-2 text-[11px] text-muted">
                <span className="truncate font-mono">{hostText(preview.path, "Host 未上报预览路径")}</span>
                <Badge className="shrink-0">{hostText(preview.language, "Host 未上报语言")}</Badge>
                {preview.lineCount !== undefined && <Badge className="shrink-0">{preview.lineCount} 行</Badge>}
                {/* A plain-directory link has no Git view (the Host refuses
                    `plain-dir-no-diff`): the affordance follows the renderer's
                    own knowledge of the selected root's kind as well as the
                    view's own attribution — a preview that mis-describes its
                    root must not put a Git button on a link. */}
                {preview.attribution.rootKind === "worktree" && selectedRoot?.kind === "worktree" && (
                  <Button type="button" variant="link" size="sm" onClick={() => void openDiff()} className="ml-auto h-auto shrink-0 px-0">
                    改动
                  </Button>
                )}
              </div>
              <ViewAttribution label="预览" attribution={preview.attribution} testId="dock-preview-attribution" />
              <pre className="mt-1.5 max-h-[320px] overflow-auto border border-line bg-paper p-2 text-[11px] leading-relaxed">
                {preview.source}
              </pre>
              {preview.truncated && <p className="mt-1 text-[10px] text-muted">Host 已按上限截断内容</p>}
            </section>
          )}
          {diff && (
            <section className="min-h-0 border-t border-line pt-2">
              {/* The diff carries its OWN attribution: a two-repo task shows two
                  different repos, one beside each view. */}
              <ViewAttribution label="Git 差异" attribution={diff.attribution} testId="dock-diff-attribution" />
              <pre className="mt-1.5 max-h-[320px] overflow-auto border border-line bg-paper p-2 text-[11px] leading-relaxed" data-testid="dock-diff">
                {diff.diff.length > 0 ? diff.diff : "该文件没有未提交改动"}
              </pre>
              {diff.truncated && <p className="mt-1 text-[10px] text-muted">Host 已按上限截断差异</p>}
            </section>
          )}
        </>
      )}
    </div>
  );
}

function TerminalTool({ taskId }: { taskId: string }) {
  const [state, setState] = useState<TerminalStateView | null>(null);
  const [roots, setRoots] = useState<WorkspaceRootView[]>([]);
  const [rootId, setRootId] = useState<string | undefined>(undefined);
  const [plan, setPlan] = useState<TerminalPlanView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const stateResult = await terminalStateThroughShell(taskId);
      if (!live) return;
      if (!stateResult.ok) {
        setState({ spawnImplemented: false, instances: [] });
        setError(shellFailure(stateResult, "读取终端状态失败"));
        return;
      }
      const parsed = terminalStateFromHost(stateResult.payload);
      if (!parsed) {
        setState({ spawnImplemented: false, instances: [] });
        setError("Host 终端状态响应无法解析");
        return;
      }
      setState(parsed);
      setError(null);
      // A spawning Host renders the takeover surface (`TerminalTakeoverPanel`),
      // which reads its own roots and plan. The roots here belong to the
      // plan-only view, so they are only read when this Host cannot spawn.
      if (parsed.spawnImplemented) return;
      const rootsResult = await fileRootsThroughShell(taskId);
      if (!live) return;
      const rootsParsed = rootsResult.ok ? workspaceRootsFromHost(rootsResult.payload) : undefined;
      const list = rootsParsed?.roots ?? [];
      setRoots(list);
      if (list[0]) setRootId(list[0].id);
    })();
    return () => {
      live = false;
    };
  }, [taskId]);

  const planTerminal = async (nextRootId: string) => {
    const result = await planTerminalThroughShell({
      taskId,
      instanceId: `term-${taskId}-1`,
      rootId: nextRootId,
      program: "bash",
      args: ["-l"],
    });
    if (!result.ok) {
      setPlan(null);
      setError(shellFailure(result, "终端计划失败"));
      return;
    }
    const view = terminalPlanFromHost(result.payload);
    if (!view) {
      setPlan(null);
      setError("Host 终端计划响应无法解析");
      return;
    }
    setPlan(view);
    setError(null);
  };

  if (state === null) return <p className="text-xs text-muted">正在读取终端状态…</p>;

  // When the Host can fork a real pty, the dock is the same human takeover
  // surface the demo rail uses: plan, bounded history and labelled human
  // start/stop/input/resize through the typed bridge. Only a Host that cannot
  // spawn falls back to the read-only plan view.
  if (state.spawnImplemented) return <TerminalTakeoverPanel taskId={taskId} />;

  return (
    <div className="flex min-h-0 flex-col gap-2">
      {error && (
        <p role="status" className="border border-[#e0b4b4] bg-[#fdf3f3] px-2 py-1.5 text-[11px] text-[#8a3b3b]">
          {error}
        </p>
      )}
      {!state.spawnImplemented && (
        <p className="border border-line bg-soft px-2 py-1.5 text-[11px] text-muted" data-testid="dock-terminal-plan-only">
          Host 无法启动真实 pty（平台不受支持或预检未通过）：下面是计划视图（cwd、环境与实例记录），不会启动进程。
        </p>
      )}
      <section>
        <p className="text-[11px] text-muted">实例 {state.instances.length}</p>
        <ul className="mt-1 flex flex-col gap-1" data-testid="dock-terminal-instances">
          {state.instances.map((instance) => (
            <li key={instance.instanceId} className="border border-line bg-paper px-2 py-1.5 text-[11px]">
              {/* Every string here is `str()`-parsed, so the Host may have sent
                  `""`: the instance's identity and its cwd are NAMED when they
                  are absent instead of rendering as an anonymous row. */}
              <span className="font-mono">{hostText(instance.instanceId, "Host 未上报实例标识")}</span>
              <span className="ml-1.5 text-muted">
                {instance.lifecycle === "running" ? "运行中" : "已退出"}
                {instance.processKnown ? "" : " · 进程未知"}
              </span>
              <span className="block truncate font-mono text-[10px] text-muted">{hostText(instance.cwd, "Host 未上报终端工作目录")}</span>
              {instance.exitReason && <span className="block text-[10px] text-muted">退出：{instance.exitReason}</span>}
            </li>
          ))}
          {!state.instances.length && <li className="px-1 py-2 text-xs text-muted">本任务还没有终端实例</li>}
        </ul>
      </section>
      {roots.length > 0 && (
        <section className="border-t border-line pt-2">
          <p className="text-[11px] text-muted">计划终端（bash -l）</p>
          <RootChips
            roots={roots}
            selectedId={rootId}
            onSelect={(next) => {
              setRootId(next);
              void planTerminal(next);
            }}
          />
          {plan && (
            <div className="mt-2 border border-line bg-paper px-2 py-1.5 text-[11px]" data-testid="dock-terminal-plan">
              <p className="font-mono">
                {hostText(plan.program, "Host 未上报终端程序")} {plan.args.join(" ")}
              </p>
              <p className="mt-0.5 truncate font-mono text-[10px] text-muted">{hostText(plan.cwd, "Host 未上报终端工作目录")}</p>
              <p className="mt-0.5 text-[10px] text-muted">
                {hostText(attribution(plan.attribution), "Host 未上报根名称")} · {plan.resolved.length} 项环境变量（密钥已打码）· 历史上限 {plan.historyLimit}
              </p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function validProtocolState(payload: unknown, taskId: string): boolean {
  if (!isRecord(payload) || !isRecord(payload.state)) return false;
  const state = payload.state;
  const protocol = state.protocol;
  const generation = state.generation;
  const toolchain = state.toolchain;
  const assessment = state.switchAssessment;
  const row = (value: unknown) => isRecord(value);
  const text = (value: unknown) => typeof value === "string";
  const entries = (value: unknown, check: (entry: Record<string, unknown>) => boolean) =>
    Array.isArray(value) && value.every((entry: unknown) => row(entry) && check(entry));
  const stringList = (value: unknown) => Array.isArray(value) && value.every(text);
  const validBinding = (value: unknown): boolean => {
    if (!isRecord(value)) return false;
    if (value.kind === "release") return text(value.dependency);
    if (value.kind === "go-workspace") return text(value.path) && stringList(value.useDirectories) &&
      stringList(value.excludedConsumers) && stringList(value.releaseManifestsUntouched) &&
      isRecord(value.env) && text(value.env.GOWORK);
    if (value.kind === "ts-link") return text(value.linkPath) && text(value.artifact) && text(value.marker) &&
      isRecord(value.link) && text(value.link.program) && stringList(value.link.args) &&
      isRecord(value.restore) && text(value.restore.program) && stringList(value.restore.args);
    return false;
  };
  return state.taskId === taskId && (state.mode === "release" || state.mode === "local") &&
    isRecord(protocol) && ["repoDir", "goGenDir", "tsGenDir"].every((key) => text(protocol[key])) &&
    (state.generatedVersion === null || text(state.generatedVersion)) &&
    isRecord(generation) && typeof generation.runsGeneration === "boolean" && text(generation.reason) &&
    entries(generation.steps, (step) => (step.kind === "generate" || step.kind === "postprocess") && text(step.program) && text(step.cwd) && Array.isArray(step.args) && step.args.every(text)) &&
    isRecord(toolchain) && typeof toolchain.ok === "boolean" && text(toolchain.platform) && text(toolchain.note) &&
    entries(toolchain.entries, (entry) => text(entry.toolId) && text(entry.label) && text(entry.detail) &&
      ["ready", "missing", "unverified", "unsupported-platform"].includes(String(entry.status))) &&
    isRecord(assessment) && entries(assessment.blockers, (entry) => text(entry.consumerId) && text(entry.code) && text(entry.message)) &&
    entries(state.consumers, (consumer) => text(consumer.consumerId) && text(consumer.name) && text(consumer.repoDir) &&
      text(consumer.releaseDependency) && (consumer.language === "go" || consumer.language === "ts") &&
      validBinding(consumer.binding) && isRecord(consumer.staleness) &&
      (consumer.resolution === undefined || (isRecord(consumer.resolution) && typeof consumer.resolution.ok === "boolean" && text(consumer.resolution.message))) &&
      ["ready", "needs-regenerate", "needs-binding", "needs-compile", "needs-restart"].includes(String(consumer.staleness.state)) && text(consumer.staleness.detail)) &&
    entries(state.prepare, (entry) => text(entry.state) && text(entry.label) && typeof entry.ok === "boolean" && text(entry.detail)) &&
    entries(state.diagnostics, (entry) => text(entry.code) && text(entry.message));
}

function ProtocolTool({ taskId }: { taskId: string }) {
  const [result, setResult] = useState<{ view: ReturnType<typeof protocolBindingFromHost>; error: string } | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setResult(null);
    void protocolStateThroughShell(taskId).then((response) => {
      if (!live) return;
      if (!response.ok) { setResult({ view: undefined, error: shellFailure(response, "读取协议状态失败") }); return; }
      const view = validProtocolState(response.payload, taskId) ? protocolBindingFromHost(taskId, response.payload) : undefined;
      setResult(view ? { view, error: "" } : { view: undefined, error: "Host 协议状态响应无法解析" });
    }).catch((error: unknown) => {
      if (live) setResult({ view: undefined, error: error instanceof Error ? error.message : "读取协议状态失败" });
    });
    return () => { live = false; };
  }, [taskId, revision]);
  return <div className="min-w-0 space-y-3">
    <div className="flex items-center justify-between gap-2"><p className="text-[11px] text-muted">本任务协议状态 · 只读</p><Button type="button" size="sm" variant="outline" onClick={() => setRevision((value) => value + 1)}>刷新</Button></div>
    {!result && <p role="status" className="text-xs text-muted">正在读取协议状态…</p>}
    {result?.error && <p role="alert" className="break-words border border-[#e0b4b4] bg-[#fdf3f3] p-2 text-xs text-[#ad4545]">{result.error}</p>}
    {result?.view && <ProtocolPanel view={result.view} />}
  </div>;
}

function UnwiredControls({ id, label }: { id: string; label: string }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5" data-unwired={id} title={DESKTOP_TOOL_CONTROLS_UNWIRED[id]}>
      <Button type="button" size="sm" variant="outline" disabled>{label}</Button>
      <Badge variant="soft">未接线</Badge>
    </div>
  );
}

/**
 * Real human start/stop for one bound service ([PiDock 04] #7). The click
 * sends only project/task/service/action to main's trusted catalog path
 * (`runTaskService`), which resolves the launch, registers it on the task Host
 * and controls it; the panel then re-reads the Host's own status. A refusal is
 * shown verbatim - the control never falls back to fixture data and never
 * claims a state the Host did not confirm.
 *
 * Scope, stated instead of implied: this is the HUMAN path, so it is not
 * session-scoped (a read-only session does not disable the button) - the
 * session gate guards Agent control, and the Host's human path is main-attested
 * rather than session-gated. The renderer also holds no platform fact, so the
 * trigger is enabled on every platform; where the Host cannot verify a launch
 * identity (non-POSIX), the click answers with main's named
 * `unsupported-platform` refusal, shown verbatim, rather than being disabled
 * behind a claim the renderer cannot make.
 */
function ServiceControl({ taskId, projectId, row, onChanged }: {
  taskId: string;
  projectId: string;
  row: BoundServiceRow;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [fenced, setFenced] = useState<string | undefined>(undefined);
  const running = serviceRunning(row);
  const action = running ? "stop" : "start";
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    const result = await runBoundTaskServiceThroughShell({ projectId, taskId, serviceId: row.binding.serviceId, action });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      // The named fence is the one refusal with a wired way back: main cannot
      // confirm this task's owner binding against the current catalog (a moved
      // execution snapshot, or an owner message it cannot check). Any other
      // refusal is shown verbatim with no control.
      if (result.error.includes("service-owner-inventory-unconfirmed")) setFenced(result.error);
      return;
    }
    setFenced(undefined);
    onChanged();
  };
  return (
    <div className="mt-1 min-w-0" data-service-control={row.binding.serviceId}>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { void submit(); }}>
          {running ? "停止" : "启动"}
        </Button>
        <span className="text-[10px] text-muted">{running ? "停止本任务已登记的服务进程" : "按项目配方启动本服务"}</span>
        {error !== undefined && <span role="alert" className="min-w-0 break-words text-[10px] text-[#ad4545]">{error}</span>}
      </div>
      {fenced !== undefined && <ServiceOwnerRebind projectId={projectId} taskId={taskId} surfacedBy={fenced}
        onRebound={() => { setError(undefined); onChanged(); }} onDismiss={() => setFenced(undefined)} />}
    </div>
  );
}

/**
 * 整组启动 ([PiDock 05] #10 box 4): the task's own run unit group, started as a
 * group. The click sends only the project and the task to main's catalog entry
 * (`runTaskServiceGroup`); main resolves the task's bound services from the
 * trusted catalog and forwards ONE `task/controlService {group:true}`, which
 * starts every unit through the SAME gate a single start uses and observes each
 * one for real (a real accepted connection for 已监听, a real connection to the
 * dependency for 已互验).
 *
 * Nothing here renders a plan: every label below comes from the Host's returned
 * group result, and a refusal (or a payload this build cannot read) is shown by
 * name - the panel never falls back to fixture data and never implies a unit
 * started.
 */
const GROUP_STATE_LABEL: Record<ServiceGroupRunView["state"], string> = {
  verified: "已互验",
  listening: "已监听",
  "not-probed": "未探测",
  "not-listening": "未监听",
  "dependency-unreachable": "依赖不可达",
  "verify-failed": "核验失败",
  "start-failed": "启动失败",
  refused: "门禁拒绝",
  "approval-required": "待确认",
  "not-planned": "未规划",
};

const GROUP_START_LABEL: Record<ServiceGroupUnitView["start"], string> = {
  started: "已启动",
  "start-failed": "启动失败",
  refused: "门禁拒绝",
  "approval-required": "待确认",
  "not-started": "未启动",
};

const GROUP_LISTENING_LABEL: Record<ServiceGroupUnitView["listening"], string> = {
  listening: "已监听",
  "not-listening": "未监听",
  "not-probed": "未探测",
};

/**
 * One verify step, labelled by what it ACTUALLY observed. A `passed` readiness
 * step is the unit's 已监听 observation, a `passed` linkage step is 已互验; a
 * `not-probed` step is named 未探测 instead of being folded into a failure.
 */
function stepLabel(step: ServiceGroupUnitView["steps"][number]): string {
  if (step.outcome === "not-probed") return "未探测";
  if (step.kind === "linkage") return step.outcome === "passed" ? "已互验" : "依赖不可达";
  return step.outcome === "passed" ? "已监听" : "核验失败";
}

/**
 * A unit's 联通核验 line. 已互验 requires a real passed linkage observation; a
 * unit the plan gives no dependency edge has nothing to verify, and that is
 * NAMED (无依赖边 · 未探测) instead of reading as a verified or a failed link.
 */
function unitLinkageLabel(unit: ServiceGroupUnitView): string {
  const linkage = unit.steps.filter((step) => step.kind === "linkage");
  if (linkage.length === 0) return "无依赖边（未做互验）";
  if (linkage.every((step) => step.outcome === "passed")) return "已互验";
  return linkage.some((step) => step.outcome === "dependency-unreachable") ? "依赖不可达" : "未探测";
}

/** The Host's named diagnostics, each with the vocabulary the panel already uses. */
function GroupDiagnosticList({ diagnostics, scope }: { diagnostics: readonly ServiceGroupDiagnosticView[]; scope: "unit" | "group" }) {
  if (diagnostics.length === 0) return null;
  return (
    <ul className="mt-0.5 flex flex-col gap-0.5 text-[10px] text-muted"
      data-testid={scope === "group" ? "dock-group-diagnostics" : "dock-group-unit-diagnostics"} data-scope={scope}>
      {diagnostics.map((diagnostic, index) => (
        <li key={`${diagnostic.code}:${index}`} data-diagnostic-code={diagnostic.code}>
          <span className="text-[#ad4545]">{failureLabel(diagnostic.code).label}</span> · {diagnostic.message}
          {diagnostic.hint !== undefined ? ` · ${diagnostic.hint}` : ""}
        </li>
      ))}
    </ul>
  );
}

/**
 * The Host's REAL group result ([PiDock 05] #10 box 4), one row per unit plus the
 * group's own named state and diagnostics. Every value rendered here is an
 * observation the Host made or a negative it named; the plan never appears.
 */
function GroupRunReceipt({ group }: { group: ServiceGroupRunView }) {
  return (
    <div className="mt-1 min-w-0 text-[10px] text-muted" data-testid="dock-group-run">
      <p data-testid="dock-group-state" data-state={group.state}>
        整组状态：{GROUP_STATE_LABEL[group.state]}
        {group.state === "not-planned" ? "（Host 报告本任务没有已规划的运行单元，未启动任何单元）" : ""}
      </p>
      <ul className="mt-0.5 flex flex-col gap-0.5">
        {group.units.map((unit) => (
          <li key={unit.unitId} data-group-unit={unit.unitId} data-service-id={unit.serviceId}
            data-start={unit.start} data-listening={unit.listening} data-linkage={unitLinkageLabel(unit)}>
            <span className="font-mono">{unit.serviceId}</span>
            <span> · 启动：{GROUP_START_LABEL[unit.start]}</span>
            <span>{unit.pid !== undefined ? ` · pid ${unit.pid}` : " · 进程标识未读取"}</span>
            <span> · 监听：{GROUP_LISTENING_LABEL[unit.listening]}</span>
            <span>{unit.address !== undefined ? `（${unit.address.host}:${unit.address.port}）` : ""}</span>
            <span> · 联通：{unitLinkageLabel(unit)}</span>
            {unit.steps.map((step, index) => (
              <span key={`${step.targetUnitId}:${index}`} data-group-step={step.outcome}> · {step.label}：{stepLabel(step)}</span>
            ))}
            <GroupDiagnosticList diagnostics={unit.diagnostics} scope="unit" />
          </li>
        ))}
        {group.units.length === 0 && <li data-group-unit-empty>Host 未返回任何运行单元的观测结果</li>}
      </ul>
      <GroupDiagnosticList diagnostics={group.diagnostics} scope="group" />      {group.restartScope.length > 0 && (
        <p data-testid="dock-group-restart-scope">
          本次整组启动未重启任何单元；计划要求后续重启：
          {group.restartScope.map((row) => `${row.unitId}（${row.reason}）`).join("、")}
        </p>
      )}
    </div>
  );
}

function GroupStartControl({ taskId, projectId, onStarted }: {
  taskId: string;
  projectId: string;
  onStarted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: "refused"; error: string } | { kind: "run"; group: ServiceGroupRunView } | null>(null);
  const submit = async () => {
    setBusy(true);
    const response = await runBoundTaskServiceGroupThroughShell({ projectId, taskId });
    setBusy(false);
    if (!response.ok) {
      setResult({ kind: "refused", error: response.error });
      return;
    }
    setResult({ kind: "run", group: response.group });
    onStarted();
  };
  return (
    <section className="border-t border-line pt-2" data-testid="dock-group-control">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { void submit(); }}>整组启动</Button>
        <span className="text-[10px] text-muted">按任务计划顺序启动本任务全部运行单元，先监听；有依赖边才互验</span>
      </div>
      {result?.kind === "refused" && (
        <p role="alert" className="mt-1 min-w-0 break-words text-[10px] text-[#ad4545]" data-testid="dock-group-refusal">{result.error}</p>
      )}
      {result?.kind === "run" && <GroupRunReceipt group={result.group} />}
    </section>
  );
}

/**
 * [PiDock 05] (#10 box 1) 本地/远程位置 of one bound service, read from main's
 * trusted 依赖去向 answer. An absent unit is a NAMED unknown - this row never
 * defaults a unit to 本机实例, and it never renders a shared environment as one.
 *
 * `location` is the BINDING's semantics (main plans every bound unit as a local
 * run unit), which this read does not observe as a running process and skips the
 * platform gate for. The label therefore names ownership, never 运行: a unit that
 * is not started - or cannot be started on this platform - must not read as if
 * the task were running it.
 */
function serviceLocationText(dependencies: TaskDependencyRoutingView | undefined, serviceId: string): string {
  const unit = dependencies?.units.find((entry) => entry.serviceId === serviceId);
  if (unit === undefined) return "位置未读取";
  return unit.location === "local" ? "本机实例 · 本任务自有（未启动不代表运行中）" : "共享环境 · 本任务不运行该单元";
}

/**
 * Why a derived 依赖去向 list is empty. An empty list is an ALL-CLEAR only when
 * the read resolved every binding (`diagnostics` empty - any unhandled one means
 * the plan failed closed and the list carries NO destination at all) AND there is
 * a bound service it could speak about. Otherwise the row names the absence of a
 * conclusion instead of asserting "no shared-environment variable", because a
 * variable no declaration binds really does keep the shared environment address.
 */
type DependencyListState = "all-local" | "unconcluded" | "no-service" | "unread";

function dependencyEmptyState(dependencies: TaskDependencyRoutingView | undefined): DependencyListState {
  if (dependencies === undefined) return "unread";
  if (dependencies.units.length === 0) return "no-service";
  return dependencies.diagnostics.length === 0 ? "all-local" : "unconcluded";
}

const REMOTE_DEPS_EMPTY_TEXT: Record<DependencyListState, string> = {
  "all-local": "本任务服务的地址变量都指向本任务实例，没有指向共享环境的变量；不列不存在的共享资源。",
  "unconcluded": "依赖去向仍有未处理的诊断（见「请求去向」），此清单不足以得出「都指向本任务实例」的结论。",
  "no-service": "本任务还没有绑定服务，没有指向共享环境的地址变量可列举。",
  "unread": "依赖去向未读取，无法判断本任务的地址变量是否指向共享环境。",
};

const DEPENDENCY_EMPTY_TEXT: Record<DependencyListState, string> = {
  "all-local": "本任务服务的配置里没有可展示的地址变量（未声明、也无读取点）。",
  "unconcluded": "依赖去向仍有未处理的诊断（见下），此处不足以得出「本任务没有地址变量」的结论。",
  "no-service": "本任务还没有绑定服务，没有可展示的地址变量。",
  "unread": "依赖去向未读取，没有可展示的地址变量。",
};

/** One read point ("共享模板=…" / "本机私有配置（已遮蔽）"), never a private value. */
function readPointValueText(point: TaskDependencyReadPointView): string {
  if (point.masked) return "（已遮蔽）";
  return point.value === undefined ? "" : `=${point.value}`;
}

/**
 * The per-variable 实际依赖去向 ([PiDock 05] #10 box 1): every row is a value main
 * derived from the catalog plus the task's PINNED bindings. 本任务实例地址 (its
 * address + port) and 共享环境 are separate rows on purpose, and a variable no
 * 服务依赖声明 binds keeps the shared environment address instead of being
 * rewritten into a local one.
 */
function DependencyTargets({ dependencies }: { dependencies: TaskDependencyRoutingView }) {
  if (dependencies.destinations.length === 0) {
    const state = dependencyEmptyState(dependencies);
    return <li className="px-1 py-1 text-[11px] text-muted" data-testid="dock-dependency-empty" data-dependency-empty-state={state}>
      {DEPENDENCY_EMPTY_TEXT[state]}
    </li>;
  }
  return <>
    {dependencies.destinations.map((entry) => (
      <li key={`${entry.unitId}/${entry.key}`} className="border border-line bg-paper px-2 py-1 text-[11px]"
        data-destination-key={entry.key} data-destination-unit={entry.unitId} data-destination-kind={entry.target.kind}>
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-mono text-[10px]">{hostText(entry.key, "Host 未上报变量名")}</span>
          <span className="ml-auto shrink-0 text-muted" data-destination-label>
            {entry.target.kind === "local-instance" ? "本任务实例地址" : "共享环境"}
          </span>
        </div>
        <p className="mt-0.5 min-w-0 break-words text-[10px] text-muted" data-destination-value>
          {entry.target.kind === "local-instance"
            ? <>{hostText(entry.value, "（无地址值）")} · {hostText(entry.target.address, "Host 未上报实例地址")}
                {entry.target.port === undefined ? "（无端口）" : `（端口 ${entry.target.port}）`}</>
            : <>共享环境 {hostText(entry.target.environment, "名称未提供")}
                {entry.readPoints.map((point) => ` · ${hostText(point.source, "Host 未上报读取点来源")}${readPointValueText(point)}`).join("")}</>}
        </p>
        <p className="mt-0.5 min-w-0 break-words text-[10px] text-muted">
          读取点：{entry.readPoints.map((point) => hostText(point.source, "Host 未上报读取点来源")).join("、") || "无"}
        </p>
        {entry.reason !== undefined && <p className="mt-0.5 min-w-0 break-words text-[10px] text-muted" data-destination-reason>{hostText(entry.reason, "Host 未给出该去向的原因")}</p>}
      </li>
    ))}
  </>;
}

function RunTool({ taskId }: { taskId: string }) {
  const [load, setLoad] = useState<TaskServicesLoad | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setLoad(null);
    void loadTaskServices(taskId).then((result) => { if (live) setLoad(result); });
    return () => { live = false; };
  }, [taskId, revision]);

  if (load === null) return <p className="text-xs text-muted">正在读取任务服务…</p>;
  if (!load.ok) return <p role="alert" className="break-words border border-[#e0b4b4] bg-[#fdf3f3] p-2 text-xs text-[#ad4545]">{load.error}</p>;
  const boundProjectId = load.projectId;
  // main's trusted 依赖去向 answer ([PiDock 05] #10 box 1), `undefined` when the
  // task has no bound service at all.
  const dependencies = load.dependencies;
  const remoteDependencies = (dependencies?.destinations ?? []).filter(
    (entry): entry is typeof entry & { target: { kind: "remote"; environment: string } } => entry.target.kind === "remote",
  );
  // An empty 远程依赖 list is only an all-clear when the read derived it fully
  // (see `dependencyEmptyState`); otherwise the row names the unhandled state.
  const remoteDepsEmptyState = dependencyEmptyState(dependencies);

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted">任务运行环境（启停已接线 · 其余状态只读）</p>
        <Button type="button" size="sm" variant="outline" onClick={() => setRevision((value) => value + 1)}>刷新</Button>
      </div>
      <UnwiredControls id="runtime-config" label="配置" />
      {boundProjectId === null ? (
        load.associationState === "unavailable" ? (
          <p role="status" className="border border-line bg-soft px-2 py-1.5 text-[11px] text-muted" data-testid="dock-runtime-unavailable" data-association-state="unavailable">
            Host 报告该任务归属状态暂不可用，无法确认归属项目；此面板不列举服务，也不冒充空清单。
          </p>
        ) : (
          <p role="status" className="border border-line bg-soft px-2 py-1.5 text-[11px] text-muted" data-testid="dock-runtime-unassigned" data-association-state={load.associationState}>
            该任务尚未由用户确认归属项目，Host 不在项目下保存服务绑定；此面板不列举服务，也不冒充空清单。
          </p>
        )
      ) : (
        <>
          {load.templatesError && <p role="status" className="break-words border border-line bg-soft px-2 py-1.5 text-[11px] text-muted">{load.templatesError}</p>}
          {load.rows.length > 0 && <GroupStartControl taskId={taskId} projectId={boundProjectId} onStarted={() => setRevision((value) => value + 1)} />}
          <section>
            <p className="text-[11px] text-muted">本任务服务 · {load.rows.length}</p>
            <ul className="mt-1 flex flex-col gap-1" data-testid="dock-service-rows">
              {load.rows.map((row) => {
                const running = serviceRunning(row);
                return (
                  <li key={row.binding.serviceId} className="border border-line bg-paper px-2 py-1.5 text-[11px]" data-service-id={row.binding.serviceId}
                    data-service-health={row.status?.kind === "registry" ? row.status.health ?? "unreported" : undefined}>
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? "bg-accent" : "bg-line"}`} aria-hidden="true" />
                      <span className="truncate font-semibold">{serviceName(row)}</span>
                      <span className="ml-auto shrink-0 text-muted">{statusText(row)}</span>
                    </div>
                    <p className="mt-0.5 truncate text-[10px] text-muted">
                      {row.template
                        ? (row.template.descriptor.ports.length > 0
                          ? <><span>配方声明端口</span> · <span className="font-mono">{row.template.descriptor.ports.map((port) => `127.0.0.1:${port}`).join(" ")}</span></>
                          : "配方未声明端口")
                        : "Host 未提供配方描述"}
                    </p>
                    <p className="mt-0.5 truncate text-[10px] text-muted">
                      绑定 v{row.binding.templateVersion} · {hostText(row.binding.rootId, "Host 未上报绑定根")}{row.binding.subdir ? `/${row.binding.subdir}` : ""}
                      {row.binding.privateKeys.length > 0 ? ` · 私有引用 ${row.binding.privateKeys.length} 项` : ""}
                    </p>
                    <ServiceRunRecord row={row} />
                    <ServiceControl taskId={taskId} projectId={boundProjectId} row={row} onChanged={() => setRevision((value) => value + 1)} />
                    {row.status?.kind === "registry" && <LaunchVerification view={row.status.launchVerification} />}
                    {/* (#10 box 1) 本地/远程位置, read from main's trusted derivation:
                        the row no longer carries a 未接线 badge for a control whose
                        values are now shown. */}
                    <p className="mt-0.5 truncate text-[10px] text-muted" data-testid={`dock-service-location-${row.binding.serviceId}`}>
                      位置：{serviceLocationText(dependencies, row.binding.serviceId)}
                    </p>
                  </li>
                );
              })}
              {!load.rows.length && <li className="px-1 py-2 text-xs text-muted">本任务还没有绑定服务。绑定属于项目服务配方，不在此处新建。</li>}
            </ul>
          </section>
          <section className="border-t border-line pt-2">
            <p className="text-[11px] text-muted">远程依赖</p>
            {load.dependenciesError !== undefined
              ? <p role="alert" className="mt-1 min-w-0 break-words text-[10px] text-[#ad4545]" data-testid="dock-remote-deps-error">{load.dependenciesError}</p>
              : <ul className="mt-1 flex flex-col gap-1" data-testid="dock-remote-deps">
                  {remoteDependencies.length === 0
                    ? <li className="px-1 py-1 text-[10px] text-muted" data-testid="dock-remote-deps-empty" data-remote-deps-state={remoteDepsEmptyState}>
                        {REMOTE_DEPS_EMPTY_TEXT[remoteDepsEmptyState]}
                      </li>
                    : remoteDependencies.map((entry) => (
                        <li key={`remote/${entry.unitId}/${entry.key}`} className="px-1 text-[10px] text-muted" data-remote-key={entry.key}>
                          {hostText(entry.key, "Host 未上报变量名")} → 共享环境 {hostText(entry.target.environment, "名称未提供")}
                          （读取点：{entry.readPoints.map((point) => hostText(point.source, "Host 未上报读取点来源")).join("、") || "无"}）
                        </li>
                      ))}
                </ul>}
            <p className="mt-1 text-[10px] text-muted" data-testid="dock-remote-deps-note">
              此清单只列本任务服务的配置里指向共享环境的地址变量。共享外部资源在哪声明尚未决定（box 5/7），本面板不冒充一份完整清单。
            </p>
          </section>
          <section className="border-t border-line pt-2">
            <p className="text-[11px] text-muted">请求去向</p>
            {load.dependenciesError !== undefined
              ? <p role="alert" className="mt-1 min-w-0 break-words text-[10px] text-[#ad4545]" data-testid="dock-routing-error">{load.dependenciesError}</p>
              : <ul className="mt-1 flex flex-col gap-1" data-testid="dock-routing">{dependencies !== undefined && <DependencyTargets dependencies={dependencies} />}</ul>}
            {dependencies !== undefined && dependencies.diagnostics.length > 0 && (
              <ul className="mt-1 flex flex-col gap-0.5" data-testid="dock-routing-diagnostics">
                {dependencies.diagnostics.map((entry) => (
                  <li key={`${entry.code}:${entry.message}`} className="min-w-0 break-words text-[10px] text-muted">
                    {hostText(entry.code, "Host 未上报诊断代码")}：{hostText(entry.message, "Host 未上报诊断说明")}{entry.hint && `（${entry.hint}）`}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="border-t border-line pt-2">
            <p className="text-[11px] text-muted">依赖边（声明）</p>
            {load.dependenciesError !== undefined
              ? <p role="alert" className="mt-1 min-w-0 break-words text-[10px] text-[#ad4545]" data-testid="dock-linkage-error">{load.dependenciesError}</p>
              : <ul className="mt-1 flex flex-col gap-1" data-testid="dock-linkage" data-linkage-state={dependencies?.linkage.state}>
                  {dependencies === undefined || dependencies.linkage.state === "no-declaration"
                    ? <li className="px-1 text-[10px] text-muted" data-testid="dock-linkage-none">无依赖边（未做互验）</li>
                    : dependencies.linkage.edges.map((edge) => (
                        <li key={`${edge.from}->${edge.to}`} className="px-1 text-[10px] text-muted" data-edge-to={edge.to}>
                          {hostText(edge.fromName, "Host 未上报来源单元")} → {hostText(edge.toName, "Host 未上报目标单元")}（{edge.kind === "call" ? "调用" : "前置"}）· 已声明 · 未互验（本读不启动任何单元）
                        </li>
                      ))}
                </ul>}
            <p className="mt-1 text-[10px] text-muted">
              这里只有声明：已互验只由整组启动的互验步骤产生，该读从不代替它。
            </p>
          </section>
        </>
      )}
      <section className="border-t border-line pt-2">
        <p className="text-[11px] text-muted">代码工作副本</p>
        <ul className="mt-1 flex flex-col gap-1"><UnwiredRow id="runtime-worktrees" /></ul>
      </section>
      <p className="text-[10px] text-muted" data-testid="dock-runtime-note">
        以上状态是 Host 当前应答；未列出进程不等于已停止，也不代表外部依赖可用。worktree、进程、端口和浏览器状态按任务独立。
      </p>
    </div>
  );
}

function LogsTool({ taskId }: { taskId: string }) {
  const [load, setLoad] = useState<TaskServicesLoad | null>(null);
  const [serviceId, setServiceId] = useState<string | undefined>(undefined);
  const [log, setLog] = useState<{ ok: true; lines: { at: string; line: string }[] } | { ok: false; error: string } | null>(null);
  useEffect(() => {
    let live = true;
    setLoad(null); setLog(null); setServiceId(undefined);
    void loadTaskServices(taskId).then((result) => {
      if (!live) return;
      setLoad(result);
      if (result.ok) setServiceId(result.rows[0]?.binding.serviceId);
    });
    return () => { live = false; };
  }, [taskId]);
  useEffect(() => {
    if (serviceId === undefined) { setLog(null); return; }
    let live = true;
    setLog(null);
    void serviceLogThroughShell({ taskId, serviceId, limit: 200 }).then((result) => {
      if (!live) return;
      if (!result.ok) { setLog({ ok: false, error: shellFailure(result, "读取服务日志失败") }); return; }
      const lines = serviceLogFromHost(result.payload);
      setLog(lines ? { ok: true, lines } : { ok: false, error: "Host 日志响应无法解析" });
    });
    return () => { live = false; };
  }, [taskId, serviceId]);

  if (load === null) return <p className="text-xs text-muted">正在读取任务服务…</p>;
  if (!load.ok) return <p role="alert" className="break-words border border-[#e0b4b4] bg-[#fdf3f3] p-2 text-xs text-[#ad4545]">{load.error}</p>;

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <p className="text-[11px] text-muted">运行日志 · 按需读取尾部</p>
        <Badge variant="soft">最多 200 行</Badge>
      </div>
      {load.projectId === null ? (
        <p role="status" className="border border-line bg-soft px-2 py-1.5 text-[11px] text-muted" data-testid="dock-logs-unassigned">
          该任务尚未由用户确认归属项目，Host 不在项目下保存服务绑定，因此没有可选的真实服务。
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5" data-testid="dock-log-services">
            {load.rows.map((row) => (
              <Button
                key={row.binding.serviceId}
                type="button"
                size="sm"
                variant={row.binding.serviceId === serviceId ? "secondary" : "outline"}
                aria-pressed={row.binding.serviceId === serviceId}
                onClick={() => setServiceId(row.binding.serviceId)}
                className={row.binding.serviceId === serviceId ? "border-primary" : "text-muted-foreground"}
              >{serviceName(row)}</Button>
            ))}
            {!load.rows.length && <span className="text-xs text-muted">本任务还没有绑定服务，没有可读取日志的真实服务</span>}
          </div>
          {log === null && serviceId !== undefined && <p className="text-xs text-muted">正在读取日志…</p>}
          {log?.ok && log.lines.length > 0 && (
            <ol className="flex flex-col gap-0.5 border-t border-line pt-2 font-mono text-[10px]" data-testid="dock-log-lines">
              {log.lines.map((line, index) => <li key={index} className="break-all"><span className="text-muted">{line.at}</span> {line.line}</li>)}
            </ol>
          )}
          {log?.ok && !log.lines.length && <p role="status" className="text-xs text-muted" data-testid="dock-log-empty">Host 返回 0 行日志</p>}
          {log && !log.ok && <p role="alert" className="break-words border border-[#e0b4b4] bg-[#fdf3f3] p-2 text-xs text-[#ad4545]" data-testid="dock-log-error">{log.error}</p>}
        </>
      )}
      <ul className="flex flex-col gap-1 border-t border-line pt-2"><UnwiredRow id="log-stream" /></ul>
      <p className="text-[10px] text-muted" data-testid="dock-logs-note">
        日志只来自 Host 已登记的服务；Host 尚未接管真实服务进程时，这里会显示 Host 的原话，而不是样例行。
      </p>
    </div>
  );
}

type BrowserPageHandle = { pageId: string; webContentsId?: number; url: string };
type PageState = { epoch: number; url: string; title: string };
type PageEvidence = { consoleErrors: string[]; failedRequests: { url: string; errorText: string }[] };

function browserPageFromHost(payload: unknown): BrowserPageHandle | null {
  if (!isRecord(payload) || typeof payload["pageId"] !== "string" || payload["pageId"].length === 0) return null;
  if (typeof payload["url"] !== "string") return null;
  const webContentsId = payload["webContentsId"];
  if (webContentsId !== undefined && typeof webContentsId !== "number") return null;
  return { pageId: payload["pageId"], url: payload["url"], ...(typeof webContentsId === "number" ? { webContentsId } : {}) };
}

function pageStateFromHost(payload: unknown): PageState | null {
  if (!isRecord(payload) || !isRecord(payload["state"])) return null;
  const state = payload["state"];
  if (typeof state["epoch"] !== "number" || typeof state["url"] !== "string" || typeof state["title"] !== "string") return null;
  return { epoch: state["epoch"], url: state["url"], title: state["title"] };
}

function pageEvidenceFromHost(payload: unknown): PageEvidence | null {
  if (!isRecord(payload) || !isRecord(payload["evidence"])) return null;
  const evidence = payload["evidence"];
  if (!Array.isArray(evidence["consoleErrors"]) || !Array.isArray(evidence["failedRequests"])) return null;
  const consoleErrors: string[] = [];
  for (const entry of evidence["consoleErrors"]) {
    if (!isRecord(entry) || typeof entry["text"] !== "string") return null;
    consoleErrors.push(entry["text"]);
  }
  const failedRequests: PageEvidence["failedRequests"] = [];
  for (const entry of evidence["failedRequests"]) {
    if (!isRecord(entry) || typeof entry["url"] !== "string" || typeof entry["errorText"] !== "string") return null;
    failedRequests.push({ url: entry["url"], errorText: entry["errorText"] });
  }
  return { consoleErrors, failedRequests };
}

function BrowserTool({ taskId }: { taskId: string }) {
  const [url, setUrl] = useState("");
  const [page, setPage] = useState<BrowserPageHandle | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "refused"; text: string } | null>(null);
  const [state, setState] = useState<PageState | null>(null);
  const [evidence, setEvidence] = useState<PageEvidence | null>(null);
  const [paused, setPaused] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = useCallback(async (action: string, params?: Record<string, unknown>) => {
    if (page === null && action !== "page/open") return null;
    setBusy(true);
    const result = await browserActionThroughShell({
      taskId,
      action,
      ...(page !== null ? { page: { taskId, pageId: page.pageId, ...(page.webContentsId !== undefined ? { webContentsId: page.webContentsId } : {}) } } : {}),
      ...(params !== undefined ? { params } : {}),
      label: `用户从工具面板执行 ${action}`,
    });
    setBusy(false);
    return result;
  }, [page, taskId]);

  const open = async () => {
    setNotice(null); setState(null); setEvidence(null); setPaused(null);
    setBusy(true);
    const result = await browserActionThroughShell({ taskId, action: "page/open", params: { url: url.trim() }, label: "用户从工具面板打开任务页面" });
    setBusy(false);
    if (!result.ok) { setPage(null); setNotice({ kind: "refused", text: shellFailure(result, "打开任务页面被拒绝") }); return; }
    const opened = browserPageFromHost(result.payload);
    if (!opened) { setPage(null); setNotice({ kind: "refused", text: "Host 页面响应无法解析" }); return; }
    setPage(opened);
    setNotice({ kind: "ok", text: `主进程窗口已打开 ${opened.url}` });
  };

  const readState = async () => {
    const result = await ask("page/state");
    if (!result) return;
    if (!result.ok) { setState(null); setNotice({ kind: "refused", text: shellFailure(result, "读取页面状态被拒绝") }); return; }
    const parsed = pageStateFromHost(result.payload);
    if (!parsed) { setState(null); setNotice({ kind: "refused", text: "Host 页面状态响应无法解析" }); return; }
    setState(parsed); setNotice({ kind: "ok", text: "已按 Host 应答更新页面状态" });
  };

  const readEvidence = async () => {
    const result = await ask("evidence");
    if (!result) return;
    if (!result.ok) { setEvidence(null); setNotice({ kind: "refused", text: shellFailure(result, "读取页面证据被拒绝") }); return; }
    const parsed = pageEvidenceFromHost(result.payload);
    if (!parsed) { setEvidence(null); setNotice({ kind: "refused", text: "Host 页面证据响应无法解析" }); return; }
    setEvidence(parsed); setNotice({ kind: "ok", text: "已按 Host 应答更新控制台与网络证据" });
  };

  const takeOver = async (next: boolean) => {
    const result = await ask(next ? "takeover/pause" : "takeover/resume", next ? { reason: "用户接管浏览器" } : {});
    if (!result) return;
    if (!result.ok) { setNotice({ kind: "refused", text: shellFailure(result, next ? "接管页面被拒绝" : "交还页面被拒绝") }); return; }
    setPaused(next);
    setNotice({ kind: "ok", text: next ? "已接管页面：Agent 自动化暂停" : "已交还页面：Agent 可继续操作" });
  };

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <p className="text-[11px] text-muted">任务页面 · 主进程窗口（渲染层不内嵌页面）</p>
      <div className="flex min-w-0 items-center gap-1.5">
        <input
          aria-label="任务页面地址"
          value={url}
          placeholder="http://127.0.0.1:5173/"
          onChange={(event) => setUrl(event.target.value)}
          className="min-h-8 min-w-0 flex-1 rounded-[4px] border border-line bg-paper px-2 font-mono text-[11px]"
        />
        <Button type="button" size="sm" disabled={busy || url.trim().length === 0} onClick={() => void open()}>打开任务页面</Button>
      </div>
      <UnwiredControls id="browser-nav" label="前进 / 后退 / 刷新" />
      {notice && (notice.kind === "refused"
        ? <p role="alert" className="break-words border border-[#e0b4b4] bg-[#fdf3f3] p-2 text-[11px] text-[#ad4545]" data-testid="dock-browser-notice">{notice.text}</p>
        : <p role="status" className="break-words border border-line bg-soft p-2 text-[11px] text-muted" data-testid="dock-browser-notice">{notice.text}</p>)}
      {page && (
        <section className="border border-line bg-paper px-2 py-1.5 text-[11px]" data-testid="dock-browser-page">
          <p className="truncate">页面句柄 <span className="font-mono">{page.pageId}</span>{page.webContentsId !== undefined ? <span className="text-muted"> · webContents {page.webContentsId}</span> : null}</p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted">{page.url}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void readState()}>读取状态</Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void readEvidence()}>读取证据</Button>
            {paused === true
              ? <Button type="button" size="sm" disabled={busy} onClick={() => void takeOver(false)}>交还 Agent</Button>
              : <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void takeOver(true)}>接管浏览器</Button>}
          </div>
          {state && <p className="mt-1 text-[10px] text-muted" data-testid="dock-browser-state">epoch {state.epoch} · {state.title || "（无标题）"} · {state.url}</p>}
          {evidence && (
            <div className="mt-1 text-[10px] text-muted" data-testid="dock-browser-evidence">
              <p>控制台错误 {evidence.consoleErrors.length} · 失败请求 {evidence.failedRequests.length}</p>
              {evidence.consoleErrors.slice(-3).map((text, index) => <p key={index} className="break-all font-mono">{text}</p>)}
              {evidence.failedRequests.slice(-3).map((row, index) => <p key={index} className="break-all font-mono">{row.url} · {row.errorText}</p>)}
            </div>
          )}
        </section>
      )}
      <ul className="flex flex-col gap-1 border-t border-line pt-2">
        <UnwiredRow id="browser-owner" />
        <UnwiredRow id="browser-pages" />
        <UnwiredRow id="browser-embed" />
        <UnwiredRow id="browser-marks" />
      </ul>
      <p className="text-[10px] text-muted">打开与导航按 Host 的任务导航白名单校验；被拒绝时显示 Host 原话。</p>
    </div>
  );
}

export function DesktopToolDock({
  taskId,
  tool,
  onClose,
}: {
  taskId: string;
  tool: DesktopTool | null;
  onClose: () => void;
}) {
  if (!tool) return null;
  return (
    <TooltipProvider>
    <aside
      data-testid="desktop-tool-dock"
      data-tool={tool}
      className="flex h-full w-[380px] min-w-0 shrink-0 flex-col overflow-hidden border-l border-line bg-paper below-mid:w-[300px] below-narrow:w-full below-narrow:flex-1 below-narrow:border-l-0"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
        <span className="text-xs font-semibold text-ink">{DESKTOP_TOOL_LABELS[tool]}</span>
        <Badge variant="soft">真实 Host</Badge>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭面板" className="ml-auto">
              ×
            </Button>
          </TooltipTrigger>
          <TooltipContent>关闭面板</TooltipContent>
        </Tooltip>
      </header>
      <Separator />
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tool === "runtime" ? <RunTool key={taskId} taskId={taskId} />
          : tool === "browser" ? <BrowserTool key={taskId} taskId={taskId} />
          : tool === "files" ? <FilesTool key={taskId} taskId={taskId} />
          : tool === "terminal" ? <TerminalTool taskId={taskId} />
          : tool === "logs" ? <LogsTool key={taskId} taskId={taskId} />
          : <ProtocolTool key={taskId} taskId={taskId} />}
      </div>
    </aside>
    </TooltipProvider>
  );
}
