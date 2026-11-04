/** Runs one walkthrough's code: `pnpm walkthrough 03` from the repository root or this folder. */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isManagedCopilotError } from "@managed-copilot/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const samples = readdirSync(here, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^\d\d-/.test(entry.name) && existsSync(join(here, entry.name, "main.ts")))
  .map((entry) => entry.name)
  .sort();

const wanted = process.argv[2] ?? "";
const sample = samples.find((name) => name === wanted || (/^\d{1,2}$/.test(wanted) && name.startsWith(`${wanted.padStart(2, "0")}-`)));
if (!sample) {
  console.error(`Usage: pnpm walkthrough <number> [options]\n\n${samples.map((name) => `  ${name}`).join("\n")}`);
  process.exit(2);
}

try {
  await import(pathToFileURL(join(here, sample, "main.ts")).href);
} catch (error) {
  const code = isManagedCopilotError(error) ? ` [${error.code}]` : "";
  console.error(`\n${sample} stopped: ${error instanceof Error ? error.message : String(error)}${code}`);
  process.exit(1);
}
// Leave nothing running: a sample is done once its code returns. A sample that couldn't clean up sets exitCode.
process.exit(process.exitCode ?? 0);
