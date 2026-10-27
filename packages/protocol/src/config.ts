/**
 * AppHost configuration (spec sections 1, 5, 7, 8, 10, 12, 13).
 *
 * `addManagedCopilot(builder, name, options)` normalizes customer options into `ManagedCopilotConfig`
 * and hands it to the gateway as JSON (`MANAGED_COPILOT_CONFIG`). Secret values never appear in this
 * JSON: they are referenced by environment-variable name (`{ secretEnv }`) and injected separately.
 */
import { z } from "zod";
import { normalizeHostPattern } from "./network.js";
import { MAX_WORKERS_LIMIT } from "./workers.js";

export const ENVIRONMENT_TYPES = ["shared", "isolated", "promotable", "orchestrator"] as const;
export type EnvironmentType = (typeof ENVIRONMENT_TYPES)[number];

/**
 * Whether sessions of this type can have a sandbox of their own: isolated sessions from the start, promotable ones
 * after promotion. Shared and orchestrator sessions run on shared placement (an orchestrator's workers are sessions of
 * their own isolated environments).
 */
export function sandboxedType(type: EnvironmentType): boolean {
  return type === "isolated" || type === "promotable";
}

export const SANDBOX_SIZES = {
  small: { cpus: 1, memoryMiB: 2048 },
  medium: { cpus: 2, memoryMiB: 4096 },
  large: { cpus: 4, memoryMiB: 8192 },
} as const;
export const SIZE_NAMES = ["small", "medium", "large"] as const;
export type SandboxSize = (typeof SIZE_NAMES)[number];

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const RESOURCE_NAME = /^[a-z][a-z0-9-]{0,62}$/;

