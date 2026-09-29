import { describe, expect, it } from "vitest";
import { assertSdkContextEnv, buildSdkContextEnv } from "./sdk-context-env.js";

const baseEnv: Record<string, string | undefined> = {
  PATH: "/usr/bin:/bin",
  TMPDIR: "/tmp",
  HOME: "/Users/someone",
  LANG: "zh_CN.UTF-8",
  OPENAI_API_KEY: "SYNTHETIC_AMBIENT_KEY",
  ANTHROPIC_API_KEY: "SYNTHETIC_AMBIENT_KEY_2",
  AWS_ACCESS_KEY_ID: "SYNTHETIC_AMBIENT_KEY_3",
  AWS_SECRET_ACCESS_KEY: "SYNTHETIC_AMBIENT_KEY_4",
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  NODE_OPTIONS: "--require=/tmp/hostile.js",
  ELECTRON_RUN_AS_NODE: "1",
  SECRET: "SYNTHETIC_AMBIENT_KEY_5",
  PIDOCK_SDK_ISOLATED: "0",
  PIDOCK_TASK_DIR: "/somewhere/else",
};

const task = { taskId: "task-abcdef12", taskDir: "/tmp/root/task-abcdef12" };
const dirs = { home: "/tmp/root/task-abcdef12/.pidock-sdk-home", workspaceId: "workspace-a" };

describe("buildSdkContextEnv", () => {
  it("forwards only the OS minimum, the private home and the task binding", () => {
    const env = buildSdkContextEnv(baseEnv, task, dirs, "posix");
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      TMPDIR: "/tmp",
      LANG: "zh_CN.UTF-8",
      HOME: dirs.home,
      USERPROFILE: dirs.home,
      PIDOCK_SDK_ISOLATED: "1",
      PIDOCK_TASK_ID: task.taskId,
      PIDOCK_TASK_DIR: task.taskDir,
      PIDOCK_WORKSPACE_ID: "workspace-a",
    });
    // The user home, every ambient credential, the proxy and the
    // process-control variables must not cross into the model context.
    for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "SECRET", "HTTP_PROXY", "HTTPS_PROXY", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"]) {
      expect(env[name]).toBeUndefined();
    }
    expect(() => assertSdkContextEnv(env, "posix")).not.toThrow();
  });

  it("keeps the Windows minimum on win32 without POSIX-only variables", () => {
    const env = buildSdkContextEnv({ ...baseEnv, SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe", LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local" }, task, dirs, "win32");
    expect(env["SystemRoot"]).toBe("C:\\Windows");
    expect(env["LOCALAPPDATA"]).toBe("C:\\Users\\someone\\AppData\\Local");
    expect(env["LANG"]).toBeUndefined();
    expect(env["PATH"]).toBe("/usr/bin:/bin");
    expect(() => assertSdkContextEnv(env, "win32")).not.toThrow();
  });

  it("fails closed on partial bindings, a relative home and invalid passthrough values", () => {
    expect(() => buildSdkContextEnv(baseEnv, { taskId: "", taskDir: task.taskDir }, dirs, "posix")).toThrow("taskId");
    expect(() => buildSdkContextEnv(baseEnv, { taskId: task.taskId, taskDir: "relative/dir" }, dirs, "posix")).toThrow("taskDir");
    expect(() => buildSdkContextEnv(baseEnv, task, { home: "relative/home" }, "posix")).toThrow("sdk home");
    expect(buildSdkContextEnv({ ...baseEnv, PATH: "/usr/bin\0/bin", TMPDIR: "" }, task, dirs, "posix")["PATH"]).toBeUndefined();
  });

  it("rejects a tampered environment: extra names, credential-shaped names, missing opt-in or binding", () => {
    const env = buildSdkContextEnv(baseEnv, task, dirs, "posix");
    expect(() => assertSdkContextEnv({ ...env, OPENAI_API_KEY: "x" }, "posix")).toThrow("sdk-context-env-unexpected");
    expect(() => assertSdkContextEnv({ ...env, PIDOCK_PROVIDER_TEST: "x" }, "posix")).toThrow("sdk-context-env-unexpected");
    expect(() => assertSdkContextEnv({ ...env, PIDOCK_API_KEY: "x" }, "posix")).toThrow("sdk-context-env-unexpected");
    expect(() => assertSdkContextEnv({ ...env, PIDOCK_SDK_ISOLATED: "0" }, "posix")).toThrow("sdk-context-env-unisolated");
    const noHome = { ...env };
    delete noHome["HOME"];
    expect(() => assertSdkContextEnv(noHome, "posix")).toThrow("sdk-context-env-missing-home");
    const noTask = { ...env };
    delete noTask["PIDOCK_TASK_DIR"];
    expect(() => assertSdkContextEnv(noTask, "posix")).toThrow("sdk-context-env-missing-task-dir");
    const relativeTask = { ...env, PIDOCK_TASK_DIR: "relative/dir" };
    expect(() => assertSdkContextEnv(relativeTask, "posix")).toThrow("sdk-context-env-missing-task-dir");
    expect(() => assertSdkContextEnv({ ...env, PATH: "/usr/bin\0/bin" }, "posix")).toThrow("sdk-context-env-invalid");
  });

  it("treats an explicit reference variable as a leak even though the builder never emits one", () => {
    const env = buildSdkContextEnv(baseEnv, task, dirs, "posix");
    expect(() => assertSdkContextEnv({ ...env, OPENAI_API_KEY: "SYNTHETIC" }, "posix")).toThrow("sdk-context-env-unexpected");
  });
});
