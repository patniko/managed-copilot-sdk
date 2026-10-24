/**
 * `aspire deploy` / `aspire publish` for Managed Copilot (Azure Container Apps). `addManagedCopilot` calls
 * `publishManagedCopilot` in publish mode; AppHosts publish their own apps with `publishApp`. Same AppHost, same
 * customer code: only where it runs changes.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { ManagedCopilotConfig } from "@managed-copilot/protocol";
import type { ManagedCopilotResource } from "../add.js";
import type { AspireBuilder } from "../aspire.js";
import type { ManagedCopilotOptions, SecretBinding } from "../options.js";
import { AzurePublishError, applyAccessRules, listSetting, prepareAzureConfig, rewriteWebhooks } from "./config.js";
import { expr, joinExpression } from "./expressions.js";
import { writeGatewayBuildFiles } from "./gateway-image.js";
import { EGRESS_BICEP } from "./egress.js";
import { SANDBOX_GROUP_BICEP } from "./sandbox-group.js";
import { imageMap, planEgressImage, planSandboxImages, pushEgressImage, pushSandboxImages, type EgressImagePlan, type SandboxImagePlan } from "./sandbox-images.js";
import type { PublishAzureResource, PublishBuilder, PublishContainer, PublishContainerResource, PublishEnvironmentResource, PublishValue } from "./types.js";

export { AzurePublishError } from "./config.js";
export type { PublishBuilder } from "./types.js";

/** The gateway's port inside its container (Container Apps ingress terminates TLS in front of it). */
export const GATEWAY_TARGET_PORT = 8080;
const GATEWAY_HEALTH_PATH = "/healthz";
const DEFAULT_ADDRESS_SPACE = "10.42.0.0/16";
const DATA_SHARE_GIB = 32;
const AMD64 = "LinuxAmd64";

export interface PublishInput {
  readonly config: ManagedCopilotConfig;
  readonly secrets: readonly SecretBinding[];
  readonly options: ManagedCopilotOptions;
  readonly appHostDirectory: string;
}

/** What `addManagedCopilot` returns in publish mode (the same shape as `aspire run`). */
export interface PublishedManagedCopilot {
  readonly name: string;
  readonly gateway: PublishContainerResource;
  /** The gateway's public HTTPS endpoint; inject it as `MANAGED_COPILOT_URL`. */
  readonly url: object;
  readonly config: ManagedCopilotConfig;
  readonly port: number;
  readonly dataDirectory: string;
}

interface Deployment {
  readonly name: string;
  readonly builder: PublishBuilder;
  readonly environment: PublishEnvironmentResource;
  readonly context: string;
  readonly npmRegistry: string;
  readonly appsByPort: Map<number, string>;
  /** One value per publish: a newer deployment's replicas take over the data volume's leases from older ones. */
  readonly stamp: string;
  /** Source ranges allowed to open the published apps (Parameters:app-allowed-ips, or this machine's public address). */
  allowedSources?: string;
  appToken?: object;
}

const deployments = new WeakMap<object, Deployment>();

/** An explicit environment credential must override Aspire's saved deployment parameter, without going through argv. */
export function appTokenParameterOptions(env: Readonly<Record<string, string | undefined>> = process.env): { secret: true; value?: string } {
  const value = env["Parameters__app-github-token"];
  if (value === undefined) return { secret: true };
  if (!value.trim()) throw new AzurePublishError("Parameters:app-github-token is empty. Provide the GitHub credential the published apps should use.");
  return { secret: true, value: value.trim() };
}

