// Incident Commander's control room: opens incidents from alerts, keeps one IncidentRun per incident, routes the
// platform's webhook deliveries to them, and publishes what changed to the browsers watching.
import { randomInt, randomUUID } from "node:crypto";
import { isManagedCopilotError, verifyWebhook, type VerifiedWebhookEvent } from "@managed-copilot/sdk";
import type { AlertInfo, AppState, IncidentSummary, IncidentView, IntegrationsView, ServerEvent } from "../shared/types.js";
import { parseAlertPayload, type IncomingAlert } from "./alerts.js";
import type { AppConfig } from "./config.js";
import { DEMO_SERVICE, sampleNotification, type DemoSeed } from "./demo.js";
import { AppError, errorText } from "./errors.js";
import type { EventHub } from "./hub.js";
import { IncidentRun, summarize } from "./incident.js";
import { log } from "./log.js";
import type { IncidentPlatform } from "./platform.js";
import type { ServiceCatalog } from "./services.js";
import type { Store } from "./store.js";

/** A re-sent alert notes "fired again" at most this often. */
const REFIRE_NOTE_MS = 10 * 60_000;

const SOURCE_LABEL: Record<AlertInfo["source"], string> = {
  simulated: "simulated",
  alertmanager: "Alertmanager",
  grafana: "Grafana",
  generic: "webhook",
};

export class Commander {
  readonly config: AppConfig;
  readonly platform: IncidentPlatform;
  readonly #store: Store;
  readonly #catalog: ServiceCatalog;
  readonly #hub: EventHub;
  readonly #runs = new Map<string, IncidentRun>();
  readonly #pending = new Set<string>();
  #publishTimer: NodeJS.Timeout | undefined;
  #summariesChanged = false;

  constructor(config: AppConfig, platform: IncidentPlatform, store: Store, catalog: ServiceCatalog, hub: EventHub) {
    this.config = config;
    this.platform = platform;
    this.#store = store;
    this.#catalog = catalog;
    this.#hub = hub;
  }

  start(): void {
    this.platform.onStatus((platform) => this.#hub.publish({ type: "platform", platform }));
    this.platform.onConnected(() => {
      for (const incident of this.#store.list()) void this.#run(incident.id).resume();
    });
  }

  async close(): Promise<void> {
    if (this.#publishTimer) clearTimeout(this.#publishTimer);
    await Promise.all([...this.#runs.values()].map((run) => run.close()));
    this.#store.flush();
  }

  #run(id: string): IncidentRun {
    let run = this.#runs.get(id);
    if (!run) {
      run = new IncidentRun(
        {
          config: this.config,
          platform: this.platform,
          store: this.#store,
          catalog: this.#catalog,
          workerEnvironment: () => this.platform.status.environments.find((env) => env.role === "worker")?.name ?? `${this.config.environment}-node`,
          changed: (changed) => this.#changed(changed),
        },
        id,
      );
      this.#runs.set(id, run);
    }
    return run;
  }

  // ─── Views ─────────────────────────────────────────────────────────────────────────────────────────────────

  integrations(): IntegrationsView {
    const lastWebhookAt = this.#store.lastWebhookAt;
    return {
      alertsUrl: `${this.config.publicUrl}/api/alerts`,
      alertsConfigured: this.config.alertSecret !== undefined,
      webhookConfigured: this.config.webhookSecret !== undefined,
      ...(lastWebhookAt ? { lastWebhookAt } : {}),
      deployConfigured: this.config.deploy !== undefined,
    };
  }

  summaries(): IncidentSummary[] {
    return this.#store.list().map(summarize);
  }

  state(): AppState {
    return { platform: this.platform.status, integrations: this.integrations(), incidents: this.summaries() };
  }

  /** What a browser gets first on the event stream. */
  initialEvents(): ServerEvent[] {
    return [
      { type: "platform", platform: this.platform.status },
      { type: "integrations", integrations: this.integrations() },
      { type: "incidents", incidents: this.summaries() },
    ];
  }

  view(id: string): IncidentView {
    if (!this.#store.get(id)) throw new AppError("not_found", `There's no incident ${id}.`, 404);
    return this.#run(id).view();
  }

  #changed(id: string): void {
    this.#pending.add(id);
    this.#summariesChanged = true;
    if (this.#publishTimer) return;
    this.#publishTimer = setTimeout(() => {
      this.#publishTimer = undefined;
      const ids = [...this.#pending];
      this.#pending.clear();
      for (const changed of ids) if (this.#store.get(changed)) this.#hub.publish({ type: "incident", incident: this.#run(changed).view() });
      if (this.#summariesChanged) {
        this.#summariesChanged = false;
        this.#hub.publish({ type: "incidents", incidents: this.summaries() });
      }
    }, 120);
    this.#publishTimer.unref?.();
  }

  // ─── Alerts ────────────────────────────────────────────────────────────────────────────────────────────────

  /** Alerts from a monitoring tool: each opens an incident, or updates the open one it belongs to. */
  async ingest(alerts: readonly IncomingAlert[]): Promise<string[]> {
    const ids: string[] = [];
    for (const { status, alert } of alerts) {
      const id = await this.#receive(status, alert);
      if (id) ids.push(id);
    }
    return [...new Set(ids)];
  }

  /** The labeled demo: a sample Alertmanager notification for the bundled demo service, with logs that match it. */
  async simulate(): Promise<string> {
    const demo: DemoSeed = { seed: randomInt(1, 2 ** 31), at: new Date().toISOString() };
    const { stats } = await this.#catalog.workspace(DEMO_SERVICE, demo);
    if (!stats) throw new AppError("demo_unavailable", "The demo service's files are missing from this installation.", 500);
    const [incoming] = parseAlertPayload(sampleNotification(stats, demo, randomUUID().replace(/-/g, "").slice(0, 16)));
    return this.#open({ ...incoming!.alert, source: "simulated" }, demo);
  }

  async #receive(status: IncomingAlert["status"], alert: AlertInfo): Promise<string> {
    const open = this.#store.openByFingerprint(alert.fingerprint);
    if (status === "resolved") {
      if (!open) return "";
      this.#store.update(open.id, (incident) => {
        incident.alert = { ...incident.alert, resolvedAt: alert.resolvedAt ?? new Date().toISOString() };
      });
      this.#store.note(open.id, "resolved", `${alert.name} resolved in ${SOURCE_LABEL[alert.source]}`);
      this.#changed(open.id);
      return open.id;
    }
    if (open) {
      const last = open.timeline.filter((entry) => entry.kind === "alert").at(-1);
      if (!last || Date.now() - Date.parse(last.at) > REFIRE_NOTE_MS) {
        this.#store.note(open.id, "alert", `${alert.name} fired again`);
        this.#changed(open.id);
      }
      return open.id;
    }
    const service = await this.#catalog.find(alert.service);
    const demo = service?.demo ? { seed: randomInt(1, 2 ** 31), at: new Date().toISOString() } : undefined;
    return this.#open(alert, demo, service?.version);
  }

  async #open(alert: AlertInfo, demo: DemoSeed | undefined, version?: string): Promise<string> {
    const resolvedVersion = version ?? (demo ? (await this.#catalog.find(alert.service))?.version : undefined);
    const incident = this.#store.create(alert, demo, resolvedVersion);
    this.#store.note(incident.id, "alert", `${alert.name} fired (${SOURCE_LABEL[alert.source]})`, alert.description ?? alert.summary, alert.startsAt);
    log.info("Opened an incident", { incident: incident.id, service: alert.service, severity: alert.severity, source: alert.source });
    this.#changed(incident.id);
    if (this.platform.status.state === "connected") void this.#run(incident.id).start();
    else {
      this.#store.update(incident.id, (stored) => {
        stored.problem = "Waiting for Managed Copilot. Copilot takes the incident as soon as it connects.";
      });
    }
    return incident.id;
  }

  // ─── The person ────────────────────────────────────────────────────────────────────────────────────────────

  #login(): string | undefined {
    return this.platform.status.account?.login;
  }

