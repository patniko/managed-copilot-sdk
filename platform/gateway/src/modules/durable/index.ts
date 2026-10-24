// Owner: durable workstream. Durable actions, webhooks, polling, schedules, agent scheduling tools, and
// background credentials (spec sections 2, 12, 13; gate G2). The contract with core is ./contract.ts.
import type { PlatformEvent } from "@managed-copilot/protocol";
import type { GatewayModule } from "../../app.js";
import { migrate } from "../../db.js";
import { DurableActions } from "./actions/service.js";
import { registerActionRoutes } from "./actions/routes.js";
import type { DurableEventsPort, DurablePlatformToolsPort, DurableSessionsPort, PlatformEventMeta } from "./contract.js";
import { registerCredentialRoutes } from "./credentials/routes.js";
import { DurableCredentials } from "./credentials/service.js";
import { loadDurableKeys } from "./keys.js";
import { DURABLE_MIGRATIONS, upgradeDurableSchema } from "./migrations.js";
import { registerScheduleRoutes } from "./schedules/routes.js";
import { DurableSchedules } from "./schedules/service.js";
import { registerScheduleTools } from "./schedules/tools.js";
import { registerWebhookRoutes } from "./webhooks/routes.js";
import { DurableWebhooks } from "./webhooks/service.js";

/** Core's services, read structurally so this module also loads (degraded) without them. */
function port<T>(services: object, key: string): T | undefined {
  return (services as Record<string, unknown>)[key] as T | undefined;
}

/**
 * How the ledger announces actions. Core's bus isolates subscriber errors, so a bus publish cannot prove the webhook
 * deliveries were queued: the outbox rows are written first and a failure reaches the ledger, which then leaves the
 * action unannounced for the sweeper to repair. The bus still fans the event out (SSE); its webhook subscriber finds
 * the rows already queued (one per webhook and event ID).
 */
export function announcer(
  webhooks: () => Pick<DurableWebhooks, "enqueue"> | undefined,
  events: () => DurableEventsPort | undefined,
): (event: PlatformEvent, meta: PlatformEventMeta) => void {
  return (event, meta) => {
    webhooks()?.enqueue(event, meta);
    events()?.publish(event, meta);
  };
}

export const durableModule: GatewayModule = {
  name: "durable",
  register(app) {
    const log = app.log.child("durable");
    migrate(app.db, "durable", DURABLE_MIGRATIONS);
    upgradeDurableSchema(app.db);
    const keys = loadDurableKeys(app.config.dataDir, app.config.env);
    const deployment = app.config.deployment;
    const sessions = () => port<DurableSessionsPort>(app.services, "sessions");
    const events = () => port<DurableEventsPort>(app.services, "events");
    const platformTools = () => port<DurablePlatformToolsPort>(app.services, "platformTools");

    let webhooks: DurableWebhooks | undefined;
    // Platform events go through core's bus (SSE and webhooks both subscribe); without it, straight to webhooks.
    const publish = (event: PlatformEvent, meta: PlatformEventMeta) => {
      const bus = events();
      if (bus) bus.publish(event, meta);
      else webhooks?.enqueue(event, meta);
    };

    const actions = new DurableActions({
      db: app.db,
      log: log.child("actions"),
      capabilityKey: keys.capability,
      publicUrl: app.config.publicUrl,
      sessions,
      platformTools,
      publish: announcer(() => webhooks, events),
    });
    webhooks = new DurableWebhooks({ db: app.db, log: log.child("webhooks"), deployment, mode: app.config.mode, env: app.config.env, actions: () => actions });
    let schedules: DurableSchedules | undefined;
    const credentials = new DurableCredentials({ db: app.db, log: log.child("credentials"), sealKey: keys.seal, auth: () => app.services.auth, schedules: () => schedules });
    schedules = new DurableSchedules({ db: app.db, log: log.child("schedules"), deployment, sessions, credentials: () => credentials, actions: () => actions, publish });

    app.provide("actions", actions);
    app.provide("webhooks", webhooks);
    app.provide("schedules", schedules);
    app.provide("credentials", credentials);

    registerActionRoutes(app, actions);
    registerScheduleRoutes(app, schedules);
    registerCredentialRoutes(app, credentials);
    registerWebhookRoutes(app, webhooks);

    // Registered now so core injects them into the first sessions of environments with `scheduling: true`.
    const tools = platformTools();
    if (tools) registerScheduleTools(tools, { deployment, schedules, credentials: () => credentials });
    else log.warn("No platform tool registry; schedule_task, list_schedules, and cancel_schedule are unavailable");

    for (const [name, declaration] of Object.entries(deployment.schedules ?? {})) {
      if (!declaration.runAs) {
        log.error("AppHost schedule has no runAs account, so it cannot run: schedules run as a person who approved them", { schedule: name });
      } else {
        log.info("AppHost schedule runs only after its account approves it (managed-copilot login, then resume it)", { schedule: name, runAs: declaration.runAs });
      }
    }

    const disposers: (() => void)[] = [];
    // Session lifecycle that changes what may still be answered: deletion cancels a session's actions and stops their
    // deliveries; promotion moves them to the new placement generation (stale owners are fenced).
    const onLifecycle = async (event: PlatformEvent) => {
      if (!event.sessionId) return;
      if (event.type === "session.deleted") {
        // Only the deleted incarnation: a later session that reuses the ID is a different session.
        const incarnation = typeof event.data.incarnation === "string" ? event.data.incarnation : undefined;
        actions.onSessionDeleted(event.sessionId, incarnation);
        webhooks!.dropSession(event.sessionId);
        schedules!.onSessionDeleted(event.sessionId, incarnation);
      } else if (event.type === "session.promoted") {
        // Promotion normally calls actions.onGenerationChanged directly first; repeating it here is a no-op.
        const generation = typeof event.data.generation === "number" ? event.data.generation : (await sessions()?.get(event.sessionId))?.generation;
        const carried = Array.isArray(event.data.carried) ? event.data.carried.filter((id): id is string => typeof id === "string") : undefined;
        if (generation !== undefined) actions.onGenerationChanged(event.sessionId, generation, carried ? { carried } : {});
      }
    };
    app.onStart(() => {
      const bus = events();
      if (bus) {
        disposers.push(
          bus.subscribe((event, meta) => {
            void onLifecycle(event).catch((error: unknown) => log.error("Handling a session lifecycle event failed", { type: event.type, error: (error as Error).message }));
            webhooks!.enqueue(event, meta);
          }),
        );
      }
      actions.start();
      webhooks!.start();
      schedules!.start();
      const subscriptions = webhooks!.subscriptionNames;
      log.info("Durable actions, webhooks, and schedules ready", subscriptions.length > 0 ? { webhooks: subscriptions } : undefined);
    });
    app.onStop(async () => {
      for (const dispose of disposers.splice(0)) dispose();
      await schedules!.stop();
      actions.stop();
      await webhooks!.stop();
    });
  },
};
