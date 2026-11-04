import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, request, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer, connect as netConnect, Socket, type Server as NetServer } from "node:net";
import { gzipSync } from "node:zlib";
import { NETWORK_ENABLED, parseConfig, type EgressRegistration } from "@managed-copilot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CertificateAuthority, createCaMaterial } from "../../egress/src/x509.js";
import { GatewayApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import { createLogger } from "../src/log.js";
import { GatewayEgress } from "../src/modules/network/fetcher.js";
import { endpointRewriter, MCP_CAPABILITY_HEADER, McpAdapter } from "../src/modules/network/mcp-adapter.js";
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

/** Polls until `condition` holds (connection teardown is asynchronous). */
async function eventually(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !condition(); ) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const HUGE_GZIP = gzipSync(randomBytes(6 * 1024 * 1024), { level: 1 });
const SMALL_GZIP = gzipSync(randomBytes(64 * 1024));

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
        // Compressed bodies that exceed the download limit or stall never end on their own.
        "/gzip-huge": () => res.writeHead(200, { "content-type": "application/octet-stream", "content-encoding": "gzip" }).write(HUGE_GZIP),
        "/gzip-stall": () => res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" }).write(SMALL_GZIP.subarray(0, SMALL_GZIP.length >> 1)),
        "/gzip-reset": () => {
          res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" }).write(SMALL_GZIP.subarray(0, SMALL_GZIP.length >> 1));
          setTimeout(() => res.destroy(), 20);
        },
        "/gzip-invalid": () => res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" }).end("this is not gzip"),
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
        } else if (req.method === "GET" && req.url === "/sse-gzip") {
          res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
          res.end(gzipSync("event: endpoint\ndata: https://mcp.contoso.example/messages?session=1\n\n"));
        } else if (req.method === "GET" && req.url === "/sse-split") {
          // The two bytes of "é" arrive in separate chunks.
          const event = Buffer.from("event: endpoint\ndata: /messages?session=caf\u00e9\n\n", "utf8");
          const split = event.indexOf(0xa9);
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(event.subarray(0, split));
          setTimeout(() => res.end(event.subarray(split)), 50);
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

    it("returns compressed bodies over the download limit promptly, truncated", async () => {
      const started = Date.now();
      const result = await fetchFor("s-web", { url: "http://web.example.test/gzip-huge" });
      expect(result.resultType).toBe("success");
      expect(result.textResultForLlm).toMatch(/application\/octet-stream content, \d+ bytes, not shown/);
      expect(result.textResultForLlm).toContain("<download truncated at the size limit>");
      expect(Date.now() - started).toBeLessThan(4_000);
    });

    it("ends a compressed body that stalls with a timeout explanation", async () => {
      const started = Date.now();
      const result = await webFetch({ url: "http://web.example.test/gzip-stall" }, { sessionId: "s-web" }, { policy, egress, timeoutMs: 300 });
      expect(result).toMatchObject({ resultType: "failure" });
      expect(result.textResultForLlm).toMatch(/^Could not fetch http:\/\/web\.example\.test\/gzip-stall: the request timed out after 0\.3 seconds\.$/);
      expect(Date.now() - started).toBeLessThan(3_000);
    });

    it("explains bodies that cannot be decoded or that break off, instead of throwing", async () => {
      const result = await fetchFor("s-web", { url: "http://web.example.test/gzip-invalid" });
      expect(result).toMatchObject({ resultType: "failure" });
      expect(result.textResultForLlm).toBe("Could not fetch http://web.example.test/gzip-invalid: the gzip content could not be decoded (incorrect header check).");
      const reset = await fetchFor("s-web", { url: "http://web.example.test/gzip-reset" });
      expect(reset.textResultForLlm).toBe("Could not fetch http://web.example.test/gzip-reset: the connection closed before the whole response arrived.");
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

    it("asks MCP servers for uncompressed responses whatever the runtime accepts", async () => {
      const adapted = await adapter.adapt("s-chat", "docs", { type: "http", url: "https://mcp.contoso.example/docs" });
      const capability = (adapted.headers as Record<string, string>)[MCP_CAPABILITY_HEADER]!;
      const response = await post(String(adapted.url), { [MCP_CAPABILITY_HEADER]: capability, "accept-encoding": "gzip, deflate, br" }, "{}");
      expect(response.status).toBe(200);
      expect(mcpRequests.at(-1)!.headers["accept-encoding"]).toBe("identity");
    });

    it("refuses a compressed event stream it cannot rewrite", async () => {
      const adapted = await adapter.adapt("s-chat", "compressed", { type: "sse", url: "https://mcp.contoso.example/sse-gzip" });
      const capability = (adapted.headers as Record<string, string>)[MCP_CAPABILITY_HEADER]!;
      const stream = await fetch(String(adapted.url), { headers: { [MCP_CAPABILITY_HEADER]: capability, accept: "text/event-stream" } });
      expect(stream.status).toBe(502);
      expect(await stream.text()).toMatch(/sent a compressed event stream \(gzip\), which the adapter cannot inspect/);
    });

    it("rewrites endpoints whose UTF-8 characters arrive split across chunks", async () => {
      const adapted = await adapter.adapt("s-chat", "split", { type: "sse", url: "https://mcp.contoso.example/sse-split" });
      const capability = (adapted.headers as Record<string, string>)[MCP_CAPABILITY_HEADER]!;
      const text = await (await fetch(String(adapted.url), { headers: { [MCP_CAPABILITY_HEADER]: capability, accept: "text/event-stream" } })).text();
      expect(/event: endpoint\ndata: (.*)\n/.exec(text)?.[1]).toMatch(/^\/internal\/mcp\/mcp_[0-9a-f]{24}\/endpoint\?u=%2Fmessages%3Fsession%3Dcaf%C3%A9$/);
    });

    it("stops serving routes of deleted sessions", async () => {
      const adapted = await adapter.adapt("s-chat", "docs", { type: "http", url: "https://mcp.contoso.example/docs" });
      policy.releaseSession("s-chat");
      const response = await post(String(adapted.url), { [MCP_CAPABILITY_HEADER]: (adapted.headers as Record<string, string>)[MCP_CAPABILITY_HEADER]! }, "{}");
      expect(response.status).toBe(404);
    });
  });
});

