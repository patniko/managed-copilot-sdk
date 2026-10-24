// Core's callback obligations and runtime credentials: SDK hooks have one connected handler and fail closed without it;
// what clients registered survives their disconnects and gateway restarts; runtime credentials come only from a
// connected client of the owner or a current background sign-in; restores keep durable's pending work; interrupted
// creates and deletions are finished; and every session incarnation is told apart.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlatformEvent } from "@managed-copilot/protocol";
import type { Principal } from "../src/http.js";
import { FakeRuntime, FakeSandboxes, RawClient, sleep, startGitHubStub, startTestGateway, type StubUser, type TestGateway } from "./harness.js";

const ALICE = "alice-token";
const BOB = "bob-token";

async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not met in time");
    await sleep(10);
  }
}

describe("callback obligations and runtime credentials", () => {
  let runtime: FakeRuntime;
  let github: Awaited<ReturnType<typeof startGitHubStub>>;
  let gateway: TestGateway;
  let alice: Principal;
  const clients: RawClient[] = [];
  // What GitHub knows: a token removed here is rejected (401) from then on.
  const users: Record<string, StubUser> = { [ALICE]: { id: 1001, login: "alice" }, [BOB]: { id: 2002, login: "bob" } };

  type Manager = ReturnType<TestGateway["gateway"]["app"]["service"]> & { recover(): Promise<void>; presence(sessionId: string, principal: Principal): () => void };
  const sessions = () => gateway.gateway.app.service("sessions") as unknown as Manager;
  const connect = async (answer?: RawClient["answer"], environment = "chat") => {
    const client = await RawClient.connect(gateway.url, ALICE, environment);
    if (answer) client.answer = answer;
    clients.push(client);
    return client;
  };
  /** Replaces some of a gateway service's members for one test (the rest stay bound to the real service). */
  const override = (name: string, members: Record<string, unknown>): (() => void) => {
    const services = gateway.gateway.app.services as Record<string, unknown>;
    const original = services[name] as Record<string | symbol, unknown>;
    services[name] = new Proxy(original, {
      get: (target, key) => {
        if (typeof key === "string" && key in members) return members[key];
        const value = target[key];
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    return () => {
      services[name] = original;
    };
  };
  const storedCallbacks = (sessionId: string) =>
    (JSON.parse((gateway.gateway.app.db.prepare("SELECT admitted FROM core_sessions WHERE id = ?").get(sessionId) as { admitted: string }).admitted) as { callbacks: { tools: { name: string }[]; flags: Record<string, boolean> } }).callbacks;
  /** The fake runtime connection the gateway's shared upstream uses for a session (where it was last opened). */
  const upstreamOf = (sessionId: string) =>
    runtime.requests.filter((request) => (request.method === "session.resume" || request.method === "session.create") && request.params["sessionId"] === sessionId).at(-1)!.connection!;
  const invokeHook = (sessionId: string, hookType: string) => runtime.requestOn(upstreamOf(sessionId), "hooks.invoke", { sessionId, hookType, input: { toolName: "lookup_order", toolArgs: {} } }) as Promise<{ output?: Record<string, unknown> }>;
  const lastResume = (sessionId: string) => runtime.calls("session.resume").filter((call) => call.params["sessionId"] === sessionId).at(-1)?.params;
  const stopped = (sessionId: string) => {
    let seen = false;
    const off = sessions().onLifecycle((event) => {
      if (event.sessionId === sessionId && event.type === "stopped") seen = true;
    });
    return async () => {
      await waitUntil(() => seen);
      off();
    };
  };

  beforeAll(async () => {
    runtime = new FakeRuntime();
    await runtime.start();
    github = await startGitHubStub(users);
    gateway = await startTestGateway({ runtime, githubUrl: github.url });
    alice = await gateway.gateway.app.service("auth").authenticate(ALICE);
  });

  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await gateway?.close();
    await runtime?.close();
    await github?.close();
  });

  it("routes hooks only to the client that registered them and refuses a competing registration", async () => {
    const guard = await connect((method) => (method === "hooks.invoke" ? { output: { permissionDecision: "deny", permissionDecisionReason: "guarded" } } : {}));
    const sessionId = crypto.randomUUID();
    await guard.request("session.create", { sessionId, hooks: true, requestPermission: true });
    // Like a stock SDK client that registered only onSessionStart: it answers every other hook with no output.
    const other = await connect((method) => (method === "hooks.invoke" ? {} : {}));
    await expect(other.request("session.resume", { sessionId, hooks: true, requestPermission: true })).rejects.toMatchObject({ data: { code: "conflict" } });
    // Without hooks it may attach; the hooks still go to the client that registered them.
    await other.request("session.resume", { sessionId, requestPermission: true });
    expect(lastResume(sessionId)).toMatchObject({ hooks: true });
    await expect(invokeHook(sessionId, "preToolUse")).resolves.toEqual({ output: { permissionDecision: "deny", permissionDecisionReason: "guarded" } });
    expect(other.requests.some((request) => request.method === "hooks.invoke")).toBe(false);
  });

  it("fails hooks closed and refuses turns while no connected client answers them, until a client takes them over", async () => {
    const guard = await connect((method) => (method === "hooks.invoke" ? { output: {} } : {}));
    const sessionId = crypto.randomUUID();
    await guard.request("session.create", { sessionId, hooks: true, requestPermission: true });
    const viewer = await connect();
    await viewer.request("session.resume", { sessionId, requestPermission: true });
    await guard.close();
    await waitUntil(() => !sessions().attached(sessionId).some((responder) => responder.connectionId === guard.welcome.connectionId));

    // The runtime carries on after an error from hooks.invoke, so gating hooks get an explicit closed answer.
    expect((await invokeHook(sessionId, "preToolUse")).output).toMatchObject({ permissionDecision: "deny" });
    expect((await invokeHook(sessionId, "userPromptSubmitted")).output).toMatchObject({ decision: "block" });
    // A tool result the session's hooks could not review (for example to redact it) is withheld from the model.
    const withheld = (await invokeHook(sessionId, "postToolUse")).output as { modifiedResult?: { textResultForLlm?: string; resultType?: string } };
    expect(withheld.modifiedResult).toMatchObject({ resultType: "denied", textResultForLlm: expect.stringMatching(/withheld/) });
    await expect(invokeHook(sessionId, "sessionStart")).rejects.toMatchObject({ data: { code: "background_callback_unsupported" } });
    // New turns do not start without their hooks, from a client or from the service (schedules, REST).
    await expect(viewer.request("session.send", { sessionId, prompt: "hello" })).rejects.toMatchObject({ data: { code: "background_callback_unsupported" } });
    await expect(sessions().send(alice, sessionId, { prompt: "scheduled" })).rejects.toMatchObject({ code: "background_callback_unsupported" });
    const cli = await sessions().attachCli!(1001, sessionId, { connectionId: `cli_${sessionId}`, notify: () => undefined });
    expect(() => cli.write({ kind: "turn", text: "from the terminal" }, () => undefined)).toThrowError(expect.objectContaining({ code: "background_callback_unsupported" }));
    cli.close();
    // A client without hooks cannot quietly drop them by resuming.
    const late = await connect();
    await expect(late.request("session.resume", { sessionId, requestPermission: true })).rejects.toMatchObject({ data: { code: "background_callback_unsupported" } });

    // A client that resumes with hooks takes them over, and can withdraw them by resuming again without.
    const takeover = await connect((method) => (method === "hooks.invoke" ? { output: {} } : {}));
    await takeover.request("session.resume", { sessionId, hooks: true, requestPermission: true });
    await expect(invokeHook(sessionId, "preToolUse")).resolves.toEqual({ output: {} });
    await takeover.request("session.resume", { sessionId, requestPermission: true });
    // Withdrawn handlers are turned off on the runtime explicitly (a resume that omits a flag may keep it there).
    expect(lastResume(sessionId)).toMatchObject({ hooks: false, hasSkillProvider: false, requestUserInput: false, requestPermission: true });
    await viewer.request("session.send", { sessionId, prompt: "hooks withdrawn" });
    await waitUntil(() => viewer.events("assistant.message").some((event) => (event["data"] as Record<string, unknown>)["content"] === "echo: hooks withdrawn"));
  });

  it("restores what clients registered, and scheduled tools' flags, after the gateway restarts", async () => {
    const client = await connect((method) => (method === "hooks.invoke" ? { output: {} } : {}));
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, tools: [{ name: "lookup_order", description: "Look up an order" }], hooks: true, requestPermission: true, requestUserInput: true });
    const scheduled = crypto.randomUUID();
    await sessions().create(alice, { sessionId: scheduled, environment: "chat", tools: [{ name: "ship_order", skipPermission: true, overridesBuiltInTool: false }], scheduleId: "nightly" });
    // The server-side create declares the tool with its flags to the runtime.
    const createdTools = runtime.calls("session.create").find((call) => call.params["sessionId"] === scheduled)!.params["tools"];
    expect(createdTools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "ship_order", skipPermission: true, overridesBuiltInTool: false })]));
    for (const connected of clients.splice(0)) await connected.close();
    const dataDir = gateway.dataDir;
    await gateway.close({ keepData: true });
    gateway = await startTestGateway({ runtime, githubUrl: github.url, dataDir });
    alice = await gateway.gateway.app.service("auth").authenticate(ALICE);

    // Service-driven restores (a schedule continuing the session) keep the client's tools and callback flags.
    await sessions().request(sessionId, "session.getMessages", {});
    const restored = lastResume(sessionId)!;
    expect((restored["tools"] as { name: string }[]).map((tool) => tool.name)).toContain("lookup_order");
    expect(restored).toMatchObject({ hooks: true, requestPermission: true, requestUserInput: true, requestElicitation: false, hasSkillProvider: false });
    // Its hooks are still required: with no client to answer them, they fail closed.
    expect((await invokeHook(sessionId, "preToolUse")).output).toMatchObject({ permissionDecision: "deny" });

    await sessions().request(scheduled, "session.getMessages", {});
    const scheduledResume = lastResume(scheduled)!;
    expect(scheduledResume["tools"]).toEqual(expect.arrayContaining([expect.objectContaining({ name: "ship_order", skipPermission: true, overridesBuiltInTool: false })]));
    expect(scheduledResume).toMatchObject({ requestPermission: true });
  });

  it("answers runtime credential requests only from a connected client of the owner or a current background sign-in", async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, requestPermission: true });
    const registrationId = runtime.sessions.get(sessionId)!.createParams["gitHubTokenProviderRegistrationId"] as string;
    const ask = () => runtime.requestOn(upstreamOf(sessionId), "gitHubToken.getToken", { registrationId, sessionId, host: "https://github.com", reason: "refresh" }) as Promise<{ kind: string; accessToken?: string; expiresIn?: number }>;

    const attached = await ask();
    expect(attached).toMatchObject({ kind: "token", accessToken: ALICE });
    // Short answers: the runtime asks again once a token is within an hour of expiry, so the gateway decides again soon.
    expect(attached.expiresIn).toBeGreaterThan(3600);
    expect(attached.expiresIn).toBeLessThanOrEqual(3900);

    await client.close();
    await waitUntil(() => sessions().attached(sessionId).length === 0);
    // The account's token was verified moments ago, but nobody is connected and there is no background sign-in.
    expect(gateway.gateway.app.service("auth").liveCredential(1001)?.token).toBe(ALICE);
    await expect(ask()).resolves.toEqual({ kind: "cancelled" });

    // A presence (an attached Copilot CLI) supplies the owner's credential while it is held.
    const release = sessions().presence(sessionId, alice);
    await expect(ask()).resolves.toMatchObject({ kind: "token", accessToken: ALICE });
    release();
    await expect(ask()).resolves.toEqual({ kind: "cancelled" });

    // A background sign-in serves the session until it is revoked.
    const credentials = gateway.gateway.app.service("credentials");
    credentials.store(alice);
    await expect(ask()).resolves.toMatchObject({ kind: "token", accessToken: ALICE });
    // GitHub rejects the token (a 401 the sandbox broker saw, for example): the stored sign-in is checked again too.
    const auth = gateway.gateway.app.service("auth");
    const known = users[ALICE]!;
    delete users[ALICE];
    auth.invalidate(ALICE);
    try {
      await expect(ask()).resolves.toEqual({ kind: "cancelled" });
    } finally {
      users[ALICE] = known;
      auth.invalidate(ALICE);
    }
    credentials.revoke(alice);
    await expect(ask()).resolves.toEqual({ kind: "cancelled" });
  });

  it("never makes a token only background work presented the account's live credential", async () => {
    const auth = gateway.gateway.app.service("auth");
    const bob = await auth.authenticate(BOB, { background: true });
    const sessionId = crypto.randomUUID();
    // A schedule's create and send hold the owner's presence; the runtime asks for a token meanwhile.
    await sessions().create(bob, { sessionId, environment: "chat" });
    await sessions().send(bob, sessionId, { prompt: "scheduled run" });
    expect(runtime.sessions.get(sessionId)!.token).toBe(BOB);
    expect(auth.liveCredential(2002)).toBeUndefined();
  });

  it("continues the runtime's pending work when it restores a session durable still waits on", async () => {
    const client = await connect();
    const waiting = crypto.randomUUID();
    await client.request("session.create", { sessionId: waiting, tools: [{ name: "lookup_order" }], requestPermission: true });
    await client.request("session.send", { sessionId: waiting, prompt: "tool:lookup_order" });
    await client.waitForEvent("external_tool.requested");
    const idle = crypto.randomUUID();
    await client.request("session.create", { sessionId: idle, requestPermission: true });
    await client.close();
    const done = [stopped(waiting), stopped(idle)];
    runtime.dropConnections();
    await Promise.all(done.map((wait) => wait()));

    await sessions().request(waiting, "session.tools.listPendingRequests", {});
    expect(lastResume(waiting)).toMatchObject({ continuePendingWork: true });
    await sessions().request(idle, "session.getMessages", {});
    expect(lastResume(idle)).not.toHaveProperty("continuePendingWork");

    // Durable is asked about this incarnation's work only (an earlier session with the same ID left its own).
    const asked: unknown[] = [];
    const restore = override("actions", { hasOpenActions: (id: string, options: unknown) => (asked.push({ id, options }), false) });
    try {
      const done2 = stopped(idle);
      runtime.dropConnections();
      await done2();
      await sessions().request(idle, "session.getMessages", {});
      expect(asked).toContainEqual({ id: idle, options: { incarnation: sessions().get(idle)!.incarnation } });
    } finally {
      restore();
    }
  });

  it("attaches a Copilot CLI as a cli responder whose writes and answers go through ownership and admission", async () => {
    const app = gateway.gateway.app;
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, tools: [{ name: "lookup_order" }], requestPermission: true });
    const notified: string[] = [];
    const resumesBefore = runtime.calls("session.resume").length;
    const cli = await sessions().attachCli!(1001, sessionId, { connectionId: "cli_one", notify: (method) => notified.push(method) });
    // A responder of its own kind, with no tools; attaching sends nothing to the runtime.
    expect(sessions().attached(sessionId)).toContainEqual(expect.objectContaining({ connectionId: "cli_one", kind: "cli", tools: [], requestPermission: true, requestElicitation: true }));
    expect(runtime.calls("session.resume").length).toBe(resumesBefore);
    expect(cli.incarnation).toBe(sessions().get(sessionId)!.incarnation);
    await expect(sessions().attachCli!(2002, sessionId, { connectionId: "cli_other", notify: () => undefined })).rejects.toMatchObject({ code: "not_found" });
    runtime.emitEvent(sessionId, "assistant.message", { content: "seen by the CLI responder" });
    await waitUntil(() => notified.includes("session.event"));

    // Writes run the AHP send in the same step as the checks, or not at all.
    let sent = 0;
    cli.write({ kind: "turn", text: "status of order 42?" }, () => sent++);
    cli.write({ kind: "abort" }, () => sent++);
    expect(() => cli.write({ kind: "turn", text: "  " }, () => sent++)).toThrow(/needs text/);
    expect(() => cli.write({ kind: "model", modelId: "gpt-5.4" }, () => sent++)).toThrowError(expect.objectContaining({ code: "policy_violation" }));
    cli.write({ kind: "model", modelId: "claude-haiku-4.5" }, () => sent++);
    expect(sent).toBe(3);
    expect(sessions().get(sessionId)!.model).toBe("claude-haiku-4.5");

    // Answers go through the actions ledger as the CLI, never straight to the runtime.
    const services = app.services as Record<string, unknown>;
    const original = services["actions"];
    const answers: Record<string, unknown>[] = [];
    let recorded = true;
    services["actions"] = {
      ...(original as object),
      onClientAnswer: async (input: Record<string, unknown>) => (answers.push(input), recorded ? { kind: "respond", response: { success: true, recorded: true } } : { kind: "forward" }),
    };
    try {
      await expect(cli.answer("session.permissions.handlePendingPermissionRequest", { requestId: "perm-1", result: { kind: "approved" } })).resolves.toEqual({ success: true, recorded: true });
      expect(answers[0]).toMatchObject({ sessionId, connectionId: "cli_one", responderKind: "cli", method: "session.permissions.handlePendingPermissionRequest", incarnation: cli.incarnation, generation: 0, requireRecorded: true });
      // An answer the ledger does not record fails closed instead of reaching the runtime.
      recorded = false;
      await expect(cli.answer("session.permissions.handlePendingPermissionRequest", { requestId: "perm-2", result: { kind: "approved" } })).rejects.toMatchObject({ code: "not_found" });
      await expect(cli.answer("session.tools.handlePendingToolCall", { requestId: "tool-1", result: "x" })).rejects.toMatchObject({ code: "invalid_request" });
    } finally {
      services["actions"] = original;
    }
    expect(runtime.calls("session.permissions.handlePendingPermissionRequest").filter((call) => ["perm-1", "perm-2"].includes(String(call.params["requestId"])))).toHaveLength(0);

    // A person answers ask_user from the CLI only when no connected app answers questions.
    cli.write({ kind: "userInput" }, () => sent++);
    expect(sent).toBe(4);
    const app2 = await connect();
    await app2.request("session.resume", { sessionId, requestPermission: true, requestUserInput: true });
    expect(() => cli.write({ kind: "userInput" }, () => sent++)).toThrowError(expect.objectContaining({ code: "conflict" }));
    await app2.close();
    await waitUntil(() => !sessions().attached(sessionId).some((responder) => responder.connectionId === app2.welcome.connectionId));

    // Closing detaches it; later writes are refused.
    cli.close();
    expect(sessions().attached(sessionId).map((responder) => responder.connectionId)).not.toContain("cli_one");
    expect(() => cli.write({ kind: "abort" }, () => sent++)).toThrowError(expect.objectContaining({ code: "conflict" }));

    // A CLI attached to an earlier incarnation of a reused ID writes nothing into the new session.
    const reused = await sessions().attachCli!(1001, sessionId, { connectionId: "cli_two", notify: () => undefined });
    await sessions().delete(1001, sessionId);
    await sessions().create(alice, { sessionId, environment: "chat" });
    expect(() => reused.write({ kind: "turn", text: "late" }, () => sent++)).toThrowError(expect.objectContaining({ code: "not_found" }));
    expect(sent).toBe(4);
  });

  it("keeps a registration another client made while a withdrawal was in flight", async () => {
    const first = await connect((method) => (method === "hooks.invoke" ? { output: {} } : {}));
    const sessionId = crypto.randomUUID();
    await first.request("session.create", { sessionId, hooks: true, requestPermission: true });
    // The handler withdraws its hooks, but its resume is still on its way when another client registers hooks.
    const hold = runtime.holdNext("session.resume", sessionId);
    const withdrawing = first.request("session.resume", { sessionId, requestPermission: true });
    await hold.held;
    const second = await connect((method) => (method === "hooks.invoke" ? { output: {} } : {}));
    const registering = second.request("session.resume", { sessionId, hooks: true, requestPermission: true });
    hold.release();
    await Promise.all([withdrawing, registering]);
    const stored = JSON.parse((gateway.gateway.app.db.prepare("SELECT admitted FROM core_sessions WHERE id = ?").get(sessionId) as { admitted: string }).admitted) as { callbacks: { flags: Record<string, boolean> } };
    expect(stored.callbacks.flags["hooks"]).toBe(true);
    // The second client's hooks stay required after it leaves.
    await second.close();
    await waitUntil(() => !sessions().attached(sessionId).some((responder) => responder.connectionId === second.welcome.connectionId));
    await expect(first.request("session.send", { sessionId, prompt: "unguarded?" })).rejects.toMatchObject({ data: { code: "background_callback_unsupported" } });
  });

  it("gives a runtime credential only to a client still connected when its verification finishes", async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, requestPermission: true });
    const registrationId = runtime.sessions.get(sessionId)!.createParams["gitHubTokenProviderRegistrationId"] as string;
    const auth = gateway.gateway.app.service("auth") as unknown as { authenticate: (token: string, options?: unknown) => Promise<Principal> };
    const original = auth.authenticate;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let verifying = false;
    auth.authenticate = async (token: string, options?: unknown) => {
      verifying = true;
      await gate;
      return original.call(auth, token, options);
    };
    try {
      const answer = runtime.requestOn(upstreamOf(sessionId), "gitHubToken.getToken", { registrationId, sessionId, host: "https://github.com", reason: "refresh" });
      await waitUntil(() => verifying);
      await client.close();
      await waitUntil(() => sessions().attached(sessionId).length === 0);
      release();
      await expect(answer).resolves.toEqual({ kind: "cancelled" });
    } finally {
      delete (auth as { authenticate?: unknown }).authenticate;
    }
  });

  it("finishes interrupted deletions, discards interrupted creates, and tells incarnations of one ID apart", async () => {
    const events: PlatformEvent[] = [];
    const off = gateway.gateway.app.service("events").subscribe((event) => events.push(event));
    const db = gateway.gateway.app.db;
    try {
      const reused = crypto.randomUUID();
      await sessions().create(alice, { sessionId: reused, environment: "chat" });
      const first = sessions().get(reused)!.incarnation;
      await sessions().delete(1001, reused);
      await sessions().create(alice, { sessionId: reused, environment: "chat" });
      expect(sessions().get(reused)!.incarnation).not.toBe(first);
      expect(events.find((event) => event.type === "session.deleted" && event.sessionId === reused)?.data).toMatchObject({ incarnation: first });

      // A deletion the gateway stopped in the middle of: the next request finishes it instead of a permanent 409.
      const stuck = crypto.randomUUID();
      await sessions().create(alice, { sessionId: stuck, environment: "chat" });
      db.prepare("UPDATE core_sessions SET state = 'deleting' WHERE id = ?").run(stuck);
      await sessions().delete(1001, stuck);
      expect(sessions().get(stuck)).toBeUndefined();

      // Startup recovery finishes deletions and discards creates that never completed.
      const deleting = crypto.randomUUID();
      const creating = crypto.randomUUID();
      await sessions().create(alice, { sessionId: deleting, environment: "chat" });
      await sessions().create(alice, { sessionId: creating, environment: "chat" });
      const interrupted = sessions().get(deleting)!.incarnation;
      db.prepare("UPDATE core_sessions SET state = 'deleting' WHERE id = ?").run(deleting);
      db.prepare("UPDATE core_sessions SET state = 'creating' WHERE id = ?").run(creating);
      await sessions().recover();
      expect(sessions().get(deleting)).toBeUndefined();
      expect(sessions().get(creating)).toBeUndefined();
      expect(runtime.calls("session.delete").some((call) => call.params["sessionId"] === deleting)).toBe(true);
      expect(events.find((event) => event.type === "session.deleted" && event.sessionId === deleting)?.data).toMatchObject({ incarnation: interrupted });

      // A schedule retrying its deterministic ID after an interrupted create gets a session, not `created: false`.
      const retried = crypto.randomUUID();
      await sessions().create(alice, { sessionId: retried, environment: "chat" });
      const stale = sessions().get(retried)!.incarnation;
      db.prepare("UPDATE core_sessions SET state = 'creating' WHERE id = ?").run(retried);
      await expect(sessions().create(alice, { sessionId: retried, environment: "chat" })).resolves.toMatchObject({ sessionId: retried, created: true });
      expect(sessions().get(retried)).toMatchObject({ state: "ready" });
      expect(sessions().get(retried)!.incarnation).not.toBe(stale);

      // Recovery works from a snapshot: a session deleted or created again meanwhile is never touched.
      const slow = crypto.randomUUID();
      const deletedMeanwhile = crypto.randomUUID();
      const createdMeanwhile = crypto.randomUUID();
      for (const id of [slow, deletedMeanwhile, createdMeanwhile]) await sessions().create(alice, { sessionId: id, environment: "chat" });
      db.prepare("UPDATE core_sessions SET state = 'deleting' WHERE id IN (?, ?)").run(slow, deletedMeanwhile);
      db.prepare("UPDATE core_sessions SET state = 'creating' WHERE id = ?").run(createdMeanwhile);
      const hold = runtime.holdNext("session.delete", slow);
      const recovering = sessions().recover();
      await hold.held;
      await sessions().delete(1001, deletedMeanwhile);
      await sessions().create(alice, { sessionId: deletedMeanwhile, environment: "chat" });
      await sessions().create(alice, { sessionId: createdMeanwhile, environment: "chat" });
      const fresh = [sessions().get(deletedMeanwhile)!.incarnation, sessions().get(createdMeanwhile)!.incarnation];
      const deletesBefore = runtime.calls("session.delete").length;
      hold.release();
      await recovering;
      expect(sessions().get(slow)).toBeUndefined();
      expect([sessions().get(deletedMeanwhile)?.incarnation, sessions().get(createdMeanwhile)?.incarnation]).toEqual(fresh);
      expect(sessions().get(deletedMeanwhile)!.state).toBe("ready");
      expect(runtime.calls("session.delete").slice(deletesBefore).map((call) => call.params["sessionId"])).not.toContain(deletedMeanwhile);
    } finally {
      off();
    }
  });

  it("hides a create the gateway never finished, and lets a client create the same ID afresh", async () => {
    const sessionId = crypto.randomUUID();
    await sessions().create(alice, { sessionId, environment: "chat" });
    const stale = sessions().get(sessionId)!.incarnation;
    gateway.gateway.app.db.prepare("UPDATE core_sessions SET state = 'creating' WHERE id = ?").run(sessionId);
    // It never existed for its owner: not found, not listed, not resumable.
    expect(sessions().get(sessionId)).toBeUndefined();
    expect(sessions().list(1001).map((record) => record.id)).not.toContain(sessionId);
    const client = await connect();
    await expect(client.request("session.resume", { sessionId, requestPermission: true })).rejects.toMatchObject({ data: { code: "not_found" } });
    await client.request("session.create", { sessionId, requestPermission: true });
    expect(sessions().get(sessionId)).toMatchObject({ state: "ready" });
    expect(sessions().get(sessionId)!.incarnation).not.toBe(stale);
  });

  it("fences service calls to the session incarnation they are for", async () => {
    const sessionId = crypto.randomUUID();
    const created = await sessions().create(alice, { sessionId, environment: "chat" });
    expect(created).toEqual({ sessionId, created: true, incarnation: sessions().get(sessionId)!.incarnation });
    await expect(sessions().create(alice, { sessionId, environment: "chat" })).resolves.toEqual({ sessionId, created: false, incarnation: created.incarnation });
    await sessions().send(alice, sessionId, { prompt: "for this incarnation" }, { incarnation: created.incarnation });
    await sessions().delete(1001, sessionId);
    await sessions().create(alice, { sessionId, environment: "chat" });
    const sends = runtime.calls("session.send").length;
    await expect(sessions().send(alice, sessionId, { prompt: "meant for the deleted session" }, { incarnation: created.incarnation })).rejects.toMatchObject({ code: "not_found" });
    await expect(sessions().request(sessionId, "session.send", { prompt: "also meant for it" }, { incarnation: created.incarnation })).rejects.toMatchObject({ code: "not_found" });
    expect(runtime.calls("session.send").length).toBe(sends);
  });

  it("reports one incarnation's details, never those of a session that reused its ID meanwhile", async () => {
    const services = gateway.gateway.app.services as Record<string, unknown>;
    const originalSandboxes = services["sandboxes"];
    const fake = new FakeSandboxes(runtime);
    services["sandboxes"] = fake;
    const listed: Record<string, unknown>[] = [];
    const restoreActions = override("actions", { list: (id: string, options: Record<string, unknown>) => (listed.push({ id, ...options }), []) });
    try {
      const sessionId = crypto.randomUUID();
      await sessions().create(alice, { sessionId, environment: "coder" });
      const first = sessions().get(sessionId)!.incarnation;
      await expect(sessions().info(1001, sessionId)).resolves.toMatchObject({ id: sessionId, pendingActions: [] });
      expect(listed.at(-1)).toEqual({ id: sessionId, open: true, incarnation: first });

      // The ID is deleted and another account creates it while the owner's read waits for its sandbox details.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let reading = false;
      (fake as unknown as { get: () => Promise<undefined> }).get = async () => {
        reading = true;
        await gate;
        return undefined;
      };
      const info = sessions().info(1001, sessionId);
      await waitUntil(() => reading);
      await sessions().delete(1001, sessionId);
      const bob = await gateway.gateway.app.service("auth").authenticate(BOB, { background: true });
      await sessions().create(bob, { sessionId, environment: "coder" });
      const listedBefore = listed.length;
      release();
      await expect(info).rejects.toMatchObject({ code: "not_found" });
      expect(listed.slice(listedBefore)).toEqual([]);
    } finally {
      services["sandboxes"] = originalSandboxes;
      restoreActions();
    }
  });

  it("keeps a model selection over an earlier option change's model when the session is restored", async () => {
    const client = await connect(undefined, "open");
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, requestPermission: true });
    const updates = () => runtime.calls("session.options.update").filter((call) => call.params["sessionId"] === sessionId);
    const restore = async () => {
      const done = stopped(sessionId);
      runtime.dropConnections();
      await done();
      const before = updates().length;
      await sessions().request(sessionId, "session.getMessages", {});
      return { model: lastResume(sessionId)!["model"], patched: updates().slice(before).map((call) => call.params["model"]) };
    };

    // From an attached Copilot CLI.
    await client.request("session.options.update", { sessionId, model: "gpt-5.4" });
    const cli = await sessions().attachCli!(1001, sessionId, { connectionId: `cli_${sessionId}`, notify: () => undefined });
    cli.write({ kind: "model", modelId: "claude-haiku-4.5" }, () => undefined);
    cli.close();
    let restored = await restore();
    expect(restored.model).toBe("claude-haiku-4.5");
    expect(restored.patched).not.toContain("gpt-5.4");

    // From an SDK client.
    await client.request("session.options.update", { sessionId, model: "gpt-5.4" });
    await client.request("session.model.switchTo", { sessionId, modelId: "claude-haiku-4.5" });
    restored = await restore();
    expect(restored.model).toBe("claude-haiku-4.5");
    expect(restored.patched).not.toContain("gpt-5.4");
    expect(sessions().get(sessionId)!.model).toBe("claude-haiku-4.5");

    // A client that resumes without a model keeps the session's (like its agent).
    const other = await connect(undefined, "open");
    await other.request("session.resume", { sessionId, requestPermission: true });
    restored = await restore();
    expect(restored.model).toBe("claude-haiku-4.5");
  });

  it("never leaves a client attached after it disconnected during its resume", async () => {
    const first = await connect((method) => (method === "hooks.invoke" ? { output: {} } : {}));
    const sessionId = crypto.randomUUID();
    await first.request("session.create", { sessionId, hooks: true, requestPermission: true });
    // Its re-registration fails upstream after it disconnected: it is not attached again.
    runtime.failNext("session.resume", sessionId);
    const hold = runtime.holdNext("session.resume", sessionId);
    const resuming = first.request("session.resume", { sessionId, hooks: true, requestPermission: true }).catch(() => undefined);
    await hold.held;
    await first.close();
    await waitUntil(() => !sessions().attached(sessionId).some((responder) => responder.connectionId === first.welcome.connectionId));
    hold.release();
    await resuming;
    await sleep(100);
    expect(sessions().attached(sessionId).map((responder) => responder.connectionId)).not.toContain(first.welcome.connectionId);
    // So a client that takes the hooks over can withdraw them, and turns run again.
    const takeover = await connect((method) => (method === "hooks.invoke" ? { output: {} } : {}));
    await takeover.request("session.resume", { sessionId, hooks: true, requestPermission: true });
    await takeover.request("session.resume", { sessionId, requestPermission: true });
    await expect(takeover.request("session.send", { sessionId, prompt: "after the takeover" })).resolves.toMatchObject({ messageId: expect.any(String) });
  });

  it("leaves a client's registration as it was when a tools update fails, so a retry withdraws the tool", async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, tools: [{ name: "lookup_order" }], requestPermission: true });
    runtime.failNext("session.tools.set", sessionId);
    await expect(client.request("session.tools.set", { sessionId, tools: [] })).rejects.toBeDefined();
    expect(storedCallbacks(sessionId).tools.map((tool) => tool.name)).toEqual(["lookup_order"]);
    await client.request("session.tools.set", { sessionId, tools: [] });
    expect(storedCallbacks(sessionId).tools).toEqual([]);
    const sent = runtime.calls("session.tools.set").filter((call) => call.params["sessionId"] === sessionId).at(-1)!.params["tools"] as { name: string }[];
    expect(sent.map((tool) => tool.name)).not.toContain("lookup_order");
  });

  it("runs a session's registration changes one at a time, each from the last one committed", async () => {
    const first = await connect();
    const sessionId = crypto.randomUUID();
    await first.request("session.create", { sessionId, tools: [{ name: "lookup_order" }], requestPermission: true });
    // The first client withdraws its tool; while that is on its way, another client registers its own.
    const hold = runtime.holdNext("session.tools.set", sessionId);
    const withdrawing = first.request("session.tools.set", { sessionId, tools: [] });
    await hold.held;
    const resumes = () => runtime.calls("session.resume").filter((call) => call.params["sessionId"] === sessionId).length;
    const before = resumes();
    const second = await connect();
    const joining = second.request("session.resume", { sessionId, tools: [{ name: "ship_order" }], requestPermission: true });
    await sleep(50);
    expect(resumes()).toBe(before);
    hold.release();
    await withdrawing;
    await joining;
    const names = (lastResume(sessionId)!["tools"] as { name: string }[]).map((tool) => tool.name);
    expect(names).toContain("ship_order");
    expect(names).not.toContain("lookup_order");
    expect(storedCallbacks(sessionId).tools.map((tool) => tool.name)).toEqual(["ship_order"]);
  });

  it("keeps a session's hooks on the runtime when their withdrawal fails while another client resumes", async () => {
    const guard = await connect((method) => (method === "hooks.invoke" ? { output: { permissionDecision: "deny", permissionDecisionReason: "guarded" } } : {}));
    const sessionId = crypto.randomUUID();
    await guard.request("session.create", { sessionId, hooks: true, requestPermission: true });
    const resumes = () => runtime.calls("session.resume").filter((call) => call.params["sessionId"] === sessionId);
    const before = resumes().length;
    // The guard's withdrawal fails at the runtime; another client resumes meanwhile.
    runtime.failNext("session.resume", sessionId);
    const hold = runtime.holdNext("session.resume", sessionId);
    const withdrawing = guard.request("session.resume", { sessionId, requestPermission: true });
    withdrawing.catch(() => undefined);
    await hold.held;
    const other = await connect();
    const joining = other.request("session.resume", { sessionId, requestPermission: true });
    await sleep(50);
    expect(resumes().length).toBe(before + 1);
    hold.release();
    await expect(withdrawing).rejects.toBeDefined();
    await joining;
    // Everything sent after the failed withdrawal keeps the hooks the session still has, and the guard still answers.
    const after = resumes().slice(before + 1);
    expect(after.length).toBeGreaterThan(0);
    for (const call of after) expect(call.params).toMatchObject({ hooks: true });
    await expect(invokeHook(sessionId, "preToolUse")).resolves.toEqual({ output: { permissionDecision: "deny", permissionDecisionReason: "guarded" } });
  });

  it("rolls a failed tools update back to the registration in effect, even with another update behind it", async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, tools: [{ name: "original" }], requestPermission: true });
    runtime.failNext("session.tools.set", sessionId);
    const hold = runtime.holdNext("session.tools.set", sessionId);
    const first = client.request("session.tools.set", { sessionId, tools: [{ name: "failed_first" }] });
    first.catch(() => undefined);
    await hold.held;
    runtime.failNext("session.tools.set", sessionId);
    const second = client.request("session.tools.set", { sessionId, tools: [{ name: "failed_second" }] });
    second.catch(() => undefined);
    hold.release();
    await expect(first).rejects.toBeDefined();
    await expect(second).rejects.toBeDefined();
    // Another client's resume carries what the first client last registered successfully.
    const other = await connect();
    await other.request("session.resume", { sessionId, requestPermission: true });
    const names = (lastResume(sessionId)!["tools"] as { name: string }[]).map((tool) => tool.name);
    expect(names).toContain("original");
    expect(names).not.toContain("failed_first");
    expect(names).not.toContain("failed_second");
  });

  it("gives no token for a background sign-in that ends while it is being checked", async () => {
    const client = await connect();
    const sessionId = crypto.randomUUID();
    await client.request("session.create", { sessionId, requestPermission: true });
    const registrationId = runtime.sessions.get(sessionId)!.createParams["gitHubTokenProviderRegistrationId"] as string;
    await client.close();
    await waitUntil(() => sessions().attached(sessionId).length === 0);
    const credentials = gateway.gateway.app.service("credentials");
    credentials.store(alice);
    const auth = gateway.gateway.app.service("auth") as unknown as { authenticate: (token: string, options?: { background?: boolean }) => Promise<Principal> };
    const original = auth.authenticate;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let checking = false;
    auth.authenticate = async (token: string, options?: { background?: boolean }) => {
      if (options?.background) {
        checking = true;
        await gate;
      }
      return original.call(auth, token, options);
    };
    try {
      const answer = runtime.requestOn(upstreamOf(sessionId), "gitHubToken.getToken", { registrationId, sessionId, host: "https://github.com", reason: "refresh" });
      await waitUntil(() => checking);
      credentials.revoke(alice);
      release();
      await expect(answer).resolves.toEqual({ kind: "cancelled" });
    } finally {
      delete (auth as { authenticate?: unknown }).authenticate;
    }
  });

  it("lets clients withdraw a registration they share in either order, even concurrently", async () => {
    const a = await connect();
    const sessionId = crypto.randomUUID();
    await a.request("session.create", { sessionId, tools: [{ name: "lookup_order" }], requestPermission: true, requestUserInput: true });
    const b = await connect();
    await b.request("session.resume", { sessionId, tools: [{ name: "lookup_order" }], requestPermission: true, requestUserInput: true });
    // B, whose registration is in effect, withdraws; A withdraws while that is on its way.
    const hold = runtime.holdNext("session.resume", sessionId);
    const first = b.request("session.resume", { sessionId, tools: [], requestPermission: true });
    await hold.held;
    const second = a.request("session.resume", { sessionId, tools: [], requestPermission: true });
    hold.release();
    await Promise.all([first, second]);
    const stored = storedCallbacks(sessionId);
    expect(stored.tools.map((tool) => tool.name)).not.toContain("lookup_order");
    expect(stored.flags["requestUserInput"]).toBeUndefined();
    expect(lastResume(sessionId)).toMatchObject({ requestUserInput: false });
  });

  it("lets the last client that registered a tool or handler withdraw it", async () => {
    const a = await connect();
    const sessionId = crypto.randomUUID();
    await a.request("session.create", { sessionId, tools: [{ name: "lookup_order" }], requestPermission: true, requestUserInput: true });
    const b = await connect();
    await b.request("session.resume", { sessionId, tools: [{ name: "lookup_order" }], requestPermission: true, requestUserInput: true });
    // B withdraws first, while A still registers both; then A withdraws.
    await b.request("session.resume", { sessionId, tools: [], requestPermission: true });
    await a.request("session.resume", { sessionId, tools: [], requestPermission: true });
    const stored = storedCallbacks(sessionId);
    expect(stored.tools.map((tool) => tool.name)).not.toContain("lookup_order");
    expect(stored.flags["requestUserInput"]).toBeUndefined();
    const resumed = lastResume(sessionId)!;
    expect((resumed["tools"] as { name: string }[]).map((tool) => tool.name)).not.toContain("lookup_order");
    expect(resumed).toMatchObject({ requestUserInput: false });
  });

  it("lets two clients that registered the same tool withdraw it concurrently", async () => {
    const b = await connect();
    const sessionId = crypto.randomUUID();
    await b.request("session.create", { sessionId, tools: [{ name: "lookup_order" }], requestPermission: true });
    const a = await connect();
    await a.request("session.resume", { sessionId, tools: [{ name: "lookup_order" }], requestPermission: true });
    // A's withdrawal (which hands its registration to B) is still on its way when B withdraws too.
    const hold = runtime.holdNext("session.tools.set", sessionId);
    const first = a.request("session.tools.set", { sessionId, tools: [] });
    await hold.held;
    const second = b.request("session.tools.set", { sessionId, tools: [] });
    hold.release();
    await Promise.all([first, second]);
    expect(storedCallbacks(sessionId).tools.map((tool) => tool.name)).not.toContain("lookup_order");
    const sent = runtime.calls("session.tools.set").filter((call) => call.params["sessionId"] === sessionId).at(-1)!.params["tools"] as { name: string }[];
    expect(sent.map((tool) => tool.name)).not.toContain("lookup_order");
  });
});
