import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopConversation } from "../components/DesktopConversation";
import type { PidockBridge } from "../data/shellBridge";
// The SHIPPED Host rules build this suite's payloads (`main/workspace-files.ts`
// is pure: no fs, no git, no Electron), so the roots, the per-view attribution
// and the plain-directory refusal below are the Host's own words and shapes.
import { deliveryTarget, workspaceAttribution, workspaceRoots } from "../../../shell/src/main/workspace-files.js";

/**
 * [PiDock 15] (#15 盒 3) 文件引用 in the PRODUCTION desktop input area.
 *
 * The reference is inserted from the shipped 文件 panel (`DesktopToolDock`
 * `FilesTool`) into the shipped desktop composer (`DesktopConversation`), so
 * both surfaces under test are the ones the app mounts. Each test drives the
 * real Host reads (`task/fileRoots|fileTree|filePreview|deliveryInfo`) and
 * asserts what the chip says about its SOURCE, never a hand-written claim:
 * a worktree reference and a plain-directory reference must stay
 * distinguishable, and attaching one must not add a single write op.
 */

const TASK_ID = "task-1";
const TASK_DIR = "/tmp/task-1";
const SHARED_LINK = "invoice-docs";
const SHARED_SOURCE = "/work/invoice-docs";
const FILE = "invoice.md";

const roots = [{ label: "默认任务根", state: "ready" }];
const association = { taskId: TASK_ID, projectId: null, state: "unassigned" };
const emptySnapshot = { source: "sdk-jsonl", sessionId: "main", messages: [], pending: false, interrupted: false };

/**
 * Every op this suite may see: reads only — #15's own file reads, the composer's
 * `task/sessionContext` readout and the #24 execution-status read.
 */
const READ_ONLY_OPS = ["task/fileRoots", "task/fileTree", "task/filePreview", "task/fileDiff", "task/deliveryInfo", "task/sessionContext", "task/executionState"];
/** The write ops a reference must never cause (box 4 of this slice). */
const WRITE_OPS = ["task/runTaskService", "task/serviceStopScope", "task/controlService", "task/quit", "task/archive", "task/restore", "task/sendMessage", "task/registerService"];

/** A task with one worktree root, built by the shipped Host rule. */
const worktreeRoots = () =>
  workspaceRoots({
    taskId: TASK_ID,
    taskDir: TASK_DIR,
    repos: ["repo-a"],
    repoSources: [{ repoDir: "repo-a", remoteBranch: "release/v2", baseCommit: "aaaa1111" }],
  });

/** A task whose only root is a plain-directory link, built by the shipped Host rule. */
const linkRoots = () =>
  workspaceRoots({
    taskId: TASK_ID,
    taskDir: TASK_DIR,
    repos: [],
    dirLinks: [{ linkName: SHARED_LINK, directoryId: "dir-9f2a", sourcePath: SHARED_SOURCE }],
  });

/** The Host's answers for one set of roots, scoped to the asked `rootId`. */
const hostReads =
  (fileRoots: ReturnType<typeof workspaceRoots>) =>
  async (_taskId: string, op: string, payload: Record<string, unknown> = {}) => {
    const root = fileRoots.find((entry) => entry.id === payload["rootId"]) ?? fileRoots[0]!;
    const view = workspaceAttribution(root, TASK_ID, TASK_DIR);
    if (op === "task/fileRoots") return { ok: true, payload: { taskDir: TASK_DIR, roots: fileRoots } };
    if (op === "task/fileTree") {
      return { ok: true, payload: { tree: { attribution: view, path: "", entries: [{ name: FILE, path: FILE, kind: "file", size: 3 }], truncated: false } } };
    }
    if (op === "task/filePreview") {
      return { ok: true, payload: { preview: { attribution: view, path: FILE, language: "markdown", source: "# 内容", truncated: false, lineCount: 1 } } };
    }
    if (op === "task/deliveryInfo") {
      const target = deliveryTarget({ root, taskId: TASK_ID, taskDir: TASK_DIR });
      return target.ok ? { ok: true, payload: { target: target.target } } : { ok: false, error: target.error };
    }
    return { ok: false, error: `unexpected ${op}` };
  };

/** The production desktop bridge: the real task reads plus the SDK session. */
function setup(read: ReturnType<typeof hostReads>) {
  const calls: Array<Record<string, unknown>> = [];
  const taskOp = vi.fn(read);
  const bridge: PidockBridge = {
    listTasks: vi.fn(async () => ({ ok: true, payload: { tasks: [{ taskId: TASK_ID, name: "Task", branch: "main", repoCount: 1, updatedAt: "now" }], roots } })),
    projectOp: vi.fn(async (request) => ({ ok: true, payload: request.op === "list" ? { initialized: true, projects: [] } : { roots, tasks: [association] } })),
    onSdkTurnEvent: vi.fn(() => () => {}),
    providerOp: vi.fn(async () => ({ ok: true, payload: { state: "not-configured", profileId: null, generation: null, profiles: [] } })),
    sdkTurn: vi.fn(async (request) => {
      calls.push(request);
      if (request.action === "subscribe") return { ok: true, payload: { taskId: TASK_ID, sessionId: "main", snapshot: emptySnapshot } };
      return { ok: true, payload: emptySnapshot };
    }),
    taskOp,
  };
  window.pidock = bridge;
  render(<DesktopConversation taskId={TASK_ID} name="Task" branch="task/main" repoCount={1} roots={JSON.stringify(roots)} association={JSON.stringify(association)} onBack={vi.fn()} onOpenProviders={vi.fn()} onArchived={vi.fn()} />);
  return { bridge, calls, taskOp };
}

