import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SalesRow, StorefrontInfo } from "../src/shared/shop.js";
import type { ApiErrorBody } from "../src/shared/support.js";
import { sign } from "../src/server/deploys.js";
import type { IncidentService } from "../src/server/service.js";
import { nextPatch } from "../src/server/storefront.js";
import { LAUNCH_DAY, MINUTE } from "../src/server/timeline.js";
import { postJson, raw, start, START, STOREFRONT_DIR, testConfig, testShop, type Clock } from "./helpers.js";

const ORIGINAL = (JSON.parse(readFileSync(join(STOREFRONT_DIR, "package.json"), "utf8")) as { version: string }).version;
const PATCHED = nextPatch(ORIGINAL);
const SECRET = "deploy-secret-for-tests";
const FIXED = "export const fixed = true; // the approved fix\n";

async function setup(options: { secret?: string } = {}) {
  const clock: Clock = { now: START };
  const config = testConfig(options.secret ? { deploySecret: options.secret } : {});
  const shop = testShop(config, clock);
  const url = await start({ config, shop });
  return { clock, shop, url, config };
}

const info = async (url: string) => (await (await fetch(`${url}/api/storefront`)).json()) as StorefrontInfo;
const service = async (url: string) => (await (await fetch(`${url}/api/incident/service`)).json()) as IncidentService;
const errorOf = async (response: Response) => ((await response.json()) as ApiErrorBody).error;

function deployBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "incident.deploy_approved",
    incident: "INC-1004",
    service: "downhill-shop",
    version: PATCHED,
    previousVersion: ORIGINAL,
    summary: "Match promotion codes without regard to case or spaces",
    tests: "node --test: 16 passed",
    approvedBy: "patniko",
    approvedAt: "2026-11-12T18:05:00Z",
    files: [
      { path: "src/promotions.js", content: FIXED },
      { path: "test/promotions.test.js", content: "// regression tests\n" },
    ],
    ...overrides,
  });
}

function deploy(url: string, body: string, options: { at: number; key?: string; signature?: string; secret?: string }): Promise<Response> {
  return fetch(`${url}/api/deploys`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": options.key ?? "session-1:call-7",
      "x-incident-commander-signature": options.signature ?? sign(options.secret ?? SECRET, body, options.at),
    },
    body,
  });
}

