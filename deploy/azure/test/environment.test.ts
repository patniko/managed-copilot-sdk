import { describe, expect, it } from "vitest";
import { DNS_SUFFIX_PLACEHOLDER, prepareGatewayEnvironment } from "../src/lease/environment.js";

const suffix = "calmsea-1a2b3c4d.westus2.azurecontainerapps.io";

describe("prepareGatewayEnvironment", () => {
  it("derives the gateway's public URL in Azure mode only, and never overrides one", () => {
    const azure: NodeJS.ProcessEnv = { MANAGED_COPILOT_MODE: "azure", CONTAINER_APP_NAME: "copilot", CONTAINER_APP_ENV_DNS_SUFFIX: suffix };
    expect(prepareGatewayEnvironment(azure)).toBeUndefined();
    expect(azure.MANAGED_COPILOT_PUBLIC_URL).toBe(`https://copilot.${suffix}`);

    const app: NodeJS.ProcessEnv = { CONTAINER_APP_NAME: "assistant", CONTAINER_APP_ENV_DNS_SUFFIX: suffix };
    prepareGatewayEnvironment(app);
    expect(app.MANAGED_COPILOT_PUBLIC_URL).toBeUndefined();

    const explicit: NodeJS.ProcessEnv = { ...azure, MANAGED_COPILOT_PUBLIC_URL: "https://copilot.example.com" };
    prepareGatewayEnvironment(explicit);
    expect(explicit.MANAGED_COPILOT_PUBLIC_URL).toBe("https://copilot.example.com");
  });

  it("fills in the environment's domain in webhook URLs, and refuses to start without it", () => {
    const config = JSON.stringify({ webhooks: { assistant: { url: `https://assistant.${DNS_SUFFIX_PLACEHOLDER}/api/copilot-events` } } });
    const env: NodeJS.ProcessEnv = { MANAGED_COPILOT_CONFIG: config, CONTAINER_APP_ENV_DNS_SUFFIX: suffix };
    expect(prepareGatewayEnvironment(env)).toBeUndefined();
    expect(JSON.parse(env.MANAGED_COPILOT_CONFIG!).webhooks.assistant.url).toBe(`https://assistant.${suffix}/api/copilot-events`);

    expect(prepareGatewayEnvironment({ MANAGED_COPILOT_CONFIG: config })).toMatch(/CONTAINER_APP_ENV_DNS_SUFFIX \(set by Azure Container Apps\) is not set/);
    expect(prepareGatewayEnvironment({ MANAGED_COPILOT_CONFIG: config, CONTAINER_APP_ENV_DNS_SUFFIX: 'x"}' })).toMatch(/is not a DNS name/);
  });
});
