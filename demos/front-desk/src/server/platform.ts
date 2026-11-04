/**
 * Front Desk's connections to Managed Copilot, each acting for one person. Nothing here ever connects without a
 * credential naming who it acts for, so Front Desk never acts as whoever deployed it, and the platform keeps each
 * person's sessions to themselves.
 *
 * With an app key (`MANAGED_COPILOT_APP_KEY`, issued by the AppHost's `apps`), one connection is Front Desk itself, and
 * `managed.as(...)` acts for each person:
 * - People who sign in with GitHub: `{ gitHubToken }`, their own token, so their sessions belong to their GitHub
 *   account and model use goes to their own Copilot plan.
 * - People without GitHub: `{ appUser }`, Front Desk vouching for them, so their sessions belong to that app user and
 *   model use goes to the deployment's Azure AI Foundry.
 *
 * Without an app key, Front Desk connects as each GitHub user with their token, and people without GitHub can sign in
 * but not chat (Front Desk says why).
 */
import { createHash } from "node:crypto";
import type { CopilotClient } from "@github/copilot-sdk";
import { ERROR_CODES, ManagedCopilotError, type ErrorCode, type SessionInfo } from "@managed-copilot/protocol";
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
  /** The model new conversations use; absent: the environment's default. */
  readonly model?: string;
}

/** One person's connection: everything it does acts as them. */
export interface PersonalConnection {
  readonly userId: string;
  readonly route: Route;
  /** A started, stock `CopilotClient` that acts as this person. */
  client(): Promise<CopilotClient>;
  /** Deletes one of this person's sessions on the platform (the platform refuses anyone else's). */
  deleteSession(sessionId: string): Promise<void>;
  /** The platform's record of one of this person's sessions: its owner and where its model calls go. */
  sessionInfo(sessionId: string): Promise<SessionInfo>;
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

/**
 * One person's connection: a `ManagedCopilot` that acts for them (a view of Front Desk's app connection, or their own
 * GitHub connection) and their stock client, started on first use.
 */
class PersonConnection implements PersonalConnection {
  readonly userId: string;
  readonly route: Route;
  /** Identifies the credential it acts with: a new GitHub token gets a new connection. */
  readonly credential: string;
  readonly #managed: ManagedCopilot;
  #client: Promise<CopilotClient> | undefined;

