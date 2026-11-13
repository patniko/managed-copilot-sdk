import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { APPS, BUILDING_BLOCKS, CONSOLE, HARNESS_APP_ID, HARNESS_STAGES, harnessStageUrl, PATTERNS, WALKTHROUGHS, type BuildingBlock, type GalleryState } from "../src/shared/catalog.js";
import { createGallery, type CloudLookup, type GalleryOptions } from "../src/server/gallery.js";
import { capture, checkTarget, cloudUrls, isLocalUrl, localUrls, normalizeGatewayUrl, probe } from "../src/server/targets.js";
import { AGENT_SKETCHES, appHref, appsOnTab, COMPARE_APP_ID, compareApp, CONNECTED_COLUMNS, FLOWS, patternsOf, SHAPES, TABS, tabForHash, walkthroughCommand } from "../src/web/model.js";

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
  const appIds = (apps: typeof APPS) => apps.map((app) => app.id).sort();
  const withoutConsole = APPS.filter((app) => app.id !== "console");

  it("uses the AppHost's fixed local ports, shifted by the port offset", () => {
    const { gatewayUrl, apps } = localUrls(0);
    expect(gatewayUrl).toBe("http://localhost:7400");
    expect(apps).toMatchObject({
      dispatch: "http://localhost:7470",
      "software-factory": "http://localhost:7480",
      assistant: "http://localhost:7490",
      "front-desk": "http://localhost:7450",
      console: "/open/console?target=local",
    });
    expect(Object.keys(apps).sort()).toEqual(appIds(APPS));
    for (const app of withoutConsole) expect(apps[app.id]).toBe(`http://localhost:${app.port}`);
    expect(localUrls(300).apps.dispatch).toBe("http://localhost:7770");
  });

  it("gives every app its own local port, apart from the gateway's and the gallery's", () => {
    const ports = withoutConsole.map((app) => app.port);
    expect(new Set(ports).size).toBe(ports.length);
    expect(ports).not.toContain(7400);
    expect(ports).not.toContain(7460);
  });

  it("puts deployed apps beside the gateway on the environment's domain", () => {
    const urls = cloudUrls("https://copilot.bravedesert-123.westus2.azurecontainerapps.io");
    expect(urls.gatewayUrl).toBe("https://copilot.bravedesert-123.westus2.azurecontainerapps.io");
    expect(urls.apps.dispatch).toBe("https://dispatch.bravedesert-123.westus2.azurecontainerapps.io");
    expect(urls.apps.assistant).toBe("https://assistant.bravedesert-123.westus2.azurecontainerapps.io");
    expect(urls.apps["front-desk"]).toBe("https://front-desk.bravedesert-123.westus2.azurecontainerapps.io");
    expect(urls.apps.console).toBe("/open/console?target=cloud");
  });

  it("leaves the console out when asked (a hosted gallery)", () => {
    const { apps } = cloudUrls("https://copilot.d.io", { console: false });
    expect(apps).toMatchObject({
      dispatch: "https://dispatch.d.io",
      "software-factory": "https://software-factory.d.io",
      assistant: "https://assistant.d.io",
      "front-desk": "https://front-desk.d.io",
    });
    const deployed = withoutConsole.filter((app) => !app.localOnly);
    expect(Object.keys(apps).sort()).toEqual(appIds(deployed));
    for (const app of deployed) expect(apps[app.id]).toBe(`https://${app.app}.d.io`);
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

  it("checks apps where it's told to, and still links to their public addresses", async () => {
    // Each app's public address refuses this caller (an allowlist), as from inside a deployment's environment.
    const refused = await listen((_req, res) => res.writeHead(403).end("RBAC: access denied"));
    const inside = await listen((_req, res) => res.writeHead(200).end("ok"));
    const urls = { gatewayUrl: inside, apps: Object.fromEntries(withoutConsole.map((app) => [app.id, `${refused}/${app.id}`])) };
    const outside = await checkTarget(urls);
    expect(new Set(Object.values(outside.links).map((link) => link.health))).toEqual(new Set(["restricted"]));
    const hosted = await checkTarget(urls, () => inside);
    for (const app of withoutConsole) expect(hosted.links[app.id]).toEqual({ url: `${refused}/${app.id}`, health: "online" });
  });
});

