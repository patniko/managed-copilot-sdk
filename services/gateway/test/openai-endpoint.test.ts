// The OpenAI-compatible endpoint inference route (spec section 15), through the real gateway with a fake runtime and a
// GitHub stub: the AppHost declares the endpoint and its key; sessions in a shared environment routed to it get the
// stock runtime's BYOK provider, and the gateway answers the runtime's per-call token requests with the key.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_KEY_HEADER, APP_USER_HEADER, ManagedCopilotConfigSchema, type DeploymentInfo, type SessionInfo } from "@managed-copilot/protocol";
import { OpenAIEndpointService } from "../src/modules/openai/service.js";
import { FakeRuntime, RawClient, startGitHubStub, startTestGateway, type TestGateway } from "./harness.js";

const ALICE = "gho_alice_token";
const DESK_KEY = "hd_".padEnd(48, "k");
const ENDPOINT_KEY = "triage-endpoint-key-for-tests";

const DEPLOYMENT = {
  name: "copilot",
  access: { githubUsers: ["alice"] },
  openai: {
    triage: { url: "http://help-desk.test/api/triage/v1/", models: ["ms-decision-1", "other-model"], key: { secretEnv: "TEST_TRIAGE_KEY" } },
    keyless: { url: "http://model-server.test/v1", models: ["local-model"] },
  },
  environments: {
    triage: { type: "shared", inference: { openai: "triage" }, models: ["ms-decision-1"] },
    open: { type: "shared", inference: { openai: "keyless" } },
    chat: { type: "shared" },
  },
  apps: { desk: { environments: ["triage", "chat"], key: { secretEnv: "TEST_DESK_KEY" } } },
};

describe("OpenAI-compatible endpoints through the gateway", () => {
  let runtime: FakeRuntime;
  let github: Awaited<ReturnType<typeof startGitHubStub>>;
  let gateway: TestGateway;
  const clients: RawClient[] = [];
  const appUser = (id: string) => ({ [APP_KEY_HEADER]: DESK_KEY, [APP_USER_HEADER]: id });
  const connect = async (environment: string, token: string, headers: Record<string, string> = {}) => {
    const client = await RawClient.connect(gateway.url, token, environment, headers);
    clients.push(client);
    return client;
  };
  const created = (sessionId: string) => runtime.calls("session.create").find((request) => request.params["sessionId"] === sessionId)!;

  beforeAll(async () => {
    runtime = new FakeRuntime();
    await runtime.start();
    github = await startGitHubStub({ [ALICE]: { id: 1001, login: "alice" } });
    gateway = await startTestGateway({ runtime, githubUrl: github.url, deployment: DEPLOYMENT, env: { TEST_DESK_KEY: DESK_KEY, TEST_TRIAGE_KEY: ENDPOINT_KEY } });
  });

  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await gateway?.close();
    await runtime?.close();
    await github?.close();
  });

  it("offers the route in the deployment's info", async () => {
    const response = await fetch(new URL("/v1/info", gateway.url), { headers: { [APP_KEY_HEADER]: DESK_KEY } });
    const info = (await response.json()) as DeploymentInfo;
    expect(info.capabilities).toContain("openai");
    expect(info.environments.find((environment) => environment.name === "triage")).toMatchObject({ inference: { openai: "triage" }, models: ["ms-decision-1"] });
  });

  it("sends an app user's session to the endpoint with its key, never a GitHub credential", async () => {
    const client = await connect("triage", "", appUser("desk-triage"));
    const sessionId = randomUUID();
    await client.request("session.create", { sessionId });
    const create = created(sessionId);
    expect(create.params["provider"]).toEqual({ type: "openai", baseUrl: "http://help-desk.test/api/triage/v1", wireApi: "completions", wireModel: "ms-decision-1", hasBearerTokenProvider: true });
    expect(create.params).toMatchObject({ model: "ms-decision-1", allowedModels: ["ms-decision-1"] });
    expect(create.params["gitHubTokenProviderRegistrationId"]).toBeUndefined();
    expect(create.params["gitHubToken"]).toBeUndefined();
    expect(JSON.stringify(create.params)).not.toContain(ENDPOINT_KEY);

    expect(await runtime.requestOn(1, "providerToken.getToken", { sessionId, providerName: "default" })).toEqual({ token: ENDPOINT_KEY });
    const githubToken = (await runtime.requestOn(1, "gitHubToken.getToken", { sessionId, registrationId: "anything" })) as { kind?: string };
    expect(githubToken.kind).toBe("cancelled");

    const info = (await (await fetch(new URL(`/v1/sessions/${sessionId}`, gateway.url), { headers: appUser("desk-triage") })).json()) as SessionInfo;
    expect(info).toMatchObject({ model: "ms-decision-1", inference: { route: "openai", openai: "triage", model: "ms-decision-1" } });

    const models = (await client.request("models.list", {})) as { models: { id: string }[] };
    expect(models.models.map((model) => model.id)).toEqual(["ms-decision-1"]);
    await expect(client.request("session.model.switchTo", { sessionId, modelId: "other-model" })).rejects.toThrow(/keeps it for its whole life/);
    await expect(client.request("session.model.switchAutoTier", { sessionId, autoTier: "intelligence" })).rejects.toThrow(/Auto model routing/);
    await expect(client.request("session.create", { sessionId: randomUUID(), model: "other-model" })).rejects.toThrow(/not one of environment "triage"'s models/);
    // The app's session config never chooses the provider.
    await expect(client.request("session.create", { sessionId: randomUUID(), provider: { type: "openai", baseUrl: "http://elsewhere.test/v1" } })).rejects.toThrow(/Custom model providers/);
  });

  it("calls a keyless endpoint without a bearer token provider", async () => {
    const client = await connect("open", ALICE);
    const sessionId = randomUUID();
    await client.request("session.create", { sessionId });
    expect(created(sessionId).params["provider"]).toEqual({ type: "openai", baseUrl: "http://model-server.test/v1", wireApi: "completions", wireModel: "local-model" });
  });

  it("keeps sessions billed to a Copilot plan off the endpoint's key", async () => {
    const client = await connect("chat", ALICE);
    const sessionId = randomUUID();
    await client.request("session.create", { sessionId });
    expect(created(sessionId).params["provider"]).toBeUndefined();
    await expect(runtime.requestOn(1, "providerToken.getToken", { sessionId, providerName: "default" })).rejects.toThrow(/Copilot plan/);
  });
});

