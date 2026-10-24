// Owner: sandbox workstream. Isolated placement: per-session sandboxes, setup, files, artifacts, and lifecycle.
import { ManagedCopilotError } from "@managed-copilot/protocol";
import type { GatewayModule } from "../../app.js";
import { ArtifactService } from "./artifacts.js";
import type { SandboxEventsPort } from "./contract.js";
import { createSandboxProvider } from "./providers/index.js";
import { registerSandboxRoutes } from "./routes.js";
import { SandboxService } from "./service.js";
import { SandboxStore } from "./store.js";

const INSTANCE = /^[a-z][a-z0-9-]{0,23}$/;
const FIRST_PROBE_WAIT_MS = 2_000;

export const sandboxModule: GatewayModule = {
  name: "sandbox",
  async register(app) {
    const log = app.log.child("sandbox");
    const env = app.config.env;

    const instance = env.MANAGED_COPILOT_INSTANCE ?? "mc";
    if (!INSTANCE.test(instance)) throw new Error(`MANAGED_COPILOT_INSTANCE must be lowercase letters, digits, and hyphens (got "${instance}")`);
    const idle = Number(env.MANAGED_COPILOT_SANDBOX_IDLE_SECONDS ?? 900);

    const provider = createSandboxProvider(env.MANAGED_COPILOT_SANDBOX_PROVIDER ?? "docker", {
      env,
      log,
      instance,
      platformKey: app.config.platformKey,
      appHostDir: app.config.appHostDir,
      dataDir: app.config.dataDir,
    });

    // `warm` needs prepared, unassigned sandboxes that never hold another session's files or credentials. Backends
    // that cannot provide that fail deployment for nonzero values (spec section 1) instead of ignoring them.
    for (const [name, environment] of Object.entries(app.config.deployment.environments)) {
      if ((environment.warm ?? 0) > 0 && !provider.capabilities.warm) {
        throw new ManagedCopilotError(
          "capability_unavailable",
          `Environment "${name}" requests warm: ${environment.warm}, but the ${provider.kind} sandbox backend cannot keep warm sandboxes safely. Remove "warm" (or set it to 0).`,
        );
      }
    }

    const store = new SandboxStore(app.db);
    const service = new SandboxService({
      app,
      store,
      provider,
      log,
      defaultIdleSeconds: Number.isFinite(idle) && idle > 0 ? idle : 900,
      prepareOnStart: env.MANAGED_COPILOT_SANDBOX_PREPARE === "1",
    });
    const artifacts = new ArtifactService({
      db: app.db,
      dataDir: app.config.dataDir,
      log,
      agentFor: (sessionId) => service.agentFor(sessionId),
      track: (sessionId, work) => service.track(sessionId, work),
      ownerOf: (sessionId) => store.bySession(sessionId)?.ownerId,
      sessionGone: (sessionId) => service.isGone(sessionId),
      settled: (sessionId) => service.settled(sessionId),
      stopping: () => service.stopping,
      events: () => (app.services as Record<string, unknown>)["events"] as SandboxEventsPort | undefined,
    });
    service.attachArtifacts(artifacts);

    app.provide("sandboxes", service);
    app.provide("artifacts", artifacts);
    registerSandboxRoutes(app, { service, artifacts });

    app.onStart(() => service.start());
    app.onStop(() => service.shutdown());

    // The gateway serves requests while start hooks run, so check the backend now: `/v1/info` then advertises isolated
    // placement correctly from the first request. A slow backend gets a short wait; the check finishes in the background.
    await Promise.race([service.probe(), new Promise((resolve) => setTimeout(resolve, FIRST_PROBE_WAIT_MS).unref())]);
  },
};
