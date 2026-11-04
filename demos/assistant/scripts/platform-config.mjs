// Writes a gateway configuration with the assistant's environment and webhook, for running the platform without
// Aspire: MANAGED_COPILOT_CONFIG_FILE=<this file> node services/gateway/dist/main.js
// Usage: node demos/assistant/scripts/platform-config.mjs [output path]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assistantCopilotOptions } from "../apphost.mts";

const output = resolve(process.argv[2] ?? fileURLToPath(new URL("../.data/apphost.json", import.meta.url)));
const config = {
  name: "copilot",
  // The webhook secret reaches the gateway through this environment variable, never through the JSON.
  ...assistantCopilotOptions({ webhookSecret: { secretEnv: "ASSISTANT_WEBHOOK_SECRET" } }),
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Wrote ${output}`);
