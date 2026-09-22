import { fileURLToPath } from "node:url";

/**
 * Shared constants for the renderer evidence scripts. Keeping the Chrome path,
 * the two base URLs, the capture viewport and the evidence directory in one
 * place stops the four scripts from drifting apart; each value is still
 * overridable by environment variable.
 */

export const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Renderer dev server. Port 4335 is the fixed contract (4318 is taken locally). */
export const RENDERER_BASE = process.env.RENDERER_BASE ?? "http://127.0.0.1:4335";

/** Read-only prototype server; never modified by these scripts. */
export const PROTOTYPE_BASE = process.env.PROTOTYPE_BASE ?? "http://127.0.0.1:4319/?variant=A";

/** Where measurements, screenshots and verification JSON are written. */
export const EVIDENCE_DIR =
  process.env.EVIDENCE_DIR ??
  fileURLToPath(new URL("../../../docs/evidence/renderer-baseline-2026-09-22/", import.meta.url));

/** Fixed capture viewport, so screenshots and measurements are comparable. */
export const VIEWPORT = { width: 1440, height: 900 };
