/**
 * [PiDock #15] The Windows packaging asset is an MSI, not the NSIS single EXE
 * (human decision 2026-10-13, recorded in
 * `docs/adr/0004-windows-installer-msi-instead-of-nsis-exe.md`).
 *
 * The MSI option allow-list is read from the *installed* builder
 * (`app-builder-lib/scheme.json` -> `definitions.MsiOptions`) instead of being
 * copied in here: the builder rejects unknown keys
 * (`definitions.MsiOptions.additionalProperties === false`), so that schema is
 * the only authority on what the config may carry.
 *
 * Unit-level: config shape and script line only. Nothing here builds, installs
 * or signs an MSI — the Windows acceptance is manual and is described in
 * `docs/electron-packaging.md`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SHELL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG_PATH = join(SHELL_ROOT, "electron-builder.config.cjs");

/** Anchored on the shell package, exactly how the packaging scripts resolve it. */
const shellRequire = createRequire(join(SHELL_ROOT, "package.json"));

const SCHEMA_UNAVAILABLE =
  "cannot read the MsiOptions allow-list from the installed app-builder-lib scheme.json";

interface TargetSpec {
  target: string;
  arch: string[];
}

interface PackagingConfig {
  asar: boolean;
  files: string[];
  electronDist: string | undefined;
  mac: { target: TargetSpec[] };
  dmg: { title: string };
  win: { target: TargetSpec[] };
  msi: Record<string, unknown>;
  afterSign: string;
}

interface MsiScheme {
  definitions?: {
    MsiOptions?: {
      properties?: Record<string, unknown>;
      additionalProperties?: unknown;
    };
  };
}

/**
 * Reads `definitions.MsiOptions.properties` from a builder scheme file. Every
 * failure mode throws a named error: a guard that silently falls back to an
 * empty allow-list would accept any key, including NSIS-only ones.
 */
function msiOptionKeysFromScheme(schemePath: string): readonly string[] {
  let scheme: MsiScheme;
  try {
    scheme = JSON.parse(readFileSync(schemePath, "utf8")) as MsiScheme;
  } catch (cause) {
    throw new Error(
      `${SCHEMA_UNAVAILABLE} at ${schemePath} (is the electron-builder devDependency installed?): ${String(cause)}`,
    );
  }
  const msiOptions = scheme.definitions?.MsiOptions;
  const keys = msiOptions?.properties ? Object.keys(msiOptions.properties) : [];
  if (keys.length === 0) {
    throw new Error(
      `${SCHEMA_UNAVAILABLE} at ${schemePath}: definitions.MsiOptions.properties is missing or empty`,
    );
  }
  if (msiOptions?.additionalProperties !== false) {
    throw new Error(
      `${SCHEMA_UNAVAILABLE} at ${schemePath}: definitions.MsiOptions.additionalProperties is not false, so "every key is in the allow-list" would not prove the block is legal`,
    );
  }
  return keys;
}

function msiSchemePath(): string {
  try {
    const electronBuilderPackage = shellRequire.resolve("electron-builder/package.json");
    const appBuilderLibPackage = createRequire(electronBuilderPackage).resolve(
      "app-builder-lib/package.json",
    );
    return join(dirname(appBuilderLibPackage), "scheme.json");
  } catch (cause) {
    throw new Error(
      `${SCHEMA_UNAVAILABLE}: electron-builder/app-builder-lib does not resolve from ${SHELL_ROOT} (is the electron-builder devDependency installed?): ${String(cause)}`,
    );
  }
}

const MSI_SCHEME_PATH = msiSchemePath();
const MSI_OPTION_KEYS = msiOptionKeysFromScheme(MSI_SCHEME_PATH);

/**
 * The keys of an MSI block that the installed builder would reject. Empty means
 * the block only uses declared MSI options.
 */
function illegalMsiOptionKeys(
  optionKeys: readonly string[],
  allowed: readonly string[] = MSI_OPTION_KEYS,
): string[] {
  return optionKeys.filter((key) => !allowed.includes(key));
}

/**
 * Loads the builder config with a chosen argv, because `electronDist` is
 * decided at require time from `process.argv.includes("--win")`.
 */
