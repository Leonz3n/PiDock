/**
 * [PiDock 04] (#7 box 7) the SEAM: the REAL Host projection read by the REAL
 * renderer parser.
 *
 * `taskLaunchVerification.test.ts` proves the parser with hand-written payloads,
 * which is exactly how a Host-emits-what-its-own-renderer-refuses bug hides: the
 * payload's key list is duplicated in prose, not enforced. This file imports
 * BOTH ends and runs `publicServiceStatus` (the exact projection
 * `task/serviceStatus` returns) through `serviceStatusFromHost` (the exact parser
 * the panel uses), so a Host key the renderer does not accept — or a renderer
 * key the Host no longer emits — fails here before it can blank the live status.
 * No payload is a literal below.
 */
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { serviceStatusFromHost, VERIFICATION_ROW_KEYS, type ServiceStatusView } from "../data/taskServices";
import { memoryLaunchVerificationLog } from "../../../shell/src/host/service-launch-verification.js";
import { probeServiceHealth } from "../../../shell/src/host/service-health-probe.js";
import { publicServiceStatus } from "../../../shell/src/host/service-public.js";
import { TaskServiceRuntime } from "../../../shell/src/host/service-runtime.js";
import { LAUNCH_VERIFICATION_SCHEMA_VERSION, type LaunchVerificationEntry } from "../../../shell/src/host/task-store.js";

const HERE = `${process.platform}-${process.arch}`;
const NODE = process.versions.node;
const THIS_INSTALLATION = "11111111-1111-1111-1111-111111111111";
const OTHER_INSTALLATION = "22222222-2222-2222-2222-222222222222";
const TEMPLATE = "v1";

/** One real record for one service, bound to a given installation/template. */
function entry(input: { serviceId: string; platform?: string; installationId?: string; templateVersion?: string }): LaunchVerificationEntry {
  return {
    schemaVersion: LAUNCH_VERIFICATION_SCHEMA_VERSION,
    serviceId: input.serviceId,
    platform: input.platform ?? HERE,
    nodeVersion: NODE,
    program: "node",
    args: ["service.cjs"],
    startedAt: "2026-10-08T00:00:00.000Z",
    stopped: false,
    installationId: input.installationId ?? THIS_INSTALLATION,
    templateVersion: input.templateVersion ?? TEMPLATE,
  };
}

function register(runtime: TaskServiceRuntime, serviceId: string, healthCheck?: { kind: "http" | "tcp" | "grpc"; target?: string }): void {
  runtime.register({
    serviceId,
    descriptor: { name: serviceId, program: "node", args: ["service.cjs"], ports: [], runType: "long-lived",
      ...(healthCheck === undefined ? {} : { healthCheck }) },
    layers: { repoDefaults: [], shared: [], privateEntries: [], task: [] },
    templateVersion: TEMPLATE,
    launchSource: "catalog",
  });
}

/** The REAL Host projection for one service, through the REAL renderer parser. */
function projected(runtime: TaskServiceRuntime, serviceId: string): ServiceStatusView {
  const payload = { service: publicServiceStatus(runtime.get(serviceId)!, HERE, THIS_INSTALLATION) };
  const view = serviceStatusFromHost(payload, serviceId);
  // A parse failure here is the defect this seam exists to catch: the real
  // payload the real Host emits is refused by the real renderer.
  expect(view).not.toBeNull();
  return view as ServiceStatusView;
}

function rowsOf(view: ServiceStatusView) {
  return view.kind === "registry" ? view.launchVerification?.rows ?? [] : [];
}

