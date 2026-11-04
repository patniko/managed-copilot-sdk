// Environment fix-ups the Azure entrypoint applies before starting the gateway: values Azure Container Apps knows only
// at runtime (the app's public address and the environment's DNS suffix).

/** Written into MANAGED_COPILOT_CONFIG by `aspire deploy` (libraries/aspire/src/publish/config.ts) for the environment's domain. */
export const DNS_SUFFIX_PLACEHOLDER = "{{CONTAINER_APP_ENV_DNS_SUFFIX}}";

/** Completes the gateway's environment in place; returns a problem that must stop the start, if any. */
export function prepareGatewayEnvironment(env: NodeJS.ProcessEnv): string | undefined {
  const suffix = env.CONTAINER_APP_ENV_DNS_SUFFIX?.trim();
  // In Container Apps the gateway's public address is <app>.<environment's default domain>.
  if (env.MANAGED_COPILOT_MODE === "azure" && !env.MANAGED_COPILOT_PUBLIC_URL && env.CONTAINER_APP_NAME && suffix) {
    env.MANAGED_COPILOT_PUBLIC_URL = `https://${env.CONTAINER_APP_NAME}.${suffix}`;
  }
  // Webhooks to apps deployed with the platform name them by their address in the environment.
  if (env.MANAGED_COPILOT_CONFIG?.includes(DNS_SUFFIX_PLACEHOLDER)) {
    if (!suffix) {
      return `MANAGED_COPILOT_CONFIG refers to ${DNS_SUFFIX_PLACEHOLDER}, but CONTAINER_APP_ENV_DNS_SUFFIX (set by Azure Container Apps) is not set.`;
    }
    if (!/^[a-z0-9.-]+$/i.test(suffix)) return `CONTAINER_APP_ENV_DNS_SUFFIX "${suffix}" is not a DNS name.`;
    env.MANAGED_COPILOT_CONFIG = env.MANAGED_COPILOT_CONFIG.replaceAll(DNS_SUFFIX_PLACEHOLDER, suffix);
  }
  return undefined;
}
