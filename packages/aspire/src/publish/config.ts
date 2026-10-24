/**
 * Turns the normalized AppHost configuration into what the gateway enforces in Azure. Pure functions (unit tested):
 *
 * - `customizations` folders are copied into the gateway image, so their host paths become image paths.
 * - Isolated environments' `image` folders are built and pushed by `aspire deploy`; the gateway gets registry images.
 * - Webhooks that point at a local app (`http://localhost:<port>/...`) point at that app inside the Container Apps
 *   environment instead (`http://<app>/...`).
 * - A public deployment must say which GitHub accounts may use it.
 */
import { isAbsolute, relative, sep } from "node:path";
import type { ManagedCopilotConfig } from "@managed-copilot/protocol";

/** Where the gateway image keeps the AppHost files it needs (customizations). */
export const APPHOST_DIR_IN_IMAGE = "/opt/managed-copilot/apphost";

/** A deployment problem the operator fixes in the AppHost; reported before anything is built or provisioned. */
export class AzurePublishError extends Error {
  override readonly name = "AzurePublishError";
}

export interface AzureGatewayConfig {
  /** Configuration for the deployed gateway (image paths, no host paths). */
  readonly config: ManagedCopilotConfig;
  /** AppHost-relative folders (POSIX separators) copied into the gateway image. */
  readonly customizations: readonly string[];
  /** Isolated environment → AppHost-relative image folder; `*` is the base sandbox image for the others. */
  readonly sandboxImages: Readonly<Record<string, string>>;
}

function appHostRelative(appHostDirectory: string, path: string, setting: string): string {
  const rel = relative(appHostDirectory, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new AzurePublishError(`${setting} (${path}) must be inside the AppHost directory to be deployed with it. Move it under ${appHostDirectory}.`);
  }
  return rel.split(sep).join("/");
}

export function prepareAzureConfig(config: ManagedCopilotConfig, appHostDirectory: string): AzureGatewayConfig {
  const customizations = new Set<string>();
  const sandboxImages: Record<string, string> = {};
  const environments: Record<string, ManagedCopilotConfig["environments"][string]> = {};
  for (const [name, environment] of Object.entries(config.environments)) {
    const next = { ...environment };
    if (environment.customizations) {
      const rel = appHostRelative(appHostDirectory, environment.customizations, `environments.${name}.customizations`);
      customizations.add(rel);
      next.customizations = `${APPHOST_DIR_IN_IMAGE}/${rel}`;
    }
    if (environment.image) {
      sandboxImages[name] = appHostRelative(appHostDirectory, environment.image, `environments.${name}.image`);
      delete next.image;
    }
    environments[name] = next;
  }
  const isolated = Object.values(config.environments).some((environment) => environment.type !== "shared") || (config.inline?.types ?? []).some((type) => type !== "shared");
  if (isolated) sandboxImages["*"] = "";
  return { config: { ...config, environments }, customizations: [...customizations].sort(), sandboxImages };
}

/** Who may use a deployment, from deploy-time settings (`Parameters:<name>-github-users` / `-github-orgs`). */
export interface DeployAccess {
  readonly githubUsers?: readonly string[];
  readonly githubOrgs?: readonly string[];
  /** `Parameters:<name>-allow-any-github-account` is "true": deploy without access rules on purpose. */
  readonly allowAnyAccount?: boolean;
}

/** Splits a comma- or whitespace-separated setting into its entries. */
export function listSetting(value: string | undefined): string[] {
  return (value ?? "").split(/[\s,]+/).filter(Boolean);
}

const merge = (...lists: (readonly string[] | undefined)[]): string[] | undefined => {
  const entries = [...new Set(lists.flatMap((list) => list ?? []))];
  return entries.length > 0 ? entries : undefined;
};

/**
 * A deployed gateway is reachable from the Internet; without access rules any GitHub account could run sessions billed
 * to you. Deploy-time settings add to the AppHost's own rules, so one AppHost can run locally and deploy unchanged.
 */
export function applyAccessRules(config: ManagedCopilotConfig, deploy: DeployAccess): ManagedCopilotConfig {
  const githubUsers = merge(config.access?.githubUsers, deploy.githubUsers);
  const githubOrgs = merge(config.access?.githubOrgs, deploy.githubOrgs);
  if (githubUsers || githubOrgs) return { ...config, access: { ...(githubUsers ? { githubUsers } : {}), ...(githubOrgs ? { githubOrgs } : {}) } };
  if (deploy.allowAnyAccount) return config;
  const name = config.name;
  throw new AzurePublishError(
    `Managed Copilot "${name}" has no access rules, so any GitHub account could use the deployed platform (and run sandboxes in your subscription). ` +
      `Set Parameters:${name}-github-users (for example \`aspire secret set Parameters:${name}-github-users your-login\`) or Parameters:${name}-github-orgs, ` +
      `add access: { githubUsers: [...] } to addManagedCopilot, or set Parameters:${name}-allow-any-github-account to "true" to deploy it open on purpose.`,
  );
}

function isLoopback(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host.endsWith(".localhost");
}

/** Points loopback webhooks at the deployed app that serves that port. */
export function rewriteWebhooks(config: ManagedCopilotConfig, appsByPort: ReadonlyMap<number, string>): ManagedCopilotConfig {
  if (!config.webhooks) return config;
  const webhooks: NonNullable<ManagedCopilotConfig["webhooks"]> = {};
  for (const [name, hook] of Object.entries(config.webhooks)) {
    const url = new URL(hook.url);
    if (!isLoopback(url)) {
      webhooks[name] = hook;
      continue;
    }
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const app = appsByPort.get(port);
    if (!app) {
      throw new AzurePublishError(
        `Webhook "${name}" calls ${hook.url}, which only exists on your machine, and no deployed app serves port ${port}. ` +
          "Deploy that app with publishApp(...) in the AppHost, or leave the webhook out when publishing.",
      );
    }
    webhooks[name] = { ...hook, url: `http://${app}${url.pathname}${url.search}` };
  }
  return { ...config, webhooks };
}
