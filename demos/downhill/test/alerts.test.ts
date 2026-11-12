import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALERT_ID, ALERTS_OFF } from "../src/server/alerts.js";
import { sign } from "../src/server/deploys.js";
import type { DownhillShop } from "../src/server/downhill.js";
import { MINUTE } from "../src/server/timeline.js";
import { fakeServer, postJson, start, START, testConfig, testShop, type Clock } from "./helpers.js";

const ALERT_SECRET = "alert-secret-for-tests";
const DEPLOY_SECRET = "deploy-secret-for-tests";
const rejected = (rider = "mona") => ({ type: "promo_rejected", rider, skus: ["mona-neon"], subtotalCents: 499, code: "trail15", source: "banner", error: "Invalid code." });

async function setup(incidentUrl: string | undefined, clock: Clock = { now: START }) {
  const config = testConfig({ ...(incidentUrl ? { incidentUrl, incidentAlertSecret: ALERT_SECRET } : {}), deploySecret: DEPLOY_SECRET });
  const shop = testShop(config, clock);
  return { shop, clock, url: await start({ config, shop }) };
}

async function rejectLive(url: string, shop: DownhillShop): Promise<void> {
  expect((await postJson(url, "/api/shop/events", rejected())).status).toBe(204);
  await shop.alerts.settled();
}

describe("the shop's alert to Incident Commander", () => {
  it("fires once when a live player's code is rejected while checkout is failing, and resolves after a deploy", async () => {
    const incident = await fakeServer({ status: 202, body: { incident: "INC-1004" } });
    const { url, shop, clock } = await setup(incident.url);
    // Simulated rejections alone never alert: only a live player's does.
    expect(incident.received).toHaveLength(0);

    await rejectLive(url, shop);
    expect(incident.received).toHaveLength(1);
    const [fired] = incident.received;
    expect(fired).toMatchObject({ method: "POST", url: "/api/alerts" });
    expect(fired!.headers.authorization).toBe(`Bearer ${ALERT_SECRET}`);
    expect(fired!.body).toEqual({
      title: "Downhill shop: launch code rejected at checkout",
      service: "downhill-shop",
      severity: "major",
      status: "firing",
      id: ALERT_ID,
      summary: expect.stringMatching(/^\d+ of \d+ promo checkouts failed in the last 10 minutes: "Invalid code\."$/),
      description: expect.stringMatching(/^Since the launch-week banner went live at \d\d:\d\d UTC \(Downhill shop 1\.1\.0: launch-week banner with one-click Apply code\), most promo checkouts fail; before it, \d+% of codes went through\.$/),
      labels: { team: "shop", env: "production" },
    });
    const [n, m] = (fired!.body as { summary: string }).summary.match(/\d+/g)!.map(Number);
    expect(n).toBeGreaterThanOrEqual(3);
    expect(n! / m!).toBeGreaterThan(0.5);
    expect(((await (await fetch(`${url}/api/status`)).json()) as { alerts: unknown }).alerts).toMatchObject({ configured: true, firing: true });

    // Already firing: more rejections don't alert again.
    clock.now += MINUTE;
    await rejectLive(url, shop);
    expect(incident.received).toHaveLength(1);

    // A deploy resolves it, with the same id.
    clock.now += 4 * MINUTE;
    const body = JSON.stringify({ type: "incident.deploy_approved", incident: "INC-1004", service: "downhill-shop", summary: "Case-insensitive codes", files: [{ path: "src/promotions.js", content: "export {};\n" }] });
    const deployed = await fetch(`${url}/api/deploys`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "k1", "x-incident-commander-signature": sign(DEPLOY_SECRET, body, clock.now) }, body });
    expect(deployed.status).toBe(200);
    await shop.alerts.settled();
    expect(incident.received).toHaveLength(2);
    expect(incident.received[1]!.body).toMatchObject({ id: ALERT_ID, status: "resolved", service: "downhill-shop", title: "Downhill shop: launch code rejected at checkout" });
    expect(shop.alerts.firing).toBe(false);

    // After the fix, checkout works again, so the rule no longer holds: not even right after the deploy, while the last
    // 10 minutes still hold the rejections from before it.
    clock.now += MINUTE;
    await rejectLive(url, shop);
    expect(incident.received).toHaveLength(2);
    clock.now += 15 * MINUTE;
    await rejectLive(url, shop);
    expect(incident.received).toHaveLength(2);
  });

  it("keeps paging when its state can't be saved, and never takes the server down", async () => {
    const incident = await fakeServer({ status: 202, body: {} });
    const config = testConfig({ incidentUrl: incident.url, incidentAlertSecret: ALERT_SECRET, deploySecret: DEPLOY_SECRET });
    // A folder where the state file goes: every save fails.
    mkdirSync(join(config.dataDir, "alert.json"));
    const clock = { now: START };
    const shop = testShop(config, clock);
    const url = await start({ config, shop });

    await rejectLive(url, shop);
    expect(incident.received.map((received) => (received.body as { status: string }).status)).toEqual(["firing"]);
    expect(shop.alerts.firing).toBe(true);
    expect((await fetch(`${url}/api/health`)).status).toBe(200);

    clock.now += MINUTE;
    const body = JSON.stringify({ type: "incident.deploy_approved", incident: "INC-1004", service: "downhill-shop", summary: "Case-insensitive codes", files: [{ path: "src/promotions.js", content: "export {};\n" }] });
    const deployed = await fetch(`${url}/api/deploys`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "k1", "x-incident-commander-signature": sign(DEPLOY_SECRET, body, clock.now) }, body });
    expect(deployed.status).toBe(200);
    await shop.alerts.settled();
    expect(incident.received.map((received) => (received.body as { status: string }).status)).toEqual(["firing", "resolved"]);
  });

  it("is off without INCIDENT_URL and INCIDENT_ALERT_SECRET, and says so", async () => {
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    const clock = { now: START };
    const config = testConfig({ incidentUrl: "http://incident-commander.test" });
    const shop = testShop(config, clock, counting);
    const url = await start({ config, shop });
    await rejectLive(url, shop);
    expect(calls).toBe(0);
    const status = (await (await fetch(`${url}/api/status`)).json()) as { alerts: unknown };
    expect(status.alerts).toEqual({ configured: false, firing: false, message: ALERTS_OFF });
    expect(ALERTS_OFF).toBe("Alerts are off: set INCIDENT_URL and INCIDENT_ALERT_SECRET to send the shop's alert to Incident Commander.");
  });

  it("never breaks checkout when Incident Commander is down, and tries again on the next rejection", async () => {
    let up = false;
    const incident = await fakeServer((_req, res) => {
      res.writeHead(up ? 202 : 503, { "content-type": "application/json" }).end(JSON.stringify(up ? {} : { error: { code: "starting", message: "Incident Commander is starting." } }));
    });
    const { url, shop, clock } = await setup(incident.url);
    await rejectLive(url, shop);
    expect(incident.received).toHaveLength(1);
    expect(shop.alerts.firing).toBe(false);
    up = true;
    clock.now += MINUTE;
    await rejectLive(url, shop);
    expect(incident.received).toHaveLength(2);
    expect(shop.alerts.firing).toBe(true);
  });
});
