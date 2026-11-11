// OpenAI-compatible endpoints as an inference route (spec section 15). The AppHost declares each endpoint's base URL,
// the models it serves, and optionally a key (an Aspire secret, delivered to the gateway as an environment variable).
// Only shared environments use them: the shared runtime calls `<url>/chat/completions` with the stock runtime's BYOK
// provider, and core answers its `providerToken.getToken` requests with the key, so the key never reaches the session's
// config, the client, or a sandbox.
import { ManagedCopilotError, type ManagedCopilotConfig, type OpenAIEndpoint } from "@managed-copilot/protocol";

export interface OpenAIEndpointStatus {
  readonly name: string;
  readonly url: string;
  readonly models: readonly string[];
  /** Whether model calls carry a key. */
  readonly key: boolean;
  readonly problem?: string;
  /** Environments that send model calls to this endpoint. */
  readonly environments: readonly string[];
}

export interface OpenAIEndpointServiceOptions {
  readonly deployment: ManagedCopilotConfig;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export class OpenAIEndpointService {
  readonly #options: OpenAIEndpointServiceOptions;
  readonly #endpoints: ReadonlyMap<string, OpenAIEndpoint>;

  constructor(options: OpenAIEndpointServiceOptions) {
    this.#options = options;
    this.#endpoints = new Map(Object.entries(options.deployment.openai ?? {}));
  }

  get size(): number {
    return this.#endpoints.size;
  }

  has(endpoint: string): boolean {
    return this.#endpoints.has(endpoint);
  }

  /** Whether model calls to the endpoint carry a key (the runtime then asks core for it per call). */
  hasKey(endpoint: string): boolean {
    return this.#endpoints.get(endpoint)?.key !== undefined;
  }

  /** The endpoint's key; `inference_unavailable` when it is declared but its secret did not reach the gateway. */
  key(endpoint: string): string {
    const declared = this.#endpoint(endpoint);
    if (!declared.key) throw new ManagedCopilotError("inference_unavailable", `OpenAI-compatible endpoint "${endpoint}" declares no key`, { openai: endpoint });
    const value = this.#options.env[declared.key.secretEnv];
    if (!value) {
      throw new ManagedCopilotError("inference_unavailable", `The key of OpenAI-compatible endpoint "${endpoint}" did not reach the gateway (${declared.key.secretEnv} is not set)`, {
        openai: endpoint,
      });
    }
    return value;
  }

  /**
   * The stock runtime's whole-session BYOK provider for one of the endpoint's models: chat completions at its URL, with
   * the model as the wire model. No credential: core adds `hasBearerTokenProvider` when the endpoint has a key.
   */
  provider(endpoint: string, model: string): Record<string, unknown> {
    const declared = this.#endpoint(endpoint);
    if (this.hasKey(endpoint)) this.key(endpoint);
    return { type: "openai", baseUrl: declared.url.replace(/\/+$/, ""), wireApi: "completions", wireModel: model };
  }

  /** The models an environment may use: its own `models`, or every model the endpoint declares. */
  models(endpoint: string, allowed: readonly string[] | undefined): readonly string[] {
    return allowed ?? this.#endpoints.get(endpoint)?.models ?? [];
  }

  /** `models.list` for an environment routed to the endpoint, in the SDK's model shape. */
  modelList(endpoint: string, allowed: readonly string[] | undefined): Record<string, unknown>[] {
    return this.models(endpoint, allowed).map((model) => ({
      id: model,
      name: `${model} (${endpoint}, OpenAI-compatible endpoint)`,
      capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 128_000 } },
      policy: { state: "enabled", terms: "" },
    }));
  }

  status(): OpenAIEndpointStatus[] {
    const environments = Object.entries(this.#options.deployment.environments);
    return [...this.#endpoints.entries()].map(([name, declared]) => {
      const missingKey = declared.key && !this.#options.env[declared.key.secretEnv];
      return {
        name,
        url: declared.url,
        models: declared.models,
        key: declared.key !== undefined,
        ...(missingKey ? { problem: `Its key did not reach the gateway (${declared.key!.secretEnv} is not set)` } : {}),
        environments: environments.filter(([, environment]) => environment.inference?.openai === name).map(([environment]) => environment),
      };
    });
  }

  #endpoint(endpoint: string): OpenAIEndpoint {
    const declared = this.#endpoints.get(endpoint);
    if (!declared) throw new ManagedCopilotError("inference_unavailable", `OpenAI-compatible endpoint "${endpoint}" is not declared in the AppHost's openai`, { openai: endpoint });
    return declared;
  }
}
