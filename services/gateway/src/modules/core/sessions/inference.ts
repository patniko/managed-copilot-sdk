// Inference routing (Azure AI Foundry, OpenAI-compatible endpoints) and session admission.
import { join } from "node:path";
import {
  DEFAULT_MAX_WORKERS,
  ManagedCopilotError,
  type NetworkPolicy,
  type Placement,
} from "@managed-copilot/protocol";
import type { Principal } from "../../../http.js";
import {
  admitSession,
  isRecord,
  isRemoteMcp,
  type AdmittedSession,
  type OrchestratorBrief,
  type WorkerEnvironmentBrief,
} from "../admission.js";
import {
  optionalService,
  type ResolvedEnvironment,
  type SandboxInferenceRoute,
  type VaultHeaderSource,
} from "../contracts.js";
import type { FoundryService } from "../../foundry/service.js";
import type { OpenAIEndpointService } from "../../openai/service.js";
import type { InferenceRoute, LiveSession } from "./types.js";
import { describeRoute } from "./support.js";
import { SessionManagerBase } from "./base.js";

export abstract class SessionInferenceRouting extends SessionManagerBase {
  // ------------------------------------------------------------------------------------------------------------
  // Azure AI Foundry (spec section 15): a session's model calls go to its environment's Foundry account, with the
  // platform's Azure identity, and never to its owner's Copilot plan. The route is fixed when the session is created.

  protected foundry(): FoundryService {
    const service = this.options.app.services.foundry;
    if (!service) throw new ManagedCopilotError("inference_unavailable", "This gateway has no Azure AI Foundry accounts configured (foundry in the AppHost)");
    return service;
  }

  protected openai(): OpenAIEndpointService {
    const service = this.options.app.services.openai;
    if (!service) throw new ManagedCopilotError("inference_unavailable", "This gateway has no OpenAI-compatible endpoints configured (openai in the AppHost)");
    return service;
  }

  /** The Foundry account and deployment a new session in a Foundry environment uses (its model, or the first one). */
  protected async foundryChoice(environment: ResolvedEnvironment, requested: unknown): Promise<InferenceRoute> {
    const account = environment.config.inference!.foundry!;
    const service = this.foundry();
    const allowed = service.deployments(account, environment.config.models);
    if (requested !== undefined && requested !== null && typeof requested !== "string") throw new ManagedCopilotError("invalid_request", "model must be a string");
    const deployment = (requested as string | undefined) ?? allowed[0];
    if (!deployment || !allowed.includes(deployment)) {
      throw new ManagedCopilotError(
        "policy_violation",
        `Model "${String(requested)}" is not one of environment "${environment.name}"'s Azure AI Foundry deployments (${allowed.join(", ")})`,
        { allowedModels: allowed },
      );
    }
    const route = await service.route(account);
    if (!route.deployments.has(deployment)) throw new ManagedCopilotError("inference_unavailable", `Azure AI Foundry account "${account}" has no deployment "${deployment}"`, { foundry: account });
    return { kind: "foundry", name: account, model: deployment };
  }

  /** The endpoint and model a new session in an OpenAI-compatible environment uses (its model, or the first one). */
  protected openaiChoice(environment: ResolvedEnvironment, requested: unknown): InferenceRoute {
    const endpoint = environment.config.inference!.openai!;
    const service = this.openai();
    const allowed = service.models(endpoint, environment.config.models);
    if (requested !== undefined && requested !== null && typeof requested !== "string") throw new ManagedCopilotError("invalid_request", "model must be a string");
    const model = (requested as string | undefined) ?? allowed[0];
    if (!model || !allowed.includes(model)) {
      throw new ManagedCopilotError("policy_violation", `Model "${String(requested)}" is not one of environment "${environment.name}"'s models on OpenAI-compatible endpoint "${endpoint}" (${allowed.join(", ")})`, {
        allowedModels: allowed,
      });
    }
    // Fails now (inference_unavailable) when the endpoint's key did not reach the gateway.
    service.provider(endpoint, model);
    return { kind: "openai", name: endpoint, model };
  }

