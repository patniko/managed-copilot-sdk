import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ApiErrorBody, PlayerTicket, SupportRequest } from "../src/shared/support.js";
import { hostAllowed } from "../src/server/http.js";
import { HelpDesk, SUPPORT_NOT_CONNECTED, type SupportDesk } from "../src/server/support.js";
import { fakeServer, listen, raw, start as startServer, testConfig } from "./helpers.js";

function start(support: SupportDesk = new HelpDesk(undefined), config = testConfig()): Promise<string> {
  return startServer({ support, config });
}

/** A stand-in for Help Desk's API. */
function fakeHelpDesk(answer: { status: number; body: unknown } = { status: 201, body: { ticketId: "t_9", chatPath: "/chat/t_9" } }) {
  return fakeServer(answer);
}

const OFFER = "Launch week: 15% off everything with code trail15";
const REQUEST = {
  player: { rider: "mona" },
  opener: "promo-error",
  checkout: { code: "trail15", error: "Invalid code.", offer: OFFER, items: [{ sku: "mona-neon", name: "Neon Mona", priceCents: 499 }], subtotalCents: 499 },
} as const satisfies SupportRequest;

function postTicket(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${url}/api/support/tickets`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

async function errorOf(response: Response): Promise<ApiErrorBody["error"]> {
  return ((await response.json()) as ApiErrorBody).error;
}

describe("Downhill's server", () => {
  it("answers only loopback host names, plus the deployment's own", () => {
    expect(hostAllowed("localhost:7455")).toBe(true);
    expect(hostAllowed("127.0.0.1")).toBe(true);
    expect(hostAllowed("[::1]:7455")).toBe(true);
    expect(hostAllowed("downhill.localhost")).toBe(true);
    expect(hostAllowed("attacker.example")).toBe(false);
    expect(hostAllowed("downhill.example.io", "downhill.example.io,downhill")).toBe(true);
    expect(hostAllowed(undefined)).toBe(false);
  });

  it("reports health, and whether support is connected", async () => {
    const url = await start();
    expect(await (await fetch(`${url}/api/health`)).json()).toEqual({ status: "ok" });
    expect(await (await fetch(`${url}/api/support`)).json()).toEqual({ connected: false });
    const connected = await start(new HelpDesk("http://help-desk.test"));
    expect(await (await fetch(`${connected}/api/support`)).json()).toEqual({ connected: true });
  });

  it("opens a player ticket in Help Desk, server to server, and returns its chat at Help Desk's public address", async () => {
    const desk = await fakeHelpDesk();
    const url = await start(new HelpDesk(`${desk.url}/`, "http://localhost:7440"));
    const response = await postTicket(url, REQUEST, { "user-agent": "Mozilla/5.0 (Edge)", origin: url });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ticketId: "t_9", chatUrl: "http://localhost:7440/chat/t_9" });
    expect(desk.received).toHaveLength(1);
    const [sent] = desk.received;
    expect(sent).toMatchObject({ method: "POST", url: "/api/player-tickets" });
    expect(sent!.headers["content-type"]).toBe("application/json");
    expect(sent!.headers.origin).toBeUndefined();
    const ticket = sent!.body as PlayerTicket;
    expect(ticket).toEqual({ product: "downhill", player: { name: "Mona", rider: "mona" }, opener: "promo-error", checkout: REQUEST.checkout, gameVersion: "1.0.0", userAgent: "Mozilla/5.0 (Edge)", at: expect.any(String) });
    expect(Date.now() - Date.parse(ticket.at)).toBeLessThan(10_000);
  });

  it("opens support before any checkout without one, and reopens the session's ticket with what's new", async () => {
    const desk = await fakeHelpDesk();
    const url = await start(new HelpDesk(desk.url));
    expect((await postTicket(url, { player: { rider: "copilot" }, opener: "support-button" })).status).toBe(201);
    expect(desk.received[0]!.body).toEqual({ product: "downhill", player: { name: "Copilot", rider: "copilot" }, opener: "support-button", gameVersion: "1.0.0", userAgent: expect.any(String), at: expect.any(String) });
    const reopened = await postTicket(url, { ...REQUEST, opener: "support-button", ticketId: "t_9" });
    expect(await reopened.json()).toMatchObject({ ticketId: "t_9" });
    expect(desk.received[1]!.body).toMatchObject({ opener: "support-button", ticketId: "t_9", checkout: REQUEST.checkout });
  });

  it("passes an order bought without the discount, and cuts long text short", async () => {
    const desk = await fakeHelpDesk();
    const url = await start(new HelpDesk(desk.url));
    const order = { id: "DH-1042", totalCents: 499, paidAt: "2026-11-12T17:30:00Z" };
    const long = { ...REQUEST, opener: "receipt", checkout: { ...REQUEST.checkout, error: `Invalid code.\n${"x".repeat(400)}`, order } };
    expect((await postTicket(url, long)).status).toBe(201);
    const { checkout } = desk.received[0]!.body as PlayerTicket;
    expect(checkout?.order).toEqual({ id: "DH-1042", totalCents: 499, paidAt: "2026-11-12T17:30:00.000Z" });
    expect(checkout?.error).toHaveLength(300);
    expect(checkout?.error).toMatch(/^Invalid code\. x+…$/);
  });

  it("refuses malformed requests in plain words, before Help Desk sees them", async () => {
    const desk = await fakeHelpDesk();
    const url = await start(new HelpDesk(desk.url));
    const bad = async (body: unknown) => {
      const response = await postTicket(url, body);
      expect(response.status).toBe(400);
      return (await errorOf(response)).message;
    };
    expect(await bad({ ...REQUEST, player: { rider: "ghost" } })).toBe("Send player.rider: one of rider, mona, copilot.");
    expect(await bad({ ...REQUEST, opener: undefined })).toBe("Send opener: one of support-button, promo-error, receipt.");
    expect(await bad({ ...REQUEST, opener: "auto" })).toBe("Send opener: one of support-button, promo-error, receipt.");
    expect(await bad({ ...REQUEST, ticketId: "../../admin" })).toBe("Send ticketId as the ticket's id, letters, digits, dashes, and underscores, or leave it out.");
    expect(await bad({ ...REQUEST, checkout: "trail15" })).toBe("Send checkout as what happened at checkout, or leave it out.");
    expect(await bad({ ...REQUEST, checkout: { ...REQUEST.checkout, offer: undefined } })).toBe("Send checkout.offer as text.");
    expect(await bad({ ...REQUEST, checkout: { ...REQUEST.checkout, items: Array.from({ length: 21 }, () => REQUEST.checkout.items[0]) } })).toBe("Send checkout.items as a list of at most 20 items.");
    expect(await bad({ ...REQUEST, checkout: { ...REQUEST.checkout, items: [{ sku: "../etc", name: "x", priceCents: 1 }] } })).toBe("Each item needs a sku: letters, digits, and dashes.");
    expect(await bad({ ...REQUEST, checkout: { ...REQUEST.checkout, subtotalCents: 4.5 } })).toBe("Send checkout.subtotalCents as a whole number of cents from 0 to 2000000.");
    expect(await bad({ ...REQUEST, checkout: { ...REQUEST.checkout, order: { id: "1042", totalCents: 499, paidAt: "2026-11-12T17:30:00Z" } } })).toBe("Send the order's id, such as DH-1042.");
    expect(await bad({ ...REQUEST, checkout: { ...REQUEST.checkout, order: { id: "DH-1042", totalCents: 499, paidAt: "yesterday" } } })).toBe("Send the order's paidAt as a date and time.");
    expect((await fetch(`${url}/api/support/tickets`, { method: "POST", body: "trail15" })).status).toBe(415);
    const huge = await postTicket(url, { ...REQUEST, padding: "x".repeat(20_000) });
    expect(huge.status).toBe(413);
    expect(desk.received).toHaveLength(0);
  });

  it("refuses other host names and cross-site requests", async () => {
    const desk = await fakeHelpDesk();
    const url = await start(new HelpDesk(desk.url));
    expect((await raw(url, "/api/health", { headers: { host: "attacker.example" } })).status).toBe(403);
    const crossSite = await raw(url, "/api/support/tickets", { method: "POST", headers: { origin: "https://attacker.example", "content-type": "application/json" }, body: JSON.stringify(REQUEST) });
    expect(crossSite.status).toBe(403);
    expect(desk.received).toHaveLength(0);
    expect((await fetch(`${url}/api/nope`)).status).toBe(404);
    expect((await fetch(`${url}/api/support`, { method: "DELETE" })).status).toBe(405);
  });

  it("says support isn't connected when HELP_DESK_URL isn't set", async () => {
    const url = await start(new HelpDesk(undefined));
    const response = await postTicket(url, REQUEST);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "support_not_connected", message: SUPPORT_NOT_CONNECTED } });
    expect(SUPPORT_NOT_CONNECTED).toBe("Support isn't connected. Start Help Desk with `aspire run`, or set HELP_DESK_URL.");
  });

  it("explains Help Desk's refusals, outages, silence, and unreadable answers", async () => {
    const outcome = async (support: SupportDesk) => {
      const response = await postTicket(await start(support), REQUEST);
      return { status: response.status, ...(await errorOf(response)) };
    };
    const refused = await fakeHelpDesk({ status: 422, body: { error: { code: "invalid", message: "That ticket is missing the player's rider." } } });
    expect(await outcome(new HelpDesk(refused.url))).toEqual({ status: 502, code: "support_rejected", message: "That ticket is missing the player's rider." });
    const down = await fakeHelpDesk({ status: 503, body: { error: { code: "platform_unavailable", message: "The platform isn't reachable." } } });
    expect(await outcome(new HelpDesk(down.url))).toEqual({ status: 503, code: "support_unavailable", message: "Help Desk isn't available right now: The platform isn't reachable." });
    const garbled = await fakeHelpDesk({ status: 201, body: { ticketId: "t_1", chatPath: "//attacker.example/chat" } });
    expect(await outcome(new HelpDesk(garbled.url))).toMatchObject({ status: 502, code: "support_error" });

    const closedServer = createServer();
    const closed = await listen(closedServer);
    await new Promise((resolve) => closedServer.close(resolve));
    expect(await outcome(new HelpDesk(closed))).toEqual({ status: 502, code: "support_unreachable", message: `Help Desk didn't answer at ${closed}. Check that it's running (\`aspire run\`), or set HELP_DESK_URL.` });
    const silent = (async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as typeof fetch;
    expect(await outcome(new HelpDesk("http://help-desk.test", undefined, silent))).toEqual({ status: 504, code: "support_timeout", message: "Help Desk didn't answer within 10 seconds. Try again in a moment." });
  });

  it("serves the built game, caching only fingerprinted assets for good", async () => {
    const url = await start();
    const page = await fetch(`${url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    expect(await page.text()).toContain('<canvas id="game">');
    const asset = await fetch(`${url}/assets/app-3f2a1c.js`);
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await fetch(`${url}/shop`)).status).toBe(200);
    expect((await fetch(`${url}/assets/missing.js`)).status).toBe(404);
    expect((await raw(url, "/%2e%2e/%2e%2e/package.json")).status).toBe(404);
  });

  it("explains a missing build instead of a blank page", async () => {
    const url = await start(undefined, testConfig({ webRoot: fileURLToPath(new URL("./fixtures/missing", import.meta.url)) }));
    const page = await fetch(`${url}/`);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("Downhill isn't built yet");
  });
});
