// GitHub authentication and access rules, the /v1/connect JSON-RPC router, the shared
// runtime, admission, the session ledger, /v1/info, /v1/me, /v1/sessions, and /v1/events.
import { join } from "node:path";
import { ROUTES } from "@managed-copilot/protocol";
import type { GatewayModule } from "../../app.js";
import { AppRegistry } from "./apps.js";
import { GitHubAuthenticator } from "./auth.js";
import { Environments } from "./environments.js";
import { PlatformEvents } from "./events.js";
import { SessionLedger } from "./ledger.js";
import { CoreOperator } from "./operator.js";
import { PlatformTools, RuntimeRequests } from "./registries.js";
import { registerConnectRoute } from "./router.js";
import { registerRoutes } from "./routes.js";
import { SharedRuntime } from "./runtime.js";
import { SessionManager } from "./sessions.js";

export const coreModule: GatewayModule = {
  name: "core",
  register(app) {
    const log = app.log.child("core");
    app.routes.get("/healthz", () => ({ status: "ok", version: app.config.version }), { auth: "none" });

    const ledger = new SessionLedger(app.db);
    const apps = new AppRegistry({ deployment: app.config.deployment, env: app.config.env, ledger, log: log.child("apps") });
    const auth = new GitHubAuthenticator({
      apiUrl: app.config.githubApiUrl,
      ...(app.config.deployment.access ? { access: app.config.deployment.access } : {}),
      apps,
      log: log.child("auth"),
    });
    if (app.config.mode === "azure" && !app.config.deployment.access?.githubOrgs?.length && !app.config.deployment.access?.githubUsers?.length) {
      log.warn("No access rules configured: any GitHub account can use this deployment. Set access.githubOrgs or access.githubUsers in the AppHost.");
    }
    for (const declared of apps.list()) {
      if (declared.anyGitHubUser) log.info("App admits any GitHub account through its key", { app: declared.name, environments: declared.environments });
    }
    const events = new PlatformEvents(ledger, log.child("events"), () => app.metrics.increment("events.published"));
    const environments = new Environments({ deployment: app.config.deployment, baseDir: app.config.appHostDir, pinDir: join(app.config.dataDir, "customizations"), log });
    const platformTools = new PlatformTools();
    const runtimeRequests = new RuntimeRequests();

    let manager: SessionManager | undefined;
    const runtime = app.config.sharedRuntime.enabled
      ? new SharedRuntime({
          log: log.child("runtime"),
          root: join(app.config.dataDir, "runtime", "shared"),
          env: app.config.env,
          ...(app.config.sharedRuntime.path ? { binary: app.config.sharedRuntime.path } : {}),
          ...(app.config.sharedRuntime.url ? { externalUrl: app.config.sharedRuntime.url } : {}),
          ...(app.config.sharedRuntime.token ? { externalToken: app.config.sharedRuntime.token } : {}),
          logLevel: app.config.sharedRuntime.logLevel,
          handlers: {
            onNotification: (upstream, method, params) => manager?.upstreamHandlers.onNotification(upstream, method, params),
            onRequest: (upstream, method, params, context) => manager!.upstreamHandlers.onRequest(upstream, method, params, context),
            onClose: (upstream, error) => manager?.upstreamHandlers.onClose?.(upstream, error),
          },
        })
      : undefined;
    manager = new SessionManager({ app, log: log.child("sessions"), ledger, environments, events, platformTools, runtimeRequests, auth, sharedRuntime: runtime });
    const sessions = manager;
    // Counted from the platform event every create publishes, whichever path created the session.
    events.subscribe((event) => {
      if (event.type === "session.created") app.metrics.increment("sessions.created");
    });

    // Per-session user credentials for shared sessions: the runtime asks the gateway, never a shared service token.
    runtimeRequests.register("gitHubToken.getToken", ({ params }) => sessions.answerTokenRequest(params), { upstream: "shared" });
    // Foundry sessions on the shared runtime: an Entra ID token for their account, per model call (spec section 15).
    runtimeRequests.register("providerToken.getToken", ({ params }) => sessions.answerProviderTokenRequest(params), { upstream: "shared" });

    app.provide("auth", auth);
    app.provide("apps", apps);
    app.provide("sessions", sessions);
    app.provide("events", events);
    app.provide("platformTools", platformTools);
    app.provide("runtimeRequests", runtimeRequests);
    app.provide("environments", environments);

    registerRoutes(app, { manager: sessions, environments, events, runtime });
    const connectRoute = registerConnectRoute({ app, log: log.child("router"), manager: sessions, environments, runtime }, ROUTES.connect);
    const operator = new CoreOperator({ app, ledger, manager: sessions, runtime, environments, platformTools, connections: () => connectRoute.connections() });
    app.provide("coreOperator", operator);

    app.onStart(async () => {
      if (!runtime) {
        log.warn("The shared runtime is disabled (MANAGED_COPILOT_SHARED_RUNTIME=0); shared environments are unavailable");
      } else {
        try {
          await runtime.start();
        } catch (error) {
          log.error("The shared runtime could not start; shared sessions will fail with capability_unavailable", { error: (error as Error).message });
        }
      }
      // In the background: deletions and creates a stopped gateway left half done.
      void sessions.recover().catch((error: unknown) => log.warn("Session recovery failed", { error: (error as Error).message }));
    });
    app.onStop(async () => {
      connectRoute.close();
      operator.close();
      sessions.close();
      await runtime?.stop();
    });
  },
};
