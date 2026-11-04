import { describe, expect, it } from "vitest";
import { AcrCredentials, REGISTRY_AUDIENCE, REGISTRY_TOKEN_USER, RegistryCredentialsError, registryHost } from "../src/modules/sandbox/providers/azure/registry.js";

const jwt = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.y`;

function fakeRegistry(options: { status?: number; refreshToken?: string } = {}) {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body) });
    const status = options.status ?? 200;
    return new Response(JSON.stringify(status === 200 ? { refresh_token: options.refreshToken ?? jwt(Math.floor(Date.now() / 1000) + 3 * 3600) } : { errors: [{ message: "unauthorized: no AcrPull" }] }), { status });
  }) as typeof fetch;
  const audiences: string[] = [];
  const tokens = { token: async (resource: string) => (audiences.push(resource), "entra-token") };
  return { calls, audiences, credentials: new AcrCredentials(tokens, { fetch: fetchImpl }) };
}

describe("AcrCredentials", () => {
  it("exchanges the gateway identity's token for a registry token, once per registry while it is fresh", async () => {
    const { calls, audiences, credentials } = fakeRegistry({ refreshToken: jwt(Math.floor(Date.now() / 1000) + 3 * 3600) });
    const first = await credentials.credentialsFor("myacr.azurecr.io/copilot-sandbox:abc");
    expect(first?.username).toBe(REGISTRY_TOKEN_USER);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://myacr.azurecr.io/oauth2/exchange");
    expect(new URLSearchParams(calls[0]!.body).get("service")).toBe("myacr.azurecr.io");
    expect(new URLSearchParams(calls[0]!.body).get("access_token")).toBe("entra-token");
    expect(audiences).toEqual([REGISTRY_AUDIENCE]);
    await credentials.credentialsFor("myacr.azurecr.io/copilot-sandbox-coder:def");
    expect(calls).toHaveLength(1);
  });

  it("renews a registry token that is about to expire", async () => {
    const { calls, credentials } = fakeRegistry({ refreshToken: jwt(Math.floor(Date.now() / 1000) + 60) });
    await credentials.credentialsFor("myacr.azurecr.io/a:1");
    await credentials.credentialsFor("myacr.azurecr.io/a:1");
    expect(calls).toHaveLength(2);
  });

  it("needs no credentials for images outside Azure Container Registry", async () => {
    const { calls, credentials } = fakeRegistry();
    expect(await credentials.credentialsFor("ghcr.io/patniko/managed-copilot-sandbox:0.1.0")).toBeUndefined();
    expect(await credentials.credentialsFor("ubuntu:24.04")).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("says which role is missing when the registry refuses the identity", async () => {
    const { credentials } = fakeRegistry({ status: 401 });
    const error = await credentials.credentialsFor("myacr.azurecr.io/a:1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RegistryCredentialsError);
    expect((error as Error).message).toMatch(/cannot pull from myacr\.azurecr\.io \(unauthorized: no AcrPull\)\. Assign it the AcrPull role/);
  });

  it("reads registry hosts from image references", () => {
    expect(registryHost("myacr.azurecr.io/x:1")).toBe("myacr.azurecr.io");
    expect(registryHost("localhost:5000/x")).toBe("localhost:5000");
    expect(registryHost("library/ubuntu")).toBeUndefined();
  });
});
