// Session creation.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { ManagedCopilotError, type NetworkPolicy, type Placement } from "@managed-copilot/protocol";
import type { Principal } from "../../../http.js";
import { assertAppUserInference } from "../apps.js";
import { accountInfo } from "../auth.js";
import type { ResolvedEnvironment } from "../contracts.js";
import type { AdmittedConfig } from "../ledger.js";
import { RuntimeUpstream } from "../runtime.js";
import type { ClientPeer, LiveSession } from "./types.js";
import {
  WIRE_FLAGS,
  sessionInference,
  applyInventory,
  registrationOf,
  storedParams,
  requestedParams,
} from "./support.js";
import { SessionCutover } from "./cutover.js";

export abstract class SessionCreation extends SessionCutover {
  // ------------------------------------------------------------------------------------------------------------
  // Creation

  protected async reserveAndCreate(input: {
    principal: Principal;
    environment: ResolvedEnvironment;
    raw: Record<string, unknown>;
    peer: ClientPeer | undefined;
    scheduleId?: string | undefined;
    webhook?: string | undefined;
    clientName?: string | undefined;
    parent?: { readonly id: string; readonly incarnation: string } | undefined;
  }): Promise<unknown> {
    const sessionId = input.raw["sessionId"] as string;
    // Reserve the ID synchronously so concurrent creates of the same ID cannot both proceed.
    if (this.creating.has(sessionId) || this.ledger.get(sessionId)) throw new ManagedCopilotError("conflict", `Session ${sessionId} already exists`);
    const done = this.#createReserved(input, sessionId);
    this.creating.set(sessionId, { ownerId: input.principal.accountId, done });
    try {
      return await done;
    } finally {
      this.creating.delete(sessionId);
    }
  }

