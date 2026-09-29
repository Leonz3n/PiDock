import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // shadcn/ui imports resolve through this alias (tsconfig `paths` mirrors it).
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  base: "./",
  server: {
    port: 4335,
    strictPort: true,
  },
  build: {
    target: "chrome152",
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
    css: true,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
