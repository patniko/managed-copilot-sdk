/**
 * `aspire deploy` / `aspire publish` for Managed Copilot (Azure Container Apps). `addManagedCopilot` calls
 * `publishManagedCopilot` in publish mode; AppHosts publish their own apps with `publishApp`. Same AppHost, same
 * customer code: only where it runs changes.
 */
import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { ManagedCopilotConfig } from "@managed-copilot/protocol";
import { appKeyLookup, type ManagedCopilotResource } from "../add.js";
import type { AspireBuilder } from "../aspire.js";
import { appKeyParameterName, type AppKeyBinding, type ManagedCopilotOptions, type SecretBinding } from "../options.js";
import { AzurePublishError, applyAccessRules, applyOperators, listSetting, prepareAzureConfig, rewriteWebhooks } from "./config.js";
import { expr, joinExpression } from "./expressions.js";
import { writeGatewayBuildFiles } from "./gateway-image.js";
import { EGRESS_BICEP } from "./egress.js";
import { FOUNDRY_ACCESS_BICEP } from "./foundry.js";
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
  /** Declared apps and the gateway variables their generated keys go in. */
  readonly apps?: readonly AppKeyBinding[];
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
  /** An app's key (spec section 2); `publishApp(..., { app })` injects it as `MANAGED_COPILOT_APP_KEY`. */
  appKey(app: string): object;
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
  /** Source ranges allowed to open the apps that aren't public (Parameters:app-allowed-ips, or this machine's public address). */
  allowedSources?: string;
  appToken?: object;
  /** Apps behind `allowedSources`, and whether each acts as the deployment's GitHub account. */
  readonly restrictedApps: { readonly name: string; readonly actsAsAccount: boolean }[];
  /** Apps open to any address (`public: true`). */
  readonly publicApps: string[];
  /** Declared apps' keys, by app name. */
  readonly appKeys: ReadonlyMap<string, object>;
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
  if (await configuration.exists(key)) return (await configuration.getConfigValue(key)).trim();
  // `aspire deploy` runs the AppHost as Production, without user secrets; `npx managed-copilot deploy` passes its
  // settings in this process's environment instead (`Parameters:x` as `Parameters__x`).
  const value = process.env[key.replaceAll(":", "__")]?.trim();
  return value ? value : undefined;
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
 * Who may open the published apps that aren't public (`public: true`), most of which act as the deployer's GitHub
 * account: Parameters:app-allowed-ips (IPv4 CIDRs, comma-separated, or "*"), else this machine's public address.
 */
