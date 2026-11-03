import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopSettingsPage } from "../components/DesktopSettingsPage";

afterEach(cleanup);

/**
 * [Pencil T14] #149 replaced the old 「Host 尚无…未接线」 settings page.
 *
 * The old page's whole content was a disabled 默认任务根 input, a disabled
 * 保存设置 button and sentences naming Host operations that did not exist. The
 * design (S11) and the parent spec require a real 外观 pane as the default and
 * no blank placeholder panes, so those assertions are gone on purpose: what is
 * pinned now is the real structure and the honest states that replaced them.
 */
describe("[Pencil T14] #149 production settings structure", () => {
  it("opens on 外观 and never shows the old 未接线 placeholder panes", () => {
    render(<DesktopSettingsPage />);
    expect(screen.getByTestId("desktop-settings-page")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "外观" })).toBeInTheDocument();
    // The old page's fabricated/stub surfaces are gone by name.
    expect(screen.queryByRole("region", { name: "应用配置目录" })).toBeNull();
    expect(screen.queryByRole("region", { name: "默认任务根目录" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "默认任务根目录" })).toBeNull();
    expect(screen.queryByRole("button", { name: "保存设置" })).toBeNull();
    expect(screen.queryByText(/~\/\.pi\/dock/)).not.toBeInTheDocument();
  });

  it("keeps the wired external editor setting under 通用 with its own save path", () => {
    render(<DesktopSettingsPage />);
    fireEvent.click(within(screen.getByRole("navigation", { name: "设置" })).getByRole("button", { name: "通用" }));
    expect(screen.getByRole("region", { name: "外部编辑器" })).toBeInTheDocument();
    expect(screen.getByLabelText("外部编辑器程序")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存外部编辑器" })).toBeInTheDocument();
  });
});
