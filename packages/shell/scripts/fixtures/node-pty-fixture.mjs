import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Explicit experimental metadata, never a read of user preference contents.
// Apple's published CF parser accepts a matching UID prefix and zero fields.
if (typeof process.getuid !== "function") throw Error("fixture-requires-Darwin-getuid");
const controlledCfMetadata = `0x${process.getuid().toString(16)}:0:0`;
// Hard lifetimes are installed before any PTY handshake/input. These programs
// are synthetic fixtures only: no shell, network, credentials or user commands.
if (process.argv[2] === "--descendant") {
  const marker = process.argv[3];
  const state = { pid: process.pid, startedAt: new Date().toISOString(), program: process.execPath, cwd: process.cwd(), heartbeat: 0, exited: false };
  const save = () => { writeFileSync(`${marker}.tmp`, JSON.stringify(state)); renameSync(`${marker}.tmp`, marker); };
  const lifetime = setTimeout(() => { state.exited = true; save(); process.exit(0); }, 15_000);
  lifetime.ref(); save();
  setInterval(() => { state.heartbeat++; save(); }, 100);
} else {
  setTimeout(() => process.exit(99), 10_000);
  const marker = process.argv[2];
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error("fixture-requires-real-pty");
  process.stdin.setRawMode(true);
  console.log(`READY:${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), cwd: process.cwd(), value: process.env.FIXTURE_VALUE,
    cols: process.stdout.columns, rows: process.stdout.rows, envKeys: Object.keys(process.env).sort(),
    cfMetadataMatches: process.env.__CF_USER_TEXT_ENCODING === controlledCfMetadata, pwd: process.env.PWD, term: process.env.TERM,
    versions: process.versions })}`);
  process.stdout.on("resize", () => console.log(`SIZE:${process.stdout.columns}x${process.stdout.rows}`));
  let input = "";
  process.stdin.on("data", (data) => {
    input += data.toString("utf8");
    if (Buffer.byteLength(input) > 2000) process.exit(98);
    for (;;) {
      const end = input.indexOf("\r");
      if (end < 0) break;
      const command = input.slice(0, end); input = input.slice(end + 1);
      if (command === "ping") console.log("PONG:real-pty-input");
      else if (command === "descendant") {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--descendant", marker], {
          cwd: process.cwd(), env: { FIXTURE_VALUE: "native-adapter", __CF_USER_TEXT_ENCODING: controlledCfMetadata }, stdio: "ignore", detached: true,
        });
        child.unref();
        console.log(`DESCENDANT:${child.pid}`);
        const started = setInterval(() => {
          try { readFileSync(marker); clearInterval(started); process.exit(7); } catch { /* hard lifetime remains active */ }
        }, 20);
      } else process.exit(97);
    }
  });
}
