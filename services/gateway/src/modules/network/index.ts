// Effective network policy, vaults (AppHost and per-user), the egress proxy's internal
// API and container, the shared-placement `web_fetch` platform tool, and the shared-placement MCP adapter.
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NETWORK_BLOCKED_EVENT, PLATFORM_EVENT_TYPES, sandboxedType, type EgressReport, type EgressStatus, type NetworkPolicy, type Placement, type PlatformEventType, type VaultInfo } from "@managed-copilot/protocol";
import type { GatewayModule } from "../../app.js";
import type { Database } from "../../db.js";
import { optionalService, type EventsService, type PlatformToolRegistry } from "../core/contracts.js";
import { EgressHub } from "./egress-api.js";
import { destinationOptions, egressSettings, GatewayEgress } from "./fetcher.js";
import { McpAdapter } from "./mcp-adapter.js";
import { PolicyService, type BlockedEvent, type SandboxEgress, type SandboxRegistrationInput, type SessionBindingInput, type SessionNetwork } from "./policy.js";
import { registerNetworkRoutes } from "./routes.js";
import { Sealer } from "./sealing.js";
import { getState, migrateNetwork, setState } from "./store.js";
import { EgressSupervisor } from "./supervisor.js";
import { VaultStore } from "./vaults.js";
import { WEB_FETCH_DESCRIPTION, WEB_FETCH_PARAMETERS, WEB_FETCH_TOOL, webFetch } from "./web-fetch.js";

/** The `policy` service other modules use (core admission, the sandbox provider, promotion). */
export interface NetworkPolicyApi {
  ceiling(environment: string | undefined): NetworkPolicy;
  effective(environment: string | undefined, requested: SessionBindingInput["requested"]): NetworkPolicy;
  bindSession(binding: SessionBindingInput): NetworkPolicy;
  session(sessionId: string): SessionNetwork | undefined;
  promoteSession(sessionId: string, targetEnvironment: string): NetworkPolicy;
  /** Pre-commit rollback: restores the binding from before the uncommitted promotion (undefined when none is pending). */
  revertPromotion(sessionId: string): NetworkPolicy | undefined;
  /** Makes the promoted binding final. */
  commitPromotion(sessionId: string): void;
  releaseSession(sessionId: string): void;
  adaptMcpServer(sessionId: string, name: string, server: Record<string, unknown>, options?: { readonly baseUrl?: string }): Promise<Record<string, unknown>>;
  registerSandbox(input: SandboxRegistrationInput): Promise<SandboxEgress>;
  updateSandbox(sandboxId: string, update: { readonly address?: string }): void;
  unregisterSandbox(sandboxId: string): void;
  blocked(sessionId: string, limit?: number): readonly EgressReport[];
  /** PEM of the platform egress CA ("" until the egress proxy has connected once). */
  caCertificate(): string;
  egressStatus(): { readonly mode: string; readonly connected: boolean; readonly instanceId?: string; readonly version?: string; readonly since?: string };
  /** Egress diagnostics for the operator console: the CA's fingerprint (never its key), registrations, recent blocks. */
  operatorEgress(): EgressStatus;
  /** Recent blocked attempts of every session, newest first (operator console). */
  operatorBlocks(limit?: number): readonly BlockedEvent[];
}

/** The `vaults` service: vaults created in code, and vault headers for remote MCP servers. */
export interface VaultsApi {
  list(ownerId: number): VaultInfo[];
  get(ownerId: number, vaultId: string): VaultInfo;
  create(ownerId: number, request: unknown): VaultInfo;
  delete(ownerId: number, vaultId: string): void;
  mcpHeaders(sessionId: string, url: string, placement: Placement): Record<string, string> | undefined;
}

declare module "../../app.js" {
  interface GatewayServices {
    policy: NetworkPolicyApi;
    vaults: VaultsApi;
  }
}

type EgressMode = "auto" | "docker" | "external" | "off";

/** SHA-256 fingerprint of a PEM certificate's DER bytes, as `AB:CD:…` (what certificate viewers show). */
export function certificateFingerprint(pem: string): string | undefined {
  const body = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(pem)?.[1]?.replace(/\s+/g, "");
  if (!body) return undefined;
  const digest = createHash("sha256").update(Buffer.from(body, "base64")).digest("hex").toUpperCase();
  return digest.match(/../g)!.join(":");
}

