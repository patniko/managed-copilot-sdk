import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "../src/server/http.js";
import { createLogger } from "../src/server/log.js";
import { Sealer } from "../src/server/seal.js";
import { Store } from "../src/server/store.js";
import { GoogleAuth, GoogleAuthError, REQUESTED_SCOPES } from "../src/server/tools/google/oauth.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function setupAuth(fetchImpl: typeof fetch) {
  const store = new Store(":memory:");
  store.upsertUser({ id: 1, login: "octo" });
  const sealer = Sealer.fromSecret("a-long-enough-test-secret-value");
  const auth = new GoogleAuth({
    client: { clientId: "client-123", clientSecret: "secret-456" },
    redirectUri: "http://localhost:7490/api/google/callback",
    store,
    sealer,
    log: createLogger("test"),
    fetch: fetchImpl,
  });
  return { store, sealer, auth };
}

describe("Google OAuth", () => {
  it("starts an offline, PKCE-protected consent flow with minimal scopes", () => {
    const { auth } = setupAuth(fetch);
    const url = new URL(auth.beginAuthorization(1));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:7490/api/google/callback");
    expect(url.searchParams.get("scope")!.split(" ")).toEqual([...REQUESTED_SCOPES]);
    expect(REQUESTED_SCOPES).not.toContain("https://mail.google.com/");
  });

  it("exchanges the code, seals the tokens, and makes the state single-use", async () => {
    const calls: { url: string; body?: string }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
      if (url.includes("/token")) {
        return jsonResponse(200, { access_token: "ya29.access", refresh_token: "1//refresh", expires_in: 3599, scope: REQUESTED_SCOPES.join(" ") });
      }
      if (url.includes("/profile")) return jsonResponse(200, { emailAddress: "octo@gmail.example" });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const { auth, store, sealer } = setupAuth(fetchImpl);
    const state = new URL(auth.beginAuthorization(1)).searchParams.get("state")!;
    const result = await auth.completeAuthorization(new URLSearchParams({ state, code: "auth-code" }));
    expect(result).toEqual({ accountId: 1, email: "octo@gmail.example", missingScopes: [] });

    const tokenBody = new URLSearchParams(calls[0]!.body);
    expect(tokenBody.get("grant_type")).toBe("authorization_code");
    expect(tokenBody.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{64}$/);

    const record = store.getGoogle(1)!;
    expect(record.refreshToken).not.toContain("1//refresh");
    expect(sealer.open(record.refreshToken, "google:1:refresh")).toBe("1//refresh");
    expect(await auth.accessToken(1)).toBe("ya29.access");

    await expect(auth.completeAuthorization(new URLSearchParams({ state, code: "auth-code" }))).rejects.toMatchObject({ code: "expired" });
  });

  it("refreshes expired access and flags revoked grants for reconnect", async () => {
    let refreshes = 0;
    let revoked = false;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/token")) {
        refreshes++;
        if (revoked) return jsonResponse(400, { error: "invalid_grant" });
        return jsonResponse(200, { access_token: `ya29.fresh${refreshes}`, expires_in: 3599 });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const { auth, store, sealer } = setupAuth(fetchImpl);
    store.saveGoogle({
      accountId: 1,
      scopes: [...REQUESTED_SCOPES],
      refreshToken: sealer.seal("1//refresh", "google:1:refresh"),
      accessToken: sealer.seal("ya29.old", "google:1:access"),
      accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
      status: "ok",
      connectedAt: new Date().toISOString(),
    });
    const [a, b] = await Promise.all([auth.accessToken(1), auth.accessToken(1)]);
    expect(a).toBe("ya29.fresh1");
    expect(b).toBe("ya29.fresh1");
    expect(refreshes).toBe(1);

    revoked = true;
    await expect(auth.accessToken(1, { forceRefresh: true })).rejects.toBeInstanceOf(GoogleAuthError);
    expect(store.getGoogle(1)!.status).toBe("needs_reconnect");
    await expect(auth.accessToken(1)).rejects.toMatchObject({ code: "needs_reconnect" });
  });

  it("reports a missing configuration explicitly", () => {
    const store = new Store(":memory:");
    const auth = new GoogleAuth({ client: undefined, redirectUri: "x", store, sealer: Sealer.fromSecret("a-long-enough-test-secret-value"), log: createLogger("test") });
    expect(auth.configured).toBe(false);
    expect(() => auth.beginAuthorization(1)).toThrow(/isn't configured/);
  });
});

describe("Router", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  async function start() {
    const router = new Router({ port: 7490, publicUrl: "http://localhost:7490", extraOrigins: [] });
    router.add("POST", "/api/messages", async (ctx) => ({ got: await ctx.json<{ text: string }>() }));
    router.add("POST", "/api/copilot-events", () => ({ ok: true }), { sameOrigin: false });
    server = createServer((req, res) => void router.handle(req, res).then((handled) => (handled ? undefined : res.writeHead(404).end())));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    return (server.address() as AddressInfo).port;
  }

  function post(port: number, path: string, headers: Record<string, string>, body = "{}"): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", ...headers } }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      });
      req.on("error", reject);
      req.end(body);
    });
  }

  it("accepts same-origin JSON and rejects cross-origin, rebinding, and form posts", async () => {
    const port = await start();
    expect((await post(port, "/api/messages", { host: "localhost:7490", origin: "http://localhost:7490" }, '{"text":"hi"}')).body).toBe('{"got":{"text":"hi"}}');
    expect((await post(port, "/api/messages", { host: "localhost:7490", origin: "https://evil.example" })).status).toBe(403);
    expect((await post(port, "/api/messages", { host: "evil.example:7490" })).status).toBe(421);
    expect((await post(port, "/api/messages", { host: "localhost:7490", "content-type": "text/plain" })).status).toBe(415);
    // Signed webhooks come from the platform, not a browser, so they skip the origin check.
    expect((await post(port, "/api/copilot-events", { host: "localhost:7490", origin: "https://gateway.example" })).status).toBe(200);
  });
});
