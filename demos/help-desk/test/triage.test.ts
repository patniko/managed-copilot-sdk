import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { MessageOptions, ResponseSchema, SessionConfig } from "@github/copilot-sdk";
import type { SessionInfo } from "@managed-copilot/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { decisionEndpoint } from "../src/server/config.js";
import { DecisionClient, DecisionError, type Decider, type DecisionRequest } from "../src/server/decision.js";
import { HelpDesk } from "../src/server/desk.js";
import { createRequestHandler } from "../src/server/http.js";
import { EventHub } from "../src/server/hub.js";
import { authorized, complete, EndpointError, parseRequest, readAnswers, stripContext } from "../src/server/triage-endpoint.js";
import { TRIAGE_QUESTIONS, TRIAGE_SESSION_PREFIX, Triage, USES_PER_SESSION, type ClassifierSession, type TriagePlatform } from "../src/server/triage.js";
import { CUSTOMERS } from "../src/server/seed.js";
import type { PlatformStatus, ServerEvent } from "../src/shared/types.js";
import { FakeFactory, FakePlatform, settle, testConfig } from "./fakes.js";

/** A chat completion as the stock runtime sends it for `sendAndWait(prompt, schema)` on an `openai` provider. */
function completion(overrides: Record<string, unknown> = {}, user = "<current_datetime>2026-11-03T10:00:00Z</current_datetime>\n\nMy tent never arrived and I leave Friday!") {
  return {
    model: "ms-decision-1",
    messages: [
      { role: "system", content: JSON.stringify(TRIAGE_QUESTIONS) },
      { role: "user", content: "An earlier message" },
      { role: "assistant", content: '{"category":"question","urgent":false}' },
      { role: "user", content: user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "response",
        strict: true,
        schema: {
          type: "object",
          properties: { category: { type: "string", enum: ["delivery", "refund", "cancellation", "order-change", "website-problem", "question"] }, urgent: { type: "boolean" } },
          required: ["category", "urgent"],
          additionalProperties: false,
        },
      },
    },
    ...overrides,
  };
}

class FakeDecider implements Decider {
  readonly requests: DecisionRequest[] = [];
  answers: Record<string, unknown> = { category: { type: "choice", choice: "delivery", confidence: 0.97 }, urgent: { type: "noul", noul: 0.91 } };
  failWith: Error | undefined;

  async decide(request: DecisionRequest) {
    this.requests.push(request);
    if (this.failWith) throw this.failWith;
    return { answers: this.answers, usage: { input_tokens: 70, output_tokens: 2 } };
  }
}

describe("the triage endpoint's requests", () => {
  it("ask the schema's properties as decision questions about the last user message", () => {
    const parsed = parseRequest(completion());
    expect(parsed.state).toBe("My tent never arrived and I leave Friday!");
    expect(parsed.questions["category"]).toMatchObject({ type: "choice", instructions: TRIAGE_QUESTIONS["category"]!.instructions });
    expect(Object.keys((parsed.questions["category"] as { criteria: object }).criteria)).toEqual(["delivery", "refund", "cancellation", "order-change", "website-problem", "question"]);
    expect(parsed.questions["urgent"]).toMatchObject({ type: "noul", criteria: { true: expect.any(String), false: expect.any(String) } });
  });

  it.each([
    ["streaming", { stream: true }, /Streaming/],
    ["no structured output", { response_format: undefined }, /structured output/],
    ["a text response format", { response_format: { type: "text" } }, /structured output/],
    ["a property that isn't an enum or a boolean", { response_format: { type: "json_schema", json_schema: { schema: { type: "object", properties: { category: { type: "string" } } } } } }, /string enum/],
    ["a property the system message doesn't ask", { response_format: { type: "json_schema", json_schema: { schema: { type: "object", properties: { mood: { type: "boolean" } } } } } }, /no question for "mood"/],
    ["a system message that isn't the questions", { messages: [{ role: "system", content: "You are helpful." }, { role: "user", content: "hi" }] }, /must be JSON/],
    ["no user message", { messages: [{ role: "system", content: JSON.stringify(TRIAGE_QUESTIONS) }] }, /user message/],
  ])("are refused with 400 for %s", (_name, overrides, message) => {
    const attempt = () => parseRequest(completion(overrides));
    expect(attempt).toThrow(EndpointError);
    expect(attempt).toThrow(message);
    try {
      attempt();
    } catch (error) {
      expect((error as EndpointError).status).toBe(400);
    }
  });

  it("read the customer's words without the runtime's date", () => {
    expect(stripContext("<current_datetime>2026-11-03T10:00:00Z</current_datetime>\n\nWhere is my order?")).toBe("Where is my order?");
    expect(stripContext("Where is my order?")).toBe("Where is my order?");
  });

  it("need the platform's key as a bearer token", () => {
    expect(authorized("Bearer s3cret-key", "s3cret-key")).toBe(true);
    expect(authorized("Bearer wrong", "s3cret-key")).toBe(false);
    expect(authorized(undefined, "s3cret-key")).toBe(false);
  });
});

