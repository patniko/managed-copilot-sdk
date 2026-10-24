import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { ManagedCopilotConfig } from "@managed-copilot/protocol";
import type { AspireBuilder, AspireNodeAppBuilder, EndpointOf, GatewayResourceOf } from "./aspire.js";
import { normalizeOptions, type ManagedCopilotOptions } from "./options.js";

/** Default gateway port on the developer's machine. */
export const DEFAULT_GATEWAY_PORT = 7400;

const RESOURCE_NAME = /^[a-z][a-z0-9-]{0,62}$/;

/** The platform declared by `addManagedCopilot`, for wiring other AppHost resources to it. */
export interface ManagedCopilotResource<TGateway = unknown, TEndpoint = unknown> {
  readonly name: string;
  /** The gateway resource. Pass it to `waitFor(...)` on resources that use the platform. */
  readonly gateway: TGateway;
  /** The gateway's HTTP endpoint. Inject it as `MANAGED_COPILOT_URL` so `ManagedCopilot.connect()` finds it. */
  readonly url: TEndpoint;
  /** The normalized configuration the gateway enforces. Contains secret references, never secret values. */
  readonly config: ManagedCopilotConfig;
  readonly port: number;
  readonly dataDirectory: string;
}

function locateGateway(): string {
  try {
    return dirname(createRequire(import.meta.url).resolve("@managed-copilot/gateway/package.json"));
  } catch {
    throw new Error("Cannot find the @managed-copilot/gateway package. Run `pnpm install` at the repository root.");
  }
}

function hostNpmRegistry(): string | undefined {
  try {
    const registry = execSync("npm config get registry", { encoding: "utf8", timeout: 15_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^https?:\/\//.test(registry) ? registry : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Adds the Managed Copilot platform to an Aspire TypeScript AppHost (spec section 1).
 *
 * ```ts
 * const copilot = await addManagedCopilot(builder, "copilot", { environments: { chat: { type: "shared" } } });
 * await builder.addNodeApp("web", "./web", "dist/main.js")
 *   .withEnvironment("MANAGED_COPILOT_URL", copilot.url)
 *   .waitFor(copilot.gateway);
 * ```
 *
 * The gateway runs as a Node app with a health check, a persistent generated platform key, and a data directory
 * next to the AppHost. It builds and supervises sandbox images, the sandbox relay, and the egress proxy itself.
 * Secret options must be Aspire secret parameters: they reach the gateway as environment variables and appear in
 * its configuration only as `{ secretEnv }` references.
 */
export async function addManagedCopilot<B extends AspireBuilder>(
  builder: B,
  name: string,
  options: ManagedCopilotOptions,
): Promise<ManagedCopilotResource<GatewayResourceOf<B>, EndpointOf<B>>> {
  if (!RESOURCE_NAME.test(name)) {
    throw new Error(`Managed Copilot resource name "${name}" must start with a lowercase letter and use only lowercase letters, digits, and hyphens.`);
  }
  if (await builder.executionContext().isPublishMode()) {
    throw new Error(
      `Managed Copilot "${name}": Azure deployment is not available yet (delivery gate G3). Use \`aspire run\` for the local platform.`,
    );
  }

  const appHostDirectory = await builder.appHostDirectory();
  const { config, secrets } = normalizeOptions(name, options, { baseDirectory: appHostDirectory });
  const gatewayDirectory = options.gatewayDirectory ? resolve(appHostDirectory, options.gatewayDirectory) : locateGateway();
  if (!existsSync(join(gatewayDirectory, "dist", "main.js"))) {
    throw new Error(`The Managed Copilot gateway is not built (${join(gatewayDirectory, "dist", "main.js")} is missing). Run \`pnpm build\` first.`);
  }
  const port = options.port ?? DEFAULT_GATEWAY_PORT;
  const dataDirectory = resolve(appHostDirectory, options.dataDirectory ?? join(".managed-copilot", "data"));
  // Names Docker networks, containers, and volumes so separate checkouts on one Docker engine never collide.
  const instance = `mc-${createHash("sha256").update(appHostDirectory.toLowerCase()).digest("hex").slice(0, 8)}`;

  const platformKey = await builder.addParameterWithGeneratedValue(`${name}-platform-key`, { minLength: 48, special: false }, { secret: true, persist: true });

  let gateway: AspireNodeAppBuilder = builder
    .addNodeApp(name, gatewayDirectory, "dist/main.js")
    .withPnpm({ install: false })
    .withHttpEndpoint({ port, env: "PORT", isProxied: false })
    .withHttpHealthCheck({ path: "/healthz" })
    .withIconName("BotSparkle")
    .withEnvironment("MANAGED_COPILOT_MODE", "local")
    .withEnvironment("MANAGED_COPILOT_CONFIG", JSON.stringify(config))
    .withEnvironment("MANAGED_COPILOT_PUBLIC_URL", `http://localhost:${port}`)
    .withEnvironment("MANAGED_COPILOT_DATA_DIR", dataDirectory)
    .withEnvironment("MANAGED_COPILOT_APPHOST_DIR", appHostDirectory)
    .withEnvironment("MANAGED_COPILOT_INSTANCE", instance)
    .withEnvironment("MANAGED_COPILOT_PLATFORM_KEY", platformKey);
  const npmRegistry = hostNpmRegistry();
  if (npmRegistry) gateway = gateway.withEnvironment("MANAGED_COPILOT_NPM_REGISTRY", npmRegistry);
  for (const secret of secrets) gateway = gateway.withEnvironment(secret.env, secret.value);

  const resource = await gateway;
  const url = await resource.getEndpoint("http");
  return {
    name,
    gateway: resource as GatewayResourceOf<B>,
    url: url as EndpointOf<B>,
    config,
    port,
    dataDirectory,
  };
}
