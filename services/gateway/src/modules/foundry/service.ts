// Azure AI Foundry as an inference route (spec section 15). The AppHost names existing Foundry (AIServices) accounts
// and their model deployments; this service finds each account through Azure Resource Manager, checks the deployments,
// and hands out Entra ID tokens for model calls with the platform's own Azure identity: the signed-in Azure CLI with
// `aspire run`, the gateway's managed identity with `aspire deploy`. Tokens never reach an execution sandbox: core gives
// the shared runtime one per model call (`providerToken.getToken`), and the sandbox broker swaps them for a placeholder.
import { execFile } from "node:child_process";
import { ManagedCopilotError, type FoundryAccount, type ManagedCopilotConfig } from "@managed-copilot/protocol";
import type { Logger } from "../../log.js";
import { AzureCliTokenSource, ManagedIdentityTokenSource, TokenUnavailableError, type TokenSource } from "../sandbox/providers/azure/credential.js";

/** Entra ID resource for model calls to Foundry and Azure OpenAI. */
export const COGNITIVE_SERVICES_RESOURCE = "https://cognitiveservices.azure.com";
const ARM_RESOURCE = "https://management.azure.com/";
const ARM_URL = "https://management.azure.com";
const ARM_API_VERSION = "2024-10-01";
/** A resolved account is looked up again after this long (its deployments may change). */
const RESOLVED_TTL_MS = 10 * 60_000;
/** A lookup that found the account unusable as declared is tried again no sooner than this. */
const RETRY_AFTER_MS = 30_000;
/** Waits between attempts of one Azure Resource Manager read. */
const ARM_RETRY_DELAYS_MS: readonly number[] = [500, 1500, 4000];

/** A Foundry account the platform can call: where its OpenAI-compatible API is, and what its deployments serve. */
export interface FoundryRoute {
  readonly account: string;
  readonly subscription: string;
  readonly resourceGroup: string;
  /** The account's OpenAI-compatible v1 API, e.g. `https://contoso.openai.azure.com/openai/v1`. */
  readonly baseUrl: string;
  /** Host of `baseUrl`: the only host a sandbox's brokered model calls may reach. */
  readonly host: string;
  /** Declared deployments → the model each one serves (when Azure says). */
  readonly deployments: ReadonlyMap<string, { readonly model?: string }>;
}

export interface FoundryAccountStatus {
  readonly name: string;
  readonly resourceGroup: string;
  readonly subscription?: string;
  readonly deployments: readonly { readonly name: string; readonly model?: string }[];
  readonly endpoint?: string;
  readonly state: "checking" | "ready" | "unavailable";
  readonly problem?: string;
  readonly checkedAt?: string;
  /** Environments that send model calls to this account. */
  readonly environments: readonly string[];
  /** How the platform authenticates: `cli` (az login) or `managed-identity`. */
  readonly credential: "cli" | "managed-identity";
}

interface AccountState {
  readonly name: string;
  readonly declared: FoundryAccount;
  route?: FoundryRoute;
  problem?: string;
  /** The last problem says the account cannot work as declared (not a passing hiccup). */
  definitive?: boolean;
  checkedAt?: number;
  pending?: Promise<FoundryRoute>;
  subscription?: string;
}

export interface FoundryServiceOptions {
  readonly deployment: ManagedCopilotConfig;
  readonly mode: "local" | "azure";
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: Logger;
  /** Tests: token sources and fetch. */
  readonly tokens?: (subscription: string | undefined) => TokenSource;
  readonly fetch?: typeof fetch;
  readonly defaultSubscription?: () => Promise<string | undefined>;
}

/** The Azure CLI's current subscription (`az account show`), for accounts that name none locally. */
function cliSubscription(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(process.platform === "win32" ? "az.cmd" : "az", ["account", "show", "--query", "id", "--output", "tsv"], { windowsHide: true, timeout: 30_000, shell: process.platform === "win32" }, (error, stdout) => {
      const id = stdout?.trim();
      resolve(!error && /^[0-9a-fA-F-]{36}$/.test(id) ? id : undefined);
    });
  });
}

/** Whether an error says the account cannot work as declared (not a passing Azure hiccup). */
function definitive(error: unknown): boolean {
  return error instanceof ManagedCopilotError && error.details?.["definitive"] === true;
}

export class FoundryService {
  readonly #options: FoundryServiceOptions;
  readonly #accounts = new Map<string, AccountState>();
  readonly #tokens = new Map<string, TokenSource>();
  readonly #fetch: typeof fetch;
  readonly credential: "cli" | "managed-identity";

