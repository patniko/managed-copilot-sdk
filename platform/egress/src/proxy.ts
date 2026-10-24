/**
 * The egress proxy: an authenticated HTTP forward proxy and CONNECT tunnel endpoint for sandboxes (spec sections 7
 * and 8). Every connection is attributed to one sandbox registration, checked against that session's effective
 * policy and the platform protections after DNS resolution, and connected to the validated address only. CONNECT
 * tunnels must carry TLS whose server name matches the authorized host. Tunnels to a session's vault hosts are
 * terminated with the platform CA so placeholders can be substituted in their named headers.
 */
import { once } from "node:events";
import { createServer, request as httpRequest, STATUS_CODES, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { Transform, type Duplex } from "node:stream";
import { checkServerIdentity, connect as tlsConnect, rootCertificates, TLSSocket } from "node:tls";
import { normalizeDestinationHost, type EgressBlockReason, type EgressRegistration } from "@managed-copilot/protocol";
import { dialValidated, evaluateDestination, systemDialer, type Decision, type DestinationOptions, type Dialer } from "./destination.js";
import { SecretUnavailableError, type Reporter, type SecretResolver } from "./gateway-link.js";
import type { Logger } from "./log.js";
import type { Registry } from "./registry.js";
import { readClientHello } from "./sni.js";
import { applySubstitution, mentionsPlaceholder, planSubstitution, redactText } from "./substitute.js";
import type { CertificateAuthority } from "./x509.js";

export interface ProxyOptions {
  readonly registry: Registry;
  readonly secrets: SecretResolver;
  readonly reporter: Reporter;
  readonly ca: CertificateAuthority;
  readonly destination: DestinationOptions;
  /** Connects to a validated address. Tests replace it; production uses `net.connect`. */
  readonly dial?: Dialer;
  /** Extra CA certificates (PEM) trusted for upstream TLS, in addition to Node's bundled roots. */
  readonly upstreamCa?: readonly string[];
  readonly connectTimeoutMs?: number;
  readonly helloTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly log: Logger;
}

interface TerminatedConnection {
  readonly sandboxId: string;
  readonly sessionId: string;
  readonly credentialHash: string;
  readonly host: string;
  readonly port: number;
  readonly addresses: readonly string[];
  readonly onRequest: () => void;
}

const PROXY_AUTHENTICATE = 'Basic realm="Managed Copilot egress"';
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);
const PREFIX = "Managed Copilot egress:";

/** Parses `host:port` (port required unless `defaultPort` is given); IPv6 hosts are bracketed. */
export function parseAuthority(authority: string, defaultPort?: number): { readonly host: string; readonly port: number } | undefined {
  const match = /^(\[[0-9a-fA-F:.]+\]|[^:[\]/\s@]+)(?::(\d{1,5}))?$/.exec(authority.trim());
  if (!match) return undefined;
  const port = match[2] !== undefined ? Number(match[2]) : defaultPort;
  if (port === undefined || !(port >= 1 && port <= 65535)) return undefined;
  return { host: match[1]!, port };
}

function filterHeaders(raw: readonly string[], drop: ReadonlySet<string> = new Set()): string[] {
  const listed = new Set<string>();
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() === "connection") for (const token of raw[i + 1]!.split(",")) listed.add(token.trim().toLowerCase());
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i]!.toLowerCase();
    if (HOP_BY_HOP.has(name) || listed.has(name) || drop.has(name)) continue;
    out.push(raw[i]!, raw[i + 1] ?? "");
  }
  return out;
}

function setRawHeader(raw: readonly string[], name: string, value: string): string[] {
  const out = filterHeaders(raw, new Set([name.toLowerCase()]));
  out.push(name, value);
  return out;
}

function phrase(status: number, message: string): string {
  const base = STATUS_CODES[status] ?? "Error";
  const detail = message.replace(/[^\x20-\x7e]/g, " ").slice(0, 180);
  return status === 407 ? base : `${base} - ${detail}`;
}

