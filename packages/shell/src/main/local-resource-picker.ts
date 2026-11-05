import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { TrustDomainViolation, type TrustDomainRegistry } from "./trust-domain.js";

/** Metadata selection only. Saving/importing/executing remains a separate validated action. */
export function registerLocalResourcePicker(registry: TrustDomainRegistry): void {
  const pending = new Set<number>();
  ipcMain.handle("shell/pickLocalResource", async (event: IpcMainInvokeEvent, payload: unknown) => {
    let owner: number | undefined;
    try {
      const sender = registry.requireShellSender(event);
      if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
          Object.keys(payload).length !== 1 || !("kind" in payload) ||
          (payload.kind !== "directory" && payload.kind !== "executable")) {
        throw new TrustDomainViolation("invalid-payload", "resource picker accepts only directory or executable kind");
      }
      if (pending.has(event.sender.id)) return { ok: false, error: "picker-busy: 资源选择器已打开" };
      owner = event.sender.id;
      pending.add(owner);
      const options = {
        title: payload.kind === "directory" ? "选择本机文件夹" : "选择本机可执行文件",
        properties: payload.kind === "directory" ? ["openDirectory" as const] : ["openFile" as const, "treatPackageAsDirectory" as const],
      };
      const window = BrowserWindow.fromWebContents(event.sender);
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      const current = registry.requireShellSender(event);
      if (current !== sender) throw new TrustDomainViolation("unknown-sender", "picker owner changed");
      if (result.canceled || result.filePaths.length === 0) return { ok: true, payload: { canceled: true } };
      if (result.filePaths.length !== 1 || !isAbsolute(result.filePaths[0]!)) throw Error("invalid-selection");
      const path = realpathSync(result.filePaths[0]!);
      const stat = statSync(path);
      if (payload.kind === "directory") {
        if (!stat.isDirectory()) throw Error("not-directory");
        accessSync(path, constants.R_OK | (process.platform === "win32" ? 0 : constants.X_OK));
      } else {
        if (!stat.isFile()) throw Error("not-file");
        accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      }
      return { ok: true, payload: { canceled: false, path } };
    } catch (error) {
      if (error instanceof TrustDomainViolation) return { ok: false, error: `${error.code}: ${error.message}` };
      return { ok: false, error: "resource-selection-failed: 所选资源不可用或类型／权限不符，请重新选择" };
    } finally {
      if (owner !== undefined) pending.delete(owner);
    }
  });
}