describe("checkout's storefront code", () => {
  it("serves the storefront as it shipped at a versioned, immutable URL, and says so with no caching", async () => {
    const { url } = await setup();
    const response = await fetch(`${url}/api/storefront`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const current = (await response.json()) as StorefrontInfo;
    expect(current).toEqual({ version: ORIGINAL, source: "original", modules: { promotions: expect.stringMatching(/^\/storefront\/\d+\.\d+\.\d+-[0-9a-f]{10}\/src\/promotions\.js$/), cart: expect.stringMatching(/\/src\/cart\.js$/) } });
    const promotions = await fetch(`${url}${current.modules.promotions}`);
    expect(promotions.status).toBe(200);
    expect(promotions.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(promotions.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await promotions.text()).toBe(readFileSync(join(STOREFRONT_DIR, "src", "promotions.js"), "utf8").replace(/\r\n/g, "\n"));
    const release = current.modules.promotions.split("/")[2]!;
    expect((await fetch(`${url}/storefront/${ORIGINAL}-0000000000/src/promotions.js`)).status).toBe(404);
    expect((await fetch(`${url}/storefront/${release}/package.json`)).status).toBe(404);
    expect((await raw(url, `/storefront/${release}/src/%2e%2e/%2e%2e/package.json`)).status).toBe(404);
    expect((await fetch(`${url}${current.modules.cart}`, { method: "POST" })).status).toBe(405);
  });
});

describe("the sales ledger's API", () => {
  it("records the shop's checkout outcomes as live sales, and serves them as CSV and JSON", async () => {
    const { url, clock } = await setup();
    const rejected = { type: "promo_rejected", rider: "mona", skus: ["mona-neon"], subtotalCents: 499, code: "trail15", source: "banner", error: "Invalid code." };
    expect((await postJson(url, "/api/shop/events", rejected, { origin: url })).status).toBe(204);
    clock.now += 20_000;
    const bought = { type: "purchase", rider: "mona", skus: ["mona-neon"], subtotalCents: 499, orderId: "DH-1042", discountCents: 0, totalCents: 499 };
    expect((await postJson(url, "/api/shop/events", bought)).status).toBe(204);

    const csv = await fetch(`${url}/api/sales.csv`);
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(csv.headers.get("cache-control")).toBe("no-store");
    const lines = (await csv.text()).trimEnd().split("\n");
    expect(lines[0]).toBe("time,minutes_since_launch,event,order_id,item,kind,price_usd,promo_code,promo_result,discount_usd,total_usd,player,source");
    expect(lines.filter((line) => line.endsWith(",live"))).toEqual([
      expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,180\.0,promo_rejected,,Neon Mona,outfit,4\.99,trail15,rejected,,,Mona,live$/),
      expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,180\.3,purchase,DH-1042,Neon Mona,outfit,4\.99,,none,0\.00,4\.99,Mona,live$/),
    ]);
    const { rows } = (await (await fetch(`${url}/api/sales`)).json()) as { rows: SalesRow[] };
    expect(rows).toHaveLength(lines.length - 1);
    expect(rows.at(-1)).toMatchObject({ event: "purchase", order_id: "DH-1042", promo_code: null, promo_result: "none", discount_usd: 0, total_usd: 4.99, player: "Mona", source: "live" });
  });

  it("refuses events it can't record, in plain words, and cross-site requests", async () => {
    const { url } = await setup();
    const bad = async (body: unknown) => {
      const response = await postJson(url, "/api/shop/events", body);
      expect(response.status).toBe(400);
      return (await errorOf(response)).message;
    };
    const event = { type: "promo_rejected", rider: "mona", skus: ["mona-neon"], subtotalCents: 499, code: "trail15", source: "banner", error: "Invalid code." };
    expect(await bad({ ...event, type: "refund" })).toBe('Send type: "promo_applied", "promo_rejected", or "purchase".');
    expect(await bad({ ...event, rider: "ghost" })).toBe("Send rider: one of rider, mona, copilot.");
    expect(await bad({ ...event, skus: ["free-bike"] })).toBe('The shop doesn\'t sell "free-bike".');
    expect(await bad({ ...event, skus: [] })).toBe("Send skus: the cart's items, 1 to 20 of them.");
    expect(await bad({ ...event, source: "email" })).toBe('Send source: "banner" or "typed".');
    expect(await bad({ ...event, type: "purchase", orderId: "1042", discountCents: 0, totalCents: 499 })).toBe("Send the order's orderId, such as DH-1042.");
    expect(await bad({ ...event, type: "promo_applied", discountCents: 900 })).toBe("Send discountCents as a whole number of cents from 0 to 499.");
    expect((await postJson(url, "/api/shop/events", event, { origin: "https://attacker.example" })).status).toBe(403);
    expect((await postJson(url, "/api/shop/events", { ...event, padding: "x".repeat(9_000) })).status).toBe(413);
  });
});

