/**
 * Front Desk's connections to Managed Copilot: one per person, acting as that person. Nothing here ever connects
 * without the person's own credential, so Front Desk never acts as whoever deployed it, and the platform keeps each
 * person's sessions to themselves.
 *
 * - People who sign in with GitHub: `ManagedCopilot.connect({ gitHubToken })` with their token, so their sessions
 *   belong to their GitHub account and model use goes to their own Copilot plan.
 * - People without GitHub: the app vouches for them with its app credential, and their model use goes to the app's
 *   Azure AI Foundry. Until this deployment offers that, they can sign in but not chat, and Front Desk says why.
 */
import type { CopilotClient } from "@github/copilot-sdk";
import { ERROR_CODES, ManagedCopilotError, type ErrorCode } from "@managed-copilot/protocol";
import { ManagedCopilot } from "@managed-copilot/sdk";
import type { BillingRoute } from "../shared/types.js";
import type { FrontDeskConfig } from "./config.js";
import { AppError } from "./errors.js";
import { log } from "./log.js";

export type Person =
  | { readonly kind: "github"; readonly userId: string; readonly login: string; readonly token: string }
  | { readonly kind: "app"; readonly userId: string; readonly name: string; readonly email?: string };

/** Where a kind of person's conversations run, and who pays for their model use. */
export interface Route {
  readonly route: BillingRoute;
  readonly environment: string;
  readonly model: string;
}

/** One person's connection: everything it does acts as them. */
export interface PersonalConnection {
  readonly userId: string;
  readonly route: Route;
  /** A started, stock `CopilotClient` that acts as this person. */
  client(): Promise<CopilotClient>;
  /** Deletes one of this person's sessions on the platform (the platform refuses anyone else's). */
  deleteSession(sessionId: string): Promise<void>;
  /** Answers when the connection still works. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface Platform {
  /** The person's connection, opened on first use and reused while it works. */
  open(person: Person): Promise<PersonalConnection>;
  routeFor(kind: Person["kind"]): Route;
  /** Whether people without GitHub can chat on this deployment, and why not. */
  appUsers(): { readonly available: boolean; readonly reason?: string };
  /** Closes the person's connection. Their sessions keep running on the platform. */
  release(userId: string): Promise<void>;
  closeAll(): Promise<void>;
}

/**
 * The platform's stable error, whether it came from the SDK's REST helpers (a `ManagedCopilotError`) or from a stock
 * client call answered over JSON-RPC (the code is in `data.code` and at the end of the message, `... [not_found]`).
 */
export function managedErrorOf(error: unknown): ManagedCopilotError | undefined {
  if (error instanceof ManagedCopilotError) return error;
  if (!error || typeof error !== "object") return undefined;
  const data = (error as { data?: { code?: unknown } }).data;
  const message = error instanceof Error ? error.message : String((error as { message?: unknown }).message ?? "");
  const code = typeof data?.code === "string" ? data.code : /\[([a-z_]+)\]\s*$/.exec(message)?.[1];
  if (!code || !(ERROR_CODES as readonly string[]).includes(code)) return undefined;
  return new ManagedCopilotError(code as ErrorCode, message.replace(/\s*\[[a-z_]+\]\s*$/, "") || code);
}

/** Plain words for a failure to reach or use Managed Copilot as this person. */
export function describePlatformError(error: unknown, who?: { readonly kind: Person["kind"]; readonly login?: string }, route?: Route): AppError {
  if (error instanceof AppError) return error;
  const managed = managedErrorOf(error);
  if (managed) {
    switch (managed.code) {
      case "authentication_required":
        return who?.kind === "github"
          ? new AppError("github_sign_in_expired", "GitHub no longer accepts your sign-in. Sign in with GitHub again.", 401)
          : new AppError("platform_sign_in_failed", "Managed Copilot didn't accept Front Desk's sign-in for you. Try again later.", 503);
      case "forbidden":
        return who?.kind === "github"
          ? new AppError("not_admitted", `This Front Desk's Managed Copilot deployment doesn't admit @${who.login ?? "your account"}. Ask whoever runs it to add your GitHub account.`, 403)
          : new AppError("not_admitted", "This Front Desk's Managed Copilot deployment doesn't admit you yet. Ask whoever runs it.", 403);
      case "environment_not_found":
        return new AppError(
          "not_set_up",
          `This Managed Copilot deployment has no "${route?.environment ?? "front-desk"}" environment. Add Front Desk's environments to the AppHost (demos/front-desk/apphost.mts).`,
          503,
        );
      case "upstream_unavailable":
      case "timeout":
        return new AppError("platform_unavailable", "Managed Copilot isn't answering right now. Try again in a moment.", 503);
      case "inference_unavailable":
        return new AppError("inference_unavailable", `The model isn't available for you right now: ${managed.message}`, 503);
      default:
        return new AppError(managed.code, managed.message, managed.status >= 400 && managed.status < 600 ? managed.status : 502);
    }
  }
  const message = (error as Error)?.message ?? String(error);
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|No Managed Copilot deployment|not running anymore|did not answer/i.test(message)) {
    return new AppError("platform_unavailable", "Managed Copilot isn't reachable right now. Try again in a moment.", 503);
  }
  return new AppError("platform_error", message, 502);
}

function deadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A GitHub user's connection: their own `ManagedCopilot` handle and stock client, both with their token. */
class GitHubConnection implements PersonalConnection {
  readonly userId: string;
  readonly route: Route;
  readonly token: string;
  readonly #managed: ManagedCopilot;
  #client: Promise<CopilotClient> | undefined;

  constructor(userId: string, token: string, route: Route, managed: ManagedCopilot) {
    this.userId = userId;
    this.token = token;
    this.route = route;
    this.#managed = managed;
  }

  client(): Promise<CopilotClient> {
    if (!this.#client) {
      const starting = deadline(this.#managed.client(this.route.environment), 30_000, "Starting your Managed Copilot client");
      this.#client = starting;
      starting.catch(() => {
        if (this.#client === starting) this.#client = undefined;
      });
    }
    return this.#client;
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.#managed.sessions.delete(sessionId);
  }

  async ping(): Promise<void> {
    if (!this.#client) return;
    await deadline((await this.#client).ping(), 8_000, "Managed Copilot");
  }

  async close(): Promise<void> {
    this.#client = undefined;
    await this.#managed.close().catch(() => undefined);
  }
}

export interface ManagedPlatformOptions {
  readonly config: FrontDeskConfig;
  /** Opens a connection as a GitHub user (tests replace it). */
  readonly connectAsGitHubUser?: (token: string) => Promise<ManagedCopilot>;
}

export class ManagedPlatform implements Platform {
  readonly #config: FrontDeskConfig;
  readonly #connectAsGitHubUser: (token: string) => Promise<ManagedCopilot>;
  readonly #connections = new Map<string, Promise<PersonalConnection>>();

  constructor(options: ManagedPlatformOptions) {
    this.#config = options.config;
    // Always the person's own token: never the SDK's fallbacks (environment variables, the GitHub CLI), which would be
    // whoever runs this server.
    this.#connectAsGitHubUser = options.connectAsGitHubUser ?? ((token) => ManagedCopilot.connect({ gitHubToken: token, clientName: "front-desk" }));
  }

  routeFor(kind: Person["kind"]): Route {
    if (kind === "github") return { route: "copilot", environment: this.#config.environment, model: this.#config.model };
    return { route: "foundry", environment: `${this.#config.environment}-foundry`, model: this.#config.model };
  }

  appUsers(): { available: boolean; reason?: string } {
    return {
      available: false,
      reason: "This Managed Copilot deployment can't run conversations for people without GitHub yet. Sign in with GitHub to chat.",
    };
  }

  async open(person: Person): Promise<PersonalConnection> {
    if (person.kind === "app") {
      const { reason } = this.appUsers();
      throw new AppError("app_users_unavailable", reason ?? "People without GitHub can't chat on this deployment yet.", 503);
    }
    const current = this.#connections.get(person.userId);
    if (current) {
      const connection = await current.catch(() => undefined);
      // A new GitHub token (signed in again, or refreshed) gets a new connection; the old one is closed.
      if (connection instanceof GitHubConnection && connection.token === person.token) return connection;
      if (this.#connections.get(person.userId) === current) this.#connections.delete(person.userId);
      await connection?.close();
    }
    const route = this.routeFor("github");
    const opening = (async () => {
      try {
        const managed = await deadline(this.#connectAsGitHubUser(person.token), 45_000, "Managed Copilot");
        log.info("Connected to Managed Copilot as a GitHub user", { user: person.userId, login: managed.account.login, url: managed.url });
        return new GitHubConnection(person.userId, person.token, route, managed);
      } catch (error) {
        throw describePlatformError(error, person, route);
      }
    })();
    this.#connections.set(person.userId, opening);
    opening.catch(() => {
      if (this.#connections.get(person.userId) === opening) this.#connections.delete(person.userId);
    });
    return opening;
  }

  async release(userId: string): Promise<void> {
    const current = this.#connections.get(userId);
    if (!current) return;
    this.#connections.delete(userId);
    const connection = await current.catch(() => undefined);
    await connection?.close();
  }

  async closeAll(): Promise<void> {
    const all = [...this.#connections.keys()];
    await Promise.all(all.map((userId) => this.release(userId)));
  }
}
