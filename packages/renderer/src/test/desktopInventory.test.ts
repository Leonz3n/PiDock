import { describe, expect, it, vi } from "vitest";
import { desktopMode, listDesktopTasks } from "../data/desktopInventory";

describe("Desktop task inventory boundary", () => {
  it("selects desktop once when a bridge exists or Electron preload is missing", () => {
    expect(desktopMode(undefined, "Chrome/100")).toBe(false);
    expect(desktopMode({ listTasks: vi.fn() }, "Chrome/100")).toBe(true);
    expect(desktopMode(undefined, "Electron/44 Chrome/100")).toBe(true);
  });

  it("lists only strict Host task summaries, without using a demo fallback", async () => {
    const listTasks = vi.fn(async () => ({ ok: true, payload: { tasks: [
      { taskId: "task-a", name: "Real task", branch: "task/real", repoCount: 1, updatedAt: "2026-09-22" },
    ] } }));
    await expect(listDesktopTasks({ listTasks })).resolves.toMatchObject([{ taskId: "task-a" }]);
    expect(listTasks).toHaveBeenCalledTimes(1);
    await expect(listDesktopTasks({ listTasks: vi.fn(async () => ({ ok: false, error: "offline" })) })).rejects.toThrow("offline");
    await expect(listDesktopTasks({})).rejects.toThrow("桌面壳");
    await expect(listDesktopTasks({ listTasks: vi.fn(async () => ({ ok: true, payload: { tasks: [{ taskId: "task-a", taskDir: "/secret" }] } })) })).rejects.toThrow("异常");
  });
});
