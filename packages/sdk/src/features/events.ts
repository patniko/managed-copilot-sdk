// Owner: core workstream. Subscribes to `GET /v1/events` (server-sent events) for `managed.on(...)`.
import type { ManagedContext } from "../types.js";

/** Starts the event stream on first subscription; must not throw if the stream is unavailable. */
export function ensureEventStream(_ctx: ManagedContext): void {
  // Not implemented yet: listeners register but receive nothing until the core workstream lands the SSE stream.
}