async function appAllowedSources(builder: PublishBuilder): Promise<string> {
  const configured = await setting(builder, "Parameters:app-allowed-ips");
  if (configured) return configured;
  const address = await publicAddress();
  if (!address) {
    throw new AzurePublishError(
      "Apps that aren't public open only from Parameters:app-allowed-ips, which defaults to this machine's public address, and this machine's public address could not be detected. " +
        'Set Parameters:app-allowed-ips to the IPv4 ranges allowed to open them (for example "203.0.113.7/32"), or to "*" to allow any address. ' +
        "An app that signs in its own users can be published with public: true instead.",
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
  const access = applyOperators(
    applyAccessRules(input.config, {
      githubUsers: listSetting(await setting(builder, `Parameters:${name}-github-users`)),
      githubOrgs: listSetting(await setting(builder, `Parameters:${name}-github-orgs`)),
    }),
    {
      githubUsers: listSetting(await setting(builder, `Parameters:${name}-operator-users`)),
      githubOrgs: listSetting(await setting(builder, `Parameters:${name}-operator-orgs`)),
    },
  );
  const prepared = prepareAzureConfig(access, input.appHostDirectory);
  const addressSpace = (await setting(builder, `Parameters:${name}-address-space`)) ?? DEFAULT_ADDRESS_SPACE;
  const npmRegistry = hostNpmRegistry();

  const environment = await builder.addAzureContainerAppEnvironment(`${name}-env`).withManagedCopilotNetworkAndStorage(addressSpace, DATA_SHARE_GIB);
  const files = writeGatewayBuildFiles({ appHostDirectory: input.appHostDirectory, name, customizations: prepared.customizations });
  const platformKey = await builder.addParameterWithGeneratedValue(`${name}-platform-key`, { minLength: 48, special: false }, { secret: true, persist: true });
  // The same parameters as `aspire run`, so an app keeps its key between the two (an explicit Parameters:<name> wins).
  const appKeys = new Map<string, object>();
  for (const { app } of input.apps ?? []) {
    appKeys.set(app, await builder.addParameterWithGeneratedValue(appKeyParameterName(name, app), { minLength: 48, special: false }, { secret: true, persist: true }));
  }

  const deployment: Deployment = {
    name,
    builder,
    environment,
    context: files.context,
    npmRegistry,
    appsByPort: new Map(),
    stamp: String(Date.now()),
    restrictedApps: [],
    publicApps: [],
    appKeys,
  };
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
    // Sealing keys live in secret parameters, not beside the sealed values on the NFS share. 43 alphanumeric
    // characters decode to 32 bytes; an explicitly set Parameters:<parameter> (32 bytes, base64) is used instead.
    // The gateway wraps a key file an earlier deployment generated in /data under this key, keeping its values readable.
    const key = await builder.addParameterWithGeneratedValue(parameter, { minLength: 43, special: false }, { secret: true, persist: true });
    gateway = gateway.withEnvironment(variable, key);
  }
  for (const secret of input.secrets) gateway = gateway.withEnvironment(secret.env, secret.value);
  for (const { app, env } of input.apps ?? []) gateway = gateway.withEnvironment(env, appKeys.get(app)!);
  const plan = Object.keys(prepared.sandboxImages).length > 0 ? planSandboxImages({
    name,
    sandboxContext: join(gatewayDirectory(input.options, input.appHostDirectory), "..", "sandbox"),
    azureLayerContext: join(files.context, "deployments", "azure", "sandbox"),
    appHostDirectory: input.appHostDirectory,
    environments: prepared.sandboxImages,
    npmRegistry,
    pipIndexUrl: pipIndexUrl(),
    sdkVersion: installedVersion(gatewayDirectory(input.options, input.appHostDirectory), "@github/copilot-sdk"),
  }) : undefined;
  const foundryAccounts = Object.entries(prepared.config.foundry ?? {});
  // The gateway's own Azure identity: it manages the sandboxes and calls the Foundry accounts.
  const identity = plan || foundryAccounts.length > 0 ? await builder.addAzureUserAssignedIdentity(`${name}-gateway-identity`) : undefined;
  if (identity) {
    gateway = gateway
      .withAzureUserAssignedIdentity(identity)
      .withEnvironment("MANAGED_COPILOT_AZURE_CREDENTIAL", "managed-identity")
      .withEnvironment("MANAGED_COPILOT_AZURE_CLIENT_ID", await identity.getOutput("clientId"));
  }
  if (plan) {
    const egress = planEgressImage(name, join(gatewayDirectory(input.options, input.appHostDirectory), "..", "egress"));
    const sandboxes = await sandboxGroup(builder, name, environment, plan, egress, addressSpace, identity!);
    for (const [variable, value] of sandboxes.env) gateway = gateway.withEnvironment(variable, value);
    // As with `aspire run`: import the sandbox images into disk images at start instead of on the first session.
    if (input.options.prepareSandboxes ?? true) gateway = gateway.withEnvironment("MANAGED_COPILOT_SANDBOX_PREPARE", "1");
  } else {
    // No sandboxes: nothing needs the sandbox egress proxy (shared sessions fetch through the gateway itself).
    gateway = gateway.withEnvironment("MANAGED_COPILOT_EGRESS", "off");
  }
  if (identity && foundryAccounts.length > 0) {
    const configured = await setting(builder, "Azure:SubscriptionId");
    let deploymentSubscription: PublishValue | undefined = configured;
    for (const [account, declared] of foundryAccounts) {
      const access = await builder
        .addBicepTemplateString(`${name}-foundry-${resourceSuffix(account)}`, FOUNDRY_ACCESS_BICEP)
        .withParameter("accountName", { value: account })
        .withParameter("accountResourceGroup", { value: declared.resourceGroup })
        .withParameter("accountSubscription", { value: declared.subscription ?? "" })
        .withParameter("gatewayPrincipalId", { value: await identity.getOutput("principalId") });
      deploymentSubscription ??= await access.getOutput("deploymentSubscriptionId");
    }
    // Accounts that name no subscription are in the deployment's.
    if (deploymentSubscription) gateway = gateway.withEnvironment("MANAGED_COPILOT_FOUNDRY_SUBSCRIPTION", deploymentSubscription);
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
      for (const [key, value] of appAccessSummary(deployment, domain ?? "")) await summary.add(key, value);
    },
    { dependsOn: ["provision-azure-bicep-resources"], requiredBy: ["deploy"] },
  );
  const published: PublishedManagedCopilot = {
    name,
    gateway: resource,
    url,
    config: prepared.config,
    port: GATEWAY_TARGET_PORT,
    dataDirectory: "/data",
    appKey: appKeyLookup(name, appKeys),
  };
  deployments.set(published, deployment);
  return published;
}

