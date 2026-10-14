import { expect, it, beforeEach, afterEach, vi } from "vitest";
import { copyFileSync, chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectNodePtyPrebuild, prepareNodePtyPrebuild } from "./node-pty-preflight.js";

const actualDarwinArm64 = process.platform === "darwin" && process.arch === "arm64";
// Only actual POSIX mode/fchmod and link-identity checks use this platform gate.
const posixIt = it.skipIf(!actualDarwinArm64);
beforeEach(() => { vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64" }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** node-pty 1.1.0's darwin-arm64 prebuilds, copied at the real pinned bytes with
 * their mode cleared, so a case can measure readiness as the audited `0o644`. */
function writeDarwinPayload(path: string) {
  const installed = fileURLToPath(new URL("../../node_modules/node-pty/", import.meta.url));
  mkdirSync(join(path, "prebuilds/darwin-arm64"), { recursive: true });
  const helper = join(path, "prebuilds/darwin-arm64/spawn-helper"), addon = join(path, "prebuilds/darwin-arm64/pty.node");
  copyFileSync(join(installed, "prebuilds/darwin-arm64/spawn-helper"), helper);
  copyFileSync(join(installed, "prebuilds/darwin-arm64/pty.node"), addon);
  chmodSync(helper, 0o644); chmodSync(addon, 0o644);
  return { helper, addon };
}

/** The win32-x64 ConPTY pair. `conoutSocketWorker.js` is part of the win32 pin, so
 * the fixture always writes it and the cases remove or damage it explicitly. */
function writeWin32Payload(path: string) {
  const installed = fileURLToPath(new URL("../../node_modules/node-pty/", import.meta.url));
  mkdirSync(join(path, "prebuilds/win32-x64"), { recursive: true });
  mkdirSync(join(path, "lib/worker"), { recursive: true });
  const addon = join(path, "prebuilds/win32-x64/conpty.node"), worker = join(path, "lib/worker/conoutSocketWorker.js");
  copyFileSync(join(installed, "prebuilds/win32-x64/conpty.node"), addon);
  copyFileSync(join(installed, "lib/worker/conoutSocketWorker.js"), worker);
  return { addon, worker };
}

/** `dev` is the pnpm virtual store under a repository root; `packed` is the flat
 * production layout a packed app extracts under `app.asar.unpacked`, with the
 * archive that requires it present next to it. The payload is written separately
 * because the pin that audits it differs per platform while the layout does not. */
function layoutRoot(layout: "dev" | "packed") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pidock-pty-preflight-")));
  const resources = join(root, "PiDock.app/Contents/Resources");
  const path = layout === "packed"
    ? join(resources, "app.asar.unpacked/node_modules/node-pty")
    : join(root, "node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty");
  mkdirSync(join(path, "lib"), { recursive: true });
  if (layout === "packed") writeFileSync(join(resources, "app.asar"), "packed-applications-archive\n");
  const entryPath = join(path, "lib/index.js");
  writeFileSync(entryPath, "// Never imported by filesystem tests.\n");
  writeFileSync(join(path, "package.json"), '{"name":"node-pty","version":"1.1.0"}');
  return {
    root, path, entryPath,
    resources: layout === "packed" ? resources : undefined,
    archiveEntryPath: join(resources, "app.asar/node_modules/node-pty/lib/index.js"),
  };
}

function fixture(layout: "dev" | "packed" = "dev") {
  const { root, path, entryPath, resources, archiveEntryPath } = layoutRoot(layout);
  const { helper, addon } = writeDarwinPayload(path);
  return {
    root, path, helper, addon, entryPath, resources, archiveEntryPath,
    resolveEntry: () => entryPath,
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** The payload files `hostFixture` wrote, by the pin's own payload kind. The two
 * pins pin different kinds, so the record is partial by construction. */
interface HostPayload { helper?: string; addon?: string; worker?: string }

/** The same layouts as `fixture()`, carrying the payload of the pin this host
 * really admits (`hostPin`). A layout or payload case uses it because the darwin
 * pin's `0o644` mode audit cannot be satisfied on a win32 filesystem:
 * `chmodSync` only clears the read-only attribute, so the audit there reads
 * `0o666` and refuses a darwin-shaped payload. Which directory and which entry
 * spellings resolve, and which changed bytes are refused, are the same
 * propositions under either pin. */
function hostFixture(layout: "dev" | "packed" = "dev") {
  const { root, path, entryPath, resources, archiveEntryPath } = layoutRoot(layout);
  const payloads: HostPayload = hostPin === "win32-x64" ? writeWin32Payload(path) : writeDarwinPayload(path);
  return {
    root, path, entryPath, resources, archiveEntryPath, payloads,
    resolveEntry: () => entryPath,
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** The measured Windows build of this host and the last build before ConPTY. */
const WINDOWS_BUILD = 26200, LEGACY_WINDOWS_BUILD = 18308;

/** The refusal is one exact string everywhere; a substring match would still
 * accept a renamed one, so the win32 cases compare the message itself. */
function expectNodePtyRefusal(run: () => unknown): void {
  try { run(); }
  catch (error) { expect((error as Error).message).toBe("node-pty-preflight-unavailable"); return; }
  throw Error("expected a node-pty-preflight-unavailable refusal");
}

function stubWin32(): void { vi.stubGlobal("process", { ...process, platform: "win32", arch: "x64" }); }

/** The pin this host really admits, keyed exactly as `pins` in
 * node-pty-preflight.ts. */
const hostPin: "darwin-arm64" | "win32-x64" = process.platform === "win32" ? "win32-x64" : "darwin-arm64";

/** The win32 pin sits behind the ConPTY build gate and the darwin pin reads no
 * build at all, so only a win32 host passes the measured build; `undefined`
 * leaves production's `os.release()` seam in place. */
const hostPinWindowsBuild = hostPin === "win32-x64" ? WINDOWS_BUILD : undefined;

/** `beforeEach` already stubs the darwin pin, so only a win32 host restubs - and
 * it must, or the fixture payload and the audited pin would be different
 * records. */
function stubHostPin(): void { if (hostPin === "win32-x64") stubWin32(); }

/** The payload kinds the two pins name, spelled as `pins` in
 * node-pty-preflight.ts spells them. */
type HostPayloadKind = "helper" | "addon" | "worker";

/** The kinds `hostPin` pins: darwin pins `spawn-helper` + `pty.node`, win32 the
 * ConPTY `conpty.node` + `conoutSocketWorker.js`. A payload case takes these, so
 * it changes the bytes of a file the pin this host audits really names. */
const hostPayloadKinds: HostPayloadKind[] = hostPin === "win32-x64" ? ["addon", "worker"] : ["helper", "addon"];

/** The pinned file `hostFixture` wrote for `kind`. */
function hostPayloadFile(fixture: ReturnType<typeof hostFixture>, kind: HostPayloadKind): string {
  const file = fixture.payloads[kind];
  if (file === undefined) throw Error(`host pin ${hostPin} pins no ${kind} payload`);
  return file;
}

/** The mode half of a changed-bytes case: refusing must not grant execution
 * permission, i.e. the audited helper's POSIX mode is exactly what the fixture
 * left. Only darwin audits a mode; win32 pins no helper and a win32 file carries
 * no observable POSIX mode at all (`chmodSync` only clears the read-only
 * attribute, so the audit reads `0o666`). That half is #57's mode-bit class:
 * named here and reported on #56 as "unobserved on win32", never a pass. */
function expectAuditedModeUnchanged(helper: string | undefined, before: number | undefined): void {
  if (helper === undefined || before === undefined) return;
  expect(statSync(helper).mode & 0o7777).toBe(before);
}

/** A win32-x64 dev layout. */
function fixtureWin32() {
  const { root, path, entryPath } = layoutRoot("dev");
  const { addon, worker } = writeWin32Payload(path);
  return { root, addon, worker, entryPath, resolveEntry: () => entryPath, clean: () => rmSync(root, { recursive: true, force: true }) };
}

posixIt("Darwin arm64 POSIX modes: refuses a competing release addon before granting audited helper execution permission", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.path, "build/Release"), { recursive: true });
    copyFileSync(f.addon, join(f.path, "build/Release/pty.node"));
    expect(() => prepareNodePtyPrebuild(f.root, f.resolveEntry)).toThrow("node-pty-preflight-unavailable");
    expect(statSync(f.helper).mode & 0o7777).toBe(0o644);
  } finally { f.clean(); }
});

posixIt("Darwin arm64 POSIX modes: reports the pinned non-executable helper unready without mutating or loading native code", () => {
  const f = fixture();
  try {
    expect(inspectNodePtyPrebuild(f.root, f.resolveEntry)).toMatchObject({ ready: false, entryPath: f.entryPath });
    expect(statSync(f.helper).mode & 0o7777).toBe(0o644);
  } finally { f.clean(); }
});

posixIt("Darwin arm64 POSIX fchmod: explicitly prepares only the audited helper and is idempotent without changing binary bytes", () => {
  const f = fixture();
  try {
    const helper = readFileSync(f.helper), addon = readFileSync(f.addon), before = statSync(f.helper);
    const result = prepareNodePtyPrebuild(f.root, f.resolveEntry);
    expect(result.before.ready).toBe(false); expect(result.after.ready).toBe(true);
    expect(statSync(f.helper).mode & 0o7777).toBe(0o755);
    expect(statSync(f.helper).ino).toBe(before.ino);
    expect(readFileSync(f.helper)).toEqual(helper); expect(readFileSync(f.addon)).toEqual(addon);
    expect(statSync(f.addon).mode & 0o7777).toBe(0o644);
    expect(prepareNodePtyPrebuild(f.root, f.resolveEntry).before.ready).toBe(true);
  } finally { f.clean(); }
});

it.each(hostPayloadKinds)("refuses changed %s bytes before granting execution permission", (kind) => {
  stubHostPin();
  const f = hostFixture();
  try {
    const helper = f.payloads.helper, before = helper === undefined ? undefined : statSync(helper).mode & 0o7777;
    const path = hostPayloadFile(f, kind), bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
    expect(() => prepareNodePtyPrebuild(f.root, f.resolveEntry, undefined, hostPinWindowsBuild)).toThrow("node-pty-preflight-unavailable");
    expectAuditedModeUnchanged(helper, before);
  } finally { f.clean(); }
});

posixIt.each(["symlink", "hardlink", "unexpected-mode"])("refuses %s without mutating an unaudited resource", (condition) => {
  const f = fixture();
  try {
    if (condition === "symlink") {
      const outside = join(f.root, "outside-helper"); copyFileSync(f.helper, outside); rmSync(f.helper); symlinkSync(outside, f.helper);
    } else if (condition === "hardlink") linkSync(f.helper, join(f.root, "shared-helper"));
    else if (condition === "unexpected-mode") chmodSync(f.helper, 0o600);
    const before = statSync(f.helper).mode & 0o7777;
    expect(() => prepareNodePtyPrebuild(f.root, f.resolveEntry)).toThrow("node-pty-preflight-unavailable");
    expect(statSync(f.helper).mode & 0o7777).toBe(before);
  } finally { f.clean(); }
});

it("refuses package resolution to another installed entry before native loading", () => {
  const f = fixture();
  try {
    expect(() => inspectNodePtyPrebuild(f.root, () => join(f.root, "other/lib/index.js"))).toThrow("node-pty-preflight-unavailable");
  } finally { f.clean(); }
});

it.each([
  "build/Release/pty.node", "lib/build/Release/pty.node",
  "build/Debug/pty.node", "lib/build/Debug/pty.node",
  "lib/prebuilds/darwin-arm64/pty.node",
  "build/Release/spawn-helper", "lib/build/Release/spawn-helper",
  "build/Debug/spawn-helper", "lib/build/Debug/spawn-helper",
  "lib/prebuilds/darwin-arm64/spawn-helper",
])("refuses competing native loader resource %s before audited binary inspection", (relative) => {
  const f = fixture();
  try {
    const competitor = join(f.path, relative);
    mkdirSync(dirname(competitor), { recursive: true }); writeFileSync(competitor, "untrusted-native-candidate");
    expect(() => inspectNodePtyPrebuild(f.root, f.resolveEntry)).toThrow("node-pty-preflight-unavailable");
  } finally { f.clean(); }
});

it.each(["file", "directory"])("refuses competing loader directory occupied by %s", (kind) => {
  const f = fixture();
  try {
    const competitor = join(f.path, "build/Release"); mkdirSync(dirname(competitor));
    if (kind === "file") writeFileSync(competitor, "untrusted");
    else mkdirSync(competitor);
    expect(() => inspectNodePtyPrebuild(f.root, f.resolveEntry)).toThrow("node-pty-preflight-unavailable");
  } finally { f.clean(); }
});

it("refuses a wrong pinned package version without needing native files", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.path, "package.json"), '{"name":"node-pty","version":"1.0.0"}');
    expect(() => inspectNodePtyPrebuild(f.root, f.resolveEntry)).toThrow("node-pty-preflight-unavailable");
  } finally { f.clean(); }
});

