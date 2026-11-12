import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseServiceUrls } from "../src/server/config.js";
import { ServiceCatalog, ServiceLoadError } from "../src/server/services.js";
import { FakeRemoteService, testConfig } from "./fakes.js";

const demoDir = testConfig().demoServicesDir;
const MB = 1024 * 1024;

/** The message `run` throws. */
function thrown(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("It didn't throw.");
}

describe("INCIDENT_SERVICE_URLS", () => {
  it("reads comma-separated name=url pairs", () => {
    expect(
      loadConfig({ INCIDENT_SERVICE_URLS: " downhill-shop=http://localhost:7455/api/incident/service , billing=https://billing.example.com/incident?view=a=b," }).remoteServices,
    ).toEqual([
      { name: "downhill-shop", url: "http://localhost:7455/api/incident/service" },
      { name: "billing", url: "https://billing.example.com/incident?view=a=b" },
    ]);
    expect(loadConfig({}).remoteServices).toBeUndefined();
  });

  it("refuses what it can't use, in plain words, without repeating a URL", () => {
    expect(() => loadConfig({ INCIDENT_SERVICE_URLS: "downhill-shop" })).toThrow(ConfigError);
    expect(thrown(() => parseServiceUrls("downhill-shop"))).toContain("entry 1 isn't name=url");
    expect(thrown(() => parseServiceUrls("Downhill Shop=http://x.test/"))).toContain('"Downhill Shop" isn\'t a service name');
    expect(thrown(() => parseServiceUrls("shop=ftp://x.test/"))).toBe("INCIDENT_SERVICE_URLS: the URL for shop isn't an http:// or https:// URL.");
    expect(thrown(() => parseServiceUrls("shop=localhost:7455"))).toContain("isn't an http:// or https:// URL");
    expect(thrown(() => parseServiceUrls("shop=https://deploy:hunter2@x.test/"))).toContain("has a user name or password in it");
    expect(thrown(() => parseServiceUrls("shop=http://a.test/,shop=http://b.test/"))).toContain("shop is listed twice");
    // A URL where the name belongs: its password isn't repeated.
    const misplaced = thrown(() => parseServiceUrls("https://deploy:hunter2@x.test/?a=b"));
    expect(misplaced).toContain("The name of entry 1 isn't a service name");
    expect(misplaced).not.toContain("hunter2");
  });
});

