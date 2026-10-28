import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    // Never open console windows from tests; keep logs quiet.
    env: { DISPATCH_DISABLE_TERMINAL: "1", DISPATCH_LOG_LEVEL: "error" },
  },
});
