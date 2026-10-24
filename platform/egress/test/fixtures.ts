/** Test fixtures: fake DNS, a dialer that maps fake public addresses to local servers, and proxy clients. */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer as createHttpServer, request, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { Dialer, Resolver } from "../src/destination.js";
import { CertificateAuthority, createCaMaterial } from "../src/x509.js";

export const bearer = (token: string) => ["Bearer", token].join(" ");
export const basic = (user: string, secret: string) => `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

export interface EchoRecord {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
}

/** An HTTP(S) echo server: replies with what it received, including the raw Authorization header. */
export function echoHandler(records: EchoRecord[]) {
  return (req: IncomingMessage, res: import("node:http").ServerResponse) => {
    records.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    const body = JSON.stringify({
      method: req.method,
      url: req.url,
      host: req.headers.host,
      authorization: req.headers.authorization ?? null,
      authorizationSha256: req.headers.authorization ? sha256(req.headers.authorization) : null,
      proxyAuthorization: req.headers["proxy-authorization"] ?? null,
      acceptEncoding: req.headers["accept-encoding"] ?? null,
    });
    res.writeHead(200, { "content-type": "application/json", "x-echo-authorization": req.headers.authorization ?? "" });
    res.end(body);
  };
}

export function httpsEcho(ca: CertificateAuthority, host: string, records: EchoRecord[]): Server {
  const issued = ca.issue(host);
  return createHttpsServer({ key: issued.keyPem, cert: issued.certPem }, echoHandler(records));
}

export function httpEcho(records: EchoRecord[]): Server {
  return createHttpServer(echoHandler(records));
}

export function testCa(name = "Upstream Test CA"): CertificateAuthority {
  return new CertificateAuthority(createCaMaterial({ commonName: name }));
}

/** Resolves names from a table; each entry may be a function so tests can change answers between lookups. */
export function tableResolver(table: Record<string, string[] | (() => string[])>, lookups: string[] = []): Resolver {
  return async (host) => {
    lookups.push(host);
    const entry = table[host];
    if (!entry) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return typeof entry === "function" ? entry() : entry;
  };
}

/** Dials only addresses in `routes` (fake public IP:port → local port) and records every attempt. */
export function routedDialer(routes: Map<string, number>, attempts: string[] = []): Dialer {
  return (address, port) => {
    attempts.push(`${address}:${port}`);
    const local = routes.get(`${address}:${port}`);
    if (local === undefined) {
      const socket = netConnect({ host: "127.0.0.1", port: 9 });
      socket.destroy(new Error(`test dialer has no route to ${address}:${port}`));
      return socket;
    }
    return netConnect({ host: "127.0.0.1", port: local });
  };
}

export interface ProxyResponse {
  readonly status: number;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

function collect(res: IncomingMessage): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    res.on("error", reject);
  });
}

/** Plain HTTP request through the forward proxy (absolute-form target). */
export function forward(proxyPort: number, url: string, headers: Record<string, string> = {}): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: url, headers });
    req.on("response", (res) => void collect(res).then(resolve, reject));
    req.on("error", reject);
    req.end();
  });
}

export interface TunnelResult {
  readonly status: number;
  readonly statusMessage: string;
  readonly body: string;
  readonly socket?: Socket;
}

/** Sends CONNECT and returns the proxy's answer; on 200 the open socket is included. */
export function openTunnel(proxyPort: number, authority: string, proxyAuthorization?: string): Promise<TunnelResult> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: authority, headers: proxyAuthorization ? { "proxy-authorization": proxyAuthorization } : {} });
    req.on("connect", (res, socket, head) => {
      if (res.statusCode === 200) {
        if (head.length > 0) socket.unshift(head);
        resolve({ status: 200, statusMessage: res.statusMessage ?? "", body: "", socket });
      } else {
        const chunks: Buffer[] = [head];
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        socket.on("close", () => resolve({ status: res.statusCode ?? 0, statusMessage: res.statusMessage ?? "", body: Buffer.concat(chunks).toString("utf8") }));
      }
    });
    req.on("response", (res) => void collect(res).then((r) => resolve({ status: r.status, statusMessage: res.statusMessage ?? "", body: r.body }), reject));
    req.on("error", reject);
    req.end();
  });
}

/** TLS over an open tunnel. Resolves with the TLS socket, or rejects with the handshake error. */
export function tlsOver(socket: Socket, servername: string, ca: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({ socket, servername, ca }, () => resolve(tls));
    tls.once("error", reject);
  });
}

/** One HTTP/1.1 request over an established TLS socket. */
export function httpOver(tls: TLSSocket, path: string, headers: Record<string, string>): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ createConnection: () => tls, path, method: "GET", headers, setHost: false });
    req.on("response", (res) => void collect(res).then(resolve, reject));
    req.on("error", reject);
    req.end();
  });
}

/** Resolves when a socket closes, or rejects after `ms`. */
export function closed(socket: Socket, ms = 2_000): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket did not close")), ms);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
