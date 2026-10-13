import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanServiceImportHints } from "./service-import.js";
import { SERVICE_VALUE_MASK as HOST_MASK } from "../main/service-config.js";
import { SERVICE_VALUE_MASK as RENDERER_MASK, serviceImportScanFromHost } from "../../../renderer/src/data/serviceImportHints.js";

/**
 * The Host scanner → renderer parser seam ([PiDock 04] #7 box 3).
 *
 * The renderer mirrors the shared rules instead of importing them (its page has
 * no Node capability), so nothing else proves that the Host's own output is a
 * reply the page accepts. This test runs the real scanner and feeds its payload
 * into the strict parser: a variable row the renderer refuses (an invalid key
 * or an unbounded review list) would otherwise turn every hint into
 * `Host 导入草案响应无法核对`. The cross-package read is test-only and hands the
 * page no capability — it reads the renderer's pure parser from the Node side.
 */
const roots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), "pidock-import-seam-")); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("#7 Host scanner to renderer parser seam", () => {
  it("keeps the one masked-value spelling on both sides", () => {
    expect(RENDERER_MASK).toBe(HOST_MASK);
  });

  it("emits a launch.json hint the renderer accepts even when the env block has an invalid key", () => {
    const repo = root();
    mkdirSync(join(repo, ".vscode"));
    writeFileSync(join(repo, ".vscode", "launch.json"), JSON.stringify({ configurations: [{
      name: "api", program: "node", args: ["server.js"],
      env: { "1BAD": "synthetic-value-one", DSN: "postgres://${DB_HOST}/app", PORT: "4100" },
    }] }));
    const scan = scanServiceImportHints(repo);
    expect(scan.errors).toEqual([]);
    expect(scan.hints[0]?.invalidVars).toEqual(["1BAD"]);

    const view = serviceImportScanFromHost({ scan });
    expect(view).not.toBeNull();
    expect(view?.hints).toHaveLength(1);
    // The invalid key is disclosed by name but never carried as a variable row.
    expect(view?.hints[0]?.variables.map((row) => row.key)).toEqual(["DSN", "PORT"]);
    expect(view?.hints[0]?.invalidVars).toEqual(["1BAD"]);
  });

  it("emits a Compose hint the renderer accepts even when the environment list repeats a key", () => {
    const repo = root();
    writeFileSync(join(repo, "compose.yaml"), "services:\n  worker:\n    command: node worker.js\n    environment:\n      - PORT=4100\n      - PORT=4200\n");
    const scan = scanServiceImportHints(repo);
    const view = serviceImportScanFromHost({ scan });
    expect(view).not.toBeNull();
    // The renderer refuses a reply that repeats a key, so the Host collapses it.
    expect(view?.hints[0]?.variables.map((row) => row.key)).toEqual(["PORT"]);
  });

  it("emits a .env hint whose review list the renderer accepts", () => {    const repo = root();
    writeFileSync(join(repo, ".env"), Array.from({ length: 40 }, (_, index) =>
      `CONFIG_PATH_${String(index).padStart(2, "0")}=/Users/name/private/config-${index}.yaml`).join("\n"));
    const scan = scanServiceImportHints(repo);
    expect(scan.hints[0]!.toVerify.length).toBeLessThanOrEqual(32);

    const view = serviceImportScanFromHost({ scan });
    expect(view).not.toBeNull();
    expect(view?.hints[0]?.source).toBe(".env");
    expect(view?.hints[0]?.toVerify.length).toBeLessThanOrEqual(32);
  });
});
