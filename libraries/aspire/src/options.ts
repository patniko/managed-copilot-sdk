import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ManagedCopilotConfigSchema,
  type ManagedCopilotConfig,
  type ManagedCopilotConfigInput,
  type SecretRef,
  type ToolDeclaration,
} from "@managed-copilot/protocol";
import { ZodError } from "zod";

/**
 * A secret supplied by the AppHost: an Aspire secret parameter (`await builder.addParameter(name, { secret: true })`),
 * or a `{ secretEnv }` reference to a variable the operator already sets on the gateway. Literal strings are
 * rejected so secret values never appear in AppHost code or in the gateway configuration.
 */
export type AspireSecret = object;

type ConfigInput = ManagedCopilotConfigInput;
type VaultCredentialInput = NonNullable<ConfigInput["vaults"]>[string][number];
type WebhookInput = NonNullable<ConfigInput["webhooks"]>[string];
type ScheduleInput = NonNullable<ConfigInput["schedules"]>[string];
type AppInput = NonNullable<ConfigInput["apps"]>[string];

export type SandboxCredentialOption = Omit<Extract<VaultCredentialInput, { env: string }>, "value"> & { value: AspireSecret };
export type McpCredentialOption = Omit<Extract<VaultCredentialInput, { mcpServer: string }>, "value"> & { value: AspireSecret };
export type VaultCredentialOption = SandboxCredentialOption | McpCredentialOption;
export type WebhookOption = Omit<WebhookInput, "secret"> & { secret: AspireSecret };
/**
 * An app that signs in its own users and vouches for them (spec section 2). The integration generates its key; pass
 * `copilot.appKey(name)` to the app as `MANAGED_COPILOT_APP_KEY`.
 */
export type AppOption = Omit<AppInput, "key">;

/**
 * A stock SDK tool (`defineTool(...)`) or a plain declaration. Schedules store only the standard declaration (name,
 * description, JSON schema, flags, revision); handlers stay in your app and answer through webhooks (spec section 13).
 */
export interface ToolOption {
  name: string;
  description?: string;
  parameters?: unknown;
  overridesBuiltInTool?: boolean;
  skipPermission?: boolean;
  revision?: string;
}

export type ScheduleOption = Omit<ScheduleInput, "session"> & {
  session?: Omit<NonNullable<ScheduleInput["session"]>, "tools"> & { tools?: ToolOption[] };
};

/** `addManagedCopilot` options: the AppHost declaration from spec section 1 plus local hosting settings. */
export interface ManagedCopilotOptions extends Omit<ConfigInput, "name" | "vaults" | "webhooks" | "schedules" | "apps"> {
  /** Named vaults (spec section 8). Values must be Aspire secret parameters. */
  vaults?: Record<string, VaultCredentialOption[]>;
  /** Webhook subscribers (spec section 12). Secrets must be Aspire secret parameters. */
  webhooks?: Record<string, WebhookOption>;
  /** Schedules deployed with the app (spec section 13). Tools are stock SDK tools; only declarations are stored. */
  schedules?: Record<string, ScheduleOption>;
  /** Apps that vouch for their own users with a generated key (spec section 2): `copilot.appKey(name)`. */
  apps?: Record<string, AppOption>;
  /** Gateway port on this machine. Defaults to 7400; `ManagedCopilot.connect()` discovers it either way. */
  port?: number;
  /** Ledger, artifacts, and runtime state. Defaults to `.managed-copilot/data` next to the AppHost. */
  dataDirectory?: string;
  /** Gateway package directory. Defaults to the installed `@managed-copilot/gateway` package. */
  gatewayDirectory?: string;
  /**
   * Build the sandbox base image and start the relay when the gateway starts, rather than on the first isolated
   * session (progress appears in the gateway's logs). Defaults to true when an isolated or promotable environment exists.
   */
  prepareSandboxes?: boolean;
  /**
   * Advertise this gateway for zero-config `ManagedCopilot.connect()` on this machine (default true). Turn it off for a
   * second copy running beside another, so tools keep finding the first.
   */
  discovery?: boolean;
}

/** A secret the gateway receives through its environment, never through `MANAGED_COPILOT_CONFIG`. */
export interface SecretBinding {
  /** Environment variable on the gateway process. */
  readonly env: string;
  readonly value: AspireSecret;
  /** Where the secret was declared, e.g. `vaults.payments[0].value`. */
  readonly source: string;
}

export interface NormalizedOptions {
  readonly config: ManagedCopilotConfig;
  readonly secrets: readonly SecretBinding[];
  /** Each declared app and the gateway variable its generated key goes in. */
  readonly apps: readonly AppKeyBinding[];
}

/** An app's key: the integration generates an Aspire secret parameter and hands it to the gateway in `env`. */
export interface AppKeyBinding {
  readonly app: string;
  readonly env: string;
}

