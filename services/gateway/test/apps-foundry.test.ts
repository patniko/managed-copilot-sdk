// Apps that vouch for their own users (spec section 2) and the Azure AI Foundry inference route (section 15), through
// the real gateway with a fake runtime, a GitHub stub, and a Foundry service whose Azure calls are scripted.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_KEY_HEADER, APP_USER_HEADER, APP_USER_NAME_HEADER, type AccountInfo, type DeploymentInfo, type SessionInfo } from "@managed-copilot/protocol";
import { createLogger } from "../src/log.js";
import { FoundryService } from "../src/modules/foundry/service.js";
import { FakeRuntime, RawClient, startGitHubStub, startTestGateway, type TestGateway } from "./harness.js";

const ALICE = "gho_alice_token"; // in `access`
const BOB = "gho_bob_token"; // not in `access`
const FRONT_DESK_KEY = "fd_".padEnd(48, "k");
const KIOSK_KEY = "ks_".padEnd(48, "q");
const ACCOUNT = "contoso-foundry";
const SUBSCRIPTION = "00000000-1111-2222-3333-444444444444";
const ENTRA_TOKEN = "entra-token-for-tests";

const DEPLOYMENT = {
  name: "copilot",
  access: { githubUsers: ["alice"] },
  foundry: { [ACCOUNT]: { resourceGroup: "ai", subscription: SUBSCRIPTION, deployments: ["gpt-5-mini", "grok-4.7"] } },
  environments: {
    chat: { type: "shared", models: ["claude-haiku-4.5"] },
    support: { type: "shared", inference: { foundry: ACCOUNT } },
    narrow: { type: "shared", inference: { foundry: ACCOUNT }, models: ["grok-4.7"] },
    open: { type: "shared" },
  },
  inline: { types: ["shared"] },
  apps: {
    "front-desk": { environments: ["support", "narrow", "chat"], anyGitHubUser: true, key: { secretEnv: "TEST_FRONT_DESK_KEY" } },
    kiosk: { environments: ["support"], key: { secretEnv: "TEST_KIOSK_KEY" } },
  },
};

/** Azure Resource Manager as a script: the account, then its deployments. */
function armFetch(): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/deployments?")) {
      return Response.json({
        value: [
          { name: "gpt-5-mini", properties: { model: { name: "gpt-5-mini" }, provisioningState: "Succeeded" } },
          { name: "grok-4.7", properties: { model: { name: "grok-4.7" }, provisioningState: "Succeeded" } },
        ],
      });
    }
    return Response.json({ kind: "AIServices", properties: { endpoints: { "OpenAI Language Model Instance API": "https://contoso-foundry.openai.azure.com/" }, customSubDomainName: ACCOUNT } });
  };
  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

const tokens = () => ({ token: async (resource: string) => (resource.startsWith("https://management") ? "arm-token" : ENTRA_TOKEN) });

