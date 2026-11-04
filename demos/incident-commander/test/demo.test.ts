import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAlertPayload } from "../src/server/alerts.js";
import { demoProduction, sampleNotification } from "../src/server/demo.js";
import { ServiceCatalog } from "../src/server/services.js";
import { testConfig } from "./fakes.js";

const demoDir = testConfig().demoServicesDir;
const source = (path: string) => readFileSync(join(demoDir, "checkout", path), "utf8");
const SOURCES = { discounts: source("src/discounts.js"), cart: source("src/cart.js"), server: source("src/server.js") };
const SEED = { seed: 42, at: "2026-11-04T07:00:00.000Z" };

describe("the demo service's production", () => {
  it("is the same for the same seed, and different for another", () => {
    expect(demoProduction(SOURCES, SEED).log).toBe(demoProduction(SOURCES, SEED).log);
    expect(demoProduction(SOURCES, { ...SEED, seed: 43 }).log).not.toBe(demoProduction(SOURCES, SEED).log);
  });

  it("logs what the alert says: the failures since the deploy and the rate in the last five minutes", () => {
    const { log, stats } = demoProduction(SOURCES, SEED);
    const lines = log.trimEnd().split("\n");
    const at = (line: string) => Date.parse(line.slice(0, 24));
    const checkouts = lines.filter((line) => line.includes("path=/checkout"));
    const recent = checkouts.filter((line) => at(line) >= Date.parse(SEED.at) - 5 * 60_000);
    expect(recent.length).toBe(stats.checkoutsLast5m);
    expect(recent.filter((line) => line.includes("status=500")).length).toBe(stats.failedLast5m);
    expect(stats.errorRate).toBeGreaterThan(2);
    const failures = checkouts.filter((line) => line.includes("status=500"));
    expect(failures.length).toBe(stats.failedSinceDeploy);
    expect(failures.every((line) => at(line) >= Date.parse(stats.deployAt) && /coupon=(SUMMER24|SPRING25)/.test(line))).toBe(true);
    expect(log).toContain('msg="starting checkout-service" version=1.4.2');
  });

  it("points its stack traces at the real code", () => {
    const { log } = demoProduction(SOURCES, SEED);
    const line = SOURCES.discounts.replace(/\r\n/g, "\n").split("\n").findIndex((text) => text.includes("coupon.percent")) + 1;
    expect(log).toContain(`at applyDiscount (file:///srv/checkout/src/discounts.js:${line}:`);
    expect(log).toMatch(/at priceCart \(file:\/\/\/srv\/checkout\/src\/cart\.js:\d+:\d+\)/);
  });

  it("sends an Alertmanager notification whose numbers come from those logs", () => {
    const { stats } = demoProduction(SOURCES, SEED);
    const [incoming] = parseAlertPayload(sampleNotification(stats, SEED, "f1"));
    expect(incoming?.alert).toMatchObject({ source: "alertmanager", name: "CheckoutHighErrorRate", service: "checkout", severity: "SEV2", fingerprint: "f1" });
    expect(incoming?.alert.summary).toContain(`${stats.errorRate}%`);
    expect(incoming?.alert.description).toBe(`${stats.failedLast5m} of ${stats.checkoutsLast5m} checkouts failed in the last 5 minutes.`);
  });

  it("ships a deploy diff that matches the code", () => {
    let file = "";
    for (const line of source("deploys/v1.4.2.diff").replace(/\r\n/g, "\n").split("\n")) {
      const header = /^\+\+\+ b\/(.+)$/.exec(line);
      if (header) file = header[1]!;
      else if (line.startsWith("+")) expect(source(file).replace(/\r\n/g, "\n"), file).toContain(line.slice(1));
    }
    expect(file).toBe("test/discounts.test.js");
  });
});

describe("the service catalog", () => {
  it("gives the coordinator the demo service with its generated logs and deploy history", async () => {
    const catalog = new ServiceCatalog(demoDir);
    expect(await catalog.find("checkout")).toEqual({ name: "checkout", demo: true, version: "1.4.2" });
    const { files, stats } = await catalog.workspace("checkout", SEED);
    expect([...files.keys()].sort()).toEqual(
      expect.arrayContaining(["README.md", "deploys/HISTORY.md", "deploys/v1.4.2.diff", "logs/checkout.log", "package.json", "src/discounts.js", "test/cart.test.js"]),
    );
    expect(stats?.failedSinceDeploy).toBeGreaterThan(0);
    expect([...files.values()].every((text) => !text.includes("\r\n"))).toBe(true);
    expect((await catalog.originals("checkout")).has("logs/checkout.log")).toBe(false);
  });

  it("prefers your own service folders, skips what isn't source, and knows nothing else", async () => {
    const own = mkdtempSync(join(tmpdir(), "incident-services-"));
    mkdirSync(join(own, "payments", "src"), { recursive: true });
    mkdirSync(join(own, "payments", "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(own, "payments", "package.json"), JSON.stringify({ version: "3.2.1" }));
    writeFileSync(join(own, "payments", "src", "index.js"), "export const pay = () => 1;\r\n");
    writeFileSync(join(own, "payments", "node_modules", "left-pad", "index.js"), "module.exports = 1;");
    writeFileSync(join(own, "payments", "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const catalog = new ServiceCatalog(demoDir, own);
    expect(await catalog.find("payments")).toEqual({ name: "payments", demo: false, version: "3.2.1" });
    const { files, stats } = await catalog.workspace("payments", SEED);
    expect([...files.keys()].sort()).toEqual(["package.json", "src/index.js"]);
    expect(files.get("src/index.js")).toBe("export const pay = () => 1;\n");
    expect(stats).toBeUndefined();
    expect(await catalog.find("unknown")).toBeUndefined();
    expect(await catalog.find("../payments")).toBeUndefined();
    expect((await catalog.workspace("search", SEED)).files.size).toBe(0);
  });
});
