import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopConversation } from "../components/DesktopConversation";
import { MAX_TEXT_ATTACHMENT_BYTES } from "../data/composerRules";
import type { PidockBridge } from "../data/shellBridge";

/**
 * [PiDock 16] (#16 盒 1) the `+` attachment entry of the shipped desktop
 * composer.
 *
 * The production send path is `window.pidock.sdkTurn` → SDK `session.prompt(text)`:
 * it carries the typed string and nothing else, so an attachment can only ever be
 * page state here. This suite pins both halves of that fact — the picker works and
 * names its own refusals, and no attachment (nor a claim of delivery) reaches the
 * turn payload.
 */

const TASK_ID = "task-attach";
const roots = [{ label: "默认任务根", state: "ready" }];
const association = { taskId: TASK_ID, projectId: null, state: "unassigned" };
const snapshot = (messages: unknown[] = [], pending = false) => ({ source: "sdk-jsonl", sessionId: "main", messages, pending, interrupted: false });

function setup() {
  const calls: Array<Record<string, unknown>> = [];
  let status: unknown = null;
  const bridge: PidockBridge = {
    listTasks: vi.fn(async () => ({ ok: true, payload: { tasks: [{ taskId: TASK_ID, name: "Task", branch: "main", repoCount: 0, updatedAt: "now" }], roots } })),
    projectOp: vi.fn(async (request) => ({ ok: true, payload: request.op === "list" ? { initialized: true, projects: [] } : { roots, tasks: [association] } })),
    onSdkTurnEvent: vi.fn(() => () => {}),
    providerOp: vi.fn(async () => ({ ok: true, payload: { state: "not-configured", profileId: null, generation: null, profiles: [] } })),
    sdkTurn: vi.fn(async (request) => {
      calls.push(request);
      if (request.action === "subscribe") return { ok: true, payload: { taskId: TASK_ID, sessionId: "main", snapshot: snapshot(), turn: status } };
      if (request.action === "projection") return { ok: true, payload: snapshot() };
      if (request.action === "status") return { ok: true, payload: { turn: status } };
      if (request.action === "start") {
        status = { taskId: TASK_ID, sessionId: "main", requestId: request.requestId, turnId: request.requestId, state: "accepted", needsResync: false };
        return { ok: true, payload: { turn: status } };
      }
      return { ok: true, payload: { unsubscribed: true } };
    }),
  };
  window.pidock = bridge;
  render(<DesktopConversation taskId={TASK_ID} name="Task" roots={JSON.stringify(roots)} association={JSON.stringify(association)} onBack={vi.fn()} onOpenProviders={vi.fn()} onArchived={vi.fn()} />);
  return { calls, bridge };
}

const attachEntry = () => screen.getByTestId("desktop-composer-attach");
const fileInput = () => screen.getByTestId("desktop-composer-file-input") as HTMLInputElement;
const selectFiles = (files: File[]) => fireEvent.change(fileInput(), { target: { files } });

/** Names of the visible attachment rows, in order. */
function attachmentNames(): string[] {
  return screen.queryAllByTestId("desktop-composer-attachment-name").map((name) => name.textContent?.trim() ?? "");
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete window.pidock;
  vi.restoreAllMocks();
});

