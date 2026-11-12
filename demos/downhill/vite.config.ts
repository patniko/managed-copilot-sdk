import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL("./src/web", import.meta.url));

// NO_HMR (set by the scripts' in-process server) freezes the served files, so edits can't reload a run mid-test.
const noHmr = Boolean(process.env.NO_HMR);

// The shop's checkout imports Contoso Outdoors' storefront code from demos/help-desk/storefront. Vite serves and bundles
// it like the game's own modules: it's inside the workspace root, which the dev server may read.
export default defineConfig({
  root,
  server: { host: "127.0.0.1", hmr: { overlay: false }, ...(noHmr ? { watch: null } : {}) },
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 4000,
  },
  // Module workers: the human rider is sculpted on a worker while the world builds.
  worker: { format: "es" },
  clearScreen: false,
});
