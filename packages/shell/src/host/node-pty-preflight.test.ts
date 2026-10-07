import { expect, it, beforeEach, afterEach, vi } from "vitest";
import { copyFileSync, chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectNodePtyPrebuild, prepareNodePtyPrebuild } from "./node-pty-preflight.js";

const actualDarwinArm64 = process.platform === "darwin" && process.arch === "arm64";
// Only actual POSIX mode/fchmod and link-identity checks use this platform gate.
const posixIt = it.skipIf(!actualDarwinArm64);
beforeEach(() => { vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64" }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pidock-pty-preflight-")));
  const path = join(root, "node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty");
  const installed = fileURLToPath(new URL("../../node_modules/node-pty/", import.meta.url));
  mkdirSync(join(path, "prebuilds/darwin-arm64"), { recursive: true });
  mkdirSync(join(path, "lib"));
  const entryPath = join(path, "lib/index.js");
  writeFileSync(entryPath, "// Never imported by filesystem tests.\n");
  writeFileSync(join(path, "package.json"), '{"name":"node-pty","version":"1.1.0"}');
  const helper = join(path, "prebuilds/darwin-arm64/spawn-helper"), addon = join(path, "prebuilds/darwin-arm64/pty.node");
  copyFileSync(join(installed, "prebuilds/darwin-arm64/spawn-helper"), helper);
  copyFileSync(join(installed, "prebuilds/darwin-arm64/pty.node"), addon);
  chmodSync(helper, 0o644); chmodSync(addon, 0o644);
  return { root, path, helper, addon, entryPath, resolveEntry: () => entryPath, clean: () => rmSync(root, { recursive: true, force: true }) };
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
