#!/usr/bin/env node
// Committed launcher so `npx managed-copilot` links at install time, before `pnpm build` creates dist/.
import("../dist/main.js").catch((error) => {
  if (error?.code === "ERR_MODULE_NOT_FOUND" && String(error.message).includes("dist")) {
    console.error("managed-copilot is not built yet. Run `pnpm build` at the repository root, then try again.");
    process.exit(1);
  }
  throw error;
});