describe("apps and Azure AI Foundry through the gateway", () => {
  let runtime: FakeRuntime;
  let github: Awaited<ReturnType<typeof startGitHubStub>>;
  let gateway: TestGateway;
  const clients: RawClient[] = [];

  const call = async (path: string, options: { token?: string; headers?: Record<string, string>; method?: string; body?: unknown } = {}) => {
    const response = await fetch(new URL(path, gateway.url), {
      method: options.method ?? "GET",
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, json: (text ? JSON.parse(text) : undefined) as Record<string, unknown> & { error?: { code: string; message: string } } };
  };
  const appUser = (key: string, id: string, name?: string) => ({
    [APP_KEY_HEADER]: key,
    [APP_USER_HEADER]: encodeURIComponent(id),
    ...(name ? { [APP_USER_NAME_HEADER]: encodeURIComponent(name) } : {}),
  });
  const connect = async (environment: string, token: string, headers: Record<string, string> = {}) => {
    const client = await RawClient.connect(gateway.url, token, environment, headers);
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    runtime = new FakeRuntime();
    await runtime.start();
    github = await startGitHubStub({ [ALICE]: { id: 1001, login: "alice" }, [BOB]: { id: 2002, login: "bob" } });
    gateway = await startTestGateway({
      runtime,
      githubUrl: github.url,
      deployment: DEPLOYMENT,
      // No Azure identity here: the gateway's own lookup fails fast, and the test service below takes over.
      env: { TEST_FRONT_DESK_KEY: FRONT_DESK_KEY, TEST_KIOSK_KEY: KIOSK_KEY, MANAGED_COPILOT_AZURE_CREDENTIAL: "managed-identity" },
    });
    const arm = armFetch();
    const services = gateway.gateway.app.services as Record<string, unknown>;
    services["foundry"] = new FoundryService({ deployment: gateway.gateway.app.config.deployment, mode: "local", env: {}, log: createLogger("test", "error"), fetch: arm.fetch, tokens });
  });

  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await gateway?.close();
    await runtime?.close();
    await github?.close();
  });

  describe("app keys", () => {
    it("lets an app read only what it may use, and nothing that needs a person", async () => {
      const info = await call("/v1/info", { headers: { [APP_KEY_HEADER]: FRONT_DESK_KEY } });
      expect(info.status).toBe(200);
      const deployment = info.json as unknown as DeploymentInfo;
      expect(deployment.environments.map((environment) => environment.name).sort()).toEqual(["chat", "narrow", "support"]);
      expect(deployment.inline).toBeUndefined();
      expect(deployment.capabilities).toEqual(expect.arrayContaining(["apps", "foundry"]));
      expect(deployment.environments.find((environment) => environment.name === "support")).toMatchObject({ inference: { foundry: ACCOUNT }, models: ["gpt-5-mini", "grok-4.7"] });
      expect((await call("/v1/me", { headers: { [APP_KEY_HEADER]: FRONT_DESK_KEY } })).json).toEqual({ id: 0, login: "front-desk", kind: "app", app: "front-desk" });

      const sessions = await call("/v1/sessions", { headers: { [APP_KEY_HEADER]: FRONT_DESK_KEY } });
      expect(sessions.status).toBe(401);
      expect(sessions.json.error?.message).toMatch(/needs a person to act for/);
      await expect(connect("support", "", { [APP_KEY_HEADER]: FRONT_DESK_KEY })).rejects.toThrow(/401/);
    });

    it("refuses unknown keys, app users without a key, and malformed app users", async () => {
      expect((await call("/v1/me", { headers: { [APP_KEY_HEADER]: "x".repeat(48) } })).json.error).toMatchObject({ code: "authentication_required" });
      expect((await call("/v1/me", { headers: { [APP_USER_HEADER]: "alice" } })).json.error).toMatchObject({ code: "authentication_required" });
      expect((await call("/v1/me", { headers: appUser(FRONT_DESK_KEY, "bad\u0007id") })).json.error).toMatchObject({ code: "invalid_request" });
      expect((await call("/v1/me", { headers: appUser(FRONT_DESK_KEY, "x".repeat(300)) })).json.error).toMatchObject({ code: "invalid_request" });
      expect((await call("/v1/me", { headers: { [APP_KEY_HEADER]: FRONT_DESK_KEY, [APP_USER_HEADER]: "%E0%A4%A" } })).json.error).toMatchObject({ code: "invalid_request" });
      expect((await call("/v1/me", { token: ALICE, headers: appUser(FRONT_DESK_KEY, "alice") })).json.error).toMatchObject({ code: "invalid_request" });
    });

    it("gives each app's users their own accounts, never GitHub ones", async () => {
      const first = (await call("/v1/me", { headers: appUser(FRONT_DESK_KEY, "user-1", "User One") })).json as unknown as AccountInfo;
      expect(first).toMatchObject({ login: "front-desk/user-1", name: "User One", kind: "app-user", app: "front-desk", userId: "user-1" });
      expect(first.id).toBeLessThan(0);
      expect((await call("/v1/me", { headers: appUser(FRONT_DESK_KEY, "user-1") })).json["id"]).toBe(first.id);
      const kiosk = (await call("/v1/me", { headers: appUser(KIOSK_KEY, "user-1") })).json as unknown as AccountInfo;
      expect(kiosk).toMatchObject({ login: "kiosk/user-1", app: "kiosk" });
      expect(kiosk.id).not.toBe(first.id);
      // A slash makes no GitHub login: an app user named like an operator is still not one.
      expect((await call("/v1/operator/overview", { headers: appUser(FRONT_DESK_KEY, "alice") })).status).toBe(401);
    });

    it("admits a GitHub user outside access only through an app that admits any GitHub user", async () => {
      expect((await call("/v1/me", { token: BOB })).json.error).toMatchObject({ code: "forbidden" });
      expect((await call("/v1/me", { token: BOB, headers: { [APP_KEY_HEADER]: FRONT_DESK_KEY } })).json).toMatchObject({ id: 2002, login: "bob" });
      expect((await call("/v1/me", { token: BOB, headers: { [APP_KEY_HEADER]: KIOSK_KEY } })).json.error).toMatchObject({ code: "forbidden" });
      // Still not directly, after the app admitted it.
      expect((await call("/v1/me", { token: BOB })).json.error).toMatchObject({ code: "forbidden" });
      expect((await call("/v1/me", { token: ALICE, headers: { [APP_KEY_HEADER]: KIOSK_KEY } })).json).toMatchObject({ login: "alice" });
    });

    it("keeps every request through an app inside the app's environments", async () => {
      await expect(connect("open", BOB, { [APP_KEY_HEADER]: FRONT_DESK_KEY })).rejects.toThrow(/environment_not_found/);
      await expect(connect("open", "", appUser(FRONT_DESK_KEY, "user-1"))).rejects.toThrow(/environment_not_found/);
      await expect(connect("chat", "", appUser(KIOSK_KEY, "user-1"))).rejects.toThrow(/environment_not_found/);
    });

    it("never bills an app user to a Copilot plan, and refuses what needs a GitHub sign-in", async () => {
      await expect(connect("chat", "", appUser(FRONT_DESK_KEY, "user-1"))).rejects.toThrow(/inference_unavailable/);
      const background = await call("/v1/credentials/background", { method: "POST", body: {}, headers: appUser(FRONT_DESK_KEY, "user-1") });
      expect(background.json.error).toMatchObject({ code: "capability_unavailable" });
      const throughApp = await call("/v1/credentials/background", { method: "POST", body: {}, token: ALICE, headers: { [APP_KEY_HEADER]: FRONT_DESK_KEY } });
      expect(throughApp.json.error).toMatchObject({ code: "capability_unavailable" });
      const schedule = await call("/v1/schedules", { method: "POST", headers: appUser(FRONT_DESK_KEY, "user-1"), body: { name: "daily", cron: "0 9 * * *", environment: "support", prompt: "hi" } });
      expect(schedule.json.error).toMatchObject({ code: "capability_unavailable" });
    });
  });

  describe("Foundry sessions", () => {
    it("sends a shared session's model calls to Foundry, with no GitHub credential", async () => {
      const client = await connect("support", "", appUser(FRONT_DESK_KEY, "carol", "Carol"));
      const sessionId = randomUUID();
      await client.request("session.create", { sessionId });
      const create = runtime.calls("session.create").find((request) => request.params["sessionId"] === sessionId)!;
      expect(create.params["provider"]).toEqual({
        type: "openai",
        baseUrl: "https://contoso-foundry.openai.azure.com/openai/v1",
        wireApi: "completions",
        wireModel: "gpt-5-mini",
        modelId: "gpt-5-mini",
        hasBearerTokenProvider: true,
      });
      expect(create.params["model"]).toBe("gpt-5-mini");
      expect(create.params["allowedModels"]).toEqual(["gpt-5-mini"]);
      expect(create.params["gitHubTokenProviderRegistrationId"]).toBeUndefined();
      expect(create.params["gitHubToken"]).toBeUndefined();

      // The runtime asks the gateway for each call's token: the platform's own Entra token, for this session only.
      expect(await runtime.requestOn(1, "providerToken.getToken", { sessionId, providerName: "default" })).toEqual({ token: ENTRA_TOKEN });
      await expect(runtime.requestOn(1, "providerToken.getToken", { sessionId: randomUUID(), providerName: "default" })).rejects.toThrow();
      // And never a GitHub token.
      const github = (await runtime.requestOn(1, "gitHubToken.getToken", { sessionId, registrationId: "anything" })) as { kind?: string };
      expect(github.kind).toBe("cancelled");

      const info = (await call(`/v1/sessions/${sessionId}`, { headers: appUser(FRONT_DESK_KEY, "carol") })).json as unknown as SessionInfo;
      expect(info).toMatchObject({ inference: { route: "foundry", foundry: ACCOUNT }, model: "gpt-5-mini", owner: { kind: "app-user", app: "front-desk", userId: "carol", name: "Carol" } });
      expect((await call(`/v1/sessions/${sessionId}`, { headers: appUser(FRONT_DESK_KEY, "dave") })).status).toBe(404);
      expect((await call(`/v1/sessions/${sessionId}`, { headers: appUser(KIOSK_KEY, "carol") })).status).toBe(404);
      expect(((await call("/v1/sessions", { headers: appUser(FRONT_DESK_KEY, "carol") })).json as unknown as SessionInfo[]).map((session) => session.id)).toContain(sessionId);

      const models = (await client.request("models.list", {})) as { models: { id: string }[] };
      expect(models.models.map((model) => model.id)).toEqual(["gpt-5-mini", "grok-4.7"]);
      await expect(client.request("session.model.switchTo", { sessionId, modelId: "grok-4.7" })).rejects.toThrow(/keeps it for its whole life/);
      await expect(client.request("session.model.switchAutoTier", { sessionId, autoTier: "intelligence" })).rejects.toThrow(/Auto model routing/);
    });

    it("lets a GitHub user use a Foundry environment, and keeps their Copilot sessions on their plan", async () => {
      const foundry = await connect("narrow", ALICE);
      const foundrySession = randomUUID();
      await foundry.request("session.create", { sessionId: foundrySession });
      const create = runtime.calls("session.create").find((request) => request.params["sessionId"] === foundrySession)!;
      expect(create.params).toMatchObject({ model: "grok-4.7", provider: { wireModel: "grok-4.7", hasBearerTokenProvider: true } });
      await expect(foundry.request("session.create", { sessionId: randomUUID(), model: "gpt-5-mini" })).rejects.toThrow(/not one of environment "narrow"'s Azure AI Foundry deployments/);

      const copilot = await connect("chat", ALICE);
      const copilotSession = randomUUID();
      await copilot.request("session.create", { sessionId: copilotSession });
      const plain = runtime.calls("session.create").find((request) => request.params["sessionId"] === copilotSession)!;
      expect(plain.params["provider"]).toBeUndefined();
      expect(plain.params["gitHubTokenProviderRegistrationId"]).toEqual(expect.any(String));
      expect((await call(`/v1/sessions/${copilotSession}`, { token: ALICE })).json["inference"]).toEqual({ route: "copilot" });
      await expect(runtime.requestOn(1, "providerToken.getToken", { sessionId: copilotSession, providerName: "default" })).rejects.toThrow(/Copilot plan/);
    });
  });

  describe("FoundryService", () => {
    const service = (fetchImpl: typeof fetch, deployments = ["gpt-5-mini"]) =>
      new FoundryService({
        deployment: { name: "copilot", environments: {}, foundry: { [ACCOUNT]: { resourceGroup: "ai", subscription: SUBSCRIPTION, deployments } } } as never,
        mode: "local",
        env: {},
        log: createLogger("test", "error"),
        fetch: fetchImpl,
        tokens,
      });

    it("finds the account's OpenAI-compatible endpoint and checks its deployments", async () => {
      const arm = armFetch();
      const route = await service(arm.fetch).route(ACCOUNT);
      expect(route).toMatchObject({ baseUrl: "https://contoso-foundry.openai.azure.com/openai/v1", host: "contoso-foundry.openai.azure.com", subscription: SUBSCRIPTION });
      expect(arm.calls[0]).toBe(`https://management.azure.com/subscriptions/${SUBSCRIPTION}/resourceGroups/ai/providers/Microsoft.CognitiveServices/accounts/${ACCOUNT}?api-version=2024-10-01`);
      await expect(service(arm.fetch, ["gpt-5-mini", "o9"]).route(ACCOUNT)).rejects.toThrow(/no ready deployment o9\. Its deployments: gpt-5-mini, grok-4\.7/);
    });

    it("explains a missing account and missing access, and retries passing Azure failures", async () => {
      const status = (code: number) => (async () => new Response("{}", { status: code })) as unknown as typeof fetch;
      await expect(service(status(404)).route(ACCOUNT)).rejects.toThrow(/was not found in resource group "ai"/);
      await expect(service(status(403)).route(ACCOUNT)).rejects.toThrow(/Cognitive Services OpenAI User/);
      const arm = armFetch();
      let failures = 2;
      const flaky = (async (input: string) => {
        if (failures-- > 0) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
        return arm.fetch(input);
      }) as unknown as typeof fetch;
      expect((await service(flaky).route(ACCOUNT)).host).toBe("contoso-foundry.openai.azure.com");
      expect(await service(arm.fetch).token(ACCOUNT)).toBe(ENTRA_TOKEN);
    });
  });
});
