import { describe, expect, it } from "vitest";
import { TEMPLATES } from "../../src/shared/catalog.js";
import { pillStatus } from "../../src/web/lib/platform.js";
import { APPROVAL_LABELS, STYLE_META, STYLE_ORDER } from "../../src/web/lib/styles.js";

describe("platform pill", () => {
  it("names where the app runs: Local or Azure, else the deployment", () => {
    expect(pillStatus({ state: "connected", mode: "local", deployment: "copilot" }, "open")).toEqual({ tone: "success", label: "Local", headline: "Connected · Local" });
    expect(pillStatus({ state: "connected", mode: "azure", deployment: "copilot" }, "open").label).toBe("Azure");
    expect(pillStatus({ state: "connected", deployment: "staging" }, "open").label).toBe("staging");
  });

  it("spins while connecting, including Dispatch's own event stream, and turns red when unavailable", () => {
    expect(pillStatus(undefined, "connecting")).toMatchObject({ tone: "busy", headline: "Connecting to Managed Copilot…" });
    expect(pillStatus({ state: "reconnecting", mode: "local" }, "open")).toMatchObject({ tone: "busy", label: "Local" });
    expect(pillStatus({ state: "connected", mode: "local" }, "reconnecting")).toMatchObject({ tone: "busy", headline: "Reconnecting to Dispatch's server…" });
    expect(pillStatus({ state: "unavailable", message: "Nothing answers." }, "open")).toMatchObject({ tone: "danger", headline: "Managed Copilot isn't available" });
  });
});

describe("execution styles", () => {
  it("captions each style in eight words or fewer", () => {
    for (const style of STYLE_ORDER) expect(STYLE_META[style].caption.split(/\s+/).length).toBeLessThanOrEqual(8);
  });

  it("uses one pair of approval labels for every style and says what each covers in that style", () => {
    expect(APPROVAL_LABELS).toEqual({ ask: "Ask first", auto: "Run freely" });
    const meanings = STYLE_ORDER.map((style) => STYLE_META[style].approvals.ask);
    expect(new Set(meanings).size).toBe(STYLE_ORDER.length);
  });
});

describe("templates", () => {
  it("include one written for Mixed: math in the coordinator's own sandbox and a part that needs web access", () => {
    const mixed = TEMPLATES.filter((template) => template.style === "mixed");
    expect(mixed).toHaveLength(1);
    expect(mixed[0]!.uses.map((use) => use.kind).sort()).toEqual(["python", "web"]);
    expect(mixed[0]!.prompt).toMatch(/your own sandbox/);
  });

  it("describe themselves in one short line", () => {
    for (const template of TEMPLATES) expect(template.description.length).toBeLessThanOrEqual(45);
  });
});
