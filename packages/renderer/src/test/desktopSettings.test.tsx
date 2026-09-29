import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopSettingsPage } from "../components/DesktopSettingsPage";

afterEach(cleanup);

describe("[UI 对齐] S8 production local settings structure", () => {
  it("does not present a guessed config directory or let users save an unread setting", () => {
    render(<DesktopSettingsPage />);
    expect(screen.getByRole("region", { name: "应用配置目录" })).toHaveTextContent("未接线");
    expect(screen.getByRole("region", { name: "默认任务根目录" })).toHaveTextContent("尚未提供");
    expect(screen.getByRole("textbox", { name: "默认任务根目录" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "选择目录" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();
    expect(screen.queryByText(/~\/\.pi\/dock/)).not.toBeInTheDocument();
  });
});
