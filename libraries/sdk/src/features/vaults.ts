// Per-user vaults created in code (spec section 8).
//
// A vault created in code belongs to the account that created it: only that account's sessions can use it, and no API
// ever returns its values. Pass `{ gitHubToken }` to act for a specific user (for example a backend serving signed-in
// users), the same way `managed.client(env, { gitHubToken })` does; an app acts for its own users with `managed.as`.
import { ManagedCopilotError, ROUTES, type CreateVaultRequest, type VaultInfo } from "@managed-copilot/protocol";
import { httpForIdentity, type ManagedState } from "../connection.js";
import type { HttpClient } from "../http.js";
import { actingIdentity } from "../identity.js";
import type { ManagedVaults, VaultCallOptions } from "../types.js";

function clientFor(ctx: ManagedState, options: VaultCallOptions | undefined): HttpClient {
  if (options?.gitHubToken === undefined) return ctx.http;
  if (!options.gitHubToken) throw new ManagedCopilotError("authentication_required", "gitHubToken is empty; pass the user's GitHub token or omit it to act as this connection's account");
  return httpForIdentity(ctx, actingIdentity(ctx.identity, { gitHubToken: options.gitHubToken }));
}

function validate(request: CreateVaultRequest): void {
  if (!request || typeof request !== "object") throw new ManagedCopilotError("invalid_request", "vaults.create needs { name, credentials }");
  if (typeof request.name !== "string" || !request.name) throw new ManagedCopilotError("invalid_request", "vaults.create needs a vault name");
  if (!Array.isArray(request.credentials) || request.credentials.length === 0) {
    throw new ManagedCopilotError("invalid_request", "vaults.create needs at least one credential, e.g. { env: \"JIRA_TOKEN\", value, hosts: [\"contoso.atlassian.net\"] }");
  }
  request.credentials.forEach((credential, index) => {
    if (typeof credential?.value !== "string" || !credential.value) {
      throw new ManagedCopilotError("invalid_request", `credentials[${index}].value must be a non-empty string`);
    }
  });
}

export function createVaultsApi(ctx: ManagedState): ManagedVaults {
  return {
    async create(request, options) {
      validate(request);
      return clientFor(ctx, options).post<VaultInfo>(ROUTES.vaults, request);
    },
    async list(options) {
      return clientFor(ctx, options).get<VaultInfo[]>(ROUTES.vaults);
    },
    async delete(vaultId, options) {
      if (typeof vaultId !== "string" || !vaultId) throw new ManagedCopilotError("invalid_request", "vaults.delete needs a vault ID");
      await clientFor(ctx, options).delete(ROUTES.vault(vaultId));
    },
  };
}
