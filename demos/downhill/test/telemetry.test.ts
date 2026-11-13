import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/server/log.js";
import { createTelemetry, OtlpJsonLogExporter, type Telemetry } from "../src/server/telemetry.js";
import { fakeServer, postJson, start, START, testConfig, testShop } from "./helpers.js";
import { DownhillShop } from "../src/server/downhill.js";

const telemetries: Telemetry[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(telemetries.splice(0).map((telemetry) => telemetry.shutdown()));
});

function inMemory(): { exporter: InMemoryLogRecordExporter; telemetry: Telemetry } {
  const exporter = new InMemoryLogRecordExporter();
  const telemetry = createTelemetry({ exporter, version: "1.0.0", delayMs: 5 });
  telemetries.push(telemetry);
  return { exporter, telemetry };
}

/** A second before the server's clock: browsers' times are taken when they're this close. */
const at = START - 1_000;

describe("telemetry", () => {
  it("is off without Incident Commander's address and alert secret", () => {
    const telemetry = createTelemetry({ incidentUrl: "http://localhost:7445", version: "1.0.0" });
    expect(telemetry.configured).toBe(false);
    expect(telemetry.status().message).toContain("set INCIDENT_URL and INCIDENT_ALERT_SECRET");
  });

  it("streams checkouts, what players do in the game, and the server's own log lines as OpenTelemetry log records", async () => {
    const { exporter, telemetry } = inMemory();
    const clock = { now: START };
    const url = await start({ shop: new DownhillShop(testConfig(), { now: () => clock.now, telemetry }) });

    const rejected = { type: "promo_rejected", rider: "mona", skus: ["mona-neon"], subtotalCents: 499, code: "trail15", source: "banner", error: "Invalid code." };
    expect((await postJson(url, "/api/shop/events", rejected)).status).toBe(204);
    const ride = { rider: "mona", world: "citadel", worldName: "Citadel Coast" };
    const events = [
      { ...ride, type: "ride_started", at },
      { ...ride, type: "trick", at, title: "Backflip + Superman", points: 1240, combo: 2, perfect: true },
      { ...ride, type: "crash", at: at + 120_000, reason: "Out of bounds!", kmh: 48 },
      { rider: "mona", type: "cart_added", at, sku: "mona-neon" },
    ];
    expect((await postJson(url, "/api/game/events", { events })).status).toBe(204);
    // Tests log errors only; lines below the level aren't exported either.
    log.error("Request failed", { event: "http.failed", error: "boom", token: "ghp_should_not_leave" });
    await telemetry.flush();

    const records = exporter.getFinishedLogRecords();
    expect(records[0]?.resource.attributes).toMatchObject({ "service.name": "downhill-shop", "service.version": "1.0.0" });
    expect(records.map((record) => ({ event: record.eventName, severity: record.severityText, body: record.body, attributes: record.attributes }))).toEqual([
      {
        event: "shop.promo_rejected",
        severity: "WARN",
        body: "Checkout rejected code trail15 for Mona: Invalid code.",
        attributes: { player: "Mona", source: "live", skus: "mona-neon", subtotal_cents: 499, code: "trail15", code_source: "banner", error: "Invalid code." },
      },
      { event: "ride.started", severity: "INFO", body: "Mona dropped in on Citadel Coast", attributes: { player: "Mona", rider: "mona", world: "citadel", source: "live" } },
      {
        event: "ride.trick",
        severity: "INFO",
        body: "Mona landed Backflip + Superman for 1,240 points (×2 combo, perfect landing)",
        attributes: { player: "Mona", rider: "mona", world: "citadel", source: "live", title: "Backflip + Superman", points: 1240, combo: 2, perfect: true },
      },
      // A browser clock two minutes off: the server's time instead.
      { event: "ride.crash", severity: "INFO", body: "Mona crashed on Citadel Coast: Out of bounds at 48 km/h", attributes: { player: "Mona", rider: "mona", world: "citadel", source: "live", reason: "Out of bounds", kmh: 48 } },
      { event: "shop.cart_added", severity: "INFO", body: "Mona added Neon Mona to the cart ($4.99)", attributes: { player: "Mona", rider: "mona", source: "live", sku: "mona-neon", price_cents: 499 } },
      { event: "http.failed", severity: "ERROR", body: "Request failed", attributes: { error: "boom", token: "***" } },
    ]);
    expect(records[1]?.hrTime).toEqual([Math.floor(at / 1000), (at % 1000) * 1e6]);
    expect(records[3]?.hrTime).toEqual([Math.floor(START / 1000), 0]);
  });

  it("refuses game events it can't send, in plain words", async () => {
    const url = await start({ shop: testShop(testConfig()) });
    const refused = async (body: unknown) => ((await (await postJson(url, "/api/game/events", body)).json()) as { error: { message: string } }).error.message;
    expect(await refused({ events: [] })).toBe("Send events: 1 to 25 game events.");
    expect(await refused({ events: [{ type: "teleport", rider: "mona" }] })).toContain("Send type: one of ride_started");
    expect(await refused({ events: [{ type: "ride_started", rider: "octocat" }] })).toBe("Send rider: one of rider, mona, copilot.");
    expect(await refused({ events: [{ type: "cart_added", rider: "mona", sku: "free-money" }] })).toBe('The shop doesn\'t sell "free-money".');
    expect(await refused({ events: [{ type: "trick", rider: "mona", title: "Flip", points: -5, combo: 1 }] })).toBe("Send points as a number from 0 to 10000000.");
  });

  it("sends OTLP/HTTP JSON to Incident Commander's logs endpoint with its alert secret, and nothing from the environment", async () => {
    // Aspire's dashboard key: OpenTelemetry's own OTLP exporter would add it to every request.
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "x-otlp-api-key=dashboard-key");
    const incident = await fakeServer({ status: 200, body: { partialSuccess: {} } });
    const telemetry = createTelemetry({ incidentUrl: incident.url, secret: "alert-secret", version: "1.0.0", delayMs: 5, bridgeLog: false });
    telemetries.push(telemetry);
    expect(telemetry.status()).toEqual({ configured: true, endpoint: `${incident.url}/api/otlp/v1/logs` });
    telemetry.emit({ name: "shop.promo_rejected", level: "warn", message: "Checkout rejected code trail15 for Mona: Invalid code.", attributes: { code: "trail15", subtotal_cents: 499 }, at });
    await telemetry.flush();

    expect(incident.received).toHaveLength(1);
    const [request] = incident.received;
    expect(request).toMatchObject({ method: "POST", url: "/api/otlp/v1/logs", headers: { authorization: "Bearer alert-secret", "content-type": "application/json" } });
    expect(request?.headers["x-otlp-api-key"]).toBeUndefined();
    expect(request?.body).toMatchObject({
      resourceLogs: [
        {
          resource: { attributes: expect.arrayContaining([{ key: "service.name", value: { stringValue: "downhill-shop" } }]) },
          scopeLogs: [
            {
              scope: { name: "downhill", version: "1.0.0" },
              logRecords: [
                {
                  timeUnixNano: `${at}000000`,
                  severityNumber: 13,
                  severityText: "WARN",
                  eventName: "shop.promo_rejected",
                  body: { stringValue: "Checkout rejected code trail15 for Mona: Invalid code." },
                  attributes: [
                    { key: "code", value: { stringValue: "trail15" } },
                    { key: "subtotal_cents", value: { intValue: 499 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("says why an export failed, in plain words", async () => {
    const refusing = await fakeServer({ status: 401, body: { error: { code: "unauthorized", message: "Send the alert secret as a bearer token." } } });
    const records = new InMemoryLogRecordExporter();
    const result = (url: string) => new Promise((resolve) => new OtlpJsonLogExporter(url, {}).export([...records.getFinishedLogRecords()], resolve));
    expect(await result(`${refusing.url}/api/otlp/v1/logs`)).toMatchObject({ code: 1, error: { message: "it answered HTTP 401 (Send the alert secret as a bearer token.)" } });
    expect(await result("http://127.0.0.1:9/api/otlp/v1/logs")).toMatchObject({ code: 1, error: { message: expect.stringMatching(/^it isn't reachable \(/) } });
  });
});
