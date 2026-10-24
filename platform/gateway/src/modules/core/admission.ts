// Admission: validates and rewrites the stock SDK's session configuration before it reaches a runtime.
//
// Shared placement is application isolation inside one runtime process, so admission is an allowlist: only known
// session options pass, workload filesystem/subprocess capabilities are rejected (including nested custom-agent
// configuration), ambient discovery is disabled, and environment defaults (tool filters, models, deployed
// customizations, platform tools) are supplied server-side. The same rules apply on create, resume, `options.update`,
// `tools.set`, agent selection, and model switches. Sandbox placement is per-session isolation: workload tools are
// allowed, but credentials, billing routes, and host-global settings are still controlled by the platform.
import { ManagedCopilotError, type NetworkPolicy, type Placement } from "@managed-copilot/protocol";
import type { RegisteredPlatformTool, ResolvedEnvironment } from "./contracts.js";

/** `BuiltInTools.Isolated` from @github/copilot-sdk 1.0.26: built-ins that stay inside one session. */
export const SESSION_SAFE_BUILTINS = ["ask_user", "task_complete", "exit_plan_mode", "task", "read_agent", "write_agent", "list_agents", "send_inbox", "context_board"] as const;

/**
 * Multi-agent built-ins. In shared sessions without agents they only spawn subagents that have nothing to work with
 * (no web, shell, or files), which turns a quick chat answer into minutes of fruitless delegation, so they are on by
 * default only when the session has agents; callers can still opt in with `availableTools`.
 */
export const SUBAGENT_BUILTINS = ["task", "read_agent", "write_agent", "list_agents", "send_inbox", "context_board"] as const;

/** Runtime built-in MCP servers, disabled in shared placement (no direct egress from the shared runtime). */
export const BUILTIN_MCP_SERVERS = ["github-mcp-server"] as const;

export interface AdmissionContext {
  readonly environment: ResolvedEnvironment;
  readonly placement: Placement;
  readonly network: NetworkPolicy;
  readonly platformTools: readonly RegisteredPlatformTool[];
  /** Platform-chosen working directory: a private empty directory (shared) or the sandbox workspace. */
  readonly workingDirectory: string;
  /** Gateway-owned `gitHubToken` provider registration for this session. */
  readonly tokenRegistrationId: string;
  /** Where the customization bundle is mounted read-only inside a sandbox (sandbox placement only). */
  readonly sandboxCustomizations?: string;
  /** Whether the session admitted remote MCP servers (option patches may then allow `mcp:*` tools). */
  readonly allowMcp?: boolean;
}

/** The sandbox module mounts deployed customizations here (read-only). */
export const SANDBOX_CUSTOMIZATIONS_DIR = "/opt/managed-copilot/customizations";

/** Customization directories as the runtime sees them: host paths for shared, mount paths for sandboxes. */
function bundleDirectories(context: AdmissionContext): { agents?: string; skills?: string; instructions?: string } {
  const bundle = context.environment.customizations;
  if (!bundle) return {};
  if (context.placement === "shared") {
    return {
      ...(bundle.agentDirectory ? { agents: bundle.agentDirectory } : {}),
      ...(bundle.skillDirectory ? { skills: bundle.skillDirectory } : {}),
      ...(bundle.instructionDirectory ? { instructions: bundle.instructionDirectory } : {}),
    };
  }
  const root = (context.sandboxCustomizations ?? SANDBOX_CUSTOMIZATIONS_DIR).replace(/\/+$/, "");
  return {
    ...(bundle.agentDirectory ? { agents: `${root}/agents` } : {}),
    ...(bundle.skillDirectory ? { skills: `${root}/skills` } : {}),
    ...(bundle.instructionDirectory ? { instructions: `${root}/instructions` } : {}),
  };
}

export interface ClientCapabilities {
  readonly tools: readonly string[];
  readonly requestPermission: boolean;
  readonly requestUserInput: boolean;
  readonly requestElicitation: boolean;
}

export interface AdmittedSession {
  /** The rewritten `session.create` / `session.resume` params forwarded upstream. */
  readonly params: Record<string, unknown>;
  readonly client: ClientCapabilities;
  readonly model?: string;
  readonly agent?: string;
  /** A per-session `gitHubToken` the caller supplied; the router verifies it belongs to the caller. */
  readonly callerToken?: string;
  /** Remote MCP endpoints to check against network policy (shared placement). */
  readonly remoteMcp: readonly { readonly name: string; readonly url: string; readonly agent?: string }[];
  /** Lockdown applied with `session.options.update` after the runtime accepts the session. */
  readonly optionsPatch: Record<string, unknown>;
}

