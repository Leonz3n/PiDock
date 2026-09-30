import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface ExperimentalSupervisorArtifact { path: string; sha256: string; platform: "darwin"; arch: string }
function boundedFile(path: string, max: number): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(max)) throw Error();
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    const after = fstatSync(fd, { bigint: true });
    const atPath = lstatSync(path, { bigint: true });
    if (count !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || !atPath.isFile() || atPath.dev !== after.dev || atPath.ino !== after.ino) throw Error();
    return bytes.subarray(0, count);
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function experimentalArtifactPath(artifact: ExperimentalSupervisorArtifact | undefined): string {
  if (!artifact || process.platform !== "darwin" || artifact.platform !== process.platform || artifact.arch !== process.arch ||
      !isAbsolute(artifact.path) || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw Error("supervisor-artifact-unavailable");
  try {
    const bytes = boundedFile(artifact.path, 32 * 1024 * 1024);
    const stat = lstatSync(artifact.path);
    if ((stat.mode & 0o111) === 0 || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw Error();
    accessSync(artifact.path, constants.X_OK);
    return realpathSync(artifact.path);
  } catch { throw Error("supervisor-artifact-unavailable"); }
}

export interface DevelopmentSupervisorManifest {
  schemaVersion: 1; kind: "development-unsigned"; protocolVersion: 1;
  platform: "darwin" | "win32"; arch: "arm64" | "x64"; file: string;
  sha256: string; sourceSha256: string; goVersion: string;
}
export type DevelopmentSupervisorAvailability =
  | { state: "available-for-experiment"; manifest: DevelopmentSupervisorManifest; artifact: ExperimentalSupervisorArtifact }
  | { state: "unavailable"; reason: "invalid-development-artifact" | "unsupported-runtime-platform" };

/** Explicit development directory only. Not packaged discovery or signature verification. */
export function inspectDevelopmentSupervisor(directory: string): DevelopmentSupervisorAvailability {
  try {
    if (!isAbsolute(directory) || !lstatSync(directory).isDirectory()) throw Error();
    const value: unknown = JSON.parse(boundedFile(join(directory, "manifest.json"), 4096).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
    const row = value as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "arch,file,goVersion,kind,platform,protocolVersion,schemaVersion,sha256,sourceSha256" ||
        row["schemaVersion"] !== 1 || row["protocolVersion"] !== 1 || row["kind"] !== "development-unsigned" ||
        !((row["platform"] === "darwin" && row["arch"] === "arm64" && row["file"] === "service-supervisor") ||
          (row["platform"] === "win32" && row["arch"] === "x64" && row["file"] === "service-supervisor.exe")) ||
        typeof row["sha256"] !== "string" || !/^[a-f0-9]{64}$/.test(row["sha256"]) ||
        typeof row["sourceSha256"] !== "string" || !/^[a-f0-9]{64}$/.test(row["sourceSha256"]) ||
        typeof row["goVersion"] !== "string" || row["goVersion"].length > 200 || !/^go version go[\w.]+ [\w]+\/[\w]+$/.test(row["goVersion"])) throw Error();
    const manifest = row as unknown as DevelopmentSupervisorManifest;
    const binary = join(directory, manifest.file);
    const bytes = boundedFile(binary, 32 * 1024 * 1024);
    if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) throw Error();
    if (manifest.platform === "darwin") {
      if (bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c) throw Error();
    } else {
      const pe = bytes.readUInt32LE(0x3c);
      if (bytes.toString("ascii", 0, 2) !== "MZ" || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664) throw Error();
    }
    if (manifest.platform !== process.platform || manifest.arch !== process.arch || process.platform !== "darwin") {
      return { state: "unavailable", reason: "unsupported-runtime-platform" };
    }
    const artifact: ExperimentalSupervisorArtifact = { path: binary, sha256: manifest.sha256, platform: "darwin", arch: manifest.arch };
    experimentalArtifactPath(artifact);
    return { state: "available-for-experiment", manifest, artifact };
  } catch { return { state: "unavailable", reason: "invalid-development-artifact" }; }
}