  /** Where the session's model calls go, fixed at creation; undefined for a session billed to its owner's Copilot plan. */
  protected inferenceRoute(sessionId: string): InferenceRoute | undefined {
    const record = this.get(sessionId);
    const inference = record?.inference;
    if (inference?.route === "openai") return { kind: "openai", name: inference.openai, model: inference.model };
    if (inference?.route !== "foundry") return undefined;
    // Fixed at creation; `model` (from older records) only stands in for it.
    const deployment = inference.deployment ?? record!.model;
    if (!deployment) throw new ManagedCopilotError("state_restore_failed", `Session ${sessionId} has no recorded Foundry deployment`, { sessionId });
    return { kind: "foundry", name: inference.foundry, model: deployment };
  }

  /**
   * Create/resume params for where the session's model calls go. A session keeps the route it was created with: if its
   * environment now routes elsewhere, resuming it fails rather than switching its billing. A Foundry or
   * OpenAI-compatible session gets no GitHub credential fields, a fixed model, and (shared placement) the provider
   * whose token the gateway answers.
   */
  protected async routeInference(live: LiveSession, params: Record<string, unknown>, placement: Placement): Promise<Record<string, unknown>> {
    const route = this.inferenceRoute(live.id);
    const inference = live.environment.config.inference;
    const current: Pick<InferenceRoute, "kind" | "name"> | undefined = inference?.foundry
      ? { kind: "foundry", name: inference.foundry }
      : inference?.openai
        ? { kind: "openai", name: inference.openai }
        : undefined;
    if (route?.kind !== current?.kind || route?.name !== current?.name) {
      throw new ManagedCopilotError(
        "capability_unavailable",
        `Session ${live.id} sends model calls ${describeRoute(route)}, and environment "${live.environment.name}" now sends them ${describeRoute(current)}. A session keeps its billing route: start a new session.`,
        { sessionId: live.id },
      );
    }
    if (!route) return params;
    const { gitHubTokenProviderRegistrationId: _registration, gitHubToken: _token, provider: _provider, ...rest } = params;
    const routed: Record<string, unknown> = { ...rest, model: route.model, allowedModels: [route.model] };
    if (route.kind === "openai") {
      // Only shared environments route here (config validation); the endpoint's key is answered per model call.
      if (placement !== "shared") throw new ManagedCopilotError("capability_unavailable", `Session ${live.id} sends model calls to an OpenAI-compatible endpoint, which only shared environments support`, { sessionId: live.id });
      const service = this.openai();
      if (!service.models(route.name, undefined).includes(route.model)) {
        throw new ManagedCopilotError("inference_unavailable", `OpenAI-compatible endpoint "${route.name}" no longer declares model "${route.model}"`, { sessionId: live.id, openai: route.name });
      }
      routed["provider"] = { ...service.provider(route.name, route.model), ...(service.hasKey(route.name) ? { hasBearerTokenProvider: true } : {}) };
      return routed;
    }
    const service = this.foundry();
    const resolved = await service.route(route.name);
    if (!resolved.deployments.has(route.model)) {
      throw new ManagedCopilotError("inference_unavailable", `Azure AI Foundry account "${route.name}" no longer declares deployment "${route.model}"`, { sessionId: live.id, foundry: route.name });
    }
    // In a sandbox the broker adds the provider with its placeholder; the shared runtime asks the gateway for a token.
    if (placement === "shared") routed["provider"] = { ...service.provider(resolved, route.model), hasBearerTokenProvider: true };
    return routed;
  }

  /** What a sandbox runtime needs to send a Foundry session's model calls to its account through the broker. */
  protected async sandboxInference(sessionId: string): Promise<SandboxInferenceRoute | undefined> {
    const route = this.inferenceRoute(sessionId);
    if (!route) return undefined;
    if (route.kind === "openai") throw new ManagedCopilotError("capability_unavailable", `Session ${sessionId} sends model calls to an OpenAI-compatible endpoint, which only shared environments support`, { sessionId });
    const service = this.foundry();
    const resolved = await service.route(route.name);
    return { account: route.name, provider: service.provider(resolved, route.model), host: resolved.host, token: () => service.token(route.name) };
  }

  /** A Foundry or OpenAI-compatible session keeps its model for its whole life (its provider is fixed when the runtime opens it). */
  protected checkModelSwitch(live: LiveSession, model: unknown): void {
    const route = this.inferenceRoute(live.id);
    if (!route || model === route.model) return;
    const what = route.kind === "foundry" ? `Azure AI Foundry deployment "${route.model}"` : `model "${route.model}" of OpenAI-compatible endpoint "${route.name}"`;
    throw new ManagedCopilotError(
      "capability_unavailable",
      `Session ${live.id} sends model calls to ${what} and keeps it for its whole life. Start a new session to use another model.`,
      { sessionId: live.id },
    );
  }

