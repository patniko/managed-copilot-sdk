// Downhill's shop on the server: the launch-day timeline, the sales ledger, the storefront versions checkout runs, and
// the alert. The HTTP layer (http.ts) calls these operations.
import { join } from "node:path";
import type { SalesRow, ShopAvailability, StorefrontInfo } from "../shared/shop.js";
import { ALERTS_OFF, ShopAlerts, type AlertStatus } from "./alerts.js";
import type { DownhillConfig } from "./config.js";
import { parseDeploy, verifySignature } from "./deploys.js";
import { DownhillError } from "./errors.js";
import { readJsonFile, writeJsonFile } from "./files.js";
import { parseGameEvents, shopRecord } from "./game-events.js";
import { Ledger, toCsv, type LedgerEvent } from "./ledger.js";
import { log } from "./log.js";
import { incidentService, type IncidentService } from "./service.js";
import { parseShopEvent } from "./shop-events.js";
import { Storefront, type DeployRecord } from "./storefront.js";
import { NO_TELEMETRY, TELEMETRY_OFF, type Telemetry, type TelemetryStatus } from "./telemetry.js";
import { LAUNCH_DAY, loadTimeline, restartTimeline, timelineFrom } from "./timeline.js";

export const DEPLOYS_OFF = "Deploys are off: set DOWNHILL_DEPLOY_SECRET to the secret Incident Commander signs deploys with (its INCIDENT_DEPLOY_SECRET).";

export interface DeployAnswer {
  readonly version: string;
  readonly message: string;
}

export interface ShopStatus {
  readonly alerts: AlertStatus;
  readonly deploys: { readonly configured: boolean; readonly message?: string };
  readonly telemetry: TelemetryStatus;
  readonly storefront: StorefrontInfo;
  readonly timeline: { readonly startedAt: string; readonly launchAt: string; readonly bannerAt: string };
  readonly liveEvents: number;
  readonly shop: ShopAvailability;
}

export const SHOP_CLOSED = "The Downhill Shop is closed: open it with PUT /api/shop (the demo gallery's Shop switch) to roll it out.";

type ShopConfig = Pick<DownhillConfig, "dataDir" | "storefrontDir" | "version" | "incidentUrl" | "incidentAlertSecret" | "deploySecret">;

const answer = (record: DeployRecord): DeployAnswer => ({ version: record.version, message: `Downhill's shop now runs storefront v${record.version}.` });

export class DownhillShop {
  readonly ledger: Ledger;
  readonly storefront: Storefront;
  readonly alerts: ShopAlerts;
  /** Logs, checkouts, and game events as OpenTelemetry log records, to Incident Commander. */
  readonly telemetry: Telemetry;
  readonly #config: ShopConfig;
  readonly #now: () => number;
  /** Open as it shipped; a presenter closes it, then rolls it out live (shop.json in the data directory). */
  #availability: { open: boolean; changedAt?: string };

  constructor(config: ShopConfig, options: { now?: () => number; fetcher?: typeof fetch; telemetry?: Telemetry } = {}) {
    this.#config = config;
    this.#now = options.now ?? Date.now;
    const saved = readJsonFile<{ open?: unknown; changedAt?: unknown }>(join(config.dataDir, "shop.json"));
    this.#availability = { open: saved?.open !== false, ...(typeof saved?.changedAt === "string" ? { changedAt: saved.changedAt } : {}) };
    this.telemetry = options.telemetry ?? NO_TELEMETRY;
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
    if (!this.#availability.open) throw new DownhillError("shop_closed", SHOP_CLOSED, 409);
    const now = this.#now();
    this.#launchDay(now);
    const event = parseShopEvent(body, now);
    this.ledger.record(event);
    this.telemetry.emit(shopRecord(event));
    if (event.type === "promo_rejected") void this.alerts.onLiveRejection(now);
    return event;
  }

  /** What a player did in the game (rides, tricks, the shop), sent on as telemetry. Returns how many events. */
  game(body: unknown): number {
    const records = parseGameEvents(body, this.#now());
    for (const record of records) this.telemetry.emit(record);
    return records.length;
  }

  /** No sales while the shop is closed: it hasn't launched yet. */
  sales(): SalesRow[] {
    if (!this.#availability.open) return [];
    const now = this.#now();
    this.#launchDay(now);
    return this.ledger.rows(now);
  }

  salesCsv(): string {
    return toCsv(this.sales());
  }

  /** While the shop is closed, Incident Commander sees its code and history but an empty log. */
  service(): IncidentService {
    const now = this.#now();
    this.#launchDay(now);
    const service = incidentService(this.ledger, this.storefront, this.#config.version, now);
    if (this.#availability.open) return service;
    return { ...service, files: service.files.map((file) => (file.path === "logs/shop.log" ? { ...file, content: "" } : file)) };
  }

  availability(): ShopAvailability {
    return { ...this.#availability };
  }

  /**
   * Rolls the shop out or takes it down. Opening starts launch day over (launch three hours ago, with fresh sales, no
   * deployed fixes, and no alert), so the story plays from the start; closing resolves a firing alert.
   */
  async setOpen(open: boolean): Promise<ShopAvailability> {
    if (open === this.#availability.open) return { ...this.availability(), message: open ? "The Downhill Shop is already open." : "The Downhill Shop is already closed." };
    const now = this.#now();
    if (open) await this.reset({ restartTimeline: true });
    else await this.alerts.resolve(now, "The Downhill Shop was taken down: no checkouts run until it opens again.");
    this.#availability = { open, changedAt: new Date(now).toISOString() };
    try {
      writeJsonFile(join(this.#config.dataDir, "shop.json"), this.#availability);
    } catch (error) {
      log.warn(`Couldn't save whether the shop is open, so a restart may undo it: ${(error as Error).message}`);
    }
    log.info(open ? "Rolled out the Downhill Shop: launch day starts now" : "Took the Downhill Shop down", { event: open ? "shop.opened" : "shop.closed" });
    return { ...this.availability(), message: open ? "The Downhill Shop is open: launch day starts over, with launch three hours ago." : "The Downhill Shop is closed: no sales, checkouts, or alerts until it opens." };
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
    log.info("Deployed a storefront fix: checkout runs it now", { event: "deploy.completed", version: record.version, incident: record.incident, approvedBy: record.approvedBy, files: record.files.length });
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
    log.info("Reset the demo", { event: "demo.reset", storefront: version, timeline: options.restartTimeline ? "restarted" : "kept" });
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
      telemetry: this.telemetry.status(),
      storefront: this.storefront.info(),
      timeline: { startedAt: iso(startedAt), launchAt: iso(launchAt), bannerAt: iso(bannerAt) },
      liveEvents: this.ledger.liveCount,
      shop: this.availability(),
    };
  }

  /** What's off, said once at startup. */
  logConfiguration(): void {
    if (!this.alerts.configured) log.info(ALERTS_OFF);
    if (!this.#config.deploySecret) log.info(DEPLOYS_OFF);
    if (!this.telemetry.configured) log.info(TELEMETRY_OFF);
  }
}
