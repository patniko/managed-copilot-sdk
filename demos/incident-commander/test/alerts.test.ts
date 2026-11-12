import { describe, expect, it } from "vitest";
import { authorized, parseAlertPayload, serviceOf, severityOf } from "../src/server/alerts.js";

const NOW = new Date("2026-11-04T07:00:00.000Z");

const alertmanager = {
  version: "4",
  status: "firing",
  receiver: "incident-commander",
  commonLabels: { alertname: "CheckoutHighErrorRate", service: "checkout", severity: "critical" },
  commonAnnotations: { summary: "Checkout 5xx error rate is 12% (threshold 2%)" },
  alerts: [
    {
      status: "firing",
      labels: { alertname: "CheckoutHighErrorRate", service: "checkout", severity: "critical", env: "production" },
      annotations: { summary: "Checkout 5xx error rate is 12% (threshold 2%)", description: "31 of 260 checkouts failed", runbook_url: "https://runbooks.example.com/checkout" },
      startsAt: "2026-11-04T06:55:00Z",
      endsAt: "0001-01-01T00:00:00Z",
      generatorURL: "https://prometheus.example.com/graph?g0.expr=x",
      fingerprint: "c7d1f2",
    },
  ],
};

describe("alerts", () => {
  it("reads an Alertmanager notification", () => {
    const [incoming] = parseAlertPayload(alertmanager, NOW);
    expect(incoming).toEqual({
      status: "firing",
      alert: {
        source: "alertmanager",
        name: "CheckoutHighErrorRate",
        summary: "Checkout 5xx error rate is 12% (threshold 2%)",
        description: "31 of 260 checkouts failed",
        service: "checkout",
        severity: "SEV1",
        labels: { alertname: "CheckoutHighErrorRate", service: "checkout", severity: "critical", env: "production" },
        startsAt: "2026-11-04T06:55:00.000Z",
        fingerprint: "c7d1f2",
        links: [
          { title: "Runbook", url: "https://runbooks.example.com/checkout" },
          { title: "Source", url: "https://prometheus.example.com/graph?g0.expr=x" },
        ],
      },
    });
  });

  it("tells Grafana's notifications apart and reads a resolved alert", () => {
    const grafana = { ...alertmanager, orgId: 1, alerts: [{ ...alertmanager.alerts[0], status: "resolved", endsAt: "2026-11-04T07:05:00Z", dashboardURL: "https://grafana.example.com/d/abc" }] };
    const [incoming] = parseAlertPayload(grafana, NOW);
    expect(incoming?.status).toBe("resolved");
    expect(incoming?.alert.source).toBe("grafana");
    expect(incoming?.alert.resolvedAt).toBe("2026-11-04T07:05:00.000Z");
    expect(incoming?.alert.links.map((link) => link.title)).toContain("Dashboard");
  });

  it("reads the small generic shape, with a stable fingerprint", () => {
    const body = { title: "Payments latency", service: "Payments API", severity: "warning", summary: "p99 is 2.4 s" };
    const [first] = parseAlertPayload(body, NOW);
    const [second] = parseAlertPayload(body, NOW);
    expect(first?.alert).toMatchObject({ source: "generic", name: "Payments latency", summary: "p99 is 2.4 s", service: "payments-api", severity: "SEV3", startsAt: NOW.toISOString() });
    expect(first?.alert.fingerprint).toBe(second?.alert.fingerprint);
    expect(parseAlertPayload({ ...body, status: "resolved", id: "pay-1" }, NOW)[0]).toMatchObject({ status: "resolved", alert: { fingerprint: "pay-1" } });
    // A resolved notification may name its alert by ID alone; a firing one needs a title.
    expect(parseAlertPayload({ id: "pay-1", status: "resolved" }, NOW)[0]).toMatchObject({ status: "resolved", alert: { fingerprint: "pay-1", resolvedAt: NOW.toISOString() } });
    expect(() => parseAlertPayload({ id: "pay-1" }, NOW)).toThrow(/isn't an alert/);
  });

  it("refuses what isn't an alert", () => {
    expect(() => parseAlertPayload([], NOW)).toThrow(/JSON object/);
    expect(() => parseAlertPayload({ alerts: [] }, NOW)).toThrow(/no alerts/);
    expect(() => parseAlertPayload({ hello: "world" }, NOW)).toThrow(/isn't an alert/);
    expect(() => parseAlertPayload({ alerts: Array.from({ length: 21 }, () => ({ labels: {} })) }, NOW)).toThrow(/at most 20/);
  });

  it("keeps alert text plain and bounded", () => {
    const [incoming] = parseAlertPayload({ title: "x\u0007y", summary: "a".repeat(5_000), service: "../../etc", url: "javascript:alert(1)" }, NOW);
    expect(incoming?.alert.name).toBe("xy");
    expect(incoming?.alert.summary.length).toBe(2_000);
    expect(incoming?.alert.service).toBe("etc");
    expect(incoming?.alert.links).toEqual([]);
  });

  it("maps severities and services", () => {
    expect(["critical", "P1", "sev1", "page"].map(severityOf)).toEqual(["SEV1", "SEV1", "SEV1", "SEV1"]);
    expect(["major", "high", "error", "SEV-2"].map(severityOf)).toEqual(["SEV2", "SEV2", "SEV2", "SEV2"]);
    expect(["warning", undefined, "whatever"].map(severityOf)).toEqual(["SEV3", "SEV3", "SEV3"]);
    expect(["info", "low", "p4"].map(severityOf)).toEqual(["SEV4", "SEV4", "SEV4"]);
    expect(serviceOf({ job: "Checkout" })).toBe("checkout");
    expect(serviceOf({ app: "web", job: "node-exporter" })).toBe("web");
    expect(serviceOf({})).toBe("unknown");
  });

  it("accepts the shared secret as a bearer token or a Basic password", () => {
    expect(authorized("Bearer s3cret", "s3cret")).toBe(true);
    expect(authorized(`Basic ${Buffer.from("alertmanager:s3cret").toString("base64")}`, "s3cret")).toBe(true);
    expect(authorized("Bearer wrong", "s3cret")).toBe(false);
    expect(authorized("Bearer ", "s3cret")).toBe(false);
    expect(authorized("Token s3cret", "s3cret")).toBe(false);
    expect(authorized(undefined, "s3cret")).toBe(false);
  });
});
