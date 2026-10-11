/**
 * Seam: [PiDock 10] (#15 box 28) the Host-side external-editor launch, driven
 * with REAL child processes.
 *
 * The configured "editor" is a throwaway Node script that records its own
 * `process.argv` and `process.cwd()` before exiting; every assertion about the
 * launch reads that recording, never a returned boolean. The task folder is a
 * real task record under a path containing a space, a quote, `;` and `$HOME`,
 * so a shell string (or a split argument) would show up as extra arguments or
 * a `PWNED` file created by the injected `touch`.
 *
 * A real `git worktree` is NOT required here: the editor launch reads the same
 * task record the file panel reads and never runs Git, so a plain directory
 * stands in for the worktree root (the record's identity is what is under
 * test). Plain-directory links are real symlinks to a real original directory.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskWorkspaceFiles } from "./workspace-files.js";
import { diskTaskStore } from "./task-host.js";
import { buildTaskDiskRecord } from "./task-store.js";
import { protectApplicationProfile } from "./protected-application-path.js";
import { externalEditorPlan, probeEditorDirectory, probeEditorProgram } from "../main/external-editor.js";
import { nodeExternalEditorLauncher, openExternalEditor, type ExternalEditorLauncher } from "./open-editor.js";

/** A path segment that would split or run something if it were a shell string. */
const WEIRD_SEGMENT = 'editor $HOME; touch PWNED "quoted"';

const TASK_ID = "task-abcdef12";
const REPO_DIR = "repo-aaaaaaaa";
const LINK_NAME = "dir-11111111";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  delete process.env["EDITOR_EVIDENCE"];
});

interface Fixture {
  home: string;
  taskDir: string;
  worktreePath: string;
  linkPath: string;
  sharedSourcePath: string;
  profileDir: string;
  files: TaskWorkspaceFiles;
  /** Throwaway editor program: a real script recording argv + cwd. */
  shimPath: string;
  evidencePath: string;
}

function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "pidock-editor-"));
  homes.push(base);
  const home = join(base, WEIRD_SEGMENT);
  const taskRoot = join(home, "tasks");
  const taskDir = join(taskRoot, TASK_ID);
  const profileDir = join(home, "userData");
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  const worktreePath = join(taskDir, REPO_DIR);
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(join(worktreePath, "README.md"), "worktree file\n");
  const sharedSourcePath = join(home, "shared dir; touch PWNED");
  mkdirSync(sharedSourcePath, { recursive: true });
  writeFileSync(join(sharedSourcePath, "original.txt"), "original\n");
  const linkPath = join(taskDir, LINK_NAME);
  symlinkSync(sharedSourcePath, linkPath);
  diskTaskStore.writeTask(
    taskDir,
    buildTaskDiskRecord({
      taskId: TASK_ID,
      name: "编辑器任务",
      dirId: TASK_ID,
      branch: `task/${TASK_ID}`,
      root: taskRoot,
      taskDir,
      remoteBranch: "main",
      baseCommit: "0123456789abcdef0123456789abcdef01234567",
      repos: [REPO_DIR],
      repoSources: [{ repoDir: REPO_DIR, remote: "origin", remoteBranch: "main", baseCommit: "0123456789abcdef0123456789abcdef01234567" }],
      dirLinks: [{ linkName: LINK_NAME, directoryId: "11111111-0000-4000-8000-000000000001", sourcePath: sharedSourcePath, snapshotAt: "2026-09-24T10:00:00.000Z" }],
      now: "2026-09-24T10:00:00.000Z",
    }),
  );
  const shimPath = join(home, "fake-editor.cjs");
  const evidencePath = join(home, "editor-evidence.json");
  writeFileSync(
    shimPath,
    [
      'const fs = require("node:fs");',
      "fs.writeFileSync(process.env.EDITOR_EVIDENCE, JSON.stringify({",
      "  argv: process.argv.slice(1),",
      "  cwd: process.cwd(),",
      "  pid: process.pid,",
      "  ppid: process.ppid,",
      "}));",
      "",
    ].join("\n"),
  );
  process.env["EDITOR_EVIDENCE"] = evidencePath;
  return {
    home,
    taskDir,
    worktreePath,
    linkPath,
    sharedSourcePath,
    profileDir,
    shimPath,
    evidencePath,
    files: new TaskWorkspaceFiles(TASK_ID, taskDir, diskTaskStore, undefined, () => [], protectApplicationProfile(profileDir)),
  };
}

/** The user's configured editor: this test's own real Node interpreter. */
function configuredEditor(shimPath: string): { program: string; args: string[] } {
  return { program: process.execPath, args: [shimPath] };
}

