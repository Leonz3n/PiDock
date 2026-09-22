import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * [PiDock 02] toolchain supplement: the renderer must never gain Node
 * capability through workspace sharing. The shell owns main /
 * utilityProcess Host / preload; the renderer stays a sandboxed Vite page
 * that only talks through `window.pidock`. This test scans the renderer
 * sources (not just imports it resolves) so a `node:` import fails here
 * instead of shipping into the desktop shell.
 */
const RENDERER_SRC = join(__dirname, "..");

const NODE_PATTERNS = [
  /from\s+["']node:/,
  /require\(\s*["']node:/,
  /from\s+["']electron["']/,
  /require\(\s*["']electron["']/,
  /process\.env/,
];

// Name references (not capability imports): the renderer mirrors shell-side
// record shapes in comments / local type names, but must never import the
// shell modules that carry Node. These stay a separate allowlist so a real
// import still fails the patterns above.
const FORBIDDEN_MODULE_REFS = [
  /from\s+["'][^"']*task-provision\.js["']/,
  /from\s+["'][^"']*task-host\.js["']/,
  /from\s+["'][^"']*task-store\.js["']/,
  /from\s+["'][^"']*host-guards\.js["']/,
  /import\s*\(\s*["'][^"']*shell["']\s*\)/,
  /require\(\s*["'][^"']*shell["']\s*\)/,
];

// Bare-word mentions in comments / local type names (`Host`, `provision`)
// are documentation, not capability: only real shell-module imports and
// process spawning surface fail here.

function rendererFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...rendererFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

describe("renderer gains no Node capability", () => {
  it("imports no node:/electron modules and reads no process env", () => {
    const offenders: string[] = [];
    for (const file of rendererFiles(RENDERER_SRC)) {
      const source = readFileSync(file, "utf8");
      for (const pattern of [...NODE_PATTERNS, ...FORBIDDEN_MODULE_REFS]) {
        if (pattern.test(source)) offenders.push(`${file}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
