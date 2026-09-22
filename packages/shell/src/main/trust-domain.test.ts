import { describe, expect, it } from "vitest";
import {
  TrustDomainRegistry,
  TrustDomainViolation,
  validateShellInvocationPayload,
} from "./trust-domain.js";

const SHELL_ID = 101;
const TASK_ID = 202;
const UNKNOWN_ID = 303;

function registry(): TrustDomainRegistry {
  const domains = new TrustDomainRegistry();
  domains.registerShell({
    webContentsId: SHELL_ID,
    viewId: "shell-view",
    workspaceId: "workspace-a",
  });
  domains.registerTask({
    webContentsId: TASK_ID,
    viewId: "task-view",
    workspaceId: "workspace-a",
    taskId: "task-a",
    pageId: "page-a",
  });
  return domains;
}

function sender(webContentsId: number, routingId = 7) {
  return {
    sender: {
      id: webContentsId,
      mainFrame: { processId: 3, routingId },
    },
    senderFrame: { processId: 3, routingId },
  };
}

describe("TrustDomainRegistry identity checks", () => {
  it("keeps shell and task views in distinct trust domains", () => {
    const domains = registry();

    expect(domains.get(SHELL_ID)).toMatchObject({
      domain: "shell",
      viewId: "shell-view",
      workspaceId: "workspace-a",
    });
    expect(domains.get(TASK_ID)).toMatchObject({
      domain: "task",
      viewId: "task-view",
      taskId: "task-a",
      pageId: "page-a",
    });
  });

  it("rejects an IPC message from an unregistered WebContents", () => {
    expect(() => registry().requireShellSender(sender(UNKNOWN_ID))).toThrow(
      TrustDomainViolation,
    );
  });

  it("rejects a task WebContents masquerading as the shell domain", () => {
    expect(() => registry().requireShellSender(sender(TASK_ID))).toThrow(
      "sender is not in the shell trust domain",
    );
  });

  it("rejects IPC sent from a non-main frame", () => {
    const event = sender(SHELL_ID, 7);
    event.senderFrame = { processId: 3, routingId: 8 };

    expect(() => registry().requireShellSender(event)).toThrow(
      "IPC sender is not the main frame",
    );
  });

  it("rejects duplicate WebContents registrations", () => {
    const domains = registry();

    expect(() =>
      domains.registerTask({
        webContentsId: SHELL_ID,
        viewId: "replacement-task-view",
        workspaceId: "workspace-a",
        taskId: "task-b",
        pageId: "page-b",
      }),
    ).toThrow("WebContents 101 already has a trust binding");
  });

  it("only resolves the exact task/page identity", () => {
    const domains = registry();

    expect(
      domains.requireTaskBinding(TASK_ID, {
        taskId: "task-a",
        pageId: "page-a",
      }),
    ).toMatchObject({ taskId: "task-a", pageId: "page-a" });
    expect(() =>
      domains.requireTaskBinding(TASK_ID, {
        taskId: "task-a",
        pageId: "page-b",
      }),
    ).toThrow("task/page identity mismatch");
  });
});

describe("validateShellInvocationPayload", () => {
  it("accepts an omitted workspace id and binds it to the sender's workspace", () => {
    expect(
      validateShellInvocationPayload("shell/hostPing", undefined, "workspace-a"),
    ).toEqual({ workspaceId: "workspace-a" });
  });

  it("accepts only the sender's workspace id", () => {
    expect(
      validateShellInvocationPayload(
        "shell/hostPing",
        { workspaceId: "workspace-a" },
        "workspace-a",
      ),
    ).toEqual({ workspaceId: "workspace-a" });
  });

  it("rejects a mismatched workspace payload", () => {
    expect(() =>
      validateShellInvocationPayload(
        "shell/hostPing",
        { workspaceId: "workspace-b" },
        "workspace-a",
      ),
    ).toThrow("payload workspace does not match sender binding");
  });

  it("routes a task op by task id while binding the workspace to the sender", () => {
    expect(
      validateShellInvocationPayload(
        "shell/taskOp",
        { taskId: "task-a", op: "task/sendMessage", payload: {} },
        "workspace-a",
      ),
    ).toEqual({ workspaceId: "workspace-a" });
    expect(() =>
      validateShellInvocationPayload(
        "shell/taskOp",
        { taskId: "task-a", op: "task/exec", payload: {} },
        "workspace-a",
      ),
    ).toThrow("unknown task op");
    expect(() =>
      validateShellInvocationPayload(
        "shell/taskOp",
        { taskId: "", op: "task/cancel", payload: {} },
        "workspace-a",
      ),
    ).toThrow("requires a taskId");
    expect(() =>
      validateShellInvocationPayload(
        "shell/taskOp",
        { taskId: "task-a", op: "task/cancel", workspaceId: "workspace-b" },
        "workspace-a",
      ),
    ).toThrow("payload workspace does not match sender binding");
  });

  it("rejects unexpected payload keys", () => {
    expect(() =>
      validateShellInvocationPayload(
        "shell/hostPing",
        { workspaceId: "workspace-a", taskId: "task-b" },
        "workspace-a",
      ),
    ).toThrow("invalid shell/hostPing payload");
  });

  it("does not permit a payload for shell/getVersions", () => {
    expect(() =>
      validateShellInvocationPayload(
        "shell/getVersions",
        { workspaceId: "workspace-a" },
        "workspace-a",
      ),
    ).toThrow("shell/getVersions does not accept a payload");
  });
});
