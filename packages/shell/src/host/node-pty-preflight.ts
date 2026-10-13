import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, fchmodSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { release } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export const NODE_PTY_VERSION = "1.1.0";

/** The lowest Windows build that ships ConPTY (`10.0.18309`). */
const WINDOWS_CONPTY_MINIMUM_BUILD = 18309;

/** One pinned payload file, spelled relative to the audited package directory. */
interface PinnedPayload { relative: string; size: number; sha256: string }
/** `helper`/`addon` are the darwin prebuilds; `addon`/`worker` the win32 ConPTY pair. */
type PayloadKind = "helper" | "addon" | "worker";

/**
 * What one `${platform}-${arch}` may load, and how that identity is proven.
 *
 * `openFlags` is a measurement, not a preference: on win32
 * `fs.constants.O_NOFOLLOW` is `undefined`, so `O_RDONLY | O_NOFOLLOW` silently
 * evaluates to `0` - the same value as bare `O_RDONLY` there - and would read as
 * symlink protection while providing none. win32 therefore opens with
 * `O_RDONLY` alone and claims strictly less than darwin, which keeps
 * `O_RDONLY | O_NOFOLLOW`.
 *
 * `modeAudit` records the second measurement: on win32 `fchmodSync` succeeds
 * silently while `mode & 0o7777` stays `0o666` (`0o444` for the addon), so a
 * `mode === 0o644` check is unreachable there and POSIX bits can never prove
 * identity or readiness. darwin readiness is the audited helper's `0o755`; win32
 * readiness is exactly "the bytes of every file listed below verified", i.e.
 * existence + size + sha256.
 */
interface PlatformPin {
  /** node-pty 1.1.0 `lib/utils.js` searches `build/Release`, `build/Debug` and
   * `prebuilds/<platform>-<arch>` before its own prebuilds; each present one is a
   * competing native source and refuses the whole package. */
  competingLoaderDirectories: string[];
  openFlags: number;
  modeAudit: boolean;
  files: Partial<Record<PayloadKind, PinnedPayload>>;
}

/** The admitted platforms, keyed by `${process.platform}-${process.arch}`. A pin
 * record is the only thing that opens native bytes, so nothing the payload says
 * about itself can talk it into being audited. */
const pins: Record<string, PlatformPin> = {
  "darwin-arm64": {
    competingLoaderDirectories: ["build/Release", "lib/build/Release", "build/Debug", "lib/build/Debug", "lib/prebuilds/darwin-arm64"],
    openFlags: constants.O_RDONLY | constants.O_NOFOLLOW,
    modeAudit: true,
    files: {
      addon: { relative: "prebuilds/darwin-arm64/pty.node", size: 85496, sha256: "e6457d66f45af3facd02920a5b212164e80fe0bb758afe6e6eab1eceeba3fc9a" },
      helper: { relative: "prebuilds/darwin-arm64/spawn-helper", size: 50480, sha256: "21c589109bca43e287df884f3c34ab888033a83927ea7d273949ac5030583f26" },
    },
  },
  "win32-x64": {
    competingLoaderDirectories: ["build/Release", "lib/build/Release", "build/Debug", "lib/build/Debug", "lib/prebuilds/win32-x64"],
    // `O_RDONLY` alone - see PlatformPin.openFlags for why O_NOFOLLOW is not added.
    openFlags: constants.O_RDONLY,
    modeAudit: false,
    files: {
      // The ConPTY pair only. `prebuilds/win32-x64/pty.node`, `winpty.dll`,
      // `winpty-agent.exe` and `conpty_console_list.node` are deliberately absent
      // and unreachable by construction: the audit only opens the relative paths
      // named here, so the unpinned winpty fallback is never read by it.
      addon: { relative: "prebuilds/win32-x64/conpty.node", size: 312320, sha256: "ee8f4e6f4dad71939eecfda11de249400e34bfefe4c8b48af13f3b5476f4035b" },
      // Required, not a nicety: node-pty's conout socket worker. Its absence is a
      // measured silent hang of the terminal rather than an error, so only its
      // pinned bytes prove the packaged terminal can come up. It is a real file on
      // disk in a packed app because `asarUnpack` in
      // packages/shell/electron-builder.config.cjs unpacks the whole package.
      worker: { relative: "lib/worker/conoutSocketWorker.js", size: 848, sha256: "3e4bac095ac3870c3248a7302f5d10217de625f30c32b7000fe48a34788e47ac" },
    },
  },
};

