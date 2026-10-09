import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const shellRoot = fileURLToPath(new URL("../..", import.meta.url));
const output = join(shellRoot, "dist", "renderer");

describe("packaged Desktop renderer", () => {
  it("builds the renderer before copying assets into the packaged shell", () => {
    const manifest = JSON.parse(readFileSync(join(shellRoot, "package.json"), "utf8")) as {
      scripts: { build: string; dev: string };
      devDependencies: Record<string, string>;
    };
    expect(manifest.devDependencies["@pidock/renderer"]).toBe("workspace:*");
    expect(manifest.scripts.build).toContain("--filter @pidock/renderer build");
    expect(manifest.scripts.dev).toContain("pnpm build");
  });

  it("includes shell build scripts and the TypeScript build configuration in cached task inputs", () => {
    const graph = JSON.parse(readFileSync(join(shellRoot, "..", "..", "turbo.json"), "utf8")) as {
      tasks: Record<string, { inputs: string[] }>;
    };
    expect(graph.tasks["build"]!.inputs).toContain("scripts/**");
    for (const task of ["build", "typecheck", "test"]) {
      expect(graph.tasks[task]!.inputs).toContain("tsconfig.build.json");
    }
  });

  it("orders the shell test task after the shell build that rewrites dist/renderer", () => {
    // `scripts/copy-static.mjs` rmSync/recreates dist/renderer during `@pidock/shell#build`,
    // and this package's tests read dist/renderer/*.html, so the workspace `test` task's
    // `^build`-only ordering lets that read race the build in a fresh `turbo run --force`.
    // The fix must be package-scoped (not every package's test depending on its own build).
    const graph = JSON.parse(readFileSync(join(shellRoot, "..", "..", "turbo.json"), "utf8")) as {
      tasks: Record<string, { dependsOn?: string[] }>;
    };
    expect(graph.tasks["@pidock/shell#test"]).toBeDefined();
    expect(graph.tasks["@pidock/shell#test"]!.dependsOn).toContain("@pidock/shell#build");
    expect(graph.tasks["@pidock/shell#test"]!.dependsOn).toContain("^build");
  });

  it("ships the React entry and all referenced file-relative assets, separately from smoke", () => {
    const html = readFileSync(join(output, "index.html"), "utf8");
    const smoke = readFileSync(join(output, "smoke.html"), "utf8");
    expect(html).toContain('<div id="root"></div>');
    expect(html).not.toContain("PiDock trusted shell");
    expect(smoke).toContain("PiDock trusted shell");
    const assets = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^"]+)"/g)].map((match) => match[1]!);
    expect(assets.length).toBeGreaterThan(1);
    for (const asset of assets) expect(existsSync(join(output, asset))).toBe(true);
  });
});
