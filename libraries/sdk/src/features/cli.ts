// Runs the stock Copilot CLI attached to the live session (spec section 14).
//
// The CLI only accepts its AHP endpoint on the command line, so the launcher never puts a credential there. It runs a
// loopback relay for the CLI and connects to the deployment itself with a fresh single-use attach ticket per CLI
// connection, sent as a header. The relay admits a CLI only when its own GitHub sign-in is the session owner, so the
// relay URL on the command line grants nothing by itself. Credential-bearing AHP messages from the CLI are answered
// locally and never leave this machine.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { delimiter, isAbsolute, join, resolve as resolvePath } from "node:path";
import type { Duplex } from "node:stream";
import {
  ATTACH_CLOSE_CODES,
  ERROR_HTTP_STATUS,
  ManagedCopilotError,
  ROUTES,
  discoveryDirectory,
  filterAhpClientFrame,
  parseWebSocketProtocols,
  type AttachMaterial,
  type ErrorCode,
  type SessionInfo,
} from "@managed-copilot/protocol";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { HttpClient } from "../http.js";
import type { ManagedContext, OpenCliOptions } from "../types.js";

const GITHUB_API_URL = process.env.MANAGED_COPILOT_GITHUB_API_URL ?? "https://api.github.com";
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** Close code that makes the stock Copilot CLI reconnect to the same URL (1012, service restart). Private 4xxx codes end its attachment. */
const CLI_RECONNECT = 1012;
/** At most this many platform-requested reconnects per window, so a fault can't loop forever. */
const MAX_RECONNECTS = 5;
const RECONNECT_WINDOW_MS = 60_000;
/** How long a reconnect keeps trying while the session moves into a sandbox (`session_busy`); a move takes seconds. */
const BUSY_RETRY_MS = 120_000;
const BUSY_BACKOFF_MS = [250, 500, 1_000, 2_000] as const;
/**
 * The link to the deployment is pinged this often (ingresses such as Azure Container Apps close a WebSocket idle for
 * 240 s) and treated as dead after this long without a frame or pong from it (a half-open link after sleep or a
 * network change).
 */
const KEEPALIVE = { intervalMs: 30_000, timeoutMs: 90_000 } as const;
const STALLED = "Managed Copilot stopped responding. Reconnecting.";

function isSessionBusy(error: unknown): boolean {
  return error instanceof ManagedCopilotError && error.code === "session_busy";
}

