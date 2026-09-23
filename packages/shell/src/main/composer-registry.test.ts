import { describe, expect, it } from "vitest";
import {
  BUILTIN_COMMANDS,
  addSkillSource,
  commandAvailability,
  describeUnknownCommand,
  enabledSkillSources,
  listComposerCommands,
  planSkillInvocation,
  searchSkills,
  type ComposerCommand,
  type ComposerRunContext,
  type SkillEntry,
  type SkillSource,
} from "./composer-registry.js";

const sources: SkillSource[] = [
  { id: "src-global", kind: "global", label: "全局 pi/skills", enabled: true },
  { id: "src-project", kind: "project", label: "项目 atlas · .pi/skills", enabled: true },
  { id: "src-task", kind: "task-repo", label: "任务仓库 front-monorepo · .pi/skills", enabled: true },
  { id: "src-off", kind: "project", label: "项目 atlas · 已停用来源", enabled: false },
];

const skills: SkillEntry[] = [
  { id: "sk-1", name: "code-review", description: "审查当前改动", sourceId: "src-global", resourcePath: "skills/code-review/SKILL.md", sideEffecting: true },
  { id: "sk-2", name: "code-review", description: "按项目规则审查", sourceId: "src-project", resourcePath: "skills/code-review/SKILL.md" },
  { id: "sk-3", name: "unit-tests", description: "补写单元测试", sourceId: "src-task", resourcePath: "skills/unit-tests/SKILL.md" },
  { id: "sk-4", name: "hidden", description: "停用来源里的技能", sourceId: "src-off", resourcePath: "skills/hidden/SKILL.md" },
];

const idle: ComposerRunContext = { runState: "idle", permission: "default" };

describe("composer registry rules", () => {
  it("aggregates only enabled sources, in discovery order", () => {
    expect(enabledSkillSources(sources).map((source) => source.id)).toEqual(["src-global", "src-project", "src-task"]);
    const added = addSkillSource(sources, { id: "src-extra", label: "外部技能目录 ~/.agents/skills" });
    expect(added.ok && added.sources.at(-1)).toMatchObject({ kind: "extra", enabled: true });
    expect(addSkillSource(sources, { id: "src-global", label: "重复" })).toMatchObject({ ok: false, code: "duplicate-source" });
  });

  it("searches skills by name or description across enabled sources", () => {
    expect(searchSkills({ sources, skills }, "unit").map((row) => row.name)).toEqual(["unit-tests"]);
    expect(searchSkills({ sources, skills }, "项目规则").map((row) => row.name)).toEqual(["code-review"]);
    // Disabled sources contribute nothing.
    expect(searchSkills({ sources, skills }, "hidden")).toEqual([]);
  });

  it("keeps a duplicated skill name as two source-distinct rows and requires a source choice", () => {
    const rows = searchSkills({ sources, skills }, "code-review");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.sourceId)).toEqual(["src-global", "src-project"]);
    const ambiguous = planSkillInvocation({ sources, skills }, { name: "code-review" });
    expect(ambiguous).toMatchObject({ ok: false, code: "ambiguous-source" });
    expect(!ambiguous.ok && ambiguous.candidates).toHaveLength(2);
    const chosen = planSkillInvocation({ sources, skills }, { name: "code-review", sourceId: "src-project", args: "只看 src/" });
    expect(chosen).toMatchObject({ ok: true, plan: { resourcePath: "skills/code-review/SKILL.md", args: "只看 src/", text: "/skill:code-review 只看 src/", candidateCount: 2 } });
    expect(planSkillInvocation({ sources, skills }, { name: "missing" })).toMatchObject({ ok: false, code: "unknown-skill" });
  });

  it("marks a side-effecting skill so the caller routes it through the permission gate", () => {
    const plan = planSkillInvocation({ sources, skills }, { name: "code-review", sourceId: "src-global" });
    expect(plan.ok && plan.plan.sideEffecting).toBe(true);
    const readOnly = planSkillInvocation({ sources, skills }, { name: "unit-tests" });
    expect(readOnly.ok && readOnly.plan.sideEffecting).toBe(false);
  });

  it("groups the / menu and shows source, args and availability", () => {
    const template: ComposerCommand = {
      name: "/summarize",
      category: "template",
      source: "项目模板 · reviews",
      description: "生成评审摘要",
      args: [{ name: "范围", description: "需要总结的改动范围", required: true }],
      kind: "template",
    };
    const extension: ComposerCommand = { name: "/skill:code-review", category: "extension", source: "pi 扩展 · skills", description: "按技能处理当前请求", kind: "extension" };
    const menu = listComposerCommands([...BUILTIN_COMMANDS, template, extension], "", idle);
    expect(menu.groups.map((group) => group.category)).toEqual(["app", "template", "extension"]);
    const templateRow = menu.groups[1].items[0];
    expect(templateRow).toMatchObject({ source: "项目模板 · reviews", availability: "available" });
    expect(templateRow.args).toHaveLength(1);
    expect(menu.groups[0].items.map((row) => row.command.name)).toEqual(["/new", "/model", "/compact", "/skills", "/session", "/usage", "/help"]);
  });

  it("bounds shortcuts while a round is busy or the session is read-only", () => {
    const busy: ComposerRunContext = { runState: "running", permission: "default" };
    const template: ComposerCommand = { name: "/summarize", category: "template", source: "项目模板", description: "摘要", kind: "template" };
    const model = BUILTIN_COMMANDS.find((command) => command.name === "/model")!;
    const usage = BUILTIN_COMMANDS.find((command) => command.name === "/usage")!;
    const fresh = BUILTIN_COMMANDS.find((command) => command.name === "/new")!;
    expect(commandAvailability(model, busy)).toMatchObject({ availability: "waiting" });
    expect(commandAvailability(fresh, busy)).toMatchObject({ availability: "waiting" });
    expect(commandAvailability(usage, busy)).toMatchObject({ availability: "available" });
    expect(commandAvailability(template, busy)).toMatchObject({ availability: "unavailable" });
    // A read-only session keeps side-effecting shortcuts disabled.
    const readOnly: ComposerRunContext = { runState: "idle", permission: "read" };
    expect(commandAvailability(template, readOnly)).toMatchObject({ availability: "unavailable" });
    expect(commandAvailability(usage, readOnly)).toMatchObject({ availability: "available" });
  });

  it("suggests a correction for an unknown command instead of guessing", () => {
    const known = BUILTIN_COMMANDS.map((command) => command.name);
    expect(describeUnknownCommand("/modle", known)).toMatchObject({ suggestion: "/model" });
    expect(describeUnknownCommand("/zzzzzz", known)).toMatchObject({ suggestion: null });
    expect(describeUnknownCommand("/modle", known).message).toContain("/model");
  });
});