/** A Bicep resource name segment for a Foundry account name (letters, digits, and hyphens). */
function resourceSuffix(account: string): string {
  return account.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "account";
}

/**
 * Isolated placement: an Azure Container Apps Sandboxes group on the platform network, the gateway identity's access
 * to manage only that group, and a deploy step that builds and pushes the sandbox images before the gateway starts.
 */
async function sandboxGroup(
  builder: PublishBuilder,
  name: string,
  environment: PublishEnvironmentResource,
  plan: SandboxImagePlan,
  egressImage: EgressImagePlan,
  addressSpace: string,
  identity: PublishAzureResource,
): Promise<{ env: [string, PublishValue][] }> {
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
    env: [
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
  /**
   * Whether the app gets the deployment's GitHub token (`Parameters:app-github-token`, as `MANAGED_COPILOT_GITHUB_TOKEN`)
   * and acts as that account. Default true, except for a public app. Set false for an app that never calls the platform
   * as one account (a static page, or an app that signs in its own users); it stays behind `Parameters:app-allowed-ips`
   * unless it is also public. A public app can't have it.
   */
  readonly githubToken?: boolean;
  /**
   * Opens the app to any address on the Internet, for an app that signs in its own users (with their own GitHub tokens,
   * or users it vouches for with an app credential). It gets no GitHub token (`githubToken: true` is refused), and
   * `Parameters:app-allowed-ips` doesn't apply to it. Default false: only the addresses in `Parameters:app-allowed-ips`
   * (by default the deploying machine's) can open the app.
   */
  readonly public?: boolean;
  /**
   * An app declared in `addManagedCopilot`'s `apps`: the app gets that app's key as `MANAGED_COPILOT_APP_KEY`, so it
   * acts for its own users (spec section 2).
   */
  readonly app?: string;
}

/**
 * The deploy summary's lines about who can open the published apps: the allowlisted apps, then the public ones. Empty
 * when the AppHost publishes no apps.
 */
export function appAccessSummary(
  deployment: { readonly allowedSources?: string; readonly restrictedApps: readonly { readonly name: string; readonly actsAsAccount: boolean }[]; readonly publicApps: readonly string[] },
  domain: string,
): [string, string][] {
  const lines: [string, string][] = [];
  const restricted = deployment.restrictedApps;
  if (restricted.length > 0 && deployment.allowedSources) {
    const any = deployment.allowedSources === "*";
    const acting = any ? restricted.filter((app) => app.actsAsAccount).map((app) => app.name) : [];
    const warning = acting.length > 0 ? `${acting.join(", ")} act${acting.length === 1 ? "s" : ""} as your GitHub account for anyone; ` : "";
    lines.push(["Apps open to", `${any ? "any address" : deployment.allowedSources}: ${restricted.map((app) => app.name).join(", ")} (${warning}change with Parameters:app-allowed-ips)`]);
  }
  if (deployment.publicApps.length > 0) {
    lines.push(["Public apps", `${deployment.publicApps.map((app) => `https://${app}.${domain}`).join(", ")} (any address; they sign in their own users)`]);
  }
  return lines;
}

const APP_TOKEN_ENV = "MANAGED_COPILOT_GITHUB_TOKEN";
const AZ_OUTPUT_LIMIT = 64 * 1024 * 1024;

/** Runs the Azure CLI and returns all of its stdout, apart from stderr (a JSON answer must arrive whole). */
export type AzRunner = (args: readonly string[]) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;

/** cmd.exe metacharacters, escaped with `^` so cmd passes them through literally (as the SDK's attach launcher does). */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** Quotes one argument for CommandLineToArgvW: backslashes double only before a quote or the closing quote. */
function quoteArgument(value: string): string {
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes++;
      continue;
    }
    quoted += character === '"' ? `${"\\".repeat(backslashes * 2 + 1)}"` : `${"\\".repeat(backslashes)}${character}`;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

/**
 * The cmd.exe command line that runs the Azure CLI (a batch file on Windows) with `args`: every argument quoted, and its
 * metacharacters escaped twice, because cmd parses the line and the batch file re-parses `%*`. Nothing in an argument
 * (a resource group named `team(dev)`, say) can expand a variable or start another command.
 */
export function azCommandLine(args: readonly string[]): string {
  if (args.some((arg) => /[\r\n\0]/.test(arg))) throw new AzurePublishError("An Azure CLI argument can't contain a line break.");
  const escape = (value: string) => value.replace(CMD_META, "^$1");
  return `"${["az", ...args.map((arg) => escape(escape(quoteArgument(arg))))].join(" ")}"`;
}

export const runAz: AzRunner = (args) =>
  new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child =
        process.platform === "win32"
          ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", azCommandLine(args)], { windowsHide: true, windowsVerbatimArguments: true })
          : spawn("az", [...args], { windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= AZ_OUTPUT_LIMIT) stdout.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => void stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const errors = Buffer.concat(stderr).toString("utf8");
      if (size > AZ_OUTPUT_LIMIT) resolve({ code: 1, stdout: "", stderr: `${errors}\nThe Azure CLI's answer was larger than ${AZ_OUTPUT_LIMIT} bytes.` });
      else resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: errors });
    });
  });

