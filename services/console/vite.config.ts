import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The gateway serves the built console at /console (MANAGED_COPILOT_CONSOLE_DIR overrides where it looks).
// `pnpm dev` serves it with hot reload and proxies the operator API to a running gateway (MANAGED_COPILOT_URL).
const gateway = process.env.MANAGED_COPILOT_URL ?? "http://127.0.0.1:7400";

export default defineConfig({
  root: fileURLToPath(new URL("./src", import.meta.url)),
  base: "/console/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: Number(process.env.CONSOLE_DEV_PORT ?? 7401),
    strictPort: true,
    proxy: { "/v1": { target: gateway, changeOrigin: false } },
  },
  clearScreen: false,
});
