/**
 * Policy-enforcing outbound requests made by the gateway on a session's behalf (the `web_fetch` platform tool and
 * the shared-placement MCP adapter). Uses the same destination rules as the egress proxy (`evaluateDestination`),
 * connects only to validated addresses, and verifies TLS against the requested host.
 */
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import type { Readable } from "node:stream";
import { checkServerIdentity, connect as tlsConnect, rootCertificates } from "node:tls";
import { evaluateDestination, isUnresolvableName, parseCidr, type Cidr, type DestinationCheckOptions, type DestinationDecision, type NetworkPolicy } from "@managed-copilot/protocol";

export type Connector = (address: string, port: number) => Socket;

export interface GatewayEgressOptions {
  readonly destination: DestinationCheckOptions;
  /** Test hook: connects to a validated address. Defaults to `net.connect`. */
  readonly connect?: Connector;
  /** Extra CA certificates (PEM) trusted for upstream TLS. */
  readonly extraCa?: readonly string[];
  readonly connectTimeoutMs?: number;
}

export type OutboundResult = { readonly decision: Extract<DestinationDecision, { ok: false }> } | { readonly decision: Extract<DestinationDecision, { ok: true }>; readonly response: IncomingMessage };

function list(value: string | undefined, fallback = ""): string[] {
  return (value ?? fallback)
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Destination settings shared with the egress container (`MANAGED_COPILOT_EGRESS_*`). */
export function egressSettings(env: Readonly<Record<string, string | undefined>>): {
  readonly allowedPorts: number[];
  readonly privateHosts: string[];
  readonly protectedCidrs: string[];
  readonly blockedCidrs: string[];
} {
  return {
    allowedPorts: list(env.MANAGED_COPILOT_EGRESS_ALLOWED_PORTS, "80,443")
      .map(Number)
      .filter((port) => Number.isInteger(port) && port > 0 && port < 65536),
    privateHosts: list(env.MANAGED_COPILOT_EGRESS_PRIVATE_HOSTS).map((host) => host.toLowerCase()),
    protectedCidrs: list(env.MANAGED_COPILOT_EGRESS_PROTECTED_CIDRS, "10.213.0.0/16"),
    blockedCidrs: list(env.MANAGED_COPILOT_EGRESS_BLOCKED_CIDRS),
  };
}

export function destinationOptions(env: Readonly<Record<string, string | undefined>>): DestinationCheckOptions {
  const settings = egressSettings(env);
  const protectedCidrs: Cidr[] = settings.protectedCidrs.map(parseCidr);
  return {
    allowedPorts: new Set(settings.allowedPorts),
    privateHosts: new Set(settings.privateHosts),
    protectedCidrs: () => protectedCidrs,
    blockedCidrs: settings.blockedCidrs.map(parseCidr),
    resolve: async (host) => {
      if (isUnresolvableName(host)) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      return (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
    },
    dnsTimeoutMs: 5_000,
  };
}

export function defaultPort(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
}

/** Resolves when `socket` emits `event`; rejects on an error, an early close, an abort, or after `timeoutMs`. */
function settle(socket: Socket, event: "connect" | "secureConnect", what: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const done = (error?: unknown) => {
      clearTimeout(timer);
      socket.off(event, onEvent).off("error", done).off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onEvent = () => done();
    const onClose = () => done(new Error(`${what} was closed early`));
    const onAbort = () => done(signal?.reason);
    const timer = setTimeout(() => done(new Error(`${what} timed out`)), timeoutMs);
    socket.once(event, onEvent).once("error", done).once("close", onClose);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class GatewayEgress {
  readonly #options: GatewayEgressOptions;
  readonly #roots: string[];

  constructor(options: GatewayEgressOptions) {
    this.#options = options;
    this.#roots = [...rootCertificates, ...(options.extraCa ?? [])];
  }

  evaluate(policy: NetworkPolicy, url: URL): Promise<DestinationDecision> {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return Promise.resolve({ ok: false, reason: "invalid_destination", status: 400, message: `Only http and https URLs are supported, not ${url.protocol}` });
    }
    if (url.username || url.password) {
      return Promise.resolve({ ok: false, reason: "invalid_destination", status: 400, message: "URLs with embedded credentials are not supported" });
    }
    return evaluateDestination(policy, url.hostname, defaultPort(url), this.#options.destination);
  }

  /**
   * Connects to a validated destination; for https, resolves after the certificate verified for the host. Each dial
   * and TLS handshake is bounded by the connect timeout and `signal`. A failed attempt moves on to the next validated
   * address, except a certificate that fails verification, which is reported as is.
   */
  async open(decision: Extract<DestinationDecision, { ok: true }>, url: URL, signal?: AbortSignal): Promise<Socket> {
    const connect = this.#options.connect ?? ((address: string, port: number) => netConnect({ host: address, port }));
    const timeoutMs = this.#options.connectTimeoutMs ?? 10_000;
    const target = `${decision.host}:${decision.port}`;
    let lastError: Error | undefined;
    for (const address of decision.addresses) {
      signal?.throwIfAborted();
      const socket = connect(address, decision.port);
      try {
        await settle(socket, "connect", `Connection to ${target}`, timeoutMs, signal);
      } catch (error) {
        socket.destroy();
        if (signal?.aborted) throw error;
        lastError = error as Error;
        continue;
      }
      if (url.protocol !== "https:") return socket;
      const tls = tlsConnect({
        socket,
        servername: decision.ipLiteral ? undefined : decision.host,
        ca: this.#roots,
        ALPNProtocols: ["http/1.1"],
        checkServerIdentity: (_name, certificate) => checkServerIdentity(decision.host, certificate),
      });
      try {
        await settle(tls, "secureConnect", `TLS handshake with ${target}`, timeoutMs, signal);
      } catch (error) {
        tls.destroy();
        socket.destroy();
        if (signal?.aborted || tls.authorizationError) throw error;
        lastError = error as Error;
        continue;
      }
      return tls;
    }
    throw lastError ?? new Error(`Could not connect to ${decision.host}`);
  }

  /** One request (no redirects) to a destination the session's policy allows. */
  async request(
    policy: NetworkPolicy,
    url: URL,
    init: { readonly method?: string; readonly headers?: OutgoingHttpHeaders; readonly body?: Readable | Buffer; readonly signal?: AbortSignal } = {},
  ): Promise<OutboundResult> {
    const decision = await this.evaluate(policy, url);
    if (!decision.ok) return { decision };
    const socket = await this.open(decision, url, init.signal);
    return await new Promise<OutboundResult>((resolve, reject) => {
      const req = httpRequest({
        method: init.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        headers: { ...init.headers, host: url.host },
        setHost: false,
        createConnection: () => socket,
        ...(init.signal ? { signal: init.signal } : {}),
      });
      req.on("response", (response) => resolve({ decision, response }));
      req.on("error", (error) => {
        socket.destroy();
        reject(error);
      });
      if (init.body === undefined) req.end();
      else if (Buffer.isBuffer(init.body)) req.end(init.body);
      else init.body.pipe(req);
    });
  }
}
