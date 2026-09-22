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
 * - macOS arm64 DMG and Windows x64 NSIS EXE candidates.
 * - Reuses the already-installed Electron runtime so packaging works offline.
 * - Signing/notarisation run through `scripts/notarize.cjs`; they are no-ops
 *   unless the Apple credentials are present in the environment.
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
  // inside app.asar; the Host entry the utilityProcess spawns is dist/host/host.js.
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
    target: [{ target: "nsis", arch: ["x64"] }],
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    artifactName: "${productName}-${version}-${arch}-setup.${ext}",
  },
  afterSign: "scripts/notarize.cjs",
};
