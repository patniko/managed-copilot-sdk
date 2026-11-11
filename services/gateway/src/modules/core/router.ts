// The `/v1/connect` WebSocket JSON-RPC router: one ClientConnection per bridge. Connection-level methods are
// answered by the gateway for the caller; session-scoped methods are routed by `sessionId` after ownership checks;
// everything else is rejected (the supported-operation matrix lives here and in sessions.ts).
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  BRIDGE_CLOSE_CODES,
  BRIDGE_HELLO,
  BRIDGE_MAX_FRAME_BYTES,
  BRIDGE_SUBPROTOCOL,
  BRIDGE_WELCOME,
  ManagedCopilotError,
  type BridgeHello,
  type BridgeWelcome,
  type ErrorCode,
} from "@managed-copilot/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import type { GatewayApp } from "../../app.js";
import type { Principal } from "../../http.js";
import type { Logger } from "../../log.js";
import { assertAppEnvironment, assertAppUserInference } from "./apps.js";
import type { ResolvedEnvironment } from "./contracts.js";
import type { Environments } from "./environments.js";
import { RpcEndpoint, unsupportedMethod, webSocketTransport, type IncomingRequestContext } from "./rpc.js";
import { MAX_PROTOCOL_VERSION, type SharedRuntime } from "./runtime.js";
import type { ClientPeer, SessionManager } from "./sessions.js";

export class ClientConnection implements ClientPeer {
  readonly id = `conn_${randomUUID()}`;
  readonly kind = "sdk" as const;
  readonly connectedAt = new Date().toISOString();
  readonly principal: Principal;
  readonly environment: ResolvedEnvironment;
  readonly clientName: string | undefined;
  readonly #endpoint: RpcEndpoint;
  readonly #manager: SessionManager;
  readonly #runtime: SharedRuntime | undefined;
  readonly #app: GatewayApp;
  readonly #log: Logger;
  readonly #ws: WebSocket;
  #verifiedAt = Date.now();
  #requests = 0;
  #notifications = 0;
  #lastActivity = Date.now();

  constructor(ws: WebSocket, options: { principal: Principal; environment: ResolvedEnvironment; clientName: string | undefined; manager: SessionManager; runtime: SharedRuntime | undefined; app: GatewayApp; log: Logger }) {
    this.#ws = ws;
    this.principal = options.principal;
    this.environment = options.environment;
    this.clientName = options.clientName;
    this.#manager = options.manager;
    this.#runtime = options.runtime;
    this.#app = options.app;
    this.#log = options.log;
    const transport = webSocketTransport(ws, { onInvalid: () => this.#log.debug("Ignoring an invalid client frame", { connection: this.id }) });
    this.#endpoint = new RpcEndpoint(transport, {
      name: `client ${this.id}`,
      onRequest: (method, params, context) => this.#dispatch(method, params, context),
      onNotification: (method) => this.#log.debug("Ignoring client notification", { connection: this.id, method }),
      onError: (error, { method }) => this.#log.error("Client request failed", { connection: this.id, method, error: (error as Error)?.stack ?? String(error) }),
    });
    transport.onClose(() => {
      this.#manager.disconnect(this);
      this.#log.debug("Client disconnected", { connection: this.id, login: this.principal.login });
    });
  }

  get closed(): boolean {
    return this.#endpoint.closed;
  }