function requireConfig(extraArgv: string[] = []): PackagingConfig {
  const originalArgv = process.argv;
  process.argv = [...originalArgv.filter((arg) => arg !== "--win"), ...extraArgv];
  try {
    delete shellRequire.cache[shellRequire.resolve(CONFIG_PATH)];
    return shellRequire(CONFIG_PATH) as PackagingConfig;
  } finally {
    process.argv = originalArgv;
  }
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("#15 Windows x64 installer asset is MSI (ADR 0004)", () => {
  it("targets msi and drops the nsis block", () => {
    const config = requireConfig();
    expect(config.win.target).toEqual([{ target: "msi", arch: ["x64"] }]);
    expect(Object.keys(config)).not.toContain("nsis");
    expect(config.msi).toBeDefined();
  });

  it("uses only keys the installed builder declares in MsiOptions", () => {
    const config = requireConfig();
    // Sanity: the allow-list really came from the MSI schema, not from an empty read.
    expect(MSI_OPTION_KEYS).toContain("oneClick");
    expect(MSI_OPTION_KEYS).toContain("perMachine");
    expect(MSI_OPTION_KEYS).toContain("artifactName");
    // `allowToChangeInstallationDirectory` is declared by NsisOptions only, which
    // is why the previous block's intent cannot be carried over verbatim.
    expect(MSI_OPTION_KEYS).not.toContain("allowToChangeInstallationDirectory");
    expect(illegalMsiOptionKeys(Object.keys(config.msi))).toEqual([]);
    // The allow-list check above is one-directional: it only proves that every key
    // the config *does* carry is legal, so deleting a key that carries the intent
    // keeps it green while the MSI silently falls back to the builder's default
    // (`oneClick: true` — a one-click installer).
    // ADR 0004 preserves the previous NSIS block's intent, so pin that intent here:
    // assisted (not one-click) install and per-user scope. Delete either key and this
    // assertion fails.
    expect(config.msi).toMatchObject({ oneClick: false, perMachine: false });
    // The artifact name may be renamed freely; what the handoff depends on is that it
    // follows the real target extension instead of a hard-coded one.
    expect(config.msi.artifactName).toMatch(/\$\{ext\}$/);
  });

  it("rejects an MSI block that carries an NSIS-only key, naming it", () => {
    const mutated = { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true };
    expect(illegalMsiOptionKeys(Object.keys(mutated))).toEqual([
      "allowToChangeInstallationDirectory",
    ]);
  });

  it("never passes when the installed scheme cannot supply a closed MsiOptions allow-list", () => {
    const dir = mkdtempSync(join(tmpdir(), "pidock-builder-scheme-"));
    tempDirs.push(dir);
    const missing = join(dir, "scheme.json");
    expect(() => msiOptionKeysFromScheme(missing)).toThrow(/MsiOptions allow-list/);

    const noMsiOptions = join(dir, "no-msi-options.json");
    writeFileSync(noMsiOptions, JSON.stringify({ definitions: {} }));
    expect(() => msiOptionKeysFromScheme(noMsiOptions)).toThrow(/MsiOptions allow-list/);

    const openOptionSet = join(dir, "open-option-set.json");
    writeFileSync(
      openOptionSet,
      JSON.stringify({ definitions: { MsiOptions: { properties: { oneClick: {} } } } }),
    );
    expect(() => msiOptionKeysFromScheme(openOptionSet)).toThrow(/additionalProperties/);
  });

  it("builds the msi target from package:win and no longer mentions nsis", () => {
    const shellPackage = JSON.parse(readFileSync(join(SHELL_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(shellPackage.scripts["package:win"]).toContain("--win msi");
    expect(shellPackage.scripts["package:win"]).not.toContain("nsis");
    expect(shellPackage.scripts["package:mac"]).toBe(
      "electron-builder --config electron-builder.config.cjs --mac dmg --arm64",
    );
  });

  it("leaves the macOS arm64 DMG path unchanged", () => {
    const config = requireConfig();
    expect(config.asar).toBe(true);
    expect(config.files).toEqual(["dist/**/*", "package.json"]);
    expect(config.mac.target).toEqual([{ target: "dmg", arch: ["arm64"] }]);
    expect(config.dmg.title).toBe("${productName} ${version} ${arch}");
    expect(config.afterSign).toBe("scripts/notarize.cjs");
  });

  it("keeps the electronDist override mac-only, keyed on --win", () => {
    expect(requireConfig().electronDist).toBe(join(SHELL_ROOT, "node_modules", "electron", "dist"));
    expect(requireConfig(["--win"]).electronDist).toBeUndefined();
  });
});
