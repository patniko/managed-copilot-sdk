// Owner: sandbox workstream. Streams workspace files to and from an isolated session's sandbox (spec section 5).
import { notImplemented } from "../connection.js";
import type { ManagedContext, ManagedFiles } from "../types.js";

export function createFilesApi(_ctx: ManagedContext, _sessionId: string): ManagedFiles {
  const unavailable = () => notImplemented("managed.files()");
  return { list: unavailable, upload: unavailable, write: unavailable, download: unavailable, read: unavailable, readBytes: unavailable };
}
