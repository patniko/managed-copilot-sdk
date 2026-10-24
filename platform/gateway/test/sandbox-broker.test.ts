import { describe, expect, it } from "vitest";
import { isManagedCopilotError } from "@managed-copilot/protocol";
import { createLogger } from "../src/log.js";
import { InferenceBroker } from "../src/modules/sandbox/broker.js";

const log = createLogger("test", "error");
const PLACEHOLDER = "mcrt_placeholder_value_for_tests";
const TOKEN = "gho_real_token_for_tests";
const SESSION = "11111111-2222-3333-4444-555555555555";

interface Sent {
  method: string;
  params: Record<string, unknown>;
}

function setup(options: { fetch?: typeof fetch; resolveToken?: () => Promise<string> } = {}) {
  const sent: Sent[] = [];
  const fetched: { url: string; init: RequestInit }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    fetched.push({ url, init: init ?? {} });
    if (url.endsWith("/copilot_internal/user")) {
      return new Response(JSON.stringify({ login: "octocat", copilot_plan: "enterprise", endpoints: { api: "https://api.enterprise.githubcopilot.com" } }), { status: 200 });
    }
    return new Response(new Blob(['data: {"ok":true}\n\n']).stream(), { status: 200, headers: { "content-type": "text/event-stream", "set-cookie": "secret=1" } });
  };
  const broker = new InferenceBroker({
    sessionId: SESSION,
    placeholder: PLACEHOLDER,
    resolveToken: options.resolveToken ?? (async () => TOKEN),
    githubApiUrl: "https://api.github.test",
    log,
    fetch: options.fetch ?? fakeFetch,
  });
  const send = async (method: string, params: unknown) => {
    sent.push({ method, params: params as Record<string, unknown> });
    if (method === "session.gitHubAuth.setCredentials") return { success: true, copilotUserResolved: true };
    if (method === "llmInference.setProvider") return { success: true };
    return { accepted: true };
  };
  return { broker, sent, fetched, send };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function request(broker: InferenceBroker, params: Record<string, unknown>, body?: string) {
  await broker.handlers.get("llmInference.httpRequestStart")!({ requestId: "r1", method: "POST", transport: "http", ...params });
  await broker.handlers.get("llmInference.httpRequestChunk")!({ requestId: "r1", data: body ?? "", end: true });
}

describe("InferenceBroker", () => {
  it("registers as provider and installs a placeholder credential with a gateway-resolved identity", async () => {
    const { broker, sent, fetched, send } = setup();
    await broker.initialize(send);
    await broker.sessionOpened(SESSION);
    expect(sent[0]).toEqual({ method: "llmInference.setProvider", params: {} });
    const install = sent.find((entry) => entry.method === "session.gitHubAuth.setCredentials")!;
    const credentials = install.params["credentials"] as Record<string, unknown>;
    expect(install.params["sessionId"]).toBe(SESSION);
    expect(credentials["token"]).toBe(PLACEHOLDER);
    expect(credentials["type"]).toBe("token");
    expect((credentials["copilotUser"] as Record<string, unknown>)["login"]).toBe("octocat");
    expect(JSON.stringify(sent)).not.toContain(TOKEN);
    expect(fetched[0]!.url).toBe("https://api.github.test/copilot_internal/user");
  });

  it("swaps the placeholder for the owner's token on allowlisted Copilot API requests and streams the response", async () => {
    const { broker, sent, fetched, send } = setup();
    await broker.initialize(send);
    await request(broker, { sessionId: SESSION, url: "https://api.githubcopilot.com/v1/messages", headers: { authorization: [`Bearer ${PLACEHOLDER}`], "content-type": ["application/json"], cookie: ["x=1"] } }, '{"model":"m"}');
    await waitFor(() => sent.some((entry) => entry.method === "llmInference.httpResponseChunk" && entry.params["end"] === true));
    const upstream = fetched.find((entry) => entry.url.includes("/v1/messages"))!;
    const headers = upstream.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(headers["cookie"]).toBeUndefined();
    expect(Buffer.from(upstream.init.body as Buffer).toString()).toBe('{"model":"m"}');
    const start = sent.find((entry) => entry.method === "llmInference.httpResponseStart")!;
    expect(start.params["status"]).toBe(200);
    expect((start.params["headers"] as Record<string, unknown>)["set-cookie"]).toBeUndefined();
    const body = sent
      .filter((entry) => entry.method === "llmInference.httpResponseChunk" && entry.params["data"])
      .map((entry) => Buffer.from(String(entry.params["data"]), "base64").toString())
      .join("");
    expect(body).toContain('{"ok":true}');
    expect(JSON.stringify(sent)).not.toContain(TOKEN);
  });

  it("refuses non-Copilot hosts, other sessions, and requests without the placeholder", async () => {
    for (const [params, status] of [
      [{ sessionId: SESSION, url: "https://evil.example.com/v1/messages", headers: { authorization: [`Bearer ${PLACEHOLDER}`] } }, 403],
      [{ sessionId: SESSION, url: "http://api.githubcopilot.com/v1/messages", headers: { authorization: [`Bearer ${PLACEHOLDER}`] } }, 403],
      [{ sessionId: "another-session", url: "https://api.githubcopilot.com/v1/messages", headers: { authorization: [`Bearer ${PLACEHOLDER}`] } }, 403],
      [{ sessionId: SESSION, url: "https://api.githubcopilot.com/v1/messages", headers: { authorization: ["Bearer stolen"] } }, 401],
      [{ sessionId: SESSION, url: "https://api.githubcopilot.com/v1/messages", headers: {} }, 401],
    ] as const) {
      const { broker, sent, fetched, send } = setup();
      await broker.initialize(send);
      await request(broker, params as unknown as Record<string, unknown>);
      await waitFor(() => sent.some((entry) => entry.method === "llmInference.httpResponseChunk"));
      expect(sent.find((entry) => entry.method === "llmInference.httpResponseStart")!.params["status"]).toBe(status);
      expect((sent.find((entry) => entry.method === "llmInference.httpResponseChunk")!.params["error"] as Record<string, unknown>)["message"]).toBeTruthy();
      expect(fetched.filter((entry) => !entry.url.endsWith("/copilot_internal/user"))).toHaveLength(0);
    }
  });

  it("fails closed when the owner has no usable credential", async () => {
    const { broker, sent, send } = setup({
      resolveToken: async () => {
        const { ManagedCopilotError } = await import("@managed-copilot/protocol");
        throw new ManagedCopilotError("authentication_required", "Sign in again");
      },
    });
    await broker.initialize(send);
    await request(broker, { sessionId: SESSION, url: "https://api.githubcopilot.com/v1/messages", headers: { authorization: [`Bearer ${PLACEHOLDER}`] } });
    await waitFor(() => sent.some((entry) => entry.method === "llmInference.httpResponseChunk"));
    expect(sent.find((entry) => entry.method === "llmInference.httpResponseStart")!.params["status"]).toBe(401);
    expect((sent.find((entry) => entry.method === "llmInference.httpResponseChunk")!.params["error"] as Record<string, unknown>)["code"]).toBe("authentication_required");
    await expect(broker.sessionOpened(SESSION)).rejects.toSatisfy((error: unknown) => isManagedCopilotError(error, "authentication_required"));
  });

  it("never answers gitHubToken.getToken for sandbox runtimes", async () => {
    const { broker } = setup();
    await expect(broker.handlers.get("gitHubToken.getToken")!({ registrationId: "x", host: "https://github.com", reason: "initial" })).rejects.toSatisfy((error: unknown) =>
      isManagedCopilotError(error, "forbidden"),
    );
  });
});
