/**
 * [PiDock 02] shell-backed Host adapter ([PiDock 02] #5, S6 batch 3).
 *
 * The renderer is sandboxed (`sandbox:true`, `contextIsolation:true`,
 * `nodeIntegration:false`) and must never import Node or Electron: every
 * method below goes through `window.pidock` (`shell/*` invoke channels
 * main allowlists). The adapter wraps a full `HostAdapter` fallback
 * (the in-memory model) for every read/local op that has no shell RPC yet;
 * task turns (`sendMessage`/`stopRun`/approvals/provision) and the service
 * lifecycle of Host-registered services (`setServiceRunning`) ride the real
 * `task/*` ops when the shell is connected and fail closed otherwise.
 *
 * Selection helper `resolveHostAdapter` picks the shell-backed adapter when
 * `window.pidock.taskOp` exists, the memory adapter otherwise. `stores/host`
 * keeps `memoryHost` as the default until the shell boot path wires this in.
 */
import type {
  HostAdapter,
  SendMessageResult,
} from "./hostAdapter";
import { instanceAddress, type ServiceTopologyView } from "./serviceTopology";
import type { Approval, ApprovalStatus, Reference, RunRecord, RunState } from "./types";
import {
  compactSessionThroughShell,
  controlServiceThroughShell,
  isShellConnected,
  planServiceGroupThroughShell,
  serviceRunRecordsThroughShell,
  setSessionModelThroughShell,
  setSessionThinkingThroughShell,
  shellTaskOp,
  sendMessageThroughShell,
  type ShellTaskOpResult,
} from "./shellBridge";
import type { ProviderProfile } from "./types";