type Rule = (value: unknown, key: string) => unknown | typeof DROP;
const DROP = Symbol("drop");
const pass: Rule = (value) => value;

function violation(message: string, details?: Record<string, unknown>): ManagedCopilotError {
  return new ManagedCopilotError("policy_violation", message, details);
}

function unavailable(message: string, details?: Record<string, unknown>): ManagedCopilotError {
  return new ManagedCopilotError("capability_unavailable", message, details);
}

function rejectIfSet(message: string, error: (message: string) => ManagedCopilotError = violation): Rule {
  return (value, key) => {
    if (value === undefined || value === null || value === false || (Array.isArray(value) && value.length === 0)) return DROP;
    throw error(message.replace("{key}", key));
  };
}

const onlyFalse = (what: string): Rule => (value) => {
  if (value === true) throw violation(`${what} is not available in shared environments`);
  return false;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new ManagedCopilotError("invalid_request", `${field} must be a list of strings`);
  return value as string[];
}

/** Models the environment allows; undefined means every model the caller's entitlement offers. */
export function checkModel(environment: ResolvedEnvironment, model: unknown): void {
  const allowed = environment.config.models;
  if (model === undefined || model === null || !allowed) return;
  if (typeof model !== "string") throw new ManagedCopilotError("invalid_request", "model must be a string");
  if (model === "auto") throw violation(`Environment "${environment.name}" allows only these models: ${allowed.join(", ")}`, { allowedModels: allowed });
  if (!allowed.includes(model)) throw violation(`Model "${model}" is not allowed in environment "${environment.name}" (allowed: ${allowed.join(", ")})`, { allowedModels: allowed });
}

/**
 * Shared sessions get an accurate environment section instead of the runtime's host details (cwd, OS, directory
 * listing), so models do not attempt shell commands or file access the session does not have.
 */
export const SHARED_ENVIRONMENT_CONTEXT = [
  "<environment_context>",
  "This session runs in a Managed Copilot shared environment. It has no shell, no file system, and no direct network access.",
  "Use only the tools available in this session. Never write tool calls, shell commands, or code meant to be executed as plain text.",
  "If a request needs a capability this session does not have, say so briefly and answer as well as you can from what you know.",
  "</environment_context>",
].join("\n");

/** The environment section of promotable sessions while they are shared: steer work that needs a workspace to the move. */
export const PROMOTABLE_ENVIRONMENT_CONTEXT = [
  "<environment_context>",
  "This session runs in a Managed Copilot shared environment. Right now it has no shell, no file system, and no direct network access.",
  "It can move into its own Linux sandbox with a shell, Python, and files: when a task needs to run code or commands, or to read or write files, call request_sandbox first; the conversation continues there.",
  "Use only the tools available in this session. Never write tool calls, shell commands, or code meant to be executed as plain text.",
  "</environment_context>",
].join("\n");

/** Replaces the runtime's host environment section in shared sessions' system prompts. */
export function lockSystemMessage(supplied: unknown, options: { readonly promotable?: boolean } = {}): unknown {
  const environment = { action: "replace", content: options.promotable ? PROMOTABLE_ENVIRONMENT_CONTEXT : SHARED_ENVIRONMENT_CONTEXT };
  const defaults = { environment_context: environment, code_change_rules: { action: "remove" } };
  if (supplied === undefined || supplied === null) return { mode: "customize", sections: defaults };
  if (!isRecord(supplied)) throw new ManagedCopilotError("invalid_request", "systemMessage must be an object");
  switch (supplied["mode"]) {
    case "replace":
      return supplied;
    case "customize": {
      const sections = isRecord(supplied["sections"]) ? supplied["sections"] : {};
      return { ...supplied, sections: { ...defaults, ...sections, environment_context: environment } };
    }
    case "append":
    case undefined:
      return { mode: "customize", ...(supplied["content"] !== undefined ? { content: supplied["content"] } : {}), sections: defaults };
    default:
      throw new ManagedCopilotError("invalid_request", `Unknown systemMessage mode "${String(supplied["mode"])}"`);
  }
}

interface ToolFilterInput {
  readonly availableTools: unknown;
  readonly excludedTools: unknown;
}

/** Built-in tool names a shared session may use. Web access goes through the gateway's `web_fetch` platform tool. */
export function sharedBuiltins(environment: ResolvedEnvironment, _network: NetworkPolicy): string[] {
  const names: string[] = [...SESSION_SAFE_BUILTINS];
  if (environment.customizations?.skillDirectory) names.push("skill");
  return names;
}

