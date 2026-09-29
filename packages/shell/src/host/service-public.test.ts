import { describe, expect, it } from "vitest";
import { TaskServiceRuntime } from "./service-runtime.js";
import { publicServiceStartPreview, publicServiceStatus } from "./service-public.js";

describe("#7 service RPC display projection", () => {
  it("does not return raw env, descriptor arguments, or logs to the renderer", () => {
    const runtime = new TaskServiceRuntime("/tmp/task-a");
    runtime.register({
      serviceId: "invoice",
      descriptor: { name: "invoice", program: "/bin/echo", args: ["raw-command-secret"], ports: [], runType: "long-lived" },
      layers: {
        repoDefaults: [], shared: [],
        privateEntries: [{ key: "PRIVATE_KEY", value: "raw-env-secret", secret: true }],
        task: [{ key: "PORT", value: "4567", secret: false }],
      },
      templateVersion: "v1",
    });
    runtime.markStarted("invoice", { kind: "human", label: "ui" }, "raw-log-secret");
    const record = runtime.get("invoice")!;
    const status = publicServiceStatus(record);
    expect(status.resolved).toEqual([
      { key: "PRIVATE_KEY", value: "••••••••", source: "本机私有配置", secret: true },
      { key: "PORT", value: "4567", source: "任务覆盖", secret: false },
    ]);
    expect(JSON.stringify(status)).not.toMatch(/raw-(?:command|env|log)-secret/);
    const preview = publicServiceStartPreview(runtime.planStart("invoice", "/tmp/task-a"));
    expect(preview).toEqual({ serviceId: "invoice", runType: "long-lived" });
    expect(JSON.stringify(preview)).not.toMatch(/raw-(?:command|env|log)-secret/);
  });
});