  /** Traffic on this connection, for the operator console. */
  get stats(): { readonly requests: number; readonly notifications: number; readonly lastActivityAt: string } {
    return { requests: this.#requests, notifications: this.#notifications, lastActivityAt: new Date(this.#lastActivity).toISOString() };
  }

  notify(method: string, params: unknown): void {
    this.#notifications++;
    this.#lastActivity = Date.now();
    this.#app.metrics.increment("rpc.notifications");
    this.#endpoint.notify(method, params);
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.#endpoint.request(method, params, signal ? { signal } : {});
  }

  close(code = 1000, reason = ""): void {
    if (this.#ws.readyState === this.#ws.OPEN) this.#ws.close(code, reason);
    else this.#endpoint.close();
  }

  async #dispatch(method: string, params: unknown, context: IncomingRequestContext): Promise<unknown> {
    const body = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
    this.#requests++;
    this.#lastActivity = Date.now();
    this.#app.metrics.increment("rpc.requests");
    // Every call re-checks the credential (cached, bounded): revocation stops reads, writes, and answers alike.
    await this.#reverify();
    switch (method) {
      case "connect":
        return { ok: true, protocolVersion: this.#protocolVersion(), version: this.#runtimeVersion(), taskKinds: ["agent", "shell", "client"] };
      case "ping":
        return { message: typeof body["message"] === "string" ? body["message"] : "", timestamp: new Date().toISOString(), protocolVersion: this.#protocolVersion() };
      case "status.get":
        return { version: this.#runtimeVersion(), protocolVersion: this.#protocolVersion() };
      case "auth.getStatus":
        return {
          isAuthenticated: true,
          authType: "token",
          host: "https://github.com",
          login: this.principal.login,
          statusMessage: `Signed in to ${this.#app.config.deployment.name} as ${this.principal.kind === "app-user" ? `${this.principal.login} (a user of the ${this.principal.app} app)` : this.principal.login}`,
        };
      case "models.list":
        return this.#manager.listModels(this);
      case "session.create": {
        const created = await this.#manager.createForClient(this, params);
        // After the response is written: replayed actions must reach a session object that already exists.
        setImmediate(() => void created.after());
        return created.result;
      }
      case "session.resume": {
        const resumed = await this.#manager.resumeForClient(this, params);
        setImmediate(() => void resumed.after());
        return resumed.result;
      }
      case "session.detach":
        return this.#manager.detach(this, body["sessionId"]);
      case "session.list":
        // Through an app, only the sessions within its environments (spec section 2).
        return { sessions: this.#manager.listFor(this.principal).map((record) => metadata(record)) };
      case "session.getMetadata": {
        const record = typeof body["sessionId"] === "string" ? this.#manager.get(body["sessionId"]) : undefined;
        return { session: record && record.ownerId === this.principal.accountId && this.#manager.inAppScope(this.principal, record) ? metadata(record) : undefined };
      }
      case "session.getLastId": {
        const [latest] = this.#manager.list(this.principal.accountId, { environment: this.environment.name, limit: 1 });
        return { sessionId: latest?.id };
      }
      case "session.delete": {
        if (typeof body["sessionId"] !== "string") throw new ManagedCopilotError("invalid_request", "session.delete needs a sessionId");
        this.#manager.assertAppScope(this.principal, body["sessionId"]);
        await this.#manager.delete(this.principal.accountId, body["sessionId"]);
        return { success: true };
      }
      case "runtime.shutdown":
        // The SDK asks its own runtime to exit during client.stop(). The shared runtime is never the caller's:
        // acknowledge, and treat the connection as detaching.
        return {};
      case "session.getForeground":
      case "session.setForeground":
        throw unsupportedMethod(method, "Foreground sessions exist only in the Copilot CLI TUI");
      case "sessionFs.setProvider":
        throw unsupportedMethod(method, "Session filesystems are owned by the platform; client-provided sessionFs is not supported");
      case "llmInference.setProvider":
        throw unsupportedMethod(method, "Model inference is brokered by the platform; client request handlers are not supported");
      case "plugins.builtin.set":
      case "registerExtensionLaunchProvider":
        throw unsupportedMethod(method, "Plugins and extensions are not available through Managed Copilot");
      default:
        if (method.startsWith("session.") && typeof body["sessionId"] === "string") {
          return this.#manager.forwardForClient(this, method, body, context.signal);
        }
        throw unsupportedMethod(method);
    }
  }

  /**
   * Long-lived connections re-verify their credential before privileged calls (cached by the authenticator), so a
   * revoked or expired token stops new work from already-connected clients.
   */
  async #reverify(): Promise<void> {
    if (Date.now() - this.#verifiedAt < REVERIFY_INTERVAL_MS) return;
    try {
      const auth = this.#app.service("auth");
      const principal = auth.reverify ? await auth.reverify(this.principal) : await auth.authenticate(this.principal.token ?? "");
      if (principal.accountId !== this.principal.accountId) throw new ManagedCopilotError("authentication_required", "The connection's credential now belongs to a different account");
      this.#verifiedAt = Date.now();
    } catch (error) {
      if (error instanceof ManagedCopilotError && (error.code === "authentication_required" || error.code === "forbidden")) {
        setTimeout(() => this.close(error.code === "forbidden" ? BRIDGE_CLOSE_CODES.forbidden : BRIDGE_CLOSE_CODES.authenticationRequired, `${error.code}: ${error.message}`.slice(0, 120)), 50);
      }
      throw error;
    }
  }

  #protocolVersion(): number {
    return this.#runtime?.current()?.protocolVersion ?? MAX_PROTOCOL_VERSION;
  }

  #runtimeVersion(): string {
    return this.#runtime?.current()?.version ?? "1.0.109";
  }
}

function metadata(record: { id: string; createdAt: string; updatedAt: string; title?: string }): Record<string, unknown> {
  return { sessionId: record.id, startTime: record.createdAt, modifiedTime: record.updatedAt, ...(record.title ? { summary: record.title } : {}), isRemote: true };
}

export interface ConnectRouterOptions {
  readonly app: GatewayApp;
  readonly log: Logger;
  readonly manager: SessionManager;
  readonly environments: Environments;
  readonly runtime: SharedRuntime | undefined;
}

const HELLO_TIMEOUT_MS = 15_000;
const REVERIFY_INTERVAL_MS = 60_000;

function closeCode(code: ErrorCode): number {
  switch (code) {
    case "authentication_required":
      return BRIDGE_CLOSE_CODES.authenticationRequired;
    case "forbidden":
      return BRIDGE_CLOSE_CODES.forbidden;
    case "environment_not_found":
    case "not_found":
      return BRIDGE_CLOSE_CODES.environmentNotFound;
    case "policy_violation":
    case "invalid_request":
      return BRIDGE_CLOSE_CODES.policyViolation;
    case "capability_unavailable":
      return BRIDGE_CLOSE_CODES.capabilityUnavailable;
    default:
      return BRIDGE_CLOSE_CODES.internal;
  }
}

/** `<code>: <message>`, truncated to the 123-byte WebSocket close-reason limit. */
function closeReason(error: ManagedCopilotError): string {
  let reason = `${error.code}: ${error.message}`;
  while (Buffer.byteLength(reason) > 123) reason = `${reason.slice(0, -2)}…`;
  return reason;
}

/** `WSS /v1/connect`: closes every client connection at shutdown and lists the connected ones (operator console). */
export interface ConnectRoute {
  close(): void;
  connections(): readonly ClientConnection[];
}

/** Registers `WSS /v1/connect`. */
export function registerConnectRoute(options: ConnectRouterOptions, path: string): ConnectRoute {
  const { app, log, manager, environments, runtime } = options;
  const connections = new Set<ClientConnection>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: BRIDGE_MAX_FRAME_BYTES,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has(BRIDGE_SUBPROTOCOL) ? BRIDGE_SUBPROTOCOL : false),
  });

  const welcome = (ws: WebSocket, principal: Principal, raw: string) => {
    let hello: Partial<BridgeHello>;
    try {
      hello = JSON.parse(raw) as Partial<BridgeHello>;
    } catch {
      throw new ManagedCopilotError("invalid_request", "The first frame must be a managed-copilot hello");
    }
    if (hello.type !== BRIDGE_HELLO) throw new ManagedCopilotError("invalid_request", "The first frame must be a managed-copilot hello");
    if (hello.version !== 1) throw new ManagedCopilotError("invalid_request", `Unsupported bridge version ${String(hello.version)}; update @managed-copilot/sdk`);
    const environment = environments.resolve((hello.environment ?? {}) as never);
    // Through an app: only its environments, and for its own users only those that bill to Foundry.
    assertAppEnvironment(app.services.apps, principal, environment.name);
    assertAppUserInference(principal, environment.name, environment.config);
    const clientName = typeof hello.clientName === "string" ? hello.clientName.slice(0, 200) : undefined;
    const connection = new ClientConnection(ws, { principal, environment, clientName, manager, runtime, app, log });
    connections.add(connection);
    app.metrics.increment("connections.opened");
    ws.on("close", () => connections.delete(connection));
    const reply: BridgeWelcome = { type: BRIDGE_WELCOME, connectionId: connection.id, environment: environment.name };
    ws.send(JSON.stringify(reply));
    log.info("Client connected", { connection: connection.id, login: principal.login, environment: environment.name, ...(clientName ? { client: clientName } : {}) });
  };

  app.upgrades.add(path, async (req: IncomingMessage, socket: Duplex, head: Buffer, principal: Principal | undefined) => {
    if (!principal) throw new ManagedCopilotError("authentication_required", "Sign in with a GitHub token");
    await new Promise<void>((resolve) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        resolve();
        const timer = setTimeout(() => ws.close(BRIDGE_CLOSE_CODES.policyViolation, "invalid_request: no hello received"), HELLO_TIMEOUT_MS);
        ws.once("message", (data, isBinary) => {
          clearTimeout(timer);
          try {
            welcome(ws, principal, isBinary ? Buffer.from(data as Buffer).toString("utf8") : data.toString());
          } catch (error) {
            const managed = error instanceof ManagedCopilotError ? error : new ManagedCopilotError("internal", "The gateway could not accept this connection");
            if (managed.code === "internal") log.error("Bridge handshake failed", { error: (error as Error)?.stack ?? String(error) });
            ws.close(closeCode(managed.code), closeReason(managed));
          }
        });
      });
    });
  });
  return {
    close: () => {
      for (const connection of connections) connection.close(1001, "gateway shutting down");
      connections.clear();
      wss.close();
    },
    connections: () => [...connections].filter((connection) => !connection.closed),
  };
}