/** The stable error code in a refused upgrade's JSON body, if it has one. */
function errorCodeOf(body: string): string | undefined {
  try {
    const code = (JSON.parse(body) as { error?: { code?: unknown } }).error?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

/** Why an attachment ended, when the platform or the launcher ended it rather than the user. */
export interface AttachOutcome {
  readonly code: ErrorCode | "session_gone" | "expired";
  readonly message: string;
}

export interface AttachedCliResult {
  readonly exitCode: number;
  /** Set when the platform ended the attachment (session deleted or moved) or the launcher refused the CLI. */
  readonly outcome?: AttachOutcome;
}

interface CopilotCommand {
  readonly file: string;
  /** A Windows batch file (`copilot.cmd` from npm), which only cmd.exe can run. */
  readonly shell: boolean;
}

const BATCH_FILE = /\.(cmd|bat)$/i;

/** Executable extensions to try on Windows, in PATHEXT order (scripts such as `.js` don't run directly). */
function executableExtensions(): string[] {
  const runnable = [".com", ".exe", ".bat", ".cmd"];
  const listed = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((extension) => extension.toLowerCase());
  return listed.filter((extension) => runnable.includes(extension));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolves a command name or path the way the shell would: PATH, and on Windows PATHEXT extensions. */
function resolveExecutable(command: string): string | undefined {
  const names =
    process.platform === "win32"
      ? [...(/\.[^\\/.]+$/.test(command) ? [command] : []), ...executableExtensions().map((extension) => `${command}${extension}`)]
      : [command];
  if (isAbsolute(command) || /[\\/]/.test(command)) return names.map((name) => resolvePath(name)).find(isFile);
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const clean = directory.replace(/^"|"$/g, "");
    if (!clean) continue;
    const found = names.map((name) => join(clean, name)).find(isFile);
    if (found) return found;
  }
  return undefined;
}

/** Finds the stock Copilot CLI: `explicit` (a path or command name) or `copilot` on PATH (`copilot.exe`/`.cmd` on Windows). */
export function findCopilot(explicit?: string): CopilotCommand {
  const file = resolveExecutable(explicit ?? "copilot");
  if (file) return { file, shell: process.platform === "win32" && BATCH_FILE.test(file) };
  if (explicit) throw new ManagedCopilotError("capability_unavailable", `Copilot CLI was not found at ${explicit}.`);
  throw new ManagedCopilotError(
    "capability_unavailable",
    "Copilot CLI is not installed. Install it (winget install GitHub.Copilot, or npm install -g @github/copilot), then attach again.",
  );
}

/** Finds any command the way the shell would (PATH, PATHEXT); undefined when it isn't installed. */
export function findExecutable(command: string): CopilotCommand | undefined {
  const file = resolveExecutable(command);
  return file ? { file, shell: process.platform === "win32" && BATCH_FILE.test(file) } : undefined;
}

/** cmd.exe metacharacters, escaped with `^` so cmd passes them through literally. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** Quotes one argument for CommandLineToArgvW: backslashes double only before a quote or the closing quote. */
function quoteArgument(value: string): string {
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes++;
      continue;
    }
    quoted += character === '"' ? `${"\\".repeat(backslashes * 2 + 1)}"` : `${"\\".repeat(backslashes)}${character}`;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

/**
 * How to spawn the CLI without `shell: true`. A batch file runs as `cmd.exe /d /s /c "..."` with every argument quoted
 * and its metacharacters escaped twice (cmd parses the line, then the batch file re-parses `%*`), so no argument can
 * expand a variable or start another command.
 */
export function copilotSpawnArguments(copilot: CopilotCommand, args: readonly string[]): { file: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (!copilot.shell) return { file: copilot.file, args: [...args], windowsVerbatimArguments: false };
  const escape = (value: string) => value.replace(CMD_META, "^$1");
  const line = [escape(copilot.file), ...args.map((arg) => escape(escape(quoteArgument(arg))))].join(" ");
  return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

function socketOrigin(deploymentUrl: string): string {
  const url = new URL(deploymentUrl);
  return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
}

function reject(socket: Duplex, status: number, code: ErrorCode, message: string): void {
  const body = JSON.stringify({ error: { code, message } });
  socket.end(`HTTP/1.1 ${status} Attach refused\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
}

interface RelayOptions {
  readonly sessionId: string;
  readonly owner: { readonly id: number; readonly login: string };
  readonly deploymentUrl: string;
  readonly http: Pick<HttpClient, "post">;
  readonly first: AttachMaterial;
  /** How long a reconnect keeps trying through `session_busy` (default `BUSY_RETRY_MS`). */
  readonly busyRetryMs?: number;
  /** Keepalive for the link to the deployment (default `KEEPALIVE`). */
  readonly keepAlive?: { readonly intervalMs: number; readonly timeoutMs: number };
}

/** The loopback relay between the stock CLI and the deployment's attach socket. Exported for tests. */
export class AttachRelay {
  readonly #options: RelayOptions;
  readonly #nonce = randomBytes(24).toString("base64url");
  readonly #server: Server;
  readonly #wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES });
  /** GitHub identity lookups in flight, shared by concurrent connections; every new connection verifies again. */
  readonly #verifying = new Map<string, Promise<{ id: number; login: string }>>();
  /** Every upstream connection, including handshakes in flight, so `close()` can end them all. */
  readonly #upstreams = new Set<WebSocket>();
  /** Each upstream's network connection, so bytes still arriving (a large frame on a slow link) count as life. */
  readonly #transports = new WeakMap<WebSocket, Duplex>();
  #pending: AttachMaterial | undefined;
  #active: { client: WebSocket; upstream: WebSocket } | undefined;
  /**
   * The CLI connection being verified or connected; reserved before the first await so only one can win. A connection
   * whose socket is already gone (the CLI gave up waiting while the session moved) no longer holds the slot.
   */
  #connecting: Duplex | undefined;
  #closed = false;
  /** When the platform last asked the CLI to reconnect (session moved, attachment renewed). */
  #reconnects: number[] = [];
  outcome: AttachOutcome | undefined;

  constructor(options: RelayOptions) {
    this.#options = options;
    this.#pending = options.first;
    this.#server = createServer((_req, res) => res.writeHead(404).end());
    this.#server.on("upgrade", (req, socket, head) => {
      // Until ws takes the socket over, a reset from the client must not become an uncaught error.
      socket.on("error", () => socket.destroy());
      this.#upgrade(req, socket, head).catch(() => socket.destroy());
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = this.#server.address() as AddressInfo;
    return `ws://127.0.0.1:${port}/ahp/${this.#nonce}`;
  }

  async close(): Promise<void> {
    this.#closed = true;
    // Every CLI socket, including one still closing after a reconnect request, so shutdown never waits on it.
    for (const client of this.#wss.clients) client.terminate();
    for (const upstream of this.#upstreams) upstream.terminate();
    this.#upstreams.clear();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  /** The CLI's own GitHub sign-in must be the session owner. */
  async #verify(req: IncomingMessage): Promise<AttachOutcome | undefined> {
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const { owner, sessionId } = this.#options;
    if (!token) {
      return { code: "authentication_required", message: `Copilot CLI is not signed in. Run \`copilot login\` as @${owner.login}, then attach to ${sessionId} again.` };
    }
    const key = createHash("sha256").update(token).digest("hex");
    let lookup = this.#verifying.get(key);
    if (!lookup) {
      lookup = (async () => {
        const response = await fetch(`${GITHUB_API_URL}/user`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "managed-copilot" } });
        if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
        const user = (await response.json()) as { id: number; login: string };
        return { id: user.id, login: user.login };
      })();
      this.#verifying.set(key, lookup);
      const settled = () => this.#verifying.delete(key);
      lookup.then(settled, settled);
    }
    let cliAccount: { id: number; login: string };
    try {
      cliAccount = await lookup;
    } catch (error) {
      return { code: "authentication_required", message: `Could not verify Copilot CLI's GitHub sign-in: ${(error as Error).message}. Run \`copilot login\` and attach again.` };
    }
    if (cliAccount.id !== owner.id) {
      return {
        code: "forbidden",
        message: `Copilot CLI is signed in as @${cliAccount.login}, but this session belongs to @${owner.login}. Run \`copilot login\` as @${owner.login}, then attach again.`,
      };
    }
    return undefined;
  }

  async #material(): Promise<AttachMaterial> {
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending && Date.parse(pending.expiresAt) - Date.now() > 5_000) return pending;
    return this.#options.http.post<AttachMaterial>(ROUTES.attach(this.#options.sessionId));
  }

  /**
   * Connects to the deployment's attach socket with fresh material. While the session is moving into a sandbox the
   * deployment answers `session_busy` (for the ticket or the socket), so this keeps trying with backoff for as long as
   * the CLI waits on `cliSocket`, bounded by `BUSY_RETRY_MS`.
   */
  async #connectUpstream(protocols: string[], cliSocket: Duplex): Promise<WebSocket> {
    const deadline = Date.now() + (this.#options.busyRetryMs ?? BUSY_RETRY_MS);
    let waits = 0;
    let renewed = false;
    const mayWait = () => !this.#closed && !cliSocket.destroyed && Date.now() < deadline;
    // Ends early when the CLI hangs up, so a CLI that redials gets the launcher at once.
    const pause = () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(done, BUSY_BACKOFF_MS[Math.min(waits++, BUSY_BACKOFF_MS.length - 1)]);
        timer.unref();
        cliSocket.once("close", done);
        function done() {
          clearTimeout(timer);
          cliSocket.off("close", done);
          resolve();
        }
      });
    for (;;) {
      // The CLI hung up on this dial: its next one (if any) takes over.
      if (cliSocket.destroyed) throw new ManagedCopilotError("conflict", "Copilot CLI stopped waiting for this connection.");
      let material: AttachMaterial;
      try {
        material = await this.#material();
      } catch (error) {
        if (isSessionBusy(error) && mayWait()) {
          await pause();
          continue;
        }
        throw error;
      }
      // Reconnects stay on the conversation the CLI attached to (spec section 9): never switch sessions silently.
      if (material.ahpSessionId !== this.#options.first.ahpSessionId) {
        throw new ManagedCopilotError("conflict", "The deployment offered a different conversation for this session; refusing to switch. Attach again.");
      }
      // The ticket only ever goes to the deployment this process connected to, whatever host the material names.
      const { pathname, search } = new URL(material.url);
      if (cliSocket.destroyed) throw new ManagedCopilotError("conflict", "Copilot CLI stopped waiting for this connection.");
      const upstream = new WebSocket(`${socketOrigin(this.#options.deploymentUrl)}${pathname}${search}`, protocols, {
        headers: { authorization: `Bearer ${material.token}` },
        perMessageDeflate: false,
        handshakeTimeout: 15_000,
        maxPayload: 256 * 1024 * 1024,
      });
      this.#upstreams.add(upstream);
      upstream.once("upgrade", (response) => this.#transports.set(upstream, response.socket));
      upstream.once("close", () => this.#upstreams.delete(upstream));
      // Errors after the outcome below (a terminated handshake) have nothing left to report.
      upstream.on("error", () => undefined);
      const refusal = await new Promise<{ status: number; code?: string } | undefined>((resolve) => {
        // The CLI hung up while this dial was in flight: it ends here, before the deployment registers a responder for
        // it (the CLI's next dial, if any, takes over).
        const abandon = () => {
          upstream.terminate();
          resolve({ status: 499 });
        };
        cliSocket.once("close", abandon);
        upstream.once("close", () => cliSocket.off("close", abandon));
        upstream.once("open", () => {
          cliSocket.off("close", abandon);
          resolve(undefined);
        });
        upstream.once("unexpected-response", (_request, response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= 64 * 1024) chunks.push(chunk);
          });
          const done = () => {
            const code = errorCodeOf(Buffer.concat(chunks).toString());
            resolve({ status: response.statusCode ?? 502, ...(code ? { code } : {}) });
            upstream.terminate();
          };
          response.once("end", done);
          response.once("error", done);
        });
        upstream.once("error", () => resolve({ status: 502 }));
      });
      if (refusal === undefined) {
        if (!cliSocket.destroyed) return upstream;
        upstream.terminate();
        throw new ManagedCopilotError("conflict", "Copilot CLI stopped waiting for this connection.");
      }
      if (cliSocket.destroyed) throw new ManagedCopilotError("conflict", "Copilot CLI stopped waiting for this connection.");
      if (refusal.code === "session_busy") {
        if (mayWait()) {
          await pause();
          continue;
        }
        throw new ManagedCopilotError("session_busy", "The session is still moving into a sandbox. Attach again in a moment.");
      }
      // An expired or already used ticket: one fresh one.
      if (refusal.status === 401 && !renewed) {
        renewed = true;
        continue;
      }
      throw new ManagedCopilotError("capability_unavailable", `The deployment refused the attachment (HTTP ${refusal.status}${refusal.code ? `, ${refusal.code}` : ""}).`);
    }
  }
  async #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://relay.local").pathname;
    } catch {
      return reject(socket, 400, "invalid_request", "Malformed request target.");
    }
    if (pathname !== `/ahp/${this.#nonce}`) return reject(socket, 404, "not_found", "Unknown attach endpoint.");
    if (this.#closed) return reject(socket, 503, "capability_unavailable", "This launcher is shutting down.");
    if (this.#active || (this.#connecting && !this.#connecting.destroyed)) return reject(socket, 409, "conflict", "Another Copilot CLI is already attached through this launcher.");
    const protocols = parseWebSocketProtocols(req.headers["sec-websocket-protocol"]);
    if (!protocols) return reject(socket, 400, "invalid_request", "The Sec-WebSocket-Protocol header is malformed.");
    this.#connecting = socket;
    // Until ws takes the socket over, a CLI that hangs up mid-wait ends this dial (no half-open waiting).
    const hangUp = () => socket.destroy();
    socket.once("end", hangUp);
    try {
      const refusal = await this.#verify(req);
      if (refusal) {
        // An abandoned dial says nothing about the attachment (another dial may already be attached).
        if (socket.destroyed) return;
        this.outcome = refusal;
        return reject(socket, refusal.code === "forbidden" ? 403 : 401, refusal.code as ErrorCode, refusal.message);
      }
      let upstream: WebSocket;
      try {
        upstream = await this.#connectUpstream(protocols, socket);
      } catch (error) {
        // An abandoned dial (the CLI hung up while the session moved) says nothing about the attachment.
        if (socket.destroyed) return;
        const code: ErrorCode = error instanceof ManagedCopilotError ? error.code : "capability_unavailable";
        this.outcome = { code, message: (error as Error).message };
        return reject(socket, code === "capability_unavailable" ? 502 : ERROR_HTTP_STATUS[code], code, (error as Error).message);
      }
      if (socket.destroyed || this.#closed || this.#active) {
        upstream.terminate();
        return;
      }
      socket.off("end", hangUp);
      this.#wss.handleUpgrade(req, socket, head, (client) => this.#bridge(client, upstream));
      // ws completes or refuses the handshake synchronously; a refused one leaves nothing to own the upstream.
      if (!this.#bridged(upstream)) upstream.terminate();
    } finally {
      socket.off("end", hangUp);
      if (this.#connecting === socket) this.#connecting = undefined;
    }
  }

  /** Whether `upstream` is bridged to an attached CLI. */
  #bridged(upstream: WebSocket): boolean {
    return this.#active?.upstream === upstream;
  }

  #bridge(client: WebSocket, upstream: WebSocket): void {
    const active = { client, upstream };
    this.#active = active;
    // Reflects the latest connection: a refused attempt the CLI recovered from is not the attachment's outcome.
    this.outcome = undefined;
    // Keepalive: idle ingresses keep the link, and a dead one is noticed without waiting for the CLI to send.
    const { intervalMs, timeoutMs } = this.#options.keepAlive ?? KEEPALIVE;
    let heard = Date.now();
    let stalled = false;
    const keepAlive = setInterval(() => {
      if (upstream.readyState !== WebSocket.OPEN) return;
      if (Date.now() - heard >= timeoutMs) {
        stalled = true;
        upstream.terminate();
        return;
      }
      try {
        upstream.ping();
      } catch {
        // Closing meanwhile: its close event ends the bridge.
      }
    }, intervalMs);
    keepAlive.unref();
    upstream.on("pong", () => (heard = Date.now()));
    upstream.on("ping", () => (heard = Date.now()));
    // A pong waits behind a large frame still arriving: every byte received counts, not just whole messages.
    const transport = this.#transports.get(upstream);
    const onData = () => (heard = Date.now());
    transport?.on("data", onData);
    client.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      let filtered: ReturnType<typeof filterAhpClientFrame>;
      try {
        filtered = filterAhpClientFrame(data.toString());
      } catch {
        // A message the credential filter can't re-serialize (nested past what JSON allows) ends this connection only.
        client.close(1008, "Copilot CLI attach could not handle a message.");
        return;
      }
      for (const reply of filtered.replies) client.send(reply);
      if (filtered.forward !== undefined && upstream.readyState === WebSocket.OPEN) upstream.send(filtered.forward);
    });
    upstream.on("message", (data: RawData, isBinary: boolean) => {
      heard = Date.now();
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    client.on("close", () => {
      if (this.#active === active) this.#active = undefined;
      if (upstream.readyState === WebSocket.OPEN) upstream.close(1000);
    });
    upstream.on("close", (code: number, reason: Buffer) => {
      clearInterval(keepAlive);
      transport?.off("data", onData);
      let text = stalled ? STALLED : reason.toString();
      // Moved, renewed, or silent past the keepalive timeout (a dropped network path): the same session, again.
      if (code === ATTACH_CLOSE_CODES.moved || code === ATTACH_CLOSE_CODES.expired || stalled) {
        if (this.#mayReconnect()) {
          // The stock CLI reconnects to this relay after 1012 (service restart); the relay then attaches it again with a
          // fresh ticket, to the same session wherever it now runs. Free the slot now: the CLI redials within milliseconds.
          if (this.#active === active) this.#active = undefined;
          if (client.readyState === WebSocket.OPEN) client.close(CLI_RECONNECT, (text || "Reconnecting.").slice(0, 120));
          setTimeout(() => client.terminate(), 2_000).unref();
          return;
        }
        text = stalled ? "Managed Copilot stopped responding repeatedly. Check your connection and attach again." : "The attachment was interrupted repeatedly. Attach again.";
        this.outcome = { code: stalled ? "upstream_unavailable" : code === ATTACH_CLOSE_CODES.moved ? "session_gone" : "expired", message: text };
      } else if (code === ATTACH_CLOSE_CODES.sessionGone) {
        this.outcome = { code: "session_gone", message: text || "The session ended." };
      }
      if (client.readyState === WebSocket.OPEN) client.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1011, text.slice(0, 120));
    });
    client.on("error", () => upstream.terminate());
    upstream.on("error", () => {
      if (client.readyState === WebSocket.OPEN) client.close(1011, "Lost the connection to Managed Copilot.");
    });
  }

  /** Allows a reconnect (platform-requested, or after the link stalled) unless they are happening in a loop. */
  #mayReconnect(): boolean {
    const now = Date.now();
    this.#reconnects = this.#reconnects.filter((at) => now - at < RECONNECT_WINDOW_MS);
    if (this.#reconnects.length >= MAX_RECONNECTS) return false;
    this.#reconnects.push(now);
    return true;
  }
}

/**
 * Attaches the stock Copilot CLI to a live session in this terminal and resolves when the CLI exits. Fails before
 * starting the CLI when the terminal is not interactive, the CLI is missing, or the session cannot be attached.
 */
export async function launchAttachedCli(
  ctx: Pick<ManagedContext, "url" | "httpFor">,
  sessionId: string,
  options: OpenCliOptions = {},
): Promise<AttachedCliResult> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ManagedCopilotError("capability_unavailable", "Copilot CLI needs an interactive terminal. Run this from a terminal window.");
  }
  const copilot = findCopilot(options.copilotPath);
  const http = ctx.httpFor(sessionId);
  const session = await http.get<SessionInfo>(ROUTES.session(sessionId));
  const first = await http.post<AttachMaterial>(ROUTES.attach(sessionId));
  const relay = new AttachRelay({ sessionId, owner: { id: session.owner.id, login: session.owner.login }, deploymentUrl: ctx.url, http, first });
  const relayUrl = await relay.listen();

  // An empty folder of its own: Copilot CLI asks to trust its working folder, and the session runs remotely.
  const folder = join(discoveryDirectory(), "attach");
  mkdirSync(folder, { recursive: true });
  const args = ["--ahp", relayUrl, ...(options.args ?? [])];
  const ignoreInterrupt = () => undefined;
  process.on("SIGINT", ignoreInterrupt);
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      const command = copilotSpawnArguments(copilot, args);
      const child = spawn(command.file, command.args, { stdio: "inherit", cwd: folder, windowsHide: false, windowsVerbatimArguments: command.windowsVerbatimArguments });
      child.once("error", (error) => reject(new ManagedCopilotError("capability_unavailable", `Could not start Copilot CLI: ${error.message}`)));
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 130 : 1)));
    });
    return { exitCode, ...(relay.outcome ? { outcome: relay.outcome } : {}) };
  } finally {
    process.off("SIGINT", ignoreInterrupt);
    await relay.close();
  }
}

/** `managed.openCli(session)`: resolves with the CLI's exit code; a refused attachment throws after the CLI exits. */
export async function openCli(ctx: ManagedContext, sessionId: string, options?: OpenCliOptions): Promise<number> {
  const { exitCode, outcome } = await launchAttachedCli(ctx, sessionId, options);
  if (outcome && outcome.code !== "session_gone" && outcome.code !== "expired") throw new ManagedCopilotError(outcome.code, outcome.message);
  if (outcome) process.stderr.write(`${outcome.message}\n`);
  return exitCode;
}
