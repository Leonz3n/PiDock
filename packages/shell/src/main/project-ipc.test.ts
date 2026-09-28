import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performProjectOperation } from "./project-ipc.js";
import { ProjectRegistry } from "./project-registry.js";
import { TrustDomainRegistry } from "./trust-domain.js";

const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), "pidock-project-ipc-"));
  roots.push(root);
  const domains = new TrustDomainRegistry();
  domains.registerShell({ webContentsId: 1, workspaceId: "ws", viewId: "shell" });
  domains.registerTask({ webContentsId: 2, workspaceId: "ws", viewId: "task", taskId: "task", pageId: "page" });
  return { store: new ProjectRegistry(root), domains };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sender = (id: number, frame = 1) => ({ sender: { id, mainFrame: { processId: 1, routingId: 1 } }, senderFrame: { processId: 1, routingId: frame } });

it("requires trusted shell main frame before any project operation", async () => {
  const { store, domains } = setup();
  for (const event of [sender(2), sender(1, 2), sender(999)]) {
    expect(() => domains.requireShellSender(event)).toThrow();
  }
  domains.requireShellSender(sender(1));
  expect(await performProjectOperation(store, { op: "list" })).toEqual({ initialized: false, projects: [] });
});

describe("project IPC operation shape", () => {
  it("rejects arbitrary registry paths, extra keys, membership writes and malformed operations", async () => {
    const { store } = setup();
    for (const request of [
      { op: "list", path: "/tmp/another-registry" }, { op: "assign", taskId: "task" },
      { op: "create", input: { name: "Foo", description: "", repositories: [], directories: [], memberships: [] } },
      { op: "get", projectId: "../escape" }, { op: "delete", projectId: "x", root: "/tmp" },
      { op: "create", input: { name: "Foo", description: "", repositories: [{ name: "x", path: "~/relative" }], directories: [] } },
    ]) await expect(performProjectOperation(store, request)).rejects.toThrow();
    expect(store.list()).toEqual({ initialized: false, projects: [] });
  });

  it("persists CRUD through one authority and never accepts renderer-selected IDs", async () => {
    const { store } = setup();
    const created = await performProjectOperation(store, { op: "create", input: { name: "Foo", description: "", repositories: [], directories: [] } });
    const row = created as { id: string; name: string };
    expect((await performProjectOperation(store, { op: "get", projectId: row.id }))).toMatchObject({ id: row.id });
    expect(await performProjectOperation(store, { op: "rename", projectId: row.id, name: "Bar" })).toMatchObject({ id: row.id, name: "Bar" });
    await performProjectOperation(store, { op: "delete", projectId: row.id });
    expect(await performProjectOperation(store, { op: "list" })).toEqual({ initialized: true, projects: [] });
  });
});
