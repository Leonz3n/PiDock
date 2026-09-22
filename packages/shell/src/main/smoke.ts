import { app, WebContentsView } from "electron";
import type { UtilityProcess } from "electron";
import type { HostClient } from "../rpc/host-client.js";
import type { TrustBinding } from "./trust-domain.js";
import type {
  TrustedWindowEvidence,
  TrustedWindowViews,
  ViewPlacementEvidence,
  WebPreferencesEvidence,
} from "./runtime.js";
import {
  PAGE_ID,
  SHELL_WEB_PREFERENCES,
  TASK_ID,
  TASK_WEB_PREFERENCES,
  assertSafeWebPreferences,
  assertTrustedWindowEvidence,
  createHost,
  createTrustedWindow,
  errorMessage,
  loadTrustedViews,
  registerIpc,
  trustedWindowEvidence,
  webPreferencesEvidence,
} from "./runtime.js";

export interface SmokeEvidence {
  window: WebPreferencesEvidence;
  rendererUrl: string;
  taskUrl: string;
  trustDomains?: {
    shell: WebPreferencesEvidence;
    task: WebPreferencesEvidence;
  };
  views?: TrustedWindowEvidence;
  shellProbe?: unknown;
  taskProbe?: unknown;
  unregisteredProbe?: unknown;
}

export interface SmokeSuccessReport {
  schema: "pidock.shell.smoke.v2";
  ok: true;
  electron: string;
  mainNode: string;
  utilityNode: string;
  window: {
    sandbox: true;
    contextIsolation: true;
    nodeIntegration: false;
  };
  renderer: {
    bridge: "object";
    globals: {
      require: "undefined";
      process: "undefined";
      module: "undefined";
    };
    security: {
      sandboxed: true;
      contextIsolated: true;
    };
  };
  rpc: {
    ping: { pong: true; workspaceId: string };
    versions: {
      electron: string;
      mainNode: string;
      utilityNode: string;
      workspaceId: string;
    };
  };
  trustDomains: {
    sameBrowserWindow: true;
    distinctWebContents: true;
    browserWindow: {
      id: number;
      visible: true;
      childCount: 2;
    };
    views: {
      shell: {
        webPreferences: WebPreferencesEvidence;
        placement: ViewPlacementEvidence;
      };
      task: {
        webPreferences: WebPreferencesEvidence;
        placement: ViewPlacementEvidence;
      };
    };
    shell: {
      bridge: "object";
      bridgeKeys: string[];
      security: { sandboxed: true; contextIsolated: true };
      senderAccepted: true;
      payloadMismatchRejected: true;
    };
    task: {
      bridge: "undefined";
      globals: {
        require: "undefined";
        process: "undefined";
        module: "undefined";
        ipcRenderer: "undefined";
        electron: "undefined";
        cdp: "undefined";
      };
      binding: {
        viewId: string;
        workspaceId: string;
        taskId: string;
        pageId: string;
      };
      wrongPageRejected: true;
      shellDomainRejected: true;
    };
    unregisteredShellView: {
      webContentsId: number;
      bridge: "object";
      senderRejected: true;
    };
  };
}

export interface SmokeFailureReport {
  schema: "pidock.shell.smoke.v2";
  ok: false;
  error: {
    stage: string;
    message: string;
  };
  evidence: SmokeEvidence;
}

export type SmokeReport = SmokeSuccessReport | SmokeFailureReport;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} is missing or not an object`);
  }
  return value;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}.${key} is missing or not a non-empty string`);
  }
  return value;
}

function shellSmokeScript(
  workspaceId: string,
  mismatchedWorkspaceId: string,
): string {
  return `(async () => {
    const globals = {
      require: typeof require,
      process: typeof process,
      module: typeof module,
      pidock: typeof window.pidock,
      ipcRenderer: typeof window.ipcRenderer,
      electron: typeof window.electron,
    };
    if (typeof window.pidock !== "object" || window.pidock === null) {
      return { globals, bridge: false };
    }
    const bridgeKeys = Object.keys(window.pidock).sort();
    const security = window.pidock.getSecurityState();
    const ping = await window.pidock.hostPing(${JSON.stringify(workspaceId)});
    const versions = await window.pidock.getVersions();
    let mismatchRejected = false;
    let mismatchError = "";
    try {
      const mismatch = await window.pidock.hostPing(${JSON.stringify(mismatchedWorkspaceId)});
      mismatchRejected = Boolean(
        mismatch &&
        mismatch.ok === false &&
        typeof mismatch.error === "string" &&
        mismatch.error.includes("payload workspace does not match")
      );
      mismatchError = mismatch && typeof mismatch.error === "string"
        ? mismatch.error
        : JSON.stringify(mismatch);
    } catch (error) {
      mismatchError = error && error.message ? error.message : String(error);
    }
    return {
      globals,
      bridge: true,
      bridgeKeys,
      security,
      ping,
      versions,
      mismatchRejected,
      mismatchError,
    };
  })()`;
}

