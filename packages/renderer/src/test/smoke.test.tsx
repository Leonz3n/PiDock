import { render, screen } from "@testing-library/react";
import { App } from "../App";

describe("renderer toolchain smoke", () => {
  it("mounts the app shell with the prototype design tokens applied", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "PiDock 渲染层基线" })).toBeInTheDocument();
  });
});
