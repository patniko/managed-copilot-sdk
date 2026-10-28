import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APPS, WALKTHROUGHS, type GalleryState } from "../src/shared/catalog.js";
import { createGallery, type CloudLookup, type GalleryOptions } from "../src/server/gallery.js";
import { capture, cloudUrls, isLocalUrl, localUrls, normalizeGatewayUrl, probe } from "../src/server/targets.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("links", () => {
  it("uses the AppHost's fixed local ports, shifted by the port offset", () => {
    expect(localUrls(0)).toEqual({
      gatewayUrl: "http://localhost:7400",
      apps: { dispatch: "http://localhost:7470", "software-factory": "http://localhost:7480", assistant: "http://localhost:7490", console: "/open/console?target=local" },
    });
    expect(localUrls(300).apps.dispatch).toBe("http://localhost:7770");
  });

  it("puts deployed apps beside the gateway on the environment's domain", () => {
    const urls = cloudUrls("https://copilot.bravedesert-123.westus2.azurecontainerapps.io");
    expect(urls.gatewayUrl).toBe("https://copilot.bravedesert-123.westus2.azurecontainerapps.io");
    expect(urls.apps.dispatch).toBe("https://dispatch.bravedesert-123.westus2.azurecontainerapps.io");
    expect(urls.apps.assistant).toBe("https://assistant.bravedesert-123.westus2.azurecontainerapps.io");
    expect(urls.apps.console).toBe("/open/console?target=cloud");
  });

  it("offers only the console for a gateway on a custom host", () => {
    expect(cloudUrls("https://agents.example.com").apps).toEqual({ console: "/open/console?target=cloud" });
  });

  it("normalizes gateway URLs and tells local ones apart", () => {
    expect(normalizeGatewayUrl("copilot.example.io/")).toBe("https://copilot.example.io");
    expect(normalizeGatewayUrl(" https://copilot.example.io/path ")).toBe("https://copilot.example.io");
    expect(() => normalizeGatewayUrl("ftp://copilot.example.io")).toThrow();
    expect(isLocalUrl("http://localhost:7400")).toBe(true);
    expect(isLocalUrl("http://127.0.0.1:7400")).toBe(true);
    expect(isLocalUrl("https://copilot.example.io")).toBe(false);
  });

  it("has a unique id for every app and walkthrough", () => {
    const ids = [...APPS.map((app) => app.id), ...WALKTHROUGHS.map((w) => `sample-${w.id}`)];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("probe", () => {
  it("bounds a command that outlives its timeout", async () => {
    const started = Date.now();
    const result = await capture(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], 200);
    expect(result).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await capture(process.execPath, ["-e", "process.stdout.write('ok')"], 5_000)).toBe("ok");
  });

  it("reports online, IP-restricted, and offline", async () => {
    const url = await listen((req, res) => {
      res.statusCode = req.url === "/blocked" ? 403 : req.url === "/broken" ? 503 : 200;
      res.end();
    });
    expect(await probe(`${url}/ok`)).toBe("online");
    expect(await probe(`${url}/blocked`)).toBe("restricted");
    expect(await probe(`${url}/broken`)).toBe("offline");
    expect(await probe("http://127.0.0.1:1/", 500)).toBe("offline");
  });
});

describe("gallery server", () => {
  function gallery(overrides: Partial<GalleryOptions> = {}) {
    const webRoot = mkdtempSync(join(tmpdir(), "gallery-web-"));
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>gallery</title>");
    const shotsDir = mkdtempSync(join(tmpdir(), "gallery-shots-"));
    writeFileSync(join(shotsDir, "dispatch.png"), "png");
    return listen(
      createGallery({
        offset: 40_000,
        cloud: Promise.resolve<CloudLookup>({ note: "No deployment." }),
        webRoot,
        shotsDir,
        repoUrl: "https://github.com/o/r/blob/main/",
        openConsole: async () => ({ url: "http://localhost:47400/console/signin#ticket=t" }),
        ...overrides,
      }),
    );
  }

  it("serves the page, screenshots, and state", async () => {
    const url = await gallery();
    expect(await (await fetch(`${url}/`)).text()).toContain("gallery");
    expect(await (await fetch(`${url}/some/route`)).text()).toContain("gallery");
    expect(await (await fetch(`${url}/shots/dispatch.png`)).text()).toBe("png");
    expect((await fetch(`${url}/shots/missing.png`)).status).toBe(404);
    expect((await fetch(`${url}/shots/..%2F..%2Fpackage.json`)).status).toBe(404);

    const state = (await (await fetch(`${url}/api/gallery?refresh`)).json()) as GalleryState;
    expect(state.local.gatewayUrl).toBe("http://localhost:47400");
    expect(state.local.gateway).toBe("offline");
    expect(state.local.links.dispatch).toEqual({ url: "http://localhost:47470", health: "offline" });
    expect(state.cloud).toEqual({ links: {}, note: "No deployment." });
    expect(state.repoUrl).toBe("https://github.com/o/r/blob/main/");
  });

  it("redirects to a one-time console sign-in link", async () => {
    const asked: string[] = [];
    const url = await gallery({
      openConsole: async (gatewayUrl) => {
        asked.push(gatewayUrl);
        return { url: `${gatewayUrl}/console/signin#ticket=t` };
      },
    });
    const response = await fetch(`${url}/open/console?target=local`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:47400/console/signin#ticket=t");
    expect(asked).toEqual(["http://localhost:47400"]);
  });

  it("refuses requests for other host names", async () => {
    const url = await gallery();
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${url}/open/console?target=local`, { headers: { host: "attacker.example:7460" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.once("error", reject);
      req.end();
    });
    expect(status).toBe(421);
  });

  it("explains why the console can't open", async () => {
    const url = await gallery({ openConsole: async () => ({ message: "This deployment names no operators.", hint: "Set `Parameters:copilot-operator-users`." }) });
    const response = await fetch(`${url}/open/console?target=local`, { redirect: "manual" });
    expect(response.status).toBe(502);
    const html = await response.text();
    expect(html).toContain("names no operators");
    expect(html).toContain("<code>Parameters:copilot-operator-users</code>");

    const noCloud = await fetch(`${url}/open/console?target=cloud`, { redirect: "manual" });
    expect(noCloud.status).toBe(502);
    expect(await noCloud.text()).toContain("No Azure deployment");
  });
});
