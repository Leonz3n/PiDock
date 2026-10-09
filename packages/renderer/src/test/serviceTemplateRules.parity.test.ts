import { describe, expect, it } from "vitest";
import {
  resolveServiceEnv,
  validateServiceDescriptor,
  validateSharedServiceWorkdir,
  type ServiceConfigError,
  type ServiceDescriptor,
} from "../../../shell/src/main/service-config.js";
import {
  servicePortsFromDraft,
  validateServiceTemplateDraft,
  validateServiceWorkdir,
  type ServiceTemplateDraft,
} from "../data/serviceTemplateRules";

/**
 * Renderer/shell shared-template rule parity.
 *
 * The renderer mirror (`data/serviceTemplateRules.ts`) exists because the page
 * cannot import the shell module (no Node capability); main still re-validates
 * every save, so this test locks the *messages and codes* the page shows
 * against the shell rule source itself. Importing the shell rule module is a
 * test-only read of a pure module - it hands the page no capability.
 */
const shellRefusal = (draft: ServiceTemplateDraft): ServiceConfigError | null => {
  const descriptor: ServiceDescriptor = { name: draft.name, program: draft.program, args: draft.args, ports: draft.ports, runType: draft.runType,
    ...(draft.healthCheck === undefined ? {} : { healthCheck: draft.healthCheck }) };
  const described = validateServiceDescriptor(descriptor);
  if (described) return described;
  const workdir = draft.workdir === undefined ? null : validateSharedServiceWorkdir(draft.workdir);
  if (workdir) return workdir;
  const shared = draft.shared.map((row) => ({ key: row.key, value: row.value, secret: false }));
  const resolved = resolveServiceEnv({ repoDefaults: [], shared, privateEntries: [], task: [] });
  if (resolved.ok) return null;
  return resolved.error.code === "missing-ref" ? null : resolved.error;
};

const base: ServiceTemplateDraft = { name: "API", program: "node", args: ["server.js"], ports: [3000], runType: "long-lived", shared: [] };

describe("renderer mirror of the shared-template rules", () => {
  it("returns the shell's own code and message for every refusal class", () => {
    const cases: ServiceTemplateDraft[] = [
      base,
      { ...base, program: "" },
      { ...base, program: "pnpm dev" },
      { ...base, program: "PORT=3000" },
      { ...base, program: "pnpm", args: ["dev", "&&", "pnpm", "build"] },
      { ...base, name: "  " },
      { ...base, ports: [0] },
      { ...base, ports: [70000] },
      { ...base, healthCheck: { kind: "udp" as "http" } },
      { ...base, workdir: "/Users/name/tasks/task-1/apps/api" },
      { ...base, workdir: "~/app" },
      { ...base, workdir: "C:\\app" },
      { ...base, workdir: "\\\\host\\share" },
      { ...base, workdir: "apps\\api" },
      { ...base, workdir: "../outside" },
      { ...base, workdir: "apps/../api" },
      { ...base, workdir: "apps//api" },
      { ...base, workdir: "apps/api" },
      { ...base, workdir: "apps/api-token" },
      { ...base, workdir: "a".repeat(513) },
      { ...base, shared: [{ key: "1BAD", value: "x" }] },
      { ...base, shared: [{ key: " 1BAD ", value: "x" }] },
      { ...base, shared: [{ key: "PORT", value: "3000" }, { key: " PORT ", value: "4000" }] },
      { ...base, shared: [{ key: "API_TOKEN", value: "x" }] },
      { ...base, shared: [{ key: "PORT", value: "3000" }] },
    ];
    for (const draft of cases) {
      const shell = shellRefusal(draft);
      const mirrored = validateServiceTemplateDraft(draft);
      expect({ draft, mirrored }).toEqual({ draft, mirrored: shell === null ? null : { code: shell.code, message: shell.message } });
    }
    expect(cases.map((draft) => validateServiceTemplateDraft(draft)?.message)).toContain("启动程序不能携带内联环境赋值（PORT=3000）；请把变量写入环境层，程序与参数分开填写");
    expect(cases.map((draft) => validateServiceTemplateDraft(draft)?.message)).toContain("工作目录必须是仓库内相对目录，不能是本机绝对路径");
    expect(cases.map((draft) => validateServiceTemplateDraft(draft)?.message)).toContain("共享模板不能包含凭据「API_TOKEN」；请移入本机私有配置");
  });

  it("accepts a portable workdir exactly where the shell rule does", () => {
    for (const value of ["apps/api", "a/b/c", "apps/api.v2", "中/目录"]) {
      expect(validateServiceWorkdir(value)).toBeNull();
      expect(validateSharedServiceWorkdir(value)).toBeNull();
    }
  });

  it("names the port field problem the rule layer would return for a numeric part", () => {
    expect(servicePortsFromDraft("3000, 4100")).toEqual({ ports: [3000, 4100] });
    expect(servicePortsFromDraft("")).toEqual({ ports: [] });
    const outOfRange = servicePortsFromDraft("70000");
    expect("error" in outOfRange && outOfRange.error).toEqual(validateServiceDescriptor({ ...base, ports: [70000] }));
  });
});
