// The shop's alert to Incident Commander. When a live player's promo code is rejected, the rule is checked over the
// last 10 minutes of checkouts (live and simulated), or the time since the last deploy if that's shorter: at least 3
// rejections and under half of promo attempts succeeding. The alert fires once, and stays firing until a deploy resolves
// it. Without INCIDENT_URL and INCIDENT_ALERT_SECRET, there are no alerts. Failures are logged in plain words and never
// affect the player's checkout.
import { join } from "node:path";
import { BANNER_RELEASE } from "../shared/catalog.js";
import { readJsonFile, writeJsonFile } from "./files.js";
import type { Ledger } from "./ledger.js";
import { log } from "./log.js";
import { SERVICE_NAME } from "./deploys.js";
import { clip } from "./support.js";
import { MINUTE } from "./timeline.js";

export const ALERT_ID = "downhill-promo-rejected";
export const ALERT_TITLE = "Downhill shop: launch code rejected at checkout";
export const ALERT_WINDOW = 10 * MINUTE;
const TIMEOUT_MS = 10_000;

export const ALERTS_OFF = "Alerts are off: set INCIDENT_URL and INCIDENT_ALERT_SECRET to send the shop's alert to Incident Commander.";

/** The generic alert shape Incident Commander takes. */
export interface ShopAlert {
  readonly title: string;
  readonly service: string;
  readonly severity: "major";
  readonly status: "firing" | "resolved";
  readonly id: string;
  readonly summary: string;
  readonly description: string;
  readonly labels: { readonly team: string; readonly env: string };
}

interface AlertState {
  firing: boolean;
  firedAt?: string;
  resolvedAt?: string;
}

export interface AlertStatus {
  readonly configured: boolean;
  readonly firing: boolean;
  readonly firedAt?: string;
  readonly message?: string;
}

const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);
const utcClock = (ms: number) => new Date(ms).toISOString().slice(11, 16);

export class ShopAlerts {
  readonly #url: string | undefined;
  readonly #secret: string | undefined;
  readonly #file: string;
  readonly #ledger: Ledger;
  readonly #deployedAt: () => number | undefined;
  readonly #fetch: typeof fetch;
  #state: AlertState;
  #sending: Promise<void> = Promise.resolve();
  #busy = false;

