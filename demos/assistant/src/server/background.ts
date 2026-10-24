/**
 * Background work (spec section 2, "Work that continues without you"): reminders and automations run on the platform
 * as the person while no tab is open, which needs their one-time background sign-in on the deployment. The SDK doesn't
 * wrap background sign-in yet, so this calls the platform's REST route (`/v1/credentials/background`, the one
 * `npx managed-copilot login` uses) as this server's own GitHub account. Only the person's explicit click turns it on.
 */
import { isManagedCopilotError, type AccountInfo } from "@managed-copilot/sdk";
import type { BackgroundView } from "../shared/protocol.js";
import { UserFacingError } from "./conversation.js";
import { backgroundReason } from "./describe.js";
import { errorMessage, type Logger } from "./log.js";

export const BACKGROUND_ROUTE = "/v1/credentials/background";

/** Re-check while it's off or unknown, so turning it on from a terminal shows up quickly. */
const CHECK_OFF_MS = 30_000;
/** Re-check while it's on, so a revoked sign-in shows up without a failed reminder first. */
const CHECK_ON_MS = 5 * 60_000;
const CHECK_UNAVAILABLE_MS = 10 * 60_000;

/** The platform's background sign-in status (`GET`, `POST`, and `DELETE /v1/credentials/background`). */
interface CredentialStatus {
  readonly account?: AccountInfo;
  readonly active: boolean;
  readonly createdAt?: string;
  readonly reason?: string;
}

export interface BackgroundPlatform {
  readonly managed: { readonly account: AccountInfo } | undefined;
  request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T>;
}

export interface BackgroundDeps {
  readonly platform: BackgroundPlatform;
  readonly log: Logger;
  onChange(view: BackgroundView): void;
  now?(): number;
}

export class BackgroundWork {
  readonly #deps: BackgroundDeps;
  #view: BackgroundView = { state: "unknown" };
  #checkedAt = 0;
  /** Bumped by changes and resets, so a status read that overlapped one is never applied over it. */
  #generation = 0;
  #changing = false;
  #refreshing: Promise<BackgroundView> | undefined;

  constructor(deps: BackgroundDeps) {
    this.#deps = deps;
  }

  get view(): BackgroundView {
    return this.#view;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  /** Whether the status should be checked again (more often while it's off). */
  due(maxAgeMs?: number): boolean {
    const age = this.#now() - this.#checkedAt;
    if (maxAgeMs !== undefined) return age >= maxAgeMs;
    switch (this.#view.state) {
      case "unknown":
        return true;
      case "off":
      case "error":
        return age >= CHECK_OFF_MS;
      case "on":
        return age >= CHECK_ON_MS;
      case "unavailable":
        return age >= CHECK_UNAVAILABLE_MS;
    }
  }

  /** Reads the status from the platform (joining a read in progress). */
  refresh(reason: string): Promise<BackgroundView> {
    this.#refreshing ??= this.#refresh(reason).finally(() => (this.#refreshing = undefined));
    return this.#refreshing;
  }

  async #refresh(reason: string): Promise<BackgroundView> {
    if (!this.#deps.platform.managed) return this.#view;
    const generation = this.#generation;
    let next: BackgroundView;
    try {
      next = this.#fromStatus(await this.#deps.platform.request<CredentialStatus>("GET", BACKGROUND_ROUTE));
    } catch (error) {
      next = this.#fromError(error);
      this.#deps.log.debug("Couldn't check background work", { reason, error: errorMessage(error) });
    }
    if (generation === this.#generation && !this.#changing) this.#apply(next);
    return this.#view;
  }

  /** Turns background work on. Call only after the person explicitly agreed in the UI. */
  enable(): Promise<BackgroundView> {
    return this.#change("POST", "turn on");
  }

  /** Turns background work off; the platform pauses the person's schedules until it's on again. */
  disable(): Promise<BackgroundView> {
    return this.#change("DELETE", "turn off");
  }

  async #change(method: "POST" | "DELETE", action: string): Promise<BackgroundView> {
    if (!this.#deps.platform.managed) throw new UserFacingError("platform_unavailable", "Managed Copilot isn't connected.");
    if (this.#changing) throw new UserFacingError("busy", "Background work is already being changed. Try again in a moment.");
    this.#changing = true;
    this.#generation++;
    try {
      const status = await this.#deps.platform.request<CredentialStatus>(method, BACKGROUND_ROUTE, method === "POST" ? {} : undefined);
      this.#apply(this.#fromStatus(status));
      this.#deps.log.info(method === "POST" ? "Background work turned on" : "Background work turned off", { login: this.#view.login });
      return this.#view;
    } catch (error) {
      this.#deps.log.warn(`Couldn't ${action} background work`, { error: errorMessage(error) });
      throw new UserFacingError("background_failed", `Couldn't ${action} background work: ${errorMessage(error)}`);
    } finally {
      this.#changing = false;
      this.#generation++;
    }
  }

  /**
   * For actions that only work with background work on (adding, resuming, or running automations): re-checks when it
   * looks off, then refuses with a clear message. Unknown or unchecked states pass; the platform still enforces.
   */
  async ensureOn(): Promise<void> {
    if (this.#view.state !== "off") return;
    await this.refresh("an action needs background work");
    if (this.#view.state === "off") {
      throw new UserFacingError("background_work_off", "Turn on background work first, so this can run as you while you're away.");
    }
  }

  /** The platform connection was lost or replaced; the status is unknown until it's checked again. */
  reset(): void {
    this.#generation++;
    this.#checkedAt = 0;
    this.#apply({ state: "unknown" });
  }

  #fromStatus(status: CredentialStatus): BackgroundView {
    const checkedAt = new Date(this.#now()).toISOString();
    const account = this.#deps.platform.managed?.account;
    if (account && status.account && status.account.id !== account.id) {
      // Never present another account's background work as this person's.
      return { state: "error", error: `The platform answered for @${status.account.login}, not @${account.login}.`, checkedAt };
    }
    const login = status.account?.login ?? account?.login;
    if (status.active) return { state: "on", login, since: status.createdAt, checkedAt };
    // A sign-in that existed (createdAt) and stopped working has a reason worth showing. Turning it off was the
    // person's own choice (here or with `managed-copilot logout`), so it reads as plain "off".
    const stopped = status.createdAt !== undefined && status.reason !== undefined && !/logout|signed out/i.test(status.reason);
    return { state: "off", login, reason: stopped ? (backgroundReason(status.reason) ?? status.reason) : undefined, checkedAt };
  }

  #fromError(error: unknown): BackgroundView {
    const checkedAt = new Date(this.#now()).toISOString();
    const unreachable = isManagedCopilotError(error) && (error.details?.reason === "unreachable" || error.details?.reason === "not_connected");
    // An older or minimal deployment without the route can't run background work at all.
    if (isManagedCopilotError(error, "not_found") || (isManagedCopilotError(error, "capability_unavailable") && !unreachable)) {
      return { state: "unavailable", checkedAt };
    }
    return { state: "error", error: errorMessage(error), checkedAt };
  }

  #apply(view: BackgroundView): void {
    this.#checkedAt = view.state === "unknown" ? 0 : this.#now();
    const { checkedAt: _before, ...previous } = this.#view;
    const { checkedAt: _after, ...next } = view;
    this.#view = view;
    if (JSON.stringify(previous) !== JSON.stringify(next)) this.#deps.onChange(view);
  }
}
