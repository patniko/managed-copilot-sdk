// Operator views of harness configuration: what a session's runtime was told to run with (its stored admitted
// configuration), and what an environment's sessions may use. Secrets are masked; none of this is conversation.
import type { EnvironmentConfig, NetworkPolicy, OperatorCustomAgent, OperatorHarness, OperatorHarnessTool, OperatorMcpServer, OperatorToolPolicy, Placement } from "@managed-copilot/protocol";
import { REDACTED, looksSecret, redactUrl, redactValue, scrubArgs } from "../../redaction.js";
import { isRecord, sharedBuiltins } from "./admission.js";
import type { CustomizationBundle, PlatformToolRegistry, RegisteredPlatformTool, ResolvedEnvironment } from "./contracts.js";
import type { AdmittedConfig } from "./ledger.js";

/** Settings admission always sets for shared placement: shown as enforced, not as caller options. */
const ENFORCED_KEYS = [
  "envValueMode",
  "mcpOAuthTokenStorage",
  "toolFilterPrecedence",
  "customAgentsLocalOnly",
  "enableConfigDiscovery",
  "enableOnDemandInstructionDiscovery",
  "enableFileHooks",
  "enableHostGitOperations",
  "enableSessionStore",
  "memory",
  "embeddingCacheStorage",
] as const;

/** Keys the harness view shows in fields of their own (everything else with a simple value is an option). */
const STRUCTURED_KEYS: ReadonlySet<string> = new Set([
  "sessionId",
  "model",
  "allowedModels",
  "agent",
  "reasoningEffort",
  "systemMessage",
  "availableTools",
  "excludedTools",
  "mcpServers",
  "customAgents",
  "workingDirectory",
  "skillDirectories",
  "agentDirectories",
  "instructionDirectories",
  "enableSkills",
  "disabledSkills",
  "tools",
  "gitHubToken",
  "gitHubTokenProviderRegistrationId",
  ...ENFORCED_KEYS,
]);

/** Option names that may carry credentials: never shown, whatever their value. */
const SENSITIVE_OPTION = /token|secret|password|passwd|credential|cookie|apikey|api_key|private|signature|authorization/i;

const strings = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined);
const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const nonEmpty = (value: readonly unknown[] | undefined): boolean => Array.isArray(value) && value.length > 0;

export interface HarnessContext {
  readonly placement: Placement;
  /** Platform tools injected for the session's environment and placement. */
  readonly platformTools: readonly RegisteredPlatformTool[];
  /** Rewrites gateway host paths (a shared session's working directory, pinned bundles) to what sessions see. */
  readonly scrub: (value: unknown) => unknown;
}

