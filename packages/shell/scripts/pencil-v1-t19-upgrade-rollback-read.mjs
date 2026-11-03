// [PiDock pencil-v1] (#154 / T19) Rollback boundary: what a Pi 0.87.1 / 1.4.0
// SDK can and cannot do with a session that Pi 1.5.0 wrote.
//
// This is evidence, not a supported round-trip claim. Each old SDK is the exact
// published package installed under a temp prefix (see README for the commands);
// each open is read-only on a COPY, so no evidence file is ever mutated.
//
// Run (after the session evidence script produced `written/*.jsonl`):
//   node packages/shell/scripts/pencil-v1-t19-upgrade-rollback-read.mjs \
//     --sdk 0.87.1=/tmp/pidock-old-sdk/0871/node_modules/@earendil-works/pi-coding-agent \
//     --sdk 1.4.0=/tmp/pidock-old-sdk/140/node_modules/@earendil-works/pi-coding-agent
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const outDir = join(repoRoot, "docs/evidence/pencil-v1-t19-upgrade");
const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const args = process.argv.slice(2);
const sdkArgs = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--sdk") sdkArgs.push(args[index + 1]);
}
if (sdkArgs.length === 0) throw new Error("pass at least one --sdk <version>=<package-dir>");

const current = await import("@earendil-works/pi-coding-agent");

function project(manager) {
  const context = manager.buildSessionContext();
  const messages = context.messages.map((message) => ({
    role: message.role,
    text: typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content) ? message.content.map((block) => block.text ?? "").join("") : "",
  }));
  return { entryCount: manager.getEntries().length, messages, model: context.model, thinkingLevel: context.thinkingLevel };
}

const written = [
  { label: "0.87.1", file: join(outDir, "written", "0-87-1-after-1.5.jsonl") },
  { label: "1.4.0", file: join(outDir, "written", "1-4-0-after-1.5.jsonl") },
];
const record = {
  schema: 1,
  ticket: "#154",
  generatedAt: new Date().toISOString(),
  note: "Read-only parse of a Pi 1.5.0-written session by the exact published 0.87.1 / 1.4.0 SDKs. This is NOT a supported downgrade or round-trip contract.",
  currentSdk: "1.5.0 (repository dependency)",
  oldSdks: {},
  comparisons: [],
};
const temps = [];
try {
  for (const spec of sdkArgs) {
    const [version, packageDir] = spec.split("=");
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    const module = await import(pathToFileURL(join(packageDir, "dist", "index.js")).href);
    record.oldSdks[version] = { package: pkg.name, version: pkg.version, packageDir };
    for (const target of written) {
      const dir = mkdtempSync(join(tmpdir(), `pidock-rollback-${version.replaceAll(".", "-")}-`));
      temps.push(dir);
      const copy = join(dir, "copy.jsonl");
      copyFileSync(target.file, copy);
      const before = sha256File(copy);
      let opened = null;
      let error = null;
      try {
        const manager = module.SessionManager.open(copy, dir, "/tmp/rollback-boundary-cwd");
        opened = project(manager);
      } catch (caught) {
        error = String(caught?.message ?? caught);
      }
      const unchanged = before === sha256File(copy);
      const currentDir = mkdtempSync(join(tmpdir(), `pidock-rollback-current-${version.replaceAll(".", "-")}-`));
      temps.push(currentDir);
      const currentCopy = join(currentDir, "copy.jsonl");
      copyFileSync(target.file, currentCopy);
      const currentOpened = project(current.SessionManager.open(currentCopy, currentDir, "/tmp/rollback-boundary-cwd"));
      record.comparisons.push({
        fixture: target.label,
        file: `written/${target.file.split("/").at(-1)}`,
        reader: `${version} (${pkg.version})`,
        ok: error === null,
        error,
        unchanged,
        entryCount: opened?.entryCount ?? null,
        messageCount: opened?.messages.length ?? null,
        model: opened?.model ?? null,
        thinkingLevel: opened?.thinkingLevel ?? null,
        sameEntryCountAsCurrent: opened?.entryCount === currentOpened.entryCount,
        sameMessageRolesAsCurrent: JSON.stringify(opened?.messages.map((row) => row.role) ?? null) ===
          JSON.stringify(currentOpened.messages.map((row) => row.role)),
        sameTextAsCurrent: JSON.stringify(opened?.messages.map((row) => row.text) ?? null) ===
          JSON.stringify(currentOpened.messages.map((row) => row.text)),
        currentEntryCount: currentOpened.entryCount,
        currentMessageCount: currentOpened.messages.length,
        lastMessage: opened?.messages.at(-1)?.text ?? null,
      });
    }
  }
  record.summary = {
    readers: Object.keys(record.oldSdks),
    allReadWithoutError: record.comparisons.every((row) => row.ok),
    allCopiesUnchanged: record.comparisons.every((row) => row.unchanged),
    allMatchCurrentReader: record.comparisons.every((row) => row.sameEntryCountAsCurrent && row.sameMessageRolesAsCurrent),
  };
} finally {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
writeFileSync(join(outDir, "rollback-read.json"), `${JSON.stringify(record, null, 2)}\n`);
console.log("T19_ROLLBACK_READ=" + JSON.stringify(record.summary));