const HostPatternSchema = z.string().min(1).refine(
  (value) => {
    try {
      normalizeHostPattern(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Expected a host name such as "example.com" or "*.example.com"' },
);

/** Exact HTTPS host for credential substitution: no wildcards, schemes, ports, or paths. */
const ExactHostSchema = z.string().min(1).refine(
  (value) => {
    if (value.trim().startsWith("*.")) return false;
    try {
      normalizeHostPattern(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Expected an exact host name such as "api.stripe.com" (no wildcards, schemes, or ports)' },
);

export const NetworkSettingSchema = z.union([
  z.boolean(),
  z.array(HostPatternSchema),
  z.object({ access: z.enum(["enabled", "restricted", "disabled"]), allowedDomains: z.array(HostPatternSchema).optional() }).strict(),
]);

export const PackagesSchema = z
  .object({
    python: z.array(z.string().min(1)).optional(),
    npm: z.array(z.string().min(1)).optional(),
    /** Operator image preparation only; client/session requests for system packages are rejected. */
    system: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type Packages = z.infer<typeof PackagesSchema>;

/** A secret delivered to the gateway through the named environment variable. */
export const SecretRefSchema = z.object({ secretEnv: z.string().regex(ENV_NAME) }).strict();
export type SecretRef = z.infer<typeof SecretRefSchema>;

export const SandboxCredentialSchema = z
  .object({
    /** Environment variable that holds a per-session placeholder inside the sandbox. */
    env: z.string().regex(ENV_NAME),
    value: SecretRefSchema,
    /** Exact HTTPS hosts (no wildcards) where the proxy substitutes the real value. */
    hosts: z.array(ExactHostSchema).min(1),
    /** Request headers eligible for substitution. Defaults to `authorization`. */
    headers: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const McpCredentialSchema = z
  .object({
    mcpServer: z.string().url(),
    value: SecretRefSchema,
    /** Header the connector sets on MCP requests. Defaults to `Authorization: Bearer <value>`. */
    header: z.string().optional(),
  })
  .strict();

export const VaultCredentialSchema = z.union([SandboxCredentialSchema, McpCredentialSchema]);
export type VaultCredential = z.infer<typeof VaultCredentialSchema>;

export const EnvironmentConfigSchema = z
  .object({
    type: z.enum(ENVIRONMENT_TYPES),
    description: z.string().optional(),
    /** Folder with `agents/`, `skills/`, and `instructions/` deployed read-only with the environment. */
    customizations: z.string().optional(),
    /** Models sessions may use. Omitted means every model the caller's entitlement offers. */
    models: z.array(z.string().min(1)).optional(),
    network: NetworkSettingSchema.optional(),
    /** Sandbox image build context (a directory containing a Dockerfile). Isolated placement only. */
    image: z.string().optional(),
    size: z.enum(SIZE_NAMES).optional(),
    warm: z.number().int().min(0).max(32).optional(),
    /** Promotable only: the isolated environment that supplies the sandbox after promotion. */
    promoteTo: z.string().regex(RESOURCE_NAME).optional(),
    /** Orchestrator only: the isolated environments its workers run in. The first is the default. */
    workers: z.array(z.string().regex(RESOURCE_NAME)).min(1).optional(),
    /** Orchestrator only: how many workers one session can have at once (stopped workers don't count). Default 4. */
    maxWorkers: z.number().int().min(1).max(MAX_WORKERS_LIMIT).optional(),
    packages: PackagesSchema.optional(),
    setupCommands: z.array(z.string().min(1)).optional(),
    /** Non-secret variables visible to sandbox code. */
    env: z.record(z.string().regex(ENV_NAME), z.string()).optional(),
    vaults: z.array(z.string().regex(RESOURCE_NAME)).optional(),
    /** Operator approval for the agent scheduling tools (`schedule_task`, `list_schedules`, `cancel_schedule`). */
    scheduling: z.boolean().optional(),
    inference: z.object({ foundry: z.string().min(1) }).strict().optional(),
    github: z.object({ publish: z.boolean().optional() }).strict().optional(),
    /** Idle seconds before a sandbox may stop compute (after pending work drains). */
    idleTimeoutSeconds: z.number().int().positive().optional(),
  })
  .strict();
export type EnvironmentConfig = z.infer<typeof EnvironmentConfigSchema>;

/** Standard SDK tool declaration (no handler) stored for schedules and durable actions. */
export const ToolDeclarationSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    revision: z.string().optional(),
    /** Stock SDK `Tool` flags that change runtime behavior. */
    overridesBuiltInTool: z.boolean().optional(),
    skipPermission: z.boolean().optional(),
  })
  .strict();
export type ToolDeclaration = z.infer<typeof ToolDeclarationSchema>;

export const WebhookDeclSchema = z
  .object({
    url: z.string().url(),
    /** Authorized subscriber scope, not a deployment-wide broadcast. */
    environments: z.array(z.string().regex(RESOURCE_NAME)).min(1),
    events: z.array(z.string().min(1)).min(1),
    secret: SecretRefSchema,
  })
  .strict();
export type WebhookDecl = z.infer<typeof WebhookDeclSchema>;

export const ScheduleSessionSchema = z
  .object({
    agent: z.string().optional(),
    model: z.string().optional(),
    tools: z.array(ToolDeclarationSchema).optional(),
  })
  .strict();

export const ScheduleDeclSchema = z
  .object({
    cron: z.string().min(1),
    timeZone: z.string().min(1).default("UTC"),
    environment: z.string().regex(RESOURCE_NAME),
    session: ScheduleSessionSchema.optional(),
    webhook: z.string().optional(),
    prompt: z.string().min(1),
    /** GitHub login with an explicit grant for this deployment, environment, and schedule. */
    runAs: z.string().optional(),
  })
  .strict();
export type ScheduleDecl = z.infer<typeof ScheduleDeclSchema>;

export const AccessSchema = z
  .object({
    githubOrgs: z.array(z.string().min(1)).optional(),
    githubUsers: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const InlineSchema = z
  .object({
    types: z.array(z.enum(ENVIRONMENT_TYPES)).min(1),
    sizes: z.array(z.enum(SIZE_NAMES)).optional(),
  })
  .strict();

export const ManagedCopilotConfigSchema = z
  .object({
    name: z.string().regex(RESOURCE_NAME).default("copilot"),
    access: AccessSchema.optional(),
    /**
     * GitHub accounts that may use the operator API and console (spec section 16). A loopback gateway with none named
     * treats every account that can use it as an operator; elsewhere the console stays off until operators are named.
     */
    operators: AccessSchema.optional(),
    /** Operator default for every environment that does not set `network` itself. */
    network: NetworkSettingSchema.optional(),
    environments: z.record(z.string().regex(RESOURCE_NAME), EnvironmentConfigSchema),
    inline: InlineSchema.optional(),
    vaults: z.record(z.string().regex(RESOURCE_NAME), z.array(VaultCredentialSchema).min(1)).optional(),
    webhooks: z.record(z.string().regex(RESOURCE_NAME), WebhookDeclSchema).optional(),
    schedules: z.record(z.string().regex(RESOURCE_NAME), ScheduleDeclSchema).optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const envs = config.environments;
    const vaults = config.vaults ?? {};
    for (const [name, env] of Object.entries(envs)) {
      if (env.type === "promotable" && env.promoteTo === undefined) {
        ctx.addIssue({ code: "custom", path: ["environments", name, "promoteTo"], message: "promotable environments must name an isolated environment in promoteTo" });
      }
      if (env.promoteTo !== undefined) {
        const target = envs[env.promoteTo];
        if (env.type !== "promotable") ctx.addIssue({ code: "custom", path: ["environments", name, "promoteTo"], message: "promoteTo is only valid on promotable environments" });
        else if (!target || target.type !== "isolated") ctx.addIssue({ code: "custom", path: ["environments", name, "promoteTo"], message: `promoteTo must name an isolated environment` });
      }
      if (env.type === "orchestrator" && env.workers === undefined) {
        ctx.addIssue({ code: "custom", path: ["environments", name, "workers"], message: "orchestrator environments must name the isolated environments their workers run in (workers)" });
      }
      if (env.type !== "orchestrator" && (env.workers !== undefined || env.maxWorkers !== undefined)) {
        ctx.addIssue({ code: "custom", path: ["environments", name], message: "workers and maxWorkers are only valid on orchestrator environments" });
      }
      for (const [index, worker] of (env.workers ?? []).entries()) {
        const target = envs[worker];
        if (!target || target.type !== "isolated") ctx.addIssue({ code: "custom", path: ["environments", name, "workers", index], message: `Worker environment "${worker}" must be an isolated environment` });
        else if (env.workers!.indexOf(worker) !== index) ctx.addIssue({ code: "custom", path: ["environments", name, "workers", index], message: `Worker environment "${worker}" is listed twice` });
      }
      if (!sandboxedType(env.type) && (env.image || env.size || env.warm || env.setupCommands || env.packages || env.env)) {
        ctx.addIssue({ code: "custom", path: ["environments", name], message: `${env.type} environments have no sandbox: image, size, warm, packages, setupCommands, and env are not allowed` });
      }
      for (const vault of env.vaults ?? []) {
        const credentials = vaults[vault];
        if (!credentials) ctx.addIssue({ code: "custom", path: ["environments", name, "vaults"], message: `Unknown vault "${vault}"` });
        else if (!sandboxedType(env.type) && credentials.some((credential) => "env" in credential)) {
          ctx.addIssue({ code: "custom", path: ["environments", name, "vaults"], message: `Vault "${vault}" holds sandbox credentials, which ${env.type} environments cannot use; use MCP credentials instead` });
        }
      }
    }
    if (config.inline?.types.includes("orchestrator")) {
      ctx.addIssue({ code: "custom", path: ["inline", "types"], message: "orchestrator environments cannot be inline: declare one by name with the isolated environments its workers use" });
    }
    for (const [name, hook] of Object.entries(config.webhooks ?? {})) {
      for (const env of hook.environments) {
        if (!envs[env]) ctx.addIssue({ code: "custom", path: ["webhooks", name, "environments"], message: `Unknown environment "${env}"` });
      }
    }
    for (const [name, schedule] of Object.entries(config.schedules ?? {})) {
      if (!envs[schedule.environment]) ctx.addIssue({ code: "custom", path: ["schedules", name, "environment"], message: `Unknown environment "${schedule.environment}"` });
      if (schedule.webhook && !config.webhooks?.[schedule.webhook]) ctx.addIssue({ code: "custom", path: ["schedules", name, "webhook"], message: `Unknown webhook "${schedule.webhook}"` });
    }
  });
export type ManagedCopilotConfig = z.infer<typeof ManagedCopilotConfigSchema>;
export type ManagedCopilotConfigInput = z.input<typeof ManagedCopilotConfigSchema>;

export function parseConfig(input: unknown): ManagedCopilotConfig {
  return ManagedCopilotConfigSchema.parse(input);
}

/**
 * Environment selection sent by a client when it connects (spec sections 1, 5, 7, 8), as the first bridge frame
 * (`BridgeHello`), never in a header. Per-session inputs (`files`, `packages`, `env`) apply to every session created
 * through that client. The gateway resolves this against the named environment's ceiling; callers can only add
 * permitted setup and narrow permissions.
 */
export const EnvironmentRequestSchema = z
  .object({
    name: z.string().regex(RESOURCE_NAME).optional(),
    type: z.enum(ENVIRONMENT_TYPES).optional(),
    size: z.enum(SIZE_NAMES).optional(),
    network: NetworkSettingSchema.optional(),
    vaults: z.array(z.string().min(1)).optional(),
    packages: PackagesSchema.omit({ system: true }).strict().optional(),
    env: z.record(z.string().regex(ENV_NAME), z.string()).optional(),
    /** Small workspace-relative files, base64 encoded on the wire. Use the files API for large uploads. */
    files: z.record(z.string().min(1), z.string()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.name === undefined && value.type === undefined) ctx.addIssue({ code: "custom", message: "An environment request needs a name or a type" });
    if (value.type !== undefined && !sandboxedType(value.type) && (value.size || value.packages || value.env || value.files)) {
      ctx.addIssue({ code: "custom", message: `${value.type} environments have no sandbox: size, packages, env, and files are not allowed` });
    }
  });
export type EnvironmentRequest = z.infer<typeof EnvironmentRequestSchema>;
