import type { ServiceRecord, ServiceStartPlan } from "./service-runtime.js";

/** Public service data is an allowlist. Descriptor args, process logs and raw env stay in the task Host. */
export function publicServiceStatus(record: ServiceRecord) {
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
    resolved: record.resolved.map((entry) => ({
      key: entry.key,
      value: entry.secret ? "••••••••" : entry.value,
      source: entry.source,
      secret: entry.secret,
    })),
  };
}

/** A read-only preview, not an executable plan sent to renderer. */
export function publicServiceStartPreview(plan: ServiceStartPlan) {
  return { serviceId: plan.serviceId, runType: plan.runType };
}
