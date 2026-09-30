import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { SupervisorLaunch } from "../host/service-supervisor-experiment.js";
import { resolvePrivateServiceRefs, type ServiceCatalog } from "./service-catalog.js";
import { resolveServiceEnv } from "./service-config.js";

export interface ExperimentalSupervisorArtifact {
  path: string; sha256: string; platform: "darwin"; arch: string;
}
function artifactPath(artifact: ExperimentalSupervisorArtifact | undefined): string {
  if (!artifact || process.platform !== "darwin" || artifact.platform !== process.platform || artifact.arch !== process.arch ||
      !isAbsolute(artifact.path) || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw Error("supervisor-artifact-unavailable");
  let fd: number | undefined;
  try {
    fd = openSync(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > 32n * 1024n * 1024n || before.size === 0n || (before.mode & 0o111n) === 0n) throw Error();
    accessSync(artifact.path, constants.X_OK);
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    if (count !== Number(before.size)) throw Error();
    const digest = createHash("sha256").update(bytes.subarray(0, count)).digest("hex");
    const after = fstatSync(fd, { bigint: true });
    const atPath = lstatSync(artifact.path, { bigint: true });
    if (digest !== artifact.sha256 || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || !atPath.isFile() || atPath.dev !== after.dev || atPath.ino !== after.ino) throw Error();
    return realpathSync(artifact.path);
  } catch { throw Error("supervisor-artifact-unavailable"); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function directoryIdentity(path: string) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.dev <= 0n || stat.ino <= 0n) throw Error("service-directory-unavailable");
  return { device: stat.dev.toString(), inode: stat.ino.toString() };
}
function programIdentity(path: string) {
  const resolved = realpathSync(path);
  const stat = lstatSync(resolved, { bigint: true });
  if (!stat.isFile()) throw Error("service-program-unavailable");
  accessSync(resolved, constants.X_OK);
  return { path: resolved, device: stat.dev.toString(), inode: stat.ino.toString(), size: stat.size.toString(), mtime: stat.mtimeNs.toString() };
}

/** Internal experiment: no IPC, execution permission, binary discovery, or production launcher. */
export function prepareServiceSupervisorExperiment(
  catalog: Pick<ServiceCatalog, "taskBindings">,
  ids: { projectId: string; taskId: string; serviceId: string },
  privateEnv: Record<string, string | undefined>, artifact?: ExperimentalSupervisorArtifact,
) {
  ids = { ...ids };
  artifact = artifact ? { ...artifact } : undefined;
  // Refuse unsupported/unavailable artifacts before reading any private references.
  const binary = artifactPath(artifact);
  const selected = catalog.taskBindings(ids.projectId, ids.taskId).find((row) => row.binding.serviceId === ids.serviceId);
  if (!selected) throw Error("service-binding-unavailable");
  const snapshot = JSON.stringify(selected);
  const { binding, template } = selected;
  const taskRoot = join(binding.identity.realRoot, binding.identity.dirId);
  const rootIdentity = directoryIdentity(taskRoot);
  if (rootIdentity.device !== binding.identity.directoryDevice || rootIdentity.inode !== binding.identity.directoryInode) throw Error("service-task-identity-changed");
  const cwd = join(taskRoot, binding.rootId, binding.subdir);
  const rel = relative(taskRoot, cwd);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw Error("service-directory-unavailable");
  for (const part of rel.split(sep).map((_, index, parts) => join(taskRoot, ...parts.slice(0, index + 1)))) directoryIdentity(part);
  if (realpathSync(cwd) !== cwd) throw Error("service-directory-unavailable");
  const cwdIdentity = directoryIdentity(cwd);
  const program = programIdentity(binding.programPath);
  const refs = resolvePrivateServiceRefs(binding.privateRefs, privateEnv);
  const resolved = resolveServiceEnv({ repoDefaults: [], shared: template.shared, privateEntries: refs, task: [] });
  if (!resolved.ok || resolved.rows.some((row) => row.value.length > 4096 || row.value.includes("\0"))) throw Error("service-environment-unavailable");
  const env = Object.fromEntries(resolved.rows.map((row) => [row.key, row.value]));
  const secrets = [...refs.map((row) => row.value), ...resolved.rows.filter((row) => row.secret).map((row) => row.value)].filter(Boolean).sort((a, b) => b.length - a.length);
  const launch: SupervisorLaunch = { taskRoot, cwd, program: program.path, args: [...template.descriptor.args], env,
    rootIdentity, cwdIdentity, graceMs: 1000 };
  let consumed = false;
  return {
    taskId: ids.taskId, serviceId: ids.serviceId, templateVersion: binding.templateVersion,
    // No serializable launch/env on the returned object. Trusted test callers
    // consume once; freshness checks are not an atomic exec/signature guarantee.
    use<T>(callback: (binary: string, request: SupervisorLaunch, redact: (line: string) => string) => T): T {
      if (consumed) throw Error("service-preparation-consumed");
      consumed = true;
      const current = catalog.taskBindings(ids.projectId, ids.taskId).find((row) => row.binding.serviceId === ids.serviceId);
      if (JSON.stringify(current) !== snapshot || artifactPath(artifact) !== binary ||
          JSON.stringify(directoryIdentity(taskRoot)) !== JSON.stringify(rootIdentity) ||
          JSON.stringify(directoryIdentity(cwd)) !== JSON.stringify(cwdIdentity) ||
          JSON.stringify(programIdentity(binding.programPath)) !== JSON.stringify(program)) throw Error("service-preparation-changed");
      return callback(binary, launch, (line) => secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), line));
    },
  };
}
