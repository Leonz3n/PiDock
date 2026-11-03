import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The suite drives REAL git and filesystem work (worktrees, clones, bare
    // remotes) in parallel workers. A loaded full-suite run can push a single
    // case past vitest's 5s default even though it is correct; the ceiling is
    // raised so timing pressure cannot masquerade as a product failure.
    testTimeout: 30_000,
  },
});
