import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopConversation } from "../components/DesktopConversation";
import { DesktopShell } from "../components/DesktopShell";

/**
 * [#49] At the production minimum window (720x560, `runtime.ts:90-91`) a task
 * page leaves the Desktop shell column 280px wide; with a page open the column
 * never exceeds 380px (`desktop-layout.ts:15`). The Desktop task header must
 * therefore take the prototype's narrow form
 * (`prototypes/pidock-ui/style.css`: `.taskheader .between{flex-wrap:wrap}` and
 * `.actionset{flex-wrap:wrap}` at `max-width:1180px`, stacked header at
 * `max-width:720px`) and the breadcrumb must truncate instead of wrapping
 * mid-word.
 *
 * jsdom has no layout engine, so the geometry itself is asserted by the
 * real-Electron guard in
 * `packages/shell/scripts/electron-issue37-task-page-layout-capture.mjs`
 * (`shellColumn`: toolbar/eyebrow bounding-box intersection, toolbar inside the
 * column, no inner overflow). This case locks the class contract that produced
 * the defect when it was missing: a fixed 288px `shrink-0` toolbar forced the
 * `flex-1` title to 0 width, so the `Task workspace` eyebrow painted under the
 * icons and the column grew an inner horizontal scrollbar.
 */

const roots = [{ label: "默认任务根", state: "ready" }];
const association = (taskId: string) => ({ taskId, projectId: null, state: "unassigned" });

/** Only the bridge entries `DesktopConversation` reads on mount. */
function mountConversation(taskId = "task-a") {
  window.pidock = {
    providerOp: vi.fn(async () => ({ ok: true, payload: { state: "not-configured", profileId: null, generation: null, profiles: [] } })),
    onSdkTurnEvent: vi.fn(() => vi.fn()),
    sdkTurn: vi.fn(async (request: Record<string, unknown>) => request.action === "subscribe"
      ? { ok: true, payload: { taskId, sessionId: "main", snapshot: { source: "sdk-jsonl", sessionId: "main", messages: [], pending: false, interrupted: false }, turn: null } }
      : { ok: true, payload: {} }),
  } as unknown as typeof window.pidock;
  return render(
    <DesktopConversation
      taskId={taskId}
      name="对账单详情·任务A"
      branch="task/main"
      repoCount={1}
      roots={JSON.stringify(roots)}
      association={JSON.stringify(association(taskId))}
      onBack={vi.fn()}
      onOpenProviders={vi.fn()}
      onArchived={vi.fn()}
    />,
  );
}

function mountShell(breadcrumb: { project?: string; task?: string }) {
  return render(
    <DesktopShell
      view={{ view: "task", taskId: "task-a" }}
      onNavigate={vi.fn()}
      projects={[{ id: "p-1", name: "Adder", description: "微服务开发工作台", taskCount: 0 }]}
      projectsInitialized
      unassignedCount={0}
      tasks={[]}
      allTaskCount={0}
      lifecyclePending={false}
      lifecycleErrors={[]}
      roots={[{ label: "默认任务根", state: "ready" }]}
      rootRetry={{ busy: false, pending: false, error: null, run: vi.fn() }}
      breadcrumb={breadcrumb}
    >
      <p>内容</p>
    </DesktopShell>,
  );
}

const tiers = (className: string) => className.split(/\s+/);

afterEach(() => {
  cleanup();
  delete window.pidock;
  vi.restoreAllMocks();
});

describe("Desktop shell column at the production minimum (#49)", () => {
  it("keeps task tools available from one compact conversation action entry", () => {
    mountConversation();
    expect(screen.queryByText("Task workspace")).not.toBeInTheDocument();
    expect(screen.getByLabelText("会话与工具操作")).toBeInTheDocument();
    const toolbar = screen.getByTestId("desktop-conversation-toolbar");
    for (const label of ["运行", "浏览器", "文件", "日志", "协议", "任务操作", "返回任务列表"]) {
      expect(within(toolbar).getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(within(toolbar).queryByRole("button", { name: "终端" })).not.toBeInTheDocument();
    // Actual width/intersection checks live in the U03 production Electron capture.
  });

  it("keeps the breadcrumb on one line and truncates only the real names", () => {
    mountShell({ project: "Adder", task: "对账单详情·任务A" });
    const breadcrumb = screen.getByTestId("desktop-breadcrumb");
    for (const name of ["Adder", "对账单详情·任务A"]) {
      expect(tiers(within(breadcrumb).getByText(name).className)).toEqual(expect.arrayContaining(["min-w-0", "truncate"]));
    }
  });
});
