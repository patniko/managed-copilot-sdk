import { defineConfig } from "vitest/config";

// Docker-based end-to-end tests: real egress container, gateway network module, echo services, and sandbox-like
// clients on internal networks. Run with `pnpm --filter @managed-copilot/egress test:docker` (needs Docker).
export default defineConfig({
  test: {
    include: ["test/docker/**/*.docker.ts"],
    testTimeout: 180_000,
    hookTimeout: 900_000,
    fileParallelism: false,
  },
});
