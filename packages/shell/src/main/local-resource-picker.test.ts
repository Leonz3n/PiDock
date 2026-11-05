import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessSync, chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMainInvokeEvent } from "electron";
const mocks = vi.hoisted(() => ({ handle: vi.fn(), show: vi.fn(), parent: {} }));
vi.mock("electron", () => ({ ipcMain: { handle: mocks.handle }, dialog: { showOpenDialog: mocks.show }, BrowserWindow: { fromWebContents: () => mocks.parent } }));
import { registerLocalResourcePicker } from "./local-resource-picker.js";
import { TrustDomainRegistry } from "./trust-domain.js";

let home: string;
let registry: TrustDomainRegistry;
let route: (event: IpcMainInvokeEvent, request: unknown) => Promise<{ ok: boolean; payload?: unknown; error?: string }>;
const event = { sender: { id: 1, mainFrame: { processId: 1, routingId: 2 } }, senderFrame: { processId: 1, routingId: 2 } } as IpcMainInvokeEvent;
beforeEach(() => {
  vi.clearAllMocks();
  home = mkdtempSync(join(tmpdir(), "pidock-picker-test-"));
  registry = new TrustDomainRegistry();
  registry.registerShell({ webContentsId: 1, viewId: "shell", workspaceId: "w" });
  registerLocalResourcePicker(registry);
  expect(mocks.handle.mock.calls[0]![0]).toBe("shell/pickLocalResource");
  route = mocks.handle.mock.calls[0]![1];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
describe("trusted native resource selection", () => {
  it("returns an existing non-ASCII directory without creating/importing anything", async () => {
    const path = join(home, "资料 space"); mkdirSync(path);
    mocks.show.mockResolvedValue({ canceled: false, filePaths: [path] });
    expect(await route(event, { kind: "directory" })).toEqual({ ok: true, payload: { canceled: false, path: realpathSync(path) } });
    expect(mocks.show).toHaveBeenCalledWith(mocks.parent, { title: "选择本机文件夹", properties: ["openDirectory"] });
    accessSync(path);
  });
  it("checks executable file type and permissions after the dialog", async () => {
    const path = join(home, "program space"); writeFileSync(path, "not executed"); chmodSync(path, 0o700);
    mocks.show.mockResolvedValue({ canceled: false, filePaths: [path] });
    expect((await route(event, { kind: "executable" })).ok).toBe(true);
    expect(mocks.show.mock.calls[0]![1].properties).toEqual(["openFile", "treatPackageAsDirectory"]);
    chmodSync(path, 0o600);
    if (process.platform !== "win32") expect((await route(event, { kind: "executable" })).ok).toBe(false);
    mocks.show.mockResolvedValue({ canceled: false, filePaths: [home] });
    expect((await route(event, { kind: "executable" })).ok).toBe(false);
  });
  it("leaves cancellation and empty selection side-effect free, sanitizes unavailable selections", async () => {
    for (const result of [{ canceled: true, filePaths: [home] }, { canceled: false, filePaths: [] }]) {
      mocks.show.mockResolvedValue(result);
      expect(await route(event, { kind: "directory" })).toEqual({ ok: true, payload: { canceled: true } });
    }
    const secretPath = join(home, "unavailable-private-name");
    mocks.show.mockResolvedValue({ canceled: false, filePaths: [secretPath] });
    const result = await route(event, { kind: "directory" });
    expect(result.ok).toBe(false); expect(result.error).not.toContain(secretPath);
    mocks.show.mockRejectedValue(Error("private OS error"));
    expect((await route(event, { kind: "directory" })).error).not.toContain("private OS error");
  });
  it("rejects untrusted frames, arbitrary path/options and unsupported kinds before opening", async () => {
    for (const request of [undefined, {}, { kind: "file" }, { kind: "directory", path: home }, { kind: "directory", properties: [] }]) expect((await route(event, request)).ok).toBe(false);
    expect((await route({ ...event, senderFrame: null }, { kind: "directory" })).error).toContain("non-main-frame");
    registry.unregister(1);
    expect((await route(event, { kind: "directory" })).error).toContain("unknown-sender");
    expect(mocks.show).not.toHaveBeenCalled();
  });
  it("refuses duplicate dialogs, keeps its original lock and reattests ownership after async selection", async () => {
    let resolve!: (value: unknown) => void;
    mocks.show.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const first = route(event, { kind: "directory" });
    expect((await route(event, { kind: "directory" })).error).toContain("picker-busy");
    expect((await route(event, { kind: "directory" })).error).toContain("picker-busy");
    registry.unregister(1);
    registry.registerShell({ webContentsId: 1, viewId: "new-shell", workspaceId: "new-workspace" });
    resolve({ canceled: false, filePaths: [home] });
    expect((await first).error).toContain("picker owner changed");
    expect(mocks.show).toHaveBeenCalledTimes(1);
    mocks.show.mockResolvedValue({ canceled: true, filePaths: [] });
    expect((await route(event, { kind: "directory" })).ok).toBe(true);
  });
});
