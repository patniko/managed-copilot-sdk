import { describe, expect, it } from "vitest";
import { buildSearch, encodeSegment, href, hrefs, matchRoute, parseQuery, routePath, routeView, viewHref } from "../src/lib/routes.js";

describe("matchRoute", () => {
  it("matches the home and list views", () => {
    expect(matchRoute("/console")).toEqual({ kind: "overview" });
    expect(matchRoute("/console/")).toEqual({ kind: "overview" });
    expect(matchRoute("/console/infrastructure")).toEqual({ kind: "infrastructure" });
    expect(matchRoute("/console/sessions/")).toEqual({ kind: "sessions" });
    for (const view of ["environments", "connections", "sandboxes", "schedules", "webhooks", "actions", "accounts", "events", "logs", "audit"]) {
      expect(matchRoute(`/console/${view}`)).toEqual({ kind: view });
    }
  });

  it("matches detail views and decodes their IDs", () => {
    expect(matchRoute("/console/environments/data-science")).toEqual({ kind: "environment", name: "data-science" });
    expect(matchRoute("/console/sessions/3f2a9c1e-7b4d")).toEqual({ kind: "session", id: "3f2a9c1e-7b4d" });
    expect(matchRoute("/console/sessions/my%2Esession%20one")).toEqual({ kind: "session", id: "my.session one" });
  });

  it("matches the sign-in page", () => {
    expect(matchRoute("/console/signin")).toEqual({ kind: "signin" });
  });

  it("reports unknown paths", () => {
    expect(matchRoute("/console/nope")).toEqual({ kind: "not-found", path: "/console/nope" });
    expect(matchRoute("/console/connections/abc")).toEqual({ kind: "not-found", path: "/console/connections/abc" });
    expect(matchRoute("/console/sessions/a/b")).toEqual({ kind: "not-found", path: "/console/sessions/a/b" });
    expect(matchRoute("/consolex")).toEqual({ kind: "not-found", path: "/consolex" });
    expect(matchRoute("/console/sessions/%E0%A4%A")).toEqual({ kind: "not-found", path: "/console/sessions/%E0%A4%A" });
  });
});

describe("paths", () => {
  it("round-trips routes", () => {
    for (const route of [
      { kind: "overview" },
      { kind: "sessions" },
      { kind: "session", id: "weird id/with.dots" },
      { kind: "environment", name: "dev" },
    ] as const) {
      expect(matchRoute(routePath(route))).toEqual(route);
    }
  });

  it("encodes reserved characters in segments", () => {
    expect(encodeSegment("a b/c")).toBe("a%20b%2Fc");
    expect(hrefs.session("my.session")).toBe("/console/sessions/my.session");
  });

  it("builds query strings without empty values", () => {
    expect(buildSearch({ state: "running", owner: "", q: undefined, limit: 100, live: false })).toBe("?state=running&limit=100");
    expect(buildSearch({})).toBe("");
    expect(href({ kind: "sessions" }, { environment: "dev" })).toBe("/console/sessions?environment=dev");
    expect(parseQuery("?a=1&b=two%20words")).toEqual({ a: "1", b: "two words" });
  });

  it("resolves view references", () => {
    expect(viewHref("sessions", "abc")).toBe("/console/sessions/abc");
    expect(viewHref("environments", "dev")).toBe("/console/environments/dev");
    expect(viewHref("sandboxes", "sbx_1")).toBe("/console/sandboxes");
    expect(viewHref("overview")).toBe("/console/");
    expect(routeView({ kind: "session", id: "x" })).toBe("sessions");
    expect(routeView({ kind: "not-found", path: "/x" })).toBeUndefined();
  });
});
