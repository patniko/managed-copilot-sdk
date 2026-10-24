import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL("./src/web", import.meta.url));
const serverPort = Number(process.env.PORT ?? 7490);

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: Number(process.env.ASSISTANT_WEB_PORT ?? 7491),
    strictPort: true,
    proxy: {
      "/api": { target: `http://127.0.0.1:${serverPort}`, changeOrigin: true },
      "/healthz": { target: `http://127.0.0.1:${serverPort}`, changeOrigin: true },
    },
  },
});