/** A session's admitted configuration as the operator console shows it. */
export function harnessOf(admitted: AdmittedConfig, context: HarnessContext): OperatorHarness {
  const params = context.scrub(admitted.params) as Record<string, unknown>;
  const requested = admitted.requested ? (context.scrub(admitted.requested) as Record<string, unknown>) : undefined;
  const callbacks = admitted.callbacks ?? { tools: [], flags: { requestPermission: true as const } };

  const tools: OperatorHarnessTool[] = [];
  const seen = new Set<string>();
  const addTool = (declaration: Record<string, unknown>, source: OperatorHarnessTool["source"]) => {
    const name = text(declaration["name"]);
    if (!name || seen.has(`${source}:${name}`)) return;
    seen.add(`${source}:${name}`);
    tools.push({
      name,
      source,
      ...(text(declaration["description"]) ? { description: text(declaration["description"])! } : {}),
      ...(isRecord(declaration["parameters"]) ? { parameters: redactValue(declaration["parameters"], { keys: false }) as Record<string, unknown> } : {}),
      ...(typeof declaration["skipPermission"] === "boolean" ? { skipPermission: declaration["skipPermission"] } : {}),
      ...(declaration["overridesBuiltInTool"] === true ? { overridesBuiltInTool: true } : {}),
    });
  };
  for (const tool of callbacks.tools) addTool(tool, "client");
  for (const tool of admitted.tools ?? []) addTool(tool, "server");
  for (const tool of context.platformTools) {
    addTool({ name: tool.name, description: tool.description, parameters: tool.parameters, skipPermission: tool.skipPermission, overridesBuiltInTool: tool.overridesBuiltInTool }, "platform");
  }

  const mcpServers: OperatorMcpServer[] = [];
  const requestedServers = isRecord(requested?.["mcpServers"]) ? requested["mcpServers"] : undefined;
  if (isRecord(params["mcpServers"])) {
    for (const [name, server] of Object.entries(params["mcpServers"])) {
      if (isRecord(server)) mcpServers.push(mcpServer(name, server, isRecord(requestedServers?.[name]) ? requestedServers[name] : undefined));
    }
  }
  const customAgents: OperatorCustomAgent[] = [];
  const requestedAgents = Array.isArray(requested?.["customAgents"]) ? (requested["customAgents"] as unknown[]).filter(isRecord) : [];
  for (const agent of Array.isArray(params["customAgents"]) ? (params["customAgents"] as unknown[]).filter(isRecord) : []) {
    const name = text(agent["name"]);
    if (!name) continue;
    const servers = isRecord(agent["mcpServers"]) ? agent["mcpServers"] : {};
    const original = requestedAgents.find((candidate) => candidate["name"] === name);
    const originalServers = isRecord(original?.["mcpServers"]) ? original["mcpServers"] : undefined;
    for (const [serverName, server] of Object.entries(servers)) {
      if (isRecord(server)) mcpServers.push(mcpServer(serverName, server, isRecord(originalServers?.[serverName]) ? originalServers[serverName] : undefined, name));
    }
    customAgents.push({
      name,
      ...(text(agent["displayName"]) ? { displayName: text(agent["displayName"])! } : {}),
      ...(text(agent["description"]) ? { description: text(agent["description"])! } : {}),
      ...(text(agent["model"]) ? { model: text(agent["model"])! } : {}),
      ...(strings(agent["tools"]) ? { tools: strings(agent["tools"])! } : {}),
      ...(text(agent["prompt"]) ? { prompt: text(agent["prompt"])! } : {}),
      mcpServers: Object.keys(servers).sort(),
    });
  }

  const options: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(params)) {
    if (STRUCTURED_KEYS.has(key) || SENSITIVE_OPTION.test(key)) continue;
    if (typeof value === "number" || typeof value === "boolean") options[key] = value;
    else if (typeof value === "string") options[key] = looksSecret(value) ? REDACTED : value;
  }
  const enforced = ENFORCED_KEYS.filter((key) => params[key] !== undefined).map((key) => `${key} = ${JSON.stringify(params[key])}`);

  const systemMessage = systemMessageOf(params["systemMessage"]);
  return {
    ...(text(params["model"]) ? { model: text(params["model"])! } : {}),
    ...(strings(params["allowedModels"]) ? { allowedModels: strings(params["allowedModels"])! } : {}),
    ...(text(params["agent"]) ? { agent: text(params["agent"])! } : {}),
    ...(text(params["reasoningEffort"]) ? { reasoningEffort: text(params["reasoningEffort"])! } : {}),
    ...(systemMessage ? { systemMessage } : {}),
    ...(strings(params["availableTools"]) ? { availableTools: strings(params["availableTools"])! } : {}),
    ...(strings(params["excludedTools"]) ? { excludedTools: strings(params["excludedTools"])! } : {}),
    tools,
    mcpServers,
    customAgents,
    customizations: {
      agents: nonEmpty(strings(params["agentDirectories"])),
      skills: nonEmpty(strings(params["skillDirectories"])),
      instructions: nonEmpty(strings(params["instructionDirectories"])),
    },
    skills: { enabled: params["enableSkills"] !== false, ...(strings(params["disabledSkills"])?.length ? { disabled: strings(params["disabledSkills"])! } : {}) },
    callbacks: { tools: callbacks.tools.map((tool) => String(tool["name"])).sort(), flags: Object.keys(callbacks.flags).sort() },
    ...(text(params["workingDirectory"]) ? { workingDirectory: text(params["workingDirectory"])! } : {}),
    options,
    enforced,
  };
}

