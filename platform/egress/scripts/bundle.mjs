// Bundles the egress proxy into one dependency-free ESM file for the container image (dist/egress.mjs).
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

await build({
  absWorkingDir: root,
  entryPoints: ["src/main.ts"],
  outfile: "dist/egress.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
  banner: { js: "import { createRequire as __mcCreateRequire } from 'node:module'; const require = __mcCreateRequire(import.meta.url);" },
});
