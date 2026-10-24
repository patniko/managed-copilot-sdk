// Owner: core workstream. GitHub authentication and access rules, the /v1/connect JSON-RPC router, the shared
// runtime, admission, the session ledger, /v1/info, /v1/me, /v1/sessions, and /v1/events.
import type { GatewayModule } from "../../app.js";

export const coreModule: GatewayModule = {
  name: "core",
  register(app) {
    app.routes.get("/healthz", () => ({ status: "ok", version: app.config.version }), { auth: "none" });
  },
};