/** Intersects the caller's tool filters with the shared environment's allowlist (source-qualified names). */
export function sharedToolFilters(
  input: ToolFilterInput,
  environment: ResolvedEnvironment,
  network: NetworkPolicy,
  allowMcp: boolean,
  options: { hasAgents?: boolean } = {},
): { availableTools: string[]; excludedTools?: string[] } {
  const builtins = sharedBuiltins(environment, network);
  const defaults = options.hasAgents ? builtins : builtins.filter((name) => !(SUBAGENT_BUILTINS as readonly string[]).includes(name));
  const base = [...defaults.map((name) => `builtin:${name}`), "custom:*", ...(allowMcp ? ["mcp:*"] : [])];
  const requested = stringList(input.availableTools, "availableTools");
  const excluded = stringList(input.excludedTools, "excludedTools");
  let availableTools = base;
  if (requested) {
    const result = new Set<string>();
    for (const entry of requested) {
      const [source, name] = entry.includes(":") ? (entry.split(":", 2) as [string, string]) : [undefined, entry];
      if (source === "builtin") {
        if (name === "*") for (const builtin of builtins) result.add(`builtin:${builtin}`);
        else if (builtins.includes(name)) result.add(`builtin:${name}`);
      } else if (source === "custom") {
        result.add(`custom:${name}`);
      } else if (source === "mcp") {
        if (allowMcp) result.add(`mcp:${name}`);
      } else if (source === undefined) {
        if (builtins.includes(name)) result.add(`builtin:${name}`);
        result.add(`custom:${name}`);
        if (allowMcp) result.add(`mcp:${name}`);
      } else {
        throw new ManagedCopilotError("invalid_request", `Unknown tool source "${source}" in availableTools`);
      }
    }
    availableTools = [...result];
  }
  return { availableTools, ...(excluded && excluded.length > 0 ? { excludedTools: excluded } : {}) };
}

export function isRemoteMcp(config: Record<string, unknown>): boolean {
  return (config["type"] === "http" || config["type"] === "sse") && typeof config["url"] === "string" && config["command"] === undefined;
}

