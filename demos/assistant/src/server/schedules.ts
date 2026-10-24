/**
 * Schedules that target the conversation: reminders and recurring jobs the agent created with `schedule_task`, plus
 * automations the person adds from the UI. Uses `managed.schedules` (spec section 13).
 */
import { isManagedCopilotError, type ScheduleInfo } from "@managed-copilot/sdk";
import type { ScheduleView } from "../shared/protocol.js";
import type { AssistantConfig } from "./config.js";
import { describeCron } from "./cron.js";
import { UserFacingError } from "./conversation.js";
import { scheduleDisplayName } from "./describe.js";
import { errorMessage, type Logger } from "./log.js";
import type { Platform } from "./platform.js";
import { formatWhen } from "./time.js";

export const MORNING_BRIEFING = {
  name: "Weekday morning briefing",
  cron: "0 8 * * 1-5",
  prompt:
    "It's time for my morning briefing. Check today's calendar (flag conflicts and anything I need to prepare) and my unread mail from the last day, then give me a short briefing grouped by priority. Offer to draft replies where useful.",
} as const;

export interface SchedulesDeps {
  readonly config: AssistantConfig;
  readonly log: Logger;
  readonly platform: Platform;
  sessionId(): string | undefined;
  timeZone(): string;
  onChange(schedules: readonly ScheduleView[], error: string | undefined): void;
}

function toView(schedule: ScheduleInfo, timeZone: string): ScheduleView {
  const oneShot = !schedule.cron;
  const cadence = schedule.cron
    ? `${describeCron(schedule.cron)}${schedule.timeZone && schedule.timeZone !== timeZone ? ` (${schedule.timeZone})` : ""}`
    : schedule.runAt
      ? `Once, ${formatWhen(new Date(schedule.runAt), timeZone).replace(/^([A-Z])/, (c) => c.toLowerCase())}`
      : "Once";
  return {
    id: schedule.id,
    name: scheduleDisplayName(schedule.name, schedule.prompt),
    cadence,
    cron: schedule.cron,
    runAt: schedule.runAt,
    timeZone: schedule.timeZone,
    prompt: schedule.prompt,
    state: schedule.state,
    createdBy: schedule.createdBy,
    nextRunAt: schedule.nextRunAt,
    lastRun: schedule.lastRun
      ? { status: schedule.lastRun.status, startedAt: schedule.lastRun.startedAt, completedAt: schedule.lastRun.completedAt, reason: schedule.lastRun.reason }
      : undefined,
    oneShot,
  };
}

function friendly(error: unknown): string {
  if (isManagedCopilotError(error, "capability_unavailable") && /not available in this build/i.test(errorMessage(error))) {
    return "Schedules aren't available on this platform yet.";
  }
  if (isManagedCopilotError(error, "authentication_required")) {
    return "Scheduled work needs your background sign-in. Run `npx managed-copilot login` once, then try again.";
  }
  return errorMessage(error);
}

export class Schedules {
  readonly #deps: SchedulesDeps;
  #schedules: ScheduleView[] = [];
  #raw = new Map<string, ScheduleInfo>();
  #error: string | undefined;
  #refreshing: Promise<void> | undefined;
  #retry: NodeJS.Timeout | undefined;

  constructor(deps: SchedulesDeps) {
    this.#deps = deps;
  }

  get list(): readonly ScheduleView[] {
    return this.#schedules;
  }

  get error(): string | undefined {
    return this.#error;
  }

  /** The schedule whose prompt was delivered as this `source: "system"` message, when known. */
  nameFor(text: string): string | undefined {
    const normalized = text.trim();
    for (const schedule of this.#raw.values()) {
      if (schedule.prompt.trim() === normalized) return scheduleDisplayName(schedule.name, schedule.prompt);
    }
    return undefined;
  }

  refresh(): Promise<void> {
    this.#refreshing ??= this.#refresh().finally(() => (this.#refreshing = undefined));
    return this.#refreshing;
  }

  async #refresh(): Promise<void> {
    const managed = this.#deps.platform.managed;
    const sessionId = this.#deps.sessionId();
    if (!managed) return;
    clearTimeout(this.#retry);
    try {
      const all = await managed.schedules.list();
      const mine = all.filter((schedule) => sessionId !== undefined && schedule.target?.sessionId === sessionId);
      // Keep finished one-shot reminders out of the way; their results are in the chat.
      const visible = mine.filter((schedule) => schedule.cron || schedule.state === "paused" || schedule.nextRunAt);
      this.#raw = new Map(mine.map((schedule) => [schedule.id, schedule]));
      const timeZone = this.#deps.timeZone();
      this.#schedules = visible
        .map((schedule) => toView(schedule, timeZone))
        .sort((a, b) => {
          if (a.state !== b.state) return a.state === "active" ? -1 : 1;
          return (Date.parse(a.nextRunAt ?? "") || Infinity) - (Date.parse(b.nextRunAt ?? "") || Infinity);
        });
      this.#error = undefined;
    } catch (error) {
      // Keep showing the last known list; transient failures retry shortly.
      this.#error = friendly(error);
      this.#deps.log.debug("Couldn't list schedules", { error: errorMessage(error) });
      if (!(isManagedCopilotError(error, "capability_unavailable") && /not available in this build/i.test(errorMessage(error)))) {
        this.#retry = setTimeout(() => void this.refresh(), 15_000);
        this.#retry.unref();
      }
    }
    this.#deps.onChange(this.#schedules, this.#error);
  }

  #owned(id: string): ScheduleInfo {
    const schedule = this.#raw.get(id);
    if (!schedule) throw new UserFacingError("not_found", "That scheduled task no longer exists.");
    return schedule;
  }

  async #run<T>(action: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof UserFacingError) throw error;
      throw new UserFacingError("schedule_failed", `Couldn't ${action}: ${friendly(error)}`);
    } finally {
      await this.refresh();
    }
  }

  #managed() {
    const managed = this.#deps.platform.managed;
    if (!managed) throw new UserFacingError("platform_unavailable", "Managed Copilot isn't connected.");
    return managed;
  }

  pause(id: string): Promise<unknown> {
    this.#owned(id);
    return this.#run("pause the task", () => this.#managed().schedules.pause(id));
  }

  resume(id: string): Promise<unknown> {
    this.#owned(id);
    return this.#run("resume the task", () => this.#managed().schedules.resume(id));
  }

  remove(id: string): Promise<unknown> {
    this.#owned(id);
    return this.#run("delete the task", () => this.#managed().schedules.delete(id));
  }

  runNow(id: string, invocationId: string): Promise<unknown> {
    this.#owned(id);
    return this.#run("run the task", () => this.#managed().schedules.runNow(id, { invocationId }));
  }

  /** One-click weekday morning briefing that lands in the conversation. */
  addMorningBriefing(): Promise<unknown> {
    const sessionId = this.#deps.sessionId();
    if (!sessionId) throw new UserFacingError("no_conversation", "Say hello to your assistant first, then add the briefing.");
    if (this.#schedules.some((s) => s.name === MORNING_BRIEFING.name)) {
      throw new UserFacingError("exists", "You already have a weekday morning briefing.");
    }
    return this.#run("add the briefing", () =>
      this.#managed().schedules.create({
        name: MORNING_BRIEFING.name,
        cron: MORNING_BRIEFING.cron,
        timeZone: this.#deps.timeZone(),
        target: { sessionId },
        webhook: this.#deps.config.webhookName,
        prompt: MORNING_BRIEFING.prompt,
      }),
    );
  }
}
