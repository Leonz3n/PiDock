/**
 * [Pencil T16] #151 · S09 Skills pane states.
 *
 * jsdom has no layout, so the 900/560 contract is asserted on the tier classes
 * the pane uses (`below-mid` = max-width 960px, `below-stack` = max-width
 * 720px): the add row stacks at 560 and the source rows keep their actions
 * visible at 900. Every visible state comes from the injected view — no static
 * card is asserted, and an empty list says it is empty.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopSkills } from "../components/DesktopSkills";
import type { PidockBridge } from "../data/shellBridge";
import type { SkillSourcesView } from "../data/skillSources";

afterEach(() => { cleanup(); delete (window as { pidock?: unknown }).pidock; });

const SOURCE_A = "src-11111111";
const SOURCE_B = "src-22222222";
const SOURCE_MISSING = "src-33333333";
const SOURCE_BROKEN = "src-44444444";

function view(overrides?: Partial<SkillSourcesView>): SkillSourcesView {
  return {
    state: "ok",
    file: "/profile/skill-sources.json",
    sources: [
      {
        id: SOURCE_A, path: "/Users/me/skills", enabled: true, status: "ok", diagnostics: [],
        skills: [{
          key: `${SOURCE_A}::pdf-tools`, name: "pdf-tools", description: "Extract text from PDFs. Use when inspecting a PDF.",
          sourceId: SOURCE_A, sourcePath: "/Users/me/skills", skillFile: "/Users/me/skills/pdf-tools/SKILL.md",
          skillDir: "/Users/me/skills/pdf-tools", status: "ok", duplicates: [`${SOURCE_B}::pdf-tools`],
          resources: [{ path: "references/format.md", bytes: 42 }],
        }],
      },
      {
        id: SOURCE_B, path: "/Users/me/more-skills", enabled: true, status: "ok", diagnostics: [],
        skills: [{
          key: `${SOURCE_B}::pdf-tools`, name: "pdf-tools", description: "Second source, different instructions.",
          sourceId: SOURCE_B, sourcePath: "/Users/me/more-skills", skillFile: "/Users/me/more-skills/pdf-tools/SKILL.md",
          skillDir: "/Users/me/more-skills/pdf-tools", status: "ok", duplicates: [`${SOURCE_A}::pdf-tools`], resources: [],
        }],
      },
      { id: SOURCE_MISSING, path: "/Users/me/gone", enabled: true, status: "missing", message: "来源目录不存在或不是目录", skills: [], diagnostics: [] },
      {
        id: SOURCE_BROKEN, path: "/Users/me/broken", enabled: false, status: "disabled", skills: [], diagnostics: [],
      },
    ],
    ...overrides,
  };
}

function harness(initial: SkillSourcesView) {
  let current = initial;
  const skillsOp = vi.fn(async (request: Record<string, unknown>) => {
    if (request["op"] === "list") return { ok: true, payload: current };
    if (request["op"] === "add") {
      current = { ...current, sources: [...current.sources, { id: "src-55555555", path: String(request["path"]), enabled: true, status: "ok", skills: [], diagnostics: [] }] };
      return { ok: true, payload: current };
    }
    if (request["op"] === "setEnabled") {
      current = { ...current, sources: current.sources.map((source) => (source.id === request["id"] ? { ...source, enabled: request["enabled"] === true } : source)) };
      return { ok: true, payload: current };
    }
    return { ok: true, payload: current };
  });
  const bridge: PidockBridge = { skillsOp };
  return { bridge, skillsOp };
}

describe("Skills pane (S09 · #151)", () => {
  it("renders the real scan: descriptions, source paths, resources, duplicates and named failures", async () => {
    const { bridge } = harness(view());
    const { container } = render(<DesktopSkills bridge={bridge} />);
    const pane = await screen.findByTestId("skills-pane");

    await waitFor(() => expect(pane.querySelectorAll("[data-testid^='skill-source-']")).toHaveLength(4));
    // Two rows for one name, each naming the other source instead of substituting it.
    expect(screen.getAllByText("pdf-tools")).toHaveLength(2);
    expect(screen.getByTestId(`skill-duplicate-${SOURCE_A}::pdf-tools`)).toHaveTextContent("/Users/me/more-skills");
    expect(screen.getByTestId(`skill-file-${SOURCE_A}::pdf-tools`)).toHaveTextContent("/Users/me/skills/pdf-tools/SKILL.md");
    expect(screen.getByTestId(`skill-resources-${SOURCE_A}::pdf-tools`)).toHaveTextContent("references/format.md (42 B)");
    expect(screen.getByText("Extract text from PDFs. Use when inspecting a PDF.")).toBeInTheDocument();
    // A disappeared source is named, not hidden; a disabled one is not `ok`.
    expect(within(screen.getByTestId(`skill-source-${SOURCE_MISSING}`)).getByText("来源缺失")).toBeInTheDocument();
    expect(within(screen.getByTestId(`skill-source-${SOURCE_MISSING}`)).getByText(/来源目录不存在/)).toBeInTheDocument();
    expect(within(screen.getByTestId(`skill-source-${SOURCE_BROKEN}`)).getAllByText("已停用").length).toBeGreaterThan(0);
    expect(screen.getByTestId("skills-counts")).toHaveTextContent("4 个来源 · 3 启用 · 1 异常 · 2 个技能");
    expect(screen.getByText(/技能说明只在会话开始注入一次/)).toBeInTheDocument();

    // 900px: the source row keeps its actions next to the path (`below-mid` tier).
    const row = screen.getByTestId(`skill-source-${SOURCE_A}`);
    expect(row.firstElementChild?.className).toContain("flex-wrap");
    // 560px: the add form stacks to one column (`below-stack` tier).
    const form = container.querySelector("form");
    expect(form?.className).toContain("below-stack:grid-cols-1");
  });

  it("adds a directory and toggles a source through main's named ops", async () => {
    const { bridge, skillsOp } = harness(view());
    render(<DesktopSkills bridge={bridge} />);
    await screen.findByTestId("skills-pane");
    await waitFor(() => expect(screen.getByTestId(`skill-source-${SOURCE_A}`)).toBeInTheDocument());

    fireEvent.change(screen.getByTestId("skills-add-path"), { target: { value: "/Users/me/new-skills" } });
    fireEvent.click(screen.getByTestId("skills-add-submit"));
    await waitFor(() => expect(skillsOp).toHaveBeenCalledWith({ op: "add", path: "/Users/me/new-skills" }));
    await waitFor(() => expect(screen.getByText("/Users/me/new-skills")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId(`skill-toggle-${SOURCE_A}`));
    await waitFor(() => expect(skillsOp).toHaveBeenCalledWith({ op: "setEnabled", id: SOURCE_A, enabled: false }));
    await waitFor(() => expect(within(screen.getByTestId(`skill-source-${SOURCE_A}`)).getByText("启用")).toBeInTheDocument());
  });

  it("says the list is empty and names a corrupt document instead of showing sample cards", async () => {
    const empty = harness(view({ state: "empty", sources: [] }));
    const { unmount } = render(<DesktopSkills bridge={empty.bridge} />);
    expect(await screen.findByTestId("skills-empty")).toHaveTextContent("还没有添加本地技能来源");
    expect(screen.getByTestId("skills-counts")).toHaveTextContent("0 个来源");
    unmount();

    const corrupt = harness(view({ state: "invalid", sources: [], message: "配置不是合法 JSON" }));
    render(<DesktopSkills bridge={corrupt.bridge} />);
    expect(await screen.findByTestId("skills-config-invalid")).toHaveTextContent("配置不是合法 JSON");
    expect(screen.getByText(/不会用空白配置覆盖/)).toBeInTheDocument();
  });

  it("refuses to pretend it is wired when the shell bridge is absent", async () => {
    render(<DesktopSkills bridge={{}} />);
    expect(await screen.findByTestId("skills-error")).toHaveTextContent("Skills 来源尚未接线");
    expect(screen.queryAllByTestId(/skill-source-/)).toHaveLength(0);
  });
});
