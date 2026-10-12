import { LAUNCH_VERIFICATION_TARGETS, hostPlatformLabel } from "../main/service-config.js";
import { hostInstallationId } from "./installation-identity.js";
import { healthDetailOf, unprobedServiceHealth, type ServiceHealthObservation } from "./service-health-probe.js";
import type { ServiceLaunchVerification, ServiceRecord, ServiceStartPlan } from "./service-runtime.js";

/**
 * One platform row of the launch-verification read ([PiDock 04] #7 box 7).
 * `verified` is true ONLY for a row whose record carries a real launch
 * observation (`startedAt`) made on the platform this Host is answering from,
 * by THIS installation, against the template version the service currently
 * runs. Every other row says WHY it is not verified - another platform,
 * another installation of the same platform, a stale template, or a record
 * missing its launch facts - so a platform (or an iteration) the app did not
 * run here can never read as a pass. The launch's argv is deliberately absent:
 * like the descriptor's own argv, it stays in the task Host.
 */
export interface PlatformVerificationRow {
  platform: string;
  verified: boolean;
  nodeVersion?: string;
  program?: string;
  startedAt?: string;
  stopped?: boolean;
  stoppedAt?: string;
  reason?: string;
}

/**
 * Build the platform rows of one service's verification read. The row set is
 * the project's release targets, this machine's own platform, and any platform
 * a record names — so "no row" is never how an unverified platform is shown.
 * A record is a verification of THIS installation only: it must match the
 * platform this Host runs on, the Host's own installation identity, and the
 * template version this service currently runs. A record written on another
 * platform, or by another installation of the same platform (a task workspace
 * copied between machines), or against an older template, stays a not-verified
 * row with a named reason instead of making its old launch look like a
 * verification of this one. A malformed record (an observed launch with no
 * program token, say) degrades to ITS row being unverified; it never blanks the
 * whole status, so one bad row cannot hide every other service fact.
 */
export function platformVerificationRows(
  verifications: readonly ServiceLaunchVerification[],
  platform: string,
  installationId: string | undefined,
  templateVersion: string,
): PlatformVerificationRow[] {
  const observed = new Map(verifications.filter((entry) => entry.startedAt !== undefined).map((entry) => [entry.platform, entry]));
  const withoutObservation = new Set(verifications.filter((entry) => entry.startedAt === undefined).map((entry) => entry.platform));
  const rows: PlatformVerificationRow[] = [];
  for (const name of [...LAUNCH_VERIFICATION_TARGETS, platform, ...verifications.map((entry) => entry.platform)]) {
    if (rows.some((row) => row.platform === name)) continue;
    const entry = observed.get(name);
    if (entry === undefined) {
      // Named reasons, so an unverified row never has to be inferred: a record
      // that names no launch fact is still not a verification.
      const reason = withoutObservation.has(name)
        ? "该平台只有未记录实测事实的条目，不算已验证"
        : name === platform ? "本任务尚无该平台的实测启动记录" : "本机未运行该平台，未实测";
      rows.push({ platform: name, verified: false, reason });
      continue;
    }
    const refusal = verificationRefusal(entry, name, platform, installationId, templateVersion);
    if (refusal !== undefined) {
      rows.push({ platform: name, verified: false, reason: refusal });
      continue;
    }
    rows.push({
      platform: name,
      verified: true,
      nodeVersion: entry.nodeVersion,
      program: entry.program as string,
      startedAt: entry.startedAt as string,
      stopped: entry.stopped === true,
      ...(entry.stopped === true && entry.stoppedAt !== undefined ? { stoppedAt: entry.stoppedAt } : {}),
    });
  }
  return rows;
}

/**
 * Why one observed record is NOT a verification of this Host, or `undefined`
 * when it really is one. Each branch is a named reason, because a not-verified
 * row must never have to be inferred: another platform, another installation of
 * the same platform, a record with no installation binding (a workspace written
 * before this binding existed), a stale template, or a record whose own launch
 * facts are unusable all stay visible instead of being dropped or promoted.
 */
