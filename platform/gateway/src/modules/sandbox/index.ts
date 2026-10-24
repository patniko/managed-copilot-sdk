// Owner: sandbox workstream. Isolated placement: per-session sandboxes, setup, files, artifacts, and lifecycle.
import { ManagedCopilotError } from "@managed-copilot/protocol";
import type { GatewayModule } from "../../app.js";
import { ArtifactService } from "./artifacts.js";
import type { SandboxEventsPort } from "./contract.js";
import { DockerClient, resolveDockerEndpoints } from "./docker.js";
import { SandboxImages } from "./images.js";
import { DockerSandboxProvider } from "./provider.js";
import { registerSandboxRoutes } from "./routes.js";
import { SandboxService } from "./service.js";
import { SandboxStore } from "./store.js";

const INSTANCE = /^[a-z][a-z0-9-]{0,23}$/;

export const sandboxModule: GatewayModule = {
  name: "sandbox",
  register(app) {
    const log = app.log.child("sandbox");
    const env = app.config.env;

    // `warm` needs prepared, unassigned sandboxes that never hold another session's files or credentials. The local
    // Docker backend does not provide that, so nonzero values fail deployment (spec section 1) instead of being ignored.
    for (const [name, environment] of Object.entries(app.config.deployment.environments)) {
      if ((environment.warm ?? 0) > 0) {
        throw new ManagedCopilotError(
          "capability_unavailable",
          `Environment "${name}" requests warm: ${environment.warm}, but this backend cannot keep warm sandboxes safely. Remove "warm" (or set it to 0).`,
        );
      }
    }

    const instance = env.MANAGED_COPILOT_INSTANCE ?? "mc";
    if (!INSTANCE.test(instance)) throw new Error(`MANAGED_COPILOT_INSTANCE must be lowercase letters, digits, and hyphens (got "${instance}")`);
    const idle = Number(env.MANAGED_COPILOT_SANDBOX_IDLE_SECONDS ?? 900);

    const docker = new DockerClient(resolveDockerEndpoints(env));
    const store = new SandboxStore(app.db);
    const images = new SandboxImages({ docker, log, env, appHostDir: app.config.appHostDir, ...(env.MANAGED_COPILOT_SANDBOX_CONTEXT ? { contextDir: env.MANAGED_COPILOT_SANDBOX_CONTEXT } : {}) });
    const provider = new DockerSandboxProvider({
      docker,
      instance,
      platformKey: app.config.platformKey,
      log,
      relayImage: async () => (await images.ensureBase()).id,
      ...(env.MANAGED_COPILOT_SANDBOX_SUBNET_POOL ? { subnetPool: env.MANAGED_COPILOT_SANDBOX_SUBNET_POOL } : {}),
    });
    const service = new SandboxService({
      app,
      store,
      provider,
      images,
      docker,
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
      events: () => (app.services as Record<string, unknown>)["events"] as SandboxEventsPort | undefined,
    });
    service.attachArtifacts(artifacts);

    app.provide("sandboxes", service);
    app.provide("artifacts", artifacts);
    registerSandboxRoutes(app, { service, artifacts });

    app.onStart(() => service.start());
    app.onStop(() => service.shutdown());
  },
};
