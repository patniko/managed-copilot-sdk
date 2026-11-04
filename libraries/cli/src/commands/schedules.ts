import { randomUUID } from "node:crypto";
import type { ScheduleInfo, ScheduleRun, ScheduleRunStatus } from "@managed-copilot/protocol";
import { resolveSchedule, type Context } from "../context.js";
import { UsageError } from "../errors.js";
import { relativeTime, shortId, table, truncate, type Style } from "../output.js";

export const SCHEDULE_ACTIONS = ["list", "runs", "pause", "resume", "delete", "run"] as const;

function paintRun(status: ScheduleRunStatus, style: Style): string {
  switch (status) {
    case "completed":
      return style.green(status);
    case "failed":
      return style.red(status);
    case "running":
    case "waiting":
    case "queued":
      return style.cyan(status);
    default:
      return style.dim(status);
  }
}

function cadence(schedule: ScheduleInfo): string {
  return schedule.cron ? `${schedule.cron} ${schedule.timeZone}` : schedule.runAt ? `once ${schedule.runAt}` : "-";
}

function list(ctx: Context, schedules: ScheduleInfo[]): void {
  const { style } = ctx;
  if (ctx.json) return ctx.out(JSON.stringify(schedules, null, 2));
  if (schedules.length === 0) {
    ctx.out("No schedules yet.");
    ctx.out(style.dim('  Create one from code: await managed.schedules.create({ name, cron, environment, prompt })'));
    return;
  }
  const rows = schedules.map((schedule) => {
    const pausedReason = (schedule as { pausedReason?: string }).pausedReason;
    return [
      style.bold(shortId(schedule.id)),
      schedule.name,
      schedule.state === "active" ? style.green("active") : style.yellow(pausedReason ? `paused ${style.dim(`(${truncate(pausedReason, 40, style.ellipsis)})`)}` : "paused"),
      style.dim(cadence(schedule)),
      schedule.state === "active" ? relativeTime(schedule.nextRunAt, ctx.now()) : style.dim("-"),
      schedule.lastRun ? `${paintRun(schedule.lastRun.status, style)} ${style.dim(relativeTime(schedule.lastRun.startedAt ?? schedule.lastRun.scheduledFor, ctx.now()))}` : style.dim("never"),
    ];
  });
  ctx.out(table(["ID", "NAME", "STATE", "SCHEDULE", "NEXT RUN", "LAST RUN"], rows, style));
}

function runs(ctx: Context, schedule: ScheduleInfo, entries: ScheduleRun[]): void {
  const { style } = ctx;
  if (ctx.json) return ctx.out(JSON.stringify(entries, null, 2));
  if (entries.length === 0) {
    ctx.out(`${style.bold(schedule.name)} has not run yet.${schedule.nextRunAt ? ` Next run ${relativeTime(schedule.nextRunAt, ctx.now())}.` : ""}`);
    return;
  }
  const rows = entries.map((run) => [
    style.dim(shortId(run.id)),
    relativeTime(run.scheduledFor, ctx.now()),
    paintRun(run.status, style),
    run.sessionId ? style.bold(shortId(run.sessionId)) : style.dim("-"),
    run.reason ? truncate(run.reason, 60, style.ellipsis) : "",
  ]);
  ctx.out(table(["RUN", "SCHEDULED", "STATUS", "SESSION", "DETAILS"], rows, style));
  if (entries.some((run) => run.sessionId)) ctx.out(style.dim("\n  Open a run's session in Copilot CLI: npx managed-copilot attach <SESSION>"));
}

export async function schedules(ctx: Context): Promise<void> {
  const { style } = ctx;
  const action = (ctx.args[0] ?? "list") as (typeof SCHEDULE_ACTIONS)[number];
  if (!SCHEDULE_ACTIONS.includes(action)) throw new UsageError(`Unknown schedules action "${ctx.args[0]}".`, `Use one of: ${SCHEDULE_ACTIONS.join(", ")}.`);
  const managed = await (await ctx.deployment()).managed();
  if (action === "list") return list(ctx, await managed.schedules.list());

  const schedule = await resolveSchedule(managed, ctx.args[1]);
  switch (action) {
    case "runs":
      return runs(ctx, schedule, await managed.schedules.runs(schedule.id));
    case "pause": {
      const updated = await managed.schedules.pause(schedule.id);
      if (ctx.json) return ctx.out(JSON.stringify(updated, null, 2));
      return ctx.out(`${style.green(style.ok)} Paused ${style.bold(updated.name)}. Resume it with: npx managed-copilot schedules resume ${updated.name}`);
    }
    case "resume": {
      const updated = await managed.schedules.resume(schedule.id);
      if (ctx.json) return ctx.out(JSON.stringify(updated, null, 2));
      return ctx.out(`${style.green(style.ok)} Resumed ${style.bold(updated.name)}.${updated.nextRunAt ? ` Next run ${relativeTime(updated.nextRunAt, ctx.now())}.` : ""}`);
    }
    case "delete": {
      if (!ctx.yes) {
        if (!ctx.interactive) throw new UsageError(`Deleting ${schedule.name} needs confirmation.`, "Pass --yes to delete without a prompt.");
        if (!(await ctx.confirm(`Delete schedule ${schedule.name}? Its future runs stop; past sessions stay.`))) return ctx.out("Kept the schedule.");
      }
      await managed.schedules.delete(schedule.id);
      if (ctx.json) return ctx.out(JSON.stringify({ deleted: schedule.id }, null, 2));
      return ctx.out(`${style.green(style.ok)} Deleted ${style.bold(schedule.name)}.`);
    }
    case "run": {
      // One invocation ID per command, so a retried request never starts a second run.
      const run = await managed.schedules.runNow(schedule.id, { invocationId: randomUUID() });
      if (ctx.json) return ctx.out(JSON.stringify(run, null, 2));
      ctx.out(`${style.green(style.ok)} Started a run of ${style.bold(schedule.name)} ${style.dim(`(${run.status})`)}.`);
      ctx.out(style.dim(`  Follow it with: npx managed-copilot schedules runs ${schedule.name}`));
    }
  }
}
