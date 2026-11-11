// Microsoft-Decision-1 on Microsoft Foundry: its decision API takes a `state` and typed questions and returns typed
// answers with probabilities. Help Desk calls it as the signed-in Azure CLI's identity (Microsoft Entra ID); no API key.
// Only the triage endpoint (triage-endpoint.ts) calls it, for the platform's sessions in the triage environment.
import { execFile } from "node:child_process";

export const COGNITIVE_SERVICES = "https://cognitiveservices.azure.com";

export type DecisionQuestion =
  | { readonly type: "choice"; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: "noul"; readonly instructions: string; readonly criteria?: { readonly true: string; readonly false: string } };

export interface DecisionRequest {
  readonly state: string;
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
}

export interface DecisionResponse {
  /** Keyed by question name: `{type: "choice", choice, confidence, probabilities}` or `{type: "noul", noul}` (a probability). */
  readonly answers: Readonly<Record<string, unknown>>;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
}

/** Asks the decision model. Implemented by `DecisionClient`; faked in tests. */
export interface Decider {
  decide(request: DecisionRequest): Promise<DecisionResponse>;
}

/** Why the decision API couldn't answer, with the HTTP status Help Desk's endpoint returns for it. */
export class DecisionError extends Error {
  override readonly name = "DecisionError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface TokenSource {
  token(resource: string): Promise<string>;
}

const REFRESH_BEFORE_MS = 5 * 60_000;

/** `az account get-access-token`: the signed-in Azure CLI's identity. Tokens are cached and never logged. */
export class AzureCliTokenSource implements TokenSource {
  readonly #subscription: string | undefined;
  readonly #cache = new Map<string, { value: string; expiresAt: number }>();
  readonly #inflight = new Map<string, Promise<{ value: string; expiresAt: number }>>();

  /** `subscription`: get tokens from that subscription's tenant, which may not be the Azure CLI's default. */
  constructor(subscription?: string) {
    this.#subscription = subscription && /^[0-9a-fA-F-]{36}$/.test(subscription) ? subscription : undefined;
  }

  async token(resource: string): Promise<string> {
    const cached = this.#cache.get(resource);
    if (cached && cached.expiresAt - REFRESH_BEFORE_MS > Date.now()) return cached.value;
    let pending = this.#inflight.get(resource);
    if (!pending) {
      pending = this.#fetch(resource).finally(() => this.#inflight.delete(resource));
      this.#inflight.set(resource, pending);
    }
    const fresh = await pending;
    this.#cache.set(resource, fresh);
    return fresh.value;
  }

  #fetch(resource: string): Promise<{ value: string; expiresAt: number }> {
    const az = process.platform === "win32" ? "az.cmd" : "az";
    const args = ["account", "get-access-token", "--resource", resource, ...(this.#subscription ? ["--subscription", this.#subscription] : []), "--output", "json"];
    return new Promise((resolve, reject) => {
      execFile(az, args, { windowsHide: true, timeout: 60_000, shell: process.platform === "win32" }, (error, stdout) => {
        if (error) {
          reject(new DecisionError(`The Azure CLI couldn't get a token for Microsoft Foundry. Run \`az login\`, then try again. (${error.message.split("\n")[0]})`, 503));
          return;
        }
        try {
          const body = JSON.parse(stdout) as { accessToken: string; expires_on?: number; expiresOn?: string };
          const expiresAt = body.expires_on ? body.expires_on * 1000 : Date.parse(body.expiresOn ?? "") || Date.now() + 30 * 60_000;
          resolve({ value: body.accessToken, expiresAt });
        } catch {
          reject(new DecisionError("The Azure CLI returned an unexpected token response.", 503));
        }
      });
    });
  }
}

/** Calls `<endpoint>/providers/microsoft/v1/systemone` with the deployment's name as the model. */
export class DecisionClient implements Decider {
  readonly #endpoint: string;
  readonly #deployment: string;
  readonly #tokens: TokenSource;
  readonly #fetch: typeof fetch;

  constructor(options: { endpoint: string; deployment: string; tokens: TokenSource; fetch?: typeof fetch }) {
    this.#endpoint = options.endpoint.replace(/\/+$/, "");
    this.#deployment = options.deployment;
    this.#tokens = options.tokens;
    this.#fetch = options.fetch ?? fetch;
  }

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    const token = await this.#tokens.token(COGNITIVE_SERVICES);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#endpoint}/providers/microsoft/v1/systemone`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ model: this.#deployment, state: request.state, questions: request.questions }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new DecisionError(`Microsoft Foundry isn't reachable at ${this.#endpoint}: ${(error as Error).message}`, 502);
    }
    const text = await response.text();
    if (!response.ok) throw new DecisionError(failure(response.status, this.#deployment, upstreamMessage(text)), response.status === 429 ? 429 : response.status === 401 || response.status === 403 ? 403 : 502);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new DecisionError("The decision API returned a response that isn't JSON.", 502);
    }
    const answers = (body as { answers?: unknown })?.answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new DecisionError("The decision API returned no answers.", 502);
    const usage = (body as { usage?: DecisionResponse["usage"] }).usage;
    return { answers: answers as Record<string, unknown>, ...(usage && typeof usage === "object" ? { usage } : {}) };
  }
}

function upstreamMessage(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown; code?: unknown } | string; message?: unknown };
    const error = body.error;
    const message = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : typeof body.message === "string" ? body.message : undefined;
    return message?.slice(0, 300);
  } catch {
    return undefined;
  }
}

function failure(status: number, deployment: string, detail: string | undefined): string {
  const suffix = detail ? ` (${detail})` : "";
  if (status === 401 || status === 403) {
    return `Microsoft Foundry refused Help Desk's Azure identity${suffix}. Give it the Cognitive Services User role on the Foundry resource (demos/help-desk/README.md).`;
  }
  if (status === 404) return `Microsoft Foundry has no "${deployment}" deployment at this endpoint${suffix}.`;
  if (status === 429) return `The "${deployment}" deployment is over its rate limit${suffix}.`;
  return `The decision API failed with HTTP ${status}${suffix}.`;
}
