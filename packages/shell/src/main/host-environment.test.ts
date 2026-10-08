import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ profile: "/synthetic-profile", forks: [] as Array<Record<string, string>> }));
vi.mock("electron", () => ({
  app: { getPath: () => state.profile },
  BrowserWindow: class {}, WebContentsView: class {}, dialog: {}, ipcMain: {}, session: {},
  utilityProcess: {
    fork: (_entry: string, _args: string[], options: { env: Record<string, string> }) => {
      state.forks.push(options.env);
      return new EventEmitter();
    },
  },
}));

import { createHost } from "./runtime.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  state.forks.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Electron fork is doubled at the OS boundary. Descendant Node/Git below are
// real local processes; this file does not claim actual utilityProcess evidence.
describe("createHost startup environment", () => {
  it.skipIf(process.platform === "win32")("passes the main-resolved default root and excludes unrelated credentials from POSIX descendants", async () => {
    const root = mkdtempSync(join(tmpdir(), "pidock-host-env-"));
    roots.push(root);
    const baseEnv = {
      PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root,
      PIDOCK_DEFAULT_ROOT: `${root}///`, PIDOCK_PROVIDER_SELECTED: "synthetic-selected-secret",
      OPENAI_API_KEY: "synthetic-unrelated-secret", BUSINESS_AUTH: "synthetic-business-secret", AWS_SECRET_ACCESS_KEY: "synthetic-cloud-secret",
      PIDOCK_TASK_ID: "forged-task", PIDOCK_TASK_DIR: "/forged", PIDOCK_PROTECTED_PROFILE: "/forged-profile",
      NODE_OPTIONS: "--require /untrusted", HTTP_PROXY: "http://untrusted", GIT_CONFIG_GLOBAL: "/untrusted",
    };
    vi.stubGlobal("process", Object.assign(Object.create(process) as NodeJS.Process, { env: baseEnv }));
    const { client } = await createHost("workspace", false, { taskId: "task-a", taskDir: join(root, "task-a") });
    client.dispose();
    const env = state.forks[0]!;
    expect(env).toEqual({
      PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root,
      PIDOCK_WORKSPACE_ID: "workspace", PIDOCK_TASK_ID: "task-a", PIDOCK_TASK_DIR: join(root, "task-a"),
      PIDOCK_PROTECTED_PROFILE: "/synthetic-profile", PIDOCK_DEFAULT_ROOT: root,
      // A bound task Host must load the strict service-owner inventory before
      // it can serve anything; this marker is the only extra task-host key.
      PIDOCK_SERVICE_OWNER_REQUIRED: "1",
    });
    const observed = execFileSync(process.execPath, ["-e", "console.log(JSON.stringify({unrelated:process.env.OPENAI_API_KEY??null,business:process.env.BUSINESS_AUTH??null,cloud:process.env.AWS_SECRET_ACCESS_KEY??null,selected:process.env.PIDOCK_PROVIDER_SELECTED??null,task:process.env.PIDOCK_TASK_ID,root:process.env.PIDOCK_DEFAULT_ROOT,serviceOwnerRequired:process.env.PIDOCK_SERVICE_OWNER_REQUIRED??null}))"], { env, encoding: "utf8" });
    expect(JSON.parse(observed)).toEqual({ unrelated: null, business: null, cloud: null, selected: null, task: "task-a", root, serviceOwnerRequired: "1" });
    execFileSync("git", ["init", "-q", "--template=", root], { env, stdio: "pipe" });
    expect(execFileSync("git", ["status", "--porcelain"], { env, cwd: root, encoding: "utf8" })).toBe("");
  });

  it.skipIf(process.platform === "win32")("keeps the task-only service-owner marker out of the unbound root Host environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "pidock-host-env-root-"));
    roots.push(root);
    vi.stubGlobal("process", Object.assign(Object.create(process) as NodeJS.Process, {
      env: {
        PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root, PIDOCK_DEFAULT_ROOT: root,
        OPENAI_API_KEY: "synthetic-unrelated-secret",
        PIDOCK_SERVICE_OWNER_REQUIRED: "ambient-forged",
      },
    }));
    const { client } = await createHost("workspace", false);
    client.dispose();
    expect(state.forks[0]).toEqual({
      PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root,
      PIDOCK_WORKSPACE_ID: "workspace",
      PIDOCK_PROTECTED_PROFILE: "/synthetic-profile", PIDOCK_DEFAULT_ROOT: root,
    });
  });
});
