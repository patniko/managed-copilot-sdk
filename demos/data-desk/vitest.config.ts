import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    // Never open console windows from tests; keep logs quiet.
    env: { DATA_DESK_DISABLE_TERMINAL: "1", DATA_DESK_LOG_LEVEL: "error" },
  },
});
