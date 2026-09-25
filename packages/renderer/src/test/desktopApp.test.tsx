import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { App } from "../App";
import { memoryHost } from "../data/memoryHost";

afterEach(() => {
  cleanup();
  delete window.pidock;
  vi.restoreAllMocks();
});

describe("Desktop boot without demo fallback", () => {
  it("keeps standalone Vite in explicit demo mode", async () => {
    const demoRead = vi.spyOn(memoryHost, "getWorkspace");
    render(<App />);
    await waitFor(() => expect(demoRead).toHaveBeenCalled());
    expect(screen.queryByTestId("desktop-inventory")).not.toBeInTheDocument();
  });

  it("shows persisted task summaries without reading the memory workspace", async () => {
    const demoRead = vi.spyOn(memoryHost, "getWorkspace");
    window.pidock = { listTasks: vi.fn(async () => ({ ok: true, payload: { tasks: [
      { taskId: "real-1", name: "真实任务", branch: "task/main", repoCount: 1, updatedAt: "2026-09-22" },
    ] } })) };
    render(<App />);
    expect(await screen.findByText("真实任务")).toBeInTheDocument();
    expect(screen.getByText(/项目映射尚未建立/)).toBeInTheDocument();
    expect(screen.getByText(/其他位置的既有任务尚不能自动发现/)).toBeInTheDocument();
    expect(screen.queryByText("Atlas Web")).not.toBeInTheDocument();
    expect(demoRead).not.toHaveBeenCalled();
  });

  it("shows a real empty state, and retries a failed bridge instead of showing demo content", async () => {
    const demoRead = vi.spyOn(memoryHost, "getWorkspace");
    const listTasks = vi.fn().mockResolvedValueOnce({ ok: false, error: "读取失败" })
      .mockResolvedValue({ ok: true, payload: { tasks: [] } });
    window.pidock = { listTasks };
    render(<App />);
    expect(await screen.findByText("读取失败")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("默认任务根暂无已登记的任务")).toBeInTheDocument();
    expect(demoRead).not.toHaveBeenCalled();
    expect(screen.queryByText("Atlas Web")).not.toBeInTheDocument();
  });

  it("rejects Desktop writes while project registration and pi are not connected", async () => {
    window.pidock = { listTasks: vi.fn(async () => ({ ok: true, payload: { tasks: [] } })), taskOp: vi.fn() };
    render(<App />);
    expect(await screen.findByText("默认任务根暂无已登记的任务")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /创建任务|发送消息/ })).not.toBeInTheDocument();
    expect(window.pidock.taskOp).not.toHaveBeenCalled();
  });
});
