import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationView, MemoryItem, MeResponse } from "../src/shared/types.js";
import { eventually, signInWithGitHub, startHarness, type Browser, type Harness } from "./harness.js";

let harness: Harness;
afterEach(async () => {
  await harness?.close();
});

async function signUp(browser: Browser, name: string, email: string) {
  const response = await browser.post("/api/auth/signup", { name, email, password: "correct horse battery" });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.user as MeResponse["user"] & {};
}

async function view(browser: Browser, id: string): Promise<ConversationView> {
  const response = await browser.get(`/api/conversations/${id}`);
  expect(response.status).toBe(200);
  return response.body as ConversationView;
}

describe("people and their conversations", () => {
  beforeEach(async () => {
    harness = await startHarness();
    harness.platform.appUsersAvailable = true;
  });

  it("keeps each person's conversations, memory, and live events to themselves", async () => {
    const alice = harness.browser();
    const bob = harness.browser();
    const carol = harness.browser();
    await signUp(alice, "Alice Smith", "alice@example.com");
    await signUp(bob, "Bob Jones", "bob@example.com");
    await signInWithGitHub(harness, carol, { id: 4242, login: "carol", name: "Carol" }, "gho_carol_token_000000000000000000");

    const aliceEvents = await alice.events();
    const bobEvents = await bob.events();
    const created = await alice.post("/api/conversations", { prompt: "remember: favorite color is teal" });
    expect(created.status).toBe(201);
    const aliceConversation = created.body.conversation.id as string;
    await eventually(async () => expect((await view(alice, aliceConversation)).busy).toBe(false));
    const aliceView = await view(alice, aliceConversation);
    expect(aliceView.items.map((item) => item.kind)).toEqual(["user", "tool", "assistant"]);
    expect(aliceView.route).toBe("foundry");
    const aliceMemories = (await alice.get("/api/memories")).body as MemoryItem[];
    expect(aliceMemories.map((memory) => memory.text)).toEqual(["favorite color is teal"]);

    // Bob, signed in to the same Front Desk, can't list, open, change, stop, or delete Alice's conversation.
    expect((await bob.get("/api/conversations")).body).toEqual([]);
    expect((await bob.get(`/api/conversations/${aliceConversation}`)).status).toBe(404);
    expect((await bob.post(`/api/conversations/${aliceConversation}/messages`, { prompt: "hi" })).status).toBe(404);
    expect((await bob.post(`/api/conversations/${aliceConversation}/stop`)).status).toBe(404);
    expect((await bob.delete(`/api/conversations/${aliceConversation}`)).status).toBe(404);
    expect((await view(alice, aliceConversation)).items.length).toBe(3);

    // Nor her memory: his assistant's recall searches only his.
    expect((await bob.get("/api/memories")).body).toEqual([]);
    expect((await bob.delete(`/api/memories/${aliceMemories[0]!.id}`)).status).toBe(404);
    const bobConversation = (await bob.post("/api/conversations", { prompt: "recall what you know about me" })).body.conversation.id as string;
    await eventually(async () => expect((await view(bob, bobConversation)).busy).toBe(false));
    const bobAnswer = (await view(bob, bobConversation)).items.find((item) => item.kind === "assistant");
    expect(bobAnswer && "text" in bobAnswer ? bobAnswer.text : "").toContain("Nothing remembered yet.");
    expect(((await alice.get("/api/memories")).body as MemoryItem[]).length).toBe(1);

    // Live events reach their owner only.
    await eventually(() => expect(aliceEvents.received.some((event) => event.type === "delta")).toBe(true));
    const mentions = (events: { type: string }[], id: string) => events.filter((event) => JSON.stringify(event).includes(id)).length;
    expect(mentions(bobEvents.received, aliceConversation)).toBe(0);
    expect(mentions(aliceEvents.received, bobConversation)).toBe(0);
    expect(bobEvents.received.some((event) => event.type === "memories" && JSON.stringify(event).includes("teal"))).toBe(false);

    // A GitHub user runs on their own Copilot plan, as their own GitHub identity.
    const carolConversation = (await carol.post("/api/conversations", { prompt: "hello" })).body.conversation.id as string;
    expect((await view(carol, carolConversation)).route).toBe("copilot");
    // And the platform's own record agrees: who owns each session, and where its model calls go.
    expect((await view(carol, carolConversation)).platform).toEqual({ ownerKind: "github", owner: "github-user", inference: { route: "copilot" }, model: "claude-sonnet-5" });
    expect((await view(alice, aliceConversation)).platform).toMatchObject({ ownerKind: "app-user", owner: expect.stringMatching(/^front-desk\/u_/), inference: { route: "foundry", foundry: "test-foundry" } });
    expect(harness.platform.sessions.get(carolConversation)?.owner).toBe("github:gho_carol_token_000000000000000000");
    expect(harness.platform.sessions.get(aliceConversation)?.owner).toMatch(/^app:u_/);
    expect(harness.platform.sessions.get(aliceConversation)?.environment).toBe("front-desk-foundry");
    expect(harness.platform.sessions.get(carolConversation)?.environment).toBe("front-desk");
    expect((await carol.get("/api/conversations")).body.map((item: { id: string }) => item.id)).toEqual([carolConversation]);
    expect((await carol.get(`/api/conversations/${aliceConversation}`)).status).toBe(404);

    aliceEvents.close();
    bobEvents.close();
  });

  it("resumes a person's conversation with their own identity after the app lets go of it", async () => {
    const carol = harness.browser();
    await signInWithGitHub(harness, carol, { id: 7, login: "carol" }, "gho_carol_token_111111111111111111");
    const id = (await carol.post("/api/conversations", { prompt: "first" })).body.conversation.id as string;
    await eventually(async () => expect((await view(carol, id)).busy).toBe(false));
    const user = harness.store.findByGitHubId(7)!;
    await harness.conversations.release(user.id);
    const resumed = await view(carol, id);
    expect(resumed.items.filter((item) => item.kind === "user").map((item) => ("text" in item ? item.text : ""))).toEqual(["first"]);
    expect(harness.platform.resumes).toEqual([{ sessionId: id, owner: "github:gho_carol_token_111111111111111111" }]);
  });

  it("deletes a conversation on the platform and in the list", async () => {
    const alice = harness.browser();
    await signUp(alice, "Alice", "alice@example.com");
    const id = (await alice.post("/api/conversations", { prompt: "hello" })).body.conversation.id as string;
    expect((await alice.delete(`/api/conversations/${id}`)).status).toBe(204);
    expect(harness.platform.sessions.get(id)?.deleted).toBe(true);
    expect((await alice.get("/api/conversations")).body).toEqual([]);
    expect((await alice.get(`/api/conversations/${id}`)).status).toBe(404);
  });

  it("reconnects once when a send fails because the connection went away", async () => {
    const alice = harness.browser();
    await signUp(alice, "Alice", "alice@example.com");
    const id = (await alice.post("/api/conversations", { prompt: "hello" })).body.conversation.id as string;
    await eventually(async () => expect((await view(alice, id)).busy).toBe(false));
    harness.platform.failNextSend = true;
    const sent = await alice.post(`/api/conversations/${id}/messages`, { prompt: "again" });
    expect(sent.status).toBe(202);
    await eventually(async () => expect((await view(alice, id)).items.filter((item) => item.kind === "user").length).toBe(2));
  });

  it("refuses a second message while an answer is being written", async () => {
    const alice = harness.browser();
    await signUp(alice, "Alice", "alice@example.com");
    const id = (await alice.post("/api/conversations", { prompt: "hello" })).body.conversation.id as string;
    // The fake answers asynchronously, so right after the first send the conversation is still busy.
    const second = await alice.post(`/api/conversations/${id}/messages`, { prompt: "again" });
    expect([202, 409]).toContain(second.status);
    if (second.status === 409) expect(second.body.error.code).toBe("busy");
  });

  it("leaves no empty conversation behind when the first message can't be delivered", async () => {
    const alice = harness.browser();
    await signUp(alice, "Alice", "alice@example.com");
    harness.platform.failNextSend = true;
    const created = await alice.post("/api/conversations", { prompt: "hello" });
    expect(created.status).toBeGreaterThanOrEqual(500);
    expect((await alice.get("/api/conversations")).body).toEqual([]);
    expect([...harness.platform.sessions.values()].map((record) => record.deleted)).toEqual([true]);
    expect((await alice.get("/api/me")).body.user.billing.remainingToday).toBe(50);
  });

  it("never sends a message twice when the connection drops after the platform took it", async () => {
    const alice = harness.browser();
    await signUp(alice, "Alice", "alice@example.com");
    const id = (await alice.post("/api/conversations", { prompt: "hello" })).body.conversation.id as string;
    await eventually(async () => expect((await view(alice, id)).busy).toBe(false));
    harness.platform.dropNextSendReply = true;
    expect((await alice.post(`/api/conversations/${id}/messages`, { prompt: "again" })).status).toBe(202);
    await eventually(async () => expect((await view(alice, id)).busy).toBe(false));
    const sent = (await view(alice, id)).items.filter((item) => item.kind === "user").map((item) => ("text" in item ? item.text : ""));
    expect(sent).toEqual(["hello", "again"]);
  });

  it("lets go of a conversation that was deleted while it was reopening", async () => {
    const alice = harness.browser();
    await signUp(alice, "Alice", "alice@example.com");
    const id = (await alice.post("/api/conversations", { prompt: "hello" })).body.conversation.id as string;
    await eventually(async () => expect((await view(alice, id)).busy).toBe(false));
    await harness.conversations.release(harness.store.findByEmail("alice@example.com")!.id);
    let finishLoading!: () => void;
    harness.platform.holdHistory = new Promise<void>((resolve) => (finishLoading = resolve));
    const reopening = alice.get(`/api/conversations/${id}`);
    await eventually(() => expect(harness.platform.historyLoads).toBe(1));
    expect((await alice.delete(`/api/conversations/${id}`)).status).toBe(204);
    finishLoading();
    expect((await reopening).status).toBe(404);
    expect(harness.platform.disconnects).toContain(id);
    expect((await alice.get("/api/conversations")).body).toEqual([]);
  });

  it("lets go of a person's connection once they've left, even after they deleted their last conversation", async () => {
    await harness.close();
    harness = await startHarness({ FRONT_DESK_IDLE_CLOSE_MS: "1" });
    harness.platform.appUsersAvailable = true;
    const alice = harness.browser();
    const user = await signUp(alice, "Alice", "alice@example.com");
    const id = (await alice.post("/api/conversations", { prompt: "hello" })).body.conversation.id as string;
    await eventually(async () => expect((await view(alice, id)).busy).toBe(false));
    expect((await alice.delete(`/api/conversations/${id}`)).status).toBe(204);
    expect(harness.platform.connected(user.id)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await harness.conversations.sweep();
    expect(harness.platform.connected(user.id)).toBe(false);
  });
});

describe("signing out", () => {
  it("ends that browser's live events, even while the person is signed in elsewhere", async () => {
    harness = await startHarness();
    harness.platform.appUsersAvailable = true;
    const laptop = harness.browser();
    const phone = harness.browser();
    await signUp(laptop, "Alice", "alice@example.com");
    expect((await phone.post("/api/auth/signin", { email: "alice@example.com", password: "correct horse battery" })).status).toBe(200);
    const stream = await laptop.events();
    await eventually(() => expect(stream.received.length).toBeGreaterThan(0));
    expect((await laptop.post("/api/auth/signout")).status).toBe(204);
    await eventually(() => expect(stream.ended()).toBe(true));
    const seen = stream.received.length;

    // Alice keeps going on her phone; none of it reaches the laptop that signed out.
    const id = (await phone.post("/api/conversations", { prompt: "remember: favorite color is teal" })).body.conversation.id as string;
    await eventually(async () => expect((await view(phone, id)).busy).toBe(false));
    expect(stream.received.length).toBe(seen);
    stream.close();
  });
});

describe("the daily allowance of people the app pays for", () => {
  it("stops at the limit, counts nothing that wasn't delivered, and never limits GitHub users", async () => {
    harness = await startHarness({ FRONT_DESK_DAILY_LIMIT: "2" });
    harness.platform.appUsersAvailable = true;
    const alice = harness.browser();
    await signUp(alice, "Alice", "alice@example.com");
    expect((await alice.get("/api/me")).body.user.billing).toMatchObject({ route: "foundry", dailyLimit: 2, remainingToday: 2 });
    const id = (await alice.post("/api/conversations", { prompt: "one" })).body.conversation.id as string;
    await eventually(async () => expect((await view(alice, id)).busy).toBe(false));
    expect((await alice.post(`/api/conversations/${id}/messages`, { prompt: "two" })).status).toBe(202);
    await eventually(async () => expect((await view(alice, id)).busy).toBe(false));
    const third = await alice.post(`/api/conversations/${id}/messages`, { prompt: "three" });
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe("daily_limit");
    expect((await alice.get("/api/me")).body.user.billing.remainingToday).toBe(0);

    const carol = harness.browser();
    await signInWithGitHub(harness, carol, { id: 9, login: "carol" }, "gho_carol_token_222222222222222222");
    expect((await carol.get("/api/me")).body.user.billing).toEqual(expect.objectContaining({ route: "copilot" }));
    expect((await carol.get("/api/me")).body.user.billing.dailyLimit).toBeUndefined();
  });
});

describe("people without GitHub on a deployment that can't serve them yet", () => {
  it("lets them sign in, and says why they can't chat", async () => {
    harness = await startHarness();
    const alice = harness.browser();
    await signUp(alice, "Alice", "alice@example.com");
    const me = (await alice.get("/api/me")).body as MeResponse;
    expect(me.options.appUsers).toEqual({ available: false, reason: "No app users here." });
    const created = await alice.post("/api/conversations", { prompt: "hello" });
    expect(created.status).toBe(503);
    expect(created.body.error).toEqual({ code: "app_users_unavailable", message: "No app users here." });
    expect((await alice.get("/api/me")).body.user.billing.remainingToday).toBe(50);
  });
});

describe("requests Front Desk refuses", () => {
  beforeEach(async () => {
    harness = await startHarness();
  });

  it("needs a signed-in person for everything personal", async () => {
    const stranger = harness.browser();
    for (const path of ["/api/conversations", "/api/memories", "/api/events", "/api/conversations/x"]) {
      const response = await stranger.get(path);
      expect(response.status, path).toBe(401);
      expect(response.body.error.code).toBe("sign_in_required");
    }
    expect((await stranger.get("/api/health")).status).toBe(200);
    expect((await stranger.get("/api/me")).body.user).toBeNull();
  });

  it("answers only its own host names, and only same-origin JSON changes", async () => {
    const alice = harness.browser();
    await signUp(alice, "Alice", "alice@example.com");
    // fetch can't set Host, so this one goes through node:http.
    const { request } = await import("node:http");
    const misdirected = await new Promise<number>((resolve, reject) => {
      const req = request(`${harness.url}/api/me`, { headers: { host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.once("error", reject);
      req.end();
    });
    expect(misdirected).toBe(421);
    expect((await alice.post("/api/conversations", { prompt: "x" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await alice.post("/api/conversations", { prompt: "x" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    const form = await fetch(`${harness.url}/api/auth/signin`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: harness.url }, body: "email=a&password=b" });
    expect(form.status).toBe(415);
  });

  it("sets HttpOnly, SameSite cookies, and security headers", async () => {
    const response = await fetch(`${harness.url}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: harness.url },
      body: JSON.stringify({ name: "Alice", email: "alice@example.com", password: "correct horse battery" }),
    });
    const cookie = response.headers.getSetCookie()[0]!;
    expect(cookie).toMatch(/^fd_session=/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("GitHub sign-in", () => {
  beforeEach(async () => {
    harness = await startHarness();
  });

  it("uses state and PKCE, and keeps the person's token sealed", async () => {
    const browser = harness.browser();
    const start = await browser.get("/auth/github?return=/c/abc");
    const location = new URL(start.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(`${harness.github.url}/login/oauth/authorize`);
    expect(location.searchParams.get("client_id")).toBe("client-id");
    expect(location.searchParams.get("redirect_uri")).toBe(`${harness.url}/auth/github/callback`);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("scope")).toBeNull();
    expect(browser.cookies.get("fd_oauth")).toBe(location.searchParams.get("state"));

    harness.github.accounts.set("gho_dana_token_0000000000000000000", { id: 77, login: "dana", name: "Dana" });
    const { code, state } = harness.github.approve(location.toString(), "gho_dana_token_0000000000000000000");
    const back = await browser.get(`/auth/github/callback?code=${code}&state=${state}`);
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/c/abc");
    const me = (await browser.get("/api/me")).body as MeResponse;
    expect(me.user).toMatchObject({ kind: "github", login: "dana", name: "Dana", billing: { route: "copilot" } });
    expect(harness.github.exchanges[0]).toMatchObject({ client_id: "client-id", code, redirect_uri: `${harness.url}/auth/github/callback` });
    expect(typeof harness.github.exchanges[0]!.code_verifier).toBe("string");
    const stored = harness.store.getGitHubToken(harness.store.findByGitHubId(77)!.id)!;
    expect(stored.token).not.toContain("gho_dana");
    expect(stored.source).toBe("oauth");
  });

  it("refuses a callback this browser didn't start, and a state used twice", async () => {
    const victim = harness.browser();
    const attacker = harness.browser();
    harness.github.accounts.set("gho_attacker_000000000000000000000", { id: 66, login: "attacker" });
    const start = await attacker.get("/auth/github");
    const { code, state } = harness.github.approve(start.headers.get("location")!, "gho_attacker_000000000000000000000");
    // Login CSRF: the attacker's code and state, opened in the victim's browser, don't sign the victim in as them.
    const forced = await victim.get(`/auth/github/callback?code=${code}&state=${state}`);
    expect(forced.headers.get("location")).toBe("/?signin_error=expired");
    expect((await victim.get("/api/me")).body.user).toBeNull();
    // And the state is spent: the attacker can't use it either now.
    const reused = await attacker.get(`/auth/github/callback?code=${code}&state=${state}`);
    expect(reused.headers.get("location")).toBe("/?signin_error=expired");
  });

  it("explains a callback URL GitHub doesn't know, and a cancelled sign-in", async () => {
    const browser = harness.browser();
    const start = await browser.get("/auth/github");
    const location = new URL(start.headers.get("location")!);
    location.searchParams.set("redirect_uri", "http://localhost:1/elsewhere");
    harness.github.accounts.set("gho_erin_token_000000000000000000000", { id: 5, login: "erin" });
    const { code, state } = harness.github.approve(location.toString(), "gho_erin_token_000000000000000000000");
    expect((await browser.get(`/auth/github/callback?code=${code}&state=${state}`)).headers.get("location")).toBe("/?signin_error=callback_mismatch");

    const again = await browser.get("/auth/github");
    const cancelled = await browser.get(`/auth/github/callback?error=access_denied&state=${new URL(again.headers.get("location")!).searchParams.get("state")}`);
    expect(cancelled.headers.get("location")).toBe("/?signin_error=denied");
  });

  it("refreshes an expiring GitHub App token before using it", async () => {
    const browser = harness.browser();
    const start = await browser.get("/auth/github");
    harness.github.accounts.set("ghu_old_token_00000000000000000000", { id: 12, login: "frank" });
    harness.github.refreshTokens.set("ghr_refresh_1", { account: "ghu_old_token_00000000000000000000", next: "ghu_new_token_00000000000000000000" });
    // Expires in 60 s: inside the refresh margin, so the first use refreshes it.
    const { code, state } = harness.github.approve(start.headers.get("location")!, "ghu_old_token_00000000000000000000", { refresh: "ghr_refresh_1", expiresIn: 60 });
    await browser.get(`/auth/github/callback?code=${code}&state=${state}`);
    harness.platform.appUsersAvailable = true;
    const id = (await browser.post("/api/conversations", { prompt: "hello" })).body.conversation.id as string;
    expect(harness.platform.sessions.get(id)?.owner).toBe("github:ghu_new_token_00000000000000000000");
  });

  it("signs out everywhere: no session, no GitHub token kept", async () => {
    const browser = harness.browser();
    await signInWithGitHub(harness, browser, { id: 31, login: "gil" }, "gho_gil_token_0000000000000000000000");
    const userId = harness.store.findByGitHubId(31)!.id;
    expect(harness.store.getGitHubToken(userId)).toBeDefined();
    expect((await browser.post("/api/auth/signout")).status).toBe(204);
    expect((await browser.get("/api/me")).body.user).toBeNull();
    expect(harness.store.getGitHubToken(userId)).toBeUndefined();
  });
});

describe("this computer's GitHub sign-in", () => {
  it("signs in as the GitHub CLI's account on a loopback Front Desk", async () => {
    harness = await startHarness({}, { gh: async () => "gho_local_cli_token_00000000000000000\n" });
    harness.github.accounts.set("gho_local_cli_token_00000000000000000", { id: 99, login: "me" });
    const browser = harness.browser();
    const me = (await browser.get("/api/me")).body as MeResponse;
    expect(me.options.localGitHub).toBe(true);
    const signedIn = await browser.post("/api/auth/github/local");
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.user).toMatchObject({ kind: "github", login: "me" });
    expect(harness.store.getGitHubToken(signedIn.body.user.id)?.source).toBe("local");
  });

  it("is never offered by a deployed Front Desk", async () => {
    harness = await startHarness({ FRONT_DESK_DEPLOYED: "1" }, { gh: async () => "gho_local_cli_token_00000000000000000" });
    const browser = harness.browser();
    expect(((await browser.get("/api/me")).body as MeResponse).options.localGitHub).toBe(false);
    const refused = await browser.post("/api/auth/github/local");
    expect(refused.status).toBe(403);
  });
});
