import { expect, it } from "vitest";
import { serviceImportScanFromHost } from "../data/serviceImportHints";

const hint = { source: "package.json", name: "dev", runType: "long-lived", envKeys: ["PORT"], invalidVars: [], toVerify: ["人工核对"] };
const reply = { scan: { hints: [hint], errors: [], truncated: false } };

it("accepts config-only root .env hints without weakening the six command-source contracts", () => {
  const config = { source: ".env", name: ".env", runType: null, envKeys: ["API_TOKEN", "PORT"], invalidVars: [], toVerify: [] };
  const scan = (hints: unknown[]) => ({ scan: { hints, errors: [], truncated: false } });
  expect(serviceImportScanFromHost(scan([hint, config]))?.hints).toEqual([hint, config]);
  for (const runType of ["long-lived", "one-shot", "prepare", "running", undefined]) {
    expect(serviceImportScanFromHost(scan([{ ...config, runType }]))).toBeNull();
  }
  for (const source of ["package.json", ".vscode/launch.json", "compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"]) {
    expect(serviceImportScanFromHost(scan([{ ...hint, source, runType: null }]))).toBeNull();
    expect(serviceImportScanFromHost(scan([{ ...hint, source }]))?.hints).toHaveLength(1);
  }
  for (const envKeys of [["bad-key"], ["1BAD"], ["A".repeat(101)]]) {
    expect(serviceImportScanFromHost(scan([{ ...config, envKeys }]))).toBeNull();
  }
  expect(serviceImportScanFromHost(scan([{ ...config, source: ".env.local" }]))).toBeNull();
});

it("accepts one bounded read error for each fixed configuration source", () => {
  const sources = ["package.json", ".vscode/launch.json", "compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml", ".env"];
  const errors = sources.map((source) => ({ source, reason: "配置读取失败" }));
  expect(serviceImportScanFromHost({ scan: { hints: [], errors, truncated: false } })?.errors).toEqual(errors);
  expect(serviceImportScanFromHost({ scan: { hints: [], errors: [...errors, errors[0]], truncated: false } })).toBeNull();
});

it("parses bounded Host-only import hints without inferring success from malformed data", () => {
  expect(serviceImportScanFromHost(reply)?.hints[0]?.name).toBe("dev");
  expect(serviceImportScanFromHost({ scan: { hints: [], errors: [], truncated: true } })?.truncated).toBe(true);
  expect(serviceImportScanFromHost({ scan: { hints: [], errors: [] } })).toBeNull();
  expect(serviceImportScanFromHost({ scan: { hints: [{ ...hint, runType: "running" }], errors: [], truncated: false } })).toBeNull();
  expect(serviceImportScanFromHost({ scan: { hints: [{ ...hint, source: "../../secret" }], errors: [], truncated: false } })).toBeNull();
  expect(serviceImportScanFromHost({ scan: { hints: [{ ...hint, toVerify: Array(33).fill("x") }], errors: [], truncated: false } })).toBeNull();
});