function sealedKey(db: Database, sealer: Sealer, name: string, override: string | undefined): string {
  if (override) return override;
  const stored = getState(db, name);
  if (stored) return sealer.unseal(stored, `network_state:${name}`);
  const key = randomBytes(32).toString("base64url");
  setState(db, name, sealer.seal(key, `network_state:${name}`));
  return key;
}

export const networkModule: GatewayModule = {
  name: "network",
  register(app) {
    const log = app.log.child("network");
    const env = app.config.env;
    migrateNetwork(app.db);
    const sealer = Sealer.load({
      ...(env.MANAGED_COPILOT_VAULT_KEY ? { envKey: env.MANAGED_COPILOT_VAULT_KEY } : {}),
      keyFile: join(app.config.dataDir, "network", "vault.key"),
      sealed: () => [
        ...(app.db.prepare("SELECT key, value FROM network_state WHERE key IN ('egress_key', 'mcp_adapter_key')").all() as { key: string; value: string }[]).map((row) => ({
          value: row.value,
          aad: `network_state:${row.key}`,
        })),
        ...(app.db.prepare("SELECT id, sealed FROM network_vaults").all() as { id: string; sealed: string }[]).map((row) => ({ value: row.sealed, aad: `network_vaults:${row.id}` })),
      ],
      ...(env.MANAGED_COPILOT_LEASE_STAMP ? { stamp: env.MANAGED_COPILOT_LEASE_STAMP } : {}),
      warn: (message, fields) => log.warn(message, fields),
    });
    const vaults = new VaultStore({ db: app.db, sealer, deployment: app.config.deployment, env, log: log.child("vaults") });
    const egressKey = sealedKey(app.db, sealer, "egress_key", env.MANAGED_COPILOT_EGRESS_KEY);
    const adapterKey = Buffer.from(sealedKey(app.db, sealer, "mcp_adapter_key", undefined), "base64url");
    const deployment = app.config.deployment;
    const needsSandboxes = Object.values(deployment.environments).some((environment) => sandboxedType(environment.type)) || (deployment.inline?.types ?? []).includes("isolated");
    const requested = (env.MANAGED_COPILOT_EGRESS ?? "auto").toLowerCase();
    const mode: EgressMode = requested === "docker" || requested === "external" || requested === "off" ? requested : "auto";

    let policy: PolicyService | undefined;
    const hub = new EgressHub({
      db: app.db,
      key: egressKey,
      deployment: app.config.deployment.name,
      log: log.child("egress"),
      snapshot: () => policy?.registrations() ?? [],
      resolveSecret: (request) => policy!.resolveSecret(request),
      record: (reports) => policy?.record(reports),
    });

    const events = optionalService<EventsService>(app.services, "events");
    const published = new Map<string, number>();
    const canPublish = (PLATFORM_EVENT_TYPES as readonly string[]).includes(NETWORK_BLOCKED_EVENT);
    policy = new PolicyService({
      db: app.db,
      deployment: app.config.deployment,
      vaults,
      egress: hub,
      log,
      alwaysWaitForEgress: mode !== "off",
      egressMode: mode,
      onBlocked: (session, report) => {
        if (!events || !canPublish) return;
        const key = `${session.sessionId}|${report.reason}|${report.host ?? ""}`;
        const now = Date.now();
        if (now - (published.get(key) ?? 0) < 10_000) return;
        published.set(key, now);
        if (published.size > 10_000) published.clear();
        events.emit(NETWORK_BLOCKED_EVENT as PlatformEventType, {
          ownerId: session.ownerId,
          sessionId: session.sessionId,
          ...(session.environment ? { environment: session.environment } : {}),
          data: { ...report },
        });
      },
    });
    const service = policy;
    // Core registers first, so its ledger exists to recover the sources of sessions promoted by earlier versions.
    service.convertLegacyPromotions();

    const settings = egressSettings(env);
    const egress = new GatewayEgress({ destination: destinationOptions(env) });
    const adapter = new McpAdapter({
      db: app.db,
      policy: service,
      egress,
      key: adapterKey,
      baseUrl: () => (env.MANAGED_COPILOT_MCP_ADAPTER_URL ?? `http://127.0.0.1:${app.config.port}`).replace(/\/+$/, ""),
      log: log.child("mcp"),
    });

    const supervisor =
      mode === "auto" || mode === "docker"
        ? new EgressSupervisor({
            instance: env.MANAGED_COPILOT_INSTANCE || "mc",
            context: env.MANAGED_COPILOT_EGRESS_CONTEXT ?? fileURLToPath(new URL("../../../../egress/", import.meta.url)),
            gatewayUrl: () => (env.MANAGED_COPILOT_EGRESS_GATEWAY_URL ?? `http://host.docker.internal:${app.config.port}`).replace(/\/+$/, ""),
            key: egressKey,
            settings,
            ...(env.MANAGED_COPILOT_EGRESS_UPSTREAM_CA_B64 ? { upstreamCa: env.MANAGED_COPILOT_EGRESS_UPSTREAM_CA_B64 } : {}),
            log: log.child("egress"),
          })
        : undefined;
    let supervising = false;
    if (supervisor) {
      hub.setStarter(() => {
        supervising = true;
        supervisor.start();
      });
    }

    hub.register(app);
    adapter.register(app);
    registerNetworkRoutes(app, { policy: service, vaults });

    const api: NetworkPolicyApi = {
      ceiling: (environment) => service.ceiling(environment),
      effective: (environment, requestedNetwork) => service.effective(environment, requestedNetwork),
      bindSession: (binding) => service.bindSession(binding),
      session: (sessionId) => service.session(sessionId),
      promoteSession: (sessionId, target) => service.promoteSession(sessionId, target),
      revertPromotion: (sessionId) => service.revertPromotion(sessionId),
      commitPromotion: (sessionId) => service.commitPromotion(sessionId),
      releaseSession: (sessionId) => service.releaseSession(sessionId),
      adaptMcpServer: (sessionId, name, server, options) => adapter.adapt(sessionId, name, server, options),
      registerSandbox: (input) => service.registerSandbox(input),
      updateSandbox: (sandboxId, update) => service.updateSandbox(sandboxId, update),
      unregisterSandbox: (sandboxId) => service.unregisterSandbox(sandboxId),
      blocked: (sessionId, limit) => service.blocked(sessionId, limit),
      caCertificate: () => hub.caCertificate() ?? "",
      egressStatus: () => ({ mode, ...hub.status }),
      operatorEgress: () => {
        const ca = hub.caCertificate();
        return {
          mode,
          ...hub.status,
          ...(ca ? { caFingerprint: certificateFingerprint(ca) } : {}),
          registrations: service.registrationCount(),
          blockedLastDay: service.blockedSince(new Date(Date.now() - 24 * 60 * 60_000).toISOString()),
        };
      },
      operatorBlocks: (limit) => service.recentBlocked(limit),
    };
    const vaultsApi: VaultsApi = {
      list: (ownerId) => vaults.list(ownerId),
      get: (ownerId, vaultId) => vaults.get(ownerId, vaultId),
      create: (ownerId, request) => vaults.create(ownerId, request),
      delete: (ownerId, vaultId) => vaults.delete(ownerId, vaultId),
      mcpHeaders: (sessionId, url, placement) => service.mcpHeaders(sessionId, url, placement),
    };
    app.provide("policy", api);
    app.provide("vaults", vaultsApi);
    app.capabilities.add("network.policy");

    const platformTools = optionalService<PlatformToolRegistry>(app.services, "platformTools");
    if (platformTools) {
      platformTools.register({
        name: WEB_FETCH_TOOL,
        description: WEB_FETCH_DESCRIPTION,
        parameters: WEB_FETCH_PARAMETERS as unknown as Record<string, unknown>,
        overridesBuiltInTool: true,
        appliesTo: ({ environment, placement }) => {
          if (placement !== "shared") return false;
          try {
            return service.ceiling(environment).access !== "disabled";
          } catch {
            return false;
          }
        },
        handler: (args, context) => webFetch((args ?? {}) as Record<string, unknown>, { sessionId: context.sessionId, ...(context.signal ? { signal: context.signal } : {}) }, { policy: service, egress }),
      });
      app.capabilities.add("web_fetch");
    } else {
      log.warn("The platform tool registry is unavailable; shared sessions get no web_fetch tool");
    }

    app.onStart(() => {
      if (supervisor && mode === "docker" && needsSandboxes) {
        supervising = true;
        supervisor.start();
      }
    });
    app.onStop(async () => {
      hub.close();
      if (supervisor && supervising) await supervisor.stop();
    });
  },
};
