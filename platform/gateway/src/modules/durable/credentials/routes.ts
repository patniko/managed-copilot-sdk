import { ROUTES } from "@managed-copilot/protocol";
import type { GatewayApp } from "../../../app.js";
import type { CredentialsService } from "../contract.js";

/** `managed-copilot login` / `logout`: the caller's own GitHub credential, never another account's. */
export function registerCredentialRoutes(app: GatewayApp, credentials: CredentialsService): void {
  app.routes.post(ROUTES.backgroundCredential, (ctx) => credentials.store(ctx.principal!));
  app.routes.get(ROUTES.backgroundCredential, (ctx) => credentials.status(ctx.principal!));
  app.routes.delete(ROUTES.backgroundCredential, (ctx) => {
    credentials.revoke(ctx.principal!);
    return credentials.status(ctx.principal!);
  });
}
