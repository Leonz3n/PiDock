import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopSettingsPage } from "../components/DesktopSettingsPage";

// Seam: [PiDock 10] (#15 box 28) the settings surface that makes the external
// editor REACHABLE. Before this section the launch read a machine-private
// document nothing in the app could write, so every press returned
// `editor-not-configured`. The page must save through its own attested op —
// never through the renderer's generic task-op route, where a page-chosen
// program could be written — and must show main's own answer or refusal.

const SETTINGS_PATH = "/tmp/userData/external-editor.json";

function bridge(editorSettingsOp: ReturnType<typeof vi.fn>, taskOp = vi.fn(async () => ({ ok: true, payload: {} }))) {
  window.pidock = { editorSettingsOp, taskOp } as unknown as typeof window.pidock;
  return { editorSettingsOp, taskOp };
}

afterEach(() => {
  cleanup();
  delete (window as { pidock?: unknown }).pidock;
});

describe("#15 box 28 external editor setting in 本机设置", () => {
  it("reads the saved program from main and writes it only through its own op, never the task-op route", async () => {
    const editorSettingsOp = vi.fn(async (request: Record<string, unknown>) =>
      request["op"] === "read"
        ? { ok: true, payload: { program: "/usr/local/bin/code", args: ["--new-window"], settingsPath: SETTINGS_PATH } }
        : { ok: false, error: "unexpected" });
    const { taskOp } = bridge(editorSettingsOp);
    render(<DesktopSettingsPage />);

    expect(await screen.findByText("/usr/local/bin/code")).toBeInTheDocument();
    expect(screen.getByText(SETTINGS_PATH)).toBeInTheDocument();
    expect(editorSettingsOp).toHaveBeenCalledWith({ op: "read" });

    // MUTATION CHECK: if this surface were rewired onto the renderer-reachable
    // task-op route, a page could name the program main then launches; that
    // would make this assertion (`taskOp` untouched by a settings read/write)
    // fail. The read/write op is its own attested channel.
    expect(taskOp).not.toHaveBeenCalled();
  });

  it("saves the typed program and one argument per line, and reports what main actually stored", async () => {
    const editorSettingsOp = vi.fn(async (request: Record<string, unknown>) => {
      if (request["op"] === "read") return { ok: true, payload: { program: null, args: [], settingsPath: SETTINGS_PATH } };
      return { ok: true, payload: { program: "/opt/editor", args: ["--wait"], settingsPath: SETTINGS_PATH } };
    });
    const { taskOp } = bridge(editorSettingsOp);
    render(<DesktopSettingsPage />);
    await waitFor(() => expect(editorSettingsOp).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("外部编辑器程序"), { target: { value: "/opt/editor" } });
    fireEvent.change(screen.getByLabelText("附加参数（每行一项）"), { target: { value: "  --wait  \n\n" } });
    fireEvent.click(screen.getByRole("button", { name: "保存外部编辑器" }));

    await waitFor(() => expect(editorSettingsOp).toHaveBeenCalledTimes(2));
    // Exactly a program and its own args: no file, no task, no path.
    expect(editorSettingsOp).toHaveBeenLastCalledWith({ op: "save", program: "/opt/editor", args: ["--wait"] });
    expect(taskOp).not.toHaveBeenCalled();
    expect(await screen.findByText("/opt/editor")).toBeInTheDocument();
  });

  it("omits args entirely when the user typed none", async () => {
    const editorSettingsOp = vi.fn(async (request: Record<string, unknown>) =>
      request["op"] === "read"
        ? { ok: true, payload: { program: null, args: [], settingsPath: SETTINGS_PATH } }
        : { ok: true, payload: { program: "/opt/editor", args: [], settingsPath: SETTINGS_PATH } });
    bridge(editorSettingsOp);
    render(<DesktopSettingsPage />);
    await waitFor(() => expect(editorSettingsOp).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("外部编辑器程序"), { target: { value: "/opt/editor" } });
    fireEvent.click(screen.getByRole("button", { name: "保存外部编辑器" }));

    await waitFor(() => expect(editorSettingsOp).toHaveBeenCalledTimes(2));
    expect(editorSettingsOp).toHaveBeenLastCalledWith({ op: "save", program: "/opt/editor" });
  });

  it("shows main's named refusal for an invalid program instead of a saved-looking draft", async () => {
    const editorSettingsOp = vi.fn(async (request: Record<string, unknown>) =>
      request["op"] === "read"
        ? { ok: true, payload: { program: "/usr/local/bin/code", args: [], settingsPath: SETTINGS_PATH } }
        : { ok: false, error: `editor-program-not-executable: 外部编辑器程序不是可执行文件（/tmp/Fake.app），未保存任何设置` });
    bridge(editorSettingsOp);
    render(<DesktopSettingsPage />);
    await waitFor(() => expect(editorSettingsOp).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("外部编辑器程序"), { target: { value: "/tmp/Fake.app" } });
    fireEvent.click(screen.getByRole("button", { name: "保存外部编辑器" }));

    expect(await screen.findByText(/editor-program-not-executable/)).toBeInTheDocument();
    // The stored setting is unchanged: main's answer, not the refused draft.
    expect(screen.getByText("/usr/local/bin/code")).toBeInTheDocument();
    expect(screen.queryByText("/tmp/Fake.app")).not.toBeInTheDocument();
  });

  it("clears the setting through the same op and returns the honest 未配置 state", async () => {
    const editorSettingsOp = vi.fn(async (request: Record<string, unknown>) =>
      request["op"] === "read"
        ? { ok: true, payload: { program: "/usr/local/bin/code", args: [], settingsPath: SETTINGS_PATH } }
        : { ok: true, payload: { program: null, args: [], settingsPath: SETTINGS_PATH } });
    bridge(editorSettingsOp);
    render(<DesktopSettingsPage />);
    await waitFor(() => expect(editorSettingsOp).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "清除外部编辑器设置" }));

    await waitFor(() => expect(editorSettingsOp).toHaveBeenLastCalledWith({ op: "clear" }));
    expect(await screen.findByText(/未配置（打开外部编辑器会返回 editor-not-configured/)).toBeInTheDocument();
  });

  it("treats a status that is not the documented shape as an error, never as an empty setting", async () => {
    bridge(vi.fn(async () => ({ ok: true, payload: { program: "/opt/editor" } })));
    render(<DesktopSettingsPage />);
    expect(await screen.findByText("Host 外部编辑器设置响应无法解析")).toBeInTheDocument();
    expect(screen.queryByText("/opt/editor")).not.toBeInTheDocument();
  });

  it("says it cannot read or write the setting outside the desktop shell instead of pretending", async () => {
    window.pidock = { taskOp: async () => ({ ok: true, payload: {} }) } as unknown as typeof window.pidock;
    render(<DesktopSettingsPage />);
    expect(await screen.findByText("当前不在桌面壳内，无法读写外部编辑器设置")).toBeInTheDocument();
  });
});
