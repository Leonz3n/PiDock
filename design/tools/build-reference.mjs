import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { home } from "./screens/home.mjs";
import { taskWorkspace } from "./screens/task.mjs";
import { newTask } from "./screens/new-task.mjs";
import { project } from "./screens/project.mjs";
import { schedules } from "./screens/schedules.mjs";
import { capabilities } from "./screens/capabilities.mjs";
import { attention } from "./screens/attention.mjs";
import { recovery } from "./screens/recovery.mjs";
import { cleanup } from "./screens/cleanup.mjs";
import { sessions } from "./screens/sessions.mjs";
import { mcp } from "./screens/mcp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../reference");
fs.mkdirSync(outDir, { recursive: true });

const screens = [["01-workbench", home], ["02-task-workspace", taskWorkspace], ["03-new-task", newTask], ["04-project", project], ["05-schedules", schedules], ["06-capabilities", capabilities], ["07-attention", attention], ["08-recovery", recovery], ["09-cleanup", cleanup], ["10-sessions", sessions], ["11-mcp", mcp]];

for (const [name, render] of screens) {
  const svg = render();
  fs.writeFileSync(path.join(outDir, `${name}.svg`), svg);
  console.log(`wrote ${name}.svg`);
}
