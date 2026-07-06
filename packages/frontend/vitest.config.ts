import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: true,
  },
  resolve: {
    alias: { "@hiagent/shared": "../../packages/shared/src/index.ts" },
  },
});