it.each([["win32", "arm64"], ["linux", "x64"], ["darwin", "x64"]] as const)("refuses unsupported %s-%s before resolving a package or touching native files", (platform, arch) => {
  vi.stubGlobal("process", { ...process, platform, arch });
  const resolveEntry = vi.fn(() => "never-resolved");
  expectNodePtyRefusal(() => inspectNodePtyPrebuild(join(tmpdir(), "unused-pty-repo"), resolveEntry, undefined, WINDOWS_BUILD));
  expect(resolveEntry).not.toHaveBeenCalled();
});


posixIt("Darwin arm64 symlinks: refuses a dangling competing loader directory", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.path, "build"));
    symlinkSync(join(f.root, "missing"), join(f.path, "build/Release"));
    expect(() => inspectNodePtyPrebuild(f.root, f.resolveEntry)).toThrow("node-pty-preflight-unavailable");
  } finally { f.clean(); }
});

it("refuses a non-directory loader parent rather than treating ENOTDIR as absence", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.path, "build"), "untrusted-parent");
    expect(() => inspectNodePtyPrebuild(f.root, f.resolveEntry)).toThrow("node-pty-preflight-unavailable");
  } finally { f.clean(); }
});

it("refuses a directory at the fixed package entry", () => {
  const f = fixture();
  try {
    rmSync(f.entryPath); mkdirSync(f.entryPath);
    expect(() => inspectNodePtyPrebuild(f.root, f.resolveEntry)).toThrow("node-pty-preflight-unavailable");
  } finally { f.clean(); }
});

