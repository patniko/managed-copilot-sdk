/**
 * Turns the normalized AppHost configuration into what the gateway enforces in Azure. Pure functions (unit tested):
 *
 * - `customizations` folders are copied into the gateway image, so their host paths become image paths.
 * - Isolated environments' `image` folders and `packages.system` are built into images and pushed by `aspire deploy`;
 *   the gateway gets registry images.
 * - Webhooks that point at a local app (`http://localhost:<port>/...`) point at that app's HTTPS address in the
 *   Container Apps environment instead (`https://<app>.<environment domain>/...`), which stays inside the environment.
 * - A public deployment must say which GitHub accounts may use it.
 */
import { isAbsolute, relative, sep } from "node:path";
import type { ManagedCopilotConfig } from "@managed-copilot/protocol";

/** Where the gateway image keeps the AppHost files it needs (customizations). */
export const APPHOST_DIR_IN_IMAGE = "/opt/managed-copilot/apphost";

/**
 * The environment's domain, known only at runtime: the gateway's entrypoint (deploy/azure/src/lease/environment.ts)
 * replaces it in MANAGED_COPILOT_CONFIG with CONTAINER_APP_ENV_DNS_SUFFIX.
 */
export const DNS_SUFFIX_PLACEHOLDER = "{{CONTAINER_APP_ENV_DNS_SUFFIX}}";

/** A deployment problem the operator fixes in the AppHost; reported before anything is built or provisioned. */
export class AzurePublishError extends Error {
  override readonly name = "AzurePublishError";
}

/** What one environment's sandbox image is built from, on top of the base image. */
export interface SandboxImageSource {
  /** AppHost-relative folder (POSIX separators) with a Dockerfile FROM the base image. */
  readonly folder?: string;
  /** Operator-declared system packages (`packages.system`), installed in a layer of their own. */
  readonly system?: readonly string[];
}

export interface AzureGatewayConfig {
  /** Configuration for the deployed gateway (image paths, no host paths). */
  readonly config: ManagedCopilotConfig;
  /** AppHost-relative folders (POSIX separators) copied into the gateway image. */
  readonly customizations: readonly string[];
  /** Environment → what its image is built from; `*` is the base sandbox image for every other environment. */
  readonly sandboxImages: Readonly<Record<string, SandboxImageSource>>;
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
  const sandboxImages: Record<string, SandboxImageSource> = {};
  const environments: Record<string, ManagedCopilotConfig["environments"][string]> = {};
  for (const [name, environment] of Object.entries(config.environments)) {
    const next = { ...environment };
    if (environment.customizations) {
      const rel = appHostRelative(appHostDirectory, environment.customizations, `environments.${name}.customizations`);
      customizations.add(rel);
      next.customizations = `${APPHOST_DIR_IN_IMAGE}/${rel}`;
    }
    const folder = environment.image ? appHostRelative(appHostDirectory, environment.image, `environments.${name}.image`) : undefined;
    const system = [...new Set(environment.packages?.system ?? [])].sort();
    if (folder || system.length > 0) sandboxImages[name] = { ...(folder ? { folder } : {}), ...(system.length > 0 ? { system } : {}) };
    delete next.image;
    environments[name] = next;
  }
  const isolated = Object.values(config.environments).some((environment) => environment.type !== "shared") || (config.inline?.types ?? []).some((type) => type !== "shared");
  if (isolated) sandboxImages["*"] = {};
  return { config: { ...config, environments }, customizations: [...customizations].sort(), sandboxImages };
}

/** Who may use a deployment, from deploy-time settings (`Parameters:<name>-github-users` / `-github-orgs`). */
export interface DeployAccess {
  readonly githubUsers?: readonly string[];
  readonly githubOrgs?: readonly string[];
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
  const name = config.name;
  throw new AzurePublishError(
    `Managed Copilot "${name}" has no access rules, so any GitHub account could use the deployed platform (and run sandboxes in your subscription). ` +
      `Set Parameters:${name}-github-users to the GitHub logins allowed to use this deployment (for example \`aspire secret set Parameters:${name}-github-users your-login\`), ` +
      `or Parameters:${name}-github-orgs to their organizations. Alternatively add access: { githubUsers: [...] } to addManagedCopilot.`,
  );
}

/**
 * Who may operate a deployment (spec section 16): deploy-time settings (`Parameters:<name>-operator-users` /
 * `-operator-orgs`) add to the AppHost's `operators`. A deployment that names none keeps its operator console off.
 */
export function applyOperators(config: ManagedCopilotConfig, deploy: DeployAccess): ManagedCopilotConfig {
  const githubUsers = merge(config.operators?.githubUsers, deploy.githubUsers);
  const githubOrgs = merge(config.operators?.githubOrgs, deploy.githubOrgs);
  const { operators: _named, ...rest } = config;
  if (!githubUsers && !githubOrgs) return rest;
  return { ...rest, operators: { ...(githubUsers ? { githubUsers } : {}), ...(githubOrgs ? { githubOrgs } : {}) } };
}

function isLoopback(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host.endsWith(".localhost");
}

/**
 * Points loopback webhooks at the deployed app that serves that port, by its HTTPS address: plain HTTP between apps is
 * redirected to HTTPS by the environment's ingress, and the app's public host name is the one it accepts.
 */
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
    webhooks[name] = { ...hook, url: `https://${app}.${DNS_SUFFIX_PLACEHOLDER}${url.pathname}${url.search}` };
  }
  return { ...config, webhooks };
}
