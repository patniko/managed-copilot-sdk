import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, request, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as netConnect } from "node:net";
import { parseConfig, type EgressRegistration } from "@managed-copilot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CertificateAuthority, createCaMaterial } from "../../egress/src/x509.js";
import { GatewayApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import { createLogger } from "../src/log.js";
import { GatewayEgress } from "../src/modules/network/fetcher.js";
import { MCP_CAPABILITY_HEADER, McpAdapter } from "../src/modules/network/mcp-adapter.js";
import { PolicyService } from "../src/modules/network/policy.js";
import { Sealer } from "../src/modules/network/sealing.js";
import { migrateNetwork } from "../src/modules/network/store.js";
import { VaultStore } from "../src/modules/network/vaults.js";
import { htmlToText, webFetch } from "../src/modules/network/web-fetch.js";

const log = createLogger("test", "error");
const CONFIG = {
  name: "copilot",
  vaults: { docs: [{ mcpServer: "https://mcp.contoso.example/docs", value: { secretEnv: "TEST_DOCS_TOKEN" } }] },
  environments: {
    web: { type: "shared", network: ["web.example.test", "internal.example.test"] },
    chat: { type: "shared", vaults: ["docs"], network: ["mcp.contoso.example", "internal.example.test"] },
    quiet: { type: "shared", network: false },
  },
};

const PAGE = `<!doctype html><html><head><title>Aspire &amp; friends</title><style>body{}</style><script>alert(1)</script></head>
<body><nav>skip me</nav><main><h1>What changed</h1><p>Aspire 13 adds <a href="/docs">new docs</a> and <strong>faster</strong> startup.</p>
<ul><li>One</li><li>Two &lt;3</li></ul><pre>line 1
line 2</pre></main><footer>footer text</footer></body></html>`;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return (server.address() as { port: number }).port;
}