describe("patterns", () => {
  const apphost = readFileSync(fileURLToPath(new URL("../../../apphost.mts", import.meta.url)), "utf8");
  /** An environment's inline declaration or its shared top-level object in the root AppHost. */
  const declaration = (name: string) => {
    const reference = apphost.match(new RegExp(`^ +${name}: (\\w+),?$`, "m"))?.[1];
    const pattern = reference
      ? `^const ${reference} = \\{[\\s\\S]*?^\\};`
      : `^( +)${name}: \\{(?:[^\\n]*\\},?|[\\s\\S]*?\\n\\1\\},?)`;
    return apphost.match(new RegExp(pattern, "m"))?.[0];
  };

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

describe("tabs", () => {
  const apphost = readFileSync(fileURLToPath(new URL("../../../apphost.mts", import.meta.url)), "utf8");

  it("lists the Software Factory and exactly the apps the root AppHost routes to it or to Help Desk as connected", () => {
    // The demo each .withEnvironment("SOFTWARE_FACTORY_URL" | "HELP_DESK_URL", …) belongs to: the nearest addDemo Dockerfile above it.
    const routedBy = (variable: string) =>
      [...apphost.matchAll(new RegExp(`\\.withEnvironment\\("${variable}"`, "g"))].map((match) => {
        const before = [...apphost.slice(0, match.index).matchAll(/dockerfile: "demos\/([\w-]+)\/Dockerfile"/g)];
        return before.at(-1)![1]!;
      });
    const routed = [...routedBy("SOFTWARE_FACTORY_URL"), ...routedBy("HELP_DESK_URL")];
    expect(routedBy("HELP_DESK_URL")).toEqual(["downhill"]);
    expect(APPS.filter((app) => app.group === "connected").map((app) => app.id).sort()).toEqual(["software-factory", ...routed].sort());
    expect(APPS.filter((app) => app.group === "staff").map((app) => app.id)).toEqual([HARNESS_APP_ID]);
  });

  it("draws exactly the connections the root AppHost wires between connected apps, each app placed and sketched", () => {
    // Each variable names the app it points at; the demo it's set on is the nearest addDemo Dockerfile above it.
    const targets: Record<string, string> = {
      SOFTWARE_FACTORY_URL: "software-factory",
      HELP_DESK_URL: "help-desk",
      INCIDENT_URL: "incident-commander",
      DOWNHILL_URL: "downhill",
      INCIDENT_DEPLOY_URL: "downhill",
    };
    const pair = (a: string, b: string) => [a, b].sort().join(" ↔ ");
    const wired = new Set(
      Object.entries(targets).flatMap(([variable, target]) =>
        [...apphost.matchAll(new RegExp(`\\.withEnvironment\\("${variable}"`, "g"))].map((match) => {
          const owner = [...apphost.slice(0, match.index).matchAll(/dockerfile: "demos\/([\w-]+)\/Dockerfile"/g)].at(-1)![1]!;
          return pair(owner, target);
        }),
      ),
    );
    expect(new Set(FLOWS.map((flow) => pair(flow.from, flow.to)))).toEqual(wired);
    const connected = APPS.filter((app) => app.group === "connected").map((app) => app.id);
    expect(Object.values(CONNECTED_COLUMNS).flat().sort()).toEqual([...connected].sort());
    // Downhill runs no agents; every other connected app has a sketch of its own.
    expect(Object.keys(AGENT_SKETCHES).sort()).toEqual(connected.filter((id) => id !== "downhill").sort());
  });

  it("opens the tab holding the section a link names", () => {
    expect(tabForHash("")).toBe("overview");
    for (const tab of TABS) expect(tabForHash(`#${tab}`)).toBe(tab);
    expect(tabForHash("#patterns")).toBe("overview");
    expect(tabForHash("#pattern-mixed")).toBe("overview");
    expect(tabForHash("#walkthrough-03")).toBe("overview");
    expect(tabForHash("#hack-the-harness")).toBe("staff-assistant");
    expect(tabForHash("#harness-workers")).toBe("staff-assistant");
    expect(tabForHash("#nothing")).toBe("overview");
    // The tabs' earlier addresses.
    expect(tabForHash("#architectures")).toBe("overview");
    expect(tabForHash("#walkthroughs")).toBe("overview");
    expect(tabForHash("#connected")).toBe("downhill-launch");
  });

  it("leaves local-only apps off a hosted gallery's tabs, and the console off every tab", () => {
    expect(appsOnTab(APPS, "staff", false).map((app) => app.id)).toEqual([HARNESS_APP_ID]);
    expect(appsOnTab(APPS, "staff", true)).toEqual([]);
    for (const group of ["connected", "staff", "more"] as const) expect(appsOnTab(APPS, group, false)).not.toContain(CONSOLE);
  });
});

describe("Hack the Harness stages", () => {
  const stages = readFileSync(fileURLToPath(new URL("../../hack-the-harness/src/app/server/stages.ts", import.meta.url)), "utf8");

  it("lists the app's stages in its order, each showing one of the six patterns", () => {
    const ids = [...stages.matchAll(/^ {4}id: "(\w+)",$/gm)].map((match) => match[1]);
    expect(HARNESS_STAGES.map((stage) => stage.id)).toEqual(ids);
    for (const stage of HARNESS_STAGES) expect(PATTERNS.map((pattern) => pattern.id), stage.id).toContain(stage.pattern);
    expect(new Set(HARNESS_STAGES.map((stage) => stage.pattern)).size).toBe(PATTERNS.length);
    expect(APPS.find((app) => app.id === HARNESS_APP_ID)?.localOnly).toBe(true);
  });

  it("opens each stage with ?stage= on the app's address", () => {
    expect(harnessStageUrl("http://localhost:7415/", "mixed")).toBe("http://localhost:7415/?stage=mixed");
    expect(harnessStageUrl("http://localhost:7425", "workers")).toBe("http://localhost:7425/?stage=workers");
  });
});

describe("public apps", () => {
  const apphost = readFileSync(fileURLToPath(new URL("../../../apphost.mts", import.meta.url)), "utf8");
  /** The root AppHost's call that publishes a demo: the nearest `addDemo(` or `publishApp(` before its Dockerfile, to the matching `)`. */
  const publishCall = (folder: string): string | undefined => {
    const at = apphost.indexOf(`dockerfile: "demos/${folder}/Dockerfile"`);
    const start = Math.max(apphost.lastIndexOf("addDemo(", at), apphost.lastIndexOf("publishApp(", at));
    if (at < 0 || start < 0) return undefined;
    let depth = 0;
    for (let index = apphost.indexOf("(", start); index < apphost.length; index++) {
      if (apphost[index] === "(") depth++;
      else if (apphost[index] === ")" && --depth === 0) return apphost.slice(start, index + 1);
    }
    return undefined;
  };

  it("marks Public exactly the apps the root AppHost publishes with public: true", () => {
    for (const app of APPS.filter((entry) => entry.id !== "console" && !entry.localOnly)) {
      const folder = /^demos\/([^/]+)\//.exec(app.readme)?.[1];
      const call = folder ? publishCall(folder) : undefined;
      expect(call, `${app.id} is published in apphost.mts`).toBeDefined();
      expect(/\bpublic: true\b/.test(call!), app.id).toBe(app.public === true);
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

  it("rolls Downhill's shop out and back through a same-site switch, and says so when Downhill isn't up", async () => {
    const url = await gallery();
    const put = (open: boolean, headers: Record<string, string> = {}) =>
      fetch(`${url}/api/downhill/shop?target=local`, { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ open }) });
    expect(await (await fetch(`${url}/api/downhill/shop?target=local`)).json()).toEqual({ error: "Downhill isn't answering. Start the platform with aspire run." });

    // Downhill on its local port at the gallery's offset (7455 + 40000).
    let open = false;
    const received: string[] = [];
    const downhill = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        received.push(`${req.method} ${req.url} ${body}`);
        if (req.method === "PUT") open = (JSON.parse(body) as { open: boolean }).open;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ open }));
      });
    });
    servers.push(downhill);
    await new Promise<void>((resolve) => downhill.listen(47_455, resolve));

    expect(await (await fetch(`${url}/api/downhill/shop?target=local`)).json()).toEqual({ open: false });
    expect(await (await put(true, { origin: url })).json()).toEqual({ open: true });
    expect((await put(false, { origin: "https://attacker.example" })).status).toBe(403);
    expect((await fetch(`${url}/api/downhill/shop?target=local`, { method: "POST" })).status).toBe(405);
    expect(received).toEqual(["GET /api/shop ", 'PUT /api/shop {"open":true}']);
  });

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
      expect(Object.keys(state.cloud.links).sort()).toEqual(APPS.filter((app) => app.id !== "console" && !app.localOnly).map((app) => app.id).sort());
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
    const others = APPS.filter((app) => app.id !== COMPARE_APP_ID);
    expect(compareApp(others)).toBeUndefined();
    const race = { ...APPS[0]!, id: COMPARE_APP_ID, title: "Pattern Race" };
    expect(compareApp([...others, race])).toBe(race);
    expect(compareApp(APPS)?.id).toBe(COMPARE_APP_ID);
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
