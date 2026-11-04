import { ROUTES, type SessionInfo, type SessionListQuery } from "@managed-copilot/protocol";
import type { ManagedContext, ManagedSessions } from "../types.js";
import { handleSessionActions } from "./actions.js";

export function createSessionsApi(ctx: ManagedContext): ManagedSessions {
  return {
    list: (query?: SessionListQuery) =>
      ctx.http.get<SessionInfo[]>(ROUTES.sessions, { query: { environment: query?.environment, state: query?.state, limit: query?.limit } }),
    get: (sessionId) => ctx.httpFor(sessionId).get<SessionInfo>(ROUTES.session(sessionId)),
    delete: (sessionId) => ctx.httpFor(sessionId).delete(ROUTES.session(sessionId)),
    handleActions: (sessionId, handlers) => handleSessionActions(ctx, sessionId, handlers),
  };
}
