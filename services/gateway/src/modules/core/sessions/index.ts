// The session manager: ownership, placement, upstream residency, request routing, and event fan-out for every
// session the gateway hosts. `SessionManager` is assembled from layers, one file per concern (see `manager.ts`).
export { SessionManager } from "./manager.js";
export { pathScrubber, upstreamTimings } from "./support.js";
export type { ClientPeer, LiveAttachmentSnapshot, LiveSessionSnapshot, SessionManagerOptions } from "./types.js";
