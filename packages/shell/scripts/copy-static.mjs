import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "dist", "renderer"), { recursive: true });
mkdirSync(join(root, "dist", "preload"), { recursive: true });
copyFileSync(join(root, "src", "renderer", "index.html"), join(root, "dist", "renderer", "index.html"));
// Plain (dependency-free) preload for the sandboxed renderer: bundlers and
// relative ESM imports do not resolve in the preload context.
copyFileSync(join(root, "src", "preload", "preload.cjs"), join(root, "dist", "preload", "preload.cjs"));
console.log("[shell] static assets copied: renderer page + plain preload");
