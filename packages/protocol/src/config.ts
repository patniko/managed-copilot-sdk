/**
 * AppHost configuration (spec sections 1, 5, 7, 8, 10, 12, 13).
 *
 * `addManagedCopilot(builder, name, options)` normalizes customer options into `ManagedCopilotConfig`
 * and hands it to the gateway as JSON (`MANAGED_COPILOT_CONFIG`). Secret values never appear in this
 * JSON: they are referenced by environment-variable name (`{ secretEnv }`) and injected separately.
 */
import { z } from "zod";
import { normalizeHostPattern } from "./network.js";

export const ENVIRONMENT_TYPES = ["shared", "isolated", "promotable"] as const;
export type EnvironmentType = (typeof ENVIRONMENT_TYPES)[number];

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
    hosts: z.array(z.string().min(1)).min(1),
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
      if (env.promoteTo !== undefined) {
        const target = envs[env.promoteTo];
        if (env.type !== "promotable") ctx.addIssue({ code: "custom", path: ["environments", name, "promoteTo"], message: "promoteTo is only valid on promotable environments" });
        else if (!target || target.type !== "isolated") ctx.addIssue({ code: "custom", path: ["environments", name, "promoteTo"], message: `promoteTo must name an isolated environment` });
      }
      if (env.type === "shared" && (env.image || env.size || env.warm || env.setupCommands || env.packages)) {
        ctx.addIssue({ code: "custom", path: ["environments", name], message: "shared environments have no sandbox: image, size, warm, packages, and setupCommands are not allowed" });
      }
      for (const vault of env.vaults ?? []) {
        if (!vaults[vault]) ctx.addIssue({ code: "custom", path: ["environments", name, "vaults"], message: `Unknown vault "${vault}"` });
      }
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
 * Environment selection sent by a client when it connects (spec sections 1, 5, 7, 8).
 * Per-session inputs (`files`, `packages`, `env`) apply to every session created through that client.
 * The gateway resolves this against the named environment's ceiling; callers can only add permitted
 * setup and narrow permissions.
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
    /** Small workspace-relative files, base64 encoded. Use the files API for large uploads. */
    files: z.record(z.string().min(1), z.string()).optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.type !== undefined, { message: "An environment request needs a name or a type" });
export type EnvironmentRequest = z.infer<typeof EnvironmentRequestSchema>;
