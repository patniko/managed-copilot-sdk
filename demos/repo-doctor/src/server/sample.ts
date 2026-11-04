import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { SampleInfo } from "../shared/types.js";

export interface SampleProject extends SampleInfo {
  readonly version: string;
  /** Workspace-relative POSIX paths and their text. */
  readonly files: readonly { readonly path: string; readonly content: string }[];
}

function walk(root: string, dir: string, out: { path: string; content: string }[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, full, out);
    else if (entry.isFile()) out.push({ path: relative(root, full).split(sep).join("/"), content: readFileSync(full, "utf8") });
  }
}

/** The bundled sample project: a small library with a real bug and the tests that catch it. */
export function loadSample(dir: string): SampleProject {
  const files: { path: string; content: string }[] = [];
  walk(dir, dir, files);
  const manifest = files.find((file) => file.path === "package.json");
  if (!manifest) throw new Error(`The sample project in ${dir} has no package.json`);
  const pkg = JSON.parse(manifest.content) as { name?: string; version?: string; description?: string };
  return { name: pkg.name ?? "sample", version: pkg.version ?? "0.0.0", description: pkg.description ?? "", files };
}
