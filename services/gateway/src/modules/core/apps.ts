// Apps that vouch for their own users (spec section 2): each declared app's key, the environments requests through it
// may use, and the accounts of its own users. Keys arrive as environment variables (`apps.<name>.key.secretEnv`); only
// their SHA-256 digests are kept, compared in constant time.
import { createHash, timingSafeEqual } from "node:crypto";
import { appUserLogin, AppUserSchema, decodeHeaderValue, ManagedCopilotError, type AccountInfo, type EnvironmentConfig, type ManagedCopilotConfig } from "@managed-copilot/protocol";
import type { Principal } from "../../http.js";
import type { Logger } from "../../log.js";
import type { SessionLedger } from "./ledger.js";

/** Shortest key the gateway accepts: the integration generates 48 characters. */
const MIN_KEY_LENGTH = 32;

export interface AppDefinition {
  readonly name: string;
  /** Environments any request through this app may use. */
  readonly environments: readonly string[];
  /** Admit every GitHub account that comes through this app's key, not only those `access` allows. */
  readonly anyGitHubUser: boolean;
}

interface LoadedApp extends AppDefinition {
  readonly digest: Buffer;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export class AppRegistry {
  readonly #apps = new Map<string, LoadedApp>();
  readonly #ledger: SessionLedger;
  /** Apps declared without a usable key; requests through them are refused. */
  readonly problems: readonly string[];

  constructor(options: { deployment: ManagedCopilotConfig; env: Readonly<Record<string, string | undefined>>; ledger: SessionLedger; log: Logger }) {
    this.#ledger = options.ledger;
    const problems: string[] = [];
    const seen = new Map<string, string>();
    for (const [name, app] of Object.entries(options.deployment.apps ?? {})) {
      const key = options.env[app.key.secretEnv]?.trim();
      if (!key || key.length < MIN_KEY_LENGTH) {
        problems.push(`App "${name}" has no usable key (${app.key.secretEnv} is ${key ? `shorter than ${MIN_KEY_LENGTH} characters` : "not set"}); requests through it are refused.`);
        continue;
      }
      const hex = digest(key).toString("hex");
      const twin = seen.get(hex);
      if (twin) {
        problems.push(`Apps "${twin}" and "${name}" have the same key; requests through either are refused. Give each app its own key.`);
        this.#apps.delete(twin);
        continue;
      }
      seen.set(hex, name);
      this.#apps.set(name, { name, environments: [...app.environments], anyGitHubUser: app.anyGitHubUser === true, digest: digest(key) });
    }
    for (const problem of problems) options.log.error(problem);
    this.problems = problems;
  }

  get size(): number {
    return this.#apps.size;
  }

  get(name: string): AppDefinition | undefined {
    return this.#apps.get(name);
  }

  list(): readonly AppDefinition[] {
    return [...this.#apps.values()];
  }

  /** The app whose key this is. Every app's digest is compared, so the time taken does not depend on which matched. */
  match(presented: string): AppDefinition | undefined {
    if (!presented || presented.length > 1024) return undefined;
    const candidate = digest(presented);
    let found: LoadedApp | undefined;
    for (const app of this.#apps.values()) {
      if (timingSafeEqual(candidate, app.digest) && !found) found = app;
    }
    return found;
  }

  /**
   * The principal of one of `app`'s own users, from the request's percent-encoded headers. Never a GitHub account:
   * the account is the deployment's own, unique per (app, user ID), with a negative ID.
   */
  userPrincipal(app: AppDefinition, encodedId: string, encodedName: string | undefined): Principal {
    const id = decodeHeaderValue(encodedId);
    const name = encodedName === undefined ? undefined : decodeHeaderValue(encodedName);
    if (id === undefined || (encodedName !== undefined && name === undefined)) {
      throw new ManagedCopilotError("invalid_request", "The app user headers must be percent-encoded UTF-8");
    }
    const parsed = AppUserSchema.safeParse({ id, ...(name !== undefined && name !== "" ? { name } : {}) });
    if (!parsed.success) throw new ManagedCopilotError("invalid_request", `Invalid app user: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    const account = this.#ledger.appUserAccount(app.name, parsed.data.id, parsed.data.name, appUserLogin(app.name, parsed.data.id));
    return appUserPrincipal(account, app.name);
  }

  /** The app itself, acting for nobody: deployment information only. */
  appPrincipal(app: AppDefinition): Principal {
    return { accountId: 0, login: app.name, kind: "app", app: app.name };
  }
}

export function appUserPrincipal(account: AccountInfo, app: string): Principal {
  return {
    accountId: account.id,
    login: account.login,
    ...(account.name ? { name: account.name } : {}),
    kind: "app-user",
    app,
    ...(account.userId !== undefined ? { userId: account.userId } : {}),
  };
}

/** Whether an environment is one the principal's app may use (always, for requests that came through no app). */
export function appAllows(apps: AppRegistry | undefined, principal: Principal, environment: string): boolean {
  if (!principal.app) return true;
  return apps?.get(principal.app)?.environments.includes(environment) ?? false;
}

/**
 * An app's own users have no Copilot plan: their agent sessions run only where model calls go to Foundry. Anything
 * else is refused before a session exists (`inference_unavailable`), never billed to someone else.
 */
export function assertAppUserInference(principal: Principal, environment: string, config: EnvironmentConfig): void {
  if (principal.kind !== "app-user" || config.inference?.foundry) return;
  throw new ManagedCopilotError(
    "inference_unavailable",
    `Environment "${environment}" sends model calls to each user's GitHub Copilot plan, and app users have none. Use an environment with inference: { foundry } for the "${principal.app}" app's users.`,
    { environment, app: principal.app },
  );
}

/** Refuses an environment outside the principal's app (`environment_not_found`, as for an undeclared name). */
export function assertAppEnvironment(apps: AppRegistry | undefined, principal: Principal, environment: string): void {
  if (appAllows(apps, principal, environment)) return;
  const app = principal.app ? apps?.get(principal.app) : undefined;
  throw new ManagedCopilotError(
    "environment_not_found",
    `The "${principal.app}" app may not use environment "${environment}".${app ? ` Its environments: ${app.environments.join(", ")}.` : ""}`,
    { environment, app: principal.app },
  );
}
