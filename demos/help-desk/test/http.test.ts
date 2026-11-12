import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { HelpDeskConfig } from "../src/server/config.js";
import { HelpDesk } from "../src/server/desk.js";
import { createRequestHandler, hostAllowed } from "../src/server/http.js";
import { EventHub } from "../src/server/hub.js";
import { playerSessionId } from "../src/server/player.js";
import { sessionIdFor } from "../src/server/ticket.js";
import type { ApiErrorBody, HelpDeskState, PlayerTicket, PlayerTicketCreated, RunInfo, ServerEvent, SoftwareIssue } from "../src/shared/types.js";
import { FakeFactory, FakePlatform, MONA, monaWith, reportBug, settle, testConfig } from "./fakes.js";

const servers: Server[] = [];
const desks: HelpDesk[] = [];
afterEach(async () => {
  for (const desk of desks.splice(0)) desk.close();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** A built UI's stand-in. */
const WEB_ROOT = fileURLToPath(new URL("./fixtures/web", import.meta.url));

async function start(platform = new FakePlatform(), factory = new FakeFactory(), config: HelpDeskConfig = testConfig()): Promise<string> {
  const hub = new EventHub();
  const desk = new HelpDesk(platform, config, (event) => hub.publish(event), factory);
  desks.push(desk);
  const server = createServer(createRequestHandler({ desk, hub, config }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function raw(url: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`${url}${path}`, { method: init.method ?? "GET", headers: init.headers ?? {} }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
      res.once("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.once("error", reject);
    req.end(init.body);
  });
}

/** Reads a server-sent event stream until `done`; `act` runs once the first events arrived. */
function stream(url: string, path: string, done: (events: ServerEvent[]) => boolean, act?: () => void): Promise<ServerEvent[]> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const req = request(`${url}${path}`, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (chunk: string) => {
        text += chunk;
        const events = text
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)) as ServerEvent);
        if (act && events.length > 0) {
          const run = act;
          act = undefined;
          run();
        }
        if (!finished && done(events)) {
          finished = true;
          req.destroy();
          resolve(events);
        }
      });
    });
    req.once("error", (error) => {
      if (!finished) reject(error);
    });
    req.end();
  });
}

