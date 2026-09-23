import { describe, expect, it } from "vitest";
import { createMemoryHost } from "../data/memoryHost";
import {
  environmentLabel,
  relativeActivity,
  runningServiceCount,
  summarySegments,
  taskCardActivity,
  taskCardMeta,
} from "../data/shellNav";
import type { Task } from "../data/types";

async function fixture() {
  const workspace = await createMemoryHost().getWorkspace();
  const release = workspace.tasks.find((task) => task.id === "release")!;
  const designDocs = workspace.tasks.find((task) => task.id === "design-docs")!;
  return { workspace, release, designDocs };
}

describe("shell task card helpers", () => {
  it("counts running services for the card dot and the summary bar", async () => {
    const { release } = await fixture();
    expect(runningServiceCount(release.services)).toBe(release.services.filter((service) => service.running).length);
    expect(runningServiceCount([])).toBe(0);
  });

  it("resolves the environment display name and falls back to the id", async () => {
    const { workspace, release } = await fixture();
    expect(environmentLabel(release, workspace.environments)).toBe("测试环境");
    expect(environmentLabel({ ...release, environmentId: "missing" }, workspace.environments)).toBe("missing");
  });

  it("composes the card meta line for repository, plain-directory and scheduled tasks", async () => {
    const { workspace, release, designDocs } = await fixture();
    expect(taskCardMeta(release, workspace)).toBe(`${release.repos.length} 仓库 · 测试环境`);
    expect(taskCardMeta(designDocs, workspace)).toBe("普通目录 · 共享文件");

    const scheduled: Task = { ...release, type: "scheduled" };
    expect(taskCardMeta(scheduled, { ...workspace, schedules: [] })).toBe("等待设置");
    expect(taskCardMeta(scheduled, workspace)).toBe("2026-09-25T15:00:00+08:00");
    expect(taskCardMeta(scheduled, { ...workspace, schedules: [{ ...workspace.schedules[0]!, enabled: false }] })).toBe("已暂停");
  });

  it("formats session activity relative to the supplied clock", async () => {
    const now = new Date("2026-09-24T12:00:00+08:00");
    expect(relativeActivity("2026-09-24T11:59:40+08:00", now)).toBe("刚刚");
    expect(relativeActivity("2026-09-24T11:35:00+08:00", now)).toBe("25 分钟前");
    expect(relativeActivity("2026-09-24T09:00:00+08:00", now)).toBe("3 小时前");
    expect(relativeActivity("2026-09-22T09:00:00+08:00", now)).toBe("2 天前");
    expect(relativeActivity("2026-06-01T09:00:00+08:00", now)).toBe("2026-06-01");
    expect(relativeActivity("not-a-date", now)).toBe("");
  });

  it("uses the most recent session activity on the card", async () => {
    const { release } = await fixture();
    const latest = release.sessions
      .map((session) => new Date(session.lastActivity).getTime())
      .reduce((left, right) => Math.max(left, right), 0);
    const now = new Date(latest + 90 * 60_000);
    expect(taskCardActivity(release, now)).toBe("1 小时前");
  });
});

describe("shell summary segments", () => {
  it("falls back to the workspace name when no task is open", async () => {
    const { workspace } = await fixture();
    expect(summarySegments({ workspaceName: workspace.projects[0]!.name, takeoverPaused: false })).toEqual([
      { key: "task", label: "Atlas Web", title: "当前工作区 · 未选择任务" },
    ]);
    expect(summarySegments({ takeoverPaused: false })[0]?.label).toBe("未选择工作区");
  });

  it("summarises the task, its running services and the browser controller", async () => {
    const { release } = await fixture();
    const running = runningServiceCount(release.services);
    const segments = summarySegments({ task: release, takeoverPaused: false });
    expect(segments.map((segment) => segment.key)).toEqual(["task", "services", "browser"]);
    expect(segments[0]).toMatchObject({ label: "发布前检查", title: "当前任务 · 发布前检查" });
    expect(segments[1]?.label).toBe(`${running} 服务`);
    expect(segments[1]?.title).toBe(`${running} / ${release.services.length} 个服务在运行`);
    expect(segments[2]?.label).toBe("Agent 控制中");

    expect(summarySegments({ task: release, takeoverPaused: true })[2]?.label).toBe("人工接管中");
    expect(summarySegments({ task: { ...release, browserPages: [] }, takeoverPaused: true })[2]?.label).toBe("浏览器未打开");
  });
});