interface Revision {
  readonly name?: string;
  readonly properties?: { readonly active?: boolean; readonly template?: { readonly containers?: readonly { readonly env?: readonly { readonly name?: string }[] }[] } };
}

/**
 * Refuses to open an app to any address while one of its active revisions holds the deployment's GitHub token.
 * Container Apps applies ingress to every revision at once, but the token leaves only with the new revision, so an app
 * that acted as the deployer would serve any address as the deployer until the new revision took over (or for as long
 * as it failed to). A new app, or one that already holds no token, passes.
 */
export async function checkPublicTransition(app: string, environmentId: string | null | undefined, run: AzRunner = runAz): Promise<void> {
  const scope = environmentId ? /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\//i.exec(environmentId) : null;
  if (!scope) throw new AzurePublishError(`Can't check app "${app}" before opening it to any address: the Container Apps environment's resource ID isn't known yet.`);
  const [, subscription, group] = scope;
  const listed = await run(["containerapp", "revision", "list", "--name", app, "--resource-group", group!, "--subscription", subscription!, "--only-show-errors", "-o", "json"]).catch(
    (error: Error) => ({ code: 1, stdout: "", stderr: error.message }),
  );
  if (listed.code !== 0) {
    // Only Azure saying this very container app doesn't exist yet passes; any other failure (sign-in, tenant,
    // permissions) fails closed.
    const missing = new RegExp(`\\(ResourceNotFound\\)[^\\n]*'Microsoft\\.App/containerApps/${app.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`, "i");
    if (missing.test(listed.stderr)) return;
    const tail = listed.stderr.split(/\r?\n/).filter(Boolean).slice(-5).join("\n");
    throw new AzurePublishError(
      `Couldn't check app "${app}" before opening it to any address (\`az containerapp revision list\` exited with ${listed.code}; the Azure CLI must be installed and signed in).${tail ? `\n${tail}` : ""}`,
    );
  }
  let revisions: Revision[];
  try {
    revisions = JSON.parse(listed.stdout) as Revision[];
    if (!Array.isArray(revisions)) throw new TypeError("not a list");
  } catch {
    throw new AzurePublishError(`Couldn't check app "${app}" before opening it to any address: the Azure CLI's revision list wasn't a JSON list.`);
  }
  const holding = revisions
    .filter((revision) => revision.properties?.active !== false)
    .filter((revision) => (revision.properties?.template?.containers ?? []).some((container) => (container.env ?? []).some((variable) => variable.name === APP_TOKEN_ENV)))
    .map((revision) => revision.name ?? "unnamed");
  if (holding.length > 0) {
    throw new AzurePublishError(
      `App "${app}" runs now as an app that acts as your GitHub account (revision ${holding.join(", ")}), and opening it to any address in the same deploy would ` +
        "expose that revision, with your token, until the new one takes over. Deploy it once with githubToken: false instead of public: true " +
        "(it stays behind Parameters:app-allowed-ips and drops the token), then again with public: true.",
    );
  }
}

/**
 * Publishes an app that uses the platform (a demo or your own service). By default it acts as one GitHub account
 * (`Parameters:app-github-token`), so its ingress only admits the source ranges in `Parameters:app-allowed-ips`. An
 * app that signs in its own users can be `public` instead: open to any address, with no GitHub token.
 * Pass the AppHost's builder and the value `addManagedCopilot` returned (in publish mode).
 */
