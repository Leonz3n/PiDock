import { expect, it } from "vitest";
import { serviceImportScanFromHost } from "../data/serviceImportHints";

const hint = { source: "package.json", name: "dev", runType: "long-lived", envKeys: ["PORT"], invalidVars: [], toVerify: ["人工核对"] };
const reply = { scan: { hints: [hint], errors: [], truncated: false } };

it("parses bounded Host-only import hints without inferring success from malformed data", () => {
  expect(serviceImportScanFromHost(reply)?.hints[0]?.name).toBe("dev");
  expect(serviceImportScanFromHost({ scan: { hints: [], errors: [], truncated: true } })?.truncated).toBe(true);
  expect(serviceImportScanFromHost({ scan: { hints: [], errors: [] } })).toBeNull();
  expect(serviceImportScanFromHost({ scan: { hints: [{ ...hint, runType: "running" }], errors: [], truncated: false } })).toBeNull();
  expect(serviceImportScanFromHost({ scan: { hints: [{ ...hint, source: "../../secret" }], errors: [], truncated: false } })).toBeNull();
  expect(serviceImportScanFromHost({ scan: { hints: [{ ...hint, toVerify: Array(33).fill("x") }], errors: [], truncated: false } })).toBeNull();
});
