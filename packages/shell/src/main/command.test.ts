import { describe, expect, it } from "vitest";
import { resolveShellCommand } from "./command.js";

// Seam: Electron main-process command resolution.
// Electron may consume or inject its own argv entries, so shell modes only
// come from an explicit environment flag or application args after `--`.

describe("resolveShellCommand", () => {
  it("keeps normal launches in window mode", () => {
    expect(resolveShellCommand(["/path/to/Electron", "."], {})).toEqual({
      kind: "window",
    });
  });

  it("ignores Electron CLI switches before the application-argument separator", () => {
    expect(
      resolveShellCommand(["/path/to/Electron", "--smoke", "."], {}),
    ).toEqual({ kind: "window" });
  });

  it("recognizes smoke mode after the application-argument separator", () => {
    expect(
      resolveShellCommand(["/path/to/Electron", ".", "--", "--smoke"], {}),
    ).toEqual({ kind: "smoke" });
  });

  it("recognizes smoke mode from the environment", () => {
    expect(
      resolveShellCommand(["/path/to/Electron", "."], { PIDOCK_SMOKE: "1" }),
    ).toEqual({ kind: "smoke" });
  });

  it("recognizes versions mode after the application-argument separator", () => {
    expect(
      resolveShellCommand(
        ["/path/to/Electron", ".", "--", "--print-versions"],
        {},
      ),
    ).toEqual({ kind: "versions" });
  });

  it("rejects conflicting explicit modes", () => {
    expect(() =>
      resolveShellCommand(
        ["/path/to/Electron", ".", "--", "--smoke", "--print-versions"],
        {},
      ),
    ).toThrow("conflicting shell command flags");
  });
});

describe("resolveShellCommand S3 smoke", () => {
  it("recognizes the two-phase task browser smoke flag", () => {
    expect(
      resolveShellCommand(
        ["/path/to/Electron", ".", "--", "--smoke-s3"],
        {},
      ),
    ).toEqual({ kind: "task-browser-smoke" });
  });

  it("recognizes S3 smoke from the environment", () => {
    expect(
      resolveShellCommand(["/path/to/Electron", "."], {
        PIDOCK_S3_SMOKE: "1",
      }),
    ).toEqual({ kind: "task-browser-smoke" });
  });

  it("rejects S3 smoke combined with another explicit mode", () => {
    expect(() =>
      resolveShellCommand(
        ["/path/to/Electron", ".", "--", "--smoke-s3", "--smoke"],
        {},
      ),
    ).toThrow("conflicting shell command flags");
  });
});
