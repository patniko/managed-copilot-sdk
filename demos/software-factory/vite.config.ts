import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL("./src/web", import.meta.url));

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  clearScreen: false,
});