function taskSmokeScript(): string {
  return `(() => ({
    globals: {
      require: typeof require,
      process: typeof process,
      module: typeof module,
      pidock: typeof window.pidock,
      ipcRenderer: typeof window.ipcRenderer,
      electron: typeof window.electron,
      cdp: typeof window.cdp,
    },
    marker: document.body.dataset.trustDomain || null,
    title: document.title,
  }))()`;
}

function unregisteredShellSmokeScript(): string {
  return `(async () => {
    const globals = {
      require: typeof require,
      process: typeof process,
      module: typeof module,
      pidock: typeof window.pidock,
      ipcRenderer: typeof window.ipcRenderer,
    };
    try {
      const result = await window.pidock.getVersions();
      const rejected = Boolean(
        result &&
        result.ok === false &&
        typeof result.error === "string" &&
        result.error.includes("unknown WebContents sender")
      );
      return {
        globals,
        rejected,
        error: result && typeof result.error === "string"
          ? result.error
          : JSON.stringify(result),
      };
    } catch (error) {
      return {
        globals,
        rejected: false,
        error: error && error.message ? error.message : String(error),
      };
    }
  })()`;
}

function validateShellProbe(
  raw: unknown,
  workspaceId: string,
  shellPreferences: WebPreferencesEvidence,
): {
  globals: Record<string, unknown>;
  bridgeKeys: string[];
  security: { sandboxed: true; contextIsolated: true };
  ping: { pong: true; workspaceId: string };
  versions: {
    electron: string;
    mainNode: string;
    utilityNode: string;
    workspaceId: string;
  };
  mismatchRejected: true;
} {
  assertSafeWebPreferences(shellPreferences, "shell");
  const probe = requireRecord(raw, "shell renderer probe");
  const globals = requireRecord(probe["globals"], "shell globals");
  for (const key of ["require", "process", "module", "ipcRenderer", "electron"]) {
    if (globals[key] !== "undefined") {
      throw new Error(`shell Node/arbitrary IPC global leaked: ${String(key)}`);
    }
  }
  if (probe["bridge"] !== true || globals["pidock"] !== "object") {
    throw new Error("shell window.pidock bridge is missing");
  }

  const bridgeKeys = probe["bridgeKeys"];
  if (
    !Array.isArray(bridgeKeys) ||
    bridgeKeys.some((key) => typeof key !== "string") ||
    JSON.stringify(bridgeKeys) !==
      JSON.stringify([
        "getSecurityState",
        "getVersions",
        "hostPing",
        "onHostStatus",
      ])
  ) {
    throw new Error(`shell bridge surface mismatch: ${JSON.stringify(bridgeKeys)}`);
  }

  const security = requireRecord(probe["security"], "shell security");
  if (
    security["sandboxed"] !== true ||
    security["contextIsolated"] !== true
  ) {
    throw new Error(`shell preload security mismatch: ${JSON.stringify(security)}`);
  }

  const pingEnvelope = requireRecord(probe["ping"], "shell hostPing");
  if (pingEnvelope["ok"] !== true) {
    throw new Error(`shell hostPing envelope mismatch: ${JSON.stringify(pingEnvelope)}`);
  }
  const ping = requireRecord(pingEnvelope["payload"], "shell hostPing payload");
  if (ping["pong"] !== true || ping["workspaceId"] !== workspaceId) {
    throw new Error(`shell hostPing evidence mismatch: ${JSON.stringify(ping)}`);
  }

  const versionsEnvelope = requireRecord(probe["versions"], "shell getVersions");
  if (versionsEnvelope["ok"] !== true) {
    throw new Error(
      `shell getVersions envelope mismatch: ${JSON.stringify(versionsEnvelope)}`,
    );
  }
  const versions = requireRecord(
    versionsEnvelope["payload"],
    "shell getVersions payload",
  );
  const versionEvidence = {
    electron: requireString(versions, "electron", "versions"),
    mainNode: requireString(versions, "mainNode", "versions"),
    utilityNode: requireString(versions, "utilityNode", "versions"),
    workspaceId: requireString(versions, "workspaceId", "versions"),
  };
  if (versionEvidence.workspaceId !== workspaceId) {
    throw new Error(
      `shell getVersions workspace mismatch: ${versionEvidence.workspaceId}`,
    );
  }

  if (
    probe["mismatchRejected"] !== true ||
    typeof probe["mismatchError"] !== "string" ||
    !probe["mismatchError"].includes("payload workspace does not match")
  ) {
    throw new Error(
      `payload mismatch was not rejected: ${JSON.stringify(probe)}`,
    );
  }

  return {
    globals,
    bridgeKeys: bridgeKeys as string[],
    security: { sandboxed: true, contextIsolated: true },
    ping: { pong: true, workspaceId },
    versions: versionEvidence,
    mismatchRejected: true,
  };
}

