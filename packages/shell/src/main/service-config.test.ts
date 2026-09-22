import { describe, expect, it } from "vitest";
import {
  auditImportVars,
  autoAdjustPorts,
  buildChildEnv,
  classifyImportDraft,
  diffServiceTemplate,
  isServiceSecretKey,
  maskServiceValue,
  nextServiceTemplateVersion,
  recordPlatformLaunch,
  resolveServiceEnv,
  restartNeededForTemplateAdopt,
  validateNoSecretsInShared,
  validateServiceDescriptor,
  type ResolvedServiceRow,
  type ServiceDescriptor,
} from "./service-config.js";

// Seam: #7 S1 pure service-config rules (no Electron, no child_process).

const row = (key: string, value: string, source: ResolvedServiceRow["source"]): ResolvedServiceRow => ({
  key,
  value,
  secret: false,
  source,
});

describe("validateServiceDescriptor", () => {
  const base: ServiceDescriptor = {
    name: "saas-web",
    program: "pnpm",
    args: ["--filter", "saas-web", "dev"],
    ports: [5173],
    runType: "long-lived",
  };
  it("accepts an explicit program + args descriptor", () => {
    expect(validateServiceDescriptor(base)).toBeNull();
  });
  it("rejects Unix-only inline env assignment in the program", () => {
    expect(validateServiceDescriptor({ ...base, program: "PORT=5173" })?.code).toBe("invalid-service");
    expect(validateServiceDescriptor({ ...base, program: "PORT=5173" })?.message).toContain("内联环境赋值");
  });
  it("rejects shell chaining anywhere in program/args", () => {
    expect(validateServiceDescriptor({ ...base, args: ["dev", "&&", "pnpm", "build"] })?.code).toBe("invalid-service");
  });
  it("rejects blank programs and out-of-range ports", () => {
    expect(validateServiceDescriptor({ ...base, program: "  " })?.code).toBe("invalid-service");
    expect(validateServiceDescriptor({ ...base, ports: [0] })?.code).toBe("invalid-port");
    expect(validateServiceDescriptor({ ...base, ports: [70000] })?.code).toBe("invalid-port");
  });
  it("rejects relative cwd", () => {
    expect(validateServiceDescriptor({ ...base, cwd: "relative/dir" })?.code).toBe("invalid-service");
    expect(validateServiceDescriptor({ ...base, cwd: "/Users/name/tasks/task-a1f92c3d/front" })).toBeNull();
  });
});