/** Open the shipped 文件 panel and preview the one file it lists. */
async function openAndPreview() {
  fireEvent.click(screen.getByRole("button", { name: "文件" }));
  fireEvent.click(await screen.findByText(FILE));
  await screen.findByTestId("dock-preview-attribution");
}

/** The entry under test, used on the file the panel is previewing now. */
const clickReference = () => fireEvent.click(screen.getByRole("button", { name: "引用到对话" }));

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete window.pidock;
  vi.restoreAllMocks();
});

describe("[PiDock 15] (#15 盒 3) 文件引用在桌面输入区", () => {
  it("puts a worktree file reference in the composer with its root name and source", async () => {
    const fixture = setup(hostReads(worktreeRoots()));
    await screen.findByText(/尚未开始/);

    await openAndPreview();
    clickReference();

    const chip = await screen.findByTestId("composer-file-reference-task-file:repo-a:invoice.md");
    // The reference's own identity: the source root + the in-source relative path.
    expect(chip).toHaveTextContent("repo-a/invoice.md");
    // A worktree reference names its kind, and says 版本未记录 instead of pinning
    // a commit this panel never read (it runs no Git command).
    expect(chip).toHaveAttribute("data-source-kind", "worktree");
    expect(chip).toHaveTextContent("worktree");
    expect(chip).toHaveTextContent("版本未记录");
    expect(chip).toHaveTextContent("任务代码引用");
    expect(chip).not.toHaveTextContent("普通目录");
    // Nothing was sent: a reference is page state, not a turn.
    expect(fixture.calls.filter((call) => call.action === "start")).toEqual([]);
  });

  it("keeps a plain-directory reference distinguishable, with the original target and the write-through note", async () => {
    const fixture = setup(hostReads(linkRoots()));
    await screen.findByText(/尚未开始/);

    await openAndPreview();
    clickReference();

    const chip = await screen.findByTestId(`composer-file-reference-task-file:${SHARED_LINK}:invoice.md`);
    expect(chip).toHaveAttribute("data-source-kind", "plain-dir");
    expect(chip).toHaveTextContent(`${SHARED_LINK}/invoice.md`);
    // The link is named as what it is: no Git version, and an edit reaches the original files.
    expect(chip).toHaveTextContent("普通目录链接");
    expect(chip).toHaveTextContent("无 Git 版本");
    expect(chip).toHaveTextContent("修改影响原文件");
    // The original target the Host recorded for this link.
    expect(chip).toHaveTextContent(SHARED_SOURCE);
    // A plain directory is never presented as a worktree reference.
    expect(chip).not.toHaveTextContent("worktree");
    expect(chip).not.toHaveTextContent("版本未记录");
    expect(fixture.calls.filter((call) => call.action === "start")).toEqual([]);
  });

  it("attaches and removes the reference without adding a write op", async () => {
    const fixture = setup(hostReads(worktreeRoots()));
    await screen.findByText(/尚未开始/);
    await openAndPreview();
    // The panel's own reads are the baseline: they are the only ops allowed
    // before and after the reference action.
    const before = fixture.taskOp.mock.calls.length;

    clickReference();
    await screen.findByTestId("composer-file-reference-task-file:repo-a:invoice.md");

    // The reference action added NO op of any kind, read or write.
    expect(fixture.taskOp.mock.calls.length).toBe(before);
    // Everything this panel ever asked for is a read, and no write op appears.
    const ops = fixture.taskOp.mock.calls.map((call) => String(call[1]));
    expect(ops.every((op) => READ_ONLY_OPS.includes(op))).toBe(true);
    expect(ops.filter((op) => WRITE_OPS.includes(op))).toEqual([]);
    expect((fixture.bridge as { serviceCatalogOp?: unknown }).serviceCatalogOp).toBeUndefined();
    expect(fixture.calls.filter((call) => call.action === "start")).toEqual([]);

    // Removing it is page state too.
    const afterReference = fixture.taskOp.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /移除引用 repo-a\/invoice\.md/ }));
    await waitFor(() => expect(screen.queryByTestId("composer-file-reference-task-file:repo-a:invoice.md")).not.toBeInTheDocument());
    expect(fixture.taskOp.mock.calls.length).toBe(afterReference);
  });
});