function validateTaskProbe(raw: unknown): {
  globals: {
    require: "undefined";
    process: "undefined";
    module: "undefined";
    ipcRenderer: "undefined";
    electron: "undefined";
    cdp: "undefined";
  };
} {
  const probe = requireRecord(raw, "task renderer probe");
  const globals = requireRecord(probe["globals"], "task globals");
  for (const key of [
    "require",
    "process",
    "module",
    "pidock",
    "ipcRenderer",
    "electron",
    "cdp",
  ]) {
    if (globals[key] !== "undefined") {
      throw new Error(`task trust boundary leaked global: ${String(key)}`);
    }
  }
  if (probe["marker"] !== "task" || probe["title"] !== "PiDock Task Page (S2)") {
    throw new Error(`task fixture identity mismatch: ${JSON.stringify(probe)}`);
  }
  return {
    globals: {
      require: "undefined",
      process: "undefined",
      module: "undefined",
      ipcRenderer: "undefined",
      electron: "undefined",
      cdp: "undefined",
    },
  };
}

function validateUnregisteredProbe(raw: unknown): {
  rejected: true;
  webContentsId: number;
} {
  const probe = requireRecord(raw, "unregistered shell probe");
  const globals = requireRecord(probe["globals"], "unregistered globals");
  if (
    globals["pidock"] !== "object" ||
    probe["rejected"] !== true ||
    typeof probe["webContentsId"] !== "number"
  ) {
    throw new Error(
      `unregistered shell sender was not rejected: ${JSON.stringify(probe)}`,
    );
  }
  return { rejected: true, webContentsId: probe["webContentsId"] };
}

function validateSmokeResult(
  shellRaw: unknown,
  taskRaw: unknown,
  unregisteredRaw: unknown,
  views: TrustedWindowViews,
  viewEvidence: TrustedWindowEvidence,
  shellPreferences: WebPreferencesEvidence,
  taskPreferences: WebPreferencesEvidence,
  workspaceId: string,
): SmokeSuccessReport {
  assertTrustedWindowEvidence(viewEvidence);
  assertSafeWebPreferences(shellPreferences, "shell");
  assertSafeWebPreferences(taskPreferences, "task");
  const shell = validateShellProbe(shellRaw, workspaceId, shellPreferences);
  const task = validateTaskProbe(taskRaw);
  const unregistered = validateUnregisteredProbe(unregisteredRaw);

  views.registry.requireShellSender({
    sender: views.shellView.webContents,
    senderFrame: views.shellView.webContents.mainFrame,
  });
  const taskBinding = views.registry.requireTaskBinding(
    views.taskView.webContents.id,
    { taskId: TASK_ID, pageId: PAGE_ID },
  );

  let wrongPageRejected = false;
  try {
    views.registry.requireTaskBinding(views.taskView.webContents.id, {
      taskId: TASK_ID,
      pageId: "wrong-page",
    });
  } catch {
    wrongPageRejected = true;
  }
  let shellDomainRejected = false;
  try {
    views.registry.requireShellSender({
      sender: views.taskView.webContents,
      senderFrame: views.taskView.webContents.mainFrame,
    });
  } catch {
    shellDomainRejected = true;
  }
  if (!wrongPageRejected || !shellDomainRejected) {
    throw new Error(
      `task/page identity checks failed: ${JSON.stringify({
        wrongPageRejected,
        shellDomainRejected,
      })}`,
    );
  }

  return {
    schema: "pidock.shell.smoke.v2",
    ok: true,
    electron: shell.versions.electron,
    mainNode: shell.versions.mainNode,
    utilityNode: shell.versions.utilityNode,
    window: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
    renderer: {
      bridge: "object",
      globals: {
        require: "undefined",
        process: "undefined",
        module: "undefined",
      },
      security: {
        sandboxed: true,
        contextIsolated: true,
      },
    },
    rpc: {
      ping: { pong: true, workspaceId },
      versions: shell.versions,
    },
    trustDomains: {
      sameBrowserWindow: true,
      distinctWebContents: true,
      browserWindow: {
        id: viewEvidence.browserWindowId,
        visible: true,
        childCount: 2,
      },
      views: {
        shell: {
          webPreferences: shellPreferences,
          placement: viewEvidence.shell,
        },
        task: {
          webPreferences: taskPreferences,
          placement: viewEvidence.task,
        },
      },
      shell: {
        bridge: "object",
        bridgeKeys: shell.bridgeKeys,
        security: shell.security,
        senderAccepted: true,
        payloadMismatchRejected: shell.mismatchRejected,
      },
      task: {
        bridge: "undefined",
        globals: task.globals,
        binding: bindingEvidence(taskBinding),
        wrongPageRejected: true,
        shellDomainRejected: true,
      },
      unregisteredShellView: {
        webContentsId: unregistered.webContentsId,
        bridge: "object",
        senderRejected: unregistered.rejected,
      },
    },
  };
}