describe("a service over HTTP", () => {
  it("is found, copied, and compared from what it publishes, read again each time", async () => {
    const shop = new FakeRemoteService();
    const catalog = shop.catalog();
    expect(await catalog.find("downhill-shop")).toEqual({ name: "downhill-shop", demo: false, version: "1.0.0" });
    const workspace = await catalog.workspace("downhill-shop", undefined);
    expect([...workspace.files.keys()].sort()).toEqual(["README.md", "deploys/HISTORY.md", "logs/shop.log", "package.json", "src/promotions.js", "test/promotions.test.js"]);
    expect(workspace).toMatchObject({ version: "1.0.0" });
    expect(workspace.stats).toBeUndefined();
    // What deployed: its code and tests, without the logs and deploy history.
    expect([...(await catalog.originals("downhill-shop")).keys()].sort()).toEqual(["README.md", "package.json", "src/promotions.js", "test/promotions.test.js"]);
    expect(shop.requests[0]).toEqual({ url: shop.url, accept: "application/json", redirect: "error" });

    // A fix was deployed to it: the next read has it.
    shop.version = "1.0.1";
    shop.files["src/promotions.js"] = "export const fixed = true;\r\n";
    expect((await catalog.originals("downhill-shop")).get("src/promotions.js")).toBe("export const fixed = true;\n");
    expect((await catalog.find("downhill-shop"))?.version).toBe("1.0.1");
    expect(shop.requests).toHaveLength(5);
    // Without a version in its answer, its package.json says.
    shop.version = undefined;
    expect((await catalog.find("downhill-shop"))?.version).toBe("1.0.0");
  });

  it("comes after your own folder of the same name, and before the bundled demo service", async () => {
    const own = mkdtempSync(join(tmpdir(), "incident-services-"));
    mkdirSync(join(own, "downhill-shop"));
    writeFileSync(join(own, "downhill-shop", "package.json"), JSON.stringify({ version: "9.9.9" }));
    const shop = new FakeRemoteService();
    const checkout = new FakeRemoteService("checkout");
    const catalog = new ServiceCatalog(demoDir, own, {
      remote: [shop.service, checkout.service],
      fetch: (input, init) => (String(input) === checkout.url ? checkout : shop).fetch(input, init),
    });
    expect(await catalog.find("downhill-shop")).toEqual({ name: "downhill-shop", demo: false, version: "9.9.9" });
    expect(shop.requests).toEqual([]);
    expect(await catalog.find("checkout")).toEqual({ name: "checkout", demo: false, version: "1.0.0" });
    expect(await new ServiceCatalog(demoDir).find("checkout")).toMatchObject({ demo: true });
  });

  it("says why it can't be loaded, instead of giving an empty folder", async () => {
    const shop = new FakeRemoteService();
    const catalog = shop.catalog();
    const reason = async (): Promise<string> => {
      const error: unknown = await catalog.workspace("downhill-shop", undefined).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(ServiceLoadError);
      const message = (error as ServiceLoadError).message;
      expect(message.startsWith(`Couldn't load downhill-shop from ${shop.url}: `)).toBe(true);
      return message.slice(`Couldn't load downhill-shop from ${shop.url}: `.length);
    };
    const answer = (body: unknown, init?: ResponseInit) => () => (typeof body === "string" ? new Response(body, init) : Response.json(body, init));
    const files = (...list: unknown[]) => answer({ name: "downhill-shop", version: "1.0.0", files: list });

    shop.answer = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7455"), { code: "ECONNREFUSED" }) });
    expect(await reason()).toBe("it isn't reachable (ECONNREFUSED).");
    shop.answer = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(await reason()).toBe("it didn't answer within 10 s.");
    shop.answer = answer({ error: { code: "starting", message: "The shop is still starting." } }, { status: 503 });
    expect(await reason()).toBe("it answered HTTP 503. The shop is still starting.");
    shop.answer = answer("<!doctype html><title>Downhill</title>");
    expect(await reason()).toBe("its answer isn't JSON.");
    shop.answer = answer("{}", { headers: { "content-length": String(60 * MB) } });
    expect(await reason()).toBe("its answer is larger than 48 MB.");
    shop.answer = answer([{ path: "src/a.js", content: "" }]);
    expect(await reason()).toBe("its answer isn't a JSON object with name, version, and files.");
    shop.answer = answer({ name: "checkout", files: [{ path: "src/a.js", content: "" }] });
    expect(await reason()).toBe('its answer is for "checkout", not "downhill-shop".');
    shop.answer = answer({ name: "downhill-shop", version: 1, files: [{ path: "src/a.js", content: "" }] });
    expect(await reason()).toBe("its version isn't a string.");
    shop.answer = files();
    expect(await reason()).toBe("it sent no files.");
    for (const path of ["../etc/passwd", "/etc/passwd", "src\\a.js", "src//a.js", "./src/a.js"]) {
      shop.answer = files({ path, content: "" });
      expect(await reason()).toBe(`"${path}" isn't a relative path inside the service's folder.`);
    }
    shop.answer = files({ content: "" });
    expect(await reason()).toBe("file 1 has no path.");
    shop.answer = files({ path: "src/a.js", content: "a" }, { path: "src/a.js", content: "b" });
    expect(await reason()).toBe("it sent src/a.js twice.");
    shop.answer = files({ path: "src/a.js", content: 42 });
    expect(await reason()).toBe("src/a.js has no text content.");
    shop.answer = files({ path: "logo.png", content: "\u0089PNG\u0000\u0001" });
    expect(await reason()).toBe("logo.png isn't text.");
    shop.answer = files(...Array.from({ length: 401 }, (_, index) => ({ path: `src/${index}.js`, content: "" })));
    expect(await reason()).toBe("it sent 401 files; Incident Commander takes at most 400.");
    shop.answer = files({ path: "src/big.js", content: "x".repeat(2 * MB + 1) });
    expect(await reason()).toBe("src/big.js is larger than 2 MB.");
    shop.answer = files(...Array.from({ length: 13 }, (_, index) => ({ path: `data/${index}.txt`, content: "x".repeat(2 * MB) })));
    expect(await reason()).toBe("its files add up to more than 24 MB.");

    // The other reads fail the same way: never an empty folder.
    shop.answer = new TypeError("fetch failed");
    await expect(catalog.originals("downhill-shop")).rejects.toThrow(ServiceLoadError);
    await expect(catalog.find("downhill-shop")).rejects.toThrow("Couldn't load downhill-shop");
  });
});