  async #createReserved(
    input: {
      principal: Principal;
      environment: ResolvedEnvironment;
      raw: Record<string, unknown>;
      peer: ClientPeer | undefined;
      scheduleId?: string | undefined;
      webhook?: string | undefined;
      clientName?: string | undefined;
      parent?: { readonly id: string; readonly incarnation: string } | undefined;
    },
    sessionId: string,
  ): Promise<unknown> {
    const { principal, environment } = input;
    const placement: Placement = environment.type === "isolated" ? "sandbox" : "shared";
    if (placement === "shared" && !this.options.sharedRuntime) {
      throw new ManagedCopilotError("capability_unavailable", "Shared environments are disabled on this gateway (no shared runtime)");
    }
    if (placement === "sandbox" && !this.sandboxes) {
      throw new ManagedCopilotError("capability_unavailable", `Environment "${environment.name}" needs isolated sandboxes, which this deployment does not provide yet`);
    }
    // An app's own users have no Copilot plan: only Foundry or OpenAI-compatible environments, refused before anything exists.
    assertAppUserInference(principal, environment.name, environment.config);
    // An explicitly selected billing route never falls back to the owner's Copilot plan: the session gets no GitHub
    // credential, and its model is fixed for its life.
    const routed = environment.config.inference?.foundry
      ? await this.foundryChoice(environment, input.raw["model"])
      : environment.config.inference?.openai
        ? this.openaiChoice(environment, input.raw["model"])
        : undefined;
    const raw = routed ? { ...input.raw, model: routed.model } : input.raw;
    const tokenRegistrationId = `mc-${randomUUID()}`;
    // Taken before admission, which rewrites nested values (remote MCP servers point at the gateway adapter).
    const requested = requestedParams(raw);
    const admitted = await this.admit(environment, placement, raw, "create", environment.network, sessionId, tokenRegistrationId, principal);
    if (routed) admitted.params["allowedModels"] = [routed.model];

    // Bind network policy (validates vaults) before anything is allocated.
    let network: NetworkPolicy = environment.network;
    const policy = this.policy;
    if (policy) {
      const bound = await policy.bindSession({
        sessionId,
        owner: principal.accountId,
        environment: environment.inline ? undefined : environment.name,
        type: environment.type,
        requested: environment.request.network,
        vaults: environment.request.vaults,
      });
      if (bound) network = bound;
    }
    let live: LiveSession | undefined;
    try {
      await this.checkRemoteMcp(admitted, sessionId, placement, network);
      const registration = registrationOf(admitted.params, this.options.platformTools, environment.name);
      const stored: AdmittedConfig = {
        params: storedParams(admitted.params),
        // Without a client, the declarations are the service's own; a client's are its callback registrations.
        ...(input.peer ? {} : { tools: registration.tools }),
        callbacks: applyInventory(undefined, { tools: input.peer ? registration.tools : [], flags: registration.flags, removeTools: [], removeFlags: [] }),
        optionsPatch: admitted.optionsPatch,
        requested,
      };
      const record = this.ledger.insert({
        id: sessionId,
        owner: accountInfo(principal),
        environment: environment.name,
        type: environment.type,
        placement,
        network,
        environmentRequest: environment.request,
        admitted: stored,
        ...(routed ? { model: routed.model, inference: sessionInference(routed) } : admitted.model ? { model: admitted.model } : {}),
        ...(admitted.agent ? { agent: admitted.agent } : {}),
        ...(input.clientName ? { clientName: input.clientName } : {}),
        ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
        ...(input.webhook ? { webhook: input.webhook } : {}),
        ...(input.parent ? { parentSessionId: input.parent.id, parentIncarnation: input.parent.incarnation } : {}),
      });
      if (routed?.kind === "foundry") this.log.info("Session model calls go to Azure AI Foundry", { sessionId, account: routed.name, deployment: routed.model, owner: principal.login });
      if (routed?.kind === "openai") this.log.info("Session model calls go to an OpenAI-compatible endpoint", { sessionId, endpoint: routed.name, model: routed.model, owner: principal.login });
      const created = this.register(record, environment, tokenRegistrationId);
      live = created;
      // The creating principal's verified credential serves the session while it is created (without a client, the
      // runtime asks for one during `session.create`). A session another one starts (an orchestrator's worker) is
      // served by its parent's connected clients instead, checked at every request, so a credential borrowed from a
      // connection never outlives it.
      const presence = Symbol(sessionId);
      if (!input.peer && !input.parent) created.presences.set(presence, principal);
      let result: unknown;
      await this.serialize(created, async () => {
        let upstream: RuntimeUpstream;
        if (placement === "sandbox") {
          await this.sandboxes!.create({
            sessionId,
            ownerId: principal.accountId,
            environment: environment.name,
            size: environment.config.size ?? "small",
            network,
            ...(environment.request.vaults ? { vaults: environment.request.vaults } : {}),
            additions: {
              ...(environment.request.files ? { files: environment.request.files } : {}),
              ...(environment.request.packages ? { packages: environment.request.packages } : {}),
              ...(environment.request.env ? { env: environment.request.env } : {}),
            },
            resolved: environment,
          });
          upstream = await this.openSandbox(created);
        } else {
          mkdirSync(this.workingDirectory("shared", sessionId), { recursive: true });
          upstream = await this.options.sharedRuntime!.ready();
          created.upstream = upstream;
        }
        const forwarded = await this.prepare(created, "session.create", await this.withVaultHeaders(sessionId, admitted.params, placement));
        // A creating client that disconnected meanwhile is not attached; what it registered stays in the inventory.
        if (input.peer && !input.peer.closed) {
          this.attach(created, input.peer, admitted, forwarded);
          // The creating client may later withdraw what it registered at create (and only that).
          const attachment = created.attachments.get(input.peer.id)!;
          const revisions = stored.callbacks?.revisions;
          for (const tool of attachment.declarations) {
            const revision = revisions?.tools[String(tool["name"])];
            if (revision !== undefined) attachment.registered.tools[String(tool["name"])] = revision;
          }
          for (const key of WIRE_FLAGS) {
            const revision = revisions?.flags[key];
            if (attachment.flags[key] === true && revision !== undefined) attachment.registered.flags[key] = revision;
          }
        }
        const opened = upstream;
        result = await this.bounded(created, opened, "session.create", () => opened.request("session.create", forwarded));
        await this.opened(created, upstream, admitted.optionsPatch);
        created.ready = true;
        return upstream;
      });
      created.presences.delete(presence);
      this.ledger.update(sessionId, { state: "ready" });
      this.options.events.emit("session.created", { ownerId: principal.accountId, sessionId, environment: environment.name, data: { placement, type: environment.type, incarnation: record.incarnation } });
      this.log.info("Session created", { sessionId, owner: principal.login, environment: environment.name, placement });
      return this.scrub(created, this.sanitizeResponse(created, result));
    } catch (error) {
      if (live) {
        this.live.delete(sessionId);
        for (const attachment of live.attachments.values()) this.actions?.onDetached(attachment.peer.id, sessionId);
        live.attachments.clear();
      }
      this.ledger.remove(sessionId);
      if (placement === "sandbox" && live) {
        live.upstream?.close();
        live.sandbox?.close?.();
        await this.sandboxes?.delete(sessionId).catch((cleanup: unknown) => this.log.warn("Sandbox cleanup after failed create failed", { sessionId, error: (cleanup as Error).message }));
      }
      await Promise.resolve(this.policy?.releaseSession?.(sessionId)).catch(() => undefined);
      this.log.warn("Session creation failed", { sessionId, environment: environment.name, error: (error as Error).message });
      throw error;
    }
  }
}
