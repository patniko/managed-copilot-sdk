import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL("./src/web", import.meta.url));
// `pnpm dev` serves the page with hot reload and sends everything else to a running `pnpm gallery` (GALLERY_PORT in
// src/shared/catalog.ts, shifted by MANAGED_COPILOT_PORT_OFFSET like the gallery).
const offset = Number(process.env.MANAGED_COPILOT_PORT_OFFSET ?? 0);
const gallery = `http://127.0.0.1:${Number(process.env.GALLERY_PORT ?? 7460 + offset)}`;

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: Number(process.env.GALLERY_WEB_PORT ?? 7461 + offset),
    strictPort: true,
    proxy: { "/api": gallery, "/shots": gallery, "/open": gallery },
  },
  clearScreen: false,
});
