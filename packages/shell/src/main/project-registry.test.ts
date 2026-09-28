import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRegistry, projectRegistryPath } from "./project-registry.js";

const roots: string[] = [];
function registry() {
  const root = mkdtempSync(join(tmpdir(), "pidock-projects-"));
  roots.push(root);
  return { root, file: projectRegistryPath(root), store: new ProjectRegistry(root) };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const input = { name: "Billing", description: "Invoices", repositories: [{ name: "api", path: "/workspace/api" }], directories: [{ name: "notes", path: "/workspace/notes" }] };

describe("main-owned project registry", () => {
  it("distinguishes absent from an empty saved registry and preserves generated identities on restart", async () => {
    const { root, file, store } = registry();
    expect(store.list()).toEqual({ initialized: false, projects: [] });
    const created = await store.create(input);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.repositories[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.directories[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.id).not.toBe(created.repositories[0]?.id);
    expect(new ProjectRegistry(root).get(created.id)).toEqual(created);
    expect(new ProjectRegistry(root).list()).toEqual({ initialized: true, projects: [created] });
    expect(readFileSync(file, "utf8")).not.toContain("token");
  });

  it("rejects corrupt, unsupported and symlinked registry without resetting it", async () => {
    const { root, file, store } = registry();
    writeFileSync(file, "{bad");
    expect(() => store.list()).toThrow();
    await expect(store.create(input)).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe("{bad");
    writeFileSync(file, JSON.stringify({ version: 2, projects: [], memberships: [] }));
    expect(() => store.list()).toThrow(/version/);
    rmSync(file);
    symlinkSync(join(root, "absent"), file);
    expect(() => store.list()).toThrow();
  });

  it("keeps prior snapshot and backup after a failed atomic commit", async () => {
    const { root, file, store } = registry();
    const first = await store.create(input);
    const original = readFileSync(file, "utf8");
    const failing = new ProjectRegistry(root, { beforeCommit: () => { throw new Error("disk full"); } });
    await expect(failing.create({ ...input, name: "Other" })).rejects.toThrow("disk full");
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(store.get(first.id)).toEqual(first);
    await store.rename(first.id, "Billing 2");
    expect(existsSync(`${file}.bak`)).toBe(true);
    expect(JSON.parse(readFileSync(`${file}.bak`, "utf8")).projects[0].name).toBe("Billing");
    rmSync(file);
    expect(() => store.list()).toThrow(/backup requires explicit recovery/);
    await expect(store.create(input)).rejects.toThrow(/backup requires explicit recovery/);
    expect(existsSync(`${file}.bak`)).toBe(true);
  });

  it("serializes concurrent writes and preserves identity on rename and update", async () => {
    const { store } = registry();
    const [a, b] = await Promise.all([store.create(input), store.create({ ...input, name: "Shipping" })]);
    expect(store.list().projects).toHaveLength(2);
    await expect(store.create(input)).rejects.toThrow(/name/);
    await store.rename(a.id, "Billing 2");
    const changed = await store.update(a.id, { description: "New", repositories: [{ id: a.repositories[0]!.id, name: "api", path: "/new/api" }], directories: [] });
    expect(changed.id).toBe(a.id);
    expect(changed.repositories[0]?.id).toBe(a.repositories[0]?.id);
    expect(store.get(b.id)).toEqual(b);
    await expect(store.rename(b.id, "Billing 2")).rejects.toThrow(/name/);
  });

  it("refuses deletion with a persisted membership even if its task is absent", async () => {
    const { file, store } = registry();
    const project = await store.create(input);
    const document = JSON.parse(readFileSync(file, "utf8"));
    document.memberships.push({ taskId: "task-1", projectId: project.id, createdAt: "2026-01-01T00:00:00Z", root: "/gone", dirId: "task-11111111" });
    writeFileSync(file, JSON.stringify(document));
    await expect(store.delete(project.id)).rejects.toThrow(/associated/);
    expect(store.get(project.id)).toBeDefined();
  });

  it("rejects relative, traversal, URL, and credential-like metadata without touching the source", async () => {
    const { store } = registry();
    for (const path of ["relative", "/workspace/../secret", "https://example.com", "/workspace/./repo", "/workspace/\u0000bad"]) {
      await expect(store.create({ ...input, repositories: [{ name: "api", path }] })).rejects.toThrow();
    }
    await expect(store.create({ ...input, token: "secret" } as never)).rejects.toThrow();
    await expect(store.create({ ...input, repositories: [{ name: "api", path: "/workspace/api", password: "secret" }] } as never)).rejects.toThrow();
  });
});
