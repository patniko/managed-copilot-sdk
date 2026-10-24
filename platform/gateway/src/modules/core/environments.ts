// Environment resolution: named and inline environments, network ceilings narrowed by the caller, and deployed
// customization bundles (agents, skills, instructions) pinned into a platform-owned directory at startup.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  EnvironmentRequestSchema,
  ManagedCopilotError,
  narrowNetwork,
  normalizeNetwork,
  NETWORK_ENABLED,
  type EnvironmentConfig,
  type EnvironmentInfo,
  type EnvironmentRequest,
  type ManagedCopilotConfig,
  type NetworkPolicy,
} from "@managed-copilot/protocol";
import type { Logger } from "../../log.js";
import type { CustomizationBundle, EnvironmentResolver, ResolvedEnvironment, SessionRecord } from "./contracts.js";

interface BundleState {
  readonly bundle?: CustomizationBundle;
  /** Why the bundle cannot be used (sessions in this environment fail with `policy_violation`). */
  readonly problem?: string;
}

export interface AgentFile {
  readonly name: string;
  readonly description?: string;
  readonly model?: string;
  readonly tools?: readonly string[];
  /** Frontmatter keys that declare executable capabilities (local MCP servers, hooks). */
  readonly executableKeys: readonly string[];
}

/** Parses the small YAML frontmatter subset Copilot agent files use (`key: value`, inline arrays, `- item` lists). */
export function parseAgentFile(fileName: string, content: string): AgentFile {
  const fallbackName = basename(fileName).replace(/\.agent\.md$/i, "").replace(/\.md$/i, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  const fields = new Map<string, string | string[]>();
  const keys: string[] = [];
  if (match) {
    let listKey: string | undefined;
    for (const rawLine of match[1]!.split(/\r?\n/)) {
      const line = rawLine.replace(/\s+#.*$/, "");
      if (!line.trim()) continue;
      const item = /^\s+-\s*(.*)$/.exec(line);
      if (item && listKey) {
        const list = fields.get(listKey);
        if (Array.isArray(list)) list.push(unquote(item[1]!));
        continue;
      }
      const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
      if (!pair) continue;
      const key = pair[1]!;
      const value = pair[2]!.trim();
      keys.push(key);
      listKey = undefined;
      if (value === "") {
        fields.set(key, []);
        listKey = key;
      } else if (value.startsWith("[") && value.endsWith("]")) {
        fields.set(key, value.slice(1, -1).split(",").map((part) => unquote(part.trim())).filter(Boolean));
      } else {
        fields.set(key, unquote(value));
      }
    }
  }
  const name = fields.get("name");
  const description = fields.get("description");
  const model = fields.get("model");
  const tools = fields.get("tools");
  const executableKeys = keys.filter((key) => /^(mcp-servers|mcpServers|mcp_servers|hooks)$/i.test(key));
  return {
    name: typeof name === "string" && name ? name : fallbackName,
    ...(typeof description === "string" ? { description } : {}),
    ...(typeof model === "string" && model ? { model } : {}),
    ...(Array.isArray(tools) ? { tools } : typeof tools === "string" ? { tools: [tools] } : {}),
    executableKeys,
  };
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Customizations may not contain symbolic links (${relative(root, full)})`);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(root);
  return files.sort();
}

/** Pins an environment's customization folder into `<target>/<digest>` and describes what it contains. */
export function pinCustomizations(source: string, target: string): CustomizationBundle {
  if (!existsSync(source) || !statSync(source).isDirectory()) throw new Error(`Customizations folder ${source} does not exist`);
  const files = listFiles(source);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(source, file).split(sep).join("/"));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  const digest = hash.digest("hex").slice(0, 16);
  const root = join(target, digest);
  if (!existsSync(root)) {
    mkdirSync(target, { recursive: true });
    cpSync(source, root, { recursive: true, errorOnExist: false, force: true });
  }
  const agentDirectory = join(root, "agents");
  const skillDirectory = join(root, "skills");
  const instructionDirectory = join(root, "instructions");
  const agents: CustomizationBundle["agents"][number][] = [];
  const unsafe: string[] = [];
  if (existsSync(agentDirectory)) {
    for (const file of readdirSync(agentDirectory)) {
      if (!/\.md$/i.test(file)) continue;
      const agent = parseAgentFile(file, readFileSync(join(agentDirectory, file), "utf8"));
      if (agent.executableKeys.length > 0) unsafe.push(`agents/${file} declares ${agent.executableKeys.join(", ")}`);
      agents.push({ name: agent.name, ...(agent.description ? { description: agent.description } : {}), ...(agent.model ? { model: agent.model } : {}), ...(agent.tools ? { tools: agent.tools } : {}) });
    }
  }
  const hasSkills = existsSync(skillDirectory) && readdirSync(skillDirectory, { withFileTypes: true }).some((entry) => entry.isDirectory() && existsSync(join(skillDirectory, entry.name, "SKILL.md")));
  const hasInstructions = existsSync(instructionDirectory) && readdirSync(instructionDirectory).some((file) => /\.md$/i.test(file));
  for (const folder of ["hooks", "plugins"]) {
    if (existsSync(join(root, folder))) unsafe.push(`${folder}/ (executable customizations are not deployed with environments)`);
  }
  const bundle: CustomizationBundle & { unsafe?: readonly string[] } = {
    root,
    digest,
    agents,
    ...(agents.length > 0 ? { agentDirectory } : {}),
    ...(hasSkills ? { skillDirectory } : {}),
    ...(hasInstructions ? { instructionDirectory } : {}),
    ...(unsafe.length > 0 ? { unsafe } : {}),
  };
  return bundle;
}

export interface EnvironmentsOptions {
  readonly deployment: ManagedCopilotConfig;
  /** Directory relative `customizations` paths resolve against (the AppHost directory). */
  readonly baseDir: string;
  /** Platform-owned directory for pinned customization copies. */
  readonly pinDir: string;
  readonly log: Logger;
}

export class Environments implements EnvironmentResolver {
  readonly #deployment: ManagedCopilotConfig;
  readonly #bundles = new Map<string, BundleState>();
  readonly #defaultNetwork: NetworkPolicy;

  constructor(options: EnvironmentsOptions) {
    this.#deployment = options.deployment;
    this.#defaultNetwork = normalizeNetwork(options.deployment.network, NETWORK_ENABLED);
    for (const [name, env] of Object.entries(options.deployment.environments)) {
      if (!env.customizations) continue;
      const source = isAbsolute(env.customizations) ? env.customizations : resolve(options.baseDir, env.customizations);
      try {
        const bundle = pinCustomizations(source, join(options.pinDir, name)) as CustomizationBundle & { unsafe?: readonly string[] };
        const problems: string[] = [];
        if (bundle.unsafe && bundle.unsafe.length > 0 && env.type !== "isolated") problems.push(`include executable configuration: ${bundle.unsafe.join("; ")}`);
        const outside = env.models ? bundle.agents.filter((agent) => agent.model && !env.models!.includes(agent.model)) : [];
        if (outside.length > 0) problems.push(`select models the environment does not allow: ${outside.map((agent) => `${agent.name} uses ${agent.model}`).join("; ")}`);
        const problem = problems.length > 0 ? `Customizations for "${name}" ${problems.join(", and ")}` : undefined;
        if (problem) options.log.error("Environment customizations rejected", { environment: name, problem });
        else options.log.info("Pinned environment customizations", { environment: name, digest: bundle.digest, agents: bundle.agents.map((agent) => agent.name) });
        this.#bundles.set(name, problem ? { bundle, problem } : { bundle });
      } catch (error) {
        const problem = `Customizations for "${name}" could not be loaded: ${(error as Error).message}`;
        options.log.error("Environment customizations unavailable", { environment: name, problem });
        this.#bundles.set(name, { problem });
      }
    }
  }

  get deployment(): ManagedCopilotConfig {
    return this.#deployment;
  }

  /** The policy ceiling of a declared environment (deployment default, then the environment's own setting). */
  ceiling(config: EnvironmentConfig): NetworkPolicy {
    return normalizeNetwork(config.network, this.#defaultNetwork);
  }

  resolve(input: EnvironmentRequest | string): ResolvedEnvironment {
    const parsed = EnvironmentRequestSchema.safeParse(typeof input === "string" ? { name: input } : input);
    if (!parsed.success) {
      throw new ManagedCopilotError("invalid_request", "The environment selector is invalid", {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
    const request = parsed.data;
    let name: string;
    let config: EnvironmentConfig;
    let inline = false;
    if (request.name !== undefined) {
      const declared = this.#deployment.environments[request.name];
      if (!declared) {
        const known = Object.keys(this.#deployment.environments);
        throw new ManagedCopilotError("environment_not_found", `Unknown environment "${request.name}".${known.length > 0 ? ` This deployment offers: ${known.join(", ")}.` : ""}`, { environment: request.name });
      }
      if (request.type !== undefined && request.type !== declared.type) {
        throw new ManagedCopilotError("invalid_request", `Environment "${request.name}" is ${declared.type}, not ${request.type}`);
      }
      if (request.size !== undefined && request.size !== (declared.size ?? "small")) {
        throw new ManagedCopilotError("policy_violation", `Environment "${request.name}" uses size ${declared.size ?? "small"}; callers cannot change it`);
      }
      name = request.name;
      config = declared;
    } else {
      const type = request.type!;
      const allowed = this.#deployment.inline;
      if (!allowed || !allowed.types.includes(type)) {
        throw new ManagedCopilotError("environment_not_found", `This deployment does not allow inline ${type} environments. Use a declared environment name.`);
      }
      let size = request.size;
      if (type !== "shared") {
        const sizes = allowed.sizes ?? ["small"];
        size ??= sizes[0] ?? "small";
        if (!sizes.includes(size)) {
          throw new ManagedCopilotError("environment_not_found", `This deployment does not allow inline ${type} environments of size ${size} (allowed: ${sizes.join(", ")})`);
        }
      } else if (size !== undefined) {
        throw new ManagedCopilotError("invalid_request", "Shared environments have no sandbox size");
      }
      name = type === "shared" ? "inline-shared" : `inline-${type}-${size}`;
      config = { type, ...(size ? { size } : {}) };
      inline = true;
    }
    if (config.type === "shared" && (request.files || request.packages || request.env)) {
      throw new ManagedCopilotError("policy_violation", `Per-session files, packages, and env apply to sandbox environments; "${name}" is shared`);
    }
    const network = narrowNetwork(this.ceiling(config), request.network);
    const state = inline ? undefined : this.#bundles.get(name);
    if (state?.problem) throw new ManagedCopilotError("policy_violation", state.problem, { environment: name });
    return {
      name,
      type: config.type,
      inline,
      config,
      network,
      request,
      ...(state?.bundle ? { customizations: state.bundle } : {}),
    };
  }

  forSession(session: SessionRecord): ResolvedEnvironment {
    return this.resolve(session.environmentRequest);
  }

  info(): EnvironmentInfo[] {
    return Object.entries(this.#deployment.environments).map(([name, env]) => {
      const bundle = this.#bundles.get(name)?.bundle;
      return {
        name,
        type: env.type,
        ...(env.description ? { description: env.description } : {}),
        ...(env.models ? { models: env.models } : {}),
        network: this.ceiling(env),
        ...(env.type !== "shared" ? { size: env.size ?? "small" } : {}),
        ...(env.promoteTo ? { promoteTo: env.promoteTo } : {}),
        scheduling: env.scheduling === true,
        agents: bundle?.agents.map((agent) => agent.name) ?? [],
      };
    });
  }
}
