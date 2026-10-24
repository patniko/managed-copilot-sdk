// Owner: durable workstream. Schedules that start or continue sessions (spec section 13).
import { notImplemented } from "../connection.js";
import type { ManagedContext, ManagedSchedules } from "../types.js";

export function createSchedulesApi(_ctx: ManagedContext): ManagedSchedules {
  const unavailable = () => notImplemented("managed.schedules");
  return {
    create: unavailable,
    list: unavailable,
    get: unavailable,
    runs: unavailable,
    pause: unavailable,
    resume: unavailable,
    delete: unavailable,
    runNow: unavailable,
  };
}
