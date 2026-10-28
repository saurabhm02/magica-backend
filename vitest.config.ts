import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    // tests/db/ files share one live Postgres connection — running them in parallel
    // causes Neon connection contention and flaky timeouts.
    fileParallelism: false,
    // tests/db/ round-trip to real Neon over a websocket; the 5s default is too tight.
    testTimeout: 15000,
  },
});
