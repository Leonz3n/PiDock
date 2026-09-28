import { cpSync, copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const renderer = join(root, "..", "renderer", "dist");
const html = readFileSync(join(renderer, "index.html"), "utf8");
if (!html.includes('<div id="root"></div>') || !html.includes('./assets/')) {
  throw new Error("renderer build is missing or does not contain file-relative assets");
}
const output = join(root, "dist", "renderer");
rmSync(output, { recursive: true, force: true });
cpSync(renderer, output, { recursive: true });
mkdirSync(join(root, "dist", "preload"), { recursive: true });
copyFileSync(join(root, "src", "renderer", "index.html"), join(output, "smoke.html"));
copyFileSync(join(root, "src", "renderer", "task.html"), join(output, "task.html"));
// Plain (dependency-free) preload for the sandboxed renderer: bundlers and
// relative ESM imports do not resolve in the preload context.
copyFileSync(join(root, "src", "preload", "preload.cjs"), join(root, "dist", "preload", "preload.cjs"));
console.log("[shell] static assets copied: production Desktop, smoke/task pages + plain preload");
