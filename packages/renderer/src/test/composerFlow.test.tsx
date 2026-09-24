import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp } from "./helpers";
import { useDraftStore } from "../stores/drafts";
import { checkDraftReference, describeReferenceChip } from "../data/composerRules";
import { createMemoryHost, seededWorktreeCommit } from "../data/memoryHost";
import { sessionKeyOf } from "../data/sessionKey";

/**
 * [PiDock 13] (#16) composer behaviour through the real input box: one "+"
 * attachment entry (no permanent @/$/ buttons), the model selector before
 * the send button, keyboard-driven candidates that never send on confirm,
 * IME composition that never submits, a mixed message (text + file
 * reference + skill) and a draft reference that is re-checked on restore.
 *
 * [UI 对齐 06] (#30) renamed the entries to the prototype's own wording (the
 * input is 给 Agent 的消息, the entry is 添加文件) and turned the send control
 * into the prototype's accent square: its accessible name is still 发送消息.
 */
describe("composer references, skills and commands", () => {
  it("keeps only the + attachment entry and puts the model picker before send", async () => {
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    const composer = screen.getByLabelText("给 Agent 的消息").closest("form")!;
    expect(within(composer).getByRole("button", { name: "添加文件" })).toBeInTheDocument();
    // The prototype's permanent symbol buttons are gone; completion still works.
    expect(within(composer).queryByRole("button", { name: "@" })).not.toBeInTheDocument();
    expect(within(composer).queryByRole("button", { name: "$" })).not.toBeInTheDocument();
    expect(within(composer).queryByRole("button", { name: "/" })).not.toBeInTheDocument();
    expect(within(composer).queryByRole("button", { name: "+ 引用文件" })).not.toBeInTheDocument();
    const buttons = within(composer).getAllByRole("button");
    const modelIndex = buttons.findIndex((button) => (button.getAttribute("aria-label") ?? "").startsWith("选择模型："));
    const sendIndex = buttons.findIndex((button) => button.getAttribute("aria-label") === "发送消息");
    expect(modelIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeGreaterThan(modelIndex);
  });

  it("confirms a candidate with the keyboard without sending, and sends with Enter", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    const input = screen.getByLabelText("给 Agent 的消息");

    await user.type(input, "/comp");
    await screen.findByRole("listbox", { name: "输入候选" });
    await user.keyboard("{Enter}");
    // Candidate confirmed: the app command ran (compaction toast) and no message was sent.
    expect(await screen.findByText("已压缩上下文；占用标记为待更新，累计 Token 保留")).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(screen.queryByText("正在执行")).not.toBeInTheDocument();

    // A plain Enter sends the typed message.
    await user.type(input, "修复构建");
    await user.keyboard("{Enter}");
    // The plain message was sent (the run settles and clears the draft).
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""), { timeout: 6000 });
  });

  it("keeps a mixed draft (text + file reference + skill) and never treats IME confirm as send", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    const input = screen.getByLabelText("给 Agent 的消息");

    await user.type(input, "看下 @api");
    const at = await screen.findByRole("listbox", { name: "输入候选" });
    await user.click(within(at).getAllByRole("option")[0]!);
    expect((await screen.findAllByText(/引用 · /)).length).toBeGreaterThan(0);
    // The `@` pick pins the worktree commit the candidate carried, so a
    // restored draft can be re-checked instead of silently re-binding.
    const fileReference = useDraftStore.getState().drafts[sessionKeyOf("release", "main")]!.references.find((reference) => reference.relativePath !== undefined)!;
    expect(fileReference).toMatchObject({ sourceId: "front-monorepo", sourceKind: "worktree", version: seededWorktreeCommit });
    const task = (await createMemoryHost().getTask("release"))!;
    expect(checkDraftReference(fileReference, task)).toEqual({ state: "ok" });

    await user.type(input, "$code");
    const dollar = await screen.findByRole("listbox", { name: "输入候选" });
    await user.click(within(dollar).getAllByRole("option")[0]!);
    expect(screen.getAllByText(/code-review/).length).toBeGreaterThan(0);
    expect((screen.getByLabelText("给 Agent 的消息") as HTMLTextAreaElement).value).toContain("$code-review");
    // The `$` pick records the skill's source id and resource path instead of
    // a bare label, and the scope chip shows the resource path.
    const skillReference = useDraftStore.getState().drafts[sessionKeyOf("release", "main")]!.references.find((reference) => reference.kind === "skill")!;
    expect(skillReference).toMatchObject({ sourceId: "cap-1", resourcePath: "skills/code-review/SKILL.md" });
    expect(describeReferenceChip(skillReference)).toContain("skills/code-review/SKILL.md");

    // IME composition confirm must not submit anything. jsdom has no real
    // composition, so the keydown carries `isComposing` directly (the pure
    // rule is unit-tested above).
    await user.type(input, "中文");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect((screen.getByLabelText("给 Agent 的消息") as HTMLTextAreaElement).value).toContain("中文");
    expect(screen.queryByText("正在执行")).not.toBeInTheDocument();
  });

  it("re-checks a restored draft reference and asks for a new selection", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    // Seed a draft reference whose file no longer exists in the task.
    await act(async () => {
      useDraftStore.setState({
        drafts: {
          [sessionKeyOf("release", "main")]: {
            text: "继续处理",
            references: [
              {
                id: "ref-moved",
                kind: "file",
                label: "front-monorepo/src/gone.ts",
                detail: "front-monorepo · 任务代码引用",
                taskId: "release",
                sourceId: "front-monorepo",
                sourceKind: "worktree",
                relativePath: "src/gone.ts",
              },
              {
                id: "ref-attach",
                kind: "attachment",
                label: "shot.png",
                detail: "图片附件 · 仅 shot.png 本身",
                previewUrl: "blob:demo",
              },
            ],
          },
        },
      });
    });
    await waitFor(() => expect(screen.getByTestId("composer-reference-ref-moved")).toBeInTheDocument());
    expect(screen.getByText(/失效 · front-monorepo\/src\/gone\.ts/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新选择 front-monorepo/src/gone.ts" }));
    await waitFor(() => expect(screen.queryByTestId("composer-reference-ref-moved")).not.toBeInTheDocument());
    expect(await screen.findByText(/请重新输入 @ 或 \$ 选择来源/)).toBeInTheDocument();
  });

  it("shows a reference's actual scope on demand", async () => {
    const user = userEvent.setup();
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    await act(async () => {
      useDraftStore.setState({
        drafts: {
          [sessionKeyOf("release", "main")]: {
            text: "",
            references: [
              { id: "ref-scope", kind: "file", label: "front-monorepo/src/checkout/api.ts", detail: "front-monorepo · 任务代码引用", taskId: "release", sourceId: "front-monorepo", sourceKind: "worktree", relativePath: "src/checkout/api.ts", version: seededWorktreeCommit },
            ],
          },
        },
      });
    });
    await waitFor(() => expect(screen.getByTestId("composer-reference-ref-scope")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "查看范围 front-monorepo/src/checkout/api.ts" }));
    expect(screen.getByTestId("composer-reference-scope")).toHaveTextContent("不计入实报 Token");
  });
});
