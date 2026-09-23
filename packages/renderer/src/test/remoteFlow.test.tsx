import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useHostStore } from "../stores/host";
import { useUiStore } from "../stores/ui";
import { renderApp } from "./helpers";

/**
 * [PiDock 19] (#21) remote access page: the desktop generates a short-lived code,
 * confirms or rejects the device that scanned it, and manages each device's
 * credential. Runs on the in-memory projection; the Host holds the secret, the
 * real pairing states and the op allow-list (covered by the shell tests).
 */
describe("remote access flow", () => {
  it("generates a fragment-only code, invalidates the old one and pairs a device", async () => {
    const user = userEvent.setup();
    renderApp("/remote");
    await screen.findByRole("heading", { name: "远程访问" });

    await user.click(screen.getByRole("button", { name: "配对设备" }));
    const dialog = await screen.findByRole("dialog", { name: "配对远程设备" });
    await user.click(within(dialog).getByRole("button", { name: "生成配对凭据" }));

    const first = useHostStore.getState().workspace?.remotePairing;
    expect(first).toMatchObject({ state: "pending" });
    expect(first?.url).toContain("#pairing=");
    expect(first?.url).not.toContain("?");
    // The secret never reaches the renderer: only the credential id is shown.
    expect(first?.url).not.toMatch(/token=|secret=/);
    expect(within(dialog).getByText(/剩余 \d+:\d{2}/)).toBeInTheDocument();

    // Generating again invalidates the previous code instead of adding a second.
    await user.click(within(dialog).getByRole("button", { name: "重新生成（旧码失效）" }));
    const second = useHostStore.getState().workspace?.remotePairing;
    expect(second?.credentialId).not.toBe(first?.credentialId);
    expect(second?.state).toBe("pending");
    expect(useUiStore.getState().toasts.some((toast) => toast.text.includes("旧码立即失效"))).toBe(true);

    // Closing the dialog cancels the live code.
    await user.click(within(dialog).getByRole("button", { name: "完成" }));
    await waitFor(() => expect(useHostStore.getState().workspace?.remotePairing?.state).toBe("cancelled"));
    expect(useHostStore.getState().workspace?.remoteAudits.some((audit) => audit.kind === "pairing-refused")).toBe(true);
  });

  it("keeps an unconfirmed device out, confirms it with narrowed permissions and revokes it", async () => {
    const user = userEvent.setup();
    renderApp("/remote");
    await screen.findByRole("heading", { name: "远程访问" });

    // A device that scanned a code waits for the desktop and grants nothing yet.
    expect(screen.getByText("Pixel 9")).toBeInTheDocument();
    expect(screen.getByText("等待本机确认")).toBeInTheDocument();
    expect(screen.getByText(/确认前不能查看或操作任何任务/)).toBeInTheDocument();
    expect(useHostStore.getState().workspace?.devices.find((device) => device.id === "device-3")?.status).toBe("pending-confirmation");

    await user.click(screen.getByRole("button", { name: "确认并收窄权限" }));
    const confirmed = useHostStore.getState().workspace?.devices.find((device) => device.id === "device-3");
    // The requested terminal permission is not granted by default (默认关闭).
    expect(confirmed).toMatchObject({ status: "active", permissions: ["overview", "chat"], credentialGeneration: 1 });
    expect(useUiStore.getState().toasts.some((toast) => toast.text.includes("已确认设备「Pixel 9」"))).toBe(true);

    // Rotation replaces the credential and says so.
    const rotateButtons = screen.getAllByRole("button", { name: "轮换凭据" });
    await user.click(rotateButtons[rotateButtons.length - 1] as HTMLElement);
    await waitFor(() =>
      expect(useHostStore.getState().workspace?.devices.find((device) => device.id === "device-3")?.credentialGeneration).toBe(2),
    );

    // Revoking ends the device; the button is then disabled for it.
    const revokeButtons = screen.getAllByRole("button", { name: "撤销设备" });
    await user.click(revokeButtons[revokeButtons.length - 1] as HTMLElement);
    await waitFor(() => expect(useHostStore.getState().workspace?.devices.find((device) => device.id === "device-3")?.status).toBe("revoked"));
    expect(useHostStore.getState().workspace?.devices.find((device) => device.id === "device-3")?.permissions).toEqual([]);
    expect(useUiStore.getState().toasts.some((toast) => toast.text.includes("现有连接与后续请求均失效"))).toBe(true);
  });

  it("rejects a pending device without granting anything and audits the audit trail", async () => {
    const user = userEvent.setup();
    renderApp("/remote");
    await screen.findByRole("heading", { name: "远程访问" });

    await user.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(useHostStore.getState().workspace?.devices.find((device) => device.id === "device-3")?.status).toBe("revoked"));
    const audit = useHostStore.getState().workspace?.remoteAudits.at(-1);
    expect(audit).toMatchObject({ kind: "device-rejected", deviceId: "device-3" });
    // The audit list on the page shows the redacted detail, not a raw payload.
    expect(screen.getByText(/本机拒绝设备 device-3/)).toBeInTheDocument();
  });

  it("shows the entry the Host reported and drops the live connection on a route switch", async () => {
    const user = userEvent.setup();
    renderApp("/remote");
    await screen.findByRole("heading", { name: "远程访问" });

    expect(screen.getByText("127.0.0.1:4318")).toBeInTheDocument();
    expect(screen.getByText(/pidock-host.tailnet.ts.net/)).toBeInTheDocument();
    expect(screen.getByText(/离线（不重放请求）/)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "自建 PiDock Gateway" }));
    await waitFor(() => expect(useHostStore.getState().workspace?.remoteEntry.mode).toBe("gateway"));
    expect(useUiStore.getState().toasts.some((toast) => toast.text.includes("旧连接不再复用"))).toBe(true);
    expect(useHostStore.getState().workspace?.remoteAudits.some((audit) => audit.kind === "gateway-disconnected")).toBe(true);
  });
});