function admitMcpServers(value: unknown, placement: Placement, owner: string | undefined, remote: { name: string; url: string; agent?: string }[]): unknown {
  if (value === undefined || value === null) return DROP;
  if (!isRecord(value)) throw new ManagedCopilotError("invalid_request", "mcpServers must be an object");
  for (const [name, server] of Object.entries(value)) {
    if (!isRecord(server)) throw new ManagedCopilotError("invalid_request", `mcpServers.${name} must be an object`);
    if (placement === "shared") {
      if (!isRemoteMcp(server)) {
        throw violation(`MCP server "${name}"${owner ? ` (custom agent "${owner}")` : ""} runs a local command; shared environments allow only remote http/sse MCP servers`);
      }
      if (server["cwd"] !== undefined || server["env"] !== undefined) throw violation(`MCP server "${name}" sets local process options that shared environments do not allow`);
    }
    if (isRemoteMcp(server)) {
      let url: URL;
      try {
        url = new URL(server["url"] as string);
      } catch {
        throw new ManagedCopilotError("invalid_request", `MCP server "${name}" has an invalid URL`);
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") throw violation(`MCP server "${name}" must use http(s)`);
      remote.push({ name, url: url.toString(), ...(owner ? { agent: owner } : {}) });
    }
  }
  return value;
}

function admitCustomAgents(value: unknown, context: AdmissionContext, remote: { name: string; url: string; agent?: string }[]): unknown {
  if (value === undefined || value === null) return DROP;
  if (!Array.isArray(value)) throw new ManagedCopilotError("invalid_request", "customAgents must be a list");
  const deployed = new Set(context.environment.customizations?.agents.map((agent) => agent.name) ?? []);
  const seen = new Set<string>();
  return value.map((agent, index) => {
    if (!isRecord(agent) || typeof agent["name"] !== "string" || !agent["name"]) throw new ManagedCopilotError("invalid_request", `customAgents[${index}] needs a name`);
    const name = agent["name"];
    if (seen.has(name)) throw new ManagedCopilotError("invalid_request", `Custom agent "${name}" is declared twice`);
    seen.add(name);
    if (deployed.has(name)) throw new ManagedCopilotError("conflict", `Custom agent "${name}" would shadow the agent deployed with environment "${context.environment.name}"; choose another name`);
    if (agent["model"] !== undefined) checkModel(context.environment, agent["model"]);
    if (context.placement === "shared" && agent["hooks"] !== undefined && agent["hooks"] !== null && Object.keys(agent["hooks"] as object).length > 0) {
      throw violation(`Custom agent "${name}" declares hooks; shared environments do not run hook actions`);
    }
    const mcpServers = admitMcpServers(agent["mcpServers"], context.placement, name, remote);
    const { mcpServers: _ignored, ...rest } = agent;
    return mcpServers === DROP ? rest : { ...rest, mcpServers };
  });
}

function admitTools(value: unknown, context: AdmissionContext): { declarations: Record<string, unknown>[]; names: string[] } {
  const declarations: Record<string, unknown>[] = [];
  const names: string[] = [];
  if (value !== undefined && value !== null) {
    if (!Array.isArray(value)) throw new ManagedCopilotError("invalid_request", "tools must be a list");
    for (const [index, tool] of value.entries()) {
      if (!isRecord(tool) || typeof tool["name"] !== "string" || !tool["name"]) throw new ManagedCopilotError("invalid_request", `tools[${index}] needs a name`);
      const name = tool["name"];
      if (names.includes(name)) throw new ManagedCopilotError("invalid_request", `Tool "${name}" is declared more than once`);
      if (context.platformTools.some((platform) => platform.name === name) || PLATFORM_RESERVED.has(name)) {
        throw new ManagedCopilotError("conflict", `Tool name "${name}" is reserved by the platform in environment "${context.environment.name}"`);
      }
      declarations.push(tool);
      names.push(name);
    }
  }
  for (const tool of context.platformTools) {
    declarations.push({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      skipPermission: tool.skipPermission,
      ...(tool.overridesBuiltInTool ? { overridesBuiltInTool: true } : {}),
    });
  }
  return { declarations, names };
}

/** Names reserved for platform tools even when the owning module is not registered. */
const PLATFORM_RESERVED = new Set(["schedule_task", "list_schedules", "cancel_schedule", "request_sandbox"]);

function sandboxPath(value: unknown, field: string, root: string): string {
  if (typeof value !== "string" || !value) throw new ManagedCopilotError("invalid_request", `${field} must be a path`);
  const normalized = value.replace(/\\/g, "/");
  const absolute = normalized.startsWith("/") ? normalized : `${root.replace(/\/+$/, "")}/${normalized}`;
  const segments: string[] = [];
  for (const segment of absolute.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) throw violation(`${field} escapes the sandbox workspace`);
      segments.pop();
    } else segments.push(segment);
  }
  const resolved = `/${segments.join("/")}`;
  if (resolved !== root && !resolved.startsWith(`${root.replace(/\/+$/, "")}/`)) throw violation(`${field} must be inside ${root}`);
  return resolved;
}