describe("gateway-side egress", () => {
  const upstreamCa = new CertificateAuthority(createCaMaterial({ commonName: "Upstream Test CA" }));
  const mcpRequests: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[] = [];
  const servers: Server[] = [];
  const dialed: string[] = [];
  const db = openDatabase(":memory:");
  migrateNetwork(db);
  const deployment = parseConfig(CONFIG);
  const vaults = new VaultStore({ db, sealer: new Sealer(randomBytes(32)), deployment, env: { TEST_DOCS_TOKEN: "docs-token-xyz" }, log });
  const channel = { ready: true, caCertificate: () => "", waitReady: async () => undefined, upsert: (_r: EgressRegistration) => undefined, remove: (_id: string) => undefined };
  const policy = new PolicyService({ db, deployment, vaults, egress: channel, log });
  let egress: GatewayEgress;
  let adapter: McpAdapter;
  let adapterBase: string;

  beforeAll(async () => {
    const web = createHttpServer((req, res) => {
      const routes: Record<string, () => void> = {
        "/": () => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE),
        "/r1": () => res.writeHead(302, { location: "/r2" }).end(),
        "/r2": () => res.writeHead(301, { location: "http://web.example.test/" }).end(),
        "/json": () => res.writeHead(200, { "content-type": "application/json" }).end('{"a":1,"b":[true]}'),
        "/missing": () => res.writeHead(404, { "content-type": "text/plain" }).end("not here"),
        "/evil": () => res.writeHead(302, { location: "http://evil.example.test/steal" }).end(),
        "/private": () => res.writeHead(302, { location: "http://internal.example.test/" }).end(),
        "/long": () => res.writeHead(200, { "content-type": "text/plain" }).end("0123456789".repeat(100)),
        "/loop": () => res.writeHead(302, { location: "/loop" }).end(),
      };
      (routes[req.url ?? ""] ?? (() => res.writeHead(404).end()))();
    });
    const issued = upstreamCa.issue("mcp.contoso.example");
    const mcp = createHttpsServer({ key: issued.keyPem, cert: issued.certPem }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        mcpRequests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        if (req.method === "GET" && req.url === "/sse") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write("event: endpoint\ndata: /messages?session=1\n\n");
          res.end('event: message\ndata: {"jsonrpc":"2.0","method":"ready"}\n\n');
        } else if (req.url === "/redirect") {
          res.writeHead(307, { location: "https://elsewhere.example.test/" }).end();
        } else {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "abc" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
        }
      });
    });
    servers.push(web, mcp);
    const routes = new Map([
      ["93.184.216.20:80", await listen(web)],
      ["93.184.216.21:443", await listen(mcp)],
    ]);
    const answers: Record<string, string[]> = {
      "web.example.test": ["93.184.216.20"],
      "mcp.contoso.example": ["93.184.216.21"],
      "evil.example.test": ["93.184.216.22"],
      "internal.example.test": ["10.1.2.3"],
    };
    egress = new GatewayEgress({
      destination: {
        allowedPorts: new Set([80, 443]),
        privateHosts: new Set(),
        protectedCidrs: () => [],
        blockedCidrs: [],
        dnsTimeoutMs: 1_000,
        resolve: async (host) => {
          const answer = answers[host];
          if (!answer) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
          return answer;
        },
      },
      connect: (address, port) => {
        dialed.push(`${address}:${port}`);
        const local = routes.get(`${address}:${port}`);
        return netConnect({ host: "127.0.0.1", port: local ?? 9 });
      },
      extraCa: [upstreamCa.certPem],
    });
    const app = new GatewayApp(loadConfig({ PORT: "0", MANAGED_COPILOT_CONFIG: JSON.stringify(CONFIG), MANAGED_COPILOT_SHARED_RUNTIME: "0" }), db, log);
    const gatewayServer = createHttpServer((req, res) => void app.routes.handle(app, req, res));
    servers.push(gatewayServer);
    adapterBase = `http://127.0.0.1:${await listen(gatewayServer)}`;
    adapter = new McpAdapter({ db, policy, egress, key: randomBytes(32), baseUrl: () => adapterBase, log });
    adapter.register(app);
    for (const [sessionId, environment] of [
      ["s-web", "web"],
      ["s-chat", "chat"],
      ["s-quiet", "quiet"],
    ] as const) {
      policy.bindSession({ sessionId, owner: 7, environment, type: "shared", requested: undefined, vaults: undefined });
    }
  });

  afterAll(() => {
    for (const server of servers) {
      server.closeAllConnections?.();
      server.close();
    }
  });

  describe("web_fetch", () => {
    const fetchFor = (sessionId: string, args: Record<string, unknown>) => webFetch(args, { sessionId }, { policy, egress });

    it("returns readable text for HTML pages", async () => {
      const result = await fetchFor("s-web", { url: "http://web.example.test/" });
      expect(result.resultType).toBe("success");
      expect(result.textResultForLlm).toContain("Contents of http://web.example.test/");
      expect(result.textResultForLlm).toContain("Title: Aspire & friends");
      expect(result.textResultForLlm).toContain("# What changed");
      expect(result.textResultForLlm).toContain("[new docs](http://web.example.test/docs)");
      expect(result.textResultForLlm).not.toMatch(/alert|skip me|footer text/);
    });

    it("follows redirects and re-checks every hop", async () => {
      expect((await fetchFor("s-web", { url: "http://web.example.test/r1" })).textResultForLlm).toContain("# What changed");
      const evil = await fetchFor("s-web", { url: "http://web.example.test/evil" });
      expect(evil).toMatchObject({ resultType: "failure" });
      expect(evil.textResultForLlm).toMatch(/Blocked by this session's network policy: evil\.example\.test is not an allowed host/);
      const internal = await fetchFor("s-web", { url: "http://web.example.test/private" });
      expect(internal.textResultForLlm).toMatch(/resolves to 10\.1\.2\.3, a private network address/);
      expect(dialed).not.toContain("10.1.2.3:80");
      expect(policy.blocked("s-web").map((entry) => entry.host)).toEqual(expect.arrayContaining(["evil.example.test", "internal.example.test"]));
      expect((await fetchFor("s-web", { url: "http://web.example.test/loop" })).textResultForLlm).toMatch(/Too many redirects/);
    });

    it("formats JSON, pages long content, and reports HTTP errors", async () => {
      expect((await fetchFor("s-web", { url: "http://web.example.test/json" })).textResultForLlm).toContain('"a": 1');
      const page = await fetchFor("s-web", { url: "http://web.example.test/long", max_length: 300, start_index: 100 });
      expect(page.textResultForLlm).toContain("start_index=400");
      expect(page.textResultForLlm.split("\n\n")[1]).toHaveLength(300);
      const missing = await fetchFor("s-web", { url: "http://web.example.test/missing" });
      expect(missing).toMatchObject({ resultType: "failure", error: "HTTP 404" });
    });

    it("explains blocks for disabled networks, other schemes, and unbound sessions", async () => {
      expect((await fetchFor("s-quiet", { url: "http://web.example.test/" })).textResultForLlm).toMatch(/network: false/);
      expect((await fetchFor("s-web", { url: "file:///etc/passwd" })).textResultForLlm).toMatch(/Only http and https/);
      expect((await fetchFor("s-web", { url: "http://127.0.0.1/healthz" })).textResultForLlm).toMatch(/Direct IP connections are not allowed/);
      expect((await fetchFor("s-web", { url: "http://web.example.test:7400/" })).textResultForLlm).toMatch(/Port 7400 is not allowed/);
      expect((await fetchFor("nope", { url: "http://web.example.test/" })).textResultForLlm).toMatch(/no network policy binding/);
      expect((await fetchFor("s-web", {})).resultType).toBe("failure");
    });

    it("converts HTML conservatively", () => {
      expect(htmlToText("<p>a &amp; b &#x263A; &#9731;</p>").text).toBe("a & b ☺ ☃");
      expect(htmlToText('<a href="javascript:alert(1)">x</a>').text).toBe("x");
    });
  });

  describe("MCP adapter", () => {
    const post = (url: string, headers: Record<string, string>, body: string) =>
      new Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }>((resolve, reject) => {
        const req = request(url, { method: "POST", headers: { "content-type": "application/json", ...headers } }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        });
        req.on("error", reject);
        req.end(body);
      });

    it("routes a shared session's MCP server through the adapter with its vault credential", async () => {
      const adapted = await adapter.adapt("s-chat", "docs", { type: "http", url: "https://mcp.contoso.example/docs", headers: { "x-custom": "1" }, tools: ["*"] });
      expect(adapted.url).toMatch(new RegExp(`^${adapterBase}/internal/mcp/mcp_[0-9a-f]{24}$`));
      expect(adapted).toMatchObject({ type: "http", tools: ["*"], headers: { "x-custom": "1" } });
      expect(JSON.stringify(adapted)).not.toContain("docs-token-xyz");
      const capability = (adapted.headers as Record<string, string>)[MCP_CAPABILITY_HEADER]!;
      const response = await post(String(adapted.url), { [MCP_CAPABILITY_HEADER]: capability, "x-custom": "1" }, '{"jsonrpc":"2.0","id":1,"method":"initialize"}');
      expect(response.status).toBe(200);
      expect(response.headers["mcp-session-id"]).toBe("abc");
      expect(JSON.parse(response.body)).toMatchObject({ result: { ok: true } });
      const seen = mcpRequests.at(-1)!;
      expect(seen).toMatchObject({ method: "POST", url: "/docs", body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}' });
      expect(seen.headers.authorization).toBe(["Bearer", "docs-token-xyz"].join(" "));
      expect(seen.headers["x-custom"]).toBe("1");
      expect(seen.headers[MCP_CAPABILITY_HEADER]).toBeUndefined();
      expect((await adapter.adapt("s-chat", "docs", { type: "http", url: "https://mcp.contoso.example/docs" })).url).toBe(adapted.url);
    });

    it("requires the route capability", async () => {
      const adapted = await adapter.adapt("s-chat", "docs", { type: "http", url: "https://mcp.contoso.example/docs" });
      expect((await post(String(adapted.url), {}, "{}")).status).toBe(403);
      expect((await post(String(adapted.url), { [MCP_CAPABILITY_HEADER]: "x".repeat(43) }, "{}")).status).toBe(403);
    });

    it("refuses servers the session's policy or platform protections forbid", async () => {
      await expect(adapter.adapt("s-chat", "evil", { type: "http", url: "https://evil.example.test/mcp" })).rejects.toThrow(/not an allowed host/);
      await expect(adapter.adapt("s-chat", "internal", { type: "http", url: "https://internal.example.test/mcp" })).rejects.toThrow(/private network address/);
      await expect(adapter.adapt("s-chat", "local", { type: "stdio", command: "node" })).rejects.toThrow(/only remote http and sse/);
      expect(policy.blocked("s-chat").map((entry) => entry.host)).toEqual(expect.arrayContaining(["evil.example.test", "internal.example.test"]));
    });

    it("does not follow redirects", async () => {
      const adapted = await adapter.adapt("s-chat", "redirecting", { type: "http", url: "https://mcp.contoso.example/redirect" });
      const response = await post(String(adapted.url), { [MCP_CAPABILITY_HEADER]: (adapted.headers as Record<string, string>)[MCP_CAPABILITY_HEADER]! }, "{}");
      expect(response.status).toBe(502);
      expect(response.body).toMatch(/does not follow redirects/);
    });

    it("rewrites legacy SSE endpoints back through the adapter", async () => {
      const adapted = await adapter.adapt("s-chat", "legacy", { type: "sse", url: "https://mcp.contoso.example/sse" });
      const capability = (adapted.headers as Record<string, string>)[MCP_CAPABILITY_HEADER]!;
      const stream = await fetch(String(adapted.url), { headers: { [MCP_CAPABILITY_HEADER]: capability, accept: "text/event-stream" } });
      const text = await stream.text();
      const endpoint = /event: endpoint\ndata: (.*)\n/.exec(text)?.[1];
      expect(endpoint).toMatch(/^\/internal\/mcp\/mcp_[0-9a-f]{24}\/endpoint\?u=%2Fmessages%3Fsession%3D1$/);
      expect(text).toContain('{"jsonrpc":"2.0","method":"ready"}');
      const message = await post(`${adapterBase}${endpoint}`, { [MCP_CAPABILITY_HEADER]: capability }, '{"jsonrpc":"2.0","method":"ping"}');
      expect(message.status).toBe(200);
      expect(mcpRequests.at(-1)).toMatchObject({ method: "POST", url: "/messages?session=1" });
    });

    it("stops serving routes of deleted sessions", async () => {
      const adapted = await adapter.adapt("s-chat", "docs", { type: "http", url: "https://mcp.contoso.example/docs" });
      policy.releaseSession("s-chat");
      const response = await post(String(adapted.url), { [MCP_CAPABILITY_HEADER]: (adapted.headers as Record<string, string>)[MCP_CAPABILITY_HEADER]! }, "{}");
      expect(response.status).toBe(404);
    });
  });
});