posixIt("Darwin arm64 symlinks: refuses an entry redirected outside the pinned package", () => {
  const f = fixture();
  try {
    const outside = join(f.root, "other-index.js"); writeFileSync(outside, "// Must not load.\n");
    rmSync(f.entryPath); symlinkSync(outside, f.entryPath);
    expect(() => inspectNodePtyPrebuild(f.root, f.resolveEntry)).toThrow("node-pty-preflight-unavailable");
  } finally { f.clean(); }
});

it("resolves the flat packaged package under app.asar.unpacked and accepts the app.asar spelling of its pinned entry", () => {
  stubHostPin();
  const f = hostFixture("packed");
  try {
    // require.resolve reports the archive member; asarUnpack pins that member's
    // extraction to the unpacked file the audit below really reads.
    expect(inspectNodePtyPrebuild(f.root, () => f.archiveEntryPath, f.resources, hostPinWindowsBuild)).toMatchObject({ entryPath: f.entryPath });
    // The unpacked spelling names the same audited file and is accepted too.
    expect(inspectNodePtyPrebuild(f.root, () => f.entryPath, f.resources, hostPinWindowsBuild).entryPath).toBe(f.entryPath);
  } finally { f.clean(); }
});

it("keeps the pnpm virtual-store layout when the resources root holds no archive", () => {
  stubHostPin();
  const f = hostFixture();
  try {
    // A dev Electron has a `process.resourcesPath` but no app.asar: the packaged
    // candidate must not hijack the dev layout.
    const resources = join(f.root, "Electron.app/Contents/Resources");
    mkdirSync(resources, { recursive: true });
    expect(inspectNodePtyPrebuild(f.root, f.resolveEntry, resources, hostPinWindowsBuild).entryPath).toBe(f.entryPath);
  } finally { f.clean(); }
});

