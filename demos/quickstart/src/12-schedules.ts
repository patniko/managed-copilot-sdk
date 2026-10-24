import { randomUUID } from "node:crypto";
import { ROUTES, type BackgroundCredentialStatus } from "@managed-copilot/protocol";
import { ManagedCopilot } from "@managed-copilot/sdk";
import { HttpClient, resolveToken } from "@managed-copilot/sdk/internal";
import { eventually, snippet } from "./harness.js";
import { lookupOrder } from "./orders.js";
import { startWebhookReceiver } from "./webhook-receiver.js";

export default snippet(import.meta.url, { title: "Run on a schedule", section: "spec §13", requires: ["schedules", "background", "webhooks"], timeoutMs: 8 * 60_000 }, async (t) => {
  const managed = await ManagedCopilot.connect();
  t.cleanup(() => managed.close());

  // Runs execute as you through background sign-in (`npx managed-copilot login`, spec section 2).
  const background = await new HttpClient(managed.url, await resolveToken()).get<BackgroundCredentialStatus>(ROUTES.backgroundCredential);
  if (!background.active) return t.skip("Run `npx managed-copilot login` once so scheduled runs can act as you, then run this snippet again.");
  const secret = process.env.COPILOT_WEBHOOK_SECRET;
  if (!secret) return t.skip("Needs the AppHost's quickstart webhook secret: start the quickstart from the Aspire dashboard, or set COPILOT_WEBHOOK_SECRET.");
  const receiver = await startWebhookReceiver(secret); // answers lookup_order while this process is "offline"
  t.cleanup(() => receiver.close());

  const schedule = await managed.schedules.create({
    name: `weekday-triage-${randomUUID().slice(0, 8)}`,
    cron: "0 9 * * 1-5",
    timeZone: "America/Los_Angeles",
    environment: "chat",
    session: { agent: "triage", tools: [lookupOrder] },
    webhook: "quickstart", // supplies an authorized handler while the creating process is offline
    prompt: "Triage the issues opened since the last run",
  });
  t.cleanup(() => managed.schedules.delete(schedule.id));

  for (const run of await managed.schedules.runs(schedule.id)) {
    console.log(run.startedAt, run.status, run.sessionId);
  }

  // Acceptance checks
  t.check(schedule.state === "active" && Boolean(schedule.nextRunAt), `the schedule is active; next run ${schedule.nextRunAt}`);
  t.check(schedule.session?.tools?.[0]?.name === "lookup_order" && !("handler" in (schedule.session.tools[0] ?? {})), "only the tool's declaration was stored");
  const run = await managed.schedules.runNow(schedule.id, { invocationId: randomUUID() });
  const finished = await eventually(
    async () => (await managed.schedules.runs(schedule.id)).find((candidate) => candidate.id === run.id && ["completed", "failed", "skipped"].includes(candidate.status)),
    { timeoutMs: 6 * 60_000, what: "the run to finish" },
  );
  console.log(finished.startedAt, finished.status, finished.sessionId);
  t.check(finished.status === "completed" && Boolean(finished.sessionId), `runNow started session ${finished.sessionId} and completed`);
  if (finished.sessionId) t.cleanup(() => managed.sessions.delete(finished.sessionId!));
});