  /**
   * Answers the shared runtime's `providerToken.getToken` for a Foundry session (an Entra ID token for its account from
   * the platform's own identity) or an OpenAI-compatible one (its endpoint's key). Never for a session the shared
   * runtime no longer hosts, and never a GitHub token.
   */
  async answerProviderTokenRequest(params: unknown): Promise<{ token: string }> {
    const request = (params ?? {}) as { sessionId?: unknown; providerName?: unknown };
    const live = typeof request.sessionId === "string" ? this.live.get(request.sessionId) : undefined;
    if (!live || live.placement !== "shared" || live.deleting) throw new ManagedCopilotError("forbidden", "No session on the shared runtime asked for this token");
    const route = this.inferenceRoute(live.id);
    if (!route) throw new ManagedCopilotError("forbidden", `Session ${live.id} has no Azure AI Foundry or OpenAI-compatible route; its model calls use its owner's Copilot plan`);
    if (request.providerName !== undefined && request.providerName !== "default") throw new ManagedCopilotError("forbidden", `Session ${live.id} has no model provider "${String(request.providerName)}"`);
    if (route.kind === "openai") {
      const token = this.openai().key(route.name);
      this.log.debug("Answered an OpenAI-compatible endpoint key request", { sessionId: live.id, endpoint: route.name });
      return { token };
    }
    const token = await this.foundry().token(route.name);
    this.log.debug("Answered a Foundry token request", { sessionId: live.id, account: route.name });
    return { token };
  }