  constructor(options: FoundryServiceOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
    const configured = options.env.MANAGED_COPILOT_AZURE_CREDENTIAL?.trim();
    this.credential = configured === "cli" || configured === "managed-identity" ? configured : options.mode === "azure" ? "managed-identity" : "cli";
    for (const [name, declared] of Object.entries(options.deployment.foundry ?? {})) this.#accounts.set(name, { name, declared });
  }

  get size(): number {
    return this.#accounts.size;
  }

  /** Looks every account up now (gateway start), reporting problems in the log without failing the start. */
  async refresh(): Promise<void> {
    await Promise.all(
      [...this.#accounts.values()].map((state) =>
        this.#resolve(state).then(
          (route) => this.#options.log.info("Foundry account ready", { account: route.account, host: route.host, deployments: [...route.deployments.keys()] }),
          (error: unknown) => this.#options.log.warn("Foundry account unavailable", { account: state.name, problem: (error as Error).message }),
        ),
      ),
    );
  }

  /** The account's route; `inference_unavailable` (with the reason and how to fix it) when it cannot be used. */
  async route(account: string): Promise<FoundryRoute> {
    const state = this.#accounts.get(account);
    if (!state) throw new ManagedCopilotError("inference_unavailable", `Azure AI Foundry account "${account}" is not declared in the AppHost's foundry`, { foundry: account });
    const now = Date.now();
    if (state.route && !state.problem && state.checkedAt !== undefined && now - state.checkedAt < RESOLVED_TTL_MS) return state.route;
    // A problem that says the account cannot work as declared is reported again for a while; a passing one is retried.
    if (state.problem && state.definitive && state.checkedAt !== undefined && now - state.checkedAt < RETRY_AFTER_MS) {
      throw new ManagedCopilotError("inference_unavailable", state.problem, { foundry: account });
    }
    try {
      return await this.#resolve(state);
    } catch (error) {
      if (state.route && !definitive(error)) return state.route;
      throw error;
    }
  }

  /** An Entra ID token for the account's model calls, from the platform's own identity. Cached until near expiry. */
  async token(account: string): Promise<string> {
    const route = await this.route(account);
    try {
      return await this.#tokenSource(route.subscription).token(COGNITIVE_SERVICES_RESOURCE);
    } catch (error) {
      throw new ManagedCopilotError("inference_unavailable", `The platform's Azure identity could not get a token for Azure AI Foundry account "${account}": ${(error as Error).message}`, { foundry: account });
    }
  }

  /**
   * The stock runtime's whole-session BYOK provider for a deployment: the account's OpenAI-compatible v1 API, chat
   * completions, and the deployment as the wire model. No credential: core adds `hasBearerTokenProvider` for the shared
   * runtime, and the sandbox broker adds its placeholder.
   */
  provider(route: FoundryRoute, deployment: string): Record<string, unknown> {
    const model = route.deployments.get(deployment)?.model;
    return { type: "openai", baseUrl: route.baseUrl, wireApi: "completions", wireModel: deployment, ...(model ? { modelId: model } : {}) };
  }

  /** The deployments an environment may use: its own `models`, or every deployment declared for the account. */
  deployments(account: string, allowed: readonly string[] | undefined): readonly string[] {
    return allowed ?? this.#accounts.get(account)?.declared.deployments ?? [];
  }

  /** `models.list` for a Foundry environment: its deployments, in the SDK's model shape. */
  models(account: string, allowed: readonly string[] | undefined): Record<string, unknown>[] {
    const route = this.#accounts.get(account)?.route;
    return this.deployments(account, allowed).map((deployment) => {
      const model = route?.deployments.get(deployment)?.model;
      return {
        id: deployment,
        name: model && model !== deployment ? `${deployment} (${model}, Azure AI Foundry)` : `${deployment} (Azure AI Foundry)`,
        capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 128_000 } },
        policy: { state: "enabled", terms: "" },
      };
    });
  }

  status(): FoundryAccountStatus[] {
    const environments = Object.entries(this.#options.deployment.environments);
    return [...this.#accounts.values()].map((state) => {
      const subscription = state.route?.subscription ?? state.declared.subscription ?? state.subscription;
      return {
        name: state.name,
        resourceGroup: state.declared.resourceGroup,
        ...(subscription ? { subscription } : {}),
        deployments: state.declared.deployments.map((name) => {
          const model = state.route?.deployments.get(name)?.model;
          return { name, ...(model ? { model } : {}) };
        }),
        ...(state.route ? { endpoint: state.route.baseUrl } : {}),
        state: state.problem ? "unavailable" : state.route ? "ready" : "checking",
        ...(state.problem ? { problem: state.problem } : {}),
        ...(state.checkedAt !== undefined ? { checkedAt: new Date(state.checkedAt).toISOString() } : {}),
        environments: environments.filter(([, environment]) => environment.inference?.foundry === state.name).map(([name]) => name),
        credential: this.credential,
      };
    });
  }

  #tokenSource(subscription: string | undefined): TokenSource {
    const key = this.credential === "cli" ? (subscription ?? "") : "managed-identity";
    let source = this.#tokens.get(key);
    if (!source) {
      if (this.#options.tokens) source = this.#options.tokens(subscription);
      else if (this.credential === "cli") source = new AzureCliTokenSource(subscription ? { subscription } : {});
      else {
        const endpoint = this.#options.env.IDENTITY_ENDPOINT;
        const header = this.#options.env.IDENTITY_HEADER;
        if (!endpoint || !header) throw new TokenUnavailableError("No managed identity is available to the gateway (IDENTITY_ENDPOINT/IDENTITY_HEADER are not set); assign one to its container app.");
        const clientId = this.#options.env.MANAGED_COPILOT_AZURE_CLIENT_ID?.trim();
        source = new ManagedIdentityTokenSource({ endpoint, header, ...(clientId ? { clientId } : {}) });
      }
      this.#tokens.set(key, source);
    }
    return source;
  }

  async #subscriptionOf(state: AccountState): Promise<string> {
    const subscription =
      state.declared.subscription ||
      this.#options.env.MANAGED_COPILOT_FOUNDRY_SUBSCRIPTION?.trim() ||
      (await (this.#options.defaultSubscription ?? (this.credential === "cli" ? cliSubscription : async () => undefined))());
    if (!subscription) {
      throw new ManagedCopilotError(
        "inference_unavailable",
        `Azure AI Foundry account "${state.name}" names no subscription and none is configured: set subscription on it in the AppHost's foundry, or Azure:SubscriptionId.`,
        { foundry: state.name, definitive: true },
      );
    }
    state.subscription = subscription;
    return subscription;
  }

  #resolve(state: AccountState): Promise<FoundryRoute> {
    if (state.pending) return state.pending;
    const pending = this.#lookup(state).then(
      (route) => {
        state.route = route;
        state.problem = undefined;
        state.definitive = false;
        state.checkedAt = Date.now();
        return route;
      },
      (error: unknown) => {
        state.problem = (error as Error).message;
        state.definitive = definitive(error);
        state.checkedAt = Date.now();
        throw error instanceof ManagedCopilotError ? error : new ManagedCopilotError("inference_unavailable", state.problem, { foundry: state.name });
      },
    );
    state.pending = pending.finally(() => {
      state.pending = undefined;
    });
    return state.pending;
  }

  async #arm(state: AccountState, subscription: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
    let token: string;
    try {
      token = await this.#tokenSource(subscription).token(ARM_RESOURCE);
    } catch (error) {
      throw new ManagedCopilotError(
        "inference_unavailable",
        `The platform's Azure identity could not sign in to look up Azure AI Foundry account "${state.name}": ${(error as Error).message}`,
        { foundry: state.name },
      );
    }
    const url = `${ARM_URL}/subscriptions/${encodeURIComponent(subscription)}/resourceGroups/${encodeURIComponent(state.declared.resourceGroup)}/providers/Microsoft.CognitiveServices/accounts/${encodeURIComponent(state.name)}${path}?api-version=${ARM_API_VERSION}`;
    // Reads are idempotent: transport errors, throttling, and 5xx answers are tried again a few times.
    for (let attempt = 0; ; attempt++) {
      let problem: string;
      try {
        const response = await this.#fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
        if (response.status !== 429 && response.status < 500) {
          const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
          return { status: response.status, body };
        }
        await response.body?.cancel().catch(() => undefined);
        problem = `HTTP ${response.status}`;
      } catch (error) {
        const cause = (error as { cause?: { code?: unknown } }).cause;
        problem = `${(error as Error).message}${typeof cause?.code === "string" ? ` (${cause.code})` : ""}`;
      }
      const delay = ARM_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        throw new ManagedCopilotError("inference_unavailable", `Azure Resource Manager did not answer for Azure AI Foundry account "${state.name}": ${problem}`, { foundry: state.name });
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  async #lookup(state: AccountState): Promise<FoundryRoute> {
    const subscription = await this.#subscriptionOf(state);
    const where = `resource group "${state.declared.resourceGroup}" of subscription ${subscription}`;
    const identity = this.credential === "cli" ? "Your Azure CLI sign-in (az login)" : "The gateway's managed identity";
    const account = await this.#arm(state, subscription, "");
    if (account.status === 404) {
      throw new ManagedCopilotError("inference_unavailable", `Azure AI Foundry account "${state.name}" was not found in ${where}.`, { foundry: state.name, definitive: true });
    }
    if (account.status === 401 || account.status === 403) {
      throw new ManagedCopilotError(
        "inference_unavailable",
        `${identity} cannot read Azure AI Foundry account "${state.name}" in ${where}. Give it the Cognitive Services OpenAI User role on the account.`,
        { foundry: state.name, definitive: true },
      );
    }
    if (account.status !== 200) throw new ManagedCopilotError("inference_unavailable", `Azure Resource Manager returned HTTP ${account.status} for Azure AI Foundry account "${state.name}".`, { foundry: state.name });
    const kind = String(account.body["kind"] ?? "");
    if (kind !== "AIServices" && kind !== "OpenAI") {
      throw new ManagedCopilotError("inference_unavailable", `"${state.name}" is a ${kind || "Cognitive Services"} account, not an Azure AI Foundry (AIServices) account.`, { foundry: state.name, definitive: true });
    }
    const properties = (account.body["properties"] ?? {}) as { endpoints?: Record<string, unknown>; customSubDomainName?: unknown };
    const declaredEndpoint = properties.endpoints?.["OpenAI Language Model Instance API"];
    const endpoint =
      typeof declaredEndpoint === "string" ? declaredEndpoint : typeof properties.customSubDomainName === "string" && properties.customSubDomainName ? `https://${properties.customSubDomainName}.openai.azure.com/` : undefined;
    if (!endpoint) {
      throw new ManagedCopilotError("inference_unavailable", `Azure AI Foundry account "${state.name}" has no custom subdomain, which Entra ID sign-in needs.`, { foundry: state.name, definitive: true });
    }
    const base = new URL(endpoint);
    if (base.protocol !== "https:") throw new ManagedCopilotError("inference_unavailable", `Azure AI Foundry account "${state.name}" has a non-HTTPS endpoint.`, { foundry: state.name, definitive: true });
    const listed = await this.#arm(state, subscription, "/deployments");
    if (listed.status !== 200) {
      throw new ManagedCopilotError("inference_unavailable", `Azure Resource Manager returned HTTP ${listed.status} listing the deployments of Azure AI Foundry account "${state.name}".`, { foundry: state.name });
    }
    const found = new Map<string, { model?: string; state?: string }>();
    for (const entry of (listed.body["value"] as unknown[] | undefined) ?? []) {
      const item = entry as { name?: unknown; properties?: { model?: { name?: unknown }; provisioningState?: unknown } };
      if (typeof item.name !== "string") continue;
      const model = item.properties?.model?.name;
      const provisioning = item.properties?.provisioningState;
      found.set(item.name, { ...(typeof model === "string" ? { model } : {}), ...(typeof provisioning === "string" ? { state: provisioning } : {}) });
    }
    const deployments = new Map<string, { model?: string }>();
    const missing: string[] = [];
    for (const name of state.declared.deployments) {
      const deployment = found.get(name);
      if (!deployment || (deployment.state !== undefined && deployment.state !== "Succeeded")) missing.push(deployment ? `${name} (${deployment.state})` : name);
      else deployments.set(name, deployment.model ? { model: deployment.model } : {});
    }
    if (missing.length > 0) {
      const available = [...found.keys()];
      throw new ManagedCopilotError(
        "inference_unavailable",
        `Azure AI Foundry account "${state.name}" has no ready deployment ${missing.join(", ")}.${available.length > 0 ? ` Its deployments: ${available.join(", ")}.` : " It has no deployments."}`,
        { foundry: state.name, definitive: true },
      );
    }
    const root = base.toString().endsWith("/") ? base.toString() : `${base.toString()}/`;
    const baseUrl = new URL("openai/v1", root).toString();
    return { account: state.name, subscription, resourceGroup: state.declared.resourceGroup, baseUrl, host: new URL(baseUrl).hostname.toLowerCase(), deployments };
  }
}
