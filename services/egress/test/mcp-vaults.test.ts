/**
 * Vault MCP credentials for sandboxes, end to end without Docker. The real gateway network module issues the
 * placeholder headers (`vaults.mcpHeaders`) and sandbox registrations. The egress proxy, linked to the gateway over the
 * internal API, substitutes a placeholder only for the owning session's HTTPS requests to the MCP server's exact host.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { request, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../gateway/src/config.js";
import { startGateway, type RunningGateway } from "../../gateway/src/server.js";
import { GatewayLink } from "../src/gateway-link.js";
import { silentLogger } from "../src/log.js";
import { EgressProxy } from "../src/proxy.js";
import { Registry } from "../src/registry.js";
import { basic, bearer, listen, openTunnel, routedDialer, sha256, tableResolver, testCa, tlsOver, type ProxyResponse } from "./fixtures.js";

const EGRESS_KEY = "mcp-vault-test-egress-key-0123456789";
const DOCS_TOKEN = "docs-token-0123456789abcdef";
const WIKI_TOKEN = "wiki-key-fedcba9876543210";
const DOCS_MCP = "https://mcp.contoso.test/mcp";
const WIKI_MCP = "https://wiki.contoso.test/mcp";
const PORTED_MCP = "https://mcp.contoso.test:8443/mcp";

const CONFIG = {
  name: "copilot",
  vaults: {
    docs: [{ mcpServer: DOCS_MCP, value: { secretEnv: "TEST_DOCS_TOKEN" } }],
    wiki: [{ mcpServer: WIKI_MCP, header: "x-api-key", value: { secretEnv: "TEST_WIKI_TOKEN" } }],
    ported: [{ mcpServer: PORTED_MCP, value: { secretEnv: "TEST_DOCS_TOKEN" } }],
  },
  environments: {
    research: { type: "isolated", vaults: ["docs", "wiki", "ported"], network: ["mcp.contoso.test", "wiki.contoso.test", "other.contoso.test"] },
    chat: { type: "shared", vaults: ["docs"], network: ["mcp.contoso.test"] },
  },
};

interface Recorded {
  readonly host: string;
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

const PLACEHOLDER = /^mcv_placeholder_[0-9a-f]{40}$/;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  for (const start = Date.now(); !condition(); await sleep(20)) if (Date.now() - start > ms) throw new Error("condition not met in time");
}

/** One HTTP/1.1 POST over an established TLS socket. */
function postOver(tls: TLSSocket, path: string, headers: Record<string, string>, body: string): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ createConnection: () => tls, path, method: "POST", headers: { "content-type": "application/json", ...headers }, setHost: false });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("vault MCP credentials for sandboxes", () => {
  const platformCa = testCa("Platform Egress CA");
  const upstreamCa = testCa("Upstream MCP CA");
  const records: Recorded[] = [];
  const servers: Server[] = [];
  const registry = new Registry({ staleMs: 30_000, maxConnectionsPerSandbox: 32 });
  let dataDir: string;
  let gateway: RunningGateway;
  let link: GatewayLink;
  let proxy: EgressProxy;
  let proxyPort: number;
  const auth: Record<string, string> = {};

  /** An MCP server that answers JSON-RPC posts and keeps GET event streams open, echoing the credential it saw. */
  const mcpServer = (host: string): Server => {
    const issued = upstreamCa.issue(host);
    return createHttpsServer({ key: issued.keyPem, cert: issued.certPem }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        records.push({ host, method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        const seen = String(req.headers.authorization ?? req.headers["x-api-key"] ?? "");
        if (req.method === "GET" && String(req.headers.accept ?? "").includes("text/event-stream")) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { seen } })}\n\n`);
          return;
        }
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "mcp-session-1", "x-echo-credential": seen });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { seen } }));
      });
    });
  };

  /** A TLS connection through the proxy, as `sandbox`, to `host:443` (terminated by the platform CA for vault hosts). */
  const connect = async (sandbox: string, host: string, ca = platformCa.certPem): Promise<TLSSocket> => {
    const tunnel = await openTunnel(proxyPort, `${host}:443`, auth[sandbox]);
    expect(tunnel.status).toBe(200);
    return await tlsOver(tunnel.socket!, host, ca);
  };

  const mcpCall = async (sandbox: string, host: string, headers: Record<string, string>): Promise<ProxyResponse> => {
    const tls = await connect(sandbox, host);
    try {
      return await postOver(tls, "/mcp", { host, accept: "application/json, text/event-stream", ...headers }, '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    } finally {
      tls.destroy();
    }
  };

  beforeAll(async () => {
    const routes = new Map<string, number>();
    for (const [host, address] of [
      ["mcp.contoso.test", "93.184.216.40"],
      ["wiki.contoso.test", "93.184.216.41"],
      ["other.contoso.test", "93.184.216.42"],
    ] as const) {
      const server = mcpServer(host);
      servers.push(server);
      routes.set(`${address}:443`, await listen(server));
    }

    dataDir = mkdtempSync(join(tmpdir(), "mc-egress-mcp-"));
    gateway = await startGateway(
      loadConfig({
        PORT: "0",
        LOG_LEVEL: "error",
        MANAGED_COPILOT_DATA_DIR: dataDir,
        MANAGED_COPILOT_WRITE_DISCOVERY: "0",
        MANAGED_COPILOT_SHARED_RUNTIME: "0",
        MANAGED_COPILOT_INSTANCE: "mcvaultmcptest",
        MANAGED_COPILOT_EGRESS: "external",
        MANAGED_COPILOT_EGRESS_KEY: EGRESS_KEY,
        MANAGED_COPILOT_CONFIG: JSON.stringify(CONFIG),
        TEST_DOCS_TOKEN: DOCS_TOKEN,
        TEST_WIKI_TOKEN: WIKI_TOKEN,
      }),
    );

    link = new GatewayLink({ url: gateway.url, key: EGRESS_KEY, registry, hello: { instanceId: "mcp-vault-test", version: "test", caCertificate: platformCa.certPem }, log: silentLogger });
    proxy = new EgressProxy({
      registry,
      secrets: link,
      reporter: link,
      ca: platformCa,
      log: silentLogger,
      destination: {
        allowedPorts: new Set([443, 8443]),
        privateHosts: new Set(),
        protectedCidrs: () => [],
        blockedCidrs: [],
        dnsTimeoutMs: 1_000,
        resolve: tableResolver({ "mcp.contoso.test": ["93.184.216.40"], "wiki.contoso.test": ["93.184.216.41"], "other.contoso.test": ["93.184.216.42"] }),
      },
      dial: routedDialer(routes),
      upstreamCa: [upstreamCa.certPem],
    });
    proxyPort = (await proxy.listen(0, "127.0.0.1")).port;
    link.start();

    const policy = gateway.app.service("policy");
    policy.bindSession({ sessionId: "s-alice", owner: 1, environment: "research", type: "isolated", requested: undefined, vaults: undefined });
    policy.bindSession({ sessionId: "s-bob", owner: 2, environment: "research", type: "isolated", requested: undefined, vaults: undefined });
    policy.bindSession({ sessionId: "s-chat", owner: 1, environment: "chat", type: "shared", requested: undefined, vaults: undefined });
    for (const [sandboxId, sessionId] of [
      ["sbx_alice", "s-alice"],
      ["sbx_bob", "s-bob"],
    ] as const) {
      const proxyUrl = new URL((await policy.registerSandbox({ sandboxId, sessionId })).proxyUrl);
      auth[sandboxId] = basic(proxyUrl.username, proxyUrl.password);
      await until(() => registry.get(sandboxId)?.credentialHash === sha256(proxyUrl.password));
    }
  }, 60_000);

  afterAll(async () => {
    await link?.stop();
    await proxy?.close();
    await gateway?.close();
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("gives sandboxes placeholder headers that match their egress registration", () => {
    const vaults = gateway.app.service("vaults");
    const docs = vaults.mcpHeaders("s-alice", DOCS_MCP, "sandbox");
    const wiki = vaults.mcpHeaders("s-alice", WIKI_MCP, "sandbox");
    expect(Object.keys(docs ?? {})).toEqual(["authorization"]);
    const docsPlaceholder = docs!.authorization!.replace(/^Bearer /, "");
    expect(docs!.authorization).toBe(bearer(docsPlaceholder));
    expect(docsPlaceholder).toMatch(PLACEHOLDER);
    expect(wiki).toEqual({ "x-api-key": expect.stringMatching(PLACEHOLDER) });
    expect(JSON.stringify([docs, wiki])).not.toMatch(new RegExp(`${DOCS_TOKEN}|${WIKI_TOKEN}`));

    // Stable per session and credential, and different for every session.
    expect(vaults.mcpHeaders("s-alice", "https://MCP.contoso.test:443/mcp#tools", "sandbox")).toEqual(docs);
    expect(vaults.mcpHeaders("s-bob", DOCS_MCP, "sandbox")!.authorization).not.toBe(docs!.authorization);

    expect(registry.get("sbx_alice")!.credentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ placeholder: docsPlaceholder, destinations: [{ host: "mcp.contoso.test", port: 443 }], headers: ["authorization"] }),
        expect.objectContaining({ placeholder: wiki!["x-api-key"], destinations: [{ host: "wiki.contoso.test", port: 443 }], headers: ["x-api-key"] }),
      ]),
    );
    // Nothing for other URLs, for shared placement (the MCP adapter attaches credentials there), or shared sessions.
    expect(vaults.mcpHeaders("s-alice", "https://mcp.contoso.test/other", "sandbox")).toBeUndefined();
    expect(vaults.mcpHeaders("s-alice", DOCS_MCP, "shared")).toBeUndefined();
    expect(vaults.mcpHeaders("s-chat", DOCS_MCP, "sandbox")).toBeUndefined();
  });

  it("fails visibly for a vault MCP server the proxy could never substitute for", () => {
    let error: unknown;
    try {
      gateway.app.service("vaults").mcpHeaders("s-alice", PORTED_MCP, "sandbox");
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "capability_unavailable", message: expect.stringMatching(/port 443/) });
    expect(registry.get("sbx_alice")!.credentials.every((credential) => credential.destinations.every((destination) => destination.port === 443))).toBe(true);
  });

  it("substitutes the owning session's placeholder for the MCP server's exact host", async () => {
    const vaults = gateway.app.service("vaults");
    const docs = await mcpCall("sbx_alice", "mcp.contoso.test", vaults.mcpHeaders("s-alice", DOCS_MCP, "sandbox")!);
    expect(docs.status).toBe(200);
    expect(records.at(-1)).toMatchObject({ host: "mcp.contoso.test", method: "POST", url: "/mcp", body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    expect(records.at(-1)!.headers.authorization).toBe(bearer(DOCS_TOKEN));
    expect(docs.headers["mcp-session-id"]).toBe("mcp-session-1");
    // A server that reflects the credential gives the sandbox only a redacted copy.
    expect(JSON.parse(docs.body)).toEqual({ jsonrpc: "2.0", id: 1, result: { seen: bearer("[redacted]") } });
    expect(docs.headers["x-echo-credential"]).toBe(bearer("[redacted]"));

    const wiki = await mcpCall("sbx_alice", "wiki.contoso.test", vaults.mcpHeaders("s-alice", WIKI_MCP, "sandbox")!);
    expect(wiki.status).toBe(200);
    expect(records.at(-1)!.headers["x-api-key"]).toBe(WIKI_TOKEN);

    const bob = await mcpCall("sbx_bob", "mcp.contoso.test", vaults.mcpHeaders("s-bob", DOCS_MCP, "sandbox")!);
    expect(bob.status).toBe(200);
    expect(records.at(-1)!.headers.authorization).toBe(bearer(DOCS_TOKEN));
  });

  it("refuses other sessions' placeholders, other hosts, and other headers without contacting the server", async () => {
    const vaults = gateway.app.service("vaults");
    const alice = vaults.mcpHeaders("s-alice", DOCS_MCP, "sandbox")!;
    const before = records.length;

    const stolen = await mcpCall("sbx_bob", "mcp.contoso.test", alice);
    expect(stolen.status).toBe(403);
    expect(stolen.body).toMatch(/does not belong to this session/);

    const elsewhere = await mcpCall("sbx_alice", "wiki.contoso.test", alice);
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.body).toMatch(/only valid for mcp\.contoso\.test/);

    const wrongHeader = await mcpCall("sbx_alice", "mcp.contoso.test", { "x-api-key": alice.authorization!.replace(/^Bearer /, "") });
    expect(wrongHeader.status).toBe(403);
    expect(wrongHeader.body).toMatch(/only be sent in the authorization header/);

    expect(records.length).toBe(before);
    const policy = gateway.app.service("policy");
    const misuse = (sessionId: string) => policy.blocked(sessionId).filter((event) => event.reason === "credential_misuse");
    await until(() => misuse("s-bob").some((event) => event.host === "mcp.contoso.test") && misuse("s-alice").length === 2);
    expect(misuse("s-alice").map((event) => event.host).sort()).toEqual(["mcp.contoso.test", "wiki.contoso.test"]);
    expect(JSON.stringify([policy.blocked("s-alice"), policy.blocked("s-bob")])).not.toContain(DOCS_TOKEN);
  });

  it("streams an MCP server's events as they arrive, redacted", async () => {
    const tls = await connect("sbx_alice", "mcp.contoso.test");
    try {
      const credential = gateway.app.service("vaults").mcpHeaders("s-alice", DOCS_MCP, "sandbox")!.authorization!;
      let received = "";
      tls.on("data", (chunk: Buffer) => (received += chunk.toString("utf8")));
      tls.write(`GET /mcp HTTP/1.1\r\nHost: mcp.contoso.test\r\nAccept: text/event-stream\r\nAuthorization: ${credential}\r\n\r\n`);
      const event = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { seen: bearer("[redacted]") } })}\n\n`;
      // The server keeps the stream open, so the event must arrive whole without waiting for more data.
      await until(() => received.includes(event), 3_000);
      expect(received).toMatch(/^HTTP\/1\.1 200/);
      expect(received).not.toContain(DOCS_TOKEN);
      expect(records.at(-1)).toMatchObject({ host: "mcp.contoso.test", method: "GET" });
      expect(records.at(-1)!.headers.authorization).toBe(bearer(DOCS_TOKEN));
    } finally {
      tls.destroy();
    }
  });
});