describe("rolling out the shop", () => {
  const put = (url: string, body: unknown) => fetch(`${url}/api/shop`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const event = { type: "promo_rejected", rider: "mona", skus: ["mona-neon"], subtotalCents: 499, code: "trail15", source: "banner", error: "Invalid code." };
  const rows = async (url: string) => ((await (await fetch(`${url}/api/sales`)).json()) as { rows: SalesRow[] }).rows;

  it("closed, takes no checkouts and shows no sales or shop log; opened, starts launch day over; and remembers which across restarts", async () => {
    const { url, clock, config } = await setup();
    expect(await (await fetch(`${url}/api/shop`)).json()).toEqual({ open: true });

    const closed = await put(url, { open: false });
    expect(closed.status).toBe(200);
    expect(await closed.json()).toMatchObject({ open: false, changedAt: new Date(START).toISOString(), message: expect.stringContaining("closed") });
    const refused = await postJson(url, "/api/shop/events", event);
    expect(refused.status).toBe(409);
    expect((await errorOf(refused)).code).toBe("shop_closed");
    expect(await rows(url)).toEqual([]);
    expect((await service(url)).files.find((file) => file.path === "logs/shop.log")?.content).toBe("");

    // The same data directory, as after a restart: still closed.
    expect(testShop(config, clock).availability().open).toBe(false);

    clock.now += 2 * 60 * MINUTE;
    const opened = (await (await put(url, { open: true })).json()) as { open: boolean };
    expect(opened.open).toBe(true);
    const status = (await (await fetch(`${url}/api/status`)).json()) as { timeline: { launchAt: string } };
    expect(Date.parse(status.timeline.launchAt)).toBe(clock.now - 3 * 60 * MINUTE);
    expect((await rows(url)).length).toBeGreaterThan(0);
    expect((await postJson(url, "/api/shop/events", event)).status).toBe(204);
    expect((await put(url, { open: "yes" })).status).toBe(400);
  });
});

describe("downhill-shop for Incident Commander", () => {
  it("is the storefront code as checkout runs it, the shop's last two hours of logs, and its deploy history", async () => {
    const { url } = await setup();
    await postJson(url, "/api/shop/events", { type: "promo_rejected", rider: "mona", skus: ["mona-neon"], subtotalCents: 499, code: "trail15", source: "banner", error: "Invalid code." });
    const shop = await service(url);
    expect(shop.name).toBe("downhill-shop");
    expect(shop.version).toBe(ORIGINAL);
    expect(shop.files.map((file) => file.path)).toEqual([
      "package.json",
      "README.md",
      "src/promotions.js",
      "src/cart.js",
      "src/order-status.js",
      "test/cart.test.js",
      "test/order-status.test.js",
      "test/promotions.test.js",
      "logs/shop.log",
      "deploys/HISTORY.md",
    ]);
    const file = (path: string) => shop.files.find((f) => f.path === path)!.content;
    expect(file("src/promotions.js")).toBe(readFileSync(join(STOREFRONT_DIR, "src", "promotions.js"), "utf8").replace(/\r\n/g, "\n"));

    const lines = file("logs/shop.log").trimEnd().split("\n");
    const times = lines.map((line) => Date.parse(line.slice(0, 20)));
    expect(times.every((t, i) => t >= START - 120 * MINUTE && t <= START && (i === 0 || t >= times[i - 1]!))).toBe(true);
    expect(lines.at(-1)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ level=warn event=promo_rejected code=trail15 source=banner error="Invalid code\." sku=mona-neon subtotal_cents=499 player=Mona live=true$/);
    expect(lines.some((line) => / level=info event=promo_applied code=TRAIL15 source=typed sku=\S+ subtotal_cents=\d+ discount_cents=\d+ player="[^"]+"$/.test(line))).toBe(true);
    expect(lines.some((line) => / level=info event=purchase order=DH-\d+ sku=\S+ subtotal_cents=\d+ promo=none discount_cents=0 total_cents=\d+ player=/.test(line))).toBe(true);
    expect(lines).toContainEqual(expect.stringContaining('level=info event=release service=downhill-shop version=1.1.0 msg="Downhill shop 1.1.0: launch-week banner with one-click Apply code"'));
    expect(lines.filter((line) => line.includes("live=true"))).toHaveLength(1);

    const history = file("deploys/HISTORY.md");
    expect(history).toContain(`| Downhill 1.0.0, storefront v${ORIGINAL} | Launch:`);
    expect(history.indexOf(`storefront v${ORIGINAL}`)).toBeLessThan(history.indexOf("| Downhill shop 1.1.0 | Downhill shop 1.1.0: launch-week banner with one-click Apply code |"));
  });
});

describe("deploys from Incident Commander", () => {
  it("are refused while DOWNHILL_DEPLOY_SECRET isn't set", async () => {
    const { url, clock } = await setup();
    const response = await deploy(url, deployBody(), { at: clock.now });
    expect(response.status).toBe(503);
    expect((await errorOf(response)).message).toBe("Deploys are off: set DOWNHILL_DEPLOY_SECRET to the secret Incident Commander signs deploys with (its INCIDENT_DEPLOY_SECRET).");
  });

  it("need a fresh, valid signature", async () => {
    const { url, clock } = await setup({ secret: SECRET });
    const body = deployBody();
    const refused = async (options: Parameters<typeof deploy>[2]) => {
      const response = await deploy(url, body, options);
      expect(response.status).toBe(401);
      return (await errorOf(response)).message;
    };
    expect(await refused({ at: clock.now, secret: "someone-else" })).toBe("The deploy's signature doesn't match. Check that DOWNHILL_DEPLOY_SECRET is Incident Commander's deploy secret.");
    expect(await refused({ at: clock.now - 6 * MINUTE })).toBe("The deploy's signature is more than 5 minutes old. Send it again.");
    expect(await refused({ at: clock.now, signature: "t=1,v1=nothex" })).toBe("The deploy's signature doesn't match. Check that DOWNHILL_DEPLOY_SECRET is Incident Commander's deploy secret.");
    const unsigned = await fetch(`${url}/api/deploys`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(unsigned.status).toBe(401);
    // A body changed after signing doesn't match its signature.
    const tampered = await fetch(`${url}/api/deploys`, { method: "POST", headers: { "content-type": "application/json", "x-incident-commander-signature": sign(SECRET, body, clock.now) }, body: body.replace("INC-1004", "INC-6666") });
    expect(tampered.status).toBe(401);
    expect((await info(url)).source).toBe("original");
  });

  it("deploy only storefront code: .js under src/ or test/, README.md, and package.json, for downhill-shop", async () => {
    const { url, clock } = await setup({ secret: SECRET });
    const bad = async (overrides: Record<string, unknown>) => {
      const response = await deploy(url, deployBody(overrides), { at: clock.now });
      expect(response.status).toBe(400);
      return (await errorOf(response)).message;
    };
    const files = (path: string) => ({ files: [{ path, content: FIXED }] });
    for (const path of ["../server.js", "src/../../server.js", "/etc/passwd.js", "src/promotions.ts", "node_modules/x/index.js", "src\\promotions.js", ".github/workflows/x.js", "src/.hidden.js", "logs/shop.log"]) {
      expect(await bad(files(path))).toMatch(/can't be deployed: only \.js files under src\/ or test\/, README\.md, and package\.json\.$/);
    }
    expect(await bad({ type: "incident.created" })).toBe('Downhill only takes approved deploys (type "incident.deploy_approved").');
    expect(await bad({ service: "checkout-service" })).toBe("Downhill only deploys downhill-shop; this deploy is for checkout-service.");
    expect(await bad({ files: [] })).toBe("Send the fix as files: 1 to 40 of them.");
    expect(await bad({ files: [{ path: "src/a.js", content: "x".repeat(300 * 1024) }] })).toBe("src/a.js is larger than 256 KB.");
    expect(await bad({ files: [{ path: "package.json", content: "{ nope" }] })).toBe("package.json isn't valid JSON.");
    expect(await bad({ incident: "" })).toBe("Send the incident the deploy fixes, such as INC-1004.");
    expect((await info(url)).source).toBe("original");
  });

  it("activate the approved version for checkout, once per idempotency key", async () => {
    const { url, clock, shop } = await setup({ secret: SECRET });
    const before = await info(url);
    clock.now += 5 * MINUTE;
    const response = await deploy(url, deployBody(), { at: clock.now });
    expect(response.status).toBe(200);
    const answer = await response.json();
    expect(answer).toEqual({ version: PATCHED, message: `Downhill's shop now runs storefront v${PATCHED}.` });

    const after = await info(url);
    expect(after).toEqual({
      version: PATCHED,
      source: "deployed",
      deployedAt: new Date(clock.now).toISOString(),
      incident: "INC-1004",
      approvedBy: "patniko",
      modules: { promotions: expect.stringMatching(new RegExp(`^/storefront/${PATCHED.replace(/\./g, "\\.")}-[0-9a-f]{10}/src/promotions\\.js$`)), cart: expect.any(String) },
    });
    expect(await (await fetch(`${url}${after.modules.promotions}`)).text()).toBe(FIXED);
    // The cart wasn't part of the fix: the new version serves the original, and the old version's URLs still work.
    expect(await (await fetch(`${url}${after.modules.cart}`)).text()).toBe(await (await fetch(`${url}${before.modules.cart}`)).text());
    expect(await (await fetch(`${url}${before.modules.promotions}`)).text()).not.toBe(FIXED);

    // The same deploy again is the same deploy, with the same answer.
    clock.now += MINUTE;
    const again = await deploy(url, deployBody(), { at: clock.now });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(answer);
    expect(shop.storefront.deploys()).toHaveLength(1);

    // Incident Commander sees the code as checkout runs it now.
    const now = await service(url);
    const file = (path: string) => now.files.find((f) => f.path === path)?.content;
    expect(now.version).toBe(PATCHED);
    expect(file("src/promotions.js")).toBe(FIXED);
    expect(file("test/promotions.test.js")).toBe("// regression tests\n");
    expect(JSON.parse(file("package.json")!)).toMatchObject({ name: "contoso-storefront", version: PATCHED });
    expect(file("deploys/HISTORY.md")).toContain(`| storefront v${PATCHED} | INC-1004: Match promotion codes without regard to case or spaces (approved by patniko) |`);
    expect(file("logs/shop.log")).toMatch(new RegExp(`level=info event=deploy service=downhill-shop storefront=${PATCHED.replace(/\./g, "\\.")} incident=INC-1004 approved_by=patniko msg="Match promotion codes without regard to case or spaces"`));
  });

  it("build on each other, and bump the version when the one sent is taken", async () => {
    const { url, clock } = await setup({ secret: SECRET });
    expect(await (await deploy(url, deployBody(), { at: clock.now })).json()).toMatchObject({ version: PATCHED });
    const second = deployBody({ incident: "INC-1005", files: [{ path: "src/cart.js", content: "export const cartFixed = true;\n" }] });
    const answer = await (await deploy(url, second, { at: clock.now, key: "session-2:call-1" })).json();
    expect(answer).toEqual({ version: nextPatch(PATCHED), message: `Downhill's shop now runs storefront v${nextPatch(PATCHED)}.` });
    const current = await service(url);
    expect(current.files.find((f) => f.path === "src/promotions.js")?.content).toBe(FIXED);
    expect(current.files.find((f) => f.path === "src/cart.js")?.content).toBe("export const cartFixed = true;\n");
    const third = await (await deploy(url, deployBody({ version: undefined, incident: "INC-1006" }), { at: clock.now, key: "session-3:call-1" })).json();
    expect(third).toMatchObject({ version: nextPatch(nextPatch(PATCHED)) });
  });
});

describe("the demo reset", () => {
  it("clears live sales, deployed versions, and the alert, keeping launch day's timeline", async () => {
    const { url, clock } = await setup({ secret: SECRET });
    await postJson(url, "/api/shop/events", { type: "promo_rejected", rider: "rider", skus: ["bike-lava"], subtotalCents: 399, code: "trail15", source: "banner", error: "Invalid code." });
    await deploy(url, deployBody(), { at: clock.now });
    expect((await info(url)).version).toBe(PATCHED);
    const timeline = ((await (await fetch(`${url}/api/status`)).json()) as { timeline: unknown }).timeline;

    expect((await postJson(url, "/api/demo/reset", {}, { origin: "https://attacker.example" })).status).toBe(403);
    // PowerShell's Invoke-RestMethod sends a form content type with no body: no body is no options.
    expect((await raw(url, "/api/demo/reset", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "0" } })).status).toBe(200);
    const reset = await fetch(`${url}/api/demo/reset`, { method: "POST" });
    expect(reset.status).toBe(200);
    expect(((await reset.json()) as { message: string }).message).toBe(`Demo reset: live sales, deployed fixes, and the alert are cleared, and checkout runs storefront v${ORIGINAL} again.`);
    expect(await info(url)).toMatchObject({ version: ORIGINAL, source: "original" });
    const csv = await (await fetch(`${url}/api/sales.csv`)).text();
    expect(csv).not.toContain(",live");
    expect(csv).toContain(",simulated");
    const status = (await (await fetch(`${url}/api/status`)).json()) as { timeline: unknown; liveEvents: number; alerts: { firing: boolean } };
    expect(status).toMatchObject({ timeline, liveEvents: 0, alerts: { firing: false } });

    // Starting launch day over moves it to now.
    clock.now += 60 * MINUTE;
    await postJson(url, "/api/demo/reset", { timeline: "restart" });
    const restarted = (await (await fetch(`${url}/api/status`)).json()) as { timeline: { startedAt: string; launchAt: string } };
    expect(restarted.timeline).toMatchObject({ startedAt: new Date(clock.now).toISOString(), launchAt: new Date(clock.now - 180 * MINUTE).toISOString() });
  });
});

describe("launch day", () => {
  it("starts over by itself once it's more than a day old, so the story and the sales stay a day's worth", async () => {
    const { url, clock } = await setup();
    const timeline = async () => ((await (await fetch(`${url}/api/status`)).json()) as { timeline: { startedAt: string } }).timeline;
    const first = await timeline();
    clock.now += LAUNCH_DAY - MINUTE;
    expect(await timeline()).toEqual(first);
    const dayOld = ((await (await fetch(`${url}/api/sales`)).json()) as { rows: SalesRow[] }).rows;

    clock.now += 2 * MINUTE;
    const rows = ((await (await fetch(`${url}/api/sales`)).json()) as { rows: SalesRow[] }).rows;
    expect(await timeline()).toMatchObject({ startedAt: new Date(clock.now).toISOString() });
    expect(Math.max(...rows.map((row) => row.minutes_since_launch))).toBeLessThanOrEqual(180);
    expect(rows.length).toBeLessThan(dayOld.length / 4);
  });
});
