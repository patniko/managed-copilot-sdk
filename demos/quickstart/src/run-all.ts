/**
 * One acceptance run of every spec snippet against your platform:
 *   pnpm --filter @managed-copilot/quickstart acceptance            # all snippets
 *   pnpm --filter @managed-copilot/quickstart acceptance 01 02 13   # a selection
 *   ... acceptance --strict                                         # count unavailable features as failures
 */
import { ManagedCopilot } from "@managed-copilot/sdk";
import idea from "./01-the-idea.js";
import sharedChat from "./02-shared-chat-with-a-tool.js";
import isolatedCoder from "./03-isolated-coder.js";
import setup from "./04-setup.js";
import artifacts from "./05-artifacts.js";
import network from "./06-network.js";
import vaults from "./07-vaults.js";
import promotable from "./08-promotable.js";
import comeBackLater from "./09-come-back-later.js";
import offlineWebhook from "./10-offline-webhook.js";
import polling from "./11-polling.js";
import schedules from "./12-schedules.js";
import attach from "./13-attach.js";
import { runSnippet, style, symbols, type Outcome, type SnippetResult } from "./harness.js";

const ALL = [idea, sharedChat, isolatedCoder, setup, artifacts, network, vaults, promotable, comeBackLater, offlineWebhook, polling, schedules, attach];

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const selected = args.filter((arg) => !arg.startsWith("--"));
const snippets = selected.length === 0 ? ALL : ALL.filter((snippet) => selected.some((prefix) => snippet.id.startsWith(prefix.padStart(2, "0"))));
if (snippets.length === 0) {
  console.error(`No snippets match ${selected.join(", ")}. Use numbers 01-${ALL.length}.`);
  process.exit(2);
}

try {
  const managed = await ManagedCopilot.connect();
  console.log(style.bold("Managed Copilot quickstart"));
  console.log(style.dim(`${managed.url} · @${managed.account.login} · ${managed.info.name} v${managed.info.version} · capabilities: ${managed.info.capabilities.join(", ") || "none"}`));
  await managed.close();
} catch (error) {
  console.error(`${style.red(symbols.fail)} ${(error as Error).message}`);
  console.error(style.dim("  Start the platform from the repository root with `aspire run`, then run the quickstart again."));
  process.exit(1);
}

const results: SnippetResult[] = [];
for (const snippet of snippets) results.push(await runSnippet(snippet));

const counts: Record<Outcome, number> = { pass: 0, fail: 0, unavailable: 0, skipped: 0 };
for (const result of results) counts[result.outcome]++;
const paint: Record<Outcome, (text: string) => string> = { pass: style.green, fail: style.red, unavailable: style.yellow, skipped: style.dim };

console.log(`\n${style.bold("Summary")}`);
const width = Math.max(...results.map((result) => result.snippet.title.length));
for (const result of results) {
  const time = style.dim(`${(result.durationMs / 1000).toFixed(1)}s`.padStart(7));
  const detail = result.outcome === "pass" ? style.dim(`${result.checks} checks`) : paint[result.outcome](result.detail ?? "");
  console.log(`  ${paint[result.outcome](symbols[result.outcome])} ${result.snippet.id}  ${result.snippet.title.padEnd(width)}  ${time}  ${detail}`);
}
console.log(
  `\n  ${[
    paint.pass(`${counts.pass} passed`),
    counts.fail ? paint.fail(`${counts.fail} failed`) : "",
    counts.unavailable ? paint.unavailable(`${counts.unavailable} not available yet`) : "",
    counts.skipped ? paint.skipped(`${counts.skipped} skipped`) : "",
  ]
    .filter(Boolean)
    .join(" · ")}`,
);
// Exit explicitly: a timed-out snippet's platform work cannot be cancelled from here and may hold connections open.
process.exit(counts.fail > 0 || (strict && counts.unavailable > 0) ? 1 : 0);
