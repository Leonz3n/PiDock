import type { App, BrowserWindow } from "electron";
import { backgroundPolicyFor } from "./task-lifecycle.js";
import { createLastWindowShutdown, errorMessage } from "./runtime.js";

/** Owns the existing production window; reentry never replaces its trust bindings. */
export function registerApplicationLifecycle(input: {
  app: Pick<App, "on" | "quit">;
  window: Pick<BrowserWindow, "on" | "isDestroyed" | "isMinimized" | "hide" | "show" | "focus" | "restore">;
  platform: string;
  stopHosts: () => Promise<boolean>;
}): void {
  const { app, window } = input;
  if (window.isDestroyed()) throw Error("application-window-unavailable");
  const background = backgroundPolicyFor({ platform: input.platform });
  let quitting = false;
  let quitFinished = false;
  window.on("close", (event) => {
    if (quitFinished) return;
    if (quitting) { event.preventDefault(); return; }
    if (background.windowClosedContinues) {
      event.preventDefault();
      window.hide();
    }
  });
  const showWindow = () => {
    if (window.isDestroyed()) {
      console.error("[main] application window unavailable; cannot restore the existing window");
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  app.on("activate", () => {
    if (!background.windowClosedContinues || quitting || quitFinished) return;
    showWindow();
  });
  const stopAfterLastWindow = createLastWindowShutdown(input.stopHosts, () => {
    quitFinished = true;
    app.quit();
  });
  app.on("window-all-closed", () => {
    if (!background.windowClosedContinues && !quitting && !quitFinished) void stopAfterLastWindow();
  });
  app.on("before-quit", (event) => {
    if (quitFinished) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void Promise.resolve().then(input.stopHosts).catch((error: unknown) => {
      console.error(`[main] application shutdown failed; retaining Hosts: ${errorMessage(error)}`);
      return false;
    }).then((stopped) => {
      if (stopped) {
        quitFinished = true;
        app.quit();
      } else {
        quitting = false;
        showWindow();
      }
    });
  });
}
