import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, fchmodSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export const NODE_PTY_VERSION = "1.1.0";
const files = {
  helper: { name: "spawn-helper", size: 50480, sha256: "21c589109bca43e287df884f3c34ab888033a83927ea7d273949ac5030583f26" },
  addon: { name: "pty.node", size: 85496, sha256: "e6457d66f45af3facd02920a5b212164e80fe0bb758afe6e6eab1eceeba3fc9a" },
};
interface FileEvidence { path: string; dev: number; ino: number; nlink: number; mode: number; size: number; sha256: string }
export function nodePtyRepositoryRoot(): string { return fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, ""); }

/** The physical package directory the audit runs against, plus the app.asar
 * spelling of it that `require.resolve` reports inside a packed app. */
interface NodePtyLayout { directory: string; archiveDirectory?: string }

/**
 * Where the pinned package must live, chosen by the anchored layout this process
 * runs from and never by anything the payload says about itself:
 * - a packed app (`<resourcesPath>/app.asar` exists) extracts production modules
 *   flat under `app.asar.unpacked`, pinned by `asarUnpack` in
 *   packages/shell/electron-builder.config.cjs, so that the native payload is a
 *   real file on disk and not only an archive member;
 * - a dev checkout has no archive and uses the pnpm virtual store under the
 *   repository root.
 */
function nodePtyLayout(repositoryRoot: string, resourcesPath: string | undefined): NodePtyLayout {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw Error("node-pty-preflight-unavailable");
  const resources = typeof resourcesPath === "string" && isAbsolute(resourcesPath) ? resourcesPath : undefined;
  if (resources !== undefined && existsSync(join(resources, "app.asar"))) {
    return {
      directory: join(resources, "app.asar.unpacked/node_modules/node-pty"),
      archiveDirectory: join(resources, "app.asar/node_modules/node-pty"),
    };
  }
  if (!isAbsolute(repositoryRoot) || realpathSync(repositoryRoot) !== repositoryRoot) throw Error("node-pty-preflight-unavailable");
  return { directory: join(repositoryRoot, `node_modules/.pnpm/node-pty@${NODE_PTY_VERSION}/node_modules/node-pty`) };
}

/** The audited package directory of `layout`, or a refusal. Every check below is
 * a refusal boundary: a missing, symlinked, foreign or unpinned package never
 * escapes as a raw filesystem error. */
function packageDirectory(layout: NodePtyLayout): string {
  try {
    const directory = layout.directory;
    if (realpathSync(directory) !== directory) throw Error("node-pty-preflight-unavailable");
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    if (manifest.name !== "node-pty" || manifest.version !== NODE_PTY_VERSION) throw Error("node-pty-preflight-unavailable");
    // node-pty 1.1.0 lib/utils.js searches these locations relative to lib.
    // Refuse competing directories themselves, including empty/dangling entries.
    for (const relative of ["build/Release", "lib/build/Release", "build/Debug", "lib/build/Debug", "lib/prebuilds/darwin-arm64"]) {
      try { lstatSync(join(directory, relative)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw Error("node-pty-preflight-unavailable");
      }
      throw Error("node-pty-preflight-unavailable");
    }
    return directory;
  } catch { throw Error("node-pty-preflight-unavailable"); }
}
function withFile<T>(directory: string, kind: keyof typeof files, work: (fd: number, evidence: FileEvidence) => T): T {
  const expected = files[kind], path = join(directory, "prebuilds/darwin-arm64", expected.name);
  if (realpathSync(path) !== path) throw Error("node-pty-preflight-unavailable");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const inspect = (): FileEvidence => {
    const stat = fstatSync(fd), current = statSync(path), mode = stat.mode & 0o7777;
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expected.size ||
        realpathSync(path) !== path || stat.dev !== current.dev || stat.ino !== current.ino ||
        (mode !== 0o644 && !(kind === "helper" && mode === 0o755))) throw Error("node-pty-preflight-unavailable");
    const bytes = Buffer.alloc(expected.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw Error("node-pty-preflight-unavailable");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== expected.sha256) throw Error("node-pty-preflight-unavailable");
    return { path, dev: stat.dev, ino: stat.ino, nlink: stat.nlink, mode, size: stat.size, sha256 };
  };
  try {
    const before = inspect(), result = work(fd, before), after = inspect();
    if (before.dev !== after.dev || before.ino !== after.ino) throw Error("node-pty-preflight-unavailable");
    return result;
  } finally { closeSync(fd); }
}

function resolveNodePtyEntry(): string {
  return createRequire(new URL("./node-pty-worker.js", import.meta.url)).resolve("node-pty");
}

/** Read-only preflight, before native addon loading/spawn. No implicit chmod.
 * resolveEntry is the trusted package-resolution boundary for filesystem tests:
 * inside a packed app it reports the app.asar member whose extraction the
 * `asarUnpack` pin makes the audited file, so both spellings of this package's
 * entry are accepted and no other path is.
 * Later path-based loading still has a TOCTOU boundary; this is not a sandbox.
 */
export function inspectNodePtyPrebuild(repositoryRoot = nodePtyRepositoryRoot(), resolveEntry = resolveNodePtyEntry, resourcesPath = process.resourcesPath) {
  const layout = nodePtyLayout(repositoryRoot, resourcesPath), directory = packageDirectory(layout);
  const entryPath = join(directory, "lib/index.js");
  const entry = lstatSync(entryPath);
  if (!entry.isFile() || entry.nlink !== 1 || realpathSync(entryPath) !== entryPath) throw Error("node-pty-preflight-unavailable");
  const resolution = resolveEntry();
  if (resolution !== entryPath && (layout.archiveDirectory === undefined || resolution !== join(layout.archiveDirectory, "lib/index.js"))) throw Error("node-pty-preflight-unavailable");
  const addon = withFile(directory, "addon", (_fd, evidence) => evidence);
  const helper = withFile(directory, "helper", (_fd, evidence) => evidence);
  return { ready: helper.mode === 0o755, version: NODE_PTY_VERSION, entryPath, helper, addon };
}

/** Explicit manual preparation only. Tests supply an owned temporary repo layout.
 * Identity/hash checks plus same-fd chmod narrow the path race; this is not a
 * filesystem sandbox or a packaging/installed runtime ownership guarantee.
 */
export function prepareNodePtyPrebuild(repositoryRoot = nodePtyRepositoryRoot(), resolveEntry = resolveNodePtyEntry, resourcesPath = process.resourcesPath) {
  const before = inspectNodePtyPrebuild(repositoryRoot, resolveEntry, resourcesPath), directory = packageDirectory(nodePtyLayout(repositoryRoot, resourcesPath));
  withFile(directory, "helper", (fd, evidence) => {
    if (before.helper.dev !== evidence.dev || before.helper.ino !== evidence.ino) throw Error("node-pty-preflight-unavailable");
    if (evidence.mode === 0o644) fchmodSync(fd, 0o755);
  });
  const after = inspectNodePtyPrebuild(repositoryRoot, resolveEntry, resourcesPath);
  if (!after.ready || before.helper.dev !== after.helper.dev || before.helper.ino !== after.helper.ino) throw Error("node-pty-preflight-unavailable");
  return { before, after };
}
