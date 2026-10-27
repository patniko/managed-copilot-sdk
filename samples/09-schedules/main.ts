// Walkthrough 09: run on a schedule. Steps and output: samples/09-schedules/README.md
// Run it with: pnpm sample 09
// Once per deployment first: npx managed-copilot login   (scheduled runs act as you while you're away)
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { approveAll } from "@github/copilot-sdk";
import { ManagedCopilot, type ScheduleRun } from "@managed-copilot/sdk";

const managed = await ManagedCopilot.connect();
/** Cleanup that can't finish is reported, never ignored. */
const couldNotDelete = (what: string) => (error: Error) => {
  process.exitCode = 1;
  console.error(`Couldn't delete ${what}: ${error.message}`);
};

// Every weekday at 9:00 Seattle time, start a new "chat" session with this prompt.
const schedule = await managed.schedules.create({
  name: `standup-reminder-${randomUUID().slice(0, 8)}`,
  cron: "0 9 * * 1-5",
  timeZone: "America/Los_Angeles",
  environment: "chat",
  prompt: "Write a two-line stand-up reminder: review open pull requests, then update your tickets.",
});
console.log(`Created ${schedule.name}: "${schedule.cron}" in ${schedule.timeZone}`);
console.log(`  state ${schedule.state}, next run ${schedule.nextRunAt}`);

let run: ScheduleRun | undefined;
try {
  // Don't wait for a weekday morning: run it now. Retrying with the same invocationId never starts a second run.
  run = await managed.schedules.runNow(schedule.id, { invocationId: randomUUID() });
  console.log(`Run ${run.id} started...`);

  let finished: ScheduleRun | undefined;
  for (const deadline = Date.now() + 5 * 60_000; !finished; await sleep(2_000)) {
    if (Date.now() > deadline) throw new Error("The run did not finish within 5 minutes.");
    const latest = (await managed.schedules.runs(schedule.id)).find((candidate) => candidate.id === run?.id);
    if (latest) run = latest;
    if (latest && !["queued", "running", "waiting"].includes(latest.status)) finished = latest;
  }
  if (finished.status !== "completed" || !finished.sessionId) {
    throw new Error(`The run ended as ${finished.status}${finished.reason ? `: ${finished.reason}` : "."}`);
  }
  console.log(`Run completed in session ${finished.sessionId}`);

  // Each run is an ordinary session you own. Resume it to read what the agent wrote.
  const session = await managed.resumeSession(finished.sessionId, { onPermissionRequest: approveAll });
  const reply = (await session.getEvents()).filter((event) => event.type === "assistant.message").at(-1);
  console.log(`\nCopilot (scheduled run):\n${reply?.data.content}`);
} finally {
  // The run started its own session. If no poll saw it yet, look it up once, then delete it and the schedule.
  let sessionId = run?.sessionId;
  if (!sessionId && run) sessionId = (await managed.schedules.runs(schedule.id).catch(() => [])).find((r) => r.id === run?.id)?.sessionId;
  if (sessionId) await managed.sessions.delete(sessionId).catch(couldNotDelete(`session ${sessionId}`));
  await managed.schedules.delete(schedule.id).catch(couldNotDelete(`schedule ${schedule.id}`));
  await managed.close();
}
