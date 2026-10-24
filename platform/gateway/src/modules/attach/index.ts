// Owner: attach workstream. Copilot CLI attach (spec section 14): short-lived, owner-scoped attach material and a
// WebSocket that mediates the stock CLI's AHP connection to a per-session listener on the session's own runtime.
// The CLI is a `cli` responder of the session (core's `attachCli`): its turns and cancels are admitted and fenced by
// core, its approvals and answers go through the actions ledger, and anything else it may not do is refused
// (policy.ts). A promotion fences it (promotion participant) before the source runtime is checkpointed.
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { ATTACH_CLOSE_CODES, ManagedCopilotError, ROUTES, parseWebSocketProtocols, type AttachMaterial, type SessionInfo } from "@managed-copilot/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import type { GatewayApp, GatewayModule } from "../../app.js";
import { pathScrubber } from "../core/sessions.js";
import type { PromotionParticipant } from "../promotion/contract.js";
import { AhpHosts } from "./hosts.js";
import { uriAwareScrubber } from "./policy.js";
import { AhpBridge, LEDGER_WAIT_MS, openUpstream } from "./proxy.js";
import { AttachTickets, TICKET_PREFIX } from "./tickets.js";
import type { AttachActions, AttachSessions, CliAttachment, SessionLifecycleEvent } from "./types.js";

export type { AttachActions, AttachSessions, SessionLifecycleEvent, SessionRuntime } from "./types.js";

const MAX_CLIENT_FRAME_BYTES = 16 * 1024 * 1024;

function sessionsOf(app: GatewayApp): AttachSessions {
  const sessions = (app.services as Record<string, unknown>).sessions as AttachSessions | undefined;
  if (!sessions) throw new ManagedCopilotError("capability_unavailable", "The sessions service is not available on this gateway");
  return sessions;
}

function actionsOf(app: GatewayApp): AttachActions | undefined {
  return (app.services as Record<string, unknown>).actions as AttachActions | undefined;
}

function moving(sessionId: string): ManagedCopilotError {
  return new ManagedCopilotError("session_busy", "This session is moving into a sandbox. Attach again when the move finishes.", { sessionId });
}

