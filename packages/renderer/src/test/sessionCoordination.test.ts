import { describe, expect, it } from "vitest";
import {
  MAX_VISIBLE_SESSION_TABS,
  SESSION_MENU_LABEL,
  sessionMenuActions,
  sessionTabLabel,
  visibleSessionTabs,
} from "../data/sessionNav";
import {
  emptyTaskWriteLock,
  sessionWriteRoleLabel,
  sessionWriteStates,
  writeCoordinationSummary,
  writeCoordinationVisible,
  waitingSessions,
} from "../data/writeCoordination";
import type { Session } from "../data/types";

// Seam: [PiDock 09] (#11) session navigation + coordination display rules.
// The renderer shows the Host's coordination state; it never re-derives who
// may write (that decision lives in the shell), so these tests cover the
// display rules: bounded labels, four stable slots, hidden active session,
// queue/read-only roles and the abort entry conditions.

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    name: id,
    archived: false,
    permission: "default",
    providerId: "provider-local",
    model: "pidock-default",
    contextUsed: 0,
    contextWindow: 200,
    tokens: 0,
    runState: "idle",
    unread: 0,
    lastActivity: "2026-09-22T10:00:00+08:00",
    messages: [],
    ...overrides,
  };
}

describe("session tab navigation", () => {
  it("bounds the label so a long name never widens the navigation", () => {
    expect(sessionTabLabel("实现与验证")).toBe("实现与验证");
    expect(sessionTabLabel("  部署前检查与回滚脚本验证  ")).toBe("部署前检查与回滚脚…");
    expect(sessionTabLabel("")).toBe("未命名会话");
  });

  it("keeps four slots in creation order and lets the hidden active session take the last", () => {
    const sessions = ["a", "b", "c", "d", "e"].map((id) => session(id));
    expect(visibleSessionTabs(sessions, "a").map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
    // Active session outside the first four replaces the last visible slot.
    expect(visibleSessionTabs(sessions, "e").map((item) => item.id)).toEqual(["a", "b", "c", "e"]);
    expect(sessions.slice(0, MAX_VISIBLE_SESSION_TABS)).toHaveLength(4);
  });

  it("shows only the active session on a narrow layout", () => {
    const sessions = ["a", "b", "c"].map((id) => session(id));
    expect(visibleSessionTabs(sessions, "b", { narrow: true }).map((item) => item.id)).toEqual(["b"]);
  });

  it("offers the abort entry for the holder and the queued session", () => {
    expect(sessionMenuActions(session("main"), { isOwner: false, isWaiting: false })).toEqual([
      "open",
      "rename",
      "archive",
      "browse",
    ]);
    expect(sessionMenuActions(session("main"), { isOwner: true, isWaiting: false })).toContain("stop");
    expect(sessionMenuActions(session("main"), { isOwner: false, isWaiting: true })).toContain("stop");
    // An archived session offers restore rather than archive.
    expect(sessionMenuActions(session("main", { archived: true }), { isOwner: false, isWaiting: false })).toContain("restore");
    expect(SESSION_MENU_LABEL.stop).toBe("中止该会话");
  });
});

describe("task write coordination display", () => {
  it("marks one holder, queue positions and read-only sessions", () => {
    const states = sessionWriteStates({
      sessions: [session("impl"), session("review"), session("audit", { permission: "read" })],
      writeLock: { owner: "impl", ownerLabel: "回合工具 exec.run", waiting: ["review"], orphans: [], derived: [] },
    });
    expect(states).toEqual([
      { sessionId: "impl", role: "owner" },
      { sessionId: "review", role: "waiting", queuePosition: 1 },
      { sessionId: "audit", role: "readonly" },
    ]);
    expect(sessionWriteRoleLabel(states[0])).toBe("持有写操作权");
    expect(sessionWriteRoleLabel(states[1])).toBe("排队第 1 位");
    expect(sessionWriteRoleLabel(states[2])).toBe("只读");
    expect(sessionWriteRoleLabel({ sessionId: "x", role: "idle" })).toBeNull();
  });

  it("reports the holder, derived execution and queue in one summary", () => {
    const task = {
      sessions: [session("impl", { name: "实现" }), session("review", { name: "排查" })],
      writeLock: {
        owner: "impl",
        ownerLabel: "回合工具 exec.run",
        waiting: ["review"],
        orphans: [],
        derived: [{ sessionId: "impl", label: "构建子进程" }],
      },
    };
    expect(writeCoordinationVisible(task)).toBe(true);
    const summary = writeCoordinationSummary(task);
    expect(summary).toContain("实现 持有写操作权（回合工具 exec.run）");
    expect(summary).toContain("派生执行中：构建子进程");
    expect(summary).toContain("排队 1 个会话");
    expect(waitingSessions(task).map((item) => item.id)).toEqual(["review"]);
  });

  it("surfaces leftover resources and stays hidden for an idle task", () => {
    const idle = { sessions: [session("main")], writeLock: emptyTaskWriteLock() };
    expect(writeCoordinationVisible(idle)).toBe(false);
    expect(writeCoordinationSummary(idle)).toBe("无会话持有写操作权");
    const orphaned = {
      sessions: [session("main")],
      writeLock: { ...emptyTaskWriteLock(), orphans: [{ resourceId: "saas-web", kind: "service" as const, ownerSessionId: "gone", label: "saas-web" }] },
    };
    expect(writeCoordinationVisible(orphaned)).toBe(true);
    expect(writeCoordinationSummary(orphaned)).toContain("遗留执行资源待核验：saas-web");
  });
});
