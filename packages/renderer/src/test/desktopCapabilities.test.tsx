import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopCapabilitiesPage } from "../components/DesktopCapabilitiesPage";

afterEach(cleanup);

describe("[UI 对齐] S8 production capability structure", () => {
  it("switches categories without inventing inventory counts or editable capabilities", () => {
    render(<DesktopCapabilitiesPage />);
    expect(screen.getByRole("tabpanel", { name: "Skills" })).toHaveTextContent("真实清单");
    expect(screen.getByRole("button", { name: "添加技能来源" })).toBeDisabled();
    expect(screen.getAllByText("未接线")).toHaveLength(5);
    fireEvent.click(screen.getByRole("tab", { name: "MCP Servers" }));
    expect(screen.getByRole("tabpanel", { name: "MCP Servers" })).toHaveTextContent("真实清单");
    expect(screen.getByText(/受控桥接 Extension/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加 MCP Server" })).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: "Packages" }));
    expect(screen.getByRole("tabpanel", { name: "Packages" })).toHaveTextContent("不展示样例");
    expect(screen.getByRole("button", { name: "安装扩展包" })).toBeDisabled();
    expect(screen.queryByText(/^0$/)).not.toBeInTheDocument();
  });
});