/** Admits `session.create` / `session.resume` params for a placement. */
export function admitSession(raw: unknown, context: AdmissionContext, mode: "create" | "resume"): AdmittedSession {
  if (!isRecord(raw)) throw new ManagedCopilotError("invalid_request", `${mode === "create" ? "session.create" : "session.resume"} params must be an object`);
  const shared = context.placement === "shared";
  // Promotable sessions (request_sandbox injected) are told how to get a workspace instead of to do without one.
  const promotable = context.platformTools.some((tool) => tool.name === "request_sandbox");
  const environment = context.environment;
  const bundle = environment.customizations;
  const remoteMcp: { name: string; url: string; agent?: string }[] = [];
  let callerToken: string | undefined;

  const common: Record<string, Rule> = {
    sessionId: pass,
    model: (value) => {
      checkModel(environment, value);
      return value;
    },
    allowedModels: (value) => {
      const list = stringList(value, "allowedModels");
      if (!list) return DROP;
      const allowed = environment.config.models;
      return allowed ? list.filter((model) => allowed.includes(model)) : list;
    },
    name: pass,
    clientName: pass,
    reasoningEffort: pass,
    reasoningSummary: pass,
    isExperimentalMode: pass,
    contextTier: pass,
    toolSearch: pass,
    imageGeneration: pass,
    canvases: pass,
    requestCanvasRenderer: pass,
    canvasProvider: pass,
    commands: pass,
    excludedBuiltinAgents: pass,
    enableSessionTelemetry: pass,
    enableCitations: pass,
    enableFileChangeTracking: pass,
    sessionLimits: pass,
    autopilot: pass,
    modelCapabilities: pass,
    requestPermission: pass,
    requestUserInput: pass,
    requestElicitation: pass,
    askUserVariant: pass,
    requestMcpApps: pass,
    githubMcpToolConfig: pass,
    requestExitPlanMode: pass,
    requestAutoModeSwitch: pass,
    hooks: pass,
    streaming: pass,
    includeSubAgentStreamingEvents: pass,
    enableGitHubTelemetryForwarding: pass,
    authClientIdMetadataUrl: pass,
    organizationCustomInstructions: pass,
    disabledSkills: pass,
    disabledMcpServers: pass,
    infiniteSessions: pass,
    interactiveUser: pass,
    traceparent: pass,
    tracestate: pass,
    allowTranscriptRecovery: pass,
    disableResume: pass,
    continuePendingWork: pass,
    openCanvases: pass,
    refreshCustomInstructions: pass,
    hasSkillProvider: pass,
    defaultAgent: pass,
    agent: (value) => {
      if (value === undefined || value === null) return DROP;
      if (typeof value !== "string") throw new ManagedCopilotError("invalid_request", "agent must be a string");
      return value;
    },
    systemMessage: (value) => (shared ? lockSystemMessage(value, { promotable }) : value === undefined ? DROP : value),
    largeOutput: (value) => {
      if (value === undefined || value === null) return DROP;
      if (!isRecord(value)) throw new ManagedCopilotError("invalid_request", "largeOutput must be an object");
      if (shared && (value["outputDir"] !== undefined || value["outputDirectory"] !== undefined)) throw violation("largeOutput.outputDirectory writes to the host filesystem; shared environments do not allow it");
      return value;
    },
    mcpServers: (value) => admitMcpServers(value, context.placement, undefined, remoteMcp),
    customAgents: (value) => admitCustomAgents(value, context, remoteMcp),
    customAgentsLocalOnly: (value) => {
      if (value === false && shared) throw violation("customAgentsLocalOnly cannot be disabled in shared environments");
      return DROP;
    },
    envValueMode: () => DROP,
    mcpOAuthTokenStorage: () => DROP,
    embeddingCacheStorage: () => DROP,
    skipEmbeddingRetrieval: pass,
    enableSkills: (value) => {
      if (value === true && shared && !bundle?.skillDirectory) throw violation(`Environment "${environment.name}" deploys no skills; ship them in its customizations folder`);
      return value === false ? false : DROP;
    },
    gitHubToken: (value) => {
      if (typeof value === "string" && value) callerToken = value;
      return DROP;
    },
    gitHubTokenProviderRegistrationId: rejectIfSet("gitHubTokenProvider is not supported by Managed Copilot; pass gitHubToken to managed.client(...) instead", unavailable),
    provider: rejectIfSet("Custom model providers are not available; model calls use the session owner's GitHub Copilot entitlement or the environment's configured inference route"),
    providers: rejectIfSet("Custom model providers are not available; model calls use the session owner's GitHub Copilot entitlement or the environment's configured inference route"),
    capi: rejectIfSet("Custom Copilot API endpoints are not available in Managed Copilot"),
    models: rejectIfSet("Provider model definitions (BYOK) are not available in Managed Copilot"),
    cloud: rejectIfSet("Cloud sessions are not available through Managed Copilot", unavailable),
    featureFlags: rejectIfSet("{key} is controlled by the platform"),
    expAssignments: rejectIfSet("{key} is controlled by the platform"),
    enableManagedSettings: rejectIfSet("{key} is controlled by the platform"),
    enforceManagedModelDefaults: rejectIfSet("{key} is controlled by the platform"),
    managedSettings: rejectIfSet("{key} is controlled by the platform"),
    diagnostics: rejectIfSet("{key} is controlled by the platform"),
    sandboxConfig: rejectIfSet("{key} is controlled by the platform"),
    configDir: rejectIfSet("{key} would read configuration from the platform host; use the environment's customizations folder"),
    extensionSdkPath: rejectIfSet("Extensions are not available through Managed Copilot", unavailable),
    extensionInfo: rejectIfSet("Extensions are not available through Managed Copilot", unavailable),
    requestExtensions: rejectIfSet("Extensions are not available through Managed Copilot", unavailable),
    workflows: rejectIfSet("Extension workflows are not available through Managed Copilot", unavailable),
    requestedEnvironmentVariables: rejectIfSet("Extension environment variables are not available through Managed Copilot", unavailable),
    availableTools: () => DROP,
    excludedTools: () => DROP,
    toolFilterPrecedence: () => DROP,
    tools: () => DROP,
  };

  const sharedRules: Record<string, Rule> = {
    workingDirectory: rejectIfSet("workingDirectory is managed by the platform; shared sessions have no workload filesystem"),
    trustWorkingDirectory: rejectIfSet("{key} is not available in shared environments"),
    additionalDirectories: rejectIfSet("additionalDirectories would grant access to the platform host; shared sessions have no workload filesystem"),
    enableConfigDiscovery: onlyFalse("Ambient configuration discovery"),
    enableOnDemandInstructionDiscovery: onlyFalse("On-demand instruction discovery"),
    enableFileHooks: onlyFalse("File hooks"),
    enableHostGitOperations: onlyFalse("Host git operations"),
    enableSessionStore: onlyFalse("The cross-session store"),
    memory: (value) => {
      if (isRecord(value) && value["enabled"] === true) throw violation("Memory is not available in shared environments (it is cross-session state)");
      return DROP;
    },
    skillDirectories: rejectIfSet("Ship skills in the environment's customizations folder; {key} is not accepted from callers"),
    agentDirectories: rejectIfSet("Ship agents in the environment's customizations folder; {key} is not accepted from callers"),
    instructionDirectories: rejectIfSet("Ship instructions in the environment's customizations folder; {key} is not accepted from callers"),
    hookDirectories: rejectIfSet("Hooks are not available in shared environments"),
    pluginDirectories: rejectIfSet("Plugins are not available in shared environments"),
  };

  const sandboxRules: Record<string, Rule> = {
    workingDirectory: (value) => (value === undefined || value === null ? DROP : sandboxPath(value, "workingDirectory", context.workingDirectory)),
    trustWorkingDirectory: pass,
    additionalDirectories: (value) => {
      const list = stringList(value, "additionalDirectories");
      return list ? list.map((entry, index) => sandboxPath(entry, `additionalDirectories[${index}]`, context.workingDirectory)) : DROP;
    },
    enableConfigDiscovery: pass,
    enableOnDemandInstructionDiscovery: pass,
    enableFileHooks: pass,
    enableHostGitOperations: pass,
    enableSessionStore: pass,
    memory: pass,
    skillDirectories: pass,
    agentDirectories: pass,
    instructionDirectories: pass,
    hookDirectories: pass,
    pluginDirectories: pass,
  };

  const rules = { ...common, ...(shared ? sharedRules : sandboxRules) };
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const rule = rules[key];
    if (!rule) throw unavailable(`Session option "${key}" is not supported by Managed Copilot`, { option: key });
    const admitted = rule(value, key);
    if (admitted !== DROP) params[key] = admitted;
  }

  // Environment defaults the platform owns.
  const tools = admitTools(raw["tools"], context);
  const directories = bundleDirectories(context);
  params["tools"] = tools.declarations;
  params["envValueMode"] = "direct";
  params["mcpOAuthTokenStorage"] = "in-memory";
  params["gitHubTokenProviderRegistrationId"] = context.tokenRegistrationId;
  params["toolFilterPrecedence"] = "excluded";
  const models = environment.config.models;
  if (models && models.length > 0) {
    if (params["model"] === undefined && mode === "create") params["model"] = models[0];
    if (params["allowedModels"] === undefined) params["allowedModels"] = [...models];
  }
  if (shared) {
    params["workingDirectory"] = context.workingDirectory;
    params["customAgentsLocalOnly"] = true;
    params["enableConfigDiscovery"] = false;
    params["enableOnDemandInstructionDiscovery"] = false;
    params["enableFileHooks"] = false;
    params["enableHostGitOperations"] = false;
    params["enableSessionStore"] = false;
    params["memory"] = { enabled: false };
    params["embeddingCacheStorage"] = "in-memory";
    if (params["systemMessage"] === undefined) params["systemMessage"] = lockSystemMessage(undefined, { promotable });
    params["enableSkills"] = params["enableSkills"] === false ? false : Boolean(directories.skills);
    if (directories.skills) params["skillDirectories"] = [directories.skills];
    if (directories.agents) params["agentDirectories"] = [directories.agents];
    if (directories.instructions) params["instructionDirectories"] = [directories.instructions];
    const hasAgents = (environment.customizations?.agents.length ?? 0) > 0 || (Array.isArray(raw["customAgents"]) && raw["customAgents"].length > 0) || typeof raw["agent"] === "string";
    const filters = sharedToolFilters({ availableTools: raw["availableTools"], excludedTools: raw["excludedTools"] }, environment, context.network, remoteMcp.length > 0, { hasAgents });
    params["availableTools"] = filters.availableTools;
    if (filters.excludedTools) params["excludedTools"] = filters.excludedTools;
    // The runtime's built-in GitHub MCP server would egress directly from the shared runtime host.
    const disabled = stringList(params["disabledMcpServers"], "disabledMcpServers") ?? [];
    params["disabledMcpServers"] = [...new Set([...disabled, ...BUILTIN_MCP_SERVERS])];
  } else {
    params["workingDirectory"] ??= context.workingDirectory;
    const available = stringList(raw["availableTools"], "availableTools");
    const excluded = stringList(raw["excludedTools"], "excludedTools");
    if (available) params["availableTools"] = available;
    if (excluded && excluded.length > 0) params["excludedTools"] = excluded;
    if (directories.skills) params["skillDirectories"] = [...((params["skillDirectories"] as string[] | undefined) ?? []), directories.skills];
    if (directories.agents) params["agentDirectories"] = [...((params["agentDirectories"] as string[] | undefined) ?? []), directories.agents];
    if (directories.instructions) params["instructionDirectories"] = [...((params["instructionDirectories"] as string[] | undefined) ?? []), directories.instructions];
    if (directories.skills && params["enableSkills"] === undefined) params["enableSkills"] = true;
  }

  const optionsPatch: Record<string, unknown> = shared
    ? {
        skipCustomInstructions: !bundle?.instructionDirectory,
        customAgentsLocalOnly: true,
        coauthorEnabled: false,
        manageScheduleEnabled: false,
        installedPlugins: [],
        includedBuiltinSkills: [],
      }
    : {};

  const model = typeof params["model"] === "string" ? params["model"] : undefined;
  const agent = typeof params["agent"] === "string" ? params["agent"] : undefined;
  return {
    params,
    client: {
      tools: tools.names,
      requestPermission: raw["requestPermission"] === true,
      requestUserInput: raw["requestUserInput"] === true,
      requestElicitation: raw["requestElicitation"] === true,
    },
    ...(model ? { model } : {}),
    ...(agent ? { agent } : {}),
    ...(callerToken ? { callerToken } : {}),
    remoteMcp,
    optionsPatch,
  };
}