function verificationRefusal(
  entry: ServiceLaunchVerification,
  name: string,
  platform: string,
  installationId: string | undefined,
  templateVersion: string,
): string | undefined {
  if (name !== platform) return `记录来自其他平台（${name}），本机 ${platform} 未实测`;
  if (entry.installationId === undefined) return "记录未绑定安装标识，本安装未实测";
  if (installationId === undefined) return "本安装缺少安装标识，未实测确认";
  if (entry.installationId !== installationId) return "记录来自其他安装（同一平台），本安装未实测";
  if (entry.templateVersion === undefined) return "记录未绑定模板版本，未算已验证";
  if (entry.templateVersion !== templateVersion) {
    return `记录来自模板 ${entry.templateVersion}，当前模板 ${templateVersion}，未算已验证`;
  }
  // The projection is an allowlist the renderer parses strictly, so a record
  // missing any launch fact is refused HERE (its own row) instead of emitting a
  // row the renderer would reject - which would blank the whole status.
  const startedAt = entry.startedAt;
  const program = entry.program;
  const nodeVersion = entry.nodeVersion;
  if (
    typeof startedAt !== "string" || startedAt.length === 0 ||
    typeof program !== "string" || program.length === 0 ||
    typeof nodeVersion !== "string" || nodeVersion.length === 0
  ) {
    return "该平台的记录缺少启动事实，未算已验证";
  }
  return undefined;
}

/** Public service data is an allowlist. Descriptor args, process logs and raw env stay in the task Host. */
export function publicServiceStatus(
  record: ServiceRecord,
  platform: string = hostPlatformLabel(),
  installationId: string | undefined = hostInstallationId(),
  /**
   * The health observation the caller produced for THIS read
   * (`probeServiceHealth`). Absent does NOT mean a pass: the projection then
   * states, by name, that this read ran no probe (see `unprobedServiceHealth`),
   * so a caller that forgets to probe can never render as healthy.
   */
  health: ServiceHealthObservation = unprobedServiceHealth(record.descriptor.healthCheck),
) {
  const healthDetail = healthDetailOf(health);
  return {
    serviceId: record.serviceId,
    lifecycle: record.lifecycle,
    templateVersion: record.templateVersion,
    startedAt: record.startedAt,
    stoppedAt: record.stoppedAt,
    exitReason: record.exitReason,
    /** `catalog` only: a `ui` registration is display data and cannot execute yet. */
    launchSource: record.launchSource,
    /**
     * The declared 健康检查, as OBSERVED by one bounded probe of the pinned
     * revision's own target ([PiDock 04] #7 box 5): `healthy` only after a real
     * 2xx/completed connect, `unhealthy` with the named reason of a real
     * failure, `not-probed` when nothing was dialled (the process is not
     * running, no target is declared, or the kind has no implementation here),
     * `undeclared` when the pinned revision declares no check at all. A probe
     * failure is a statement about the TARGET, never about the process:
     * `lifecycle` stays process liveness. `healthDetail` carries the facts the
     * probe really observed (declared kind, declared target, real status code,
     * real elapsed ms and bound, and the named reason of a non-pass).
     */
    health: health.state,
    ...(healthDetail === undefined ? {} : { healthDetail }),
    /**
     * Who last started or stopped this service, and through which path
     * ([PiDock 04] #7 box 5): `human` is the explicit UI action carrying
     * main's own label, `agent` is the gated Agent path carrying the session
     * id. The UI renders them apart, so an Agent action is never shown as if
     * the user had clicked it itself (and the reverse). `null` means the
     * service has no recorded control yet.
     */
    lastControl: record.lastControl === undefined ? null : {
      action: record.lastControl.action,
      actor: record.lastControl.actor.kind,
      label: record.lastControl.actor.kind === "human" ? record.lastControl.actor.label : record.lastControl.actor.sessionId,
    },
    resolved: record.resolved.map((entry) => ({
      key: entry.key,
      value: entry.secret ? "••••••••" : entry.value,
      source: entry.source,
      secret: entry.secret,
    })),
    /**
     * The platform this Host is really answering from (`process.platform` +
     * `process.arch`, host-side computed) and one row per platform: a real
     * verification by THIS installation against the current template, or the
     * named reason it is not one. Never a claim that this machine verified a
     * launch it did not run (another platform, another installation, or an
     * older template all read as not verified, by name).
     */
    launchVerification: {
      platform,
      rows: platformVerificationRows(record.launchVerifications, platform, installationId, record.templateVersion),
    },
  };
}

/** A read-only preview, not an executable plan sent to renderer. */
export function publicServiceStartPreview(plan: ServiceStartPlan) {
  return { serviceId: plan.serviceId, runType: plan.runType };
}
