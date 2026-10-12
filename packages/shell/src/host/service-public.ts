import { LAUNCH_VERIFICATION_TARGETS, hostPlatformLabel } from "../main/service-config.js";
import type { ServiceLaunchVerification, ServiceRecord, ServiceStartPlan } from "./service-runtime.js";

/**
 * One platform row of the launch-verification read ([PiDock 04] #7 box 7).
 * `verified` is true ONLY for a row whose record carries a real launch
 * observation (`startedAt`) made on the platform this Host is answering from;
 * every other row says WHY it is not verified, so a platform the app never ran
 * on cannot be read as a pass. The launch's argv is deliberately absent: like
 * the descriptor's own argv, it stays in the task Host.
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
 * A record written on another platform stays a not-verified row here: a task
 * workspace copied between machines must not make its old launch look like a
 * verification of this one.
 */
export function platformVerificationRows(
  verifications: readonly ServiceLaunchVerification[],
  platform: string,
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
    const mine = name === platform;
    rows.push({
      platform: name,
      verified: mine,
      nodeVersion: entry.nodeVersion,
      program: entry.program ?? "",
      startedAt: entry.startedAt as string,
      stopped: entry.stopped === true,
      ...(entry.stopped === true && entry.stoppedAt !== undefined ? { stoppedAt: entry.stoppedAt } : {}),
      ...(mine ? {} : { reason: `记录来自其他平台（${name}），本机 ${platform} 未实测` }),
    });
  }
  return rows;
}

/** Public service data is an allowlist. Descriptor args, process logs and raw env stay in the task Host. */
export function publicServiceStatus(record: ServiceRecord, platform: string = hostPlatformLabel()) {
  return {
    serviceId: record.serviceId,
    lifecycle: record.lifecycle,
    templateVersion: record.templateVersion,
    startedAt: record.startedAt,
    stoppedAt: record.stoppedAt,
    exitReason: record.exitReason,
    /** `catalog` only: a `ui` registration is display data and cannot execute yet. */
    launchSource: record.launchSource,
    /** Process liveness only; no dependency/health probe contributed to `lifecycle`. */
    health: "not-probed" as const,
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
     * verification, or the named reason it is not verified. Never a claim that
     * this machine verified a platform it did not run.
     */
    launchVerification: {
      platform,
      rows: platformVerificationRows(record.launchVerifications, platform),
    },
  };
}

/** A read-only preview, not an executable plan sent to renderer. */
export function publicServiceStartPreview(plan: ServiceStartPlan) {
  return { serviceId: plan.serviceId, runType: plan.runType };
}
