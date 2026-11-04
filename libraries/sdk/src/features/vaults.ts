// Owner: network workstream. Per-user vaults created in code (spec section 8).
//
// A vault created in code belongs to the GitHub account that created it: only that account's sessions can use it, and
// no API ever returns its values. Pass `{ gitHubToken }` to act for a specific user (for example a backend serving
// signed-in users), the same way `managed.client(env, { gitHubToken })` does.
import { ManagedCopilotError, ROUTES, type CreateVaultRequest, type VaultInfo } from "@managed-copilot/protocol";
import type { ManagedContext, ManagedVaults, VaultCallOptions } from "../types.js";

function authorization(options: VaultCallOptions | undefined): Record<string, string> | undefined {
  if (options?.gitHubToken === undefined) return undefined;
  if (!options.gitHubToken) throw new ManagedCopilotError("authentication_required", "gitHubToken is empty; pass the user's GitHub token or omit it to act as this connection's account");
  return { authorization: ["Bearer", options.gitHubToken].join(" ") };
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

export function createVaultsApi(ctx: ManagedContext): ManagedVaults {
  return {
    async create(request, options) {
      validate(request);
      const headers = authorization(options);
      return ctx.http.post<VaultInfo>(ROUTES.vaults, request, headers ? { headers } : undefined);
    },
    async list(options) {
      const headers = authorization(options);
      return ctx.http.get<VaultInfo[]>(ROUTES.vaults, headers ? { headers } : undefined);
    },
    async delete(vaultId, options) {
      if (typeof vaultId !== "string" || !vaultId) throw new ManagedCopilotError("invalid_request", "vaults.delete needs a vault ID");
      const headers = authorization(options);
      await ctx.http.delete(ROUTES.vault(vaultId), headers ? { headers } : undefined);
    },
  };
}
