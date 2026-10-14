import { afterEach, describe, expect, it, vi } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskWorkspaceHost } from "../host/task-host.js";
import { diskTaskStore, readTaskRecordOnDisk } from "../host/task-store.js";
import { linkTargetMatches } from "./directory-link.js";
import { buildLinkName } from "./multi-repo-provision.js";
import { CreationIntentStore, ProjectTaskCreation } from "./project-task-creation.js";
import { ProjectRegistry } from "./project-registry.js";
import { TaskRootIndex } from "./task-root-index.js";

// Partial mock (repo precedent: `service-host-binding.test.ts`): only `symlinkSync`
// is replaced. It throws the real de-privileged EPERM shape for a directory
// symlink and delegates a `"junction"` attempt to the real call, so the test
// proves the PRODUCTION create site falls back — not a test-only stand-in.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    symlinkSync: vi.fn((target: string, path: string, type?: "dir" | "file" | "junction") => {
      if (type !== "junction") {
        throw Object.assign(new Error(`EPERM: operation not permitted, symlink '${target}' -> '${path}'`), {
          code: "EPERM",
          errno: -4048,
          syscall: "symlink",
        });
      }
      actual.symlinkSync(target, path, "junction");
    }),
  };
});

const win32It = it.skipIf(process.platform !== "win32");
const homes: string[] = [];

async function setupPureDirectoryEnv() {
  const home = mkdtempSync(join(tmpdir(), "pidock-create-junction-"));
  homes.push(home);
  const root = join(home, "tasks");
  const profile = join(home, "profile");
  const docsDir = join(home, "my-documents");
  mkdirSync(root);
  mkdirSync(docsDir);
  writeFileSync(join(docsDir, "spec.txt"), "original spec content\n");

  const projects = new ProjectRegistry(profile);
  const project = await projects.create({
    name: "Pure Dir Project",
    description: "Zero git repos",
    repositories: [],
    directories: [{ name: "documents", path: docsDir }],
  });

  const roots = new TaskRootIndex(profile, root);
  const storage = new CreationIntentStore(profile);
  const host = {
    routeTaskOp: async ({ taskId, payload }: { taskId: string; payload: Record<string, unknown> }) => {
      const instance = new TaskWorkspaceHost(taskId, join(payload["rootOverride"] as string, taskId), diskTaskStore);
      instance.provision(payload as never);
      return { workspaceId: "test", taskId, op: "task/provision" as const, payload: {} };
    },
  };
  const service = new ProjectTaskCreation(storage, projects, roots, host, root);
  const request = {
    projectId: project.id,
    name: "Pure Dir Task",
    repositories: [],
    directoryIds: [project.directories[0]!.id],
    sharedWriteConfirmed: true,
    override: false,
  };
  return { home, docsDir, project, service, request };
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("Project task creation falls back to a junction on EPERM", () => {
  win32It("commit produces a usable junction link and records it truthfully", async () => {
    const env = await setupPureDirectoryEnv();
    const preview = await env.service.prepare(env.request);
    await env.service.commit(preview.id);

    const linkPath = join(preview.taskDir, buildLinkName(env.project.directories[0]!.id));
    // The production site attempted the dir symlink first, then the junction.
    expect(vi.mocked(symlinkSync).mock.calls.map((call) => call[2])).toEqual(["dir", "junction"]);
    // The junction is a link, not a plain directory, and compares as the source.
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(lstatSync(linkPath).isDirectory()).toBe(false);
    expect(linkTargetMatches(readlinkSync(linkPath), env.docsDir)).toBe(true);
    // Usable: real bytes flow through, and the record names the link truthfully.
    expect(readFileSync(join(linkPath, "spec.txt"), "utf8")).toBe("original spec content\n");
    const record = readTaskRecordOnDisk(preview.taskDir);
    expect(record?.dirLinks?.some((link) => link.sourcePath === env.docsDir && link.linkName === buildLinkName(env.project.directories[0]!.id))).toBe(true);
  });

  win32It("is a control: with the privilege error absent the production site creates a plain dir symlink", async () => {
    const env = await setupPureDirectoryEnv();
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const mocked = vi.mocked(symlinkSync);
    mocked.mockClear();
    // One link is created (one directory): let it succeed as `"dir"`.
    mocked.mockImplementationOnce((target, path, type) => {
      realFs.symlinkSync(target, path, type);
    });

    const preview = await env.service.prepare(env.request);
    await env.service.commit(preview.id);

    expect(mocked.mock.calls.map((call) => call[2])).toEqual(["dir"]);
    expect(lstatSync(join(preview.taskDir, buildLinkName(env.project.directories[0]!.id))).isSymbolicLink()).toBe(true);
  });
});