describe("OpenAIEndpointService", () => {
  const deployment = ManagedCopilotConfigSchema.parse(DEPLOYMENT);

  it("fails explicitly when a declared key did not reach the gateway", () => {
    const service = new OpenAIEndpointService({ deployment, env: {} });
    expect(() => service.provider("triage", "ms-decision-1")).toThrow(/did not reach the gateway \(TEST_TRIAGE_KEY is not set\)/);
    expect(service.status().find((status) => status.name === "triage")).toMatchObject({ key: true, problem: expect.stringContaining("TEST_TRIAGE_KEY"), environments: ["triage"] });
    expect(() => service.provider("missing", "m")).toThrow(/not declared/);
  });
});

describe("openai config validation", () => {
  it("accepts endpoints only on shared environments, with declared names and models", () => {
    const result = ManagedCopilotConfigSchema.safeParse({
      name: "copilot",
      openai: { triage: { url: "http://localhost:7440/v1", models: ["m"] } },
      environments: {
        bad: { type: "isolated", inference: { openai: "triage" } },
        unknown: { type: "shared", inference: { openai: "nope" } },
        model: { type: "shared", inference: { openai: "triage" }, models: ["other"] },
        both: { type: "shared", inference: { openai: "triage", foundry: "acct" } },
      },
    });
    expect(result.success).toBe(false);
    const messages = result.error!.issues.map((issue) => issue.message).join("\n");
    expect(messages).toMatch(/only valid on shared environments/);
    expect(messages).toMatch(/Unknown OpenAI-compatible endpoint "nope"/);
    expect(messages).toMatch(/"other" is not one of OpenAI-compatible endpoint "triage"'s models/);
    expect(messages).toMatch(/exactly one of foundry or openai/);
    expect(ManagedCopilotConfigSchema.safeParse({ name: "c", openai: { e: { url: "ftp://x/v1", models: ["m"] } }, environments: {} }).success).toBe(false);
  });
});
