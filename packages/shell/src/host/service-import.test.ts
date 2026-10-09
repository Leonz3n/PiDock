import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanServiceImportHints, scanTaskServiceImportHints } from "./service-import.js";

const roots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), "pidock-import-")); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("#10 task-bound dotenv configuration hints", () => {
  it("reports only root .env key names as configuration, using Node dotenv syntax without values", () => {
    const task = root(); const repo = join(task, "api");
    mkdirSync(repo);
    writeFileSync(join(repo, ".env"), `# synthetic configuration\nexport API_TOKEN="synthetic-private-one"\nAPI_TOKEN=synthetic-private-two\nPORT=4100 # comment\nMULTILINE="synthetic-line-one\nsynthetic-line-two"\nLITERAL='${"${synthetic_private_reference}"}'\n`);
    writeFileSync(join(repo, ".env.production.local"), "IGNORED_KEY=synthetic-ignored-value");
    const scan = scanTaskServiceImportHints({ taskDir: task, roots: [
      { id: "api", kind: "worktree", label: "api", path: repo },
    ] }, "api");
    expect(scan.errors).toEqual([]);
    expect(scan.hints).toHaveLength(1);
    expect(scan.hints[0]).toMatchObject({ source: ".env", name: ".env", runType: null,
      envKeys: ["API_TOKEN", "LITERAL", "MULTILINE", "PORT"], invalidVars: [] });
    expect(scan.hints[0]?.toVerify).toContain("仅提取变量键名；语法及业务读取点、生效优先级和 URL 覆盖规则需人工核对");
    expect(JSON.stringify(scan)).not.toMatch(/synthetic-|synthetic_private_reference|4100|IGNORED_KEY/);
    expect(process.env["MULTILINE"]).not.toBe("synthetic-line-one\nsynthetic-line-two");
  });
  it.each(["existing", "missing"])("refuses a %s external .env symlink without disclosing its target", (targetState) => {
    const task = root(); const repo = join(task, "api"); const outside = root();
    mkdirSync(repo);
    const target = join(outside, "private.env");
    if (targetState === "existing") writeFileSync(target, "API_TOKEN=synthetic-external-secret");
    symlinkSync(target, join(repo, ".env"));
    const scan = scanTaskServiceImportHints({ taskDir: task, roots: [
      { id: "api", kind: "worktree", label: "api", path: repo },
    ] }, "api");
    expect(scan.hints).toEqual([]);
    expect(scan.errors).toEqual([{ source: ".env", reason: "配置文件是符号链接，需要人工核对" }]);
    expect(JSON.stringify(scan)).not.toMatch(/synthetic-external-secret|private\.env|pidock-import-/);
  });
  it("bounds and filters parsed keys without echoing invalid text, references or tolerant syntax values", () => {
    const task = root(); const repo = join(task, "api");
    mkdirSync(repo);
    writeFileSync(join(repo, ".env"), ["1INVALID=synthetic-invalid-value", "bad-key=synthetic-bad-value",
      `${"A".repeat(101)}=synthetic-long-key-value`, "UNTERMINATED=\"synthetic-unclosed-value",
      ...Array.from({ length: 101 }, (_, index) => `KEY_${String(index).padStart(3, "0")}=synthetic-bounded-value`),
    ].join("\n"));
    const scan = scanTaskServiceImportHints({ taskDir: task, roots: [
      { id: "api", kind: "worktree", label: "api", path: repo },
    ] }, "api");
    expect(scan.hints[0]?.envKeys).toHaveLength(100);
    expect(scan.hints[0]?.envKeys[0]).toBe("KEY_000");
    expect(scan.hints[0]?.envKeys[99]).toBe("KEY_099");
    expect(scan.hints[0]?.toVerify).toContain("环境变量列表已截断，请人工核对");
    expect(JSON.stringify(scan)).not.toMatch(/synthetic-|1INVALID|bad-key|A{101}/);
    expect(scan.errors).toEqual([]);
  });

  it.each(["directory", "oversize"])("refuses a %s .env without echoing content", (kind) => {
    const task = root(); const repo = join(task, "api");
    mkdirSync(repo);
    if (kind === "directory") mkdirSync(join(repo, ".env"));
    else writeFileSync(join(repo, ".env"), "API_TOKEN=synthetic-oversize-secret\n" + "x".repeat(128 * 1024));
    const scan = scanTaskServiceImportHints({ taskDir: task, roots: [
      { id: "api", kind: "worktree", label: "api", path: repo },
    ] }, "api");
    expect(scan.hints).toEqual([]);
    expect(scan.errors).toEqual([{ source: ".env", reason: "配置文件不是受限大小的普通文件" }]);
    expect(JSON.stringify(scan)).not.toContain("synthetic-oversize-secret");
  });

  it("does not scan a .env through a worktree escaping the bound task", () => {
    const task = root(); const outside = root(); const escaped = join(task, "api");
    writeFileSync(join(outside, ".env"), "API_TOKEN=synthetic-escaped-secret");
    symlinkSync(outside, escaped);
    expect(() => scanTaskServiceImportHints({ taskDir: task, roots: [
      { id: "api", kind: "worktree", label: "api", path: escaped },
    ] }, "api")).toThrow("path-out-of-scope");
  });
});