it("refuses a packed app that has an archive but no extracted package", () => {
  const f = fixture("packed");
  try {
    rmSync(join(f.resources!, "app.asar.unpacked"), { recursive: true, force: true });
    expect(() => inspectNodePtyPrebuild(f.root, () => f.archiveEntryPath, f.resources)).toThrow("node-pty-preflight-unavailable");
  } finally { f.clean(); }
});

it("refuses a packaged package resolution to an entry outside the packaged package", () => {
  const f = fixture("packed");
  try {
    expect(() => inspectNodePtyPrebuild(f.root, () => join(f.root, "other/lib/index.js"), f.resources)).toThrow("node-pty-preflight-unavailable");
  } finally { f.clean(); }
});

it("refuses a competing loader directory inside the packaged package", () => {
  stubHostPin();
  const f = hostFixture("packed");
  try {
    // Positive control: only the competitor is added between the two calls.
    expect(inspectNodePtyPrebuild(f.root, f.resolveEntry, f.resources, hostPinWindowsBuild).entryPath).toBe(f.entryPath);
    mkdirSync(join(f.path, "build/Release"), { recursive: true });
    writeFileSync(join(f.path, "build/Release/pty.node"), "untrusted-native-candidate");
    expect(() => inspectNodePtyPrebuild(f.root, f.resolveEntry, f.resources, hostPinWindowsBuild)).toThrow("node-pty-preflight-unavailable");
  } finally { f.clean(); }
});

