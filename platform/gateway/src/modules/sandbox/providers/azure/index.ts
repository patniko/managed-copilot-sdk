// Owner: azure workstream. Isolated placement on Azure Container Apps Sandboxes (see provider.ts).
// Selected with MANAGED_COPILOT_SANDBOX_PROVIDER=azure; `aspire deploy` sets the MANAGED_COPILOT_AZURE_* settings.
import type { SandboxProvider, SandboxProviderDeps } from "../types.js";
import { SandboxApi } from "./api.js";
import { loadAzureConfig } from "./config.js";
import { AzureCliTokenSource, ManagedIdentityTokenSource, type TokenSource } from "./credential.js";
import { AzureSandboxProvider } from "./provider.js";
import { AcrCredentials } from "./registry.js";

export { AzureSandboxProvider } from "./provider.js";

export function createAzureSandboxProvider(deps: SandboxProviderDeps): SandboxProvider {
  const loaded = loadAzureConfig(deps.env);
  const config = loaded.config;
  let api: SandboxApi | undefined;
  let registry: AcrCredentials | undefined;
  if (config) {
    const tokens: TokenSource =
      config.credential === "cli"
        ? new AzureCliTokenSource()
        : new ManagedIdentityTokenSource({ endpoint: deps.env.IDENTITY_ENDPOINT!, header: deps.env.IDENTITY_HEADER!, ...(config.clientId ? { clientId: config.clientId } : {}) });
    api = new SandboxApi({
      endpoint: config.endpoint,
      subscriptionId: config.subscriptionId,
      resourceGroup: config.resourceGroup,
      sandboxGroup: config.sandboxGroup,
      apiVersion: config.apiVersion,
      tokens,
    });
    // The gateway's identity pulls the deployment's sandbox images (AcrPull on the registry).
    registry = new AcrCredentials(tokens);
  } else {
    deps.log.warn("The Azure sandbox backend is not configured; isolated sessions will fail until it is", { problems: loaded.problems });
  }
  return new AzureSandboxProvider(deps, loaded, api, registry ? { registryCredentials: (image) => registry.credentialsFor(image) } : {});
}
