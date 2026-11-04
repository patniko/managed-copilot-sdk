// Who may operate this deployment, and how a browser signs in. Operators are GitHub accounts the AppHost names
// (`operators`); a loopback gateway that names none treats every account that can use it as an operator. The console
// signs in with a one-time ticket the CLI mints with the operator's GitHub token, redeemed for an HttpOnly cookie. The
// token stays in this process's memory only (never on disk) and is re-verified on every console request.
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { CONSOLE_REQUEST_HEADER, CONSOLE_TICKET_TTL_SECONDS, ManagedCopilotError, type OperatorGrant } from "@managed-copilot/protocol";
import type { GatewayApp } from "../../app.js";
import { isGitHubPrincipal, type Principal } from "../../http.js";
import type { Logger } from "../../log.js";

export interface OperatorRules {
  readonly githubUsers: readonly string[];
  readonly githubOrgs: readonly string[];
}

interface Ticket {
  readonly principal: Principal;
  readonly grant: OperatorGrant;
  readonly expiresAt: number;
}

export interface ConsoleSession {
  readonly principal: Principal;
  readonly grant: OperatorGrant;
  readonly createdAt: number;
  readonly expiresAt: number;
  lastSeenAt: number;
}

/** How long a console session lasts, and how long it may sit unused. */
export const CONSOLE_SESSION_MS = 8 * 60 * 60_000;
export const CONSOLE_IDLE_MS = 60 * 60_000;
const MAX_TICKETS = 200;
const MAX_SESSIONS = 500;

/** Cookie names: `__Host-` (Secure, Path=/, no Domain) when the console is served over HTTPS. */
export const COOKIE_SECURE = "__Host-mc_console";
export const COOKIE_PLAIN = "mc_console";

const hash = (secret: string) => createHash("sha256").update(secret).digest("base64url");

function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

/** Satisfied by core's GitHub authenticator. */
export interface OperatorAuthPort {
  authenticate(token: string): Promise<Principal>;
  satisfies(principal: Principal, rules: { readonly githubUsers?: readonly string[]; readonly githubOrgs?: readonly string[] }): Promise<boolean>;
}

export class OperatorAccess {
  readonly #app: GatewayApp;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #tickets = new Map<string, Ticket>();
  readonly #sessions = new Map<string, ConsoleSession>();
  readonly rules: OperatorRules;

  constructor(options: { readonly app: GatewayApp; readonly log: Logger; readonly now?: () => number }) {
    this.#app = options.app;
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
    const operators = options.app.config.deployment.operators;
    this.rules = { githubUsers: operators?.githubUsers ?? [], githubOrgs: operators?.githubOrgs ?? [] };
  }

  get configured(): boolean {
    return this.rules.githubUsers.length > 0 || this.rules.githubOrgs.length > 0;
  }

  /** A loopback gateway (local mode) with no operators named: every account that can use it may operate it. */
  get localDefault(): boolean {
    const config = this.#app.config;
    return !this.configured && config.mode === "local" && isLoopbackHost(config.host);
  }

  /** Whether anyone can operate this deployment. */
  get enabled(): boolean {
    return this.configured || this.localDefault;
  }

  /** Why the console is off, when it is. */
  get offReason(): string | undefined {
    if (this.enabled) return undefined;
    const name = this.#app.config.deployment.name;
    if (this.#app.config.mode === "azure") {
      return `This deployment names no operators, so its operator console is off. Add operators: { githubUsers: ["<your-login>"] } to addManagedCopilot in the AppHost, or set Parameters:${name}-operator-users, and deploy again.`;
    }
    return `This gateway listens on ${this.#app.config.host}, beyond this machine, and names no operators, so its operator console is off. Add operators: { githubUsers: ["<your-login>"] } to addManagedCopilot in the AppHost.`;
  }

