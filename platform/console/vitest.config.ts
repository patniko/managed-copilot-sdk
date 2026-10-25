import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// vite.config.ts roots the app at src/; tests live in test/ and cover pure logic in a node environment.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