/** Invalid AppHost options, reported before any resource starts. */
export class ManagedCopilotOptionsError extends Error {
  constructor(name: string, problems: readonly string[]) {
    super(`Invalid Managed Copilot options for "${name}":\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "ManagedCopilotOptionsError";
  }
}

const HOSTING_KEYS = ["port", "dataDirectory", "gatewayDirectory", "prepareSandboxes", "discovery"] as const;

function envSegment(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Readable, plus a hash of the exact name, so distinct names (`billing-prod`, `billing--prod`) never share a variable. */
function secretEnvName(kind: "VAULT" | "WEBHOOK" | "APP", name: string, index?: number): string {
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8).toUpperCase();
  return `MANAGED_COPILOT_SECRET_${kind}_${envSegment(name) || "NAMED"}_${hash}${index === undefined ? "" : `_${index}`}`;
}

function isSecretRef(value: unknown): value is SecretRef {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === 1 &&
    typeof (value as { secretEnv?: unknown }).secretEnv === "string"
  );
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** The stock SDK sends `parameters.toJSONSchema()` for zod schemas and plain JSON schemas as they are. */
function jsonSchemaOf(parameters: unknown): Record<string, unknown> | undefined {
  if (parameters === undefined || parameters === null) return undefined;
  const convert = (parameters as { toJSONSchema?: unknown }).toJSONSchema;
  if (typeof convert === "function") return convert.call(parameters) as Record<string, unknown>;
  return typeof parameters === "object" ? (parameters as Record<string, unknown>) : undefined;
}

/** Extracts the standard declaration from a stock SDK tool; the handler closure is never serialized. */
export function toolDeclaration(tool: ToolOption): ToolDeclaration {
  const parameters = jsonSchemaOf(tool.parameters);
  const declaration: ToolDeclaration = {
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(parameters !== undefined ? { parameters } : {}),
    ...(tool.overridesBuiltInTool !== undefined ? { overridesBuiltInTool: tool.overridesBuiltInTool } : {}),
    ...(tool.skipPermission !== undefined ? { skipPermission: tool.skipPermission } : {}),
  };
  const revision = tool.revision ?? `sha256:${createHash("sha256").update(JSON.stringify(canonical(declaration))).digest("hex").slice(0, 16)}`;
  return { ...declaration, revision };
}

/**
 * Turns AppHost options into the gateway's `ManagedCopilotConfig` plus the secrets to inject as environment variables.
 * Relative `image` and `customizations` paths resolve against `baseDirectory` (the AppHost directory).
 */
export function normalizeOptions(name: string, options: ManagedCopilotOptions, { baseDirectory }: { baseDirectory: string }): NormalizedOptions {
  const problems: string[] = [];
  const secrets: SecretBinding[] = [];

  const secretRef = (source: string, value: unknown, env: string): SecretRef => {
    if (isSecretRef(value)) return value;
    if (typeof value === "string") {
      problems.push(`${source} is a literal string. Use an Aspire secret parameter, e.g. await builder.addParameter("my-secret", { secret: true }).`);
    } else if (value === null || typeof value !== "object") {
      problems.push(`${source} is missing. Use an Aspire secret parameter, e.g. await builder.addParameter("my-secret", { secret: true }).`);
    } else {
      const clash = secrets.find((binding) => binding.env === env);
      if (clash) problems.push(`${source} and ${clash.source} would share the environment variable ${env}. Rename one of them.`);
      else secrets.push({ env, value, source });
    }
    return { secretEnv: env };
  };

  const input: Record<string, unknown> = { ...options, name };
  for (const key of HOSTING_KEYS) delete input[key];

  if (options.vaults) {
    input.vaults = Object.fromEntries(
      Object.entries(options.vaults).map(([vault, credentials]) => [
        vault,
        (credentials ?? []).map((credential, index) => ({
          ...credential,
          value: secretRef(`vaults.${vault}[${index}].value`, credential.value, secretEnvName("VAULT", vault, index)),
        })),
      ]),
    );
  }
  if (options.webhooks) {
    input.webhooks = Object.fromEntries(
      Object.entries(options.webhooks).map(([hook, webhook]) => [
        hook,
        { ...webhook, secret: secretRef(`webhooks.${hook}.secret`, webhook.secret, secretEnvName("WEBHOOK", hook)) },
      ]),
    );
  }
  if (options.schedules) {
    input.schedules = Object.fromEntries(
      Object.entries(options.schedules).map(([schedule, declaration]) => {
        const tools = declaration.session?.tools;
        if (!tools) return [schedule, declaration];
        return [schedule, { ...declaration, session: { ...declaration.session, tools: tools.map((tool) => toolDeclaration(tool)) } }];
      }),
    );
  }
  const apps: AppKeyBinding[] = [];
  if (options.apps) {
    input.apps = Object.fromEntries(
      Object.entries(options.apps).map(([app, declaration]) => {
        if (declaration && typeof declaration === "object" && "key" in declaration) {
          problems.push(`apps.${app}.key is generated by addManagedCopilot; remove it and pass copilot.appKey("${app}") to the app instead.`);
        }
        const env = secretEnvName("APP", app);
        apps.push({ app, env });
        return [app, { ...declaration, key: { secretEnv: env } }];
      }),
    );
  }

  const environments: Record<string, unknown> = {};
  for (const [envName, environment] of Object.entries(options.environments ?? {})) {
    const resolved: Record<string, unknown> = { ...environment };
    if (typeof environment.image === "string") {
      const context = resolve(baseDirectory, environment.image);
      if (!existsSync(join(context, "Dockerfile"))) problems.push(`environments.${envName}.image: no Dockerfile in ${context}`);
      resolved.image = context;
    }
    if (typeof environment.customizations === "string") {
      const folder = resolve(baseDirectory, environment.customizations);
      if (!existsSync(folder) || !statSync(folder).isDirectory()) problems.push(`environments.${envName}.customizations: folder ${folder} does not exist`);
      resolved.customizations = folder;
    }
    environments[envName] = resolved;
  }
  input.environments = environments;

  let config: ManagedCopilotConfig | undefined;
  try {
    config = ManagedCopilotConfigSchema.parse(input);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    for (const issue of error.issues) problems.push(`${issue.path.length > 0 ? issue.path.join(".") : "options"}: ${issue.message}`);
  }
  if (problems.length > 0 || !config) throw new ManagedCopilotOptionsError(name, problems);
  return { config, secrets, apps };
}

/** The Aspire parameter that holds an app's generated key (`<name>-app-<app>-key`). */
export function appKeyParameterName(name: string, app: string): string {
  return `${name}-app-${app}-key`;
}