function writeConnectFailure(socket: Duplex, status: number, message: string): void {
  const body = `${PREFIX} ${message}\n`;
  const headers = [
    `HTTP/1.1 ${status} ${phrase(status, message)}`,
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    `X-Managed-Copilot-Egress: ${status >= 500 ? "error" : "blocked"}`,
    ...(status === 407 ? [`Proxy-Authenticate: ${PROXY_AUTHENTICATE}`] : []),
    "Connection: close",
  ];
  socket.end(`${headers.join("\r\n")}\r\n\r\n${body}`);
  // CONNECT sockets allow half-open connections; do not wait forever for the client to hang up.
  setTimeout(() => socket.destroy(), 5_000).unref();
}

function sendText(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = `${PREFIX} ${message}\n`;
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "x-managed-copilot-egress": status >= 500 ? "error" : "blocked",
    ...(status === 407 ? { "proxy-authenticate": PROXY_AUTHENTICATE } : {}),
    connection: "close",
  });
  res.end(body);
}

function pathOnly(target: string): string {
  const index = target.search(/[?#]/);
  return (index < 0 ? target : target.slice(0, index)).slice(0, 512);
}

function isClientTrustRejection(error: NodeJS.ErrnoException): boolean {
  return /ALERT_(UNKNOWN_CA|BAD_CERTIFICATE|CERTIFICATE_UNKNOWN|DECRYPT_ERROR|ACCESS_DENIED)/i.test(error.code ?? "") || /alert (unknown ca|bad certificate|certificate unknown)/i.test(error.message);
}

function isCertificateError(error: NodeJS.ErrnoException): boolean {
  return /CERT|SIGNATURE|ALTNAME|ISSUER|SELF_SIGNED/i.test(error.code ?? "");
}

/**
 * Streams a body while replacing any secret value with `[redacted]`, including values split across chunks. It holds
 * back only a tail that could still grow into a secret, so streamed responses (server-sent events, MCP) are not
 * delayed.
 */
export function redactingStream(secrets: readonly string[]): Transform {
  const needles = secrets.filter((secret) => secret.length >= 4).map((secret) => Buffer.from(secret, "utf8"));
  const marker = Buffer.from("[redacted]");
  const replace = (data: Buffer): Buffer => {
    let out: Buffer = data;
    for (const needle of needles) {
      const parts: Buffer[] = [];
      let start = 0;
      for (let index = out.indexOf(needle); index >= 0; index = out.indexOf(needle, start)) {
        parts.push(out.subarray(start, index), marker);
        start = index + needle.length;
      }
      if (parts.length > 0) {
        parts.push(out.subarray(start));
        out = Buffer.concat(parts);
      }
    }
    return out;
  };
  /** Length of the longest suffix of `data` that is the beginning of a secret. */
  const pending = (data: Buffer): number => {
    let longest = 0;
    for (const needle of needles) {
      for (let length = Math.min(needle.length - 1, data.length); length > longest; length--) {
        if (data.subarray(data.length - length).equals(needle.subarray(0, length))) {
          longest = length;
          break;
        }
      }
    }
    return longest;
  };
  let carry: Buffer = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const data = replace(carry.length === 0 ? chunk : Buffer.concat([carry, chunk]));
      const hold = pending(data);
      carry = Buffer.from(data.subarray(data.length - hold));
      callback(null, data.subarray(0, data.length - hold));
    },
    flush(callback) {
      callback(null, replace(carry));
    },
  });
}

export class EgressProxy {
  readonly server: Server;
  readonly #options: ProxyOptions;
  readonly #dial: Dialer;
  readonly #termination: Server;
  readonly #terminated = new WeakMap<object, TerminatedConnection>();
  readonly #upstreamRoots: string[];
  readonly #connectTimeoutMs: number;
  readonly #helloTimeoutMs: number;
  readonly #idleTimeoutMs: number;
  readonly #sockets = new Set<Socket>();