  #auth(): OperatorAuthPort {
    return this.#app.service("auth") as unknown as OperatorAuthPort;
  }

  /** The principal's operator grant; `forbidden` (naming who may operate, and the caller's login) when it has none. */
  async authorize(principal: Principal): Promise<OperatorGrant> {
    // Operators are GitHub users: never an app's own user, whatever the deployment's rules say.
    if (!isGitHubPrincipal(principal)) throw new ManagedCopilotError("forbidden", "Only GitHub users can operate this deployment.", { login: principal.login });
    if (this.configured) {
      if (await this.#auth().satisfies(principal, this.rules)) return "configured";
      const allowed = [...this.rules.githubUsers.map((user) => `@${user}`), ...this.rules.githubOrgs.map((org) => `members of ${org}`)].join(", ");
      throw new ManagedCopilotError("forbidden", `@${principal.login} is not an operator of this deployment (operators: ${allowed}). Operators are named in the AppHost: operators in addManagedCopilot.`, {
        operators: allowed,
        login: principal.login,
      });
    }
    if (this.localDefault) return "local";
    throw new ManagedCopilotError("forbidden", this.offReason!, { login: principal.login, reason: "console_off" });
  }

  // --- Tickets --------------------------------------------------------------------------------------------------

  /** A one-time console sign-in ticket for an authorized operator. */
  mintTicket(principal: Principal, grant: OperatorGrant): { ticket: string; expiresAt: string } {
    const now = this.#now();
    this.#prune(now);
    if (this.#tickets.size >= MAX_TICKETS) {
      const oldest = [...this.#tickets].sort(([, a], [, b]) => a.expiresAt - b.expiresAt)[0];
      if (oldest) this.#tickets.delete(oldest[0]);
    }
    const ticket = `mcct_${randomBytes(32).toString("base64url")}`;
    const expiresAt = now + CONSOLE_TICKET_TTL_SECONDS * 1000;
    this.#tickets.set(hash(ticket), { principal, grant, expiresAt });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Redeems a ticket once. Unknown, used, or expired tickets fail with `authentication_required`. */
  redeemTicket(ticket: unknown): { principal: Principal; grant: OperatorGrant } {
    const invalid = () => new ManagedCopilotError("authentication_required", "This sign-in link has expired or was already used. Run `npx managed-copilot console` to get a new one.");
    if (typeof ticket !== "string" || !ticket.startsWith("mcct_") || ticket.length > 200) throw invalid();
    const key = hash(ticket);
    const entry = this.#tickets.get(key);
    this.#tickets.delete(key);
    if (!entry || entry.expiresAt <= this.#now()) throw invalid();
    return { principal: entry.principal, grant: entry.grant };
  }

  // --- Console sessions -----------------------------------------------------------------------------------------

  createSession(principal: Principal, grant: OperatorGrant): { cookie: string; session: ConsoleSession } {
    const now = this.#now();
    this.#prune(now);
    if (this.#sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.#sessions].sort(([, a], [, b]) => a.lastSeenAt - b.lastSeenAt)[0];
      if (oldest) this.#sessions.delete(oldest[0]);
    }
    const cookie = randomBytes(32).toString("base64url");
    const session: ConsoleSession = { principal, grant, createdAt: now, expiresAt: now + CONSOLE_SESSION_MS, lastSeenAt: now };
    this.#sessions.set(hash(cookie), session);
    return { cookie, session };
  }

  /** The live console session a cookie value names (undefined when unknown, expired, or idle too long). */
  session(cookie: string | undefined): ConsoleSession | undefined {
    if (!cookie) return undefined;
    const key = hash(cookie);
    const session = this.#sessions.get(key);
    if (!session) return undefined;
    const now = this.#now();
    if (session.expiresAt <= now || now - session.lastSeenAt > CONSOLE_IDLE_MS) {
      this.#sessions.delete(key);
      return undefined;
    }
    return session;
  }

  touch(session: ConsoleSession): void {
    session.lastSeenAt = this.#now();
  }

  endSession(cookie: string | undefined): ConsoleSession | undefined {
    if (!cookie) return undefined;
    const key = hash(cookie);
    const session = this.#sessions.get(key);
    this.#sessions.delete(key);
    return session;
  }

  /** Ends every console session of an account (its credential was rejected). */
  endSessionsOf(accountId: number): void {
    for (const [key, session] of this.#sessions) if (session.principal.accountId === accountId) this.#sessions.delete(key);
  }

  #prune(now: number): void {
    for (const [key, ticket] of this.#tickets) if (ticket.expiresAt <= now) this.#tickets.delete(key);
    for (const [key, session] of this.#sessions) if (session.expiresAt <= now || now - session.lastSeenAt > CONSOLE_IDLE_MS) this.#sessions.delete(key);
  }

  // --- Request helpers -----------------------------------------------------------------------------------------

  /** Whether the console is served over HTTPS (the cookie is then `Secure`, with the `__Host-` prefix). */
  get secure(): boolean {
    return this.#app.config.publicUrl.startsWith("https://");
  }

  cookieFrom(req: IncomingMessage): string | undefined {
    const header = req.headers.cookie;
    if (!header) return undefined;
    const wanted = this.secure ? COOKIE_SECURE : COOKIE_PLAIN;
    for (const part of header.split(";")) {
      const index = part.indexOf("=");
      if (index < 0) continue;
      if (part.slice(0, index).trim() === wanted) {
        try {
          return decodeURIComponent(part.slice(index + 1).trim());
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  }

  setCookie(value: string, maxAgeSeconds: number): string {
    const name = this.secure ? COOKIE_SECURE : COOKIE_PLAIN;
    return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}${this.secure ? "; Secure" : ""}`;
  }

  clearCookie(): string {
    return this.setCookie("", 0);
  }

  /**
   * Cross-site request checks for cookie-authenticated (and ticket) requests: the console's own header, which a
   * cross-site page cannot send without a preflight the gateway never grants, and an `Origin`, when the browser sends
   * one, of this gateway.
   */
  assertConsoleRequest(req: IncomingMessage): void {
    if (req.headers[CONSOLE_REQUEST_HEADER] !== "1") {
      throw new ManagedCopilotError("forbidden", `Console requests must carry the ${CONSOLE_REQUEST_HEADER} header.`);
    }
    const origin = req.headers.origin;
    if (origin === undefined) return;
    let host: string | undefined;
    try {
      host = new URL(origin).host;
    } catch {
      host = undefined;
    }
    const allowed = new Set([req.headers.host, new URL(this.#app.config.publicUrl).host].filter((value): value is string => Boolean(value)));
    if (!host || !allowed.has(host)) {
      this.#log.warn("Refused a cross-origin console request", { origin });
      throw new ManagedCopilotError("forbidden", "Console requests must come from the console's own origin.");
    }
  }
}