/** Recursive content hash of a directory: names + bytes, so a write shows up. */
function snapshot(dir: string): string[] {
  const lines: string[] = [];
  const walk = (current: string) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(current, entry.name);
      const key = relative(dir, full);
      if (entry.isSymbolicLink()) {
        // A plain-directory link is a symlink: record its target, never follow it.
        lines.push(`${key}->${execFileSync("readlink", [full], { encoding: "utf8" }).trim()}`);
        continue;
      }
      if (entry.isDirectory()) {
        lines.push(`${key}/`);
        walk(full);
        continue;
      }
      lines.push(`${key}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  };
  walk(dir);
  return lines;
}

/** Read the throwaway editor's own recording of what it was launched with. */
function recorded(evidencePath: string): { argv: string[]; cwd: string; pid: number; ppid: number } {
  return JSON.parse(readFileSync(evidencePath, "utf8")) as { argv: string[]; cwd: string; pid: number; ppid: number };
}

function countingLauncher(inner: ExternalEditorLauncher): { launcher: ExternalEditorLauncher; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    launcher: {
      async launch(launch) {
        calls.push(launch);
        return inner.launch(launch);
      },
    },
  };
}

describe("#15 box 28 external editor launch (real process)", () => {
  it("spawns the user-configured program with the resolved worktree path as ONE argument, at that cwd", async () => {
    const f = fixture();
    const before = snapshot(f.taskDir);

    const result = await openExternalEditor({
      files: f.files,
      payload: { rootId: REPO_DIR, editor: configuredEditor(f.shimPath) },
      origin: { kind: "shell-ui", senderWebContentsId: 7 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The real child ran and recorded its own argv/cwd: the workspace path with
    // its space, quote, `;`, `$HOME` and `touch` arrived as ONE argument.
    await vi.waitFor(() => expect(existsSync(f.evidencePath)).toBe(true), { timeout: 10_000 });
    const observed = recorded(f.evidencePath);
    expect(observed.argv).toEqual([f.shimPath, f.worktreePath]);
    expect(observed.argv[1]).toBe(f.worktreePath);
    // The path argument keeps the task record's own spelling; the OS reports
    // the cwd with symlinks resolved (macOS `/var` -> `/private/var`).
    expect(observed.cwd).toBe(realpathSync(f.worktreePath));
    expect(observed.pid).toBeGreaterThan(0);
    // The child is PiDock's own (not a shell's grandchild): its parent is this
    // test process through the detached spawn, and it inherited no PIDOCK_*.
    expect(observed.ppid).toBe(process.pid);

    // The launch itself reports the exact argv after the program, plus the
    // attribution of a human explicit action.
    expect(result.launch.program).toBe(process.execPath);
    expect(result.launch.args).toEqual([f.shimPath, f.worktreePath]);
    expect(result.launch.cwd).toBe(f.worktreePath);
    expect(result.launch.openedPath).toBe(f.worktreePath);
    expect(result.launch.rootKind).toBe("worktree");
    expect(result.launch.actor).toBe("human");
    expect(result.launch.label).toContain("用户显式操作");
    expect(result.launch.windowObserved).toBe(false);
    expect(result.launch.started).toBe(true);
    expect(typeof result.launch.pid).toBe("number");
    expect(result.launch.attribution.repo).toBe(REPO_DIR);

    // Nothing in the task workspace changed, and in particular no editor
    // configuration was created (盒子 28: 不自动复制整套敏感编辑器配置).
    expect(snapshot(f.taskDir)).toEqual(before);
    expect(existsSync(join(f.worktreePath, ".vscode"))).toBe(false);
    expect(existsSync(join(f.taskDir, ".vscode"))).toBe(false);
    expect(existsSync(join(f.worktreePath, "PWNED"))).toBe(false);
    expect(existsSync(join(f.taskDir, "PWNED"))).toBe(false);
    expect(fsFind(f.taskDir, "launch.json")).toEqual([]);
    expect(fsFind(f.taskDir, "tasks.json")).toEqual([]);
    expect(fsFind(f.taskDir, "settings.json")).toEqual([]);
  });

  it("opens a plain-directory link at its ORIGINAL path and keeps the shared identity in the disclosure", async () => {
    const f = fixture();
    const before = snapshot(f.taskDir);

    const result = await openExternalEditor({
      files: f.files,
      payload: { rootId: LINK_NAME, editor: configuredEditor(f.shimPath) },
      origin: { kind: "shell-ui", senderWebContentsId: 7 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await vi.waitFor(() => expect(existsSync(f.evidencePath)).toBe(true), { timeout: 10_000 });
    const observed = recorded(f.evidencePath);
    // The editor opens the real original directory, not the in-task symlink.
    expect(observed.argv).toEqual([f.shimPath, f.sharedSourcePath]);
    expect(observed.cwd).toBe(realpathSync(f.sharedSourcePath));
    expect(result.launch.rootKind).toBe("shared-dir");
    expect(result.launch.openedPath).toBe(f.sharedSourcePath);
    // The link identity stays visible: link location, original target, and the
    // `修改影响原文件` note the existing plain-dir convention uses.
    expect(result.launch.disclosure).toContain("修改影响原文件");
    expect(result.launch.disclosure).toContain(f.linkPath);
    expect(result.launch.attribution.linkPath).toBe(f.linkPath);
    expect(result.launch.attribution.sourcePath).toBe(f.sharedSourcePath);
    expect(result.launch.attribution.sharedNote).toContain("普通目录链接");

    expect(snapshot(f.taskDir)).toEqual(before);
    expect(existsSync(f.linkPath)).toBe(true);
    expect(execFileSync("readlink", [f.linkPath], { encoding: "utf8" }).trim()).toBe(f.sharedSourcePath);
  });

  it("refuses an unconfigured editor by name and spawns nothing", async () => {
    const f = fixture();
    const inner = countingLauncher(nodeExternalEditorLauncher);
    for (const editor of [undefined, null]) {
      const result = await openExternalEditor({
        files: f.files,
        payload: { rootId: REPO_DIR, editor },
        origin: { kind: "shell-ui", senderWebContentsId: 7 },
        launcher: inner.launcher,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("editor-not-configured");
    }
    expect(inner.calls).toEqual([]);
    expect(existsSync(f.evidencePath)).toBe(false);
  });

  it("refuses a missing or non-executable program by name before spawning anything", async () => {
    const f = fixture();
    const inner = countingLauncher(nodeExternalEditorLauncher);
    const notExecutable = join(f.home, "not-executable-editor.cjs");
    writeFileSync(notExecutable, "#!/usr/bin/env node\n", { mode: 0o644 });

    const cases: { editor: { program: string; args?: string[] }; expected: string }[] = [
      { editor: { program: join(f.home, "missing-editor") }, expected: "editor-program-not-found" },
      { editor: { program: f.shimPath, args: [] }, expected: "editor-program-not-executable" },
      { editor: { program: notExecutable }, expected: "editor-program-not-executable" },
      { editor: { program: f.home }, expected: "editor-program-not-executable" },
      { editor: { program: "relative-editor" }, expected: "editor-program-invalid" },
    ];
    for (const entry of cases) {
      const result = await openExternalEditor({
        files: f.files,
        payload: { rootId: REPO_DIR, editor: entry.editor },
        origin: { kind: "shell-ui", senderWebContentsId: 7 },
        launcher: inner.launcher,
      });
      expect(result.ok, JSON.stringify(entry.editor)).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain(entry.expected);
      // The rule layer probes the real filesystem for these instead of trusting
      // a payload: the named refusal is what the disk says.
      expect(probeEditorProgram(entry.editor.program)).not.toBe("executable");
    }
    // Nothing was spawned for any refusal, and no refusal wrote the workspace.
    expect(inner.calls).toEqual([]);
    expect(existsSync(f.evidencePath)).toBe(false);
  });

  it("refuses an unattested or non-shell-UI origin, and an unknown root, without spawning", async () => {
    const f = fixture();
    const inner = countingLauncher(nodeExternalEditorLauncher);
    const editor = configuredEditor(f.shimPath);
    for (const origin of [undefined, { kind: "service-catalog", senderWebContentsId: 7 }, { kind: "shell-ui", senderWebContentsId: 0 }]) {
      const result = await openExternalEditor({
        files: f.files,
        payload: { rootId: REPO_DIR, editor },
        ...(origin === undefined ? {} : { origin: origin as never }),
        launcher: inner.launcher,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("permission-denied");
    }
    const unknown = await openExternalEditor({
      files: f.files,
      payload: { rootId: "dir-99999999", editor },
      origin: { kind: "shell-ui", senderWebContentsId: 7 },
      launcher: inner.launcher,
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain("unknown-root");
    expect(inner.calls).toEqual([]);
    expect(existsSync(f.evidencePath)).toBe(false);
  });

  it("refuses a missing workspace directory by name instead of spawning the editor at a dead path", async () => {
    const f = fixture();
    const inner = countingLauncher(nodeExternalEditorLauncher);
    rmSync(f.worktreePath, { recursive: true, force: true });
    const result = await openExternalEditor({
      files: f.files,
      payload: { rootId: REPO_DIR, editor: configuredEditor(f.shimPath) },
      origin: { kind: "shell-ui", senderWebContentsId: 7 },
      launcher: inner.launcher,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("editor-path-missing");
    expect(inner.calls).toEqual([]);
    expect(existsSync(f.evidencePath)).toBe(false);
  });

  it("refuses a shared link whose original target was never recorded", () => {
    const planned = externalEditorPlan({
      roots: [{ id: LINK_NAME, kind: "shared-dir", label: LINK_NAME, path: `/tmp/tasks/${LINK_NAME}`, directoryId: "d" }],
      taskId: TASK_ID,
      taskDir: "/tmp/tasks",
      rootId: LINK_NAME,
      settings: configuredEditor("/bin/echo"),
      probeProgram: () => "executable",
      probeDirectory: () => "directory",
    });
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.error).toContain("plain-dir-source-missing");
  });

  it("uses the real probes for the program and the directory", () => {
    expect(probeEditorProgram(process.execPath)).toBe("executable");
    expect(probeEditorProgram(join(tmpdir(), "definitely-missing-editor"))).toBe("missing");
    expect(probeEditorDirectory(tmpdir())).toBe("directory");
    expect(probeEditorDirectory(join(tmpdir(), "definitely-missing-dir"))).toBe("missing");
  });
});

/** Every path under `dir` whose basename is `name` (editor-config evidence). */
function fsFind(dir: string, name: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === name) found.push(full);
    }
  };
  walk(dir);
  return found;
}
