#!/usr/bin/env node
// Usage: managed-copilot-storage-probe [--dir <directory>] [--keep]
//
// Qualifies the storage behind the gateway's data directory (default: a fresh directory under
// $MANAGED_COPILOT_DATA_DIR/.probe). Prints a JSON report; exits 0 only when every check passed.
import { fileURLToPath } from "node:url";
import { defaultProbeDirectory, runChild, runProbe } from "./probe.js";

const args = process.argv.slice(2);
const childAt = args.indexOf("--child");
if (childAt >= 0) {
  try {
    await runChild(args.slice(childAt + 1));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
} else {
  const dirAt = args.indexOf("--dir");
  const directory = dirAt >= 0 && args[dirAt + 1] ? args[dirAt + 1]! : defaultProbeDirectory();
  const report = await runProbe({
    directory,
    keep: args.includes("--keep"),
    childCommand: [process.execPath, ...process.execArgv, fileURLToPath(import.meta.url)],
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.result === "passed" ? 0 : 1);
}