describe("SSE endpoint rewriting", () => {
  /** Feeds `chunks` through the rewriter and returns what the runtime would receive. */
  const rewritten = async (...chunks: Array<string | Buffer>): Promise<string> => {
    const transform = endpointRewriter((endpoint) => `/adapter?u=${encodeURIComponent(endpoint)}`);
    const out: Buffer[] = [];
    transform.on("data", (chunk: Buffer) => out.push(chunk));
    const done = new Promise((resolve) => transform.on("end", resolve));
    for (const chunk of chunks) transform.write(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    transform.end();
    await done;
    return Buffer.concat(out).toString("utf8");
  };
  /** The endpoint events an SSE client would dispatch from `stream` (per the HTML event-stream parsing rules). */
  const dispatchedEndpoints = (stream: string): string[] => {
    const endpoints: string[] = [];
    let type = "";
    let data: string[] = [];
    for (const line of stream.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/)) {
      if (line === "") {
        if (type === "endpoint" && data.length > 0) endpoints.push(data.join("\n"));
        type = "";
        data = [];
        continue;
      }
      const colon = line.indexOf(":");
      if (colon === 0) continue;
      const field = colon < 0 ? line : line.slice(0, colon);
      const raw = colon < 0 ? "" : line.slice(colon + 1);
      const value = raw.startsWith(" ") ? raw.slice(1) : raw;
      if (field === "event") type = value;
      else if (field === "data") data.push(value);
    }
    return endpoints;
  };

  it("rewrites endpoint events whatever their line endings", async () => {
    for (const eol of ["\n", "\r\n", "\r"]) {
      const out = await rewritten(`event: endpoint${eol}data: https://mcp.contoso.example/messages${eol}${eol}event: message${eol}data: {}${eol}${eol}`);
      expect(dispatchedEndpoints(out), JSON.stringify(eol)).toEqual(["/adapter?u=https%3A%2F%2Fmcp.contoso.example%2Fmessages"]);
      expect(out).toContain("event: message\ndata: {}\n\n");
    }
  });

  it("handles a CRLF split across chunks and a leading byte order mark", async () => {
    const out = await rewritten("\uFEFFevent: endpoint\r", "\ndata: /m\r", "\n\r", "\n");
    expect(dispatchedEndpoints(out)).toEqual(["/adapter?u=%2Fm"]);
    expect(out).toBe("event: endpoint\ndata: /adapter?u=%2Fm\n\n");
  });

  it("never lets an endpoint event through unrewritten when its data comes before its type", async () => {
    const attacks = [
      "data: https://169.254.169.254/latest\nevent: endpoint\n\n",
      "data:https://evil.example.test/x\revent:endpoint\r\r",
      "event: message\ndata: https://evil.example.test/x\nevent: endpoint\n\n",
      "data\nevent: endpoint\n\n",
    ];
    for (const attack of attacks) {
      const out = await rewritten(attack);
      expect(dispatchedEndpoints(out), attack).toEqual([]);
      expect(dispatchedEndpoints(attack).length, attack).toBe(1);
    }
  });

  it("rewrites multi-line endpoint data and passes comments and other fields through", async () => {
    const out = await rewritten(": keep-alive\nid: 7\nevent: endpoint\nretry: 1000\ndata: /a\ndata: /b\n\n");
    expect(out).toBe(": keep-alive\nid: 7\nevent: endpoint\nretry: 1000\ndata: /adapter?u=%2Fa\ndata: /adapter?u=%2Fb\n\n");
  });
});