export async function publishApp(builder: AspireBuilder, copilot: ManagedCopilotResource, app: PublishAppOptions): Promise<PublishContainerResource> {
  const deployment = deployments.get(copilot);
  if (!deployment) throw new AzurePublishError("publishApp needs the value addManagedCopilot returned in publish mode.");
  const publisher = builder as unknown as PublishBuilder;
  const gatewayUrl = copilot.url as object;
  const holder = deployment.appsByPort.get(app.port);
  if (holder) throw new AzurePublishError(`Apps "${holder}" and "${app.name}" both use port ${app.port}; webhooks address apps by port.`);
  // Only `true` opens an app: anything else keeps it behind the allowlist.
  const isPublic = app.public === true;
  if (isPublic && app.githubToken === true) {
    throw new AzurePublishError(
      `App "${app.name}" is public, so it can't act as your GitHub account: anyone on the Internet could use it as you. ` +
        "Sign its users in instead (with their own GitHub tokens, or users it vouches for with an app credential) and remove githubToken: true, " +
        "or remove public: true to keep it behind Parameters:app-allowed-ips.",
    );
  }
  const actsAsAccount = !isPublic && app.githubToken !== false;
  if (!isPublic) deployment.allowedSources ??= await appAllowedSources(publisher);
  deployment.appsByPort.set(app.port, app.name);
  if (isPublic) deployment.publicApps.push(app.name);
  else deployment.restrictedApps.push({ name: app.name, actsAsAccount });
  if (actsAsAccount) deployment.appToken ??= await publisher.addParameter("app-github-token", appTokenParameterOptions());
  if (isPublic) {
    // Before the app's ingress opens: an earlier revision that still holds the deployer's token must not become public.
    // Container app provisioning steps only exist once the pipeline runs, so this runs before every image push (each
    // app's provisioning waits for its image), after the environment whose resource ID names the resource group.
    await publisher.pipeline().addStep(
      `check-${app.name}-public`,
      async (context) => {
        const step = await context.reportingStep();
        const task = await step.createTask(`Checking that no revision of ${app.name} holds your GitHub token before opening it to any address`);
        try {
          await checkPublicTransition(app.name, await (await deployment.environment.getOutput("AZURE_CONTAINER_APPS_ENVIRONMENT_ID")).value());
          await task.completeTask({ completionMessage: `${app.name} holds no GitHub token` });
        } catch (error) {
          await task.completeTask({ completionMessage: (error as Error).message, completionState: "CompletedWithError" });
          throw error;
        }
      },
      { dependsOn: [`provision-${deployment.name}-env`], requiredBy: ["push-prereq"] },
    );
  }

  const dataDirectory = app.dataDirectory ?? "/data";
  const subPath = `apps/${app.name}`;
  let container = amd64(publisher.addDockerfile(app.name, deployment.context, { dockerfilePath: app.dockerfile }).withBuildArg("NPM_REGISTRY", deployment.npmRegistry))
    .withHttpEndpoint({ targetPort: app.port, env: "PORT" })
    .withExternalHttpEndpoints()
    .withComputeEnvironment(deployment.environment);
  const allowed = deployment.allowedSources;
  container = isPublic
    ? container.publishAsManagedCopilotPublicApp(deployment.environment, subPath, dataDirectory, app.port, app.healthPath)
    : container.publishAsManagedCopilotApp(deployment.environment, subPath, dataDirectory, app.port, app.healthPath, allowed === "*" ? "" : allowed!);
  container = container
    // For the lease supervisor the app's image starts with (see demos/*/Dockerfile).
    .withEnvironment("MANAGED_COPILOT_DATA_DIR", dataDirectory)
    .withEnvironment("MANAGED_COPILOT_LEASE_STAMP", deployment.stamp)
    .withEnvironment("MANAGED_COPILOT_URL", gatewayUrl);
  if (actsAsAccount) container = container.withEnvironment("MANAGED_COPILOT_GITHUB_TOKEN", deployment.appToken!);
  if (app.app !== undefined) container = container.withEnvironment("MANAGED_COPILOT_APP_KEY", appKeyLookup(deployment.name, deployment.appKeys)(app.app));
  for (const variable of app.gatewayUrlEnv ?? []) container = container.withEnvironment(variable, gatewayUrl);
  // Descriptors written for `aspire run` carry local values (for example a localhost public URL) for variables set here.
  const managed = new Set([
    "PORT",
    "MANAGED_COPILOT_DATA_DIR",
    "MANAGED_COPILOT_LEASE_STAMP",
    "MANAGED_COPILOT_URL",
    "MANAGED_COPILOT_GITHUB_TOKEN",
    "MANAGED_COPILOT_APP_KEY",
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