  protected async admit(
    environment: ResolvedEnvironment,
    placement: Placement,
    raw: Record<string, unknown>,
    mode: "create" | "resume",
    network: NetworkPolicy,
    sessionId: string,
    tokenRegistrationId: string,
    principal: Principal,
  ): Promise<AdmittedSession> {
    const admitted = admitSession(
      raw,
      {
        environment,
        placement,
        network,
        platformTools: this.platformToolsFor(environment, placement),
        workingDirectory: this.workingDirectory(placement, sessionId),
        tokenRegistrationId,
        ...(environment.type === "orchestrator" ? { orchestrator: this.#orchestratorBrief(environment) } : {}),
      },
      mode,
    );
    if (placement === "sandbox") delete admitted.params["gitHubTokenProviderRegistrationId"];
    if (admitted.callerToken) {
      // Verified as the connection was: through its app, which may admit any GitHub account.
      const owner = await this.options.auth.authenticate(admitted.callerToken, principal.app ? { app: principal.app } : {});
      if (owner.accountId !== principal.accountId) {
        throw new ManagedCopilotError("forbidden", "The session's gitHubToken belongs to a different GitHub account; a managed client cannot switch owners");
      }
    }
    return admitted;
  }

  /** Shared sessions have no direct egress: remote MCP servers are rewritten to the gateway MCP adapter. */
  protected async checkRemoteMcp(admitted: AdmittedSession, sessionId: string, placement: Placement, _network: NetworkPolicy): Promise<void> {
    if (placement !== "shared" || admitted.remoteMcp.length === 0) return;
    const adapt = this.policy?.adaptMcpServer?.bind(this.policy);
    if (!adapt) {
      throw new ManagedCopilotError("capability_unavailable", "Remote MCP servers in shared environments need the gateway MCP adapter, which this deployment does not provide");
    }
    for (const server of admitted.remoteMcp) {
      // Copy on write: the caller's own objects (which `requested` snapshots) keep the original endpoints.
      if (server.agent) {
        const agents = admitted.params["customAgents"] as Record<string, unknown>[] | undefined;
        const index = agents?.findIndex((agent) => agent["name"] === server.agent) ?? -1;
        const agent = index >= 0 ? agents![index]! : undefined;
        const servers = agent?.["mcpServers"] as Record<string, Record<string, unknown>> | undefined;
        const entry = servers?.[server.name];
        if (!agents || !agent || !servers || !entry) continue;
        const copy = [...agents];
        copy[index] = { ...agent, mcpServers: { ...servers, [server.name]: await adapt(sessionId, server.name, entry) } };
        admitted.params["customAgents"] = copy;
      } else {
        const servers = admitted.params["mcpServers"] as Record<string, Record<string, unknown>> | undefined;
        const entry = servers?.[server.name];
        if (!servers || !entry) continue;
        admitted.params["mcpServers"] = { ...servers, [server.name]: await adapt(sessionId, server.name, entry) };
      }
    }
  }

  /**
   * Sandbox runtimes reach remote MCP servers through the egress proxy, which swaps a vault credential's placeholder
   * for the secret: each admitted server (custom agents' too) gets the placeholder header of a vault credential
   * granted for its URL, replacing a caller header of the same name. Applied whenever params go to a sandbox
   * runtime, so a revoked credential's header disappears; never stored.
   */
  protected async withVaultHeaders(sessionId: string, params: Record<string, unknown>, placement: Placement): Promise<Record<string, unknown>> {
    if (placement !== "sandbox") return params;
    const vaults = optionalService<VaultHeaderSource>(this.options.app.services, "vaults");
    const headersFor = vaults?.mcpHeaders?.bind(vaults);
    if (!headersFor) return params;
    const withHeaders = async (servers: unknown): Promise<unknown> => {
      if (!isRecord(servers)) return servers;
      let changed = false;
      const out: Record<string, unknown> = { ...servers };
      for (const [name, server] of Object.entries(servers)) {
        if (!isRecord(server) || !isRemoteMcp(server)) continue;
        const headers = await headersFor(sessionId, server["url"] as string, "sandbox");
        if (!headers || Object.keys(headers).length === 0) continue;
        const replaced = new Set(Object.keys(headers).map((header) => header.toLowerCase()));
        const own = isRecord(server["headers"]) ? Object.entries(server["headers"]).filter(([header]) => !replaced.has(header.toLowerCase())) : [];
        out[name] = { ...server, headers: { ...Object.fromEntries(own), ...headers } };
        changed = true;
      }
      return changed ? out : servers;
    };
    let result = params;
    const top = await withHeaders(params["mcpServers"]);
    if (top !== params["mcpServers"]) result = { ...result, mcpServers: top };
    const agents = params["customAgents"];
    if (Array.isArray(agents)) {
      const updated = await Promise.all(
        agents.map(async (agent: unknown) => {
          if (!isRecord(agent)) return agent;
          const servers = await withHeaders(agent["mcpServers"]);
          return servers === agent["mcpServers"] ? agent : { ...agent, mcpServers: servers };
        }),
      );
      if (updated.some((agent, index) => agent !== agents[index])) result = { ...result, customAgents: updated };
    }
    return result;
  }

  protected platformToolsFor(environment: ResolvedEnvironment, placement: Placement) {
    return this.options.platformTools.forSession({ environment: environment.name, type: environment.type, placement });
  }

  /** An orchestrator's worker environments as its coordinator's environment section lists them (declared order). */
  #orchestratorBrief(environment: ResolvedEnvironment): OrchestratorBrief {
    const workers: WorkerEnvironmentBrief[] = [];
    for (const name of environment.config.workers ?? []) {
      try {
        const worker = this.options.environments.resolve(name);
        workers.push({
          name,
          ...(worker.config.description ? { description: worker.config.description } : {}),
          size: worker.config.size ?? "small",
          network: worker.network,
          agents: (worker.customizations?.agents ?? []).map((agent) => ({ name: agent.name, ...(agent.description ? { description: agent.description } : {}) })),
        });
      } catch {
        // Left out (for example its customizations were rejected): a worker started there fails with the reason.
      }
    }
    const execution = environment.config.execution ?? "delegate";
    return {
      workers,
      maxWorkers: environment.config.maxWorkers ?? DEFAULT_MAX_WORKERS,
      execution,
      ...(execution !== "delegate" ? { subagents: environment.config.subagents ?? "shared" } : {}),
    };
  }

  protected workingDirectory(placement: Placement, sessionId: string): string {
    if (placement === "sandbox") return "/workspace";
    const root = this.options.sharedRuntime?.workspacesRoot ?? join(this.options.app.config.dataDir, "runtime", "shared", "workspaces");
    return join(root, sessionId);
  }
}
