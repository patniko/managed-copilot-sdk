// Owner: sandbox workstream. Turn-scoped immutable artifacts from /workspace/outputs (spec section 6).
import { notImplemented } from "../connection.js";
import type { ManagedArtifacts, ManagedContext } from "../types.js";

export function createArtifactsApi(_ctx: ManagedContext, _sessionId: string): ManagedArtifacts {
  const unavailable = () => notImplemented("managed.artifacts()");
  return { waitForPublication: unavailable, list: unavailable, read: unavailable, readBytes: unavailable, download: unavailable };
}
