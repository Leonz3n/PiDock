const path = require("node:path");

// Reuse the already-installed (darwin-arm64) Electron runtime so macOS
// packaging works offline. Windows targets must download their own win32-x64
// Electron distribution, so the override is mac-only.
const wantsWindows = process.argv.includes("--win");
const localElectronDist = path.join(
  __dirname,
  "node_modules",
  "electron",
  "dist",
);

/**
 * Packaging candidate config for PiDock (S6).
 *
 * - macOS arm64 DMG and Windows x64 MSI candidates.
 * - Reuses the already-installed Electron runtime so packaging works offline.
 * - Signing/notarisation run through `scripts/notarize.cjs`; they are no-ops
 *   unless the Apple credentials are present in the environment.
 *
 * The Windows installer asset is MSI, not the NSIS single EXE: see
 * docs/adr/0004-windows-installer-msi-instead-of-nsis-exe.md. `msi` therefore
 * declares only keys from `definitions.MsiOptions` of the installed builder's
 * scheme.json (the builder sets `additionalProperties: false`, so NSIS-only keys
 * such as `allowToChangeInstallationDirectory` would be rejected), and no MSI
 * has been produced on this darwin-arm64 host — the Windows acceptance is
 * manual (docs/electron-packaging.md).
 *
 * @type {import('electron-builder').Configuration}
 */
module.exports = {
  appId: "com.pidock.desktop",
  productName: "PiDock",
  directories: {
    output: "release",
  },
  asar: true,
  // The whole compiled shell (main + utilityProcess host + preload + rpc) ships
  // inside app.asar; production forks dist/host/host-entry.js. Test-only
  // Provider harnesses under scripts/ are excluded from packaged files.
  files: ["dist/**/*", "package.json"],
  // The pinned node-pty payload must be a real file on disk: the Host preflight
  // opens it with O_NOFOLLOW, re-checks fstat, and pins size + sha256 + mode
  // (src/host/node-pty-preflight.ts). This pins the extraction of that payload
  // explicitly instead of relying on builder's smart-unpack heuristic
  // (app-builder-lib/out/asar/unpackDetector.js unpacks a module wholesale once
  // any file in it is a `.node` carrier).
  asarUnpack: ["node_modules/node-pty/**"],
  // Nothing may rebuild the native payload. `@electron/rebuild` compiles node-pty
  // from source into `<package>/build/Release/{pty.node,spawn-helper}` - which
  // node-pty's own loader prefers over `prebuilds/<platform>-<arch>`
  // (node-pty/lib/utils.js) and which the preflight refuses as a competing loader
  // directory - so a rebuilt package ships an unpinned addon the terminal then
  // refuses to load. node-pty 1.1.0 is N-API (node-addon-api ^7.1.0) and ships the
  // pinned darwin-arm64 prebuild; @earendil-works/pi-tui resolves N-API through
  // dlsym (native/napi.h) and ships its own prebuilds, so neither needs an
  // Electron-ABI rebuild. Re-enabling this silently breaks the built-in terminal.
  npmRebuild: false,
  electronDist: wantsWindows ? undefined : localElectronDist,
  mac: {
    target: [{ target: "dmg", arch: ["arm64"] }],
    category: "public.app-category.developer-tools",
    hardenedRuntime: true,
    entitlements: "packaging/entitlements.mac.plist",
    entitlementsInherit: "packaging/entitlements.mac.plist",
  },
  dmg: {
    title: "${productName} ${version} ${arch}",
  },
  win: {
    // The msi target cannot be built without an icon: templates/msi/template.xml
    // emits `<Icon Id="${iconId}"/>` only when `iconPath` is set, while
    // out/targets/MsiTarget.js references `Icon="${iconId}"` unconditionally for
    // the shortcuts and the ProgId, so a missing icon fails the build with
    // light.exe LGHT0094. `win.icon` (not `msi.icon`, which does not exist in
    // MsiOptions) is the only key that reaches getOrConvertIcon("ico"). The path
    // is relative to this package, and it lives in packaging/ rather than the
    // builder's default build/ because .gitignore ignores build/.
    icon: "packaging/icon.svg",
    target: [{ target: "msi", arch: ["x64"] }],
  },
  // Same intent as the previous NSIS block: assisted (not one-click) install,
  // per-user scope. `${ext}` keeps the artifact name honest as `msi`, and
  // `upgradeCode` stays unset because the builder derives it from `appId`
  // (ADR 0004): changing `appId` changes the upgrade identity.
  msi: {
    oneClick: false,
    perMachine: false,
    artifactName: "${productName}-${version}-${arch}.${ext}",
  },
  afterSign: "scripts/notarize.cjs",
};
