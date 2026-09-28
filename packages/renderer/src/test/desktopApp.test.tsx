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
    ], roots: [{ label: "默认任务根", state: "ready" }] } })) };
    render(<App />);
    expect(await screen.findByText("真实任务")).toBeInTheDocument();
    expect(screen.getByText(/项目映射尚未建立/)).toBeInTheDocument();
    expect(screen.getByText(/未知位置的既有任务需明确选择目录找回/)).toBeInTheDocument();
    expect(screen.queryByText("Atlas Web")).not.toBeInTheDocument();
    expect(demoRead).not.toHaveBeenCalled();
  });

  it("shows a real empty state, and retries a failed bridge instead of showing demo content", async () => {
    const demoRead = vi.spyOn(memoryHost, "getWorkspace");
    const listTasks = vi.fn().mockResolvedValueOnce({ ok: false, error: "读取失败" })
      .mockResolvedValue({ ok: true, payload: { tasks: [], roots: [{ label: "默认任务根", state: "ready" }] } });
    window.pidock = { listTasks };
    render(<App />);
    expect(await screen.findByText("读取失败")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("已检查的任务根暂无可读取的任务")).toBeInTheDocument();
    expect(demoRead).not.toHaveBeenCalled();
    expect(screen.queryByText("Atlas Web")).not.toBeInTheDocument();
  });

  it("fails visibly when Desktop preload lacks listTasks instead of entering demo mode", async () => {
    const demoRead = vi.spyOn(memoryHost, "getWorkspace");
    window.pidock = { taskOp: vi.fn() };
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("桌面壳任务读取接口不可用");
    expect(demoRead).not.toHaveBeenCalled();
    expect(screen.queryByText("Atlas Web")).not.toBeInTheDocument();
  });

  it("shows healthy tasks beside a failed root and imports only through the picker bridge", async () => {
    const demoRead = vi.spyOn(memoryHost, "getWorkspace");
    const listTasks = vi.fn(async () => ({ ok: true, payload: { tasks: [
      { taskId: "real-1", name: "已找回任务", branch: "task/main", repoCount: 0, updatedAt: "2026-09-22" },
    ], roots: [{ label: "默认任务根", state: "ready" }, { label: "已登记任务根 1", state: "error", message: "目录丢失" }] } }));
    const importTaskRoot = vi.fn(async () => ({ ok: true, payload: { canceled: false, count: 1 } }));
    window.pidock = { listTasks, importTaskRoot };
    render(<App />);
    expect(await screen.findByText("已找回任务")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("目录丢失");
    fireEvent.click(screen.getByRole("button", { name: "找回其他位置的任务" }));
    await waitFor(() => expect(importTaskRoot).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(2));
    expect(demoRead).not.toHaveBeenCalled();
  });

  it("rejects Desktop writes while project registration and pi are not connected", async () => {
    window.pidock = { listTasks: vi.fn(async () => ({ ok: true, payload: { tasks: [], roots: [{ label: "默认任务根", state: "ready" }] } })), taskOp: vi.fn() };
    render(<App />);
    expect(await screen.findByText("已检查的任务根暂无可读取的任务")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /创建任务|发送消息/ })).not.toBeInTheDocument();
    expect(window.pidock.taskOp).not.toHaveBeenCalled();
  });
});