describe("the triage endpoint's answers", () => {
  it("are the schema's values in an assistant message", async () => {
    const decider = new FakeDecider();
    const response = await complete(completion(), decider);
    expect(decider.requests[0]!.state).toBe("My tent never arrived and I leave Friday!");
    expect(response).toMatchObject({ object: "chat.completion", model: "ms-decision-1", usage: { prompt_tokens: 70, completion_tokens: 2, total_tokens: 72 } });
    const choice = (response["choices"] as { message: { role: string; content: string } }[])[0]!;
    expect(choice.message.role).toBe("assistant");
    expect(JSON.parse(choice.message.content)).toEqual({ category: "delivery", urgent: true });
  });

  it("turn a noul's probability into a boolean, and refuse answers outside the schema", () => {
    const properties = { urgent: { kind: "noul" as const }, category: { kind: "choice" as const, values: ["delivery", "refund"] } };
    expect(readAnswers({ urgent: { noul: 0.2 }, category: { choice: "refund" } }, properties)).toEqual({ urgent: false, category: "refund" });
    expect(() => readAnswers({ urgent: { noul: 0.2 }, category: { choice: "pizza" } }, properties)).toThrow(/unknown value/);
    expect(() => readAnswers({ category: { choice: "refund" } }, properties)).toThrow(/didn't answer "urgent"/);
  });

  it("pass on why the decision API failed", async () => {
    const decider = new FakeDecider();
    decider.failWith = new DecisionError("Microsoft Foundry refused Help Desk's Azure identity.", 403);
    await expect(complete(completion(), decider)).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/refused/) });
  });
});

describe("the decision client", () => {
  it("calls the decision API as the Azure identity, with the deployment as the model", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new DecisionClient({
      endpoint: "https://contoso.services.ai.azure.com/",
      deployment: "ms-decision-1",
      tokens: { token: async (resource) => `token-for-${resource}` },
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ model: "microsoft-decision-1", answers: { urgent: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 5, output_tokens: 1 } }));
      }) as typeof fetch,
    });
    const response = await client.decide({ state: "Help", questions: { urgent: { type: "noul", instructions: "Urgent?" } } });
    expect(response.answers).toEqual({ urgent: { type: "noul", noul: 0.9 } });
    expect(calls[0]!.url).toBe("https://contoso.services.ai.azure.com/providers/microsoft/v1/systemone");
    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer token-for-https://cognitiveservices.azure.com");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ model: "ms-decision-1", state: "Help", questions: { urgent: { type: "noul", instructions: "Urgent?" } } });
  });

  it("says which role is missing when Foundry refuses the identity", async () => {
    const client = new DecisionClient({
      endpoint: "https://contoso.services.ai.azure.com",
      deployment: "ms-decision-1",
      tokens: { token: async () => "token" },
      fetch: (async () => new Response(JSON.stringify({ error: { code: "PermissionDenied", message: "Principal lacks the data action." } }), { status: 401 })) as unknown as typeof fetch,
    });
    await expect(client.decide({ state: "x", questions: {} })).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/Cognitive Services User.*|Principal lacks/) });
  });

  it("takes the endpoint as the portal shows it", () => {
    expect(decisionEndpoint("https://contoso.services.ai.azure.com/models")).toBe("https://contoso.services.ai.azure.com");
    expect(decisionEndpoint(" ")).toBeUndefined();
    expect(() => decisionEndpoint("http://contoso.services.ai.azure.com")).toThrow(/https/);
  });
});