  /** `deployedAt`: when the version checkout runs now was deployed (none: the storefront as it shipped). */
  constructor(options: { url?: string; secret?: string; dataDir: string; ledger: Ledger; deployedAt?: () => number | undefined; fetcher?: typeof fetch }) {
    this.#url = options.url;
    this.#secret = options.secret;
    this.#file = join(options.dataDir, "alert.json");
    this.#ledger = options.ledger;
    this.#deployedAt = options.deployedAt ?? (() => undefined);
    this.#fetch = options.fetcher ?? fetch;
    const saved = readJsonFile<Partial<AlertState>>(this.#file);
    this.#state = { firing: saved?.firing === true, ...(typeof saved?.firedAt === "string" ? { firedAt: saved.firedAt } : {}) };
  }

  get configured(): boolean {
    return Boolean(this.#url && this.#secret);
  }

  get firing(): boolean {
    return this.#state.firing;
  }

  status(): AlertStatus {
    return { configured: this.configured, firing: this.#state.firing, ...(this.#state.firedAt ? { firedAt: this.#state.firedAt } : {}), ...(this.configured ? {} : { message: ALERTS_OFF }) };
  }

  /** Resolves when the alert being sent (if any) has been sent or has failed. */
  settled(): Promise<void> {
    return this.#sending;
  }

  /** Keeps the state for the next start. A failed write is logged: the alert works on without it. */
  #save(): void {
    try {
      writeJsonFile(this.#file, this.#state);
    } catch (error) {
      log.warn(`Couldn't save the alert's state to ${this.#file}: ${(error as Error).message}`);
    }
  }

  /** A live player's code was rejected at `now`: fires the alert if checkout is failing and it isn't firing yet. */
  onLiveRejection(now: number): Promise<void> {
    if (!this.configured || this.#state.firing || this.#busy) return this.#sending;
    // Rejections from before the last deploy don't count: a fixed checkout mustn't page anyone again.
    const deployedAt = this.#deployedAt();
    const windowMs = deployedAt === undefined ? ALERT_WINDOW : Math.min(ALERT_WINDOW, Math.max(0, now - deployedAt));
    const stats = this.#ledger.promoStats(now, windowMs);
    if (stats.rejected < 3 || stats.applied / stats.attempts >= 0.5) return this.#sending;
    const { bannerAt, launchAt } = this.#ledger.timeline;
    const before = this.#ledger.promoStats(bannerAt, bannerAt - launchAt);
    const alert: ShopAlert = {
      title: ALERT_TITLE,
      service: SERVICE_NAME,
      severity: "major",
      status: "firing",
      id: ALERT_ID,
      summary: `${stats.rejected} of ${stats.attempts} promo checkouts failed ${windowMs < ALERT_WINDOW ? "since the last deploy" : "in the last 10 minutes"}: "${stats.error ?? "Invalid code."}"`,
      description: `Since the launch-week banner went live at ${utcClock(bannerAt)} UTC (${BANNER_RELEASE.summary}), most promo checkouts fail; before it, ${percent(before.applied, before.attempts)}% of codes went through.`,
      labels: { team: "shop", env: "production" },
    };
    return this.#send(alert, () => {
      this.#state = { firing: true, firedAt: new Date(now).toISOString() };
      this.#save();
      log.info("Alerted Incident Commander: the launch code is rejected at checkout", { event: "alert.fired", alert: ALERT_ID, rejected: stats.rejected, attempts: stats.attempts });
    });
  }

  /** Checkout changed (a deploy, or a demo reset): resolves the alert if it's firing. */
  resolve(now: number, why: string): Promise<void> {
    if (!this.#state.firing) return this.#sending;
    const firedAt = this.#state.firedAt;
    // Stop firing whether or not Incident Commander hears it: a deploy fixed the cause.
    this.#state = { firing: false, resolvedAt: new Date(now).toISOString() };
    this.#save();
    if (!this.configured) return this.#sending;
    const alert: ShopAlert = {
      title: ALERT_TITLE,
      service: SERVICE_NAME,
      severity: "major",
      status: "resolved",
      id: ALERT_ID,
      summary: clip(why, 300),
      description: `Firing since ${firedAt ? `${utcClock(Date.parse(firedAt))} UTC` : "earlier"}; resolved at ${utcClock(now)} UTC.`,
      labels: { team: "shop", env: "production" },
    };
    return this.#send(alert, () => log.info("Told Incident Commander the alert is resolved", { event: "alert.resolved", alert: ALERT_ID, why }));
  }

  /** Forgets the alert's state (a demo reset). */
  clear(): void {
    this.#state = { firing: false };
    this.#save();
  }

  #send(alert: ShopAlert, sent: () => void): Promise<void> {
    this.#busy = true;
    this.#sending = this.#sending
      .then(() => this.#post(alert))
      .then((ok) => {
        if (ok) sent();
      })
      // Nothing may reject the chain: the next alert waits on it, and nobody awaits a player's.
      .catch((error: unknown) => log.warn(`Couldn't finish the ${alert.status} alert: ${(error as Error).message}`))
      .finally(() => {
        this.#busy = false;
      });
    return this.#sending;
  }

  /** POSTs the alert; logs any failure in plain words. Never throws. */
  async #post(alert: ShopAlert): Promise<boolean> {
    const url = `${this.#url}/api/alerts`;
    try {
      const response = await this.#fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.#secret}` },
        body: JSON.stringify(alert),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) return true;
      const body = (await response.json().catch(() => undefined)) as { error?: { message?: unknown } } | undefined;
      const said = typeof body?.error?.message === "string" ? `: ${clip(body.error.message, 200)}` : "";
      const hint = response.status === 401 || response.status === 403 ? " Check that INCIDENT_ALERT_SECRET matches Incident Commander's." : "";
      log.warn(`Incident Commander refused the ${alert.status} alert (HTTP ${response.status})${said}.${hint}`);
    } catch (error) {
      const timedOut = (error as Error).name === "TimeoutError";
      log.warn(timedOut ? `Incident Commander didn't answer the ${alert.status} alert within 10 seconds.` : `Couldn't send the ${alert.status} alert to Incident Commander at ${this.#url}: ${(error as Error).message}`);
    }
    return false;
  }
}
