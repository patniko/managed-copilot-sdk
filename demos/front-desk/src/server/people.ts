/** Who someone is to Front Desk, how they appear in the UI, and how they act on Managed Copilot. */
import type { BillingInfo, UserView } from "../shared/types.js";
import { GitHubSignInError, type GitHubAuth } from "./auth/github.js";
import type { FrontDeskConfig } from "./config.js";
import { AppError } from "./errors.js";
import type { Person } from "./platform.js";
import type { Store, UserRecord } from "./store.js";

/** The day the daily allowance counts against (UTC). */
export const today = (at = new Date()) => at.toISOString().slice(0, 10);

export class People {
  readonly #store: Store;
  readonly #github: GitHubAuth;
  readonly #config: FrontDeskConfig;

  constructor(store: Store, github: GitHubAuth, config: FrontDeskConfig) {
    this.#store = store;
    this.#github = github;
    this.#config = config;
  }

  /** Whether Front Desk pays for this person's model use (people without GitHub), so the daily allowance applies. */
  appPays(user: UserRecord): boolean {
    return user.kind !== "github";
  }

  billing(user: UserRecord): BillingInfo {
    if (user.kind === "github") {
      return {
        route: "copilot",
        label: "Your Copilot plan",
        detail: `You signed in with GitHub as @${user.githubLogin ?? user.name}, so your conversations use your own Copilot plan.`,
      };
    }
    const limit = this.#config.dailyMessageLimit;
    return {
      route: "foundry",
      label: "Front Desk's Azure AI Foundry",
      detail: "You signed in with email, so Front Desk pays for your conversations through its Azure AI Foundry.",
      dailyLimit: limit,
      remainingToday: Math.max(0, limit - this.#store.messagesOn(user.id, today())),
    };
  }

  view(user: UserRecord): UserView {
    return {
      id: user.id,
      kind: user.kind,
      name: user.name,
      ...(user.githubLogin ? { login: user.githubLogin } : {}),
      ...(user.email ? { email: user.email } : {}),
      ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
      billing: this.billing(user),
    };
  }

  /**
   * How this person acts on Managed Copilot: their own GitHub token, or the app vouching for them. Whether the app can
   * vouch for people right now is the platform's call when it opens their connection, after (re)connecting if needed.
   */
  async person(user: UserRecord): Promise<Person> {
    if (user.kind === "github") {
      try {
        return { kind: "github", userId: user.id, login: user.githubLogin ?? user.name, token: await this.#github.token(user.id) };
      } catch (error) {
        if (error instanceof GitHubSignInError) throw new AppError("github_sign_in_expired", error.message, 401);
        throw error;
      }
    }
    return { kind: "app", userId: user.id, name: user.name, ...(user.email ? { email: user.email } : {}) };
  }
}