function assertAttachable(info: SessionInfo): void {
  if (info.state === "promoting") throw moving(info.id);
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
    const ledgerWaitMs = setting(app, "MANAGED_COPILOT_ATTACH_LEDGER_WAIT_MS", LEDGER_WAIT_MS);
    const tickets = new AttachTickets(app.db);
    const hosts = new AhpHosts(log, idleMs);
    const socketBase = app.config.publicUrl.replace(/^http/i, "ws");
    // Built on first use, once the data directory exists, so its resolved form (8.3 names, links) is covered too.
    let scrubber: ((value: unknown) => unknown) | undefined;
    const scrub = (value: unknown) => (scrubber ??= uriAwareScrubber(pathScrubber(app.config.dataDir)))(value);
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

    /** For CLI writes that start no work: the same incarnation, placement generation, and no fence. */
    const gateFor = (sessionId: string, attachment: CliAttachment) => () => {
      if (hosts.isFenced(sessionId)) throw moving(sessionId);
      const record = sessionsOf(app).get?.(sessionId);
      if (!record || record.incarnation !== attachment.incarnation) throw new ManagedCopilotError("not_found", "This session no longer exists.", { sessionId });
      if (record.state === "promoting") throw moving(sessionId);
      if (record.generation !== attachment.generation) throw new ManagedCopilotError("conflict", "The session moved since Copilot CLI attached. Reconnecting.", { sessionId });
    };

    app.routes.post("/v1/sessions/:id/attach", async (ctx) => {
      const principal = ctx.principal;
      const sessionId = ctx.params.id;
      if (!principal || !sessionId) throw new ManagedCopilotError("authentication_required", "Sign in to attach to a session");
      const host = await hosts.ensure(sessionId, currentRuntime(principal.accountId, sessionId));
      const incarnation = sessionsOf(app).get?.(sessionId)?.incarnation;
      // The principal stays in memory with the ticket: the attached CLI is the session's connected credential.
      const { token, expiresAt } = tickets.mint(principal, sessionId, ticketTtlMs, incarnation ? { incarnation } : {});
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
        // Minted before a gateway restart: its requester's credential is gone with it.
        if (!ticket.principal) throw new ManagedCopilotError("authentication_required", "This attach ticket is no longer valid. Request a new one.");
        const sessions = sessionsOf(app);
        if (!sessions.attachCli || !sessions.get) throw new ManagedCopilotError("capability_unavailable", "This gateway can't mediate Copilot CLI attachments.");
        // Any fence while this upgrade waits makes everything it resolved stale.
        const epoch = hosts.epoch(sessionId);
        const host = await hosts.ensure(sessionId, currentRuntime(ticket.accountId, sessionId));
        const stale = () => hosts.isFenced(sessionId) || hosts.epoch(sessionId) !== epoch || host.closed;
        if (stale()) throw moving(sessionId);
        const connectionId = `cli_${randomUUID()}`;
        const attachment = await sessions.attachCli(ticket.accountId, sessionId, { connectionId, notify: () => undefined, principal: ticket.principal });
        let attached = false;
        try {
          if (ticket.incarnation && attachment.incarnation !== ticket.incarnation) {
            throw new ManagedCopilotError("not_found", "This session was replaced since the attach ticket was issued. Attach again.", { sessionId });
          }
          const record = sessions.get(sessionId);
          if (!record || record.incarnation !== attachment.incarnation) throw new ManagedCopilotError("not_found", "This session no longer exists.", { sessionId });
          if (stale()) throw moving(sessionId);
          let upstream: WebSocket;
          try {
            upstream = await openUpstream(host, protocols);
          } catch (error) {
            throw new ManagedCopilotError("capability_unavailable", `Cannot reach this session's Copilot CLI listener: ${(error as Error).message}`);
          }
          if (stale()) {
            upstream.terminate();
            throw moving(sessionId);
          }
          if (socket.destroyed) {
            upstream.terminate();
            return;
          }
          const placement = record.placement === "sandbox" ? "sandbox" : "shared";
          const server = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_CLIENT_FRAME_BYTES, handleProtocols: () => upstream.protocol || false });
          // ws completes or refuses the handshake synchronously, so no fence can come between the check above and
          // `track`, which registers the relay for the next one.
          server.handleUpgrade(req, socket, head, (client) => {
            attached = true;
            const relay = new AhpBridge(client, upstream, { log, sessionId, maxLifetimeMs, ledgerWaitMs, placement, attachment, actions: actionsOf(app), gate: gateFor(sessionId, attachment), scrub });
            if (hosts.track(host, relay)) log.info("Copilot CLI attached", { sessionId, accountId: ticket.accountId, connectionId });
          });
          // A refused handshake leaves nothing to own the upstream.
          if (!attached) upstream.terminate();
        } finally {
          if (!attached) attachment.close();
        }
      },
      { auth: "none" },
    );

    let unsubscribe: (() => void) | undefined;
    let unregisterParticipant: (() => void) | undefined;
    app.onStart(() => {
      const sessions = (app.services as Record<string, unknown>).sessions as AttachSessions | undefined;
      unsubscribe = sessions?.onLifecycle?.((event) => {
        // A move or a stopped runtime ends hosts whose runtime was resolved before it, not one an attach resolves on
        // the new runtime afterwards (a host resolved on the old one but still starting is released too).
        const resolvedBy = event.type === "deleted" ? undefined : hosts.mark();
        void hosts.release(event.sessionId, lifecycleReason(event.type), { ...(resolvedBy !== undefined ? { resolvedBy } : {}), ...(event.type === "promoted" ? { code: ATTACH_CLOSE_CODES.moved } : {}) });
      });
      // Promotion registers after attach, so its participant hook is only available once the gateway starts.
      const promotion = (app.services as Record<string, unknown>).promotion as { participate?(participant: PromotionParticipant): () => void } | undefined;
      unregisterParticipant = promotion?.participate?.({
        name: "Copilot CLI attach",
        fence: (sessionId, signal) => hosts.fence(sessionId, signal),
        release: (sessionId) => hosts.unfence(sessionId),
      });
    });
    app.onStop(async () => {
      unsubscribe?.();
      unregisterParticipant?.();
      await hosts.disposeAll("The Managed Copilot gateway is shutting down.");
    });
  },
};
