/** Test doubles: a Managed Copilot platform that keeps sessions per person like the gateway does, and a fake GitHub. */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { CopilotClient, SessionEvent, Tool } from "@github/copilot-sdk";
import { ManagedCopilotError } from "@managed-copilot/protocol";
import type { Person, PersonalConnection, Platform, Route } from "../src/server/platform.js";

interface FakeSessionRecord {
  readonly id: string;
  /** Who the platform says owns it: a GitHub token's account, or an app user. */
  readonly owner: string;
  readonly environment: string;
  readonly events: SessionEvent[];
  deleted: boolean;
}

let eventCounter = 0;
function event(type: string, data: Record<string, unknown>): SessionEvent {
  return { id: `ev-${++eventCounter}`, parentId: null, timestamp: new Date().toISOString(), type, data } as unknown as SessionEvent;
}

/** What the fake model answers: echoes the prompt; "remember: X" calls the remember tool, "recall" calls recall. */
async function answer(prompt: string, tools: readonly Tool<any>[], emit: (event: SessionEvent) => void): Promise<void> {
  emit(event("assistant.turn_start", { turnId: randomUUID() }));
  const remember = /^remember:\s*(.+)$/i.exec(prompt);
  const toolName = remember ? "remember" : /recall/i.test(prompt) ? "recall" : undefined;
  let toolText = "";
  if (toolName) {
    const tool = tools.find((candidate) => candidate.name === toolName)!;
    const args = remember ? { fact: remember[1]! } : {};
    const toolCallId = `call-${randomUUID()}`;
    emit(event("tool.execution_start", { toolCallId, toolName, arguments: args }));
    const result = await tool.handler!(args, { sessionId: "s", toolCallId, toolName, arguments: args } as never);
    toolText = typeof result === "string" ? result : JSON.stringify(result);
    emit(event("tool.execution_complete", { toolCallId, success: true, result: { content: toolText } }));
  }
  const messageId = randomUUID();
  const text = `You said: ${prompt}${toolText ? `\n\n${toolText}` : ""}`;
  for (const part of [text.slice(0, 5), text.slice(5)]) if (part) emit(event("assistant.message_delta", { messageId, deltaContent: part }));
  emit(event("assistant.message", { messageId, content: text, model: "fake-model" }));
  emit(event("assistant.turn_end", { turnId: "t" }));
  emit(event("session.idle", {}));
}

/** One person's view of the fake platform: sessions they own only, as the gateway enforces. */
class FakeConnection implements PersonalConnection {
  readonly userId: string;
  readonly route: Route;
  readonly #owner: string;
  readonly #platform: FakePlatform;
  closed = false;

  constructor(platform: FakePlatform, person: Person, route: Route) {
    this.#platform = platform;
    this.userId = person.userId;
    this.route = route;
    this.#owner = person.kind === "github" ? `github:${person.token}` : `app:${person.userId}`;
  }

