// Owner: devloop workstream. Runs the stock Copilot CLI attached to the live session (spec section 14).
//
// The CLI only accepts its AHP endpoint on the command line, so the launcher never puts a credential there. It runs a
// loopback relay for the CLI and connects to the deployment itself with a fresh single-use attach ticket per CLI
// connection, sent as a header. The relay admits a CLI only when its own GitHub sign-in is the session owner, so the
// relay URL on the command line grants nothing by itself. Credential-bearing AHP messages from the CLI are answered
// locally and never leave this machine.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { delimiter, join } from "node:path";
import type { Duplex } from "node:stream";
import {
  ATTACH_CLOSE_CODES,
  ManagedCopilotError,
  ROUTES,
  discoveryDirectory,
  filterAhpClientFrame,
  type AttachMaterial,
  type ErrorCode,
  type SessionInfo,
} from "@managed-copilot/protocol";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { HttpClient } from "../http.js";
import type { ManagedContext, OpenCliOptions } from "../types.js";

const GITHUB_API_URL = process.env.MANAGED_COPILOT_GITHUB_API_URL ?? "https://api.github.com";
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

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
  readonly shell: boolean;
}

/** Finds the stock Copilot CLI on PATH (`copilot.exe`/`.cmd` on Windows). */
export function findCopilot(explicit?: string): CopilotCommand {
  const isScript = (file: string) => /\.(cmd|bat)$/i.test(file);
  if (explicit) return { file: explicit, shell: isScript(explicit) };
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const clean = directory.replace(/^"|"$/g, "");
    if (!clean) continue;
    for (const extension of extensions) {
      const candidate = join(clean, `copilot${extension.toLowerCase()}`);
      if (existsSync(candidate)) return { file: candidate, shell: isScript(candidate) };
    }
  }
  throw new ManagedCopilotError(
    "capability_unavailable",
    "Copilot CLI is not installed. Install it (winget install GitHub.Copilot, or npm install -g @github/copilot), then attach again.",
  );
}

function quote(value: string): string {
  return /^[\w\-.:/\\=@]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
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
}

/** The loopback relay between the stock CLI and the deployment's attach socket. Exported for tests. */
export class AttachRelay {
  readonly #options: RelayOptions;
  readonly #nonce = randomBytes(24).toString("base64url");
  readonly #server: Server;
  readonly #wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES });
  readonly #verified = new Map<string, Promise<{ id: number; login: string }>>();
  #pending: AttachMaterial | undefined;
  #active: { client: WebSocket; upstream: WebSocket } | undefined;
  outcome: AttachOutcome | undefined;

  constructor(options: RelayOptions) {
    this.#options = options;
    this.#pending = options.first;
    this.#server = createServer((_req, res) => res.writeHead(404).end());
    this.#server.on("upgrade", (req, socket, head) => void this.#upgrade(req, socket, head));
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
    this.#active?.client.terminate();
    this.#active?.upstream.terminate();
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
    let lookup = this.#verified.get(key);
    if (!lookup) {
      lookup = (async () => {
        const response = await fetch(`${GITHUB_API_URL}/user`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "managed-copilot" } });
        if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
        const user = (await response.json()) as { id: number; login: string };
        return { id: user.id, login: user.login };
      })();
      this.#verified.set(key, lookup);
    }
    let cliAccount: { id: number; login: string };
    try {
      cliAccount = await lookup;
    } catch (error) {
      this.#verified.delete(key);
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

  async #connectUpstream(protocols: string[]): Promise<WebSocket> {
    for (let attempt = 0; ; attempt++) {
      const material = await this.#material();
      // The ticket only ever goes to the deployment this process connected to, whatever host the material names.
      const { pathname, search } = new URL(material.url);
      const upstream = new WebSocket(`${socketOrigin(this.#options.deploymentUrl)}${pathname}${search}`, protocols, {
        headers: { authorization: `Bearer ${material.token}` },
        perMessageDeflate: false,
        handshakeTimeout: 15_000,
        maxPayload: 256 * 1024 * 1024,
      });
      const status = await new Promise<number | undefined>((resolve) => {
        upstream.once("open", () => resolve(undefined));
        upstream.once("unexpected-response", (_request, response) => {
          resolve(response.statusCode ?? 502);
          upstream.terminate();
        });
        upstream.once("error", () => resolve(502));
      });
      if (status === undefined) return upstream;
      if (status === 401 && attempt === 0) continue;
      throw new ManagedCopilotError("capability_unavailable", `The deployment refused the attachment (HTTP ${status}).`);
    }
  }

  async #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? "/", "http://relay.local");
    if (url.pathname !== `/ahp/${this.#nonce}`) return reject(socket, 404, "not_found", "Unknown attach endpoint.");
    if (this.#active) return reject(socket, 409, "conflict", "Another Copilot CLI is already attached through this launcher.");
    const refusal = await this.#verify(req);
    if (refusal) {
      this.outcome = refusal;
      return reject(socket, refusal.code === "forbidden" ? 403 : 401, refusal.code as ErrorCode, refusal.message);
    }
    const protocols = (req.headers["sec-websocket-protocol"] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    let upstream: WebSocket;
    try {
      upstream = await this.#connectUpstream(protocols);
    } catch (error) {
      this.outcome = { code: "capability_unavailable", message: (error as Error).message };
      return reject(socket, 502, "capability_unavailable", (error as Error).message);
    }
    if (socket.destroyed) {
      upstream.terminate();
      return;
    }
    this.#wss.handleUpgrade(req, socket, head, (client) => this.#bridge(client, upstream));
  }

  #bridge(client: WebSocket, upstream: WebSocket): void {
    const active = { client, upstream };
    this.#active = active;
    client.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const filtered = filterAhpClientFrame(data.toString());
      for (const reply of filtered.replies) client.send(reply);
      if (filtered.forward !== undefined && upstream.readyState === WebSocket.OPEN) upstream.send(filtered.forward);
    });
    upstream.on("message", (data: RawData, isBinary: boolean) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    client.on("close", () => {
      if (this.#active === active) this.#active = undefined;
      if (upstream.readyState === WebSocket.OPEN) upstream.close(1000);
    });
    upstream.on("close", (code: number, reason: Buffer) => {
      const text = reason.toString();
      if (code === ATTACH_CLOSE_CODES.sessionGone) this.outcome = { code: "session_gone", message: text || "The session ended." };
      else if (code === ATTACH_CLOSE_CODES.expired) this.outcome = { code: "expired", message: text || "The attachment expired." };
      if (client.readyState === WebSocket.OPEN) client.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1011, text.slice(0, 120));
    });
    client.on("error", () => upstream.terminate());
    upstream.on("error", () => {
      if (client.readyState === WebSocket.OPEN) client.close(1011, "Lost the connection to Managed Copilot.");
    });
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
      const child = copilot.shell
        ? spawn(quote(copilot.file), args.map(quote), { stdio: "inherit", cwd: folder, shell: true, windowsHide: false })
        : spawn(copilot.file, args, { stdio: "inherit", cwd: folder, windowsHide: false });
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