function systemMessageOf(value: unknown): OperatorHarness["systemMessage"] | undefined {
  if (!isRecord(value)) return undefined;
  const sections: Record<string, { action: string; content?: string }> = {};
  if (isRecord(value["sections"])) {
    for (const [name, section] of Object.entries(value["sections"])) {
      if (!isRecord(section)) continue;
      sections[name] = { action: text(section["action"]) ?? "replace", ...(text(section["content"]) ? { content: text(section["content"])! } : {}) };
    }
  }
  return {
    mode: text(value["mode"]) ?? "append",
    ...(text(value["content"]) ? { content: text(value["content"])! } : {}),
    ...(Object.keys(sections).length > 0 ? { sections } : {}),
  };
}

/**
 * One MCP server. Shared sessions store the gateway adapter's address in `config`; `original` (the caller's request)
 * says where it really goes. Header and environment values are never shown, only their names.
 */
function mcpServer(name: string, config: Record<string, unknown>, original: Record<string, unknown> | undefined, agent?: string): OperatorMcpServer {
  const source = original ?? config;
  const url = text(source["url"]);
  const command = text(source["command"]);
  const args = Array.isArray(source["args"]) ? scrubArgs(source["args"] as unknown[]) : undefined;
  const tools = strings(source["tools"]);
  const adapter = original !== undefined && text(config["url"]) !== undefined && text(config["url"]) !== url;
  return {
    name,
    transport: text(source["type"]) ?? (command ? "stdio" : "unknown"),
    ...(url ? { url: redactUrl(url) } : {}),
    ...(command ? { command: looksSecret(command) ? REDACTED : command } : {}),
    ...(args ? { args } : {}),
    headers: isRecord(source["headers"]) ? Object.keys(source["headers"]).sort() : [],
    env: isRecord(source["env"]) ? Object.keys(source["env"]).sort() : [],
    ...(tools ? { tools } : {}),
    ...(agent ? { agent } : {}),
    ...(adapter ? { adapter: true } : {}),
  };
}

const SHARED_RULES = [
  "No shell, file system, or subprocess tools (shared placement is application isolation)",
  "Configuration, instruction, and hook discovery off; deployed customizations only",
  "Cross-session store, memory, and host git operations off",
  "Remote http/sse MCP servers only, through the gateway's MCP adapter",
  "The system prompt's environment section is set by the platform",
  "Model calls use the session owner's GitHub Copilot entitlement",
];
const SANDBOX_RULES = [
  "Workload tools run inside the session's own sandbox (uid 10001, /workspace)",
  "No GitHub token inside the sandbox: the gateway brokers model calls",
  "Outbound traffic goes through the egress proxy, which enforces the network policy",
  "Vault credentials reach the sandbox only as placeholders the proxy swaps on allowed hosts",
];

/** What sessions of an environment may use, as admission enforces it. */
export function toolPolicyOf(
  name: string,
  config: EnvironmentConfig,
  network: NetworkPolicy,
  customizations: CustomizationBundle | undefined,
  platformTools: PlatformToolRegistry,
): OperatorToolPolicy {
  const placements: Placement[] = config.type === "shared" ? ["shared"] : config.type === "isolated" ? ["sandbox"] : ["shared", "sandbox"];
  const platform = new Map<string, { name: string; description: string; placements: Placement[] }>();
  for (const placement of placements) {
    for (const tool of platformTools.forSession({ environment: name, type: config.type, placement })) {
      const entry = platform.get(tool.name) ?? { name: tool.name, description: tool.description, placements: [] };
      entry.placements.push(placement);
      platform.set(tool.name, entry);
    }
  }
  const resolved = { name, type: config.type, inline: false, config, network, request: { name }, ...(customizations ? { customizations } : {}) } as ResolvedEnvironment;
  const enforced = config.type === "isolated" ? SANDBOX_RULES : config.type === "shared" ? SHARED_RULES : [...SHARED_RULES.map((rule) => `Before promotion: ${rule}`), ...SANDBOX_RULES.map((rule) => `After promotion: ${rule}`)];
  return {
    builtins: config.type === "isolated" ? "all" : sharedBuiltins(resolved, network),
    platform: [...platform.values()].sort((a, b) => a.name.localeCompare(b.name)),
    mcp: config.type === "isolated" ? "any" : "remote",
    enforced: [...enforced, ...(config.models?.length ? [`Models limited to: ${config.models.join(", ")}`] : [])],
  };
}
