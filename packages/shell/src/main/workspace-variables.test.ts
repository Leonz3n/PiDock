import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveTaskVariables,
  TaskVariableStore,
  variableEnvironment,
  variableNameRefusal,
  VariableInputError,
} from "./workspace-variables.js";

const homes: string[] = [];
function home() {
  const root = mkdtempSync(join(tmpdir(), "pidock-vars-"));
  homes.push(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of homes.splice(0)) rmSync(root, { recursive: true, force: true });
});

const workspaceRows = [{ key: "NODE_ENV", value: "development" }, { key: "API_BASE_URL", value: "https://api.dev.example" }];

describe("effective workspace variables and task overrides", () => {
  it("inherits workspace values, lets a task override one, and restores inheritance when the override is deleted", async () => {
    const store = new TaskVariableStore(home());
    expect(store.list("task-a")).toEqual([]);
    expect(resolveTaskVariables(workspaceRows, store.list("task-a")).rows).toEqual([
      { key: "API_BASE_URL", value: "https://api.dev.example", scope: "workspace", inheritedValue: null },
      { key: "NODE_ENV", value: "development", scope: "workspace", inheritedValue: null },
    ]);

    store.set("task-a", "NODE_ENV", "test");
    const overridden = resolveTaskVariables(workspaceRows, store.list("task-a"));
    expect(overridden.rows).toEqual([
      { key: "API_BASE_URL", value: "https://api.dev.example", scope: "workspace", inheritedValue: null },
      { key: "NODE_ENV", value: "test", scope: "task", inheritedValue: "development" },
    ]);

    const removed = store.remove("task-a", "NODE_ENV");
    expect(removed.removed).toBe(true);
    expect(resolveTaskVariables(workspaceRows, store.list("task-a")).rows).toEqual([
      { key: "API_BASE_URL", value: "https://api.dev.example", scope: "workspace", inheritedValue: null },
      { key: "NODE_ENV", value: "development", scope: "workspace", inheritedValue: null },
    ]);
    // Deleting the last override drops the task entry instead of leaving an empty shadow layer.
    expect(store.list("task-a")).toEqual([]);
    expect(store.remove("task-a", "NODE_ENV")).toEqual({ removed: false, overrides: [] });
  });

  it("keeps two tasks isolated: one override never becomes another task's value", () => {
    const store = new TaskVariableStore(home());
    store.set("task-a", "NODE_ENV", "task-a-only");
    const a = variableEnvironment(resolveTaskVariables(workspaceRows, store.list("task-a")).rows);
    const b = variableEnvironment(resolveTaskVariables(workspaceRows, store.list("task-b")).rows);
    expect(a).toMatchObject({ NODE_ENV: "task-a-only", API_BASE_URL: "https://api.dev.example" });
    expect(b).toMatchObject({ NODE_ENV: "development", API_BASE_URL: "https://api.dev.example" });
    expect(b["NODE_ENV"]).toBe("development");
  });

  it("persists workspace-independent task overrides across a restart with a new store instance", () => {
    const root = home();
    const first = new TaskVariableStore(root);
    first.set("task-a", "NODE_ENV", "test");
    first.set("task-a", "DEBUG", "pidock:*");
    const second = new TaskVariableStore(root);
    expect(second.list("task-a")).toEqual([{ key: "DEBUG", value: "pidock:*" }, { key: "NODE_ENV", value: "test" }]);
    // One exact-key upsert replaces only that key.
    second.set("task-a", "NODE_ENV", "production");
    expect(second.list("task-a")).toEqual([{ key: "DEBUG", value: "pidock:*" }, { key: "NODE_ENV", value: "production" }]);
    if (process.platform !== "win32") expect(statSync(join(root, "task-variables.json")).mode & 0o777).toBe(0o600);
  });

  it("names reserved, credential-shaped and malformed rows with their own refusal", () => {
    const store = new TaskVariableStore(home());
    for (const key of ["PATH", "HOME", "USERPROFILE", "PIDOCK_TASK_ID", "pidock_workspace_id"]) {
      expect(() => store.set("task-a", key, "x")).toThrow(VariableInputError);
      expect(() => store.set("task-a", key, "x")).toThrow(/variable-reserved/);
    }
    for (const key of ["OPENAI_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "DB_PASSWORD", "SERVICE_CREDENTIALS"]) {
      expect(() => store.set("task-a", key, "x")).toThrow(/variable-credential/);
    }
    expect(() => store.set("task-a", "1BAD", "x")).toThrow(/variable-invalid-name/);
    expect(() => store.set("task-a", "BAD KEY", "x")).toThrow(/variable-invalid-name/);
    expect(() => store.set("task-a", "OK", "line\nbreak")).toThrow(/variable-invalid-value/);
    expect(store.list("task-a")).toEqual([]);
    expect(variableNameRefusal("NODE_ENV")).toBeNull();
    expect(variableNameRefusal("API_BASE_URL")).toBeNull();
  });

  it("refuses duplicate rows in a layer and reports legacy reserved rows by key without injecting them", () => {
    const { rows, refused } = resolveTaskVariables(
      [{ key: "NODE_ENV", value: "development" }, { key: "PATH", value: "/untrusted" }],
      [{ key: "OPENAI_API_KEY", value: "never-injected" }],
    );
    expect(rows).toEqual([{ key: "NODE_ENV", value: "development", scope: "workspace", inheritedValue: null }]);
    expect(refused).toEqual([{ key: "PATH", code: "reserved" }, { key: "OPENAI_API_KEY", code: "credential" }]);
    expect(variableEnvironment(rows)).toEqual({ NODE_ENV: "development" });
  });

  it("never puts a value into an error message, log or a sibling credential/config file", async () => {
    const root = home();
    const store = new TaskVariableStore(root);
    const secret = "synthetic-provider-secret-do-not-log";
    store.set("task-a", "NODE_ENV", "shared-value-not-a-secret");
    // A credential-shaped name with a secret value: refused, and the value never appears in the message.
    let message = "";
    try { store.set("task-a", "OPENAI_API_KEY", secret); } catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toContain("OPENAI_API_KEY");
    expect(message).not.toContain(secret);

    // Sibling files where a leak would be dangerous.
    const taskFile = join(root, "tasks", "task-a", "task.json");
    rmSync(join(root, "tasks"), { recursive: true, force: true });
    mkdirSync(join(root, "tasks", "task-a"), { recursive: true });
    writeFileSync(taskFile, JSON.stringify({ taskId: "task-a", name: "任务" }));
    writeFileSync(join(root, "models.json"), JSON.stringify({ providers: {} }));
    writeFileSync(join(root, "secrets.json"), JSON.stringify({ openai: secret }));
    for (const file of ["task-variables.json", "projects.json", "models.json", taskFile]) {
      const path = join(root, file);
      expect(existsSync(path) ? readFileSync(path, "utf8") : "").not.toContain(secret);
    }
    // The shared map holds the shared value only.
    expect(readFileSync(join(root, "task-variables.json"), "utf8")).toContain("shared-value-not-a-secret");
    expect(readFileSync(join(root, "task-variables.json"), "utf8")).not.toContain(secret);

    // A refused legacy row is logged by key only.
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
    resolveTaskVariables([{ key: "PATH", value: secret }], []);
    expect(logged).toEqual([]);
  });
});