function bindingEvidence(binding: TrustBinding): {
  viewId: string;
  workspaceId: string;
  taskId: string;
  pageId: string;
} {
  if (binding.domain !== "task") {
    throw new Error("expected a task binding");
  }
  return {
    viewId: binding.viewId,
    workspaceId: binding.workspaceId,
    taskId: binding.taskId,
    pageId: binding.pageId,
  };
}

export async function runSmoke(workspaceId: string): Promise<SmokeReport> {
  const shellPreferences = webPreferencesEvidence(
    SHELL_WEB_PREFERENCES,
    true,
  );
  const taskPreferences = webPreferencesEvidence(TASK_WEB_PREFERENCES, false);
  const evidence: SmokeEvidence = {
    window: shellPreferences,
    rendererUrl: process.env["PIDOCK_RENDERER_URL"] ?? "pending",
    taskUrl: process.env["PIDOCK_TASK_URL"] ?? "pending",
    trustDomains: { shell: shellPreferences, task: taskPreferences },
  };
  let stage = "app-ready";
  let client: HostClient | undefined;
  let child: UtilityProcess | undefined;
  let views: TrustedWindowViews | undefined;
  let unregisteredView: WebContentsView | undefined;

  try {
    await app.whenReady();

    stage = "utility-process";
    const host = await createHost(workspaceId, false);
    client = host.client;
    child = host.child;

    stage = "trusted-window";
    views = createTrustedWindow(workspaceId);
    registerIpc(client, views.registry);

    stage = "window-load";
    const loaded = await loadTrustedViews(views);
    evidence.rendererUrl = loaded.shellUrl;
    evidence.taskUrl = loaded.taskUrl;
    const viewEvidence = trustedWindowEvidence(views);
    evidence.views = viewEvidence;

    stage = "shell-probe";
    evidence.shellProbe = await views.shellView.webContents.executeJavaScript(
      shellSmokeScript(workspaceId, `${workspaceId}-other`),
      true,
    );

    stage = "task-probe";
    evidence.taskProbe = await views.taskView.webContents.executeJavaScript(
      taskSmokeScript(),
      true,
    );

    stage = "unregistered-sender-probe";
    unregisteredView = new WebContentsView({
      webPreferences: SHELL_WEB_PREFERENCES,
    });
    await unregisteredView.webContents.loadURL(
      "data:text/html,<title>unregistered shell probe</title>",
    );
    evidence.unregisteredProbe =
      await unregisteredView.webContents.executeJavaScript(
        unregisteredShellSmokeScript(),
        true,
      );
    const rawUnregistered = requireRecord(
      evidence.unregisteredProbe,
      "unregistered shell probe",
    );
    rawUnregistered["webContentsId"] = unregisteredView.webContents.id;

    return validateSmokeResult(
      evidence.shellProbe,
      evidence.taskProbe,
      evidence.unregisteredProbe,
      views,
      viewEvidence,
      shellPreferences,
      taskPreferences,
      workspaceId,
    );
  } catch (error) {
    return {
      schema: "pidock.shell.smoke.v2",
      ok: false,
      error: { stage, message: errorMessage(error) },
      evidence,
    };
  } finally {
    unregisteredView?.webContents.close();
    views?.window.destroy();
    client?.dispose();
    child?.kill();
  }
}