describe("[PiDock 04] #7 the real Host projection parses in the real renderer", () => {
  const runtime = new TaskServiceRuntime("/tmp/seam-task", undefined, memoryLaunchVerificationLog([
    entry({ serviceId: "svc-verified" }),
    entry({ serviceId: "svc-foreign", installationId: OTHER_INSTALLATION }),
    entry({ serviceId: "svc-other-platform", platform: "win32-x64" }),
    entry({ serviceId: "svc-stale", templateVersion: "v0" }),
    // The malformed single row that used to blank the WHOLE status: an observed
    // launch with no program token.
    { ...entry({ serviceId: "svc-unusable" }), program: "" },
  ]));
  for (const id of ["svc-verified", "svc-foreign", "svc-other-platform", "svc-stale", "svc-unusable", "svc-clean"]) register(runtime, id);

  it("carries the verified row's real launch facts to the panel", () => {
    const verified = rowsOf(projected(runtime, "svc-verified")).filter((row) => row.verified);
    expect(verified).toEqual([
      { platform: HERE, verified: true, nodeVersion: NODE, program: "node", startedAt: "2026-10-08T00:00:00.000Z", stopped: false },
    ]);
  });

  it("keeps another installation's same-platform record unverified, by name", () => {
    const foreign = rowsOf(projected(runtime, "svc-foreign")).find((row) => row.platform === HERE);
    expect(foreign).toEqual({ platform: HERE, verified: false, reason: "记录来自其他安装（同一平台），本安装未实测" });
  });

  it("keeps another platform's record unverified, by name", () => {
    const other = rowsOf(projected(runtime, "svc-other-platform")).find((row) => row.platform === "win32-x64");
    expect(other).toEqual({ platform: "win32-x64", verified: false, reason: `记录来自其他平台（win32-x64），本机 ${HERE} 未实测` });
  });

  it("keeps a superseded template's record unverified, by name", () => {
    const stale = rowsOf(projected(runtime, "svc-stale")).find((row) => row.platform === HERE);
    expect(stale).toEqual({ platform: HERE, verified: false, reason: "记录来自模板 v0，当前模板 v1，未算已验证" });
  });

  it("lists a service with no record as unverified, not absent", () => {
    const clean = rowsOf(projected(runtime, "svc-clean"));
    expect(clean.length).toBeGreaterThan(0);
    expect(clean.every((row) => !row.verified)).toBe(true);
  });

  it("keeps a record with unusable launch facts readable, as one unverified row", () => {
    // The old projection emitted `program: ""`, which the parser's
    // `optionalText` refuses, blanking the ENTIRE service status. The read must
    // survive with that row unverified instead.
    const rows = rowsOf(projected(runtime, "svc-unusable"));
    expect(rows.find((row) => row.platform === HERE)).toEqual({ platform: HERE, verified: false, reason: "该平台的记录缺少启动事实，未算已验证" });
    expect(rows.map((row) => row.platform)).toEqual(expect.arrayContaining(["win32-x64"]));
  });

  it("pins the projection's row keys to the parser's own allowlist", () => {
    const allRows = [
      ...rowsOf(projected(runtime, "svc-verified")),
      ...rowsOf(projected(runtime, "svc-foreign")),
      ...rowsOf(projected(runtime, "svc-other-platform")),
      ...rowsOf(projected(runtime, "svc-stale")),
      ...rowsOf(projected(runtime, "svc-unusable")),
      ...rowsOf(projected(runtime, "svc-clean")),
    ];
    expect(allRows.length).toBeGreaterThan(0);
    const emitted = new Set(allRows.flatMap((row) => Object.keys(row)));
    // The duplicated key list is now DERIVED from the real projection: a new
    // Host key that the renderer's allowlist lacks fails here (and would blank
    // the live status), so the two ends cannot silently drift apart.
    expect([...emitted].every((key) => VERIFICATION_ROW_KEYS.includes(key))).toBe(true);
    expect([...emitted].sort()).toEqual(["nodeVersion", "platform", "program", "reason", "startedAt", "stopped", "verified"]);
  });

  /**
   * [PiDock 04] (#7 box 5) the SAME seam for the declared 健康检查: the REAL
   * probe of a REAL listener, through the REAL projection, into the REAL parser.
   * A health state the Host can produce but the panel refuses to read would be
   * the "capability exists but production cannot reach it" bug this file exists
   * to prevent, so the three states are pinned end to end here.
   */
  describe("the declared 健康检查's real observation", () => {
    const listeners: { close(): Promise<void> }[] = [];
    afterEach(async () => {
      for (const listener of listeners.splice(0)) await listener.close();
    });
    /** A real HTTP listener on 127.0.0.1; `respond` decides what (if anything) it answers. */
    const listener = async (statusCode: number | undefined): Promise<number> => {
      const server = createServer((_request, response) => {
        if (statusCode === undefined) return;
        response.writeHead(statusCode, { "content-type": "text/plain" });
        response.end("health");
      });
      server.on("clientError", () => {});
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw Error("no-bound-port");
      listeners.push({ close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); } });
      return address.port;
    };
    /** The real Host projection for a running service, carrying a real probe result. */
    const projectedWithProbe = async (healthCheck: { kind: "http" | "tcp" | "grpc"; target?: string } | undefined, running: boolean): Promise<ServiceStatusView> => {
      const runtime = new TaskServiceRuntime("/tmp/seam-health-task", undefined, memoryLaunchVerificationLog([]));
      register(runtime, "svc-health", healthCheck);
      const record = runtime.get("svc-health")!;
      if (running) runtime.markStarted("svc-health", { kind: "human", label: "fixture" });
      const observation = await probeServiceHealth({ healthCheck: record.descriptor.healthCheck, running });
      const view = serviceStatusFromHost({ service: publicServiceStatus(runtime.get("svc-health")!, HERE, THIS_INSTALLATION, observation) }, "svc-health");
      expect(view).not.toBeNull();
      return view as ServiceStatusView;
    };

    it("carries a real 200 and its real elapsed time to the panel", async () => {
      const port = await listener(200);
      const view = await projectedWithProbe({ kind: "http", target: `http://127.0.0.1:${String(port)}/health` }, true);
      expect(view.kind === "registry" ? view.health : undefined).toBe("healthy");
      expect(view.kind === "registry" ? view.healthDetail : undefined).toMatchObject({ kind: "http", statusCode: 200 });
      expect(view.kind === "registry" ? view.healthDetail?.elapsedMs : undefined).toBeGreaterThanOrEqual(0);
    });

    it("carries a refused declared target by name while the process stays running", async () => {
      const port = await listener(200);
      // Close the declared port for real before the read.
      for (const entry of listeners.splice(0)) await entry.close();
      const view = await projectedWithProbe({ kind: "http", target: `http://127.0.0.1:${String(port)}/health` }, true);
      expect(view.kind === "registry" ? view.health : undefined).toBe("unhealthy");
      expect(view.kind === "registry" ? view.healthDetail?.reason : undefined).toBe("连接被拒");
      // Invariant 1 through the renderer's own view: a failed probe is not a dead process.
      expect(view.kind === "registry" ? view.lifecycle : undefined).toBe("running");
    });

    it("carries 未声明 and 未探测 as named states, never as a pass", async () => {
      const undeclared = await projectedWithProbe(undefined, true);
      expect(undeclared.kind === "registry" ? undeclared.health : undefined).toBe("undeclared");
      expect(undeclared.kind === "registry" ? undeclared.healthDetail : undefined).toBeUndefined();
      const notRunning = await projectedWithProbe({ kind: "http", target: "http://127.0.0.1:1/health" }, false);
      expect(notRunning.kind === "registry" ? notRunning.health : undefined).toBe("not-probed");
      expect(notRunning.kind === "registry" ? notRunning.healthDetail?.reason : undefined).toBe("服务未运行，不发起探测");
      const grpc = await projectedWithProbe({ kind: "grpc", target: "127.0.0.1:9" }, true);
      expect(grpc.kind === "registry" ? grpc.health : undefined).toBe("not-probed");
      expect(grpc.kind === "registry" ? grpc.healthDetail?.reason : undefined).toContain("gRPC");
    });
  });
});
