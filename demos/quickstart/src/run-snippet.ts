/** Runs one snippet by number: `pnpm --filter @managed-copilot/quickstart snippet 03`. */
import { readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runSnippet, type Snippet } from "./harness.js";

const here = dirname(fileURLToPath(import.meta.url));
const wanted = (process.argv[2] ?? "").padStart(2, "0");
const file = (await readdir(here)).find((name) => /^\d\d-.*\.ts$/.test(name) && name.startsWith(wanted));
if (!process.argv[2] || !file) {
  const available = (await readdir(here)).filter((name) => /^\d\d-.*\.ts$/.test(name)).map((name) => `  ${name.replace(/\.ts$/, "")}`);
  console.error(`Usage: pnpm --filter @managed-copilot/quickstart snippet <number>\n\n${available.join("\n")}`);
  process.exit(2);
}
const { default: snippet } = (await import(pathToFileURL(`${here}/${file}`).href)) as { default: Snippet };
const result = await runSnippet(snippet);
process.exit(result.outcome === "fail" ? 1 : 0);
