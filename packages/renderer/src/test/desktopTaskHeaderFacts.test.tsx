import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App } from "../App";
import { DesktopConversation } from "../components/DesktopConversation";
import type { PidockBridge } from "../data/shellBridge";

/**
 * #24 the task workspace header's branch / repository-count chips.
 *
 * `listTasks` already answers both facts per task (`data/desktopInventory.ts`
 * `DesktopTaskSummary`), and the sidebar card built from that row renders them
 * (`DesktopShell.tsx` `TaskNavCard`). The workspace header — the one screen a
 * reader works in — showed neither, so "which branch is this task on, and how
 * many repositories does it hold" could only be answered by leaving it. The two
 * chips must show the inventory row's OWN values (one read, no re-derivation),
 * and a fact the Host did not report must be named rather than left blank,
 * printed as `undefined`, or guessed as a default branch.
 */

const PROJECT_ID = "bcedc870-22bd-474e-ac55-78d30a9d763d";
const TASK_ID = "real-1";
const roots = [{ label: "默认任务根", state: "ready" as const }];
const project = { id: PROJECT_ID, name: "真实项目", description: "系统 A", repositories: [], directories: [] };
const emptySnapshot = { source: "sdk-jsonl", sessionId: "main", messages: [], pending: false, interrupted: false };

function bridge(taskRows: Array<Record<string, unknown>>): PidockBridge {
  return {
    listTasks: vi.fn(async () => ({ ok: true, payload: { tasks: taskRows, roots } })),
    taskOp: vi.fn(async (taskId: string, op: string) => ({ ok: true, payload: { lifecycle: { taskId, archived: false, archivedAt: null }, op } })),
    projectOp: vi.fn(async (request: { op: string }) => request.op === "list"
      ? { ok: true, payload: { initialized: true, projects: [project] } }
      : { ok: true, payload: { roots, tasks: [{ taskId: TASK_ID, projectId: PROJECT_ID, state: "assigned" }] } }),
    sdkTurn: vi.fn(async (request: { action: string }) => ({ ok: true, payload: request.action === "subscribe" ? { taskId: TASK_ID, sessionId: "main", snapshot: emptySnapshot, turn: null } : { unsubscribed: true } })),
    onSdkTurnEvent: vi.fn(() => vi.fn()),
    providerOp: vi.fn(async () => ({ ok: true, payload: { state: "not-configured", profileId: null, generation: null, profiles: [] } })),
  } as unknown as PidockBridge;
}

/** Opens `TASK_ID`'s workspace through the shipped Desktop flow (not a stubbed header). */
async function openWorkspace(taskRows: Array<Record<string, unknown>>) {
  const host = bridge(taskRows);
  window.pidock = host;
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "项目管理" }));
  fireEvent.click(await screen.findByRole("button", { name: "真实项目" }));
  fireEvent.click(screen.getByRole("button", { name: "进入工作区" }));
  await screen.findByText(/尚未开始/);
  return host;
}

/** The same component mounted standalone, for facts a Host may leave unreported. */
function mountHeader(facts: { branch: string; repoCount: number | null }) {
  window.pidock = {
    providerOp: vi.fn(async () => ({ ok: true, payload: { state: "not-configured", profileId: null, generation: null, profiles: [] } })),
    onSdkTurnEvent: vi.fn(() => vi.fn()),
    sdkTurn: vi.fn(async (request: { action: string }) => ({ ok: true, payload: request.action === "subscribe" ? { taskId: TASK_ID, sessionId: "main", snapshot: emptySnapshot, turn: null } : { unsubscribed: true } })),
  } as unknown as typeof window.pidock;
  return render(
    <DesktopConversation
      taskId={TASK_ID}
      name="真实任务"
      branch={facts.branch}
      repoCount={facts.repoCount}
      roots={JSON.stringify(roots)}
      association={JSON.stringify({ taskId: TASK_ID, projectId: null, state: "unassigned" })}
      onBack={vi.fn()}
      onOpenProviders={vi.fn()}
      onArchived={vi.fn()}
    />,
  );
}

afterEach(() => { cleanup(); delete window.pidock; vi.restoreAllMocks(); });

describe("#24 task workspace header facts", () => {
  it("shows the Host's branch and repository count as header chips", async () => {
    await openWorkspace([{ taskId: TASK_ID, name: "真实任务", branch: "task/shared-branch", repoCount: 2, updatedAt: "2026-09-22" }]);
    expect(screen.getByTestId("desktop-conversation-branch").textContent).toBe("task/shared-branch");
    expect(screen.getByTestId("desktop-conversation-repo-count").textContent).toBe("2 仓库");
  });

  it("names an unreported branch and repository count instead of a blank or undefined chip", () => {
    mountHeader({ branch: "", repoCount: null });
    const header = screen.getByTestId("desktop-conversation-header");
    // Exact text: a blank chip, an `undefined`, and a guessed `main` are all
    // rejected by asserting the chip's whole content, not a substring.
    expect(screen.getByTestId("desktop-conversation-branch").textContent).toBe("Host 未上报分支");
    expect(screen.getByTestId("desktop-conversation-repo-count").textContent).toBe("Host 未上报仓库数");
    expect(header.textContent).not.toContain("undefined");
  });

  it("shows the same branch and repository count the sidebar card shows", async () => {
    await openWorkspace([{ taskId: TASK_ID, name: "真实任务", branch: "task/shared-branch", repoCount: 2, updatedAt: "2026-09-22" }]);
    const card = document.querySelector(`[data-task-nav="${TASK_ID}"]`) as HTMLElement;
    const branch = screen.getByTestId("desktop-conversation-branch").textContent;
    const repos = screen.getByTestId("desktop-conversation-repo-count").textContent;
    expect(card).not.toBeNull();
    // One inventory row feeds both surfaces, so neither may print its own value.
    expect(branch).toBe("task/shared-branch");
    expect(repos).toBe("2 仓库");
    expect(card.textContent).toContain(branch);
    expect(card.textContent).toContain(repos);
  });

  it("renders the header without issuing another listTasks read", async () => {
    const host = await openWorkspace([{ taskId: TASK_ID, name: "真实任务", branch: "task/shared-branch", repoCount: 2, updatedAt: "2026-09-22" }]);
    // 1: the shell's inventory read, 2: 进入工作区's re-verification, 3: the
    // conversation's own identity check. The header reusing that inventory adds
    // none; a second read for the chips would make this 4.
    expect(screen.getByTestId("desktop-conversation-branch")).toBeInTheDocument();
    expect(host.listTasks).toHaveBeenCalledTimes(3);
  });
});
