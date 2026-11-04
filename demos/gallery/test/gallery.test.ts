import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { APPS, BUILDING_BLOCKS, PATTERNS, WALKTHROUGHS, type BuildingBlock, type GalleryState } from "../src/shared/catalog.js";
import { createGallery, type CloudLookup, type GalleryOptions } from "../src/server/gallery.js";
import { capture, cloudUrls, isLocalUrl, localUrls, normalizeGatewayUrl, probe } from "../src/server/targets.js";
import { appHref, COMPARE_APP_ID, compareApp, patternsOf, SHAPES, walkthroughCommand } from "../src/web/model.js";

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
      apps: {
        dispatch: "http://localhost:7470",
        "software-factory": "http://localhost:7480",
        assistant: "http://localhost:7490",
        "research-swarm": "http://localhost:7425",
        console: "/open/console?target=local",
      },
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

  it("leaves the console out when asked (a hosted gallery)", () => {
    expect(cloudUrls("https://copilot.d.io", { console: false }).apps).toEqual({
      dispatch: "https://dispatch.d.io",
      "software-factory": "https://software-factory.d.io",
      assistant: "https://assistant.d.io",
      "research-swarm": "https://research-swarm.d.io",
    });
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
    for (const ids of [APPS.map((app) => app.id), WALKTHROUGHS.map((walkthrough) => walkthrough.id)]) expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("patterns", () => {
  const apphost = readFileSync(fileURLToPath(new URL("../../../apphost.mts", import.meta.url)), "utf8");
  /** An environment's declaration in the root AppHost: one line, or a block closed at the same indent. */
  const declaration = (name: string) => apphost.match(new RegExp(`^( +)${name}: \\{(?:[^\\n]*\\},?|[\\s\\S]*?\\n\\1\\},?)`, "m"))?.[0];

  it("lists the six patterns, made of the three building blocks", () => {
    expect(PATTERNS.map((pattern) => pattern.id)).toEqual(["isolated", "shared", "promotable", "direct", "delegate", "mixed"]);
    expect(new Set(PATTERNS.flatMap((pattern) => pattern.blocks))).toEqual(new Set(Object.keys(BUILDING_BLOCKS)));
  });

  it("links runnable walkthroughs and the gallery's apps", () => {
    for (const pattern of PATTERNS) {
      expect(WALKTHROUGHS.find((walkthrough) => walkthrough.id === pattern.walkthrough)?.runnable, pattern.id).toBe(true);
      for (const demo of pattern.demos) expect(APPS.map((app) => app.id), pattern.id).toContain(demo.app);
    }
  });

  it("names environments the root AppHost declares with each pattern's settings", () => {
    expect(declaration("coder")).toBe('    coder: { type: "isolated", size: "medium" },');
    for (const pattern of PATTERNS) {
      const declared = declaration(pattern.environment);
      expect(declared, pattern.environment).toBeDefined();
      for (const setting of pattern.settings) expect(declared, pattern.environment).toContain(setting);
      // A coordinator with no execution setting delegates, the default.
      if (pattern.settings.includes('type: "orchestrator"') && !pattern.settings.some((setting) => setting.startsWith("execution:"))) {
        expect(declared, pattern.environment).not.toContain("execution:");
      }
    }
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
    expect(state.local?.gatewayUrl).toBe("http://localhost:47400");
    expect(state.local?.gateway).toBe("offline");
    expect(state.local?.links.dispatch).toEqual({ url: "http://localhost:47470", health: "offline" });
    expect(state.hosted).toBeUndefined();
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
  describe("hosted", () => {
    const request = async (url: string, path: string, host: string) => {
      const { request: send } = await import("node:http");
      return new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = send(`${url}${path}`, { headers: { host } }, (res) => {
          let body = "";
          res.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
          res.once("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.once("error", reject);
        req.end();
      });
    };

    it("answers the deployment's host names and shows only the Azure target, without the console link", async () => {
      const url = await gallery({
        cloud: Promise.resolve<CloudLookup>({ url: "https://copilot.d.invalid", note: "This deployment." }),
        hosted: { allowedHosts: ["gallery.d.invalid", "gallery"] },
      });
      expect((await request(url, "/api/health", "gallery.d.invalid")).status).toBe(200);
      expect((await request(url, "/api/health", "GALLERY")).status).toBe(200);
      expect((await request(url, "/api/health", "evil.example")).status).toBe(421);

      const state = JSON.parse((await request(url, "/api/gallery?refresh", "gallery.d.invalid")).body) as GalleryState;
      expect(state.hosted).toBe(true);
      expect(state.local).toBeUndefined();
      expect(state.cloud.gatewayUrl).toBe("https://copilot.d.invalid");
      expect(Object.keys(state.cloud.links).sort()).toEqual(["assistant", "dispatch", "research-swarm", "software-factory"]);
    });

    it("never mints a console sign-in link, and says how to open it", async () => {
      const asked: string[] = [];
      const url = await gallery({
        cloud: Promise.resolve<CloudLookup>({ url: "https://copilot.d.invalid", note: "This deployment." }),
        hosted: { allowedHosts: ["gallery.d.invalid"] },
        openConsole: async (gatewayUrl) => {
          asked.push(gatewayUrl);
          return { url: "https://copilot.d.invalid/console/signin#ticket=t" };
        },
      });
      for (const target of ["cloud", "local"]) {
        const response = await request(url, `/open/console?target=${target}`, "gallery.d.invalid");
        expect(response.status).toBe(404);
        expect(response.body).toContain("<code>npx managed-copilot console --url https://copilot.d.invalid</code>");
      }
      expect(asked).toEqual([]);
    });
  });
});

describe("page", () => {
  it("draws every pattern, and each diagram agrees with the pattern's building blocks", () => {
    expect(Object.keys(SHAPES).sort()).toEqual(PATTERNS.map((pattern) => pattern.id).sort());
    for (const pattern of PATTERNS) {
      const { brain, hands } = SHAPES[pattern.id]!;
      const places = [...brain, ...hands.map((hand) => hand.place)];
      const blocks = new Set<BuildingBlock>();
      if (brain.includes("runtime")) blocks.add("multi-tenant");
      if (places.some((place) => place === "sandbox" || place === "worker")) blocks.add("container");
      // Sandboxes made while the session runs: workers, or hands for a brain that stays on the shared runtime.
      if (hands.some((hand) => hand.place === "worker") || (brain.length === 1 && brain[0] === "runtime" && hands.some((hand) => hand.place === "sandbox"))) blocks.add("orchestration");
      expect(blocks, pattern.id).toEqual(new Set(pattern.blocks));
    }
  });

  it("links the side-by-side comparison only when its app is listed", () => {
    expect(compareApp(APPS.filter((app) => app.id !== COMPARE_APP_ID))).toBeUndefined();
    const race = { ...APPS[0]!, id: COMPARE_APP_ID, title: "Pattern Race" };
    expect(compareApp([...APPS, race])).toBe(race);
  });

  it("finds the patterns an app shows, and where it opens", () => {
    const [app] = APPS;
    const patterns = PATTERNS.map((pattern, index) => ({ ...pattern, demos: index % 2 ? [{ app: app!.id, where: "somewhere" }] : [] }));
    expect(patternsOf(app!.id, patterns).map((pattern) => pattern.id)).toEqual(["shared", "direct", "mixed"]);
    // The side-by-side comparison shows every pattern, though no pattern lists it.
    expect(patternsOf(COMPARE_APP_ID, patterns)).toEqual(patterns);

    const state: GalleryState = {
      local: { gatewayUrl: "http://localhost:7400", gateway: "online", links: { [app!.id]: { url: "http://localhost:7470", health: "offline" } } },
      cloud: { gatewayUrl: "https://copilot.d.io", gateway: "online", links: { [app!.id]: { url: "https://dispatch.d.io", health: "online" } } },
      repoUrl: "https://github.com/o/r/blob/main/",
      checkedAt: new Date(0).toISOString(),
    };
    expect(appHref(app!, state)).toEqual({ href: "https://dispatch.d.io", online: true });
    expect(appHref(app!, { ...state, cloud: { links: {} } })).toEqual({ href: `https://github.com/o/r/blob/main/${app!.readme}`, online: false });
  });

  it("copies walkthrough commands that name their gateway in the visitor's shell", () => {
    expect(walkthroughCommand("03", "http://localhost:7400", "powershell")).toBe('$env:MANAGED_COPILOT_URL = "http://localhost:7400"; pnpm walkthrough 03');
    expect(walkthroughCommand("03", "https://copilot.d.io", "posix")).toBe('export MANAGED_COPILOT_URL="https://copilot.d.io"; pnpm walkthrough 03');
  });
});