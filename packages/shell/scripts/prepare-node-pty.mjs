import { prepareNodePtyPrebuild } from "../dist/host/node-pty-preflight.js";

// Explicit experimental setup after shell compilation. Never an install hook,
// worker fallback, packaging certification or arbitrary path permission tool.
if (process.argv.length !== 2) throw Error("node-pty-prepare-accepts-no-path-arguments");
console.log(JSON.stringify(prepareNodePtyPrebuild(), null, 2));