describe("#7 real repository service-import hints", () => {
  it("reads JSONC launch, package scripts and Compose as redacted command candidates with key-only env", () => {
    const repo = root();
    mkdirSync(join(repo, ".vscode"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { dev: "PRIVATE=secret-token node server.js", migrate: "node migrate.js" } }));
    writeFileSync(join(repo, ".vscode", "launch.json"), `{
      // VS Code permits comments and trailing commas
      "configurations": [{ "name": "api", "program": "node", "args": ["server.js"], "env": { "API_TOKEN": "secret-token", "PORT": "${"${MISSING}"}" }, }],
    }`);
    writeFileSync(join(repo, "compose.yaml"), `services:\n  invoice:\n    command: node server.js\n    environment:\n      API_TOKEN: secret-token\n`);
    writeFileSync(join(repo, "docker-compose.yml"), `services:\n  worker:\n    command: node worker.js\n    environment:\n      - API_TOKEN=secret-token\n      - PORT=4100\n`);
    const scan = scanServiceImportHints(repo);
    expect(scan.errors).toEqual([]);
    expect(scan.truncated).toBe(false);
    expect(scan.hints.map(({ source, name, runType }) => ({ source, name, runType }))).toEqual([
      { source: "package.json", name: "dev", runType: "long-lived" },
      { source: "package.json", name: "migrate", runType: "prepare" },
      { source: ".vscode/launch.json", name: "api", runType: "one-shot" },
      { source: "compose.yaml", name: "invoice", runType: "one-shot" },
      { source: "docker-compose.yml", name: "worker", runType: "one-shot" },
    ]);
    expect(scan.hints[2]?.envKeys).toEqual(["API_TOKEN", "PORT"]);
    expect(scan.hints[4]?.envKeys).toEqual(["API_TOKEN", "PORT"]);
    expect(scan.hints[2]?.toVerify).toContain("API_TOKEN：疑似凭据，请移入本机私有配置");
    expect(JSON.stringify(scan)).not.toContain("secret-token");
    // The command candidate is redacted, not value-free: only portable tokens
    // survive, never an env value, a credential or a machine path.
    expect(scan.hints.map(({ program, args }) => ({ program, args }))).toEqual([
      { program: "node", args: ["server.js"] },
      { program: "node", args: ["migrate.js"] },
      { program: "node", args: ["server.js"] },
      { program: "node", args: ["server.js"] },
      { program: "node", args: ["worker.js"] },
    ]);
    expect(scan.hints.every(({ program, args }) => !/[\s]/.test(program) && [program, ...args].every((token) =>
      !/^(?:\/|~|\\|[A-Za-z]:)/.test(token) && !token.includes("=") && !/(?:password|token|secret|api[_-]?key)/i.test(token)))).toBe(true);
  });

  it("drops unsafe command tokens by class and reports each drop without echoing the token", () => {
    const repo = root();
    mkdirSync(join(repo, ".vscode"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: {
      absolute: "/usr/bin/node server.js",
      assignment: "PORT=4100 node server.js",
      secret: "node --token secret-token-value server.js",
      patharg: "node /Users/name/private/service.js https://user:pass@example.test/app.js",
      mixed: "node server.js /tmp/private.js",
      onlyAssignment: "API_TOKEN=secret-token-value",
    } }));
    writeFileSync(join(repo, ".vscode", "launch.json"), JSON.stringify({ configurations: [
      { name: "absolute", program: "~/bin/node", args: ["server.js"] },
      { name: "subdir", program: "node", args: ["server.js"], cwd: "apps/api" },
      { name: "outside", program: "node", args: ["server.js"], cwd: "/srv/apps/api" },
    ] }));
    writeFileSync(join(repo, "compose.yaml"), "services:\n  api:\n    command: node server.js\n    working_dir: ../outside\n");
    const scan = scanServiceImportHints(repo);
    const byName = (name: string) => scan.hints.find((hint) => hint.name === name);
    expect(byName("absolute")).toMatchObject({ program: "", args: [],
      toVerify: expect.arrayContaining(["启动命令以本机路径开头，已从草案移除；请填写可移植的程序名"]) });
    expect(byName("assignment")).toMatchObject({ program: "node", args: ["server.js"] });
    expect(byName("secret")).toMatchObject({ program: "node", args: ["server.js"] });
    expect(byName("patharg")).toMatchObject({ program: "node", args: [] });
    expect(byName("patharg")?.toVerify).toContain("启动命令有 2 个片段含本机路径、内联环境赋值或疑似凭据，已从草案移除，请人工核对");
    expect(byName("mixed")).toMatchObject({ program: "node", args: ["server.js"] });
    expect(byName("mixed")?.toVerify).toContain("启动命令有 1 个片段含本机路径、内联环境赋值或疑似凭据，已从草案移除，请人工核对");
    expect(byName("onlyAssignment")).toMatchObject({ program: "", args: [],
      toVerify: expect.arrayContaining(["启动命令只包含内联环境赋值，已从草案移除；请填写可移植的程序名"]) });
    expect(byName("subdir")).toMatchObject({ program: "node", args: ["server.js"], workdir: "apps/api" });
    expect(byName("outside")?.workdir).toBeUndefined();
    expect(byName("outside")?.toVerify).toContain("配置中的工作目录不是可移植的仓库内相对目录，已从草案移除，请人工核对");
    expect(byName("api")?.workdir).toBeUndefined();
    // Never an env value, a credential value, an absolute path or a raw command string.
    expect(JSON.stringify(scan)).not.toMatch(/secret-token-value|secret-token|\/usr\/bin|\/Users\/|~\/bin|\/srv|user:pass@|\.\.\/outside/);
  });

  it("drops a machine path that only shows up mid-token and keeps repo-relative arguments", () => {
    const repo = root();
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: {
      compile: "cc -I/Users/name/private/include -I../outside main.c",
      dev: "node src/main.ts",
    } }));
    const scan = scanServiceImportHints(repo);
    const byName = (name: string) => scan.hints.find((hint) => hint.name === name);
    expect(byName("compile")).toMatchObject({ program: "cc", args: ["main.c"] });
    expect(byName("compile")?.toVerify).toContain("启动命令有 2 个片段含本机路径、内联环境赋值或疑似凭据，已从草案移除，请人工核对");
    expect(byName("dev")).toMatchObject({ program: "node", args: ["src/main.ts"] });
    expect(JSON.stringify(scan)).not.toMatch(/\/Users\/|private|outside/);
  });

  it("flags inline env assignments and malformed Compose lists without exposing their values", () => {
    const repo = root();
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: {
      dev: "PORT=4100 API_TOKEN=secret-token node server.js",
      broken: "1INVALID=secret-token node server.js",
      plain: "node server.js",
    } }));
    writeFileSync(join(repo, "compose.yaml"), `services:\n  api:\n    environment:\n      - API_TOKEN=secret-token\n      - 42\n`);
    const scan = scanServiceImportHints(repo);
    expect(scan.hints[0]?.envKeys).toEqual([]);
    expect(scan.hints[0]?.toVerify).toContain("脚本开头使用内联环境赋值；请将变量移入配置层以支持跨平台启动");
    expect(scan.hints[1]?.invalidVars).toContain("1INVALID");
    expect(scan.hints[2]?.toVerify).not.toContain("脚本开头使用内联环境赋值；请将变量移入配置层以支持跨平台启动");
    expect(scan.hints[3]?.toVerify).toContain("环境变量结构无效，请人工核对");
    expect(scan.hints[0]).toMatchObject({ program: "node", args: ["server.js"] });
    expect(JSON.stringify(scan)).not.toContain("secret-token");
    expect(JSON.stringify(scan)).not.toMatch(/4100|\/usr\/bin/);
  });

  it("signals truncated results and invalid environment structures", () => {
    const repo = root();
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`service-${index}`, "node server.js"]),
    ) }));
    mkdirSync(join(repo, ".vscode"));
    writeFileSync(join(repo, ".vscode", "launch.json"), JSON.stringify({ configurations: [
      { name: "invalid-env", env: "API_TOKEN=secret-token" },
    ] }));
    const scan = scanServiceImportHints(repo);
    expect(scan.hints).toHaveLength(100);
    expect(scan.truncated).toBe(true);
    expect(JSON.stringify(scan)).not.toContain("secret-token");
    const second = root();
    mkdirSync(join(second, ".vscode"));
    writeFileSync(join(second, ".vscode", "launch.json"), JSON.stringify({ configurations: [
      { name: "invalid-env", env: "API_TOKEN=secret-token" },
    ] }));
    expect(scanServiceImportHints(second).hints[0]?.toVerify).toContain("环境变量结构无效，请人工核对");
  });

  it("accepts only the task's in-root worktree identity", () => {
    const task = root(); const repo = join(task, "invoice"); const outside = root();
    mkdirSync(repo);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { dev: "node server.js" } }));
    const worktree = { id: "invoice", kind: "worktree" as const, label: "invoice", path: repo };
    expect(scanTaskServiceImportHints({ taskDir: task, roots: [worktree] }, "invoice").hints).toHaveLength(1);
    expect(() => scanTaskServiceImportHints({ taskDir: task, roots: [worktree] }, "unknown")).toThrow("unknown-worktree");
    expect(() => scanTaskServiceImportHints({ taskDir: task, roots: [{ ...worktree, kind: "shared-dir" }] }, "invoice")).toThrow("unknown-worktree");
    expect(() => scanTaskServiceImportHints({ taskDir: task, roots: [{ ...worktree, path: outside }] }, "invoice")).toThrow("path-out-of-scope");
  });

  it("refuses escaped symlinks, oversize files and malformed structured files without returning content", () => {
    const repo = root(); const outside = root();
    mkdirSync(join(repo, ".vscode"));
    writeFileSync(join(outside, "secret.json"), '{"SECRET":"secret-token"}');
    symlinkSync(join(outside, "secret.json"), join(repo, ".vscode", "launch.json"));
    writeFileSync(join(repo, "package.json"), "x".repeat(128 * 1024 + 1));
    writeFileSync(join(repo, "compose.yaml"), "services:\n  a: 1\n  a: 2\n");
    const scan = scanServiceImportHints(repo);
    expect(scan.hints).toEqual([]);
    expect(scan.errors).toHaveLength(3);
    expect(JSON.stringify(scan)).not.toContain(outside);
    expect(JSON.stringify(scan)).not.toContain("secret-token");
  });
});