it.each(hostPayloadKinds)("refuses changed %s bytes inside the packaged package", (kind) => {
  stubHostPin();
  const f = hostFixture("packed");
  try {
    const path = hostPayloadFile(f, kind), bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
    expect(() => inspectNodePtyPrebuild(f.root, () => f.archiveEntryPath, f.resources, hostPinWindowsBuild)).toThrow("node-pty-preflight-unavailable");
  } finally { f.clean(); }
});

posixIt("Darwin arm64 POSIX modes: reports the pinned packaged helper unready and prepares only it", () => {
  const f = fixture("packed");
  try {
    const helper = readFileSync(f.helper), addon = readFileSync(f.addon);
    const result = prepareNodePtyPrebuild(f.root, () => f.archiveEntryPath, f.resources);
    expect(result.before.ready).toBe(false); expect(result.after.ready).toBe(true);
    expect(statSync(f.helper).mode & 0o7777).toBe(0o755);
    expect(statSync(f.addon).mode & 0o7777).toBe(0o644);
    expect(readFileSync(f.helper)).toEqual(helper); expect(readFileSync(f.addon)).toEqual(addon);
  } finally { f.clean(); }
});

posixIt.each(["unpinned-mode", "symlink"] as const)("refuses the packaged helper as %s without mutating an unaudited resource", (condition) => {
  const f = fixture("packed");
  try {
    if (condition === "symlink") {
      const outside = join(f.root, "outside-helper"); copyFileSync(f.helper, outside); rmSync(f.helper); symlinkSync(outside, f.helper);
    } else chmodSync(f.helper, 0o600);
    const before = statSync(f.helper).mode & 0o7777;
    expect(() => prepareNodePtyPrebuild(f.root, () => f.archiveEntryPath, f.resources)).toThrow("node-pty-preflight-unavailable");
    expect(statSync(f.helper).mode & 0o7777).toBe(before);
  } finally { f.clean(); }
});

posixIt("Darwin arm64 symlinks: audits a packed app whose resources prefix is a symlink", () => {
  const f = fixture("packed");
  try {
    // Only the app prefix is symlinked (/var/folders/... -> /private/var on
    // macOS, or any bundle reached through a symlinked directory); the payload
    // behind it is a real directory with the pinned bytes.
    symlinkSync(f.root, join(f.root, "through-symlink"));
    const resources = join(f.root, "through-symlink/PiDock.app/Contents/Resources");
    expect(realpathSync(resources)).not.toBe(resources);
    chmodSync(f.helper, 0o755);
    // Both spellings of the archive member are the one audited file, so both are
    // accepted: a packed app's resolver reports whichever prefix the archive was
    // loaded through. A symlinked prefix must not re-create the refusal this
    // layout was added to remove.
    for (const entry of [f.archiveEntryPath, join(resources, "app.asar/node_modules/node-pty/lib/index.js")]) {
      expect(inspectNodePtyPrebuild(f.root, () => entry, resources)).toMatchObject({ ready: true, entryPath: f.entryPath });
    }
  } finally { f.clean(); }
});