describe("[PiDock 16] (#16 盒 1) 桌面输入区附件入口", () => {
  it("opens the system file picker from a usable `+` entry and lists the chosen file", async () => {
    const fixture = setup();
    await screen.findByText(/尚未开始/);

    // The entry is real now: clickable, wired to a multi-select file input.
    expect(attachEntry()).toBeEnabled();
    expect(fileInput()).toHaveAttribute("multiple");
    const openPicker = vi.spyOn(HTMLInputElement.prototype, "click");
    fireEvent.click(attachEntry());
    expect(openPicker).toHaveBeenCalledTimes(1);

    selectFiles([new File(["note"], "notes.md", { type: "text/markdown" })]);

    const row = await screen.findByTestId("desktop-composer-attachment");
    expect(row).toHaveTextContent("notes.md");
    expect(row).toHaveTextContent("1 KB");
    expect(fixture.calls.filter((call) => call.action === "start")).toEqual([]);
  });

  it("keeps a multi-selection as separate rows, distinguishes duplicate names, and removes each row", async () => {
    const fixture = setup();
    await screen.findByText(/尚未开始/);

    selectFiles([
      new File(["one"], "notes.md", { type: "text/markdown" }),
      new File(["two"], "notes.md", { type: "text/markdown" }),
      new File(["png"], "shot.png", { type: "image/png" }),
    ]);

    await screen.findByTestId("desktop-composer-attachments");
    // Two same-named files stay two rows with two names a user can tell apart.
    expect(attachmentNames()).toEqual(["notes.md", "notes.md（2）", "shot.png"]);

    fireEvent.click(screen.getByRole("button", { name: "移除附件 notes.md（2）" }));
    await waitFor(() => expect(attachmentNames()).toEqual(["notes.md", "shot.png"]));

    fireEvent.click(screen.getByRole("button", { name: "移除附件 shot.png" }));
    await waitFor(() => expect(attachmentNames()).toEqual(["notes.md"]));

    fireEvent.click(screen.getByRole("button", { name: "移除附件 notes.md" }));
    await waitFor(() => expect(screen.queryByTestId("desktop-composer-attachments")).not.toBeInTheDocument());
    expect(fixture.calls.filter((call) => call.action === "start")).toEqual([]);
  });

  it("adds no attachment when the selection is cancelled", async () => {
    setup();
    await screen.findByText(/尚未开始/);

    selectFiles([]);

    expect(screen.queryByTestId("desktop-composer-attachments")).not.toBeInTheDocument();
    expect(screen.queryByTestId("desktop-composer-attachment-report")).not.toBeInTheDocument();
  });

  it("refuses an oversized or unsupported file by name and keeps it out of the draft", async () => {
    const fixture = setup();
    await screen.findByText(/尚未开始/);

    selectFiles([
      new File(["png"], "shot.png", { type: "image/png" }),
      new File([new Uint8Array(MAX_TEXT_ATTACHMENT_BYTES + 1)], "huge.log", { type: "text/plain" }),
      new File(["bin"], "archive.zip", { type: "application/zip" }),
    ]);

    const report = await screen.findByTestId("desktop-composer-attachment-report");
    expect(report).toHaveTextContent("已加入 1 个，拒绝 2 个");
    // Named refusal: the file and the reason, not a swallowed selection.
    expect(report).toHaveTextContent("huge.log");
    expect(report).toHaveTextContent("超过上限 1MB");
    expect(report).toHaveTextContent("archive.zip");
    expect(report).toHaveTextContent("不支持的类型 application/zip");
    // The refused files never became rows.
    expect(attachmentNames()).toEqual(["shot.png"]);
    expect(fixture.calls.filter((call) => call.action === "start")).toEqual([]);
  });

  it("states on every row and on the strip that the attachment is page-only and never reaches the Agent", async () => {
    const fixture = setup();
    await screen.findByText(/尚未开始/);

    selectFiles([new File(["note"], "notes.md", { type: "text/markdown" })]);

    const row = await screen.findByTestId("desktop-composer-attachment");
    const rowText = row.textContent ?? "";
    // `attachmentSourceLabel()` owns this sentence; the row repeats no other claim.
    expect(rowText).toContain("仅本页保留");
    expect(rowText).toContain("内容不上传、不读取");
    expect(rowText).toContain("附件不会发给 Agent");
    const scope = screen.getByTestId("desktop-composer-attachment-scope");
    expect(scope).toHaveTextContent("附件不会发给 Agent");
    // No delivered/uploaded wording anywhere in the attachment area.
    const strip = screen.getByTestId("desktop-composer-attachments");
    expect(strip).not.toHaveTextContent(/已上传|已发送给|Agent 会看到/);

    // The turn payload is the typed string and nothing else.
    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: "请看附件" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByRole("button", { name: "停止" });
    const start = fixture.calls.find((call) => call.action === "start");
    expect(start).toBeDefined();
    expect(Object.keys(start!).sort()).toEqual(["action", "requestId", "sessionId", "taskId", "text"]);
    expect(start!.text).toBe("请看附件");
    const receipt = JSON.parse(localStorage.getItem("pidock-sdk-main-pending-v1:task-attach") ?? "{}") as Record<string, unknown>;
    expect(Object.keys(receipt).sort()).toEqual(["requestId", "schema", "sessionId", "taskId", "text"]);
    expect(receipt.text).toBe("请看附件");
  });

  it("names the scope before any file is chosen, in the `+` tooltip", async () => {
    setup();
    await screen.findByText(/尚未开始/);

    const user = userEvent.setup();
    await user.click(screen.getByRole("textbox", { name: "消息" }));
    await user.tab();
    const explanation = screen.getByLabelText("附件说明");
    expect(explanation).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("附件只在本页输入区保留：内容不上传、不读取，附件不会发给 Agent（当前 SDK 发送路径只发送文本）");
    expect(explanation).toHaveAccessibleDescription("附件只在本页输入区保留：内容不上传、不读取，附件不会发给 Agent（当前 SDK 发送路径只发送文本）");
  });
});
