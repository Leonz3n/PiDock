import { expect, it } from "vitest";
import { serviceImportScanFromHost } from "../data/serviceImportHints";

const hint = { source: "package.json", name: "dev", runType: "long-lived", envKeys: ["PORT"], program: "node", args: ["server.js"], invalidVars: [], toVerify: ["人工核对"] };
const reply = { scan: { hints: [hint], errors: [], truncated: false } };

const config = { source: ".env", name: ".env", runType: null as null, envKeys: ["API_TOKEN", "PORT"], program: "", args: [] as string[], invalidVars: [], toVerify: [] };

it("accepts config-only root .env hints without weakening the six command-source contracts", () => {
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

it("keeps the redacted command candidate and the repo-relative workdir strict", () => {
  expect(serviceImportScanFromHost(reply)?.hints[0]).toMatchObject({ program: "node", args: ["server.js"] });
  const withWorkdir = { ...hint, workdir: "apps/api" };
  expect(serviceImportScanFromHost({ scan: { hints: [withWorkdir], errors: [], truncated: false } })?.hints[0]?.workdir).toBe("apps/api");
  // A missing command candidate is an old/foreign reply, not an empty one.
  expect(serviceImportScanFromHost({ scan: { hints: [{ ...hint, program: undefined }], errors: [], truncated: false } })).toBeNull();
  expect(serviceImportScanFromHost({ scan: { hints: [{ ...hint, args: undefined }], errors: [], truncated: false } })).toBeNull();
  expect(serviceImportScanFromHost({ scan: { hints: [{ ...hint, args: "node server.js" }], errors: [], truncated: false } })).toBeNull();
  expect(serviceImportScanFromHost({ scan: { hints: [{ ...hint, program: "a".repeat(201) }], errors: [], truncated: false } })).toBeNull();
  expect(serviceImportScanFromHost({ scan: { hints: [{ ...hint, args: Array(41).fill("x") }], errors: [], truncated: false } })).toBeNull();
  for (const workdir of ["/srv/app", "~/app", "../outside", "apps/api-token", 7]) {
    expect(serviceImportScanFromHost({ scan: { hints: [{ ...hint, workdir }], errors: [], truncated: false } })).toBeNull();
  }
  // A configuration-only source can never carry a command or a working directory.
  expect(serviceImportScanFromHost({ scan: { hints: [{ ...config, program: "node" }], errors: [], truncated: false } })).toBeNull();
  expect(serviceImportScanFromHost({ scan: { hints: [{ ...config, args: ["server.js"] }], errors: [], truncated: false } })).toBeNull();
  expect(serviceImportScanFromHost({ scan: { hints: [{ ...config, workdir: "apps/api" }], errors: [], truncated: false } })).toBeNull();
});
