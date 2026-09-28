import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRegistry, projectRegistryPath } from "./project-registry.js";
import { TaskRootIndex } from "./task-root-index.js";
import { performProjectOperation } from "./project-ipc.js";

const homes: string[] = [];
const id = "task-abcdef12";
const createdAt = "2026-09-22T10:00:00Z";
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pidock-claim-"));
  homes.push(home);
  const data = join(home, "data");
  const defaultRoot = join(home, "default");
  const override = join(home, "override");
  mkdirSync(defaultRoot);
  mkdirSync(override);
  const registry = new ProjectRegistry(data);
  const roots = new TaskRootIndex(data, defaultRoot);
  const task = (root = defaultRoot, taskId = id, date = createdAt) => {
    const dir = join(root, taskId);
    mkdirSync(dir);
    writeFileSync(join(dir, "task.json"), JSON.stringify({ taskId, name: "Same repository", dirId: taskId,
      root, taskDir: dir, branch: "task/main", remoteBranch: "main", baseCommit: "abc123", repos: [],
      createdAt: date, updatedAt: date }));
    return dir;
  };
  const project = (name: string) => registry.create({ name, description: "", repositories: [
    { name: "Shared repository", path: join(home, "repo") }], directories: [] });
  return { home, data, defaultRoot, override, registry, roots, task, project };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("explicit Project task association", () => {
  it("upgrades v1 on first explicit claim, persists one receipt and retains stable identity on restart", async () => {
    const f = fixture();
    f.task();
    const target = await f.project("Billing");
    expect(JSON.parse(readFileSync(projectRegistryPath(f.data), "utf8")).version).toBe(1);
    expect(f.registry.association(id, f.roots)).toMatchObject({ projectId: null, state: "unassigned" });
    const receipt = await f.registry.claim(id, target.id, f.roots);
    expect(receipt).toMatchObject({ action: "claim", taskId: id, fromProjectId: null, toProjectId: target.id });
    const saved = JSON.parse(readFileSync(projectRegistryPath(f.data), "utf8"));
    expect(saved.version).toBe(2);
    expect(saved.receipts).toEqual([receipt]);
    expect(JSON.parse(readFileSync(`${projectRegistryPath(f.data)}.bak`, "utf8")).version).toBe(1);
    expect(saved.memberships[0]).toMatchObject({ taskId: id, createdAt, root: f.defaultRoot, dirId: id });
    const reopened = new ProjectRegistry(f.data);
    expect(reopened.association(id, new TaskRootIndex(f.data, f.defaultRoot))).toMatchObject({ projectId: target.id, state: "assigned" });
    await expect(reopened.delete(target.id)).rejects.toThrow(/associated/);
    await expect(reopened.claim(id, target.id, f.roots)).rejects.toThrow(/already associated/);
    expect(JSON.parse(readFileSync(projectRegistryPath(f.data), "utf8")).receipts).toHaveLength(1);
  });

  it("requires explicit transfer, preserves receipts and permits deliberate unlink of damaged identity", async () => {
    const f = fixture();
    const dir = f.task();
    const first = await f.project("One");
    const second = await f.project("Two");
    await f.registry.claim(id, first.id, f.roots);
    await expect(f.registry.claim(id, second.id, f.roots)).rejects.toThrow(/transfer/);
    await expect(f.registry.transfer(id, second.id, first.id, f.roots)).rejects.toThrow(/association changed/);
    const transferred = await f.registry.transfer(id, first.id, second.id, f.roots);
    expect(transferred).toMatchObject({ action: "transfer", fromProjectId: first.id, toProjectId: second.id });
    await f.registry.delete(first.id);
    writeFileSync(join(dir, "task.json"), "{bad");
    expect(f.registry.association(id, f.roots)).toMatchObject({ projectId: second.id, state: "needs-repair" });
    await expect(f.registry.transfer(id, second.id, first.id, f.roots)).rejects.toThrow();
    await expect(f.registry.unlink(id, first.id)).rejects.toThrow();
    const unlinked = await f.registry.unlink(id, second.id);
    expect(unlinked).toMatchObject({ action: "unlink", fromProjectId: second.id, toProjectId: null, createdAt });
    await f.registry.delete(second.id);
    expect(JSON.parse(readFileSync(projectRegistryPath(f.data), "utf8")).receipts.map((row: { action: string }) => row.action)).toEqual(["claim", "transfer", "unlink"]);
  });

  it("rejects undiscovered override, then claims only after explicit root import", async () => {
    const f = fixture();
    f.task(f.override);
    const target = await f.project("One");
    await expect(f.registry.claim(id, target.id, f.roots)).rejects.toThrow(/unavailable/);
    expect(f.roots.inventory().tasks).toHaveLength(0);
    await f.roots.importRoot(f.override);
    await f.registry.claim(id, target.id, f.roots);
    expect(new ProjectRegistry(f.data).association(id, f.roots).state).toBe("assigned");
    rmSync(f.override, { recursive: true });
    f.task(f.defaultRoot);
    expect(f.registry.association(id, f.roots).state).toBe("needs-repair");
    await expect(f.registry.transfer(id, target.id, (await f.project("Two")).id, f.roots)).rejects.toThrow(/repair/);
  });

  it("fails closed on changed creation time, missing records and corrupt versions/receipts", async () => {
    const f = fixture();
    const dir = f.task();
    const target = await f.project("One");
    await f.registry.claim(id, target.id, f.roots);
    const disk = JSON.parse(readFileSync(join(dir, "task.json"), "utf8"));
    writeFileSync(join(dir, "task.json"), JSON.stringify({ ...disk, createdAt: "2026-10-01T10:00:00Z" }));
    expect(f.registry.association(id, f.roots).state).toBe("needs-repair");
    rmSync(dir, { recursive: true });
    expect(f.registry.association(id, f.roots).state).toBe("needs-repair");
    const file = projectRegistryPath(f.data);
    const content = JSON.parse(readFileSync(file, "utf8"));
    for (const broken of [{ ...content, version: 3 }, { ...content, receipts: [{ action: "claim" }] }]) {
      writeFileSync(file, JSON.stringify(broken));
      expect(() => f.registry.association(id, f.roots)).toThrow();
      await expect(f.registry.unlink(id, target.id)).rejects.toThrow();
    }
  });

  it("leaves v1 and its backup intact when the first association commit fails", async () => {
    const f = fixture();
    f.task();
    const target = await f.project("One");
    const file = projectRegistryPath(f.data);
    const original = readFileSync(file, "utf8");
    const failing = new ProjectRegistry(f.data, { beforeCommit: () => { throw new Error("interrupted"); } });
    await expect(failing.claim(id, target.id, f.roots)).rejects.toThrow("interrupted");
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(JSON.parse(readFileSync(`${file}.bak`, "utf8")).version).toBe(1);
    expect(f.registry.association(id, f.roots).state).toBe("unassigned");
  });

  it("serializes competing claims and rejects a corrupt v2 backup without changing membership", async () => {
    const f = fixture();
    f.task();
    const one = await f.project("One");
    const two = await f.project("Two");
    const outcomes = await Promise.allSettled([f.registry.claim(id, one.id, f.roots), f.registry.claim(id, two.id, f.roots)]);
    expect(outcomes.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(f.registry.association(id, f.roots).projectId).toBe(one.id);
    await f.registry.transfer(id, one.id, two.id, f.roots);
    const file = projectRegistryPath(f.data);
    const original = readFileSync(file, "utf8");
    writeFileSync(`${file}.bak`, JSON.stringify({ version: 2, projects: [], memberships: [], receipts: [{ invalid: true }] }));
    await expect(f.registry.unlink(id, two.id)).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(f.registry.association(id, f.roots).projectId).toBe(two.id);
  });

  it("refuses unaudited history truncation at capacity", async () => {
    const f = fixture();
    f.task();
    const target = await f.project("One");
    await f.registry.claim(id, target.id, f.roots);
    const file = projectRegistryPath(f.data);
    const doc = JSON.parse(readFileSync(file, "utf8"));
    doc.receipts = Array.from({ length: 1000 }, (_unused, n) => ({ ...doc.receipts[0], id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` }));
    writeFileSync(file, JSON.stringify(doc));
    await expect(f.registry.unlink(id, target.id)).rejects.toThrow(/capacity/);
    expect(JSON.parse(readFileSync(file, "utf8")).memberships).toHaveLength(1);
  });

  it("rejects renderer paths, malformed action payloads and exposes no audit history operation", async () => {
    const f = fixture();
    f.task();
    const target = await f.project("One");
    for (const input of [
      { op: "claim", taskId: id, projectId: target.id, root: f.defaultRoot },
      { op: "claim", taskId: id, projectId: target.id, taskDir: "/tmp/elsewhere" },
      { op: "claim", taskId: "../escape", projectId: target.id },
      { op: "transfer", taskId: id, fromProjectId: target.id, toProjectId: target.id, membership: {} },
      { op: "receipts" },
    ]) await expect(performProjectOperation(f.registry, input, f.roots)).rejects.toThrow();
    expect(await performProjectOperation(f.registry, { op: "associations" }, f.roots)).toMatchObject({ tasks: [{ taskId: id, state: "unassigned" }] });
    expect(await performProjectOperation(f.registry, { op: "claim", taskId: id, projectId: target.id }, f.roots)).toMatchObject({ action: "claim" });
    expect(await performProjectOperation(f.registry, { op: "association", taskId: id }, f.roots)).toMatchObject({ state: "assigned" });
  });
});