  constructor(userId: string, credential: string, route: Route, managed: ManagedCopilot) {
    this.userId = userId;
    this.credential = credential;
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

  sessionInfo(sessionId: string): Promise<SessionInfo> {
    return this.#managed.sessions.get(sessionId);
  }

  async ping(): Promise<void> {
    if (!this.#client) return;
    await deadline((await this.#client).ping(), 8_000, "Managed Copilot");
  }

  /** A view of the app connection closes only its own clients; a person's own connection closes entirely. */
  async close(): Promise<void> {
    this.#client = undefined;
    await this.#managed.close().catch(() => undefined);
  }
}

const credentialOf = (person: Person) => (person.kind === "github" ? `github:${createHash("sha256").update(person.token).digest("base64url")}` : `app:${person.userId}`);

export interface ManagedPlatformOptions {
  readonly config: FrontDeskConfig;
  /**
   * Front Desk's app key (`MANAGED_COPILOT_APP_KEY`, issued by the AppHost): one app connection then acts for
   * everyone, GitHub users with their own token and everyone else as Front Desk's own users. Without one, Front Desk
   * connects as each GitHub user, and people without GitHub can't chat.
   */
  readonly appKey?: string;
  /** Opens a connection (tests replace it). */
  readonly connect?: (options: { readonly gitHubToken?: string; readonly appKey?: string }) => Promise<ManagedCopilot>;
}

export class ManagedPlatform implements Platform {
  readonly #config: FrontDeskConfig;
  readonly #appKey: string | undefined;
  readonly #connect: (options: { readonly gitHubToken?: string; readonly appKey?: string }) => Promise<ManagedCopilot>;
  readonly #connections = new Map<string, Promise<PersonConnection>>();
  #app: Promise<ManagedCopilot> | undefined;
  #appState: { available: boolean; reason?: string; model?: string } = { available: false, reason: "Front Desk is connecting to Managed Copilot. Try again in a moment." };
  #retry: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(options: ManagedPlatformOptions) {
    this.#config = options.config;
    this.#appKey = options.appKey?.trim() || undefined;
    // Always an explicit credential: never the SDK's fallbacks (environment variables, the GitHub CLI), which would be
    // whoever runs this server.
    this.#connect =
      options.connect ??
      ((credential) =>
        ManagedCopilot.connect({ clientName: "front-desk", ...(credential.appKey ? { appKey: credential.appKey } : { gitHubToken: credential.gitHubToken! }) }));
  }

  /** Whether Front Desk connects as an app (with an app key) rather than as each GitHub user. */
  get appMode(): boolean {
    return this.#appKey !== undefined;
  }

  /** Connects the app (app mode), so whether people without GitHub can chat is known before anyone asks. */
  start(): void {
    if (this.#appKey) void this.#appConnection().catch(() => undefined);
  }

  routeFor(kind: Person["kind"]): Route {
    if (kind === "github") return { route: "copilot", environment: this.#config.environment, model: this.#config.model };
    const model = this.#config.foundryModel ?? this.#appState.model;
    return { route: "foundry", environment: this.#config.foundryEnvironment, ...(model ? { model } : {}) };
  }

  appUsers(): { available: boolean; reason?: string } {
    if (!this.#appKey) {
      return {
        available: false,
        reason: "This Front Desk has no app key, so it can't vouch for people without GitHub. Sign in with GitHub to chat.",
      };
    }
    return { available: this.#appState.available, ...(this.#appState.reason ? { reason: this.#appState.reason } : {}) };
  }

  async open(person: Person): Promise<PersonalConnection> {
    const credential = credentialOf(person);
    const current = this.#connections.get(person.userId);
    if (current) {
      const connection = await current.catch(() => undefined);
      // A new GitHub token (signed in again, or refreshed) gets a new connection; the old one is closed.
      if (connection && connection.credential === credential) return connection;
      if (this.#connections.get(person.userId) === current) this.#connections.delete(person.userId);
      await connection?.close();
    }
    const route = this.routeFor(person.kind);
    const opening = this.#appKey ? this.#openThroughApp(person, credential) : this.#openAsGitHubUser(person, credential, route);
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
    this.#stopped = true;
    if (this.#retry) clearTimeout(this.#retry);
    const all = [...this.#connections.keys()];
    await Promise.all(all.map((userId) => this.release(userId)));
    const app = this.#app;
    this.#app = undefined;
    await app?.then((managed) => managed.close()).catch(() => undefined);
  }

  /** Without an app key: the GitHub user's own connection, with their token. */
  async #openAsGitHubUser(person: Person, credential: string, route: Route): Promise<PersonConnection> {
    if (person.kind !== "github") throw new AppError("app_users_unavailable", this.appUsers().reason ?? "People without GitHub can't chat here yet.", 503);
    try {
      const managed = await deadline(this.#connect({ gitHubToken: person.token }), 45_000, "Managed Copilot");
      log.info("Connected to Managed Copilot as a GitHub user", { user: person.userId, login: managed.account.login, url: managed.url });
      return new PersonConnection(person.userId, credential, route, managed);
    } catch (error) {
      throw describePlatformError(error, person, route);
    }
  }

  /** With an app key: a view of the app connection acting for this person. */
  async #openThroughApp(person: Person, credential: string): Promise<PersonConnection> {
    const app = await this.#appConnection();
    if (person.kind === "app" && !this.#appState.available) {
      throw new AppError("app_users_unavailable", this.#appState.reason ?? "People without GitHub can't chat here yet.", 503);
    }
    const route = this.routeFor(person.kind);
    try {
      const view = await deadline(
        person.kind === "github" ? app.as({ gitHubToken: person.token }) : app.as({ appUser: { id: person.userId, name: person.name } }),
        45_000,
        "Managed Copilot",
      );
      return new PersonConnection(person.userId, credential, route, view);
    } catch (error) {
      throw describePlatformError(error, person, route);
    }
  }

  /** Front Desk's own connection (app mode), opened once and again after a failure. */
  #appConnection(): Promise<ManagedCopilot> {
    if (!this.#app) {
      const connecting = deadline(this.#connect({ appKey: this.#appKey! }), 45_000, "Managed Copilot").then((managed) => {
        this.#appState = this.#describe(managed);
        log.info("Connected to Managed Copilot as Front Desk", { url: managed.url, appUsers: this.#appState.available ? "on" : `off: ${this.#appState.reason}` });
        return managed;
      });
      this.#app = connecting;
      connecting.catch((error: unknown) => {
        if (this.#app === connecting) this.#app = undefined;
        const managed = managedErrorOf(error);
        const reason =
          managed?.code === "authentication_required" || managed?.code === "forbidden"
            ? "Managed Copilot didn't accept Front Desk's app key. Whoever runs Front Desk needs to check its MANAGED_COPILOT_APP_KEY."
            : describePlatformError(error).message;
        this.#appState = { available: false, reason };
        log.warn("Front Desk couldn't connect to Managed Copilot; trying again soon", { error: reason });
        if (!this.#stopped) {
          if (this.#retry) clearTimeout(this.#retry);
          this.#retry = setTimeout(() => this.start(), 15_000);
          this.#retry.unref();
        }
      });
    }
    return this.#app.catch((error: unknown) => {
      const managed = managedErrorOf(error);
      if (managed?.code === "authentication_required" || managed?.code === "forbidden") {
        throw new AppError("app_key_rejected", "Managed Copilot didn't accept Front Desk's app key. Whoever runs Front Desk needs to check it.", 503);
      }
      throw describePlatformError(error);
    });
  }

  /** Whether this deployment gives Front Desk a Foundry environment for people without GitHub. */
  #describe(managed: ManagedCopilot): { available: boolean; reason?: string; model?: string } {
    const name = this.#config.foundryEnvironment;
    const environment = managed.info.environments.find((candidate) => candidate.name === name);
    if (!environment) {
      return { available: false, reason: `This Managed Copilot deployment has no "${name}" environment, so people without GitHub can't chat here yet. Sign in with GitHub to chat.` };
    }
    if (!environment.inference?.foundry) {
      return { available: false, reason: `"${name}" doesn't send model calls to Azure AI Foundry, so it can't be used by people without GitHub. Sign in with GitHub to chat.` };
    }
    const model = environment.models?.[0];
    return { available: true, ...(model ? { model } : {}) };
  }
}