function hostNpmRegistry(): string {
  try {
    const registry = execSync("npm config get registry", { encoding: "utf8", timeout: 15_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (/^https?:\/\//.test(registry)) return registry;
  } catch {
    // reported below
  }
  throw new AzurePublishError("Images are built with your npm registry, but `npm config get registry` returned nothing. Configure npm, then deploy again.");
}

async function setting(builder: PublishBuilder, key: string): Promise<string | undefined> {
  const configuration = await builder.getConfiguration();
  return (await configuration.exists(key)) ? (await configuration.getConfigValue(key)).trim() : undefined;
}

function gatewayDirectory(options: ManagedCopilotOptions, appHostDirectory: string): string {
  if (options.gatewayDirectory) return resolve(appHostDirectory, options.gatewayDirectory);
  try {
    return dirname(createRequire(import.meta.url).resolve("@managed-copilot/gateway/package.json"));
  } catch {
    throw new AzurePublishError("Cannot find the @managed-copilot/gateway package. Run `pnpm install` at the repository root.");
  }
}

/** The installed version of a package as `fromDirectory` resolves it (its package.json need not be exported). */
function installedVersion(fromDirectory: string, name: string): string {
  try {
    let directory = dirname(createRequire(join(fromDirectory, "package.json")).resolve(name));
    for (;;) {
      const manifest = join(directory, "package.json");
      if (existsSync(manifest)) {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; version?: string };
        if (parsed.name === name && parsed.version) return parsed.version;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch {
    // reported below
  }
  throw new AzurePublishError(`Cannot find the installed version of ${name}. Run \`pnpm install\` at the repository root.`);
}

/** This machine's public IPv4 address, as the Internet sees it. */
async function publicAddress(): Promise<string | undefined> {
  try {
    const response = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(10_000) });
    const { ip } = (await response.json()) as { ip?: unknown };
    return typeof ip === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Who may open the published apps, which act as the deployer's GitHub account: Parameters:app-allowed-ips (IPv4 CIDRs,
 * comma-separated, or "*"), else this machine's public address.
 */
async function appAllowedSources(builder: PublishBuilder): Promise<string> {
  const configured = await setting(builder, "Parameters:app-allowed-ips");
  if (configured) return configured;
  const address = await publicAddress();
  if (!address) {
    throw new AzurePublishError(
      "The published apps act as your GitHub account, so their public address must be restricted, and this machine's public address could not be detected. " +
        'Set Parameters:app-allowed-ips to the IPv4 ranges allowed to open your apps (for example "203.0.113.7/32"), or to "*" to allow any address.',
    );
  }
  return `${address}/32`;
}

/** The pip index baked into sandbox images, as `aspire run` resolves it. */
function pipIndexUrl(): string | undefined {
  const configured = process.env.MANAGED_COPILOT_PIP_INDEX_URL;
  if (configured !== undefined) return configured || undefined;
  try {
    const listed = execSync("python -m pip config list", { encoding: "utf8", timeout: 20_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    return listed.split(/\r?\n/).map((line) => /^global\.index-url='(.*)'$/.exec(line.trim())?.[1]).find(Boolean) || undefined;
  } catch {
    return undefined;
  }
}

function amd64(container: PublishContainer): PublishContainer {
  // Azure Container Apps runs linux/amd64; the Dockerfiles build natively and only their final stage is emulated.
  return container.withContainerBuildOptions(async (context) => {
    await context.targetPlatform.set(AMD64);
  });
}

/** Declares the platform for Azure: a VNet-integrated Container Apps environment with NFS state, and the gateway. */
export async function publishManagedCopilot(builder: PublishBuilder, name: string, input: PublishInput): Promise<PublishedManagedCopilot> {
  const access = applyAccessRules(input.config, {
    githubUsers: listSetting(await setting(builder, `Parameters:${name}-github-users`)),
    githubOrgs: listSetting(await setting(builder, `Parameters:${name}-github-orgs`)),
  });
  const prepared = prepareAzureConfig(access, input.appHostDirectory);
  const addressSpace = (await setting(builder, `Parameters:${name}-address-space`)) ?? DEFAULT_ADDRESS_SPACE;
  const npmRegistry = hostNpmRegistry();

  const environment = await builder.addAzureContainerAppEnvironment(`${name}-env`).withManagedCopilotNetworkAndStorage(addressSpace, DATA_SHARE_GIB);
  const files = writeGatewayBuildFiles({ appHostDirectory: input.appHostDirectory, name, customizations: prepared.customizations });
  const platformKey = await builder.addParameterWithGeneratedValue(`${name}-platform-key`, { minLength: 48, special: false }, { secret: true, persist: true });

  const deployment: Deployment = { name, builder, environment, context: files.context, npmRegistry, appsByPort: new Map(), stamp: String(Date.now()) };
  let gateway = amd64(builder.addDockerfile(name, files.context, { dockerfilePath: files.dockerfile }).withBuildArg("NPM_REGISTRY", npmRegistry))
    .withHttpEndpoint({ targetPort: GATEWAY_TARGET_PORT, env: "PORT" })
    .withExternalHttpEndpoints()
    .withComputeEnvironment(environment)
    .publishAsManagedCopilotGateway(environment, GATEWAY_TARGET_PORT, GATEWAY_HEALTH_PATH)
    .withEnvironment("MANAGED_COPILOT_LEASE_STAMP", deployment.stamp)
    .withEnvironment("MANAGED_COPILOT_INSTANCE", name.slice(0, 24))
    .withEnvironment("MANAGED_COPILOT_PLATFORM_KEY", platformKey)
    .withEnvironment("MANAGED_COPILOT_SANDBOX_PROVIDER", "azure");
  for (const [parameter, variable] of [
    [`${name}-durable-key`, "MANAGED_COPILOT_DURABLE_KEY"],
    [`${name}-vault-key`, "MANAGED_COPILOT_VAULT_KEY"],
  ] as const) {
    // Optional (32 bytes, base64). Without them the gateway keeps generated keys in its data directory (the NFS share).
    if (await setting(builder, `Parameters:${parameter}`)) gateway = gateway.withEnvironment(variable, await builder.addParameter(parameter, { secret: true }));
  }
  for (const secret of input.secrets) gateway = gateway.withEnvironment(secret.env, secret.value);
  const plan = Object.keys(prepared.sandboxImages).length > 0 ? planSandboxImages({
    name,
    sandboxContext: join(gatewayDirectory(input.options, input.appHostDirectory), "..", "sandbox"),
    azureLayerContext: join(files.context, "deploy", "azure", "sandbox"),
    appHostDirectory: input.appHostDirectory,
    environments: prepared.sandboxImages,
    npmRegistry,
    pipIndexUrl: pipIndexUrl(),
    sdkVersion: installedVersion(gatewayDirectory(input.options, input.appHostDirectory), "@github/copilot-sdk"),
  }) : undefined;
  if (plan) {
    const egress = planEgressImage(name, join(gatewayDirectory(input.options, input.appHostDirectory), "..", "egress"));
    const sandboxes = await sandboxGroup(builder, name, environment, plan, egress, addressSpace);
    gateway = gateway.withAzureUserAssignedIdentity(sandboxes.identity);
    for (const [variable, value] of sandboxes.env) gateway = gateway.withEnvironment(variable, value);
    // As with `aspire run`: import the sandbox images into disk images at start instead of on the first session.
    if (input.options.prepareSandboxes ?? true) gateway = gateway.withEnvironment("MANAGED_COPILOT_SANDBOX_PREPARE", "1");
  } else {
    // No sandboxes: nothing needs the sandbox egress proxy (shared sessions fetch through the gateway itself).
    gateway = gateway.withEnvironment("MANAGED_COPILOT_EGRESS", "off");
  }
  // Computed last, after every app is declared, so loopback webhooks can point at the deployed apps.
  gateway = gateway.withEnvironmentCallback(async (context) => {
    await context.environment().set("MANAGED_COPILOT_CONFIG", JSON.stringify(rewriteWebhooks(prepared.config, deployment.appsByPort)));
  });

  const resource = await gateway;
  const url = await resource.getEndpoint("http");
  await builder.pipeline().addStep(
    `print-${name}-url`,
    async (context) => {
      const domain = await (await environment.getOutput("AZURE_CONTAINER_APPS_ENVIRONMENT_DEFAULT_DOMAIN")).value();
      const summary = await context.summary();
      await summary.add("Managed Copilot", `https://${name}.${domain} (ManagedCopilot.connect({ url }), MANAGED_COPILOT_URL, or managed-copilot attach --url)`);
      if (deployment.allowedSources) {
        await summary.add("Apps open to", `${deployment.allowedSources === "*" ? "any address" : deployment.allowedSources} (change with Parameters:app-allowed-ips)`);
      }
    },
    { dependsOn: ["provision-azure-bicep-resources"], requiredBy: ["deploy"] },
  );
  const published: PublishedManagedCopilot = { name, gateway: resource, url, config: prepared.config, port: GATEWAY_TARGET_PORT, dataDirectory: "/data" };
  deployments.set(published, deployment);
  return published;
}

/**
 * Isolated placement: an Azure Container Apps Sandboxes group on the platform network, a gateway identity that can
 * manage only that group, and a deploy step that builds and pushes the sandbox images before the gateway starts.
 */
async function sandboxGroup(
  builder: PublishBuilder,
  name: string,
  environment: PublishEnvironmentResource,
  plan: SandboxImagePlan,
  egressImage: EgressImagePlan,
  addressSpace: string,
): Promise<{ identity: PublishAzureResource; env: [string, PublishValue][] }> {
  const identity = await builder.addAzureUserAssignedIdentity(`${name}-gateway-identity`);
  const group = await builder
    .addBicepTemplateString(`${name}-sandboxes`, SANDBOX_GROUP_BICEP)
    .withParameter("subnetId", { value: await environment.getOutput("MANAGED_COPILOT_SANDBOX_SUBNET_ID") })
    .withParameter("registryName", { value: await environment.getOutput("AZURE_CONTAINER_REGISTRY_NAME") })
    .withParameter("gatewayPrincipalId", { value: await identity.getOutput("principalId") });
  const loginServer = await environment.getOutput("AZURE_CONTAINER_REGISTRY_ENDPOINT");
  const registryName = await environment.getOutput("AZURE_CONTAINER_REGISTRY_NAME");

  // The sandboxes' egress proxy (external mode): its own internal environment on the egress subnet, linked to the gateway.
  const egressKey = await builder.addParameterWithGeneratedValue(`${name}-egress-key`, { minLength: 43, special: false }, { secret: true, persist: true });
  const egress = await builder
    .addBicepTemplateString(`${name}-egress`, EGRESS_BICEP)
    .withParameter("subnetId", { value: await environment.getOutput("MANAGED_COPILOT_EGRESS_SUBNET_ID") })
    .withParameter("storageAccountName", { value: await environment.getOutput("MANAGED_COPILOT_DATA_ACCOUNT_NAME") })
    .withParameter("logAnalyticsWorkspaceName", { value: await environment.getOutput("AZURE_LOG_ANALYTICS_WORKSPACE_NAME") })
    .withParameter("registryServer", { value: loginServer })
    .withParameter("registryIdentityId", { value: await environment.getOutput("AZURE_CONTAINER_REGISTRY_MANAGED_IDENTITY_ID") })
    .withParameter("image", { value: joinExpression([loginServer, `/${egressImage.repository}:${egressImage.tag}`]) })
    .withParameter("gatewayUrl", { value: joinExpression(["https://", name, ".", await environment.getOutput("AZURE_CONTAINER_APPS_ENVIRONMENT_DEFAULT_DOMAIN")]) })
    .withParameter("gatewayKey", { value: egressKey })
    .withParameter("protectedCidrs", { value: addressSpace });

  await builder.pipeline().addStep(
    `push-${name}-sandbox-images`,
    async (context) => {
      const step = await context.reportingStep();
      const task = await step.createTask("Checking the sandbox images in the registry");
      try {
        const [server, registry] = [await loginServer.value(), await registryName.value()];
        if (!server || !registry) throw new AzurePublishError("The container registry has not been provisioned yet.");
        const push = { registryName: registry, loginServer: server, report: async (message: string) => void (await task.updateTask(message)) };
        const result = await pushSandboxImages(plan, push);
        const proxy = await pushEgressImage(egressImage, push);
        const pushed = result.pushed.length + (proxy === "pushed" ? 1 : 0);
        await task.completeTask({ completionMessage: pushed > 0 ? `Pushed ${pushed} image(s)` : `Sandbox and egress images are up to date (${result.present.length + 1})` });
      } catch (error) {
        await task.completeTask({ completionMessage: (error as Error).message, completionState: "CompletedWithError" });
        throw error;
      }
    },
    // After the environment (whose outputs name the registry) exists, and before the egress proxy is deployed (the gateway,
    // which needs the sandbox images when it starts, is deployed after the proxy because it uses the proxy's address).
    {
      dependsOn: [`provision-${name}-env`, "check-container-runtime"],
      requiredBy: [`provision-${name}-egress`, "provision-azure-bicep-resources"],
    },
  );

  return {
    identity,
    env: [
      ["MANAGED_COPILOT_AZURE_CREDENTIAL", "managed-identity"],
      ["MANAGED_COPILOT_AZURE_CLIENT_ID", await identity.getOutput("clientId")],
      ["MANAGED_COPILOT_AZURE_SUBSCRIPTION_ID", await group.getOutput("subscriptionId")],
      ["MANAGED_COPILOT_AZURE_RESOURCE_GROUP", await group.getOutput("resourceGroupName")],
      ["MANAGED_COPILOT_AZURE_SANDBOX_GROUP", await group.getOutput("name")],
      ["MANAGED_COPILOT_AZURE_REGION", await group.getOutput("region")],
      ["MANAGED_COPILOT_AZURE_VNET_CONNECTION", await group.getOutput("vnetConnection")],
      ["MANAGED_COPILOT_AZURE_REGISTRY", loginServer],
      ["MANAGED_COPILOT_AZURE_SANDBOX_IMAGES", imageMap(plan)],
      ["MANAGED_COPILOT_EGRESS", "external"],
      ["MANAGED_COPILOT_EGRESS_KEY", egressKey],
      ["MANAGED_COPILOT_AZURE_EGRESS_PROXY", await egress.getOutput("proxyAddress")],
    ],
  };
}

export interface PublishAppOptions {
  /** Resource name; also the app's host name inside the Container Apps environment. */
  readonly name: string;
  /** The app's Dockerfile, relative to the repository root (the build context). */
  readonly dockerfile: string;
  /** The port the app listens on (and its local port, which loopback webhooks name). */
  readonly port: number;
  /** Health route: 200 when the app serves (its readiness probe). */
  readonly healthPath: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Where the app keeps state; mounted from the platform's NFS share and owned by one replica at a time. Default `/data`. */
  readonly dataDirectory?: string;
  /** Environment variable that receives the app's own public URL. */
  readonly publicUrlEnv?: string;
  /** Environment variable that receives the host names the app answers: its public host and its in-environment name. */
  readonly allowedHostsEnv?: string;
  /** More environment variables that receive the gateway's public URL (`MANAGED_COPILOT_URL` is always set). */
  readonly gatewayUrlEnv?: readonly string[];
}

/**
 * Publishes an app that uses the platform (a demo or your own service). It acts as one GitHub account
 * (`app-github-token`), so its ingress only admits the source ranges in `Parameters:app-allowed-ips`.
 * Pass the AppHost's builder and the value `addManagedCopilot` returned (in publish mode).
 */
export async function publishApp(builder: AspireBuilder, copilot: ManagedCopilotResource, app: PublishAppOptions): Promise<PublishContainerResource> {
  const deployment = deployments.get(copilot);
  if (!deployment) throw new AzurePublishError("publishApp needs the value addManagedCopilot returned in publish mode.");
  const publisher = builder as unknown as PublishBuilder;
  const gatewayUrl = copilot.url as object;
  const holder = deployment.appsByPort.get(app.port);
  if (holder) throw new AzurePublishError(`Apps "${holder}" and "${app.name}" both use port ${app.port}; webhooks address apps by port.`);
  deployment.allowedSources ??= await appAllowedSources(publisher);
  const allowed = deployment.allowedSources;
  deployment.appsByPort.set(app.port, app.name);
  deployment.appToken ??= await publisher.addParameter("app-github-token", appTokenParameterOptions());

  const dataDirectory = app.dataDirectory ?? "/data";
  let container = amd64(publisher.addDockerfile(app.name, deployment.context, { dockerfilePath: app.dockerfile }).withBuildArg("NPM_REGISTRY", deployment.npmRegistry))
    .withHttpEndpoint({ targetPort: app.port, env: "PORT" })
    .withExternalHttpEndpoints()
    .withComputeEnvironment(deployment.environment)
    .publishAsManagedCopilotApp(deployment.environment, `apps/${app.name}`, dataDirectory, app.port, app.healthPath, allowed === "*" ? "" : allowed)
    // For the lease supervisor the app's image starts with (see demos/*/Dockerfile).
    .withEnvironment("MANAGED_COPILOT_DATA_DIR", dataDirectory)
    .withEnvironment("MANAGED_COPILOT_LEASE_STAMP", deployment.stamp)
    .withEnvironment("MANAGED_COPILOT_URL", gatewayUrl)
    .withEnvironment("MANAGED_COPILOT_GITHUB_TOKEN", deployment.appToken);
  for (const variable of app.gatewayUrlEnv ?? []) container = container.withEnvironment(variable, gatewayUrl);
  // Descriptors written for `aspire run` carry local values (for example a localhost public URL) for variables set here.
  const managed = new Set([
    "PORT",
    "MANAGED_COPILOT_DATA_DIR",
    "MANAGED_COPILOT_LEASE_STAMP",
    "MANAGED_COPILOT_URL",
    "MANAGED_COPILOT_GITHUB_TOKEN",
    ...(app.gatewayUrlEnv ?? []),
    app.publicUrlEnv,
    app.allowedHostsEnv,
  ]);
  for (const [variable, value] of Object.entries(app.env ?? {})) if (!managed.has(variable)) container = container.withEnvironment(variable, value);
  if (app.allowedHostsEnv) {
    const domain = await deployment.environment.getOutput("AZURE_CONTAINER_APPS_ENVIRONMENT_DEFAULT_DOMAIN");
    container = container.withEnvironment(app.allowedHostsEnv, expr`${app.name}.${domain},${app.name}`);
  }
  const resource = await container;
  if (app.publicUrlEnv) await resource.withEnvironment(app.publicUrlEnv, await resource.getEndpoint("http"));
  return resource;
}