const postJson = (url: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  raw(url, path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("http", () => {
  it("answers only loopback host names, plus the deployment's own", () => {
    expect(hostAllowed("localhost:7440")).toBe(true);
    expect(hostAllowed("127.0.0.1")).toBe(true);
    expect(hostAllowed("[::1]:7440")).toBe(true);
    expect(hostAllowed("help-desk.localhost")).toBe(true);
    expect(hostAllowed("attacker.example")).toBe(false);
    expect(hostAllowed("help-desk.example.io", "help-desk.example.io,help-desk")).toBe(true);
    expect(hostAllowed(undefined)).toBe(false);
  });

  it("reports health and state", async () => {
    const url = await start();
    expect(await (await fetch(`${url}/api/health`)).json()).toEqual({ status: "ok", platform: "connected" });
    const state = (await (await fetch(`${url}/api/state`)).json()) as HelpDeskState;
    expect(state.customers).toHaveLength(25);
    expect(state.desk).toMatchObject({ environment: "help-desk", model: "claude-haiku-4.5" });
    expect(state.counters).toEqual({ sessions: 0, runtimes: 0, sandboxes: 0, messages: 0, premiumRequests: 0 });
  });

  it("starts and ends a simulation", async () => {
    const platform = new FakePlatform();
    const url = await start(platform);
    const started = await fetch(`${url}/api/simulation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ size: 5 }) });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ size: 5 });
    const ended = await fetch(`${url}/api/simulation`, { method: "DELETE" });
    expect(ended.status).toBe(204);
  });

  it("explains bad requests in plain words", async () => {
    const url = await start();
    const badSize = await fetch(`${url}/api/simulation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ size: 3 }) });
    expect(badSize.status).toBe(400);
    expect(((await badSize.json()) as ApiErrorBody).error.message).toBe("Simulate 5, 10, 25 customers.");
    expect((await fetch(`${url}/api/simulation`, { method: "POST", body: "size=5" })).status).toBe(415);
    expect((await fetch(`${url}/api/tickets/c01`)).status).toBe(404);
    expect((await fetch(`${url}/api/nope`)).status).toBe(404);
    expect((await fetch(`${url}/api/state`, { method: "PUT" })).status).toBe(405);
  });

  it("lists the team knowledge base and its proposals, decides a proposal, and removes a fact", async () => {
    const url = await start();
    expect(await (await fetch(`${url}/api/knowledge`)).json()).toEqual([]);
    const missing = await fetch(`${url}/api/knowledge/nope`, { method: "DELETE" });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ApiErrorBody).error.message).toMatch(/isn't in the team knowledge base/);
    const desk = desks.at(-1)!;
    const proposal = desk.knowledge.propose({ subject: "Returns", fact: "Return labels expire after 30 days.", customerId: "c01", customerName: "Maya Chen", sessionId: "s1" })!;
    expect(await (await fetch(`${url}/api/knowledge/proposals`)).json()).toMatchObject([{ id: proposal.id, subject: "Returns" }]);
    const decide = (approve: unknown) => fetch(`${url}/api/knowledge/proposals/${proposal.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approve }) });
    expect((await decide("yes")).status).toBe(400);
    expect((await decide(true)).status).toBe(204);
    expect((await decide(true)).status).toBe(409);
    expect(await (await fetch(`${url}/api/knowledge`)).json()).toMatchObject([{ id: proposal.id, subject: "Returns" }]);
    expect((await fetch(`${url}/api/knowledge/${proposal.id}`, { method: "DELETE" })).status).toBe(204);
    expect(desk.knowledge.list()).toEqual([]);
  });

  it("refuses other host names and cross-site requests", async () => {
    const url = await start();
    expect((await raw(url, "/api/state", { headers: { host: "attacker.example" } })).status).toBe(403);
    const crossSite = await raw(url, "/api/simulation", { method: "DELETE", headers: { origin: "https://attacker.example" } });
    expect(crossSite.status).toBe(403);
  });

  it("explains a missing UI build instead of a blank page", async () => {
    const url = await start();
    const page = await fetch(`${url}/`);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("Help Desk's UI isn't built yet");
  });

  it("sends a software issue to Software Factory once, linking back to the address the operator uses", async () => {
    const platform = new FakePlatform();
    const factory = new FakeFactory();
    const url = await start(platform, factory);
    const port = new URL(url).port;
    const run = (await (await fetch(`${url}/api/simulation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ size: 10 }) })).json()) as RunInfo;
    const session = (customerId: string) => platform.sessions.get(sessionIdFor(run.id, customerId));
    for (let tries = 0; tries < 50 && !(session("c05")?.sent.length && session("c08")?.sent.length); tries++) await settle(5);
    await reportBug(session("c05")!, "The code TRAIL15 says 'invalid code' at checkout.", { area: "promo-codes", title: "TRAIL15 rejected", whatHappened: "Pasted TRAIL15, got 'invalid code'.", expected: "15% off." });
    await reportBug(session("c08")!, "Changed 1 to 2, charged for 3.", { area: "cart", title: "Quantity change adds", whatHappened: "Changed 1 to 2, charged for 3.", expected: "Charged for 2." });

    const route = (area: string, headers: Record<string, string> = {}) => raw(url, `/api/issues/${area}/route`, { method: "POST", headers });
    const sent = await route("promo-codes", { host: `localhost:${port}`, origin: `http://localhost:${port}` });
    expect(sent.status).toBe(201);
    expect(JSON.parse(sent.body) as SoftwareIssue).toMatchObject({ area: "promo-codes", routed: { workOrderId: "wo_1", number: 1, status: "queued", url: "http://factory.test/#/wo/wo_1" } });
    expect(factory.created[0]?.origin).toMatchObject({ app: "help-desk", url: `http://localhost:${port}/#/c/c05`, key: `${run.id}:promo-codes` });
    // Without an Origin (not a browser), the link uses the Host.
    expect((await route("cart")).status).toBe(201);
    expect(factory.created[1]?.origin?.url).toBe(`${url}/#/c/c08`);

    const again = await route("promo-codes");
    expect(again.status).toBe(409);
    expect((JSON.parse(again.body) as ApiErrorBody).error).toEqual({ code: "conflict", message: "This issue was sent to Software Factory already, as WO-0001." });
    expect((await route("promo-codes", { origin: "https://attacker.example" })).status).toBe(403);
    expect((await route("checkout")).status).toBe(404);

    const state = (await (await fetch(`${url}/api/state`)).json()) as HelpDeskState;
    expect(state.desk.factory).toEqual({ configured: true, url: "http://factory.test" });
    expect(state.issues.map((issue) => [issue.area, issue.routed?.number])).toEqual([
      ["promo-codes", 1],
      ["cart", 2],
    ]);
  });

  it("answers 503 with the reason when Software Factory isn't connected", async () => {
    const factory = new FakeFactory();
    factory.configured = false;
    const url = await start(new FakePlatform(), factory);
    const response = await fetch(`${url}/api/issues/promo-codes/route`, { method: "POST" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "factory_unavailable", message: "Software Factory isn't connected. Start it with `aspire run`, or set SOFTWARE_FACTORY_URL." } });
    expect(((await (await fetch(`${url}/api/state`)).json()) as HelpDeskState).desk.factory).toEqual({ configured: false });
  });
});