describe("gateway egress connections", () => {
  const ca = new CertificateAuthority(createCaMaterial({ commonName: "Handshake Test CA" }));
  const silentConnections = new Set<Socket>();
  let silentAccepted = 0;
  const silentServer: NetServer = createNetServer((socket) => {
    // Accepts TCP and reads the ClientHello, but never speaks TLS.
    silentAccepted++;
    silentConnections.add(socket);
    socket.resume();
    socket.on("error", () => undefined);
    socket.on("close", () => silentConnections.delete(socket));
  });
  const goodCertificate = ca.issue("api.example.test");
  const wrongCertificate = ca.issue("other.example.test");
  const good = createHttpsServer({ key: goodCertificate.keyPem, cert: goodCertificate.certPem }, (_req, res) => res.writeHead(200).end("ok"));
  const wrong = createHttpsServer({ key: wrongCertificate.keyPem, cert: wrongCertificate.certPem }, (_req, res) => res.writeHead(200).end("ok"));
  const SILENT = "93.184.216.40";
  const GOOD = "93.184.216.41";
  const WRONG = "93.184.216.42";
  const NEVER_CONNECTS = "93.184.216.43";
  const ports = new Map<string, number>();
  const dialed: string[] = [];
  const unconnected: Socket[] = [];
  const url = new URL("https://api.example.test/");

  const egressWith = (addresses: string[], connectTimeoutMs: number) =>
    new GatewayEgress({
      destination: {
        allowedPorts: new Set([443]),
        privateHosts: new Set(),
        protectedCidrs: () => [],
        blockedCidrs: [],
        dnsTimeoutMs: 1_000,
        resolve: async () => addresses,
      },
      connect: (address) => {
        dialed.push(address);
        if (address === NEVER_CONNECTS) {
          const socket = new Socket();
          unconnected.push(socket);
          return socket;
        }
        return netConnect({ host: "127.0.0.1", port: ports.get(address) ?? 9 });
      },
      extraCa: [ca.certPem],
      connectTimeoutMs,
    });

  beforeAll(async () => {
    await new Promise<void>((resolve) => silentServer.listen(0, "127.0.0.1", () => resolve()));
    ports.set(SILENT, (silentServer.address() as { port: number }).port);
    ports.set(GOOD, await listen(good));
    ports.set(WRONG, await listen(wrong));
  });

  afterAll(() => {
    for (const socket of silentConnections) socket.destroy();
    silentServer.close();
    for (const server of [good, wrong]) {
      server.closeAllConnections();
      server.close();
    }
  });

  it("gives up on a TLS handshake the server never answers within the connect timeout", async () => {
    const accepted = silentAccepted;
    const started = Date.now();
    await expect(egressWith([SILENT], 200).request(NETWORK_ENABLED, url)).rejects.toThrow("TLS handshake with api.example.test:443 timed out");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(silentAccepted).toBe(accepted + 1);
    await eventually(() => silentConnections.size === 0);
  });

  it("settles promptly when the caller aborts a handshake or a dial", async () => {
    const accepted = silentAccepted;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    await expect(egressWith([SILENT, GOOD], 10_000).request(NETWORK_ENABLED, url, { signal: controller.signal })).rejects.toThrow(/aborted/);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(silentAccepted).toBe(accepted + 1);
    await eventually(() => silentConnections.size === 0);

    const dial = new AbortController();
    setTimeout(() => dial.abort(), 100);
    dialed.length = 0;
    await expect(egressWith([NEVER_CONNECTS, GOOD], 10_000).request(NETWORK_ENABLED, url, { signal: dial.signal })).rejects.toThrow(/aborted/);
    expect(dialed).toEqual([NEVER_CONNECTS]);
    expect(unconnected.at(-1)?.destroyed).toBe(true);
  });

  it("moves on to the next validated address after a failed handshake", async () => {
    dialed.length = 0;
    const result = await egressWith([SILENT, GOOD], 200).request(NETWORK_ENABLED, url);
    expect("response" in result && result.response.statusCode).toBe(200);
    if ("response" in result) result.response.resume();
    expect(dialed).toEqual([SILENT, GOOD]);
  });

  it("reports a certificate that fails verification without trying other addresses", async () => {
    dialed.length = 0;
    await expect(egressWith([WRONG, GOOD], 2_000).request(NETWORK_ENABLED, url)).rejects.toThrow(/does not match certificate's altnames/);
    expect(dialed).toEqual([WRONG]);
  });
});
