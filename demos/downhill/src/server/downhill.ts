// Downhill's shop on the server: the launch-day timeline, the sales ledger, the storefront versions checkout runs, and
// the alert. The HTTP layer (http.ts) calls these operations.
import type { SalesRow, StorefrontInfo } from "../shared/shop.js";
import { ALERTS_OFF, ShopAlerts, type AlertStatus } from "./alerts.js";
import type { DownhillConfig } from "./config.js";
import { parseDeploy, verifySignature } from "./deploys.js";
import { DownhillError } from "./errors.js";
import { Ledger, toCsv, type LedgerEvent } from "./ledger.js";
import { log } from "./log.js";
import { incidentService, type IncidentService } from "./service.js";
import { parseShopEvent } from "./shop-events.js";
import { Storefront, type DeployRecord } from "./storefront.js";
import { LAUNCH_DAY, loadTimeline, restartTimeline, timelineFrom } from "./timeline.js";

export const DEPLOYS_OFF = "Deploys are off: set DOWNHILL_DEPLOY_SECRET to the secret Incident Commander signs deploys with (its INCIDENT_DEPLOY_SECRET).";

export interface DeployAnswer {
  readonly version: string;
  readonly message: string;
}

export interface ShopStatus {
  readonly alerts: AlertStatus;
  readonly deploys: { readonly configured: boolean; readonly message?: string };
  readonly storefront: StorefrontInfo;
  readonly timeline: { readonly startedAt: string; readonly launchAt: string; readonly bannerAt: string };
  readonly liveEvents: number;
}

type ShopConfig = Pick<DownhillConfig, "dataDir" | "storefrontDir" | "version" | "incidentUrl" | "incidentAlertSecret" | "deploySecret">;

const answer = (record: DeployRecord): DeployAnswer => ({ version: record.version, message: `Downhill's shop now runs storefront v${record.version}.` });

export class DownhillShop {
  readonly ledger: Ledger;
  readonly storefront: Storefront;
  readonly alerts: ShopAlerts;
  readonly #config: ShopConfig;
  readonly #now: () => number;

  constructor(config: ShopConfig, options: { now?: () => number; fetcher?: typeof fetch } = {}) {
    this.#config = config;
    this.#now = options.now ?? Date.now;
    this.storefront = new Storefront(config.storefrontDir, config.dataDir);
    this.ledger = new Ledger(config.dataDir, loadTimeline(config.dataDir, this.#now()), () => this.storefront.fixedAt());
    this.alerts = new ShopAlerts({
      ...(config.incidentUrl ? { url: config.incidentUrl } : {}),
      ...(config.incidentAlertSecret ? { secret: config.incidentAlertSecret } : {}),
      dataDir: config.dataDir,
      ledger: this.ledger,
      deployedAt: () => this.storefront.deployedAt(),
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });
  }

  /** Starts launch day over once it's more than a day old (otherwise the story goes stale and the sales grow forever). */
  #launchDay(now: number): void {
    if (now - this.ledger.timeline.startedAt < LAUNCH_DAY) return;
    try {
      this.ledger.timeline = restartTimeline(this.#config.dataDir, now);
    } catch (error) {
      log.warn(`Couldn't save launch day's new start, so a restart goes back to the old one: ${(error as Error).message}`);
      this.ledger.timeline = timelineFrom(now);
    }
    log.info("Launch day started over: the last one began more than a day ago");
  }

  /** Records a checkout outcome from a player's browser; a rejected code may fire the alert (in the background). */
  record(body: unknown): LedgerEvent {
    const now = this.#now();
    this.#launchDay(now);
    const event = parseShopEvent(body, now);
    this.ledger.record(event);
    if (event.type === "promo_rejected") void this.alerts.onLiveRejection(now);
    return event;
  }

  sales(): SalesRow[] {
    const now = this.#now();
    this.#launchDay(now);
    return this.ledger.rows(now);
  }

  salesCsv(): string {
    return toCsv(this.sales());
  }

  service(): IncidentService {
    const now = this.#now();
    this.#launchDay(now);
    return incidentService(this.ledger, this.storefront, this.#config.version, now);
  }

  /** Incident Commander's approved deploy: signed, for downhill-shop, and new (a repeat gets the first answer). */
  deploy(body: string, signature: string | undefined, idempotencyKey: string | undefined): DeployAnswer {
    const secret = this.#config.deploySecret;
    if (!secret) throw new DownhillError("deploys_off", DEPLOYS_OFF, 503);
    const verdict = verifySignature(signature, body, secret, this.#now());
    if (verdict === "missing") throw new DownhillError("unauthorized", "Sign the deploy: Downhill takes deploys only from Incident Commander, signed with DOWNHILL_DEPLOY_SECRET.", 401);
    if (verdict === "stale") throw new DownhillError("unauthorized", "The deploy's signature is more than 5 minutes old. Send it again.", 401);
    if (verdict === "invalid") throw new DownhillError("unauthorized", "The deploy's signature doesn't match. Check that DOWNHILL_DEPLOY_SECRET is Incident Commander's deploy secret.", 401);
    const key = idempotencyKey?.trim().slice(0, 200) || undefined;
    const done = key ? this.storefront.findDeploy(key) : undefined;
    if (done) return answer(done);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new DownhillError("invalid_request", "The deploy isn't valid JSON.");
    }
    const deploy = parseDeploy(parsed);
    const now = this.#now();
    const record = this.storefront.activate({ ...deploy, ...(key ? { idempotencyKey: key } : {}) }, now);
    log.info("Deployed a storefront fix: checkout runs it now", { version: record.version, incident: record.incident, approvedBy: record.approvedBy, files: record.files.length });
    void this.alerts.resolve(now, `Checkout takes the launch code again: Downhill's shop runs storefront v${record.version}, deployed from ${record.incident}.`);
    return answer(record);
  }

  /** For rehearsals: no live sales, no deployed versions, no alert. `restartTimeline`: launch day starts over now. */
  async reset(options: { restartTimeline?: boolean } = {}): Promise<{ message: string }> {
    const now = this.#now();
    const wasFiring = this.alerts.firing;
    this.ledger.clearLive();
    this.storefront.reset();
    if (wasFiring) await this.alerts.resolve(now, "Downhill's demo was reset: checkout is back to the storefront as it shipped.");
    this.alerts.clear();
    if (options.restartTimeline) this.ledger.timeline = restartTimeline(this.#config.dataDir, now);
    const version = this.storefront.originalVersion();
    log.info("Reset the demo", { storefront: version, timeline: options.restartTimeline ? "restarted" : "kept" });
    return {
      message: `Demo reset: live sales, deployed fixes, and the alert are cleared, and checkout runs storefront v${version} again${options.restartTimeline ? "; launch day starts over (launch three hours ago)" : ""}.`,
    };
  }

  status(): ShopStatus {
    this.#launchDay(this.#now());
    const { startedAt, launchAt, bannerAt } = this.ledger.timeline;
    const iso = (ms: number) => new Date(ms).toISOString();
    return {
      alerts: this.alerts.status(),
      deploys: { configured: Boolean(this.#config.deploySecret), ...(this.#config.deploySecret ? {} : { message: DEPLOYS_OFF }) },
      storefront: this.storefront.info(),
      timeline: { startedAt: iso(startedAt), launchAt: iso(launchAt), bannerAt: iso(bannerAt) },
      liveEvents: this.ledger.liveCount,
    };
  }

  /** What's off, said once at startup. */
  logConfiguration(): void {
    if (!this.alerts.configured) log.info(ALERTS_OFF);
    if (!this.#config.deploySecret) log.info(DEPLOYS_OFF);
  }
}
