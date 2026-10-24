// Owner: devloop workstream. Copilot CLI attach (spec section 14): short-lived, owner-scoped attach material and a
// WebSocket that relays the stock CLI's AHP connection to a per-session listener on the session's own runtime.
import type { IncomingMessage } from "node:http";
import { ATTACH_CLOSE_CODES, ManagedCopilotError, ROUTES, parseWebSocketProtocols, type AttachMaterial, type SessionInfo } from "@managed-copilot/protocol";
import { WebSocketServer } from "ws";
import type { GatewayApp, GatewayModule } from "../../app.js";
import { AhpHosts } from "./hosts.js";
import { bridge, openUpstream } from "./proxy.js";
import { AttachTickets, TICKET_PREFIX } from "./tickets.js";
import type { AttachSessions, SessionLifecycleEvent } from "./types.js";

export type { AttachSessions, SessionLifecycleEvent, SessionRuntime } from "./types.js";

const MAX_CLIENT_FRAME_BYTES = 16 * 1024 * 1024;

function sessionsOf(app: GatewayApp): AttachSessions {
  const sessions = (app.services as Record<string, unknown>).sessions as AttachSessions | undefined;
  if (!sessions) throw new ManagedCopilotError("capability_unavailable", "The sessions service is not available on this gateway");
  return sessions;
}

function assertAttachable(info: SessionInfo): void {
  if (info.state === "promoting") throw new ManagedCopilotError("session_busy", "This session is moving into a sandbox. Attach again when the move finishes.");
  if (info.state === "deleting" || info.state === "deleted") throw new ManagedCopilotError("conflict", "This session was deleted.");
  if (info.state === "failed") throw new ManagedCopilotError("conflict", "This session failed and cannot be attached.");
}

function ticketFrom(req: IncomingMessage, url: URL): string | undefined {
  const fromQuery = url.searchParams.get("tkn");
  if (fromQuery) return fromQuery;
  // The stock Copilot CLI sends its own GitHub token as Authorization; only an attach ticket counts here.
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
  return match?.[1]?.startsWith(TICKET_PREFIX) ? match[1] : undefined;
}

/** The checks ws applies before accepting a handshake, made before a ticket is spent or the runtime is contacted. */
function isWebSocketHandshake(req: IncomingMessage): boolean {
  const key = req.headers["sec-websocket-key"];
  const version = req.headers["sec-websocket-version"];
  return (
    req.method === "GET" &&
    req.headers.upgrade?.toLowerCase() === "websocket" &&
    typeof key === "string" &&
    /^[+/0-9A-Za-z]{22}==$/.test(key) &&
    (version === "13" || version === "8")
  );
}

function lifecycleReason(type: SessionLifecycleEvent["type"]): string {
  switch (type) {
    case "deleted":
      return "The session was deleted.";
    case "promoted":
      return "The session moved into a sandbox. Reconnecting.";
    case "stopped":
      return "The session's runtime stopped. Attach again to resume it.";
  }
}

function setting(app: GatewayApp, name: string, fallback: number): number {
  const value = Number(app.config.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const attachModule: GatewayModule = {
  name: "attach",
  register(app) {
    const log = app.log.child("attach");
    const ticketTtlMs = setting(app, "MANAGED_COPILOT_ATTACH_TICKET_TTL_MS", 60_000);
    const idleMs = setting(app, "MANAGED_COPILOT_ATTACH_IDLE_MS", 5 * 60_000);
    const maxLifetimeMs = setting(app, "MANAGED_COPILOT_ATTACH_MAX_LIFETIME_MS", 8 * 60 * 60_000);
    const tickets = new AttachTickets(app.db);
    const hosts = new AhpHosts(log, idleMs);
    const socketBase = app.config.publicUrl.replace(/^http/i, "ws");
    app.capabilities.add("attach.cli");

    /**
     * The session's current runtime, checked as attachable. Resolved inside the host queue, so a release queued by a
     * lifecycle event (deleted, promoted) settles first and a host never starts on the runtime the session just left.
     */
    const currentRuntime = (accountId: number, sessionId: string) => async () => {
      const sessions = sessionsOf(app);
      assertAttachable(await sessions.info(accountId, sessionId));
      return sessions.runtime(sessionId);
    };

    app.routes.post("/v1/sessions/:id/attach", async (ctx) => {
      const principal = ctx.principal;
      const sessionId = ctx.params.id;
      if (!principal || !sessionId) throw new ManagedCopilotError("authentication_required", "Sign in to attach to a session");
      const host = await hosts.ensure(sessionId, currentRuntime(principal.accountId, sessionId));
      const { token, expiresAt } = tickets.mint(principal.accountId, sessionId, ticketTtlMs);
      const material: AttachMaterial = { transport: "ahp", url: `${socketBase}${ROUTES.attachSocket(sessionId)}`, token, expiresAt, ahpSessionId: host.sessionUri };
      return material;
    });

    app.upgrades.add(
      "/v1/sessions/:id/ahp",
      async (req, socket, head, _principal, { url, params }) => {
        socket.on("error", () => socket.destroy());
        const sessionId = params.id ?? "";
        if (!isWebSocketHandshake(req)) throw new ManagedCopilotError("invalid_request", "This endpoint only accepts a WebSocket handshake.");
        const protocols = parseWebSocketProtocols(req.headers["sec-websocket-protocol"]);
        if (!protocols) throw new ManagedCopilotError("invalid_request", "The Sec-WebSocket-Protocol header is malformed.");
        const presented = ticketFrom(req, url);
        if (!presented) throw new ManagedCopilotError("authentication_required", `Attach with a ticket from POST ${ROUTES.attach(sessionId)}`);
        const ticket = tickets.redeem(presented, sessionId);
        if (!ticket) throw new ManagedCopilotError("authentication_required", "This attach ticket is invalid, expired, or already used. Request a new one.");
        const host = await hosts.ensure(sessionId, currentRuntime(ticket.accountId, sessionId));
        let upstream;
        try {
          upstream = await openUpstream(host, protocols);
        } catch (error) {
          throw new ManagedCopilotError("capability_unavailable", `Cannot reach this session's Copilot CLI listener: ${(error as Error).message}`);
        }
        if (host.closed) {
          upstream.terminate();
          throw new ManagedCopilotError("conflict", "The session's Copilot CLI hosting ended while connecting. Attach again.");
        }
        if (socket.destroyed) {
          upstream.terminate();
          return;
        }
        const server = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_CLIENT_FRAME_BYTES, handleProtocols: () => upstream.protocol || false });
        let attached = false;
        server.handleUpgrade(req, socket, head, (client) => {
          attached = true;
          hosts.track(host, client);
          bridge(client, upstream, { log, sessionId, maxLifetimeMs });
          log.info("Copilot CLI attached", { sessionId, accountId: ticket.accountId });
        });
        // ws completes or refuses the handshake synchronously; a refused one leaves nothing to own the upstream.
        if (!attached) upstream.terminate();
      },
      { auth: "none" },
    );

    let unsubscribe: (() => void) | undefined;
    app.onStart(() => {
      const sessions = (app.services as Record<string, unknown>).sessions as AttachSessions | undefined;
      unsubscribe = sessions?.onLifecycle?.((event) =>
        void hosts.release(event.sessionId, lifecycleReason(event.type), event.type === "promoted" ? { code: ATTACH_CLOSE_CODES.moved } : {}),
      );
    });
    app.onStop(async () => {
      unsubscribe?.();
      await hosts.disposeAll("The Managed Copilot gateway is shutting down.");
    });
  },
};