interface FileEvidence { path: string; dev: number; ino: number; nlink: number; mode: number; size: number; sha256: string }
export function nodePtyRepositoryRoot(): string {
  // Both separators, then normalize: a lone `.replace(/\/$/, "")` left a trailing
  // `\` on Windows, and `realpathSync(root) !== root` then refused the dev layout
  // even with the gate open. darwin returns the same string as before.
  return normalize(fileURLToPath(new URL("../../../../", import.meta.url)).replace(/[\\/]+$/, ""));
}

/** The one spelling of "is this platform/arch admitted by the pin record": the
 * pin record is the admission list, so every platform gate asks it here rather
 * than repeating a platform list. Same meaning as `platformPin` (which throws). */
export function nodePtyPlatformAdmitted(): boolean {
  return pins[`${process.platform}-${process.arch}`] !== undefined;
}

function platformPin(): PlatformPin {
  const pin = pins[`${process.platform}-${process.arch}`];
  if (pin === undefined) throw Error("node-pty-preflight-unavailable");
  return pin;
}

/** `os.release()` on Windows is `10.0.<build>`; anything unparseable refuses. */
function windowsBuildNumber(): number { return Number.parseInt(release().split(".")[2] ?? "", 10); }

/** The win32 build gate. The pinned win32 payload covers the ConPTY path only,
 * and `useConpty: true` is no defence: node-pty 1.1.0
 * `lib/windowsPtyAgent.js:37-38` re-derives ConPTY availability from the OS build
 * and ignores the request, so on an older build the terminal would silently load
 * the unpinned winpty fallback whose native bytes nothing here pins. */
function requireWindowsConptyBuild(windowsBuild: number): void {
  if (!Number.isInteger(windowsBuild) || windowsBuild < WINDOWS_CONPTY_MINIMUM_BUILD) throw Error("node-pty-preflight-unavailable");
}

/** The physical package directory the audit runs against, plus the app.asar
 * spellings of its entry that `require.resolve` can report inside a packed app. */
interface NodePtyLayout { pin: PlatformPin; directory: string; archiveDirectories?: string[] }

/**
 * Where the pinned package must live, chosen by the anchored layout this process
 * runs from and never by anything the payload says about itself:
 * - a packed app (`<resourcesPath>/app.asar` exists) extracts production modules
 *   flat under `app.asar.unpacked`, pinned by `asarUnpack` in
 *   packages/shell/electron-builder.config.cjs, so that the native payload is a
 *   real file on disk and not only an archive member;
 * - a dev checkout has no archive and uses the pnpm virtual store under the
 *   repository root.
 *
 * The app prefix is canonicalized here and the payload deliberately is not. The
 * prefix only says *where this process runs from*: a bundle reached through a
 * symlinked directory is a legitimate app (macOS `/var/folders/...` is
 * `/private/var`), so a symlinked prefix must not disable the terminal the
 * preflight exists to enable. The payload is what the audit claims identity for,
 * so canonicalizing it would defeat the audit: a symlinked package directory,
 * entry or prebuild file could point the pinned size/sha256/mode checks at bytes
 * nobody pinned, which is why `packageDirectory`/`withFile` keep requiring
 * `realpathSync(x) === x`. Both archive spellings are accepted because the
 * resolver inside the app reports whichever prefix the archive was loaded
 * through; they name one member of one archive, and no other path is accepted.
 *
 * The first statement is the platform gate: an unadmitted platform refuses with
 * exactly `node-pty-preflight-unavailable` before any payload is inspected.
 * `windowsBuild` is the test seam for the win32 ConPTY gate; production callers
 * never pass it and it comes from `os.release()`.
 */