posixIt("Darwin arm64 symlinks: still refuses a symlinked payload directory under a resolved app prefix", () => {
  const f = fixture("packed");
  try {
    chmodSync(f.helper, 0o755);
    // Positive control: only the payload's path identity changes between the calls.
    expect(inspectNodePtyPrebuild(f.root, () => f.archiveEntryPath, f.resources).entryPath).toBe(f.entryPath);
    const moved = join(f.root, "moved-payload");
    renameSync(f.path, moved); symlinkSync(moved, f.path);
    expect(realpathSync(f.path)).toBe(moved);
    expect(() => inspectNodePtyPrebuild(f.root, () => f.archiveEntryPath, f.resources)).toThrow("node-pty-preflight-unavailable");
  } finally { f.clean(); }
});

/** win32-x64: readiness is pinned bytes (existence + size + sha256) over the
 * ConPTY payload, because no POSIX mode bit is measurable on win32. */
it("admits the pinned win32-x64 ConPTY payload", () => {
  stubWin32();
  const f = fixtureWin32();
  try {
    expect(inspectNodePtyPrebuild(f.root, f.resolveEntry, undefined, WINDOWS_BUILD)).toMatchObject({ ready: true, entryPath: f.entryPath });
  } finally { f.clean(); }
});

it("admits win32-x64 on the ConPTY minimum build", () => {
  stubWin32();
  const f = fixtureWin32();
  try {
    expect(inspectNodePtyPrebuild(f.root, f.resolveEntry, undefined, 18309).ready).toBe(true);
  } finally { f.clean(); }
});

it.each(["addon", "worker"] as const)("refuses a win32-x64 payload whose pinned %s bytes changed", (kind) => {
  stubWin32();
  const f = fixtureWin32();
  try {
    const path = f[kind], bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
    expectNodePtyRefusal(() => inspectNodePtyPrebuild(f.root, f.resolveEntry, undefined, WINDOWS_BUILD));
  } finally { f.clean(); }
});

it.each(["addon", "worker"] as const)("refuses a win32-x64 payload missing its pinned %s", (kind) => {
  stubWin32();
  const f = fixtureWin32();
  try {
    rmSync(f[kind]);
    expectNodePtyRefusal(() => inspectNodePtyPrebuild(f.root, f.resolveEntry, undefined, WINDOWS_BUILD));
  } finally { f.clean(); }
});

it("refuses a win32-x64 payload truncated below its pinned size", () => {
  stubWin32();
  const f = fixtureWin32();
  try {
    writeFileSync(f.addon, readFileSync(f.addon).subarray(0, 1024));
    expectNodePtyRefusal(() => inspectNodePtyPrebuild(f.root, f.resolveEntry, undefined, WINDOWS_BUILD));
  } finally { f.clean(); }
});

it("refuses a win32-x64 payload grown past its pinned size", () => {
  stubWin32();
  const f = fixtureWin32();
  try {
    writeFileSync(f.addon, Buffer.concat([readFileSync(f.addon), Buffer.from([0])]));
    expectNodePtyRefusal(() => inspectNodePtyPrebuild(f.root, f.resolveEntry, undefined, WINDOWS_BUILD));
  } finally { f.clean(); }
});

it("refuses a win32 build older than the pinned ConPTY payload covers, before resolving a package", () => {
  stubWin32();
  const resolveEntry = vi.fn(() => "never-resolved");
  expectNodePtyRefusal(() => inspectNodePtyPrebuild(join(tmpdir(), "unused-pty-repo"), resolveEntry, undefined, LEGACY_WINDOWS_BUILD));
  expect(resolveEntry).not.toHaveBeenCalled();
});
