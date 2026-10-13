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
