import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectDevelopmentSupervisor } from "./service-supervisor-artifact.js";

const dirs: string[] = [];
function directory() { const dir = mkdtempSync(join(tmpdir(), "pidock-supervisor-artifact-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const unavailable = { state: "unavailable", reason: "invalid-development-artifact" };
function build(parent: string, target = "darwin-arm64") {
  const output = execFileSync(process.execPath, [resolve("scripts/build-service-supervisor.mjs"), target, parent], { encoding: "utf8", timeout: 120000, stdio: "pipe" });
  return JSON.parse(output) as Record<string, unknown>;
}
it("returns unavailable for absent, malformed, overlarge or traversal manifests", () => {
  const dir = directory();
  expect(inspectDevelopmentSupervisor(dir)).toEqual(unavailable);
  for (const body of ["{invalid", "x".repeat(4097), JSON.stringify({ file: "../service-supervisor", schemaVersion: 1 })]) {
    writeFileSync(join(dir, "manifest.json"), body);
    expect(inspectDevelopmentSupervisor(dir)).toEqual(unavailable);
  }
});

describe.skipIf(process.platform !== "darwin")("development supervisor build artifacts", () => {
  it("builds repeatable macOS contents and records Windows x64 without enabling its runtime", () => {
    const parent = directory();
    const first = build(parent), second = build(parent);
    expect(second["sha256"]).toBe(first["sha256"]);
    expect(second["sourceSha256"]).toBe(first["sourceSha256"]);
    const inspected = inspectDevelopmentSupervisor(join(parent, "darwin-arm64"));
    if (process.arch === "arm64") expect(inspected.state).toBe("available-for-experiment");
    else expect(inspected).toEqual({ state: "unavailable", reason: "unsupported-runtime-platform" });
    const windows = build(parent, "win32-x64");
    expect(windows).toMatchObject({ platform: "win32", arch: "x64", kind: "development-unsigned" });
    expect(inspectDevelopmentSupervisor(join(parent, "win32-x64"))).toEqual({ state: "unavailable", reason: "unsupported-runtime-platform" });
  }, 120000);
  it("rejects tampered content, wrong machine headers, missing binary and linked manifests", () => {
    const parent = directory(); build(parent);
    const dir = join(parent, "darwin-arm64"), manifestFile = join(dir, "manifest.json"), binary = join(dir, "service-supervisor");
    const original = readFileSync(binary), manifest = readFileSync(manifestFile, "utf8");
    writeFileSync(binary, "wrong-content"); expect(inspectDevelopmentSupervisor(dir)).toEqual(unavailable);
    writeFileSync(binary, original);
    const wrongMachine = Buffer.from(original); wrongMachine.writeUInt32LE(0x01000007, 4);
    writeFileSync(binary, wrongMachine);
    writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(manifest), sha256: createHash("sha256").update(wrongMachine).digest("hex") }));
    expect(inspectDevelopmentSupervisor(dir)).toEqual(unavailable);
    writeFileSync(binary, original);
    for (const patch of [{ protocolVersion: 2 }, { file: "../service-supervisor" }, { arch: "x64" }, { extra: "unexpected" }]) {
      writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(manifest), ...patch }));
      expect(inspectDevelopmentSupervisor(dir)).toEqual(unavailable);
    }
    writeFileSync(manifestFile, manifest);
    chmodSync(binary, 0o600); expect(inspectDevelopmentSupervisor(dir)).toEqual(unavailable);
    chmodSync(binary, 0o700);
    const other = join(parent, "external-manifest.json"); writeFileSync(other, manifest);
    rmSync(manifestFile); symlinkSync(other, manifestFile);
    expect(inspectDevelopmentSupervisor(dir)).toEqual(unavailable);
    rmSync(manifestFile); writeFileSync(manifestFile, manifest);
    rmSync(binary); expect(inspectDevelopmentSupervisor(dir)).toEqual(unavailable);
  }, 120000);
  it("does not replace an unrelated output directory", () => {
    const parent = directory(); build(parent);
    const dir = join(parent, "darwin-arm64");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ kind: "unrelated" }));
    const original = readFileSync(join(dir, "service-supervisor"));
    expect(() => build(parent)).toThrow();
    expect(readFileSync(join(dir, "service-supervisor"))).toEqual(original);
  }, 120000);
});
