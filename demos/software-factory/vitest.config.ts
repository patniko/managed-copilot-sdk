import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    // Never open console windows from tests; keep pipeline logs quiet.
    env: { FACTORY_DISABLE_TERMINAL: "1", FACTORY_LOG_LEVEL: "error" },
  },
});