describe("player tickets over http", () => {
  it("opens a ticket for Downhill's server (201), reopens it by ID (200, the same body), and explains refusals", async () => {
    const platform = new FakePlatform();
    const url = await start(platform);
    const button = monaWith({ checkout: undefined, opener: "support-button" });
    const created = await postJson(url, "/api/player-tickets", button);
    expect(created.status).toBe(201);
    const { ticketId, chatPath } = JSON.parse(created.body) as PlayerTicketCreated;
    expect(chatPath).toBe(`/chat/${ticketId}`);
    // Waiting for the player: no session until they write.
    expect((await (await fetch(`${url}/api/player-tickets/${ticketId}`)).json()) as PlayerTicket).toMatchObject({ ticketId, player: { name: "Mona" }, opener: "support-button", status: "opened", items: [] });
    expect(platform.created).toEqual([]);
    expect(((await (await fetch(`${url}/api/state`)).json()) as HelpDeskState).players.map((ticket) => ticket.ticketId)).toEqual([ticketId]);

    const reopened = await postJson(url, "/api/player-tickets", { ...MONA, opener: "promo-error", ticketId, at: "2026-11-12T17:31:00.000Z" });
    expect(reopened.status).toBe(200);
    expect(JSON.parse(reopened.body)).toEqual({ ticketId, chatPath });
    expect((await (await fetch(`${url}/api/player-tickets/${ticketId}`)).json()) as PlayerTicket).toMatchObject({ opener: "promo-error", checkout: { code: "trail15" } });
    const unknown = await postJson(url, "/api/player-tickets", { ...button, ticketId: "nosuchticket00", at: "2026-11-12T17:32:00.000Z" });
    expect(unknown.status).toBe(201);
    expect((JSON.parse(unknown.body) as PlayerTicketCreated).ticketId).not.toBe(ticketId);

    const bad = await postJson(url, "/api/player-tickets", monaWith({ checkout: { subtotalCents: 4.99 } }));
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body)).toEqual({ error: { code: "invalid_request", message: "checkout.subtotalCents must be a whole number of cents from 0 to 2,000,000." } });
    expect((await postJson(url, "/api/player-tickets", monaWith({ opener: "title" }))).status).toBe(400);
    expect((await raw(url, "/api/player-tickets", { method: "POST", body: JSON.stringify(MONA) })).status).toBe(415);
    // Downhill's server calls it; a page on another origin (the game's) can't.
    expect((await postJson(url, "/api/player-tickets", MONA, { origin: "http://localhost:7450" })).status).toBe(403);

    platform.setStatus({ state: "unavailable", message: "Managed Copilot isn't reachable yet." });
    const offline = await postJson(url, "/api/player-tickets", monaWith({ at: "2026-11-12T17:45:00.000Z" }));
    expect(offline.status).toBe(503);
    expect(JSON.parse(offline.body)).toEqual({ error: { code: "platform_unavailable", message: "Managed Copilot isn't reachable yet." } });
  });

  it("lets the player write from their chat page (the first message starts the session), and the operator answer and end it", async () => {
    const platform = new FakePlatform();
    const url = await start(platform);
    const { ticketId } = JSON.parse((await postJson(url, "/api/player-tickets", MONA)).body) as PlayerTicketCreated;
    const sessionId = playerSessionId(ticketId);
    expect((await postJson(url, `/api/player-tickets/${ticketId}/messages`, { text: "The discount code isn't working!" })).status).toBe(202);
    const session = platform.sessions.get(sessionId)!;
    expect(session.sent).toHaveLength(1);
    expect(session.sent[0]!.prompt).toMatch(/^The discount code isn't working!\n\n<downhill_checkout>\n/);

    expect((await postJson(url, `/api/player-tickets/${ticketId}/messages`, { text: "Thanks! Will it work next time?" })).status).toBe(202);
    expect(session.sent.at(-1)).toEqual({ prompt: "Thanks! Will it work next time?" });
    expect((await postJson(url, `/api/player-tickets/${ticketId}/messages`, { text: " " })).status).toBe(400);

    const pending = session.ask({ kind: "custom-tool", toolName: "request_refund", toolCallId: "r1", args: { orderId: "DH-1042", amount: 0.75, reason: "15% off" } });
    await settle();
    expect((await postJson(url, `/api/player-tickets/${ticketId}/approvals/r1`, { approve: true })).status).toBe(204);
    expect(await pending).toMatchObject({ kind: "approve-once" });
    expect((await postJson(url, `/api/player-tickets/${ticketId}/approvals/r1`, { approve: true })).status).toBe(409);

    expect((await raw(url, `/api/player-tickets/${ticketId}`, { method: "DELETE" })).status).toBe(204);
    expect(platform.deleted).toContain(sessionId);
    const gone = await raw(url, `/api/player-tickets/${ticketId}`);
    expect(gone.status).toBe(404);
    expect((JSON.parse(gone.body) as ApiErrorBody).error.message).toBe("There's no such support chat. It may have ended.");
    expect((await postJson(url, `/api/player-tickets/${ticketId}/messages`, { text: "Hello?" })).status).toBe(404);
  });

  it("streams a player's chat page only their own ticket", async () => {
    const platform = new FakePlatform();
    const url = await start(platform);
    const { ticketId } = JSON.parse((await postJson(url, "/api/player-tickets", MONA)).body) as PlayerTicketCreated;
    const ben = monaWith({ player: { name: "Ben", rider: "ben" }, at: "2026-11-12T17:40:00.000Z" });
    const events = await stream(
      url,
      `/api/events?player=${ticketId}`,
      (seen) => seen.filter((event) => event.type === "players").length >= 2,
      () => void postJson(url, "/api/player-tickets", ben),
    );
    expect(events[0]?.type).toBe("platform");
    expect(events.some((event) => event.type === "run" || event.type === "counters" || event.type === "issues")).toBe(false);
    const lists = events.flatMap((event) => (event.type === "players" ? [event.players.map((ticket) => ticket.player.name)] : []));
    expect(lists).toEqual([["Mona"], ["Mona"]]);
    expect(events.every((event) => event.type !== "player" || event.ticket.ticketId === ticketId)).toBe(true);
  });

  it("serves the player's chat page at /chat/<ticket>, which the game may frame", async () => {
    const url = await start(new FakePlatform(), new FakeFactory(), testConfig({ webRoot: WEB_ROOT }));
    const page = await fetch(`${url}/chat/mhv3k2a1q9z4f2`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("x-frame-options")).toBeNull();
    expect(page.headers.get("content-security-policy")).toBeNull();
    expect(await page.text()).toContain('<div id="root"></div>');
  });
});