function shellResultError(result: ShellTaskOpResult, fallback: string): Error {
  const message = typeof result.error === "string" && result.error.length > 0 ? result.error : fallback;
  return new Error(message);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * `task/sendMessage` result envelope -> renderer `SendMessageResult`.
 *
 * The Host speaks `PiRunState` (`done`/`approval`/`failed`/`cancelled`;
 * transport-only `idle`/`running` must never arrive here). Map to the
 * renderer vocabulary: `done->completed`, `cancelled->stopped`.
 */
function toSendMessageResult(taskId: string, sessionId: string, result: ShellTaskOpResult): SendMessageResult {
  if (!result.ok) throw shellResultError(result, "任务操作失败，已保留输入，请重试");
  const payload = asRecord(result.payload);
  const hostState = payload["state"];
  const state =
    hostState === "done"
      ? "completed"
      : hostState === "cancelled"
        ? "stopped"
        : hostState;
  if (state !== "completed" && state !== "failed" && state !== "approval" && state !== "stopped") {
    throw new Error("invalid-payload: 任务操作返回异常，请重试");
  }
  const approvalId = typeof payload["approvalId"] === "string" ? (payload["approvalId"] as string) : undefined;
  const run: RunRecord = {
    id: typeof payload["callId"] === "string" ? (payload["callId"] as string) : `run-${Date.now()}`,
    taskId,
    sessionId,
    state: state as RunState,
    startedAt: new Date().toISOString(),
    summary: state === "approval" ? "等待确认" : state === "failed" ? "执行失败，已保留现场" : "已完成",
    steps: [
      {
        label: state === "approval" ? (approvalId ? `等待确认 ${approvalId}` : "等待确认") : "运行工具",
        state: state === "failed" ? "failed" : "done",
      },
    ],
  };
  return { state: state as SendMessageResult["state"], run, ...(approvalId ? { approvalId } : {}) };
}

/**
 * Wrap a memory-backed `HostAdapter` with shell-routed task turns. Reads and
 * local-only ops delegate to the fallback; `sendMessage`/`stopRun`/
 * approvals/provision ride `window.pidock` when connected.
 */
type PendingShellApproval = {
  approvalId: string;
  taskId: string;
  sessionId: string;
  title: string;
  tool?: string;
  target?: string;
  requestedAt: string;
};

function toShellApproval(entry: PendingShellApproval): Approval {
  const expiresAt = new Date(Date.parse(entry.requestedAt) + 15 * 60 * 1000).toISOString();
  const tool = entry.tool ?? "";
  const target = entry.target ?? "";
  const title = tool.length > 0 && target.length > 0 ? `${tool} ${target}` : entry.title;
  return {
    id: entry.approvalId,
    taskId: entry.taskId,
    sessionId: entry.sessionId,
    title,
    command: title,
    cwd: "",
    impact: "桌面壳 Host 审批",
    payloadVersion: "v1",
    status: "pending",
    executed: false,
    requestedAt: entry.requestedAt,
    expiresAt,
  };
}

type HostApprovalRecord = {
  id: string;
  sessionId: string;
  tool: string;
  target: string;
  status: string;
  executed: boolean;
};

function asHostApprovalRecord(value: unknown): HostApprovalRecord | undefined {
  const record = asRecord(value);
  if (typeof record["id"] !== "string" || typeof record["sessionId"] !== "string") return undefined;
  if (typeof record["tool"] !== "string" || typeof record["target"] !== "string") return undefined;
  if (typeof record["status"] !== "string") return undefined;
  return {
    id: record["id"] as string,
    sessionId: record["sessionId"] as string,
    tool: record["tool"] as string,
    target: record["target"] as string,
    status: record["status"] as string,
    executed: record["executed"] === true,
  };
}

// Host records carry no `requestedAt`: the renderer mints a 15m-from-view
// window per view. A day-old pending Host approval therefore renders as
// fresh until Host-side reopen-expiry marks it expired (fail-safe: expiry
// only ever shortens, never extends, the true age).
function toApprovalFromHostRecord(taskId: string, record: HostApprovalRecord): Approval {
  const title = `${record.tool} ${record.target}`;
  const requestedAt = new Date().toISOString();
  return {
    id: record.id,
    taskId,
    sessionId: record.sessionId,
    title,
    command: title,
    cwd: "",
    impact: "桌面壳 Host 审批",
    payloadVersion: "v1",
    status: record.status as Approval["status"],
    executed: record.executed,
    requestedAt,
    expiresAt: new Date(Date.parse(requestedAt) + 15 * 60 * 1000).toISOString(),
  };
}

/**
 * Redacted provider catalog for the Host switch/gate ([PiDock 11] #9): ids,
 * names, protocols and per-model declarations only. The auth *reference value*
 * never crosses this boundary — the Host only needs availability/window data.
 */
async function shellProviderCatalog(fallback: HostAdapter): Promise<Record<string, unknown>[]> {
  const workspace = await fallback.getWorkspace();
  return workspace.providers.map((provider: ProviderProfile) => ({
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    enabled: provider.enabled,
    models: provider.models.map((model) => ({
      id: model.id,
      ...(model.name !== undefined ? { name: model.name } : {}),
      contextWindow: model.contextWindow,
      ...(model.maxOutput !== undefined ? { maxOutput: model.maxOutput } : {}),
      ...(model.supportsImages !== undefined ? { supportsImages: model.supportsImages } : {}),
      ...(model.thinking !== undefined ? { thinking: model.thinking } : {}),
    })),
  }));
}

export function createShellHostAdapter(fallback: HostAdapter): HostAdapter {
  // Shell turns never populate the memory fallback, so bridged approvals
  // are tracked here by (taskId, sessionId, approvalId) and resolved
  // directly via `task/approve|reject` — never via fallback lookup.
  // `listApprovals`/`getApproval` merge synthetics the Host does not (yet)
  // list, so the UI can render and resolve a fresh shell approval before
  // the Host persists it.
  const pendingShellApprovals = new Map<string, PendingShellApproval>();
  // Tasks known to have a shell Host (seen via sendMessage/listApprovals).
  // `getApproval(approvalId)` names no task, so Host probing fans out
  // over these ids; unknown ids fall back to memory, else fail closed.
  const knownShellTaskIds = new Set<string>();
  // Host-only approvals seen via `task/listApprovals` / `task/getApproval`
  // (other session, restart, another tab): tracked so `resolveApproval`
  // can route `task/approve|reject` with the listed (taskId, sessionId)
  // without a prior `sendMessage` in this page session.
  const listedShellApprovals = new Map<string, { taskId: string; record: HostApprovalRecord }>();
  return new Proxy(fallback, {
    get(target, property, receiver) {
      if (property === "sendMessage") {
        return async (taskId: string, sessionId: string, text: string, references: Reference[]) => {
          if (!isShellConnected()) return (target as HostAdapter).sendMessage(taskId, sessionId, text, references);
          // Plain chat turn: no scripted tool plan, so the Host runs its
          // default plan (fs.write note under the task dir, gated allow).
          // Structured refs ride as plain data (`references` verbatim +
          // the single `$` skill pick as `skillSource`); the Host persists
          // them without interpreting them.
          const skill = references.find((reference) => reference.kind === "skill");
          const result = await sendMessageThroughShell({
            taskId,
            sessionId,
            text,
            references: references.map((reference) => ({ ...reference })),
            ...(skill ? { skillSource: skill.id } : {}),
          });
          const sent = toSendMessageResult(taskId, sessionId, result);
          // Track the Host's approval id (never the fallback's) so
          // `resolveApproval`/`getApproval`/`listApprovals` can render it
          // without an approval-listing RPC. `approvalId` rides the
          // `task/sendMessage` result payload (see `HostTurnResult`);
          // `tool`/`target` ride the same payload so the synthetic
          // approval shows what awaits approval, not just "等待确认".
          const approvalId = sent.approvalId;
          if (sent.state === "approval" && typeof approvalId === "string" && approvalId.length > 0) {
            const payloadRecord = asRecord(result.payload);
            const tool = typeof payloadRecord["tool"] === "string" ? (payloadRecord["tool"] as string) : undefined;
            const target = typeof payloadRecord["target"] === "string" ? (payloadRecord["target"] as string) : undefined;
            pendingShellApprovals.set(approvalId, {
              approvalId,
              taskId,
              sessionId,
              title: "等待确认",
              ...(tool ? { tool } : {}),
              ...(target ? { target } : {}),
              requestedAt: new Date().toISOString(),
            });
            knownShellTaskIds.add(taskId);
          }
          return sent;
        };
      }
      if (property === "stopRun") {
        return async (taskId: string, sessionId: string) => {
          if (!isShellConnected()) return (target as HostAdapter).stopRun(taskId, sessionId);
          const result = await shellTaskOp(taskId, "task/cancel", { sessionId });
          if (!result.ok) throw shellResultError(result, "停止执行失败，请重试");
        };
      }
      if (property === "resolveApproval") {
        return async (approvalId: string, status: ApprovalStatus) => {
          if (!isShellConnected()) return (target as HostAdapter).resolveApproval(approvalId, status);
          const pending = pendingShellApprovals.get(approvalId);
          if (pending) {
            const op = status === "approved" ? "task/approve" : "task/reject";
            const result = await shellTaskOp(pending.taskId, op, { sessionId: pending.sessionId, approvalId });
            if (!result.ok) throw shellResultError(result, "确认操作失败，请重试");
            pendingShellApprovals.delete(approvalId);
            listedShellApprovals.delete(approvalId);
            return { ...toShellApproval(pending), status, executed: status === "approved" };
          }
          // Host-only approval seen via listing (other session, restart,
          // another tab): resolve directly via task/approve|reject.
          const listed = listedShellApprovals.get(approvalId);
          if (listed) {
            const op = status === "approved" ? "task/approve" : "task/reject";
            const result = await shellTaskOp(listed.taskId, op, { sessionId: listed.record.sessionId, approvalId });
            if (!result.ok) throw shellResultError(result, "确认操作失败，请重试");
            pendingShellApprovals.delete(approvalId);
            listedShellApprovals.delete(approvalId);
            return { ...toApprovalFromHostRecord(listed.taskId, listed.record), status, executed: status === "approved" };
          }
          // Probe the Host (task/getApproval over known tasks) before the
          // memory fallback: covers Host approvals never listed in this tab.
          for (const trackedTask of [...knownShellTaskIds].sort()) {
            let probed: ShellTaskOpResult;
            try {
              probed = await shellTaskOp(trackedTask, "task/getApproval", { approvalId });
            } catch {
              continue;
            }
            if (probed.ok) {
              const record = asHostApprovalRecord(asRecord(probed.payload)["approval"]);
              if (record) {
                const op = status === "approved" ? "task/approve" : "task/reject";
                const result = await shellTaskOp(trackedTask, op, { sessionId: record.sessionId, approvalId });
                if (!result.ok) throw shellResultError(result, "确认操作失败，请重试");
                pendingShellApprovals.delete(approvalId);
                listedShellApprovals.delete(approvalId);
                return { ...toApprovalFromHostRecord(trackedTask, record), status, executed: status === "approved" };
              }
            }
          }
          // No shell approval with this id: fall back to memory (local-only
          // approvals such as the dev/demo fixtures), else fail closed.
          const found = await (target as HostAdapter).getApproval(approvalId);
          if (found) return (target as HostAdapter).resolveApproval(approvalId, status);
          throw new Error("确认请求不存在");
        };
      }
      if (property === "getApproval") {
        return async (approvalId: string) => {
          const pending = pendingShellApprovals.get(approvalId);
          if (pending) return toShellApproval(pending);
          // Bridged read first: the Host owns persisted approvals
          // (`task/getApproval`); the memory fallback covers local-only
          // fixtures, else fail closed with `undefined` (matches the
          // `HostAdapter.getApproval` absent contract). `getApproval`
          // names no task, so Host probing fans out over tasks this
          // adapter has seen (`knownShellTaskIds`); only a `found`
          // record counts — `{ok:false}` / malformed records never
          // resolve (fall through to memory, never throw).
          // Bridged detail never throws: a rejected bridge (transport
          // failure) falls through to the memory fallback below, matching
          // the never-throw read contract.
          if (isShellConnected()) {
            for (const trackedTask of [...knownShellTaskIds].sort()) {
              let result: ShellTaskOpResult;
              try {
                result = await shellTaskOp(trackedTask, "task/getApproval", { approvalId });
              } catch {
                continue;
              }
              if (result.ok) {
                const record = asHostApprovalRecord(asRecord(result.payload)["approval"]);
                if (record) {
                  knownShellTaskIds.add(trackedTask);
                  listedShellApprovals.set(approvalId, { taskId: trackedTask, record });
                  return toApprovalFromHostRecord(trackedTask, record);
                }
              }
            }
          }
          return (target as HostAdapter).getApproval(approvalId);
        };
      }
      if (property === "listApprovals") {
        return async (taskId: string) => {
          const local = await (target as HostAdapter).listApprovals(taskId);
          // Bridged listing first: real Host approvals (`task/listApprovals`)
          // replace the synthetic merge; a failed or rejected RPC keeps the
          // local synthetics + memory fixture merge (fail-open read,
          // never throw).
          if (isShellConnected()) {
            let result: ShellTaskOpResult;
            try {
              result = await shellTaskOp(taskId, "task/listApprovals", {});
            } catch {
              result = { ok: false };
            }
            if (result.ok) {
              knownShellTaskIds.add(taskId);
              const raw = asRecord(result.payload)["approvals"];
              if (Array.isArray(raw)) {
                const records = raw
                  .map(asHostApprovalRecord)
                  .filter((record): record is HostApprovalRecord => record !== undefined);
                for (const record of records) {
                  listedShellApprovals.set(record.id, { taskId, record });
                }
                const listed = records.map((record) => toApprovalFromHostRecord(taskId, record));
                const listedIds = new Set(listed.map((approval) => approval.id));
                // Merge local synthetics the Host does not (yet) know:
                // the stub above returns `[]`, but a fresh `sendMessage`
                // approval is tracked locally before the Host persists it.
                const pending = [...pendingShellApprovals.values()]
                  .filter((entry) => entry.taskId === taskId && !listedIds.has(entry.approvalId))
                  .map(toShellApproval);
                return [...listed, ...pending, ...local.filter((approval) => !listedIds.has(approval.id))];
              }
            }
          }
          const shell = [...pendingShellApprovals.values()]
            .filter((entry) => entry.taskId === taskId)
            .map(toShellApproval);
          return [...shell, ...local];
        };
      }
      if (property === "setServiceRunning") {
        return async (taskId: string, serviceId: string, running: boolean) => {
          if (!isShellConnected()) return (target as HostAdapter).setServiceRunning(taskId, serviceId, running);
          // Shell Host owns the lifecycle of the services it knows.
          // Probe registration first (`task/serviceStatus`): a service the
          // Host has not registered (renderer has no registration path yet)
          // keeps the memory fallback instead of failing closed on
          // `unknown-service`. A Host-known service is controlled by the
          // Host — no `sessionId`, so the Host classifies it as the
          // attested human-UI path and labels it.
          let probe: ShellTaskOpResult;
          try {
            probe = await shellTaskOp(taskId, "task/serviceStatus", { serviceId });
          } catch {
            probe = { ok: false };
          }
          if (!probe.ok) return (target as HostAdapter).setServiceRunning(taskId, serviceId, running);
          const result = await controlServiceThroughShell({ taskId, serviceId, action: running ? "start" : "stop" });
          if (!result.ok) throw shellResultError(result, "服务启停失败，请重试");
        };
      }
      if (property === "serviceTopology") {
        return async (taskId: string): Promise<ServiceTopologyView> => {
          const local = await (target as HostAdapter).serviceTopology(taskId);
          if (!isShellConnected()) return local;
          // [PiDock 05] (#10) Prefer the Host's own plan (final ports, task
          // bindings, start groups, run records). The request is derived from
          // the visible projection, so a Host that has no plan yet (or a
          // failing round-trip) keeps the memory view instead of an empty one.
          const units = local.units.map((unit) => ({
            unitId: unit.unitId,
            serviceId: unit.serviceId,
            name: unit.name,
            ...(unit.repoDir !== undefined ? { repoDir: unit.repoDir } : {}),
            location: unit.location,
            runType: unit.runType,
          }));
          const requests = local.units
            .filter((unit) => unit.location === "local")
            .map((unit) => {
              const address = local.routing.find((entry) => entry.unitId === unit.unitId)?.target;
              const port = address?.kind === "local-instance" ? address.port : undefined;
              return port !== undefined ? { unitId: unit.unitId, port } : undefined;
            })
            .filter((entry): entry is { unitId: string; port: number } => entry !== undefined);
          const plan = await planServiceGroupThroughShell({
            taskId,
            units,
            dependencies: local.units.flatMap((unit) =>
              unit.dependencies.map((dependency) => ({ from: unit.unitId, to: dependency.to, kind: dependency.kind })),
            ),
            requests,
            environment: taskId,
          });
          const records = await serviceRunRecordsThroughShell(taskId);
          const payload = plan.ok ? asRecord(plan.payload)["plan"] : undefined;
          const planRecord = asRecord(payload);
          const hostRecords = records.ok ? asRecord(records.payload)["records"] : undefined;
          const merged: typeof local = { ...local };
          if (plan.ok && typeof payload === "object" && payload !== null) {
            const assignments = Array.isArray(planRecord["assignments"]) ? planRecord["assignments"] : [];
            const reallocated = new Map(
              (Array.isArray(planRecord["reallocated"]) ? planRecord["reallocated"] : [])
                .map((entry) => asRecord(entry))
                .map((entry) => [entry["unitId"], entry["after"]] as const),
            );
            merged.routing = local.routing.map((entry) => {
              const moved = reallocated.get(entry.unitId);
              if (typeof moved !== "number" || entry.target.kind !== "local-instance") return entry;
              return {
                ...entry,
                target: { ...entry.target, port: moved, address: instanceAddress(taskId, entry.target.serviceId, moved) },
              };
            });
            const hostGroups = planRecord["groups"];
            if (Array.isArray(hostGroups)) {
              merged.groups = hostGroups.map((group) => {
                const record = asRecord(group);
                return {
                  groupId: String(record["groupId"] ?? ""),
                  members: Array.isArray(record["members"]) ? record["members"].map(String) : [],
                  reason: (record["reason"] ?? "single") as "prestart" | "listener-group" | "single",
                  bidirectional: record["bidirectional"] === true,
                  verify: Array.isArray(record["verify"]) ? record["verify"].map(String) : [],
                };
              });
            }
            const hostDiagnostics = planRecord["diagnostics"];
            if (Array.isArray(hostDiagnostics) && hostDiagnostics.length > 0) {
              merged.diagnostics = hostDiagnostics.map((entry) => {
                const record = asRecord(entry);
                return {
                  code: String(record["code"] ?? "unknown"),
                  message: String(record["message"] ?? ""),
                  ...(typeof record["hint"] === "string" ? { hint: record["hint"] } : {}),
                };
              });
            }
            const knownLimits = planRecord["knownLimits"];
            if (Array.isArray(knownLimits)) merged.knownLimits = knownLimits.map(String);
            // Assignments the Host decided are authoritative even when a unit
            // has no endpoint variable yet.
            for (const assignment of assignments.map(asRecord)) {
              const unitId = assignment["unitId"];
              const port = assignment["port"];
              if (typeof unitId !== "string" || typeof port !== "number") continue;
              merged.routing = merged.routing.map((entry) =>
                entry.unitId === unitId && entry.target.kind === "local-instance"
                  ? { ...entry, target: { ...entry.target, port, address: instanceAddress(taskId, entry.target.serviceId, port) } }
                  : entry,
              );
            }
          }
          if (Array.isArray(hostRecords)) {
            const byService = new Map(
              hostRecords.map(asRecord).map((record) => [record["serviceId"], record] as const),
            );
            merged.records = local.records.map((entry) => {
              const run = byService.get(entry.serviceId);
              if (!run) return entry;
              return {
                ...entry,
                run: {
                  runId: String(run["runId"] ?? ""),
                  templateVersion: String(run["templateVersion"] ?? ""),
                  codeState: (asRecord(run["codeState"])["kind"] ?? "unknown") as "committed-clean" | "uncommitted" | "unknown",
                  buildFreshness: (run["buildFreshness"] ?? "unknown") as "fresh" | "stale-build" | "uncommitted-code" | "unknown",
                  ports: Array.isArray(run["ports"]) ? run["ports"].map(Number) : [],
                  processIdentity: {
                    owner: asRecord(run["processIdentity"])["owner"] === "agent" ? "agent" : "human",
                    pid: Number(asRecord(run["processIdentity"])["pid"] ?? 0),
                    startedAt: String(asRecord(run["processIdentity"])["startedAt"] ?? ""),
                  },
                  logRef: String(run["logRef"] ?? ""),
                  startedAt: String(run["startedAt"] ?? ""),
                  verifications: [],
                },
              };
            });
          }
          return merged;
        };
      }
      // [PiDock 11] (#9) provider/model/context ops. The Host owns the switch
      // gate (busy round/tool -> availability -> strict context bound) and
      // validates the redacted catalog it receives; the fallback adapter then
      // mirrors the accepted selection into the visible session state. A Host
      // refusal throws before the mirror runs, so the visible model, history
      // and draft stay untouched.
      if (property === "setSessionModel") {
        return async (taskId: string, sessionId: string, providerId: string, model: string) => {
          if (!isShellConnected()) return (target as HostAdapter).setSessionModel(taskId, sessionId, providerId, model);
          const catalog = await shellProviderCatalog(target as HostAdapter);
          const result = await setSessionModelThroughShell({ taskId, sessionId, providerId, model, reason: "human-switch", catalog });
          if (!result.ok) throw shellResultError(result, "切换模型失败，请重试");
          return (target as HostAdapter).setSessionModel(taskId, sessionId, providerId, model);
        };
      }
      if (property === "setSessionThinking") {
        return async (taskId: string, sessionId: string, level: string) => {
          if (!isShellConnected()) return (target as HostAdapter).setSessionThinking(taskId, sessionId, level);
          const catalog = await shellProviderCatalog(target as HostAdapter);
          const result = await setSessionThinkingThroughShell({ taskId, sessionId, level, catalog });
          if (!result.ok) throw shellResultError(result, "设置推理档位失败，请重试");
          return (target as HostAdapter).setSessionThinking(taskId, sessionId, level);
        };
      }
      if (property === "compactSessionContext") {
        return async (taskId: string, sessionId: string) => {
          if (!isShellConnected()) return (target as HostAdapter).compactSessionContext(taskId, sessionId);
          const catalog = await shellProviderCatalog(target as HostAdapter);
          const result = await compactSessionThroughShell({ taskId, sessionId, catalog });
          if (!result.ok) throw shellResultError(result, "上下文压缩失败，请重试");
          return (target as HostAdapter).compactSessionContext(taskId, sessionId);
        };
      }
      if (property === "simulateExpiry") {
        // Expiry simulation stays local; approval listing/detail now
        // bridge the Host (`task/listApprovals`/`task/getApproval`).
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Adapter selection: shell-backed when `window.pidock.taskOp` exists
 * (Electron shell), the memory fallback otherwise (Vite dev, tests).
 * Renderer-no-Node holds: this module only reads `window.pidock`.
 */
export function resolveHostAdapter(fallback: HostAdapter): HostAdapter {
  if (!isShellConnected()) return fallback;
  return createShellHostAdapter(fallback);
}
