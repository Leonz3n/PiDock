import { expect, it } from "vitest";
import { serviceImportScanFromHost } from "../data/serviceImportHints";

const variables = [{ key: "PORT", source: "package.json", maskedValue: "••••••••" }];
const hint = { source: "package.json", name: "dev", runType: "long-lived", runTypeBasis: "名称含常驻关键字 dev/start/serve/watch",
  runTypeUncertain: false, variables, program: "node", args: ["server.js"], invalidVars: [], toVerify: ["人工核对"] };
const reply = { scan: { hints: [hint], errors: [], truncated: false } };

const config = { source: ".env", name: ".env", runType: null as null, runTypeBasis: "配置文件本身不是运行单元", runTypeUncertain: false,
  variables: [{ key: "API_TOKEN", source: ".env", maskedValue: "••••••••" }, { key: "PORT", source: ".env", maskedValue: "••••••••" }],
  program: "", args: [] as string[], invalidVars: [], toVerify: [] };

it("accepts config-only root .env hints without weakening the six command-source contracts", () => {
  const scan = (hints: unknown[]) => ({ scan: { hints, errors: [], truncated: false } });
  expect(serviceImportScanFromHost(scan([hint, config]))?.hints).toEqual([hint, config]);
  for (const runType of ["long-lived", "one-shot", "prepare", "running", undefined]) {
    expect(serviceImportScanFromHost(scan([{ ...config, runType }]))).toBeNull();
  }
  for (const source of ["package.json", ".vscode/launch.json", "compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"]) {
    const renamed = { ...hint, source, variables: variables.map((row) => ({ ...row, source })) };
    expect(serviceImportScanFromHost(scan([{ ...renamed, runType: null }]))).toBeNull();
    expect(serviceImportScanFromHost(scan([renamed]))?.hints).toHaveLength(1);
  }
  for (const variables of [[{ key: "bad-key", source: ".env", maskedValue: "••••••••" }],
    [{ key: "1BAD", source: ".env", maskedValue: "••••••••" }],
    [{ key: "A".repeat(101), source: ".env", maskedValue: "••••••••" }]]) {
    expect(serviceImportScanFromHost(scan([{ ...config, variables }]))).toBeNull();
  }
  expect(serviceImportScanFromHost(scan([{ ...config, source: ".env.local" }]))).toBeNull();
  // A configuration-only source is never an unclassified run unit.
  expect(serviceImportScanFromHost(scan([{ ...config, runTypeUncertain: true }]))).toBeNull();
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

// [PiDock 04] (#7 box 3) the page shows provenance and a masked value, and the
// mask is a wire invariant: a reply that carries a real value is refused whole.
it("refuses any variable row that is not source-plus-mask, so a value can never render as masked", () => {
  const scan = (hints: unknown[]) => ({ scan: { hints, errors: [], truncated: false } });
  const row = { key: "API_TOKEN", source: "package.json", maskedValue: "••••••••" };
  expect(serviceImportScanFromHost(scan([{ ...hint, variables: [row] }]))?.hints[0]?.variables).toEqual([row]);
  for (const maskedValue of ["synthetic-secret-token", "", "•••••••", 7, undefined]) {
    expect(serviceImportScanFromHost(scan([{ ...hint, variables: [{ ...row, maskedValue }] }]))).toBeNull();
  }
  // Provenance is per row and must match the file the hint was scanned from.
  expect(serviceImportScanFromHost(scan([{ ...hint, variables: [{ ...row, source: "compose.yaml" }] }]))).toBeNull();
  expect(serviceImportScanFromHost(scan([{ ...hint, variables: [{ ...row, source: undefined }] }]))).toBeNull();
  // Extra fields, duplicate keys and an over-long list are foreign replies.
  expect(serviceImportScanFromHost(scan([{ ...hint, variables: [{ ...row, value: "synthetic-secret-token" }] }]))).toBeNull();
  expect(serviceImportScanFromHost(scan([{ ...hint, variables: [row, row] }]))).toBeNull();
  expect(serviceImportScanFromHost(scan([{ ...hint, variables: Array(101).fill(row) }]))).toBeNull();
  expect(serviceImportScanFromHost(scan([{ ...hint, variables: undefined }]))).toBeNull();
});

// [PiDock 04] (#7 box 2) an unclassified candidate must be readable as such.
it("keeps the run-type basis and the unclassified flag strict", () => {
  const scan = (hints: unknown[]) => ({ scan: { hints, errors: [], truncated: false } });
  const uncertain = { ...hint, runType: "one-shot", runTypeBasis: "配置未给出启动命令，无法判定运行类型", runTypeUncertain: true };
  expect(serviceImportScanFromHost(scan([uncertain]))?.hints[0]).toMatchObject({ runType: "one-shot", runTypeUncertain: true });
  for (const runTypeUncertain of [undefined, "false", 1]) {
    expect(serviceImportScanFromHost(scan([{ ...hint, runTypeUncertain }]))).toBeNull();
  }
  for (const runTypeBasis of [undefined, "a".repeat(101)]) {
    expect(serviceImportScanFromHost(scan([{ ...hint, runTypeBasis }]))).toBeNull();
  }
});

// [PiDock 04] (#7 box 2) an unclassified hint stays `one-shot`: the Host never
// pairs `runTypeUncertain` with a resident or prepare type, so a reply that does
// is foreign and must not render as "常驻服务（待确认）".
it("refuses an unclassified hint that claims a classified run type", () => {
  const scan = (hints: unknown[]) => ({ scan: { hints, errors: [], truncated: false } });
  const uncertain = { ...hint, runTypeBasis: "配置未给出启动命令，无法判定运行类型", runTypeUncertain: true };
  expect(serviceImportScanFromHost(scan([{ ...uncertain, runType: "one-shot" }]))?.hints[0]?.runType).toBe("one-shot");
  for (const runType of ["long-lived", "prepare"]) {
    expect(serviceImportScanFromHost(scan([{ ...uncertain, runType }]))).toBeNull();
  }
});