/** Admits a client's `session.options.update` patch. */
export function admitOptionsUpdate(raw: unknown, context: AdmissionContext): Record<string, unknown> {
  if (!isRecord(raw)) throw new ManagedCopilotError("invalid_request", "session.options.update params must be an object");
  const shared = context.placement === "shared";
  const environment = context.environment;
  const bundle = environment.customizations;
  const patch: Record<string, unknown> = {};
  const sharedOnlyValue = (key: string, expected: unknown, value: unknown) => {
    if (shared && JSON.stringify(value) !== JSON.stringify(expected)) throw violation(`${key} cannot be changed in shared environments`);
    return value;
  };
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || key === "sessionId") continue;
    switch (key) {
      case "model":
        checkModel(environment, value);
        patch[key] = value;
        break;
      case "reasoningEffort":
      case "reasoningSummary":
      case "verbosity":
      case "clientName":
      case "enableStreaming":
      case "askUserDisabled":
      case "continueOnAutoMode":
      case "enableReasoningSummaries":
      case "contextTier":
      case "sessionLimits":
      case "autopilot":
      case "imageGeneration":
      case "disabledSkills":
      case "disabledInstructionSources":
      case "excludedBuiltinAgents":
      case "suppressCustomAgentPrompt":
      case "skipEmbeddingRetrieval":
      case "isExperimentalMode":
      case "organizationCustomInstructions":
      case "skipCustomInstructions":
        patch[key] = value;
        break;
      case "customAgentsLocalOnly":
        patch[key] = sharedOnlyValue(key, true, value);
        break;
      case "coauthorEnabled":
      case "manageScheduleEnabled":
        patch[key] = sharedOnlyValue(key, false, value);
        break;
      case "installedPlugins":
      case "includedBuiltinSkills":
        patch[key] = sharedOnlyValue(key, [], value);
        break;
      case "enableSkills":
        if (value === true && shared && !bundle?.skillDirectory) throw violation(`Environment "${environment.name}" deploys no skills`);
        patch[key] = value;
        break;
      case "enableFileHooks":
      case "enableHostGitOperations":
      case "enableSessionStore":
      case "enableOnDemandInstructionDiscovery":
        patch[key] = sharedOnlyValue(key, false, value);
        break;
      case "availableTools":
      case "excludedTools":
        if (shared) {
          const filters = sharedToolFilters({ availableTools: key === "availableTools" ? value : undefined, excludedTools: key === "excludedTools" ? value : undefined }, environment, context.network, context.allowMcp === true);
          if (key === "availableTools") patch[key] = filters.availableTools;
          else patch[key] = filters.excludedTools ?? [];
        } else patch[key] = stringList(value, key);
        break;
      case "toolFilterPrecedence":
        patch[key] = "excluded";
        break;
      case "workingDirectory":
        if (shared) throw violation("workingDirectory is managed by the platform; shared sessions have no workload filesystem");
        patch[key] = sandboxPath(value, "workingDirectory", context.workingDirectory);
        break;
      default:
        if (!shared && ["shell", "shellInitProfile", "shellProcessFlags", "logInteractiveShells", "enableScriptSafety", "maxInlineBinaryBytes", "trajectoryFile", "eventsLogDirectory", "eventsLogIncludesSubagents", "skillDirectories", "agentDirectories", "instructionDirectories", "hookDirectories", "ignoredSkillsLocations", "includedBuiltinAgents", "allowAllMcpServerInstructions", "additionalContentExclusionPolicies"].includes(key)) {
          patch[key] = value;
          break;
        }
        throw violation(`Session option "${key}" cannot be changed through Managed Copilot`, { option: key });
    }
  }
  return patch;
}