function nodePtyLayout(repositoryRoot: string, resourcesPath: string | undefined, windowsBuild: number): NodePtyLayout {
  const pin = platformPin();
  if (process.platform === "win32") requireWindowsConptyBuild(windowsBuild);
  const resources = typeof resourcesPath === "string" && isAbsolute(resourcesPath) ? resourcesPath : undefined;
  if (resources !== undefined && existsSync(join(resources, "app.asar"))) {
    const anchor = realpathSync(resources);
    return {
      pin,
      directory: join(anchor, "app.asar.unpacked/node_modules/node-pty"),
      archiveDirectories: [...new Set([
        join(resources, "app.asar/node_modules/node-pty"),
        join(anchor, "app.asar/node_modules/node-pty"),
      ])],
    };
  }
  if (!isAbsolute(repositoryRoot) || realpathSync(repositoryRoot) !== repositoryRoot) throw Error("node-pty-preflight-unavailable");
  return { pin, directory: join(repositoryRoot, `node_modules/.pnpm/node-pty@${NODE_PTY_VERSION}/node_modules/node-pty`) };
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
    for (const relative of layout.pin.competingLoaderDirectories) {
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
function withFile<T>(directory: string, pin: PlatformPin, kind: PayloadKind, work: (fd: number, evidence: FileEvidence) => T): T {
  const expected = pin.files[kind];
  if (expected === undefined) throw Error("node-pty-preflight-unavailable");
  try {
    const path = join(directory, expected.relative);
    if (realpathSync(path) !== path) throw Error("node-pty-preflight-unavailable");
    const fd = openSync(path, pin.openFlags);
    const inspect = (): FileEvidence => {
      const stat = fstatSync(fd), current = statSync(path), mode = stat.mode & 0o7777;
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expected.size ||
          realpathSync(path) !== path || stat.dev !== current.dev || stat.ino !== current.ino ||
          (pin.modeAudit && mode !== 0o644 && !(kind === "helper" && mode === 0o755))) throw Error("node-pty-preflight-unavailable");
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
  // A missing or unreadable payload file is a refusal, not a raw ENOENT/EACCES:
  // the audit is a refusal boundary on every platform it admits.
  catch { throw Error("node-pty-preflight-unavailable"); }
}

function resolveNodePtyEntry(): string {
  return createRequire(new URL("./node-pty-worker.js", import.meta.url)).resolve("node-pty");
}

/** Read-only preflight, before native addon loading/spawn. No implicit chmod.
 * resolveEntry is the trusted package-resolution boundary for filesystem tests:
 * inside a packed app it reports the app.asar member whose extraction the
 * `asarUnpack` pin makes the audited file, so the unpacked path and the
 * app.asar spelling of this entry (under either prefix that names the app) are
 * accepted and no other path is.
 * Later path-based loading still has a TOCTOU boundary; this is not a sandbox.
 */
export function inspectNodePtyPrebuild(repositoryRoot = nodePtyRepositoryRoot(), resolveEntry = resolveNodePtyEntry, resourcesPath = process.resourcesPath, windowsBuild = windowsBuildNumber()) {
  const layout = nodePtyLayout(repositoryRoot, resourcesPath, windowsBuild), directory = packageDirectory(layout), pin = layout.pin;
  const entryPath = join(directory, "lib/index.js");
  const entry = lstatSync(entryPath);
  if (!entry.isFile() || entry.nlink !== 1 || realpathSync(entryPath) !== entryPath) throw Error("node-pty-preflight-unavailable");
  const resolution = resolveEntry();
  const archiveEntryPaths = (layout.archiveDirectories ?? []).map((archive) => join(archive, "lib/index.js"));
  if (resolution !== entryPath && !archiveEntryPaths.includes(resolution)) throw Error("node-pty-preflight-unavailable");
  const payloads: Partial<Record<PayloadKind, FileEvidence>> = {};
  for (const kind of Object.keys(pin.files) as PayloadKind[]) payloads[kind] = withFile(directory, pin, kind, (_fd, evidence) => evidence);
  const helper = payloads.helper;
  // darwin readiness is the helper's audited POSIX mode; win32 has no usable mode
  // bits, so there it is exactly "every pinned payload file verified".
  const ready = pin.modeAudit ? helper !== undefined && helper.mode === 0o755 : true;
  return { ready, version: NODE_PTY_VERSION, entryPath, helper, addon: payloads.addon, worker: payloads.worker };
}

/** Explicit manual preparation only. Tests supply an owned temporary repo layout.
 * Identity/hash checks plus same-fd chmod narrow the path race; this is not a
 * filesystem sandbox or a packaging/installed runtime ownership guarantee.
 */
export function prepareNodePtyPrebuild(repositoryRoot = nodePtyRepositoryRoot(), resolveEntry = resolveNodePtyEntry, resourcesPath = process.resourcesPath, windowsBuild = windowsBuildNumber()) {
  const before = inspectNodePtyPrebuild(repositoryRoot, resolveEntry, resourcesPath, windowsBuild);
  const layout = nodePtyLayout(repositoryRoot, resourcesPath, windowsBuild), pin = layout.pin, directory = packageDirectory(layout);
  const helper = before.helper;
  if (pin.modeAudit && helper !== undefined) {
    withFile(directory, pin, "helper", (fd, evidence) => {
      if (helper.dev !== evidence.dev || helper.ino !== evidence.ino) throw Error("node-pty-preflight-unavailable");
      if (evidence.mode === 0o644) fchmodSync(fd, 0o755);
    });
  }
  const after = inspectNodePtyPrebuild(repositoryRoot, resolveEntry, resourcesPath, windowsBuild);
  if (!after.ready || before.helper?.dev !== after.helper?.dev || before.helper?.ino !== after.helper?.ino) throw Error("node-pty-preflight-unavailable");
  return { before, after };
}
