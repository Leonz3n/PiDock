import { expect, it } from "vitest";
import { buildHostEnv, buildTerminalEnv } from "./host-guards.js";
import { resolveHostShellProfiles } from "./terminal-profiles.js";

it("keeps OS startup inputs through main/Host/terminal, without ambient credentials or runtime bindings", () => {
  const host = buildHostEnv({ SystemRoot: "C:\\Windows", Path: "C:\\tools", ProgramFiles: "C:\\Program Files",
    OPENAI_API_KEY: "synthetic-secret", NODE_OPTIONS: "--require unwanted", ELECTRON_RUN_AS_NODE: "1" },
  "workspace", { taskId: "task-test", taskDir: "C:\\tasks\\task-test" }, undefined, undefined, "win32");
  const env = buildTerminalEnv(host, {}, "win32");
  expect(env).toEqual({ SystemRoot: "C:\\Windows", PATH: "C:\\tools", ProgramFiles: "C:\\Program Files" });
  expect(host["PIDOCK_TASK_ID"]).toBe("task-test");
  const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  expect(resolveHostShellProfiles({ platform: "win32", env: host,
    probe: { exists: p => p === pwsh, isExecutable: p => p === pwsh } }).profiles[0]?.program).toBe(pwsh);
});

it("overlays task keys case-insensitively on Windows, keeping fresh isolated envs", () => {
  const base = { PATH: "C:\\tools", SystemRoot: "C:\\Windows", PIDOCK_PROVIDER_MAIN: "synthetic-secret" };
  const task = { Path: "C:\\task-tools", TASK_VALUE: "one" };
  const first = buildTerminalEnv(base, task, "win32");
  expect(first).toEqual({ SystemRoot: "C:\\Windows", Path: "C:\\task-tools", TASK_VALUE: "one" });
  first["SystemRoot"] = "changed";
  expect(buildTerminalEnv(base, {}, "win32")).toEqual({ PATH: "C:\\tools", SystemRoot: "C:\\Windows" });
  expect(base.SystemRoot).toBe("C:\\Windows");
  expect(task).toEqual({ Path: "C:\\task-tools", TASK_VALUE: "one" });
});

it("keeps POSIX case sensitivity and startup env without importing unrelated ambient secrets", () => {
  expect(buildTerminalEnv({ PATH: "/bin", HOME: "/home/test", SECRET: "synthetic-secret" }, { Path: "separate", TASK_VALUE: "one" }, "darwin"))
    .toEqual({ PATH: "/bin", HOME: "/home/test", Path: "separate", TASK_VALUE: "one" });
});