  constructor(options: ProxyOptions) {
    this.#options = options;
    this.#dial = options.dial ?? systemDialer;
    this.#upstreamRoots = [...rootCertificates, ...(options.upstreamCa ?? [])];
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.#helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 15 * 60_000;
    this.server = createServer({ requestTimeout: 0, headersTimeout: 30_000, keepAliveTimeout: 5_000, maxHeaderSize: 32 * 1024 }, (req, res) => {
      void this.#onRequest(req, res).catch((error) => this.#fail(res, error));
    });
    this.server.on("connect", (req: IncomingMessage, socket: Socket, head: Buffer) => {
      void this.#onConnect(req, socket, head).catch((error) => {
        options.log.error("CONNECT handling failed", { error: (error as Error).message });
        socket.destroy();
      });
    });
    this.server.on("upgrade", (_req: IncomingMessage, socket: Socket) => {
      writeConnectFailure(socket, 501, "Upgrading plain HTTP requests (ws://) through the proxy is not supported. Use wss://, which tunnels with CONNECT.");
    });
    this.server.on("clientError", (_error, socket) => socket.destroy());
    this.server.on("connection", (socket: Socket) => {
      this.#sockets.add(socket);
      socket.once("close", () => this.#sockets.delete(socket));
    });
    this.#termination = createServer({ requestTimeout: 0, headersTimeout: 30_000, keepAliveTimeout: 5_000, maxHeaderSize: 32 * 1024 }, (req, res) => {
      void this.#onTerminatedRequest(req, res).catch((error) => this.#fail(res, error));
    });
    this.#termination.on("upgrade", (_req: IncomingMessage, socket: Duplex) => {
      writeConnectFailure(socket, 501, "Protocol upgrades (WebSockets) to vault hosts are not supported; the vault credential was not sent.");
    });
    this.#termination.on("connect", (_req: IncomingMessage, socket: Duplex) => {
      writeConnectFailure(socket, 400, "Nested CONNECT requests are not supported.");
    });
    this.#termination.on("clientError", (_error, socket) => socket.destroy());
  }

  async listen(port: number, host = "0.0.0.0"): Promise<AddressInfo> {
    this.server.listen(port, host);
    await once(this.server, "listening");
    return this.server.address() as AddressInfo;
  }

  async close(): Promise<void> {
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections();
    this.#termination.closeAllConnections();
    // CONNECT tunnels leave the HTTP server's bookkeeping, so close every accepted socket explicitly.
    for (const socket of this.#sockets) socket.destroy();
    await closed;
  }

  #fail(res: ServerResponse, error: unknown): void {
    this.#options.log.error("Request handling failed", { error: (error as Error)?.message ?? String(error) });
    sendText(res, 500, "The egress proxy failed while handling this request.");
  }

  #report(registration: EgressRegistration, reason: EgressBlockReason, message: string, target: { host?: string; port?: number; method?: string; path?: string }): void {
    this.#options.log.info("Blocked egress", { sandboxId: registration.sandboxId, sessionId: registration.sessionId, reason, host: target.host, port: target.port, method: target.method, path: target.path });
    this.#options.reporter.report({
      sandboxId: registration.sandboxId,
      sessionId: registration.sessionId,
      at: new Date().toISOString(),
      reason,
      message,
      ...(target.host !== undefined ? { host: target.host } : {}),
      ...(target.port !== undefined ? { port: target.port } : {}),
      ...(target.method !== undefined ? { method: target.method } : {}),
      ...(target.path !== undefined ? { path: target.path } : {}),
    });
  }

  #reportDecision(registration: EgressRegistration, decision: Extract<Decision, { ok: false }>, method: string, path?: string): void {
    if (decision.reason === "dns_failed") return;
    this.#report(registration, decision.reason, decision.message, { host: decision.host, port: decision.port, method, ...(path !== undefined ? { path } : {}) });
  }

  // --- Local endpoints -------------------------------------------------------------------------------------------

  #local(req: IncomingMessage, res: ServerResponse): void {
    const path = pathOnly(req.url ?? "/");
    if (req.method === "GET" && path === "/healthz") {
      const body = JSON.stringify({ status: "ok", ready: this.#options.registry.ready, sandboxes: this.#options.registry.size });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (req.method === "GET" && path === "/ca.pem") {
      res.writeHead(200, { "content-type": "application/x-pem-file", "content-length": Buffer.byteLength(this.#options.ca.certPem) });
      res.end(this.#options.ca.certPem);
      return;
    }
    sendText(res, 404, "This is the Managed Copilot egress proxy. Use it through the HTTP_PROXY and HTTPS_PROXY settings the platform provides.");
  }

  // --- Plain HTTP forward proxying ---------------------------------------------------------------------------------

  async #onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = req.url ?? "/";
    if (target.startsWith("/")) {
      this.#local(req, res);
      return;
    }
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      sendText(res, 400, "The request target is not a valid URL.");
      return;
    }
    if (url.protocol !== "http:") {
      sendText(res, 400, `${url.protocol}// requests must be tunneled with CONNECT (set HTTPS_PROXY).`);
      return;
    }
    const auth = this.#options.registry.authenticate(req.headers["proxy-authorization"], req.socket.remoteAddress);
    if (!auth.ok) {
      sendText(res, auth.status, auth.message);
      return;
    }
    const registration = auth.registration;
    const port = url.port ? Number(url.port) : 80;
    const method = req.method ?? "GET";
    const path = pathOnly(url.pathname);
    if (mentionsPlaceholder(target, req.rawHeaders)) {
      const message = "Vault credentials are only substituted in HTTPS requests to their configured hosts. This plain HTTP request was not sent.";
      this.#report(registration, "credential_misuse", message, { host: url.hostname, port, method, path });
      sendText(res, 403, message);
      return;
    }
    // The client can hang up while DNS resolution and the dial are in flight; a "close" emitted then is not repeated.
    let gone = false;
    res.once("close", () => {
      gone = true;
    });
    const decision = await evaluateDestination(registration.policy, url.hostname, port, this.#options.destination);
    if (gone) return;
    if (!decision.ok) {
      this.#reportDecision(registration, decision, method, path);
      sendText(res, decision.status, decision.message);
      return;
    }
    const current = this.#options.registry.check(registration.sandboxId, registration.credentialHash, decision.host, decision.ipLiteral);
    if (!current.ok) {
      sendText(res, current.status, current.message);
      return;
    }
    let upstreamSocket: Socket;
    try {
      upstreamSocket = await dialValidated(decision.addresses, port, this.#dial, this.#connectTimeoutMs);
    } catch (error) {
      if (!gone) sendText(res, 502, `Could not connect to ${decision.host}:${port}: ${(error as Error).message}`);
      return;
    }
    if (gone) {
      upstreamSocket.destroy();
      return;
    }
    const tracked = this.#options.registry.track(registration.sandboxId, {
      host: decision.host,
      ipLiteral: decision.ipLiteral,
      credentialHash: registration.credentialHash,
      close: () => {
        upstreamSocket.destroy();
        res.destroy();
      },
    });
    if (!tracked.ok) {
      upstreamSocket.destroy();
      sendText(res, tracked.status, tracked.message);
      return;
    }
    res.once("close", () => {
      tracked.untrack();
      upstreamSocket.destroy();
    });
    const headers = filterHeaders(req.rawHeaders, new Set(["host", "expect"]));
    headers.unshift("Host", url.host);
    const upstream = httpRequest({ method, path: `${url.pathname}${url.search}`, headers, setHost: false, createConnection: () => upstreamSocket });
    upstream.setTimeout(this.#idleTimeoutMs, () => upstream.destroy(new Error("The upstream server timed out")));
    upstream.on("response", (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, filterHeaders(upstreamRes.rawHeaders));
      upstreamRes.pipe(res);
    });
    upstream.on("error", (error) => sendText(res, 502, `The request to ${decision.host} failed: ${error.message}`));
    req.pipe(upstream);
  }

  // --- CONNECT ---------------------------------------------------------------------------------------------------

  async #onConnect(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    socket.on("error", () => undefined);
    const auth = this.#options.registry.authenticate(req.headers["proxy-authorization"], socket.remoteAddress);
    if (!auth.ok) {
      writeConnectFailure(socket, auth.status, auth.message);
      return;
    }
    const registration = auth.registration;
    const authority = parseAuthority(req.url ?? "");
    if (!authority) {
      const message = `"${(req.url ?? "").slice(0, 100)}" is not a valid CONNECT target; use host:port.`;
      this.#report(registration, "invalid_destination", message, { method: "CONNECT" });
      writeConnectFailure(socket, 400, message);
      return;
    }
    const decision = await evaluateDestination(registration.policy, authority.host, authority.port, this.#options.destination);
    if (socket.destroyed) return;
    if (!decision.ok) {
      this.#reportDecision(registration, decision, "CONNECT");
      writeConnectFailure(socket, decision.status, decision.message);
      return;
    }
    const current = this.#options.registry.check(registration.sandboxId, registration.credentialHash, decision.host, decision.ipLiteral);
    if (!current.ok) {
      writeConnectFailure(socket, current.status, current.message);
      return;
    }
    const vaultHost = !decision.ipLiteral && current.registration.credentials.some((credential) => credential.destinations.some((d) => d.host === decision.host && d.port === decision.port));
    if (vaultHost) await this.#terminate(socket, head, current.registration, decision);
    else await this.#tunnel(socket, head, current.registration, decision);
  }

  async #tunnel(socket: Socket, head: Buffer, registration: EgressRegistration, decision: Extract<Decision, { ok: true }>): Promise<void> {
    let upstream: Socket;
    try {
      upstream = await dialValidated(decision.addresses, decision.port, this.#dial, this.#connectTimeoutMs);
    } catch (error) {
      writeConnectFailure(socket, 502, `Could not connect to ${decision.host}:${decision.port}: ${(error as Error).message}`);
      return;
    }
    if (socket.destroyed) {
      upstream.destroy();
      return;
    }
    let closed = false;
    let untrack: (() => void) | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      untrack?.();
      socket.destroy();
      upstream.destroy();
    };
    const tracked = this.#options.registry.track(registration.sandboxId, { host: decision.host, ipLiteral: decision.ipLiteral, credentialHash: registration.credentialHash, close });
    if (!tracked.ok) {
      upstream.destroy();
      writeConnectFailure(socket, tracked.status, tracked.message);
      return;
    }
    untrack = tracked.untrack;
    socket.once("close", close);
    upstream.once("close", close);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const { result, data } = await readClientHello(socket, head, { timeoutMs: this.#helloTimeoutMs });
    if (closed) return;
    if (result.kind !== "tls") {
      if (data.length > 0) {
        this.#report(registration, "non_tls_tunnel", `The tunnel to ${decision.host}:${decision.port} did not start with a TLS handshake; CONNECT tunnels must carry TLS.`, {
          host: decision.host,
          port: decision.port,
          method: "CONNECT",
        });
      }
      close();
      return;
    }
    if (!decision.ipLiteral) {
      const serverName = result.serverName === undefined ? undefined : normalizeDestinationHost(result.serverName)?.host;
      if (serverName !== decision.host) {
        this.#report(registration, "sni_mismatch", `The TLS server name ${serverName ?? "(none)"} does not match the authorized host ${decision.host}.`, {
          host: decision.host,
          port: decision.port,
          method: "CONNECT",
        });
        close();
        return;
      }
    }
    socket.setTimeout(this.#idleTimeoutMs, close);
    upstream.setTimeout(this.#idleTimeoutMs, close);
    upstream.write(data);
    socket.pipe(upstream);
    upstream.pipe(socket);
  }

  // --- Vault TLS termination -------------------------------------------------------------------------------------

  async #terminate(socket: Socket, head: Buffer, registration: EgressRegistration, decision: Extract<Decision, { ok: true }>): Promise<void> {
    let closed = false;
    let revoked = false;
    let tlsSocket: TLSSocket | undefined;
    let untrack: (() => void) | undefined;
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      if (handshakeTimer) clearTimeout(handshakeTimer);
      untrack?.();
      tlsSocket?.destroy();
      socket.destroy();
    };
    const revoke = () => {
      revoked = true;
      close();
    };
    const tracked = this.#options.registry.track(registration.sandboxId, { host: decision.host, ipLiteral: false, credentialHash: registration.credentialHash, close: revoke });
    if (!tracked.ok) {
      writeConnectFailure(socket, tracked.status, tracked.message);
      return;
    }
    untrack = tracked.untrack;
    socket.once("close", close);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const target = { host: decision.host, port: decision.port, method: "CONNECT" };
    // Check the ClientHello before presenting any certificate: OpenSSL only consults SNICallback when the client sends
    // a server name, so a client without SNI would otherwise get a vault host certificate.
    const { result, data } = await readClientHello(socket, head, { timeoutMs: this.#helloTimeoutMs });
    if (closed) return;
    if (result.kind !== "tls") {
      if (data.length > 0) {
        this.#report(registration, "non_tls_tunnel", `The tunnel to ${decision.host}:${decision.port} did not start with a TLS handshake; CONNECT tunnels must carry TLS.`, target);
      }
      close();
      return;
    }
    const helloName = result.serverName === undefined ? undefined : normalizeDestinationHost(result.serverName)?.host;
    if (helloName !== decision.host) {
      this.#report(registration, "sni_mismatch", `The TLS server name ${helloName ?? "(none)"} does not match the authorized host ${decision.host}.`, target);
      close();
      return;
    }
    // TLSSocket feeds bytes already buffered on the socket to the TLS engine before reading from its handle.
    socket.unshift(data);
    const context = this.#options.ca.contextFor(decision.host);
    let mismatchedName: string | undefined;
    tlsSocket = new TLSSocket(socket, {
      isServer: true,
      secureContext: context,
      ALPNProtocols: ["http/1.1"],
      SNICallback: (servername, callback) => {
        if (normalizeDestinationHost(servername)?.host === decision.host) {
          callback(null, context);
        } else {
          mismatchedName = servername.slice(0, 253);
          callback(new Error("The TLS server name does not match the authorized host"), undefined);
        }
      },
    });
    let secured = false;
    let securedAt = 0;
    let requested = false;
    let reported = false;
    const untrusted = (message: string) => {
      if (reported) return;
      reported = true;
      this.#report(registration, "tls_client_untrusted", message, target);
    };
    handshakeTimer = setTimeout(() => {
      if (!secured) close();
    }, this.#helloTimeoutMs);
    handshakeTimer.unref?.();
    tlsSocket.once("secure", () => {
      const servername = typeof tlsSocket!.servername === "string" ? normalizeDestinationHost(tlsSocket!.servername)?.host : undefined;
      if (servername !== decision.host) {
        reported = true;
        this.#report(registration, "sni_mismatch", `The TLS server name ${servername ?? "(none)"} does not match the authorized host ${decision.host}.`, target);
        close();
        return;
      }
      secured = true;
      securedAt = Date.now();
      if (handshakeTimer) clearTimeout(handshakeTimer);
      this.#terminated.set(tlsSocket!, {
        sandboxId: registration.sandboxId,
        sessionId: registration.sessionId,
        credentialHash: registration.credentialHash,
        host: decision.host,
        port: decision.port,
        addresses: decision.addresses,
        onRequest: () => {
          requested = true;
        },
      });
      this.#termination.emit("connection", tlsSocket);
    });
    tlsSocket.on("error", (error: NodeJS.ErrnoException) => {
      if (!secured && !reported) {
        if (mismatchedName !== undefined) {
          reported = true;
          this.#report(registration, "sni_mismatch", `The TLS server name ${mismatchedName} does not match the authorized host ${decision.host}.`, target);
        } else if (isClientTrustRejection(error)) {
          untrusted(
            `A client in this sandbox rejected the platform CA certificate for ${decision.host}, so its vault credential could not be used. Trust the CA the platform installed; clients that pin certificates are not supported.`,
          );
        }
      }
      close();
    });
    tlsSocket.once("close", () => {
      // Clients that verify certificates outside the TLS library (Node, for example) hang up without a TLS alert.
      if (revoked) {
        close();
        return;
      }
      if (!secured && socket.bytesRead > 0) {
        untrusted(
          `A client in this sandbox abandoned the TLS handshake with ${decision.host}. It probably does not trust the platform CA certificate (or pins certificates), so its vault credential could not be used.`,
        );
      } else if (secured && !requested && Date.now() - securedAt < 5_000) {
        untrusted(
          `A client in this sandbox closed its connection to ${decision.host} right after the TLS handshake without sending a request. It probably does not trust the platform CA certificate (or pins certificates), so its vault credential could not be used.`,
        );
      }
      close();
    });
    // CONNECT sockets allow half-open connections; a client that hangs up mid-handshake only sends FIN.
    tlsSocket.once("end", () => {
      if (!secured) tlsSocket?.destroy();
    });
    tlsSocket.setTimeout(this.#idleTimeoutMs, close);
  }

  async #onTerminatedRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const connection = this.#terminated.get(req.socket);
    if (!connection) {
      res.destroy();
      return;
    }
    connection.onRequest();
    const method = req.method ?? "GET";
    const host = connection.host;
    const port = connection.port;
    // A "close" emitted while this handler awaits the gateway or the upstream is not repeated, so note it now.
    let gone = false;
    res.once("close", () => {
      gone = true;
    });
    if (!this.#options.registry.ready) {
      sendText(res, 503, "The egress proxy cannot reach the Managed Copilot gateway, so outbound access is paused.");
      return;
    }
    const registration = this.#options.registry.get(connection.sandboxId);
    if (!registration || registration.credentialHash !== connection.credentialHash) {
      sendText(res, 403, "This sandbox's egress registration is no longer active.");
      return;
    }
    let path = req.url ?? "/";
    const report = (reason: EgressBlockReason, message: string, status: number) => {
      this.#report(registration, reason, message, { host, port, method, path: pathOnly(path) });
      sendText(res, status, message);
    };
    if (!this.#options.registry.allows(registration, host, false)) {
      report("host_not_allowed", `${host} is no longer an allowed host for this session.`, 403);
      return;
    }
    const authority = parseAuthority(req.headers.host ?? "", 443);
    if (!authority || normalizeDestinationHost(authority.host)?.host !== host || authority.port !== port) {
      report("authority_mismatch", `This connection is authorized for ${port === 443 ? host : `${host}:${port}`}; requests for "${(req.headers.host ?? "").slice(0, 100)}" need their own connection.`, 421);
      return;
    }
    if (!path.startsWith("/")) {
      let absolute: URL | undefined;
      try {
        absolute = new URL(path);
      } catch {
        absolute = undefined;
      }
      if (!absolute || absolute.protocol !== "https:" || normalizeDestinationHost(absolute.hostname)?.host !== host || Number(absolute.port || 443) !== port) {
        report("authority_mismatch", "The request target does not match the authorized host.", 421);
        return;
      }
      path = `${absolute.pathname}${absolute.search}`;
    }
    const plan = planSubstitution(registration, host, port, path, req.rawHeaders);
    if (!plan.ok) {
      report("credential_misuse", plan.message, 403);
      return;
    }
    const values = new Map<string, string>();
    for (const use of plan.uses) {
      if (values.has(use.placeholder)) continue;
      try {
        const value = await this.#options.secrets.resolveSecret({
          sandboxId: registration.sandboxId,
          credentialId: use.credential.id,
          placeholder: use.placeholder,
          host,
          port,
          header: use.header,
        });
        if (/[\r\n\0]/.test(value)) throw new SecretUnavailableError("credential_revoked", "The vault credential contains characters that are not valid in an HTTP header.");
        values.set(use.placeholder, value);
      } catch (error) {
        if (gone) return;
        const reason = error instanceof SecretUnavailableError ? error.reason : "policy_unavailable";
        report(reason, (error as Error).message, reason === "credential_revoked" ? 403 : 503);
        return;
      }
    }
    // The registration can be revoked, rotated, or narrowed (including its vault bindings) while the gateway resolves
    // secrets or the upstream connects; check again, synchronously, before anything is sent.
    const stillAuthorized = (): boolean => {
      if (gone) return false;
      const current = this.#options.registry.check(connection.sandboxId, connection.credentialHash, host, false);
      if (!current.ok) {
        sendText(res, current.status, current.message);
        return false;
      }
      const replanned = planSubstitution(current.registration, host, port, path, req.rawHeaders);
      if (!replanned.ok || replanned.uses.some((use) => !values.has(use.placeholder))) {
        report("credential_revoked", "A vault credential this request uses was revoked while the request was being prepared; it was not sent.", 403);
        return false;
      }
      return true;
    };
    if (!stillAuthorized()) return;
    const secrets = [...values.values()];
    // Exactly one Host header, the authority this connection was authorized for: a second Host could steer a shared
    // front end (CDN) to another virtual host after the credential was substituted.
    let headers = filterHeaders(applySubstitution(req.rawHeaders, values), new Set(["expect", "host"]));
    headers.unshift("Host", port === 443 ? host : `${host}:${port}`);
    if (secrets.length > 0) headers = setRawHeader(headers, "Accept-Encoding", "identity");

    let raw: Socket;
    try {
      raw = await dialValidated(connection.addresses, port, this.#dial, this.#connectTimeoutMs);
    } catch (error) {
      if (!gone) sendText(res, 502, `Could not connect to ${host}:${port}: ${(error as Error).message}`);
      return;
    }
    if (gone) {
      raw.destroy();
      return;
    }
    const upstreamTls = tlsConnect({
      socket: raw,
      servername: host,
      ca: this.#upstreamRoots,
      ALPNProtocols: ["http/1.1"],
      checkServerIdentity: (_name, certificate) => checkServerIdentity(host, certificate),
    });
    upstreamTls.on("error", () => undefined);
    res.once("close", () => upstreamTls.destroy());
    const handshake = new AbortController();
    const deadline = setTimeout(() => handshake.abort(), this.#connectTimeoutMs);
    const abandon = () => handshake.abort();
    res.once("close", abandon);
    try {
      // Nothing, and certainly no secret, is written before the upstream certificate verifies for `host`.
      await once(upstreamTls, "secureConnect", { signal: handshake.signal });
    } catch (error) {
      upstreamTls.destroy();
      raw.destroy();
      if (gone) return;
      const failure = error as NodeJS.ErrnoException;
      if (handshake.signal.aborted) {
        sendText(res, 504, `The TLS handshake with ${host}:${port} did not complete in time; the request was not sent.`);
      } else if (isCertificateError(failure)) {
        report("upstream_tls_failed", `The certificate presented by ${host} could not be verified (${failure.code ?? failure.message}); the request was not sent.`, 502);
      } else {
        sendText(res, 502, `TLS connection to ${host}:${port} failed: ${failure.message}`);
      }
      return;
    } finally {
      clearTimeout(deadline);
      res.off("close", abandon);
    }
    if (!stillAuthorized()) {
      upstreamTls.destroy();
      return;
    }
    const upstream = httpsRequest({ method, path, headers, setHost: false, createConnection: () => upstreamTls });
    upstream.setTimeout(this.#idleTimeoutMs, () => upstream.destroy(new Error("The upstream server timed out")));
    upstream.on("response", (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502;
      const encoding = String(upstreamRes.headers["content-encoding"] ?? "identity").toLowerCase();
      const redactBody = secrets.length > 0 && encoding === "identity" && method !== "HEAD" && status !== 204 && status !== 304;
      const responseHeaders = filterHeaders(upstreamRes.rawHeaders, redactBody ? new Set(["content-length"]) : new Set()).map((value, index) => (index % 2 === 1 && secrets.length > 0 ? redactText(value, secrets) : value));
      res.writeHead(status, upstreamRes.statusMessage, responseHeaders);
      (redactBody ? upstreamRes.pipe(redactingStream(secrets)) : upstreamRes).pipe(res);
    });
    upstream.on("error", (error) => sendText(res, 502, `The request to ${host} failed: ${error.message}`));
    req.pipe(upstream);
  }
}
