import { render, screen, waitFor } from "@testing-library/react";
import { CodeBlock } from "../components/CodeBlock";

describe("Shiki code highlighting", () => {
  it("highlights a snippet in-process without Node built-ins", async () => {
    const { container } = render(<CodeBlock language="bash" label="本地启动" code={"pnpm --filter saas-web dev"} />);
    await waitFor(
      () => {
        expect(container.querySelector("pre.shiki, pre[style*='background']")).not.toBeNull();
        expect(container.querySelectorAll("span[style*='color']").length).toBeGreaterThan(0);
      },
      { timeout: 8000 },
    );
    expect(screen.getByText("本地启动")).toBeInTheDocument();
  }, 12000);
});
