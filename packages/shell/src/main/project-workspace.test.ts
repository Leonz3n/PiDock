import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BRANCH_TEMPLATE, ProjectRegistry, projectRegistryPath } from "./project-registry.js";

const homes: string[] = [];
function registry() {
  const root = mkdtempSync(join(tmpdir(), "pidock-workspace-"));
  homes.push(root);
  return { root, file: projectRegistryPath(root), store: new ProjectRegistry(root) };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

const workspaceRoot = process.platform === "win32" ? "C:\\workspace" : "/workspace";
const environment = [{ key: "NODE_ENV", value: "development" }, { key: "API_BASE_URL", value: "https://api.dev.example" }];
const input = {
  name: "PiDock 核心开发",
  description: "桌面客户端与公共文档",
  repositories: [{ name: "pi-agent-ui", path: join(workspaceRoot, "pi-agent-ui") }],
  directories: [{ name: "docs", path: join(workspaceRoot, "docs") }],
  environment,
  branchTemplate: "feature/{task-name}",
};
/** The on-disk audit contract: project identities, memberships and receipts, in order. */
function digest(projects: { id: string }[], memberships: unknown[], receipts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify({ projectIds: projects.map((row) => row.id), memberships, receipts })).digest("hex");
}

describe("workspace settings persisted by main", () => {
  it("round-trips environment variables and the branch template across a restart", async () => {
    const { root, file, store } = registry();
    const created = await store.create(input);
    expect(created.environment).toEqual(environment);
    expect(created.branchTemplate).toBe("feature/{task-name}");
    const reopened = new ProjectRegistry(root).get(created.id);
    expect(reopened).toEqual(created);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.version).toBe(3);
    expect(saved.projects[0]).toMatchObject({ environment, branchTemplate: "feature/{task-name}" });
    expect(saved.auditDigest).toBe(digest(saved.projects, saved.memberships, saved.receipts));
    expect(JSON.parse(readFileSync(`${file}.bak`, "utf8"))).toMatchObject({ version: 3 });
  });

  it("applies the default branch template and no variables to a create that names neither", async () => {
    const { store } = registry();
    const created = await store.create({ name: "Minimal", description: "", repositories: [], directories: [] });
    expect(created.environment).toEqual([]);
    expect(created.branchTemplate).toBe(DEFAULT_BRANCH_TEMPLATE);
    expect(store.get(created.id)).toEqual(created);
  });

  it("migrates a version 1 registry with defaults and writes the current schema only on the first write", async () => {
    const { file, store } = registry();
    const legacy = { version: 1, projects: [{ id: "0f3b0c8e-6a1a-4c2f-9c1b-3c9d2f6a1b11", name: "Legacy", description: "",
      repositories: [{ id: "1f3b0c8e-6a1a-4c2f-9c1b-3c9d2f6a1b12", name: "repo", path: join(workspaceRoot, "repo") }], directories: [] }],
      memberships: [] };
    writeFileSync(file, JSON.stringify(legacy));
    expect(store.list().projects[0]).toMatchObject({ environment: [], branchTemplate: DEFAULT_BRANCH_TEMPLATE });
    // Reading never rewrites the file.
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
    const renamed = await store.rename(legacy.projects[0]!.id, "Legacy 2");
    expect(renamed).toMatchObject({ id: legacy.projects[0]!.id, environment: [], branchTemplate: DEFAULT_BRANCH_TEMPLATE });
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.version).toBe(3);
    expect(saved.projects[0]).toMatchObject({ name: "Legacy 2", environment: [], branchTemplate: DEFAULT_BRANCH_TEMPLATE });
    expect(saved.auditDigest).toBe(digest(saved.projects, [], []));
    // The previous version is preserved verbatim as the backup.
    expect(JSON.parse(readFileSync(`${file}.bak`, "utf8")).version).toBe(1);
  });

  it("migrates a version 2 registry without dropping its receipts or breaking the audit digest", async () => {
    const { file, store } = registry();
    const project = { id: "2f3b0c8e-6a1a-4c2f-9c1b-3c9d2f6a1b21", name: "Audited", description: "",
      repositories: [], directories: [] };
    const receipt = { id: "3f3b0c8e-6a1a-4c2f-9c1b-3c9d2f6a1b22", at: "2026-10-01T00:00:00Z", action: "delete", projectId: project.id };
    const saved = { version: 2, projects: [project], memberships: [], receipts: [receipt],
      auditDigest: digest([project], [], [receipt]) };
    writeFileSync(file, JSON.stringify(saved));
    expect(store.list().projects[0]).toMatchObject({ id: project.id, environment: [], branchTemplate: DEFAULT_BRANCH_TEMPLATE });
    await store.update(project.id, { description: "改过", repositories: [], directories: [] });
    const migrated = JSON.parse(readFileSync(file, "utf8"));
    expect(migrated.version).toBe(3);
    expect(migrated.receipts).toEqual([receipt]);
    expect(migrated.projects[0]).toMatchObject({ description: "改过", environment: [], branchTemplate: DEFAULT_BRANCH_TEMPLATE });
    expect(migrated.auditDigest).toBe(digest(migrated.projects, [], [receipt]));
  });

  it("refuses duplicate variable names, malformed keys and an invalid branch template", async () => {
    const { store } = registry();
    const bad = [
      [{ key: "NODE_ENV", value: "a" }, { key: "NODE_ENV", value: "b" }],
      [{ key: "1BAD", value: "a" }],
      [{ key: "BAD KEY", value: "a" }],
      [{ key: "OK", value: "line\nbreak" }],
    ];
    for (const rows of bad) {
      await expect(store.create({ ...input, environment: rows })).rejects.toThrow(/environment variable/);
    }
    for (const template of ["", "has space", "a..b", "trailing/", "/leading", "bad~ref", "x".repeat(129)]) {
      await expect(store.create({ ...input, branchTemplate: template })).rejects.toThrow(/branch template/);
    }
    expect(store.list().projects).toHaveLength(0);
  });

  it("renames together with the rest of the workspace in one write, keeping identity and source IDs", async () => {
    const { root, file } = registry();
    let writes = 0;
    const store = new ProjectRegistry(root, { beforeCommit: () => { writes += 1; } });
    const created = await store.create(input);
    const next = await store.update(created.id, { name: "改名后的工作空间", description: "新描述",
      repositories: created.repositories.map((row) => ({ id: row.id, name: "renamed", path: row.path })),
      directories: [], environment: [{ key: "DEBUG", value: "pidock:*" }], branchTemplate: "pi/{task-name}" });
    expect(writes).toBe(2);
    expect(next.id).toBe(created.id);
    expect(next.repositories[0]?.id).toBe(created.repositories[0]?.id);
    expect(next).toMatchObject({ name: "改名后的工作空间", description: "新描述", environment: [{ key: "DEBUG", value: "pidock:*" }], branchTemplate: "pi/{task-name}" });
    expect(new ProjectRegistry(root).get(created.id)).toEqual(next);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.projects[0].id).toBe(created.id);
    expect(saved.auditDigest).toBe(digest(saved.projects, saved.memberships, saved.receipts));
  });

  it("refuses a rename colliding with another workspace and leaves the registry untouched", async () => {
    const { file, store } = registry();
    const first = await store.create(input);
    await store.create({ ...input, name: "另一个工作空间" });
    const before = readFileSync(file, "utf8");
    await expect(store.update(first.id, { name: "另一个工作空间", description: "", repositories: [], directories: [] }))
      .rejects.toThrow(/duplicate project name/);
    expect(readFileSync(file, "utf8")).toBe(before);
    // `rename` stays available for compatibility and still refuses the same collision.
    await expect(store.rename(first.id, "另一个工作空间")).rejects.toThrow(/duplicate project name/);
    expect(store.get(first.id)).toMatchObject({ name: "PiDock 核心开发" });
  });

  it("still refuses a source ID this workspace never had", async () => {
    const { store } = registry();
    const created = await store.create(input);
    await expect(store.update(created.id, { description: "", repositories: [], directories: [], environment: [],
      branchTemplate: "feature/{task-name}" })).resolves.toMatchObject({ repositories: [] });
    await expect(store.update(created.id, { description: "", repositories: [{ id: "4f3b0c8e-6a1a-4c2f-9c1b-3c9d2f6a1b31", name: "x", path: join(workspaceRoot, "x") }], directories: [] }))
      .rejects.toThrow(/unknown source ID/);
  });
});