/** Admits a client's `session.tools.set` (setTools): the complete set of tools this client supplies. */
export function admitToolsSet(raw: unknown, context: AdmissionContext): { params: Record<string, unknown>; names: string[] } {
  if (!isRecord(raw)) throw new ManagedCopilotError("invalid_request", "session.tools.set params must be an object");
  const tools = admitTools(raw["tools"] ?? [], context);
  return { params: { ...raw, tools: tools.declarations }, names: tools.names };
}

/** Admits an agent selection against the environment's deployed and inline agents. */
export function admitAgentSelect(raw: unknown): void {
  if (!isRecord(raw) || (raw["name"] !== undefined && typeof raw["name"] !== "string")) throw new ManagedCopilotError("invalid_request", "session.agent.select needs an agent name");
}

/** Model-request headers a caller may not set: credentials and routing that belong to the platform. */
const RESERVED_REQUEST_HEADERS = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-github-.*|copilot-.*|openai-.*|anthropic-.*|x-request-id|host)$/i;

/**
 * Admits `session.send` / `session.sendAndWait` params. Shared sessions accept only inline (`blob`) attachments:
 * the runtime reads file, directory, and selection paths from its own filesystem, which is the platform host.
 */
export function admitSend(input: unknown, context: AdmissionContext): Record<string, unknown> {
  if (!isRecord(input)) throw new ManagedCopilotError("invalid_request", "send params must be an object");
  let raw: Record<string, unknown> = input;
  const shared = context.placement === "shared";
  const attachments = raw["attachments"];
  if (attachments !== undefined && attachments !== null) {
    if (!Array.isArray(attachments)) throw new ManagedCopilotError("invalid_request", "attachments must be a list");
    raw = {
      ...raw,
      attachments: attachments.map((attachment, index) => {
        if (!isRecord(attachment) || typeof attachment["type"] !== "string") throw new ManagedCopilotError("invalid_request", `attachments[${index}] needs a type`);
        const type = attachment["type"];
        if (type === "blob") return attachment;
        if (shared) {
          throw violation(`Attachment type "${type}" refers to a file path; shared sessions have no workload filesystem. Send the content inline as a blob attachment.`);
        }
        if (type === "file" || type === "directory") return { ...attachment, path: sandboxPath(attachment["path"], `attachments[${index}].path`, context.workingDirectory) };
        if (type === "selection") return { ...attachment, filePath: sandboxPath(attachment["filePath"], `attachments[${index}].filePath`, context.workingDirectory) };
        throw unavailable(`Attachment type "${type}" is not supported by Managed Copilot`);
      }),
    };
  }
  if (shared && raw["agentMode"] === "shell") throw violation("Shell mode is not available in shared environments");
  const headers = raw["requestHeaders"];
  if (headers !== undefined && headers !== null) {
    if (!isRecord(headers)) throw new ManagedCopilotError("invalid_request", "requestHeaders must be an object");
    const reserved = Object.keys(headers).filter((name) => RESERVED_REQUEST_HEADERS.test(name));
    if (reserved.length > 0) throw violation(`Model request headers ${reserved.join(", ")} are controlled by the platform`);
  }
  return raw;
}