  async client(): Promise<CopilotClient> {
    const platform = this.#platform;
    const owner = this.#owner;
    const environment = this.route.environment;
    const attach = (record: FakeSessionRecord, config: { onEvent?: (event: SessionEvent) => void; tools?: Tool<any>[] }) => {
      const emit = (item: SessionEvent) => {
        record.events.push(item);
        config.onEvent?.(item);
      };
      return {
        sessionId: record.id,
        send: async ({ prompt }: { prompt: string }) => {
          if (platform.failNextSend) {
            platform.failNextSend = false;
            throw new Error("Connection is closed.");
          }
          const messageId = randomUUID();
          emit(event("user.message", { messageId, content: prompt }));
          void answer(prompt, config.tools ?? [], emit);
          return messageId;
        },
        getEvents: async () => [...record.events],
        abort: async () => emit(event("abort", { reason: "user" })),
        disconnect: async () => undefined,
      };
    };
    return {
      createSession: async (config: { sessionId?: string; onEvent?: (event: SessionEvent) => void; tools?: Tool<any>[] }) => {
        const record: FakeSessionRecord = { id: config.sessionId ?? randomUUID(), owner, environment, events: [], deleted: false };
        platform.sessions.set(record.id, record);
        return attach(record, config);
      },
      resumeSession: async (sessionId: string, config: { onEvent?: (event: SessionEvent) => void; tools?: Tool<any>[] }) => {
        const record = platform.sessions.get(sessionId);
        // The gateway answers not_found for anyone else's session, exactly as for one that doesn't exist.
        if (!record || record.deleted || record.owner !== owner) throw Object.assign(new Error(`Session ${sessionId} not found [not_found]`), { data: { code: "not_found" } });
        platform.resumes.push({ sessionId, owner });
        return attach(record, config);
      },
      ping: async () => ({ message: "pong", timestamp: Date.now() }),
    } as unknown as CopilotClient;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const record = this.#platform.sessions.get(sessionId);
    if (!record || record.deleted || record.owner !== this.#owner) throw new ManagedCopilotError("not_found", `Session ${sessionId} not found`);
    record.deleted = true;
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class FakePlatform implements Platform {
  readonly sessions = new Map<string, FakeSessionRecord>();
  readonly opened: Person[] = [];
  readonly resumes: { sessionId: string; owner: string }[] = [];
  appUsersAvailable = false;
  failNextSend = false;
  readonly #connections = new Map<string, FakeConnection>();

  routeFor(kind: Person["kind"]): Route {
    return kind === "github" ? { route: "copilot", environment: "front-desk", model: "claude-sonnet-5" } : { route: "foundry", environment: "front-desk-foundry", model: "gpt-test" };
  }

  appUsers(): { available: boolean; reason?: string } {
    return this.appUsersAvailable ? { available: true } : { available: false, reason: "No app users here." };
  }

  async open(person: Person): Promise<PersonalConnection> {
    if (person.kind === "app" && !this.appUsersAvailable) throw new ManagedCopilotError("capability_unavailable", "No app users here.");
    this.opened.push(person);
    let connection = this.#connections.get(person.userId);
    if (!connection) {
      connection = new FakeConnection(this, person, this.routeFor(person.kind));
      this.#connections.set(person.userId, connection);
    }
    return connection;
  }

  async release(userId: string): Promise<void> {
    await this.#connections.get(userId)?.close();
    this.#connections.delete(userId);
  }

  async closeAll(): Promise<void> {
    for (const userId of [...this.#connections.keys()]) await this.release(userId);
  }
}

export interface FakeGitHubAccount {
  readonly id: number;
  readonly login: string;
  readonly name?: string;
}

/** GitHub's OAuth token exchange and `GET /user`, for one client ID and secret. */
export class FakeGitHub {
  readonly accounts = new Map<string, FakeGitHubAccount>();
  /** Authorization codes waiting for exchange: code → { token, PKCE challenge, redirect URI }. */
  readonly codes = new Map<string, { token: string; challenge: string; redirectUri: string; refresh?: string; expiresIn?: number }>();
  readonly refreshTokens = new Map<string, { account: string; next: string }>();
  readonly exchanges: Record<string, unknown>[] = [];
  #server: Server | undefined;
  url = "";

  constructor(readonly clientId = "client-id", readonly clientSecret = "client-secret") {}

  async start(): Promise<string> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((resolve) => this.#server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.#server?.close(resolve));
  }

  /** What GitHub does when the person approves: a code bound to the PKCE challenge and redirect URI of `authorizeUrl`. */
  approve(authorizeUrl: string, token: string, options: { refresh?: string; expiresIn?: number } = {}): { code: string; state: string } {
    const url = new URL(authorizeUrl);
    const code = `code-${randomUUID()}`;
    this.codes.set(code, { token, challenge: url.searchParams.get("code_challenge")!, redirectUri: url.searchParams.get("redirect_uri")!, ...options });
    return { code, state: url.searchParams.get("state")! };
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/user") {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const account = this.accounts.get(token);
      if (!account) return send(401, { message: "Bad credentials" });
      return send(200, { id: account.id, login: account.login, name: account.name ?? null, avatar_url: `https://avatars.githubusercontent.com/u/${account.id}` });
    }
    if (url.pathname === "/login/oauth/access_token" && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, string>;
      this.exchanges.push(body);
      if (body.client_id !== this.clientId || body.client_secret !== this.clientSecret) return send(200, { error: "incorrect_client_credentials" });
      if (body.grant_type === "refresh_token") {
        const entry = this.refreshTokens.get(body.refresh_token ?? "");
        if (!entry) return send(200, { error: "bad_refresh_token" });
        this.refreshTokens.delete(body.refresh_token!);
        const nextRefresh = `refresh-${randomUUID()}`;
        this.refreshTokens.set(nextRefresh, { account: entry.account, next: entry.next });
        this.accounts.set(entry.next, this.accounts.get(entry.account)!);
        return send(200, { access_token: entry.next, expires_in: 28_800, refresh_token: nextRefresh });
      }
      const pending = this.codes.get(body.code ?? "");
      if (!pending) return send(200, { error: "bad_verification_code" });
      if (body.redirect_uri !== pending.redirectUri) return send(200, { error: "redirect_uri_mismatch" });
      const { createHash } = await import("node:crypto");
      if (createHash("sha256").update(body.code_verifier ?? "").digest("base64url") !== pending.challenge) return send(200, { error: "bad_verification_code" });
      this.codes.delete(body.code!);
      return send(200, { access_token: pending.token, ...(pending.refresh ? { refresh_token: pending.refresh } : {}), ...(pending.expiresIn ? { expires_in: pending.expiresIn } : {}) });
    }
    send(404, { message: "Not Found" });
  }
}
