import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DesktopRootErrors } from "../components/DesktopShell";

afterEach(() => cleanup());

describe("Desktop task-root diagnostics", () => {
  it("shows a named unindexed-task diagnostic on a readable root", () => {
    render(<DesktopRootErrors roots={[{ label: "已登记任务根 1", state: "ready",
      message: "发现 1 个未登记任务（目录 task-00000003 / ID task-00000002），请在「项目管理」使用「找回任务根」明确导入" }]}
      busy={false} retryPending={false} retryError={null} onRetry={vi.fn()} />);
    const diagnostic = screen.getByRole("status");
    expect(diagnostic).toHaveTextContent("已登记任务根 1：发现 1 个未登记任务（目录 task-00000003 / ID task-00000002）");
    expect(diagnostic).toHaveTextContent("请在「项目管理」使用「找回任务根」明确导入");
    expect(diagnostic).toHaveClass("text-[#9a6032]");
  });

  it("keeps the existing error-root alert and retry action", () => {
    const onRetry = vi.fn();
    render(<DesktopRootErrors roots={[{ label: "已登记任务根 1", state: "error", message: "任务目录身份已改变" }]}
      busy={false} retryPending={false} retryError={null} onRetry={onRetry} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("已登记任务根 1：任务目录身份已改变");
    expect(alert).toHaveClass("text-[#ad4545]");
    screen.getByRole("button", { name: "重试读取已登记任务根 1" }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
