/**
 * [Pencil T02] #137 / S08: the task facts surface renders one row per real
 * source with a mode badge, the real path, branch/HEAD where the source has
 * Git, the shared-original wording and the per-source reopen verification
 * state. Nothing here falls back to a fixture, and only the one real session is
 * named.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DesktopTaskFacts } from "../components/DesktopTaskFacts";
import type { PidockBridge } from "../data/shellBridge";

afterEach(() => { cleanup(); delete (window as { pidock?: unknown }).pidock; });

function bridge(taskOp: NonNullable<PidockBridge["taskOp"]>): PidockBridge {
  window.pidock = { taskOp } as unknown as typeof window.pidock;
  return { taskOp };
}
const HEAD = "a3f892c1b2c3d4e5f60718293a4b5c6d7e8f9012";

describe("task workspace facts (S08)", () => {
  it("renders mixed existing-git and plain-directory sources with their own badges, paths and verified identity", async () => {
    const taskOp = vi.fn(async () => ({ ok: true, payload: {
      taskDir: "/tasks/task-1", workspaceMode: "existing-git",
      roots: [
        { id: "repo-1", kind: "existing-git", label: "pidock", path: "/src/pidock", baselineBranch: "main", sharedOriginal: true,
          workingBranch: { state: "observed", value: "main" }, headCommit: { state: "observed", value: HEAD },
          verification: { state: "ready", reason: "已核验：来源身份与记录一致" } },
        { id: "dir-1", kind: "shared-dir", label: "common-configs", path: "/tasks/task-1/common-configs", sourcePath: "/work/common-configs",
          verification: { state: "ready", reason: "已核验：来源身份与记录一致" } },
      ],
    } }));
    render(<DesktopTaskFacts taskId="task-1" taskName="修复分页边界" bridge={bridge(taskOp)} />);
    await screen.findByTestId("task-facts-mode");
    expect(screen.getByTestId("task-facts-mode")).toHaveTextContent("已有 Git 目录 · 共享原检出");
    expect(screen.getAllByText("已有 Git 目录 · 共享原检出").length).toBeGreaterThan(0);
    // An existing-git task shows no invented task branch on the facts surface:
    // the mode badge and per-source branch/HEAD are the honest facts.
    expect(screen.queryByText(/任务分支 task\/task-abc12345/)).not.toBeInTheDocument();
    expect(screen.getByText("普通目录 · 共享原文件")).toBeInTheDocument();
    expect(screen.getByText(/原检出真实路径: \/src\/pidock/)).toBeInTheDocument();
    expect(screen.getByText(/当前分支 main（实测）/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`HEAD ${HEAD}（实测）`))).toBeInTheDocument();
    expect(screen.getByText(/本地真实路径: \/work\/common-configs/)).toBeInTheDocument();
    expect(screen.getAllByText(/已核验/)).toHaveLength(2);
    // [Pencil T06] ticket 141: a task with a shared plain directory says what the
    // managed write coordination actually covers (and the editor exemption).
    const protection = screen.getByTestId("shared-dir-managed-protection");
    expect(protection).toHaveTextContent("受管保护");
    expect(protection).toHaveTextContent("ADR 0006");
    // [#139] The session count is the Host's own read; a fixture that cannot
    // answer names that failure instead of asserting "one session".
    expect(screen.getByTestId("task-facts-sessions")).toHaveTextContent("会话 列表读取失败：会话列表返回异常");
    expect(screen.queryByRole("button", { name: /进入活跃对话/ })).not.toBeInTheDocument();
  });

  it("names a missing source and its repair path instead of hiding it", async () => {
    const taskOp = vi.fn(async () => ({ ok: true, payload: {
      taskDir: "/tasks/task-1", workspaceMode: "plain-dirs",
      roots: [{ id: "dir-1", kind: "shared-dir", label: "docs", path: "/tasks/task-1/dir-1", sourcePath: "/work/docs",
        verification: { state: "missing", reason: "来源缺失：/work/docs 不存在或不可读" } }],
    } }));
    render(<DesktopTaskFacts taskId="task-1" taskName="Docs" bridge={bridge(taskOp)} />);
    expect(await screen.findByText(/来源缺失/)).toBeInTheDocument();
    expect(screen.getByText(/在「项目管理」中修复该来源后重新打开任务/)).toBeInTheDocument();
    expect(screen.getByTestId("task-facts-mode")).toHaveTextContent("普通目录 · 共享原文件");
  });

  it("names a worktree source's observed branch and never summarizes a mixed task as one worktree", async () => {
    const taskOp = vi.fn(async () => ({ ok: true, payload: {
      taskDir: "/tasks/task-1", workspaceMode: "worktree",
      roots: [
        { id: "repo-1", kind: "worktree", label: "repo-1", path: "/tasks/task-1/repo-1", baselineBranch: "main", baseCommit: "b".repeat(40),
          expectedBranch: "task/task-abc12345", sourceRealPath: "/src/pidock",
          workingBranch: { state: "observed", value: "task/task-abc12345" }, dirty: { state: "observed", value: true },
          verification: { state: "mismatch", reason: "身份不符：来源的 Git 公共目录已改变" } },
        { id: "dir-1", kind: "shared-dir", label: "docs", path: "/tasks/task-1/dir-1", sourcePath: "/work/docs",
          verification: { state: "repair-required", reason: "待修复：任务记录缺少来源身份（设备/索引节点），无法核验" } },
      ],
    } }));
    render(<DesktopTaskFacts taskId="task-1" taskName="Mixed" bridge={bridge(taskOp)} />);
    expect(await screen.findByText("独立 Git worktree (隔离副本)")).toBeInTheDocument();
    // [Pencil T07] #142: per-repo facts name the LOCAL task branch, the worktree
    // path, the pinned base commit AND the source checkout the copy came from.
    expect(screen.getByText(/目标检出路径: \/tasks\/task-1\/repo-1/)).toBeInTheDocument();
    expect(screen.getByText(/任务分支 task\/task-abc12345/)).toBeInTheDocument();
    expect(screen.getByText(/工作分支 task\/task-abc12345（实测）/)).toBeInTheDocument();
    expect(screen.getByText(/基线 main @ b{40}/)).toBeInTheDocument();
    expect(screen.getByText(/来源检出 \/src\/pidock/)).toBeInTheDocument();
    expect(screen.getByText(/身份不符：来源的 Git 公共目录已改变/)).toBeInTheDocument();
    expect(screen.getByText(/待修复：任务记录缺少来源身份/)).toBeInTheDocument();
    expect(screen.getByText("普通目录 · 共享原文件")).toBeInTheDocument();
  });

  it("shows a named read error and no rows when the Host answer is unusable (no fixture fallback)", async () => {
    const broken = vi.fn(async () => ({ ok: true, payload: { taskDir: "/tasks/task-1", roots: "nope" } }));
    const { unmount } = render(<DesktopTaskFacts taskId="task-1" taskName="Docs" bridge={bridge(broken)} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("任务工作区事实返回异常");
    expect(screen.queryByLabelText("任务来源事实")).not.toBeInTheDocument();
    unmount();

    const refused = vi.fn(async () => ({ ok: false, error: "task-unknown: 无法读取任务记录" }));
    render(<DesktopTaskFacts taskId="task-1" taskName="Docs" bridge={bridge(refused)} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("task-unknown");
    expect(screen.queryByLabelText("任务来源事实")).not.toBeInTheDocument();
  });
});
