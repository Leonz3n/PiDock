import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "./helpers";

// Flow: [PiDock 06] (#8) the task browser panel. The page belongs to main,
// so the panel must speak `task/browserAction` through the preload bridge —
// never CDP — and must show the takeover, the marker and the refusal state.

type BridgedWindow = { pidock?: { taskOp: ReturnType<typeof vi.fn> } };

/**
 * Expose the preload bridge on the real jsdom window. The renderer only
 * reads `window.pidock` (no Node/Electron import), so a plain property is
 * exactly what the shell provides.
 */
function stubShell(taskOp: ReturnType<typeof vi.fn>) {
  (window as unknown as BridgedWindow).pidock = { taskOp };
}

afterEach(() => {
  delete (window as unknown as BridgedWindow).pidock;
});

describe("task browser panel", () => {
  it("pauses agent automation through the attested human path", async () => {
    const user = userEvent.setup();
    const taskOp = vi.fn(async () => ({ ok: true, payload: {} }));
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    stubShell(taskOp);

    await user.click(screen.getByRole("button", { name: "浏览器" }));
    expect(await screen.findByText(/Agent 与用户操作同一页面实例/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "人工接管" }));

    expect(taskOp).toHaveBeenCalledWith(
      "release",
      "task/browserAction",
      expect.objectContaining({ action: "takeover/pause", label: "用户接管浏览器" }),
    );
    expect(await screen.findByText("人工接管中：自动化已暂停")).toBeInTheDocument();
  });

  it("sends a user marker with the page, URL, epoch and annotation", async () => {
    const user = userEvent.setup();
    const taskOp = vi.fn(async (_taskId: string, _op: string, payload: Record<string, unknown>) => {
      if (payload["action"] === "page/state") {
        return { ok: true, payload: { state: { epoch: 3, url: "http://localhost:5173/checkout", title: "对账单" } } };
      }
      return {
        ok: true,
        payload: { marker: { kind: "browser-marker", id: "marker-1", needsRelocation: false, currentEpoch: 3 } },
      };
    });
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    stubShell(taskOp);

    await user.click(screen.getByRole("button", { name: "浏览器" }));
    await user.type(await screen.findByLabelText("标记说明"), "总额与对账单不一致");
    await user.click(screen.getByRole("button", { name: "框选元素标记" }));

    const markerCall = taskOp.mock.calls.find((call) => (call[2] as Record<string, unknown>)["action"] === "marker/create");
    expect(markerCall?.[0]).toBe("release");
    expect(markerCall?.[2]).toMatchObject({
      action: "marker/create",
      label: "用户标记页面问题",
      targetSessionId: "main",
    });
    const marker = ((markerCall?.[2] as Record<string, unknown>)["params"] as Record<string, unknown>)["marker"] as Record<string, unknown>;
    expect(marker).toMatchObject({
      url: "http://localhost:5173/checkout",
      annotation: "总额与对账单不一致",
      epoch: 3,
      mode: "box",
    });
    expect(await screen.findByText(/总额与对账单不一致 · http:\/\/localhost:5173\/checkout/)).toBeInTheDocument();
  });

  it("keeps the panel usable when the Host refuses the action", async () => {
    const user = userEvent.setup();
    const taskOp = vi.fn(async () => ({ ok: false, error: "navigation-denied: https://example.org 不在任务运行配置的地址内" }));
    renderApp("/projects/atlas/tasks/release?session=main");
    await screen.findByRole("heading", { name: "发布前检查" });
    stubShell(taskOp);

    await user.click(screen.getByRole("button", { name: "浏览器" }));
    await user.click(screen.getByRole("button", { name: "获取证据" }));

    expect(await screen.findByText(/navigation-denied: https:\/\/example.org/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "获取证据" })).toBeInTheDocument();
  });
});
