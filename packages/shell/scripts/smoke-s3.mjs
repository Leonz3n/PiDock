import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const profileRoot = mkdtempSync(join(tmpdir(), "pidock-s3-"));
const originFile = join(profileRoot, "fixture-origin.txt");
const electronBin = process.platform === "win32" ? "electron.cmd" : "electron";

function parseResult(stdout, phase) {
  const line = stdout
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith("PIDOCK_S3_RESULT="));
  if (!line) {
    throw new Error(`S3 ${phase} did not print PIDOCK_S3_RESULT`);
  }
  const report = JSON.parse(line.slice("PIDOCK_S3_RESULT=".length));
  if (!report || report.ok !== true || report.phase !== phase) {
    throw new Error(`S3 ${phase} failed: ${JSON.stringify(report)}`);
  }
  return report;
}

function runPhase(phase) {
  const result = spawnSync(electronBin, [".", "--", "--smoke-s3"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      PIDOCK_S3_ORIGIN_FILE: originFile,
      PIDOCK_S3_PHASE: phase,
      PIDOCK_S3_PROFILE: profileRoot,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error) {
    throw new Error(`S3 ${phase} launch failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `S3 ${phase} exited ${String(result.status)} signal=${String(result.signal)}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return parseResult(result.stdout, phase);
}

try {
  const prepare = runPhase("prepare");
  const verify = runPhase("verify");
  if (verify.checks.restartRestored !== true) {
    throw new Error("S3 verify did not restore persisted tasks");
  }
  process.stdout.write(
    `PIDOCK_S3_RESULT=${JSON.stringify({
      schema: "pidock.shell.s3-result.v1",
      ok: true,
      electron: prepare.electron,
      phases: { prepare, verify },
    })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `[shell] S3 smoke failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  rmSync(profileRoot, { recursive: true, force: true });
}