  async decide(id: string, approve: boolean, reason?: string): Promise<void> {
    this.view(id);
    await this.#run(id).decide(approve, reason, this.#login());
  }

  async message(id: string, text: string): Promise<void> {
    this.view(id);
    await this.#run(id).message(text, this.#login());
  }

  async delete(id: string): Promise<void> {
    this.view(id);
    await this.#run(id).delete();
    this.#runs.delete(id);
    this.#store.remove(id);
    this.#hub.publish({ type: "removed", id });
    this.#hub.publish({ type: "incidents", incidents: this.summaries() });
    log.info("Deleted an incident", { incident: id });
  }

  // ─── The platform's webhook ────────────────────────────────────────────────────────────────────────────────

  /** A signed delivery from the platform. Throws `AppError` for anything that doesn't verify. */
  async webhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): Promise<void> {
    const secret = this.config.webhookSecret;
    if (!secret) throw new AppError("webhook_not_configured", "Set INCIDENT_WEBHOOK_SECRET to receive the platform's webhook.", 503);
    let event: VerifiedWebhookEvent;
    try {
      // The action capability must be for the deployment this app is connected to.
      event = await verifyWebhook({ headers, rawBody }, secret, { seen: (eventId) => this.#store.seenWebhook(eventId), ...(this.platform.url ? { deploymentUrl: this.platform.url } : {}) });
    } catch (error) {
      if (isManagedCopilotError(error, "capability_unavailable")) throw new AppError("capability_unavailable", errorText(error), 501);
      log.warn("Rejected a webhook delivery", { error: errorText(error) });
      throw new AppError("invalid_signature", "Webhook verification failed.", 401);
    }
    const incident = event.sessionId ? this.#store.bySession(event.sessionId) : undefined;
    // Webhooks cover an environment other people's sessions may share: only this app's incidents are handled.
    if (incident && (!event.duplicate || event.type === "session.action_required")) {
      try {
        await this.#run(incident.id).webhook(event);
      } catch (error) {
        log.warn("Couldn't handle a webhook delivery", { incident: incident.id, type: event.type, error: errorText(error) });
      }
    }
    this.#store.recordWebhook(event.id);
    this.#hub.publish({ type: "integrations", integrations: this.integrations() });
  }
}
