// Real Worker transport fault probes; not an SDK/model or service ownership fixture.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { SdkContextClient } from "../dist/host/sdk-context-client.js";
const root = mkdtempSync(join(tmpdir(), "pidock-sdk-shutdown-"));
const config = { profileId: "explicit", baseUrl: "https://models.example.test/v1", modelId: "fixture", contextWindow: 2048, maxTokens: 128, authRef: "PIDOCK_PROVIDER_TEST", generation: 1 };
const workers = [], results = [];
const script = `
  const {parentPort,workerData} = require("node:worker_threads");
  parentPort.postMessage({id:"ready",kind:"reply",ok:true,payload:{ready:true}});
  parentPort.on("message", ({id,op}) => {
    if(op==="open") parentPort.postMessage({id,kind:"reply",ok:true,payload:{sdkId:"fixture",file:"fixture.jsonl",tools:[]}});
    if(op==="dispose" && workerData.mode!=="silent-dispose") parentPort.postMessage({id,kind:"reply",ok:true,payload:{disposed:true}});
  });
`;
try {
  for (const mode of ["clean", "silent-dispose", "missing-termination-receipt"]) {
    const taskDir = join(root, mode); mkdirSync(taskDir); let nativeExited = false, terminationCount = 0, actualTermination;
    const client = new SdkContextClient({ task: { taskId: "task-abcdef12", taskDir }, config, credential: "synthetic-private-credential", shutdownTimeoutMs: 100,
      spawn: (env) => {
        const worker = new Worker(script, { eval: true, env, workerData: { mode } }); workers.push(worker);
        worker.on("exit", () => { nativeExited = true; }); const terminate = worker.terminate.bind(worker);
        worker.terminate = () => { terminationCount++; actualTermination = terminate(); return mode === "missing-termination-receipt" ? new Promise(() => {}) : actualTermination; };
        return worker;
      },
    });
    await client.open("main"); const first = client.dispose(); assert.equal(client.dispose(), first);
    await assert.rejects(client.prompt("main", "late"), /sdk-context-(closing|disposed)/);
    if (mode === "clean") await first;
    else await assert.rejects(first, /sdk-context-shutdown-unconfirmed/);
    await actualTermination; assert.equal(nativeExited, true); assert.equal(terminationCount, 1);
    if (mode !== "clean") await assert.rejects(client.dispose(), /sdk-context-shutdown-unconfirmed/);
    assert.equal(client.dispose(), first);
    results.push({ mode, nativeExited, terminationCount, receipt: mode === "clean" ? "confirmed" : "unconfirmed", retrySamePromise: true });
  }
  console.log("SDK_SHUTDOWN_WORKER_OK", JSON.stringify(results));
} finally {
  await Promise.allSettled(workers.map((worker) => Worker.prototype.terminate.call(worker)));
  rmSync(root, { recursive: true, force: true });
}
