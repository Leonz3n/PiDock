import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "native", "service-supervisor");
const target = process.argv[2];
if (!["darwin-arm64", "win32-x64"].includes(target) || process.argv.length > 4) throw Error("expected target darwin-arm64 or win32-x64, optional output parent");
const platform = target.startsWith("darwin") ? "darwin" : "win32";
const arch = platform === "darwin" ? "arm64" : "x64";
const outputParent = resolve(process.argv[3] ?? join(root, "build", "service-supervisor"));
mkdirSync(outputParent, { recursive: true });
const output = join(outputParent, target);
const temporary = mkdtempSync(join(outputParent, ".supervisor-"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function sourceDigest() {
  const rows = [];
  function walk(directory, prefix = "") {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name), relative = prefix + name, stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw Error("linked supervisor source");
      if (stat.isDirectory()) walk(file, relative + "/");
      else if (/\.go$|^go\.(mod|sum)$/.test(name)) rows.push([relative, hash(readFileSync(file))]);
    }
  }
  walk(source);
  return hash(JSON.stringify(rows));
}
try {
  const before = sourceDigest();
  const file = platform === "darwin" ? "service-supervisor" : "service-supervisor.exe";
  const env = { ...process.env, GOOS: platform === "darwin" ? "darwin" : "windows", GOARCH: arch === "x64" ? "amd64" : "arm64",
    CGO_ENABLED: "0", GOWORK: "off", GOFLAGS: "" };
  const goVersion = execFileSync("go", ["version"], { encoding: "utf8", timeout: 10000 }).trim();
  execFileSync("go", ["build", "-mod=readonly", "-trimpath", "-buildvcs=false", "-ldflags=-buildid=", "-o", join(temporary, file), "."],
    { cwd: source, env, timeout: 120000, stdio: "pipe" });
  if (sourceDigest() !== before) throw Error("supervisor source changed during build");
  const bytes = readFileSync(join(temporary, file));
  if (platform === "darwin") {
    if (bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c) throw Error("wrong Mach-O target");
  } else {
    const pe = bytes.readUInt32LE(0x3c);
    if (bytes.toString("ascii", 0, 2) !== "MZ" || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664) throw Error("wrong PE target");
  }
  const manifest = { schemaVersion: 1, kind: "development-unsigned", protocolVersion: 1, platform, arch, file,
    sha256: hash(bytes), sourceSha256: before, goVersion };
  writeFileSync(join(temporary, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  // Never replace an unrelated directory; only this script's exact dev target.
  let previous = false;
  try {
    const stat = lstatSync(output);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("invalid output directory");
    const prior = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
    if (prior.kind !== manifest.kind || prior.platform !== platform || prior.arch !== arch) throw Error("unrelated output directory");
    previous = true;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const backup = temporary + "-previous";
  if (previous) renameSync(output, backup);
  try { renameSync(temporary, output); }
  catch (error) { if (previous) renameSync(backup, output); throw error; }
  if (previous) rmSync(backup, { recursive: true, force: true });
  console.log(JSON.stringify({ output, ...manifest }));
} finally { rmSync(temporary, { recursive: true, force: true }); }