describe("resolveServiceEnv", () => {
  it("resolves with precedence and source labels", () => {
    const result = resolveServiceEnv({
      repoDefaults: [{ key: "API_BASE_URL", value: "https://default.example.com", secret: false }],
      shared: [{ key: "LOG_LEVEL", value: "debug", secret: false }],
      privateEntries: [{ key: "LOG_LEVEL", value: "trace", secret: false }],
      task: [{ key: "LOCAL_PORT", value: "5173", secret: false }],
      runtime: [{ key: "PORT", value: "5173", secret: false }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byKey = new Map(result.rows.map((entry) => [entry.key, entry]));
    expect(byKey.get("API_BASE_URL")?.source).toBe("仓库默认配置");
    // Private beats shared.
    expect(byKey.get("LOG_LEVEL")).toMatchObject({ value: "trace", source: "本机私有配置" });
    expect(byKey.get("PORT")?.source).toBe("运行时绑定");
  });
  it("fails closed on missing ${REF}", () => {
    const result = resolveServiceEnv({
      repoDefaults: [],
      shared: [{ key: "DSN", value: "postgres://${MISSING_HOST}/db", secret: false }],
      privateEntries: [],
      task: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("missing-ref");
    expect(result.error.message).toContain("MISSING_HOST");
  });
  it("resolves ${REF} against lower-precedence rows", () => {
    const result = resolveServiceEnv({
      repoDefaults: [{ key: "HOST", value: "db.local", secret: false }],
      shared: [{ key: "DSN", value: "postgres://${HOST}/db", secret: false }],
      privateEntries: [],
      task: [],
    });
    expect(result).toEqual({
      ok: true,
      rows: [
        { key: "HOST", value: "db.local", secret: false, source: "仓库默认配置" },
        { key: "DSN", value: "postgres://db.local/db", secret: false, source: "共享模板" },
      ],
    });
  });
  it("fails closed on duplicate keys within one layer and secrets in shared", () => {
    const dup = resolveServiceEnv({
      repoDefaults: [],
      shared: [
        { key: "A", value: "1", secret: false },
        { key: "A", value: "2", secret: false },
      ],
      privateEntries: [],
      task: [],
    });
    expect(dup.ok).toBe(false);
    const leaked = resolveServiceEnv({
      repoDefaults: [],
      shared: [{ key: "INVOICE_ACCESS_TOKEN", value: "s3cr3t", secret: false }],
      privateEntries: [],
      task: [],
    });
    expect(leaked.ok).toBe(false);
    if (leaked.ok) return;
    expect(leaked.error.code).toBe("secret-in-shared");
  });
});

describe("masking + child env isolation", () => {
  it("masks secrets and never the plain values", () => {
    expect(maskServiceValue({ key: "API_TOKEN", value: "abc", secret: false })).toBe("••••••••");
    expect(maskServiceValue({ key: "LOG_LEVEL", value: "debug", secret: false })).toBe("debug");
    expect(isServiceSecretKey("DB_PASSWORD")).toBe(true);
    expect(isServiceSecretKey("LOG_LEVEL")).toBe(false);
    expect(validateNoSecretsInShared([{ key: "X", value: "1", secret: true }])?.code).toBe("secret-in-shared");
  });
  it("buildChildEnv returns a fresh object per call", () => {
    const rows = [row("A", "1", "共享模板")];
    const first = buildChildEnv(rows);
    const second = buildChildEnv(rows);
    expect(first).toEqual({ A: "1" });
    expect(first).not.toBe(second);
    first["A"] = "mutated";
    expect(second["A"]).toBe("1");
  });
  it("autoAdjustPorts bumps taken PORTs and reports the move", () => {
    const { rows, adjusted } = autoAdjustPorts(
      [row("PORT", "5173", "运行时绑定"), row("LOG_LEVEL", "debug", "共享模板")],
      new Set([5173]),
    );
    expect(rows.find((entry) => entry.key === "PORT")?.value).toBe("5174");
    expect(adjusted).toEqual([{ key: "PORT", before: 5173, after: 5174 }]);
  });
});

describe("import drafts", () => {
  it("classifies long-lived vs prepare vs one-shot", () => {
    expect(classifyImportDraft({ command: "pnpm --filter saas-web dev" }).runType).toBe("long-lived");
    expect(classifyImportDraft({ command: "bun run db:migrate" }).runType).toBe("prepare");
    expect(classifyImportDraft({ command: "node scripts/report.mjs --once" }).runType).toBe("one-shot");
  });
  it("keeps chaining tokens in args so the descriptor validator can reject them", () => {
    const draft = classifyImportDraft({ command: "pnpm dev && pnpm build" });
    expect(draft.program).toBe("pnpm");
    expect(validateServiceDescriptor({ name: draft.name, program: draft.program, args: draft.args, ports: [], runType: draft.runType })?.code).toBe(
      "invalid-service",
    );
  });
  it("audits invalid keys, empty values and secret-looking shared keys", () => {
    const { invalidVars, toVerify } = auditImportVars(
      [
        { key: "1BAD", value: "x" },
        { key: "EMPTY", value: "" },
        { key: "API_TOKEN", value: "abc" },
        { key: "DSN", value: "postgres://${ELSEWHERE}/db" },
      ],
      { sharedDraft: true },
    );
    expect(invalidVars).toEqual(["1BAD"]);
    expect(toVerify.join("\n")).toContain("EMPTY");
    expect(toVerify.join("\n")).toContain("API_TOKEN");
    expect(toVerify.join("\n")).toContain("ELSEWHERE");
  });
});

describe("template diff + versions + restart list", () => {
  it("diffs added/changed/removed with rename as remove+add", () => {
    expect(
      diffServiceTemplate(
        [
          { key: "A", value: "1", secret: false },
          { key: "B", value: "2", secret: false },
        ],
        [
          { key: "A", value: "1", secret: false },
          { key: "B", value: "9", secret: false },
          { key: "C", value: "3", secret: false },
        ],
      ),
    ).toEqual({ added: ["C"], changed: [{ key: "B", before: "2", after: "9" }], removed: [] });
  });
  it("bumps versions and lists restart-needed services", () => {
    expect(nextServiceTemplateVersion("v12")).toBe("v13");
    expect(
      restartNeededForTemplateAdopt(
        [
          { id: "s1", name: "saas-web", templateVersion: "v12" },
          { id: "s2", name: "saas-bff", templateVersion: "v13" },
        ],
        "v13",
      ),
    ).toEqual([{ id: "s1", name: "saas-web", from: "v12", to: "v13" }]);
  });
  it("records per-platform launch verification", () => {
    expect(
      recordPlatformLaunch({ program: "pnpm", args: ["dev"], platform: "darwin-arm64", nodeVersion: "24.21.0", ok: true }),
    ).toMatchObject({ program: "pnpm", platform: "darwin-arm64", ok: true });
  });
});