describe("the triage endpoint over HTTP", () => {
  const servers: Server[] = [];
  const desks: HelpDesk[] = [];
  afterEach(async () => {
    for (const desk of desks.splice(0)) desk.close();
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  async function start(decider?: Decider): Promise<string> {
    const config = testConfig(decider ? { decision: { endpoint: "https://contoso.services.ai.azure.com", deployment: "ms-decision-1", key: "platform-key" } } : {});
    const hub = new EventHub();
    const desk = new HelpDesk(new FakePlatform(), config, (event) => hub.publish(event), new FakeFactory());
    desks.push(desk);
    const server = createServer(createRequestHandler({ desk, hub, config, ...(decider ? { decider } : {}) }));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  function post(url: string, body: unknown, key?: string): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const headers: Record<string, string> = { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
      const req = request(`${url}/api/triage/v1/chat/completions`, { method: "POST", headers }, (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> }));
      });
      req.on("error", reject);
      req.end(payload);
    });
  }

  it("answers the platform's chat completions", async () => {
    const url = await start(new FakeDecider());
    const response = await post(url, completion(), "platform-key");
    expect(response.status).toBe(200);
    expect(response.body["object"]).toBe("chat.completion");
  });

  it("refuses callers without the key, and requests it can't answer", async () => {
    const url = await start(new FakeDecider());
    expect((await post(url, completion(), "wrong")).status).toBe(401);
    const streaming = await post(url, completion({ stream: true }), "platform-key");
    expect(streaming.status).toBe(400);
    expect(streaming.body["error"]).toMatchObject({ type: "invalid_request_error", message: expect.stringMatching(/Streaming/) });
  });

  it("says when it isn't set up", async () => {
    const url = await start();
    const response = await post(url, completion(), "anything");
    expect(response.status).toBe(503);
    expect(response.body["error"]).toMatchObject({ message: expect.stringMatching(/isn't set up/) });
  });
});

class FakeClassifierSession implements ClassifierSession {
  readonly prompts: string[] = [];
  disconnected = false;
  constructor(
    readonly sessionId: string,
    readonly config: SessionConfig,
    readonly answer: (text: string) => unknown,
  ) {}

  async sendAndWait<T>(options: MessageOptions | string, schema: ResponseSchema<T>): Promise<T> {
    const text = typeof options === "string" ? options : options.prompt;
    this.prompts.push(text);
    return schema.parse(this.answer(text));
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

class FakeTriagePlatform implements TriagePlatform {
  status: PlatformStatus = { state: "connected" };
  model: string | undefined = "ms-decision-1";
  readonly sessions: FakeClassifierSession[] = [];
  readonly deleted: string[] = [];
  readonly listed: string[] = [];
  answer: (text: string) => unknown = (text) => ({ category: /refund/i.test(text) ? "refund" : "delivery", urgent: /today|tomorrow/i.test(text) });
  readonly #status = new Set<(status: PlatformStatus) => void>();
  readonly #connected = new Set<() => void>();

  onStatus(listener: (status: PlatformStatus) => void): () => void {
    this.#status.add(listener);
    return () => this.#status.delete(listener);
  }

  onConnected(listener: () => void): () => void {
    this.#connected.add(listener);
    return () => this.#connected.delete(listener);
  }

  connect(): void {
    for (const listener of this.#connected) listener();
  }

  async createSession(config: SessionConfig): Promise<ClassifierSession> {
    const session = new FakeClassifierSession(config.sessionId!, config, (text) => this.answer(text));
    this.sessions.push(session);
    return session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deleted.push(sessionId);
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.listed.map((id) => ({ id }) as SessionInfo);
  }
}

describe("the classifier", () => {
  it("asks a session with the questions as its whole system message, no tools, and structured output", async () => {
    const platform = new FakeTriagePlatform();
    const triage = new Triage(platform, "help-desk-triage");
    expect(await triage.classify("I want a refund today")).toEqual({ category: "refund", urgent: true });
    const config = platform.sessions[0]!.config;
    expect(config.sessionId!.startsWith(TRIAGE_SESSION_PREFIX)).toBe(true);
    expect(config).toMatchObject({ model: "ms-decision-1", streaming: false, availableTools: [], systemMessage: { mode: "replace" } });
    expect(JSON.parse((config.systemMessage as { content: string }).content)).toEqual(TRIAGE_QUESTIONS);
    expect(triage.status).toEqual({ state: "ready", environment: "help-desk-triage", model: "ms-decision-1" });
  });

  it("reuses its sessions, and replaces one after many classifications", async () => {
    const platform = new FakeTriagePlatform();
    const triage = new Triage(platform, "help-desk-triage");
    for (let index = 0; index < USES_PER_SESSION; index++) await triage.classify(`message ${index}`);
    expect(platform.sessions).toHaveLength(1);
    await settle();
    expect(platform.deleted).toEqual([platform.sessions[0]!.sessionId]);
    await triage.classify("one more");
    expect(platform.sessions).toHaveLength(2);
  });

  it("says why it failed, until a classification works again", async () => {
    const platform = new FakeTriagePlatform();
    const triage = new Triage(platform, "help-desk-triage");
    platform.answer = () => {
      throw new Error("403 Microsoft Foundry refused Help Desk's Azure identity.");
    };
    await expect(triage.classify("hello")).rejects.toThrow(/Classification failed: 403/);
    expect(triage.status).toMatchObject({ state: "unavailable", message: expect.stringMatching(/refused/) });
    platform.answer = () => ({ category: "question", urgent: false });
    await triage.classify("hello");
    expect(triage.status.state).toBe("ready");
  });

  it("deletes classification sessions an earlier Help Desk left behind", async () => {
    const platform = new FakeTriagePlatform();
    platform.listed.push(`${TRIAGE_SESSION_PREFIX}old`, "hd-run-c01");
    new Triage(platform, "help-desk-triage");
    platform.connect();
    await settle();
    expect(platform.deleted).toEqual([`${TRIAGE_SESSION_PREFIX}old`]);
  });

  it("is off when it isn't set up", () => {
    expect(new Triage().status).toEqual({ state: "off" });
  });
});

describe("the wall's tickets", () => {
  const desks: HelpDesk[] = [];
  afterEach(() => {
    for (const desk of desks.splice(0)) desk.close();
  });

  it("carry their classification, and a new customer message is classified again", async () => {
    const platform = new FakePlatform();
    const triagePlatform = new FakeTriagePlatform();
    const events: ServerEvent[] = [];
    const desk = new HelpDesk(platform, testConfig(), (event) => events.push(event), new FakeFactory(), new Triage(triagePlatform, "help-desk-triage"));
    desk.start();
    desks.push(desk);
    expect(desk.desk().triage.state).toBe("ready");
    await desk.simulate(5);
    await settle(200);
    const tickets = desk.state().tickets;
    expect(tickets).toHaveLength(5);
    for (const ticket of tickets) expect(ticket.triage?.state).toBe("done");
    expect(triagePlatform.sessions.flatMap((session) => session.prompts).sort()).toEqual(CUSTOMERS.slice(0, 5).map((customer) => customer.opening).sort());

    await desk.send("c01", "Actually, please just refund it.");
    await settle(200);
    expect(desk.ticket("c01").triage).toEqual({ state: "done", category: "refund", urgent: expect.any(Boolean) });
    expect(triagePlatform.sessions.flatMap((session) => session.prompts).at(-1)).toContain("Actually, please just refund it.");
  });

  it("can be classified from their first messages alone, without starting a session, until a simulation starts", async () => {
    const platform = new FakePlatform();
    const triagePlatform = new FakeTriagePlatform();
    const events: ServerEvent[] = [];
    const desk = new HelpDesk(platform, testConfig(), (event) => events.push(event), new FakeFactory(), new Triage(triagePlatform, "help-desk-triage"));
    desk.start();
    desks.push(desk);
    expect(() => desk.classifyOpenings(7)).toThrow(/Classify 5, 10, 25/);
    const started = desk.classifyOpenings(5);
    expect(Object.values(started.results).every((result) => result.state === "classifying")).toBe(true);
    await settle(50);
    const classification = desk.state().classification!;
    expect(Object.keys(classification.results).sort()).toEqual(CUSTOMERS.slice(0, 5).map((customer) => customer.id).sort());
    for (const result of Object.values(classification.results)) expect(result.state).toBe("done");
    expect(classification.elapsedMs).toEqual(expect.any(Number));
    expect(triagePlatform.sessions.flatMap((session) => session.prompts).sort()).toEqual(CUSTOMERS.slice(0, 5).map((customer) => customer.opening).sort());
    expect(desk.state().tickets).toEqual([]);
    expect(events.filter((event) => event.type === "classification").length).toBeGreaterThan(1);

    await desk.simulate(5);
    expect(desk.state().classification).toBeUndefined();
    expect(events.some((event) => event.type === "classification" && !event.classification)).toBe(true);
    expect(() => desk.classifyOpenings(5)).toThrow(/End the simulation first/);
  });

  it("can't be classified on their own when classification isn't set up", () => {
    const desk = new HelpDesk(new FakePlatform(), testConfig(), () => undefined, new FakeFactory());
    desks.push(desk);
    expect(() => desk.classifyOpenings(5)).toThrow(/isn't set up/);
  });

  it("aren't classified when classification isn't set up", async () => {
    const platform = new FakePlatform();
    const desk = new HelpDesk(platform, testConfig(), () => undefined, new FakeFactory());
    desk.start();
    desks.push(desk);
    await desk.simulate(5);
    await settle(50);
    expect(desk.desk().triage).toEqual({ state: "off" });
    for (const ticket of desk.state().tickets) expect(ticket.triage).toBeUndefined();
  });
});
