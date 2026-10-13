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

/** `dev` is the pnpm virtual store under a repository root; `packed` is the flat
 * production layout a packed app extracts under `app.asar.unpacked`, with the
 * archive that requires it present next to it. */
function fixture(layout: "dev" | "packed" = "dev") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pidock-pty-preflight-")));
  const resources = join(root, "PiDock.app/Contents/Resources");
  const path = layout === "packed"
    ? join(resources, "app.asar.unpacked/node_modules/node-pty")
    : join(root, "node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty");
  const installed = fileURLToPath(new URL("../../node_modules/node-pty/", import.meta.url));
  mkdirSync(join(path, "prebuilds/darwin-arm64"), { recursive: true });
  mkdirSync(join(path, "lib"));
  if (layout === "packed") writeFileSync(join(resources, "app.asar"), "packed-applications-archive\n");
  const entryPath = join(path, "lib/index.js");
  writeFileSync(entryPath, "// Never imported by filesystem tests.\n");
  writeFileSync(join(path, "package.json"), '{"name":"node-pty","version":"1.1.0"}');
  const helper = join(path, "prebuilds/darwin-arm64/spawn-helper"), addon = join(path, "prebuilds/darwin-arm64/pty.node");
  copyFileSync(join(installed, "prebuilds/darwin-arm64/spawn-helper"), helper);
  copyFileSync(join(installed, "prebuilds/darwin-arm64/pty.node"), addon);
  chmodSync(helper, 0o644); chmodSync(addon, 0o644);
  return {
    root, path, helper, addon, entryPath,
    resources: layout === "packed" ? resources : undefined,
    archiveEntryPath: join(resources, "app.asar/node_modules/node-pty/lib/index.js"),
    resolveEntry: () => entryPath,
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
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

it.each(["helper", "addon"] as const)("refuses changed %s bytes before granting execution permission", (kind) => {
  const f = fixture();
  try {
    const before = statSync(f.helper).mode & 0o7777;
    const path = f[kind], bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
    expect(() => prepareNodePtyPrebuild(f.root, f.resolveEntry)).toThrow("node-pty-preflight-unavailable");
    expect(statSync(f.helper).mode & 0o7777).toBe(before);
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

it.each(["win32", "linux"])("refuses unsupported %s before resolving a package or touching native files", (platform) => {
  vi.stubGlobal("process", { ...process, platform });
  const resolveEntry = vi.fn(() => "never-resolved");
  expect(() => inspectNodePtyPrebuild(join(tmpdir(), "unused-pty-repo"), resolveEntry)).toThrow("node-pty-preflight-unavailable");
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
  const f = fixture("packed");
  try {
    // require.resolve reports the archive member; asarUnpack pins that member's
    // extraction to the unpacked file the audit below really reads.
    expect(inspectNodePtyPrebuild(f.root, () => f.archiveEntryPath, f.resources)).toMatchObject({ entryPath: f.entryPath });
    // The unpacked spelling names the same audited file and is accepted too.
    expect(inspectNodePtyPrebuild(f.root, () => f.entryPath, f.resources).entryPath).toBe(f.entryPath);
  } finally { f.clean(); }
});

it("keeps the pnpm virtual-store layout when the resources root holds no archive", () => {
  const f = fixture();
  try {
    // A dev Electron has a `process.resourcesPath` but no app.asar: the packaged
    // candidate must not hijack the dev layout.
    const resources = join(f.root, "Electron.app/Contents/Resources");
    mkdirSync(resources, { recursive: true });
    expect(inspectNodePtyPrebuild(f.root, f.resolveEntry, resources).entryPath).toBe(f.entryPath);
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
  const f = fixture("packed");
  try {
    // Positive control: only the competitor is added between the two calls.
    expect(inspectNodePtyPrebuild(f.root, f.resolveEntry, f.resources).entryPath).toBe(f.entryPath);
    mkdirSync(join(f.path, "build/Release"), { recursive: true });
    writeFileSync(join(f.path, "build/Release/pty.node"), "untrusted-native-candidate");
    expect(() => inspectNodePtyPrebuild(f.root, f.resolveEntry, f.resources)).toThrow("node-pty-preflight-unavailable");
  } finally { f.clean(); }
});

it.each(["helper", "addon"] as const)("refuses changed %s bytes inside the packaged package", (kind) => {
  const f = fixture("packed");
  try {
    const path = f[kind], bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
    expect(() => inspectNodePtyPrebuild(f.root, () => f.archiveEntryPath, f.resources)).toThrow("node-pty-preflight-unavailable");
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
