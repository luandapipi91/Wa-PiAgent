import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: true,
  },
  resolve: {
    alias: { "@hiagent/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)) },
  },
});
